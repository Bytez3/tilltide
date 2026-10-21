import { describe, expect, it, vi } from 'vitest'

describe('checkProductionConfig', () => {
  it('is quiet on devnet', async () => {
    vi.resetModules()
    Object.assign(process.env, { DATABASE_URL: 'postgres://x@localhost/x', AUTH_DOMAIN: 'x', SOLANA_CLUSTER: 'devnet' })
    const { checkProductionConfig } = await import('../src/production')
    expect(checkProductionConfig()).toEqual([])
  })

  it('refuses unsafe mainnet settings and warns about missing ones', async () => {
    vi.resetModules()
    Object.assign(process.env, {
      DATABASE_URL: 'postgres://x@localhost/x',
      SOLANA_CLUSTER: 'mainnet',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      AUTH_DOMAIN: 'api-production-1.up.railway.app',
      PUBLIC_URL: 'http://insecure.example',
      PAYPAL_CLIENT_ID: 'id',
      PAYPAL_CLIENT_SECRET: 'secret',
      PAYPAL_ENV: 'sandbox',
      PAYPAL_REQUIRE_CONNECTED: 'false',
      FX_RATES: 'GBP:1.25',
    })
    const { checkProductionConfig } = await import('../src/production')
    const problems = checkProductionConfig({ FX_RATES: 'GBP:1.25' })
    const fatal = problems.filter((p) => p.level === 'fatal').map((p) => p.message).join('\n')
    expect(fatal).toMatch(/public mainnet endpoint/)
    expect(fatal).toMatch(/isn't a domain you control/)
    expect(fatal).toMatch(/must be https/)
    expect(fatal).toMatch(/PAYPAL_REQUIRE_CONNECTED/)
    expect(fatal).toMatch(/FX_RATES/)
    expect(problems.some((p) => p.level === 'warn' && /ALERT_WEBHOOK_URL/.test(p.message))).toBe(true)
    for (const k of ['SOLANA_CLUSTER', 'SOLANA_RPC_URL', 'PUBLIC_URL', 'PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_ENV', 'PAYPAL_REQUIRE_CONNECTED', 'FX_RATES']) delete process.env[k]
  })
})
