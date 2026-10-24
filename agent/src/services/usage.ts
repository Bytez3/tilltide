import { config } from '../config'
import { checkBudget, noteSpend, type TokenUsage } from './ai-costs'
import { sql, type MerchantRow } from '../db'

export class UsageLimitError extends Error {}

/**
 * Reserves one assistant question. Throws once the shop has used its daily allowance, its month's
 * questions and top-up credits, or the server's daily AI budget is spent, so a runaway or abused
 * session can't run up the Claude bill. Counted before the call, so concurrent requests can't slip past.
 */
export async function reserveAgentRequest(merchant: MerchantRow) {
  const [row] = await sql<{ requests: number }[]>`
    insert into agent_usage (merchant_id, day, requests) values (${merchant.id}, current_date, 1)
    on conflict (merchant_id, day) do update set requests = agent_usage.requests + 1
    returning requests`
  const refuse = async (message: string) => {
    await sql`update agent_usage set requests = requests - 1 where merchant_id = ${merchant.id} and day = current_date`
    throw new UsageLimitError(message)
  }
  if (row!.requests > config.agent.dailyLimit) {
    return refuse(`Daily agent limit reached (${config.agent.dailyLimit} questions). It resets at midnight UTC.`)
  }
  const cap = config.agent.globalDailyLimit
  if (cap !== null) {
    const [total] = await sql<{ requests: number }[]>`select coalesce(sum(requests), 0)::int as requests from agent_usage where day = current_date`
    if (total!.requests > cap) return refuse('The assistant has answered all the questions it can today. It resets at midnight UTC.')
  }
  const overBudget = await checkBudget().then(() => null, (err: Error) => err.message)
  if (overBudget) return refuse(overBudget)
  // Past the month's allowance, each question uses a top-up credit (taken last, so a refusal never costs one).
  const allowance = monthlyAllowance(merchant)
  const [month] = await sql<{ used: number }[]>`
    select coalesce(sum(requests), 0)::int as used from agent_usage
    where merchant_id = ${merchant.id} and day >= date_trunc('month', current_date)`
  if (month!.used > allowance) {
    const [paid] = await sql`update merchants set ai_credits = ai_credits - 1 where id = ${merchant.id} and ai_credits > 0 returning id`
    if (!paid) return refuse(`You've used this month's ${allowance} assistant questions. Top up or upgrade to keep asking; it resets on the 1st.`)
  }
}

export function monthlyAllowance(merchant: MerchantRow): number {
  return merchant.aiPlan === 'plus' ? config.agent.monthly.plus : config.agent.monthly.included
}

/** The shop's assistant usage this month, for the app. */
export async function assistantUsage(merchant: MerchantRow) {
  const [month] = await sql<{ used: number }[]>`
    select coalesce(sum(requests), 0)::int as used from agent_usage
    where merchant_id = ${merchant.id} and day >= date_trunc('month', current_date)`
  const [reset] = await sql<{ on: string }[]>`select to_char(date_trunc('month', current_date) + interval '1 month', 'YYYY-MM-DD') as on`
  return { plan: merchant.aiPlan, used: month!.used, allowance: monthlyAllowance(merchant), credits: merchant.aiCredits, resetsOn: reset!.on }
}

export async function recordUsage(merchant: MerchantRow, model: string, usage: TokenUsage) {
  await sql`
    update agent_usage set
      input_tokens = input_tokens + ${usage.inputTokens},
      output_tokens = output_tokens + ${usage.outputTokens},
      cache_read_tokens = cache_read_tokens + ${usage.cacheReadTokens},
      cache_write_tokens = cache_write_tokens + ${usage.cacheWriteTokens},
      model = ${model}
    where merchant_id = ${merchant.id} and day = current_date`
  await noteSpend().catch(() => {})
}

/** Tokens for AI work that isn't an owner's question (the end-of-day note): counted in cost, not in questions. */
export async function recordBackgroundUsage(merchant: MerchantRow, model: string, usage: TokenUsage) {
  await sql`
    insert into agent_usage (merchant_id, day, requests, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model)
    values (${merchant.id}, current_date, 0, ${String(usage.inputTokens)}, ${String(usage.outputTokens)},
      ${String(usage.cacheReadTokens)}, ${String(usage.cacheWriteTokens)}, ${model})
    on conflict (merchant_id, day) do update set
      input_tokens = agent_usage.input_tokens + excluded.input_tokens,
      output_tokens = agent_usage.output_tokens + excluded.output_tokens,
      cache_read_tokens = agent_usage.cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = agent_usage.cache_write_tokens + excluded.cache_write_tokens,
      model = excluded.model`
  await noteSpend().catch(() => {})
}
