import { beforeEach, describe, expect, it, vi } from 'vitest'

const sgtHolders = new Set<string>()
const skrBalances = new Map<string, string>()

vi.mock('@solana-mobile/skr-genesis-token', () => ({
  hasSeekerGenesisToken: async (_rpc: unknown, owner: string) => sgtHolders.has(owner),
}))
vi.mock('@solana/kit', async (orig) => {
  const real = await orig<typeof import('@solana/kit')>()
  return {
    ...real,
    createSolanaRpc: () => ({
      getTokenAccountsByOwner: (owner: string) => ({
        send: async () => ({
          value: skrBalances.has(owner)
            ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: skrBalances.get(owner) } } } } } }]
            : [],
        }),
      }),
    }),
  }
})

const A = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'
const B = '5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG'
const C = 'J2kgJqM1NDWucQPJN1PDZKZuwZEAXpLd2er3PX4DCFxd'

describe('isSeekerCustomer', () => {
  beforeEach(() => {
    vi.resetModules()
    sgtHolders.clear()
    skrBalances.clear()
    Object.assign(process.env, { DATABASE_URL: 'postgres://x@localhost/x', AUTH_DOMAIN: 'x', SEEKER_RPC_URL: 'https://mainnet.example' })
    delete process.env.SEEKER_TEST_WALLETS
  })

  it('counts Seeker Genesis Token holders and SKR holders (at least 1 SKR), nobody else', async () => {
    sgtHolders.add(A)
    skrBalances.set(B, '2500000') // 2.5 SKR
    skrBalances.set(C, '999999') // just under 1 SKR
    const { isSeekerCustomer } = await import('../src/services/seeker')
    expect(await isSeekerCustomer(A)).toBe(true)
    expect(await isSeekerCustomer(B)).toBe(true)
    expect(await isSeekerCustomer(C)).toBe(false)
  })

  it('is off without a mainnet RPC (devnet), except for sandbox test wallets', async () => {
    delete process.env.SEEKER_RPC_URL
    process.env.SEEKER_TEST_WALLETS = B
    const { isSeekerCustomer } = await import('../src/services/seeker')
    sgtHolders.add(A)
    expect(await isSeekerCustomer(A)).toBe(false)
    expect(await isSeekerCustomer(B)).toBe(true)
  })
})
