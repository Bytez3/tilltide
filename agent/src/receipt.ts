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
  const [payment] = await sql<(PaymentRow & { shopName: string; timezone: string })[]>`
    select p.*, m.name as shop_name, m.timezone from payments p join merchants m on m.id = p.merchant_id
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
  :root { --bg:#F6F3EE; --card:#fff; --ink:#14211F; --muted:#5E6B68; --line:#E2DDD4; --sea:#0E6E6B; --paid:#1F8A4C; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0F1716; --card:#172321; --ink:#EEF2F1; --muted:#9BA8A5; --line:#25332F; --sea:#3FB3AE; --paid:#4CC27D; } }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width:420px; margin:0 auto; padding:24px 16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px; margin-bottom:12px; }
  h1 { font-size:20px; margin:0 0 4px; } .muted { color:var(--muted); font-size:14px; }
  .amount { font-size:40px; font-weight:700; margin:12px 0 0; } .paid { color:var(--paid); font-weight:600; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:6px 0; border-top:1px solid var(--line); }
  .row:first-of-type { border-top:0; } .points { font-size:28px; font-weight:700; color:var(--sea); }
  a { color:var(--sea); }
</style>
</head>
<body><main>
  <div class="card">
    <h1>${payment.shopName}</h1>
    <div class="muted">${when}</div>
    <div class="amount">${({ GBP: '£', USD: '$', EUR: '€' } as const)[payment.currency]}${amount}</div>
    <div class="paid">Paid ✓${payment.rail === 'paypal' ? ' with PayPal' : ''}</div>
  </div>
  ${
    payment.label || isSolana || payment.discount > 0n || refunded?.total || payment.signature
      ? html`<div class="card">
    ${payment.label ? html`<div class="row"><span class="muted">For</span><span>${payment.label}</span></div>` : ''}
    ${
      payment.discount > 0n && payment.rail === 'solana'
        ? html`<div class="row"><span class="muted">Points used</span><span>${payment.pointsRedeemed.toString()} (−${Number(fromBaseUnits(payment.discount, LEDGER_DECIMALS)).toFixed(2)})</span></div>
    <div class="row"><span class="muted">You paid</span><span>${Number(fromBaseUnits(payment.amount - payment.discount, LEDGER_DECIMALS)).toFixed(2)} ${payment.currency}</span></div>`
        : ''
    }
    ${isSolana ? html`<div class="row"><span class="muted">Paid from</span><span>${short(payment.payer!)}</span></div>` : ''}
    ${isSolana && payment.tokenAmount && payment.discount === 0n ? html`<div class="row"><span class="muted">Sent</span><span>${Number(fromBaseUnits(payment.tokenAmount, LEDGER_DECIMALS)).toFixed(2)} ${payment.tokenSymbol}</span></div>` : ''}
    ${payment.discount > 0n && payment.rail === 'paypal' ? html`<div class="row"><span class="muted">Points used</span><span>${payment.pointsRedeemed.toString()} (−${Number(fromBaseUnits(payment.discount, LEDGER_DECIMALS)).toFixed(2)})</span></div>` : ''}
    ${refunded?.total ? html`<div class="row"><span class="muted">Refunded</span><span>${Number(fromBaseUnits(refunded.total, LEDGER_DECIMALS)).toFixed(2)} ${payment.currency}</span></div>` : ''}
    ${payment.signature ? html`<div class="row"><span class="muted">Transaction</span><a href="${explorer(payment.signature)}" rel="noopener">${short(payment.signature)}</a></div>` : ''}
  </div>`
      : ''
  }
  ${
    isSolana && balance !== null
      ? html`<div class="card">
    <div class="muted">Your points at ${payment.shopName}</div>
    <div class="points">${balance}</div>
    ${earned ? html`<div class="muted">+${earned} from this visit</div>` : html`<div class="muted">Points from this visit are on their way.</div>`}
  </div>`
      : paypalLoyalty
        ? html`<div class="card">
    <div class="muted">Your points at ${payment.shopName}</div>
    <div class="points">${paypalLoyalty.balance}</div>
    ${earned ? html`<div class="muted">+${earned} from this visit</div>` : ''}
    <div class="row" style="margin-top:12px"><span class="muted">Your loyalty code</span><strong style="letter-spacing:1px">${paypalLoyalty.code}</strong></div>
    <div class="muted">Show this code next time you pay with PayPal to spend your points.</div>
  </div>`
        : ''
  }
  <p class="muted" style="text-align:center">Powered by Tilltide · <a href="/privacy">Privacy</a></p>
</main></body></html>`
}

