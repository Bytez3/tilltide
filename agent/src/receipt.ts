import { html } from 'hono/html'
import { address } from '@solana/kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { fromBaseUnits } from '@tilltide/agent-pay-kit'
import { config } from './config'
import { LEDGER_DECIMALS, sql, type PaymentRow } from './db'
import { rpc } from './solana'
import { codeFor, ledgerBalance } from './services/paypal-loyalty'

async function pointsBalance(wallet: string): Promise<string | null> {
  if (!config.pointsMint) return null
  const [ata] = await findAssociatedTokenPda({ owner: address(wallet), mint: config.pointsMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })
  return rpc
    .getTokenAccountBalance(ata, { commitment: 'confirmed' })
    .send()
    .then((r) => r.value.amount)
    .catch(() => '0')
}

/**
 * Public receipt for one payment, for the customer to scan off the till. The id is an unguessable
 * UUID; everything merchant-typed is HTML-escaped by hono's html template.
 */
export async function renderReceipt(paymentId: string) {
  const [payment] = await sql<(PaymentRow & { shopName: string; timezone: string; pointValue: bigint })[]>`
    select p.*, m.name as shop_name, m.timezone, m.point_value from payments p join merchants m on m.id = p.merchant_id
    where p.id = ${paymentId}`
  if (!payment || payment.status !== 'paid') return null
  const [refunded] = await sql<{ total: bigint | null }[]>`
    select sum(amount)::bigint as total from refunds where payment_id = ${payment.id} and status in ('pending', 'completed')`

  const amount = Number(fromBaseUnits(payment.amount, LEDGER_DECIMALS)).toFixed(2)
  const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: payment.timezone }).format(
    payment.paidAt ?? payment.createdAt,
  )
  const isSolana = payment.rail === 'solana' && payment.payer
  const balance = isSolana ? await pointsBalance(payment.payer!) : null
  const earned = payment.pointsStatus === 'issued' && payment.points ? payment.points.toString() : null
  // PayPal customers: points live in Tilltide's ledger, spent with a loyalty code.
  const paypalLoyalty =
    payment.rail === 'paypal' && payment.payer
      ? { balance: (await ledgerBalance(payment.merchantId, payment.payer)).toString(), code: await codeFor(payment.merchantId, payment.payer) }
      : null
  const symbol = ({ GBP: '£', USD: '$', EUR: '€' } as const)[payment.currency]
  /** "Worth £0.60 off next time": what a points balance is worth at this shop. */
  const worth = (points: string | null) => {
    const value = points ? BigInt(points) * payment.pointValue : 0n
    return value > 0n ? html`<div class="worth">Worth ${symbol}${Number(fromBaseUnits(value, LEDGER_DECIMALS)).toFixed(2)} off your next visit</div>` : ''
  }
  const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`
  const explorer = (sig: string) =>
    `https://explorer.solana.com/tx/${sig}${config.cluster === 'devnet' ? '?cluster=devnet' : ''}`

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Receipt · ${payment.shopName}</title>
<style>
  :root { --bg:#F6F3EE; --card:#fff; --ink:#14211F; --muted:#5E6B68; --line:#E2DDD4; --sea:#0E6E6B; --sea-soft:#E3F0EE; --paid:#1F8A4C; --paid-soft:#E6F2EA; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0F1716; --card:#172321; --ink:#EEF2F1; --muted:#9BA8A5; --line:#25332F; --sea:#3FB3AE; --sea-soft:#1B3331; --paid:#4CC27D; --paid-soft:#173426; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
  main { max-width:420px; margin:0 auto; padding:20px 16px 32px; }
  header { display:flex; align-items:center; gap:10px; margin:4px 0 16px; }
  header img { width:32px; height:32px; border-radius:9px; }
  header .shop { font-weight:800; font-size:18px; letter-spacing:-0.2px; }
  header .sub { color:var(--muted); font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:18px; padding:20px; margin-bottom:12px; }
  .hero { text-align:center; padding:28px 20px; }
  .stamp { display:inline-flex; align-items:center; gap:6px; background:var(--paid-soft); color:var(--paid); font-weight:700; font-size:14px; padding:6px 12px; border-radius:999px; }
  .amount { font-size:48px; font-weight:800; letter-spacing:-1.5px; margin:12px 0 2px; font-variant-numeric:tabular-nums; }
  .muted { color:var(--muted); font-size:14px; }
  .label { color:var(--muted); font-size:12px; font-weight:600; letter-spacing:.08em; text-transform:uppercase; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:10px 0; border-top:1px solid var(--line); }
  .row:first-of-type { border-top:0; padding-top:0; }
  .points { font-size:44px; font-weight:800; color:var(--sea); letter-spacing:-1px; line-height:1.1; margin-top:6px; font-variant-numeric:tabular-nums; }
  .earned { display:inline-block; background:var(--sea-soft); color:var(--sea); font-weight:700; font-size:13px; padding:3px 10px; border-radius:999px; margin-top:6px; }
  .worth { margin-top:10px; font-weight:600; }
  .code { margin-top:16px; background:var(--bg); border:1px dashed var(--line); border-radius:14px; padding:14px; text-align:center; }
  .code strong { display:block; font-size:24px; letter-spacing:3px; font-family:ui-monospace,Menlo,monospace; margin:4px 0; }
  footer { text-align:center; margin-top:20px; }
  a { color:var(--sea); }
</style>
</head>
<body><main>
  <header>
    <img src="/favicon.png" alt="">
    <div><div class="shop">${payment.shopName}</div><div class="sub">Receipt · ${when}</div></div>
  </header>
  <div class="card hero">
    <span class="stamp">✓ Paid${payment.rail === 'paypal' ? ' with PayPal' : ` in ${payment.tokenSymbol}`}</span>
    <div class="amount">${symbol}${amount}</div>
    ${payment.label ? html`<div class="muted">${payment.label}</div>` : ''}
  </div>
  ${
    isSolana || payment.discount > 0n || refunded?.total || payment.signature
      ? html`<div class="card">
    ${
      payment.discount > 0n && payment.rail === 'solana'
        ? html`<div class="row"><span class="muted">Points used</span><span>${payment.pointsRedeemed.toString()} (−${symbol}${Number(fromBaseUnits(payment.discount, LEDGER_DECIMALS)).toFixed(2)})</span></div>
    <div class="row"><span class="muted">You paid</span><span>${symbol}${Number(fromBaseUnits(payment.amount - payment.discount, LEDGER_DECIMALS)).toFixed(2)}</span></div>`
        : ''
    }
    ${isSolana ? html`<div class="row"><span class="muted">Paid from</span><span>${short(payment.payer!)}</span></div>` : ''}
    ${isSolana && payment.tokenAmount && payment.discount === 0n ? html`<div class="row"><span class="muted">Sent</span><span>${Number(fromBaseUnits(payment.tokenAmount, LEDGER_DECIMALS)).toFixed(2)} ${payment.tokenSymbol}</span></div>` : ''}
    ${payment.discount > 0n && payment.rail === 'paypal' ? html`<div class="row"><span class="muted">Points used</span><span>${payment.pointsRedeemed.toString()} (−${symbol}${Number(fromBaseUnits(payment.discount, LEDGER_DECIMALS)).toFixed(2)})</span></div>` : ''}
    ${refunded?.total ? html`<div class="row"><span class="muted">Refunded</span><span>${symbol}${Number(fromBaseUnits(refunded.total, LEDGER_DECIMALS)).toFixed(2)}</span></div>` : ''}
    ${payment.signature ? html`<div class="row"><span class="muted">Transaction</span><a href="${explorer(payment.signature)}" rel="noopener">${short(payment.signature)}</a></div>` : ''}
  </div>`
      : ''
  }
  ${
    isSolana && balance !== null
      ? html`<div class="card">
    <div class="label">Your points</div>
    <div class="points">${balance}</div>
    ${earned ? html`<span class="earned">+${earned} this visit${payment.pointsBonus ? ' · Seeker bonus' : ''}</span>` : html`<div class="muted">Points from this visit are on their way.</div>`}
    ${worth(balance)}
    <div class="muted">They're in your wallet, ready to spend here next time.</div>
  </div>`
      : paypalLoyalty
        ? html`<div class="card">
    <div class="label">Your points</div>
    <div class="points">${paypalLoyalty.balance}</div>
    ${earned ? html`<span class="earned">+${earned} this visit</span>` : ''}
    ${worth(paypalLoyalty.balance)}
    <div class="code">
      <div class="label">Your loyalty code</div>
      <strong>${paypalLoyalty.code}</strong>
      <div class="muted">Show this at the till next time to spend your points.</div>
    </div>
  </div>`
        : ''
  }
  <footer class="muted">Powered by Tilltide · <a href="/privacy">Privacy</a></footer>
</main></body></html>`
}

