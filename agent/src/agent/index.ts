import Anthropic from '@anthropic-ai/sdk'
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import { fromBaseUnits, toBaseUnits } from '@tilltide/agent-pay-kit'
import { z } from 'zod'
import { isDate } from '../dates'
import { LEDGER_DECIMALS, sql, type MerchantRow, type PaymentRow, type SweepRow } from '../db'
import { config } from '../config'
import { merchantToken } from '../services/merchants'
import { recordUsage } from '../services/usage'
import { issuePointsForPayment, serializePayment } from '../services/payments'
import { getDailySummary, reconcileDay, todayIn } from '../services/summary'
import { proposeSweep, serializeSweep } from '../services/sweeps'

const client = new Anthropic()

const SYSTEM_PROMPT = `You are Tilltide, the back-office assistant for a small independent shop.
The shop takes payments two ways: stablecoins (USDC or PYUSD) on Solana into its till wallet, and PayPal checkout for customers without a crypto wallet. Both are in one ledger, in US dollars 1:1.
The person you're talking to is the shop owner, usually on their phone between customers. Answer in plain British English, short enough to read at a glance. Lead with the number they asked for.

You can look up payments, build daily summaries and reconcile the till against the chain. Use the tools; never guess a figure.

Money rules:
- You cannot move money. sweep_to_owner only creates a proposal; the owner must tap Confirm and sign in their wallet. Say so plainly, and never claim a sweep has happened.
- Sweeps carry Tilltide's small fee (shown on the confirm card). When you propose one, say how much reaches the owner and what the fee is.
- Only suggest a sweep when it makes sense (e.g. end of day, or the till holds a lot). Leave a float if the owner has mentioned one.
- issue_points only retries points for a paid payment that is missing them. It can't award arbitrary points.

PayPal takings settle to the shop's PayPal balance, not the till wallet, so they never appear in the till's onchain balance and can't be swept. PayPal customers don't earn points yet (they have no wallet). PayPal payers show as "paypal:<id>".

When reconciling, explain anything onchain that isn't in the ledger in one line each, and say whether the takings match.
Wallet addresses are long: show the first 4 and last 4 characters.`

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

