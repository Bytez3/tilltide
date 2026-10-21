import { timingSafeEqual } from 'node:crypto'
import type { Context, Next } from 'hono'
import { HTTPException } from 'hono/http-exception'

/**
 * Small fixed-window rate limiter, in memory. Fine for one API instance; move to Postgres or Redis
 * before running several replicas.
 */
export function rateLimit(opts: { windowMs: number; max: number; key: (c: Context) => string; name: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>()
  setInterval(() => {
    const now = Date.now()
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
  }, opts.windowMs).unref()

  return async (c: Context, next: Next) => {
    const key = `${opts.name}:${opts.key(c)}`
    const now = Date.now()
    let entry = hits.get(key)
    if (!entry || entry.resetAt <= now) hits.set(key, (entry = { count: 0, resetAt: now + opts.windowMs }))
    entry.count++
    if (entry.count > opts.max) {
      c.header('retry-after', String(Math.ceil((entry.resetAt - now) / 1000)))
      throw new HTTPException(429, { message: 'Too many requests, slow down' })
    }
    await next()
  }
}

/**
 * The caller's IP. Behind Cloudflare (origin locked with ORIGIN_SECRET) it's CF-Connecting-IP, which only
 * Cloudflare can set once direct traffic is refused. Otherwise, behind Railway's proxy the client address is the last X-Forwarded-For entry
 * (earlier entries can be set by the client, so they're not trusted).
 */
export function clientIp(c: Context, behindCloudflare = false): string {
  if (behindCloudflare) {
    const cf = c.req.header('cf-connecting-ip')
    if (cf) return cf
  }
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return forwarded.split(',').at(-1)!.trim()
  return c.req.header('x-real-ip') ?? 'unknown'
}

/**
 * When ORIGIN_SECRET is set, only requests carrying it (added by a Cloudflare Transform Rule) get through,
 * so nobody can bypass Cloudflare by calling the Railway address directly. /health stays open for
 * Railway's health check.
 */
export function requireOrigin(secret: string | null) {
  const expected = secret ? Buffer.from(secret) : null
  return async (c: Context, next: Next) => {
    if (expected && c.req.path !== '/health') {
      const given = Buffer.from(c.req.header('x-tilltide-origin') ?? '')
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw new HTTPException(403, { message: 'Forbidden' })
      }
    }
    await next()
  }
}
