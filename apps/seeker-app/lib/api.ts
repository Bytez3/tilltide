import { AppConfig } from '@/constants/app-config'

export interface Merchant {
  id: string
  name: string
  wallet: string
  ownerWallet: string | null
  token: 'USDC' | 'PYUSD'
  pointsPerUnit: number
  timezone: string
  cluster: 'devnet' | 'mainnet'
  pointsMint: string | null
  paypalEnabled: boolean
}

export type Rail = 'solana' | 'paypal'

export interface Payment {
  id: string
  rail: Rail
  reference: string | null
  amount: string
  decimals: number
  token: string
  label: string | null
  status: 'pending' | 'paid' | 'failed' | 'expired'
  signature: string | null
  payer: string | null
  failureReason: string | null
  points: string | null
  pointsIssued: boolean
  createdAt: string
  paidAt: string | null
  url?: string
}

export interface Sweep {
  id: string
  amount: string
  display: string
  decimals: number
  token: 'USDC' | 'PYUSD'
  toWallet: string
  reason: string | null
  status: 'proposed' | 'submitted' | 'confirmed' | 'cancelled'
  signature: string | null
  error: string | null
}

export interface DailySummary {
  date: string
  token: string
  takings: string
  paidCount: number
  averageSale: string
  uniqueCustomers: number
  topCustomers: { wallet: string; total: string; visits: number }[]
  pointsIssued: string
  stillPending: number
  byRail: { solana: string; paypal: string }
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

let sessionToken: string | null = null
let onSignedOut: (() => void) | null = null

/** The session from Sign In With Solana. Every /shop call carries it. */
export function setSession(token: string | null, signedOut?: () => void) {
  sessionToken = token
  onSignedOut = signedOut ?? null
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${AppConfig.apiUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
        ...init.headers,
      },
    })
  } catch {
    throw new ApiError("Can't reach the Tilltide server. Check your connection.", 0)
  }
  const body = await res.json().catch(() => ({}))
  if (res.status === 401 && path.startsWith('/shop')) onSignedOut?.()
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status)
  return body as T
}

const post = (body?: unknown) => ({ method: 'POST', body: JSON.stringify(body ?? {}) })

export const api = {
  nonce: () => request<{ nonce: string; domain: string; statement: string }>('/auth/nonce', post()),
  verifySignIn: (address: string, signedMessage: string, signature: string) =>
    request<{ token: string; wallet: string }>('/auth/verify', post({ address, signedMessage, signature })),
  logout: () => request<{ ok: true }>('/shop/logout', post()),

  getShop: () => request<Merchant>('/shop'),
  registerShop: (name: string) => request<Merchant>('/shop', post({ name })),
  updateShop: (patch: Partial<Pick<Merchant, 'name' | 'ownerWallet' | 'pointsPerUnit' | 'token'>>) =>
    request<Merchant>('/shop', { method: 'PATCH', body: JSON.stringify(patch) }),

  createPayment: (amount: string, rail: Rail = 'solana', label?: string) =>
    request<Payment & { url: string }>('/shop/payments', post({ amount, rail, label })),
  getPayment: (id: string) => request<Payment>(`/shop/payments/${id}`),
  listPayments: () => request<Payment[]>('/shop/payments'),
  getSummary: () => request<{ summary: DailySummary }>('/shop/summary'),
  chat: (messages: ChatTurn[]) => request<{ reply: string; sweeps: Sweep[] }>('/shop/chat', post({ messages })),

  checkSweep: (id: string) => request<Sweep>(`/shop/sweeps/${id}/check`, post()),
  submitSweep: (id: string, signature: string) => request<Sweep>(`/shop/sweeps/${id}/submit`, post({ signature })),
  cancelSweep: (id: string) => request<Sweep>(`/shop/sweeps/${id}/cancel`, post()),

  getPoints: (wallet: string) => request<{ points: string; configured: boolean }>(`/points/${wallet}`),
}