/** The agent's tools, bound to one shop. Sweeps the agent proposes are pushed onto `proposed`. */
export function buildTools(merchant: MerchantRow, proposed: SweepRow[]) {
  const token = merchantToken(merchant)
  const dateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Calendar date YYYY-MM-DD in the shop's timezone. Defaults to today.")

  return [
    betaZodTool({
      name: 'get_payments',
      description: 'List recent payment requests (paid, pending, failed, expired), newest first.',
      inputSchema: z.object({
        status: z.enum(['paid', 'pending', 'failed', 'expired']).optional(),
        rail: z.enum(['solana', 'paypal']).optional(),
        since: z.iso.datetime({ offset: true }).optional().describe('ISO 8601 timestamp; only payments created after this'),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      run: async ({ status, rail, since, limit }) => {
        const rows = await sql<PaymentRow[]>`
          select * from payments where merchant_id = ${merchant.id}
          ${status ? sql`and status = ${status}` : sql``}
          ${rail ? sql`and rail = ${rail}` : sql``}
          ${since ? sql`and created_at > ${since}` : sql``}
          order by created_at desc limit ${limit ?? 25}`
        return JSON.stringify(
          rows.map((p) => ({ ...serializePayment(p), amount: fromBaseUnits(p.amount, LEDGER_DECIMALS) })),
        )
      },
    }),
    betaZodTool({
      name: 'get_daily_summary',
      description:
        'Takings, sale count, average sale, top customers, points issued and problems for one day. Set reconcile to also check the till against the chain (current balance, onchain activity missing from the ledger).',
      inputSchema: z.object({ date: dateSchema, reconcile: z.boolean().optional() }),
      run: async ({ date, reconcile }) => {
        const day = date ?? todayIn(merchant.timezone)
        if (!isDate(day)) return 'Invalid date'
        const summary = await getDailySummary(merchant, day)
        const reconciliation = reconcile ? await reconcileDay(merchant, day) : undefined
        return JSON.stringify({ summary, reconciliation })
      },
    }),
    betaZodTool({
      name: 'issue_points',
      description: 'Retry issuing loyalty points for a paid payment whose points are missing.',
      inputSchema: z.object({ payment_id: z.string().uuid() }),
      run: async ({ payment_id }) => {
        const [owned] = await sql`select 1 from payments where id = ${payment_id} and merchant_id = ${merchant.id}`
        if (!owned) return 'Payment not found for this shop'
        const result = await issuePointsForPayment(payment_id)
        return JSON.stringify(result.issued ? { ...result, points: result.points.toString() } : result)
      },
    }),
    betaZodTool({
      name: 'sweep_to_owner',
      description: `Propose moving ${token.symbol} from the till wallet to the owner's wallet. Creates a proposal the owner must confirm and sign in the app; it does not move funds.`,
      inputSchema: z.object({
        amount: z.string().regex(/^\d+(\.\d+)?$/).describe(`Amount in ${token.symbol}, e.g. "120.50"`),
        reason: z.string().max(200).describe('One line shown to the owner on the confirm card'),
      }),
      run: async ({ amount, reason }) => {
        try {
          const sweep = await proposeSweep(merchant, toBaseUnits(amount, token.decimals), reason)
          proposed.push(sweep)
          return JSON.stringify({ proposed: true, sweep: serializeSweep(sweep), next: 'Owner must tap Confirm and sign.' })
        } catch (err) {
          return JSON.stringify({ proposed: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    }),
  ]
}

export async function runAgent(merchant: MerchantRow, history: ChatTurn[]) {
  const token = merchantToken(merchant)
  const proposed: SweepRow[] = []
  const tools = buildTools(merchant, proposed)

  const context = `Shop: ${merchant.name}. Timezone ${merchant.timezone}; today is ${todayIn(merchant.timezone)}. Payment token ${token.symbol}. Points rate ${merchant.pointsPerUnit} per 1 ${token.symbol}. Owner wallet ${merchant.ownerWallet ? 'is set' : 'is NOT set'}.`

  const model = config.agent.model
  // Adaptive thinking, effort and server-side fallbacks exist on the current Opus/Sonnet/Fable models;
  // Haiku 4.5 takes none of them.
  const isHaiku = model.startsWith('claude-haiku')
  const runner = client.beta.messages.toolRunner({
    model,
    max_tokens: 16000,
    ...(isHaiku
      ? {}
      : {
          thinking: { type: 'adaptive' as const },
          output_config: { effort: config.agent.effort },
          // Re-run on Anthropic's recommended fallback model if a safety classifier declines.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default' as const,
        }),
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: context },
    ],
    tools,
    max_iterations: 8,
    messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
  })

  // Every model call in the loop is billed, so add up usage across all of them.
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let final: Awaited<ReturnType<typeof runner.done>> | undefined
  for await (const message of runner) {
    usage.inputTokens += message.usage.input_tokens
    usage.outputTokens += message.usage.output_tokens
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0
    usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0
    final = message
  }
  if (!final) throw new Error('Agent returned no message')
  await recordUsage(merchant, model, usage)

  if (final.stop_reason === 'refusal') {
    return { reply: "Sorry, I can't help with that one.", sweeps: proposed.map(serializeSweep), usage }
  }
  const reply = final.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  if (!reply) {
    return {
      reply:
        final.stop_reason === 'max_tokens'
          ? 'That answer got too long. Try asking about one day or one customer.'
          : "I couldn't finish working that out. Try a narrower question.",
      sweeps: proposed.map(serializeSweep),
      usage,
    }
  }
  return { reply, sweeps: proposed.map(serializeSweep), usage }
}
