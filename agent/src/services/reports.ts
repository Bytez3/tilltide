import Anthropic from '@anthropic-ai/sdk'
import { alert } from '../alerts'
import { checkBudget } from './ai-costs'
import { recordBackgroundUsage } from './usage'
import { config } from '../config'
import { sql, type MerchantRow } from '../db'
import { getDailySummary, reconcileDay, todayIn } from './summary'

const SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' }

type Summary = Awaited<ReturnType<typeof getDailySummary>>
type Reconciliation = Awaited<ReturnType<typeof reconcileDay>>

export interface DailyReport {
  date: string
  text: string
  narrative: string | null
  summary: Summary
  reconciliation: Reconciliation | null
  createdAt: string
}

function money(value: string, currency: string) {
  return `${SYMBOL[currency] ?? ''}${Number(value).toFixed(2)}${SYMBOL[currency] ? '' : ` ${currency}`}`
}

/** The report as plain sentences, written without AI so it's always there (and always right). */
export function reportText(s: Summary, r: Reconciliation | null): string {
  const c = s.token
  const day = new Date(`${s.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
  const lines: string[] = []
  if (s.paidCount === 0) {
    lines.push(`${day}: no sales.`)
  } else {
    const rails = [
      Number(s.byRail.paypal) > 0 ? `PayPal ${money(s.byRail.paypal, c)}` : null,
      Number(s.byRail.solana) > 0 ? `wallet ${money(s.byRail.solana, c)}` : null,
      Number(s.byRail.cash) > 0 ? `cash ${money(s.byRail.cash, c)}` : null,
      Number(s.byRail.card) > 0 ? `card reader ${money(s.byRail.card, c)}` : null,
    ].filter(Boolean)
    lines.push(`${day}: ${money(s.takings, c)} from ${s.paidCount} sale${s.paidCount === 1 ? '' : 's'}${rails.length ? ` (${rails.join(', ')})` : ''}. Average sale ${money(s.averageSale, c)}.`)
  }
  if (s.items.length > 0) {
    lines.push(`Best sellers: ${s.items.slice(0, 3).map((i) => `${i.qty}× ${i.name}`).join(', ')}.`)
  }
  if (s.refunds.count > 0) lines.push(`${s.refunds.count} refund${s.refunds.count === 1 ? '' : 's'} (${money(s.refunds.total, c)}), so net takings ${money(s.netTakings, c)}.`)
  if (Number(s.pointsIssued) > 0 || Number(s.pointsRedeemed) > 0) {
    lines.push(`Loyalty: ${s.pointsIssued} points earned, ${s.pointsRedeemed} spent${Number(s.pointsDiscount) > 0 ? ` (${money(s.pointsDiscount, c)} off)` : ''}.`)
  }
  if (s.uniqueCustomers > 0) lines.push(`${s.uniqueCustomers} different customer${s.uniqueCustomers === 1 ? '' : 's'}.`)
  if (Number(s.paypalFees) > 0) lines.push(`Tilltide fees on PayPal sales: ${money(s.paypalFees, c)}.`)
  if (r) {
    lines.push(`The till wallet holds ${Number(r.tillBalance).toFixed(2)} ${r.token}${Number(r.sweptOutToday) > 0 ? `; ${Number(r.sweptOutToday).toFixed(2)} ${r.token} was sent to the owner today` : ''}.`)
    if (r.onchainActivityNotInLedger.length > 0) {
      lines.push(`To check: ${r.onchainActivityNotInLedger.length} transfer${r.onchainActivityNotInLedger.length === 1 ? '' : 's'} in the till that Tilltide didn't take.`)
    }
  }
  if (s.failed.length > 0) lines.push(`To check: ${s.failed.length} payment${s.failed.length === 1 ? '' : 's'} that didn't add up.`)
  if (s.voided > 0) lines.push(`${s.voided} cash or card sale${s.voided === 1 ? ' was' : 's were'} voided.`)
  if (s.stillPending > 0) lines.push(`${s.stillPending} payment request${s.stillPending === 1 ? ' is' : 's are'} still open.`)
  return lines.join(' ')
}

/** Claude notes per shop per day: the first report, plus a couple of refreshes after late sales. */
const NOTES_PER_DAY = 3

