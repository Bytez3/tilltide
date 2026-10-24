/**
 * What the AI costs, in pounds: a daily budget across every shop, with alerts on the way up, so a bug
 * or an abusive burst can't run up the Claude bill. Prices are Anthropic's list prices per million
 * tokens; cache reads cost a tenth of input and cache writes a quarter more.
 */
import { alert } from '../alerts'
import { config } from '../config'
import { sql } from '../db'
import { usdPerUnit } from '../fx'

/** USD per million tokens: [input, output]. Unknown models are priced as Opus 5. */
const PRICES: Record<string, [number, number]> = {
  'claude-opus-5': [5, 25],
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
  'claude-fable-5': [10, 50],
  'claude-fable-5-1': [10, 50],
}

export interface TokenUsage {
  inputTokens: number | bigint
  outputTokens: number | bigint
  cacheReadTokens: number | bigint
  cacheWriteTokens: number | bigint
}

export function costUsd(model: string | null, u: TokenUsage): number {
  const [input, output] = PRICES[model ?? ''] ?? PRICES['claude-opus-5']!
  const n = (v: number | bigint) => Number(v)
  return (n(u.inputTokens) * input + n(u.cacheReadTokens) * input * 0.1 + n(u.cacheWriteTokens) * input * 1.25 + n(u.outputTokens) * output) / 1e6
}

/** Pounds per US dollar, from the same rates the till uses; a fixed fallback if they can't be fetched. */
export async function gbpPerUsd(): Promise<number> {
  const usdPerGbp = await usdPerUnit('GBP').then((r) => Number(r) / 1e6, () => 1.27)
  return 1 / usdPerGbp
}

/** Today's AI spend across all shops, in pounds. */
export async function spendTodayGbp(): Promise<number> {
  const rows = await sql<(TokenUsage & { model: string | null })[]>`
    select model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens from agent_usage where day = current_date`
  const usd = rows.reduce((sum, r) => sum + costUsd(r.model, r), 0)
  return usd * (await gbpPerUsd())
}

export class BudgetError extends Error {}

/** Refuses new AI work once today's budget is spent. */
export async function checkBudget() {
  const budget = config.agent.dailyBudgetGbp
  if (budget === null) return
  if ((await spendTodayGbp()) >= budget) {
    void alert('ai-budget:100', `AI spend has reached today's £${budget} budget; the assistant is paused until midnight UTC`)
    throw new BudgetError('The assistant is paused for the rest of today. It resets at midnight UTC. Your till, reports and exports all still work.')
  }
}

/** After a call: tells a human as spend passes half, 80% and all of the day's budget. */
export async function noteSpend() {
  const budget = config.agent.dailyBudgetGbp
  if (budget === null) return
  const spent = await spendTodayGbp()
  for (const pct of [100, 80, 50]) {
    if (spent >= (budget * pct) / 100) {
      void alert(`ai-budget:${pct}`, `AI spend today is £${spent.toFixed(2)}, ${pct}% of the £${budget} daily budget`)
      return
    }
  }
}
