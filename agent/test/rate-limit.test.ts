import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { clientIp, rateLimit, requireOrigin } from '../src/rate-limit'

function appWith(max: number) {
  const app = new Hono()
  app.onError((err, c) => (err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.text('boom', 500)))
  app.use(rateLimit({ name: 't', windowMs: 60_000, max, key: clientIp }))
  app.get('/', (c) => c.text('ok'))
  return app
}

describe('rateLimit', () => {
  it('allows up to max requests per key per window, then 429 with retry-after', async () => {
    const app = appWith(2)
    const req = () => app.request('/', { headers: { 'x-forwarded-for': '1.1.1.1' } })
    expect((await req()).status).toBe(200)
    expect((await req()).status).toBe(200)
    const blocked = await req()
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('keys on the proxy-added (last) X-Forwarded-For entry, so clients can’t dodge it by spoofing', async () => {
    const app = appWith(1)
    expect((await app.request('/', { headers: { 'x-forwarded-for': 'spoof-a, 2.2.2.2' } })).status).toBe(200)
    expect((await app.request('/', { headers: { 'x-forwarded-for': 'spoof-b, 2.2.2.2' } })).status).toBe(429)
    expect((await app.request('/', { headers: { 'x-forwarded-for': '3.3.3.3' } })).status).toBe(200)
  })
})

describe('requireOrigin', () => {
  function locked(secret: string | null) {
    const app = new Hono()
    app.onError((err, c) => (err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.text('boom', 500)))
    app.use(requireOrigin(secret))
    app.get('/health', (c) => c.text('ok'))
    app.get('/shop', (c) => c.text('ok'))
    return app
  }

  it('refuses requests without the Cloudflare origin header, but keeps /health open', async () => {
    const app = locked('s3cret-value')
    expect((await app.request('/shop')).status).toBe(403)
    expect((await app.request('/shop', { headers: { 'x-tilltide-origin': 'wrong-value!' } })).status).toBe(403)
    expect((await app.request('/shop', { headers: { 'x-tilltide-origin': 's3cret-value' } })).status).toBe(200)
    expect((await app.request('/health')).status).toBe(200)
  })

  it('is a no-op when no secret is configured', async () => {
    expect((await locked(null).request('/shop')).status).toBe(200)
  })

  it('uses CF-Connecting-IP only when behind Cloudflare', () => {
    const c = { req: { header: (n: string) => ({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' })[n] } } as never
    expect(clientIp(c, true)).toBe('9.9.9.9')
    expect(clientIp(c, false)).toBe('1.1.1.1')
  })
})