/** A short, friendly note from Claude on top of the facts. Optional: skipped without an API key. */
async function narrativeFor(merchant: MerchantRow, text: string, summary: Summary): Promise<string | null> {
  // Nothing to say on a day with no sales, and every shop gets a report: skip the call, and its cost.
  if (!process.env.ANTHROPIC_API_KEY || summary.paidCount === 0) return null
  // On a server with a global cap (the public demo), notes stop once the day's questions are used up.
  if (config.agent.globalDailyLimit !== null) {
    const [used] = await sql<{ n: number }[]>`select coalesce(sum(requests), 0)::int as n from agent_usage where day = current_date`
    if (used!.n >= config.agent.globalDailyLimit) return null
  }
  if (await checkBudget().then(() => false, () => true)) return null
  try {
    const client = new Anthropic({ timeout: 60_000, maxRetries: 1 })
    const isHaiku = config.agent.model.startsWith('claude-haiku')
    const res = await client.beta.messages.create({
      model: config.agent.model,
      max_tokens: 1000,
      ...(isHaiku
        ? {}
        : { output_config: { effort: 'low' as const }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
      system:
        'You write the end-of-day note for a small independent shop owner. British English, 2-3 short sentences, warm and plain. Use only the figures given. Mention anything to check. No headings or lists.',
      messages: [{ role: 'user', content: `Shop: ${merchant.name}\nFacts: ${text}\nData: ${JSON.stringify(summary)}` }],
    })
    await recordBackgroundUsage(merchant, config.agent.model, {
      inputTokens: res.usage.input_tokens,
      outputTokens: res.usage.output_tokens,
      cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
    }).catch(() => {})
    if (res.stop_reason === 'refusal') return null
    const out = res.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim()
    return out || null
  } catch (err) {
    console.warn(`End-of-day narrative for ${merchant.id} skipped: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

/** Builds (or rebuilds) the report for one day and stores it. */
export async function writeDailyReport(merchant: MerchantRow, date: string): Promise<DailyReport> {
  const summary = await getDailySummary(merchant, date)
  const reconciliation = await reconcileDay(merchant, date).catch(() => null)
  const text = reportText(summary, reconciliation)
  const unexplained = reconciliation?.onchainActivityNotInLedger.length ?? 0
  if (unexplained > 0) {
    void alert(`unexplained:${merchant.id}:${date}`, `${merchant.name}: ${unexplained} transfer(s) in the till on ${date} that Tilltide didn't take`)
  }
  // A rewrite whose facts haven't changed keeps its note. Notes have their own small allowance, separate
  // from the owner's assistant questions, so a busy evening of late sales can't use those up.
  const [previous] = await sql<{ text: string; narrative: string | null; narrativeCount: number }[]>`
    select text, narrative, narrative_count from daily_reports where merchant_id = ${merchant.id} and day = ${date}`
  const count = previous?.narrativeCount ?? 0
  const fresh = previous?.text === text || count >= NOTES_PER_DAY ? null : await narrativeFor(merchant, text, summary)
  // Past the allowance, a changed report drops its note rather than keep one quoting old figures.
  const narrative = fresh ?? (previous?.text === text ? previous.narrative : null)
  const notes = count + (fresh ? 1 : 0)
  const stored = { summary, reconciliation }
  const json = JSON.stringify(stored, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
  const [row] = await sql<{ createdAt: Date }[]>`
    insert into daily_reports (merchant_id, day, summary, text, narrative, narrative_count)
    values (${merchant.id}, ${date}, ${json}::jsonb, ${text}, ${narrative}, ${notes})
    on conflict (merchant_id, day) do update set summary = excluded.summary, text = excluded.text,
      narrative = excluded.narrative, narrative_count = excluded.narrative_count, created_at = now()
    returning created_at`
  return { date, text, narrative, summary, reconciliation, createdAt: row!.createdAt.toISOString() }
}

export async function listReports(merchant: MerchantRow, limit = 14) {
  const rows = await sql<{ day: Date; text: string; narrative: string | null; createdAt: Date }[]>`
    select day, text, narrative, created_at from daily_reports where merchant_id = ${merchant.id}
    order by day desc limit ${limit}`
  return rows.map((r) => ({
    date: r.day.toISOString().slice(0, 10),
    text: r.text,
    narrative: r.narrative,
    createdAt: r.createdAt.toISOString(),
  }))
}

/** Local HH:MM for a timezone. */
function localTime(timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone }).format(new Date())
}

/** Writes today's report for every shop past its closing time that doesn't have one yet. */
export async function runDueReports() {
  const merchants = await sql<MerchantRow[]>`select * from merchants`
  for (const merchant of merchants) {
    const today = todayIn(merchant.timezone)
    // Catch up on yesterday too, if it was missed (server down at closing time, or a 23:59 close).
    const yesterday = dayBefore(today)
    const due = localTime(merchant.timezone) >= merchant.closeTime ? [yesterday, today] : [yesterday]
    for (const day of due) {
      const from = sql`(${day}::date::timestamp at time zone ${merchant.timezone})`
      const to = sql`((${day}::date + 1)::timestamp at time zone ${merchant.timezone})`
      const [done] = await sql<{ writtenAt: Date }[]>`
        select created_at as written_at from daily_reports where merchant_id = ${merchant.id} and day = ${day}`
      if (done) {
        // Already written: rewrite it if money landed for that day since, e.g. a sale after closing time,
        // a wallet payment that arrived late, a PayPal capture released from review, or a refund.
        const [changed] = await sql`
          select 1 from payments where merchant_id = ${merchant.id} and status = 'paid'
            and coalesce(paid_at, created_at) >= ${from} and coalesce(paid_at, created_at) < ${to} and paid_at > ${done.writtenAt}
          union all
          select 1 from refunds where merchant_id = ${merchant.id} and status in ('pending', 'completed')
            and approved_at >= ${from} and approved_at < ${to} and approved_at > ${done.writtenAt}
          limit 1`
        if (!changed) continue
      } else if (day !== today) {
        // Only shops that traded that day get a catch-up report.
        const [traded] = await sql`
          select 1 from payments where merchant_id = ${merchant.id}
            and coalesce(paid_at, created_at) >= ${from} and coalesce(paid_at, created_at) < ${to} limit 1`
        if (!traded) continue
      }
      await writeDailyReport(merchant, day).catch((err) => console.error(`End-of-day report for ${merchant.id} ${day} failed`, err))
    }
  }
}

function dayBefore(day: string): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
