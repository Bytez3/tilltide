import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import { clientIp, rateLimit } from '../src/rate-limit'

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
