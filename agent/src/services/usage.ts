import { config } from '../config'
import { sql, type MerchantRow } from '../db'

export class UsageLimitError extends Error {}

/**
 * Reserves one agent request for today. Throws once the shop has used its daily allowance, so a
 * runaway or abused session can't run up the Claude bill. Counted before the call, so concurrent
 * requests can't slip past the cap.
 */
export async function reserveAgentRequest(merchant: MerchantRow) {
  const [row] = await sql<{ requests: number }[]>`
    insert into agent_usage (merchant_id, day, requests) values (${merchant.id}, current_date, 1)
    on conflict (merchant_id, day) do update set requests = agent_usage.requests + 1
    returning requests`
  if (row!.requests > config.agent.dailyLimit) {
    await sql`update agent_usage set requests = requests - 1 where merchant_id = ${merchant.id} and day = current_date`
    throw new UsageLimitError(`Daily agent limit reached (${config.agent.dailyLimit} questions). It resets at midnight UTC.`)
  }
}

export async function recordUsage(
  merchant: MerchantRow,
  model: string,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
) {
  await sql`
    update agent_usage set
      input_tokens = input_tokens + ${usage.inputTokens},
      output_tokens = output_tokens + ${usage.outputTokens},
      cache_read_tokens = cache_read_tokens + ${usage.cacheReadTokens},
      cache_write_tokens = cache_write_tokens + ${usage.cacheWriteTokens},
      model = ${model}
    where merchant_id = ${merchant.id} and day = current_date`
}
