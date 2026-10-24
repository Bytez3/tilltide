/**
 * The operator's view: what the AI costs per shop against what each shop earns Tilltide, plus granting
 * assistant plans and top-up credits. Off unless ADMIN_TOKEN is set.
 * - GET /admin/usage: an HTML page behind HTTP basic auth (any username, ADMIN_TOKEN as the password).
 * - POST /admin/shops/:id/assistant: { plan?: 'included' | 'plus', addCredits?: number }, with
 *   `Authorization: Bearer <ADMIN_TOKEN>` (a header browsers never send on their own, so no CSRF).
 */
import { timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { config } from '../config'
import { LEDGER_DECIMALS, sql } from '../db'
import { usdPerUnit, type ShopCurrency } from '../fx'
import { costUsd, gbpPerUsd, spendTodayGbp, type TokenUsage } from '../services/ai-costs'

export const admin = new Hono()

function matches(given: string | undefined) {
  const expected = Buffer.from(config.adminToken ?? '')
  const got = Buffer.from(given ?? '')
  return expected.length > 0 && got.length === expected.length && timingSafeEqual(got, expected)
}

function basicPassword(c: Context) {
  const m = c.req.header('authorization')?.match(/^Basic (.+)$/)
  if (!m) return undefined
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8')
  return decoded.slice(decoded.indexOf(':') + 1)
}

admin.use(async (_c, next) => {
  if (!config.adminToken) throw new HTTPException(404, { message: 'Not found' })
  await next()
})

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
const gbp = (n: number) => `£${n.toFixed(2)}`

admin.get('/usage', async (c) => {
  if (!matches(basicPassword(c))) {
    return c.text('Sign in', 401, { 'www-authenticate': 'Basic realm="Tilltide admin", charset="UTF-8"' })
  }
  const toGbp = await gbpPerUsd()
  const rates = new Map<ShopCurrency, number>()
  const unitToGbp = async (cur: ShopCurrency) => {
    if (!rates.has(cur)) rates.set(cur, await usdPerUnit(cur).then((r) => (Number(r) / 1e6) * toGbp, () => (cur === 'GBP' ? 1 : toGbp)))
    return rates.get(cur)!
  }
  const shops = await sql<
    (TokenUsage & { id: string; name: string; currency: ShopCurrency; aiPlan: string; aiCredits: number; questions: number; model: string | null; paypalFees: bigint; sweepFees: bigint })[]
  >`
    select m.id, m.name, m.currency, m.ai_plan, m.ai_credits,
      coalesce(u.questions, 0)::int as questions, u.model,
      coalesce(u.input_tokens, 0) as input_tokens, coalesce(u.output_tokens, 0) as output_tokens,
      coalesce(u.cache_read_tokens, 0) as cache_read_tokens, coalesce(u.cache_write_tokens, 0) as cache_write_tokens,
      coalesce((select sum(paypal_fee) from payments p where p.merchant_id = m.id and p.status = 'paid'
        and p.paid_at >= date_trunc('month', now())), 0) as paypal_fees,
      coalesce((select sum(fee_amount) from sweeps s where s.merchant_id = m.id and s.status = 'confirmed'
        and s.created_at >= date_trunc('month', now())), 0) as sweep_fees
    from merchants m
    left join (
      select merchant_id, sum(requests) as questions, max(model) as model, sum(input_tokens) as input_tokens,
        sum(output_tokens) as output_tokens, sum(cache_read_tokens) as cache_read_tokens, sum(cache_write_tokens) as cache_write_tokens
      from agent_usage where day >= date_trunc('month', current_date) group by merchant_id
    ) u on u.merchant_id = m.id
    order by coalesce(u.questions, 0) desc, m.created_at`
  const units = 10 ** LEDGER_DECIMALS
  let totalCost = 0
  let totalFees = 0
  const rows = []
  for (const s of shops) {
    const cost = costUsd(s.model, s) * toGbp
    // PayPal fees are in the shop's currency; sweep fees in the stablecoin (dollars).
    const fees = (Number(s.paypalFees) / units) * (await unitToGbp(s.currency)) + (Number(s.sweepFees) / units) * toGbp
    totalCost += cost
    totalFees += fees
    rows.push(
      `<tr><td>${esc(s.name)}<br><small>${esc(s.id)}</small></td><td>${esc(s.aiPlan)}</td><td>${s.aiCredits}</td><td>${s.questions}</td>` +
        `<td>${gbp(cost)}</td><td>${gbp(fees)}</td><td class="${fees - cost < 0 ? 'neg' : ''}">${gbp(fees - cost)}</td></tr>`,
    )
  }
  const today = await spendTodayGbp()
  const budget = config.agent.dailyBudgetGbp
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Tilltide · AI usage</title>
<style>body{font:15px system-ui,sans-serif;margin:24px;color:#14211F;background:#F6F3EE}table{border-collapse:collapse;width:100%;background:#fff}
td,th{padding:8px 10px;border-bottom:1px solid #E2DDD4;text-align:left;vertical-align:top}th{font-size:13px;color:#5E6B68}small{color:#5E6B68}
.neg{color:#B42318;font-weight:600}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.card{background:#fff;border-radius:12px;padding:12px 16px}
.card b{display:block;font-size:22px}</style></head><body>
<h1>AI usage this month</h1>
<div class="cards">
<div class="card">Today's AI spend<b>${gbp(today)}${budget !== null ? ` of ${gbp(budget)}` : ''}</b></div>
<div class="card">AI cost this month<b>${gbp(totalCost)}</b></div>
<div class="card">Fee income this month<b>${gbp(totalFees)}</b></div>
<div class="card">Margin<b class="${totalFees - totalCost < 0 ? 'neg' : ''}">${gbp(totalFees - totalCost)}</b></div>
</div>
<p><small>Plans: included ${config.agent.monthly.included} questions a month, Plus ${config.agent.monthly.plus}. Model ${esc(config.agent.model)}. Costs are estimates from token counts at list prices.</small></p>
<table><tr><th>Shop</th><th>Plan</th><th>Credits</th><th>Questions</th><th>AI cost</th><th>Fee income</th><th>Margin</th></tr>${rows.join('')}</table>
</body></html>`)
})

admin.post('/shops/:id/assistant', async (c) => {
  if (!matches(c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1])) throw new HTTPException(401, { message: 'Not allowed' })
  const id = z.uuid().safeParse(c.req.param('id'))
  if (!id.success) throw new HTTPException(404, { message: 'Shop not found' })
  const input = z
    .object({ plan: z.enum(['included', 'plus']).optional(), addCredits: z.number().int().min(-100_000).max(100_000).optional() })
    .safeParse(await c.req.json().catch(() => null))
  if (!input.success) throw new HTTPException(400, { message: 'Send { plan?, addCredits? }' })
  const [row] = await sql<{ aiPlan: string; aiCredits: number }[]>`
    update merchants set
      ai_plan = coalesce(${input.data.plan ?? null}, ai_plan),
      ai_credits = greatest(0, ai_credits + ${input.data.addCredits ?? 0})
    where id = ${id.data} returning ai_plan, ai_credits`
  if (!row) throw new HTTPException(404, { message: 'Shop not found' })
  return c.json({ plan: row.aiPlan, credits: row.aiCredits })
})
