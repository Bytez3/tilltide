/**
 * Tells a human when something needs attention: a sweep that didn't add up, a refund PayPal won't
 * settle, money in the till Tilltide didn't take. Posts to ALERT_WEBHOOK_URL (Discord or Slack
 * incoming webhook) and always logs. The same alert is sent at most once an hour.
 */
const DEDUPE_MS = 60 * 60 * 1000
const sent = new Map<string, number>()

export async function alert(key: string, message: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  console.error(`[alert] ${message}`)
  const url = process.env.ALERT_WEBHOOK_URL
  const last = sent.get(key)
  if (!url || (last && Date.now() - last < DEDUPE_MS)) return false
  sent.set(key, Date.now())
  try {
    // Discord reads `content`, Slack reads `text`; sending both works for either.
    const body = JSON.stringify({ content: `Tilltide: ${message}`, text: `Tilltide: ${message}` })
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch (err) {
    console.error(`[alert] could not deliver: ${err instanceof Error ? err.message : err}`)
    return false
  }
}

/** For tests only. */
export function _resetAlerts() {
  sent.clear()
}
