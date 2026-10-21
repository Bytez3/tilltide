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
  /** What one point is worth when spent, e.g. "0.01". */
  pointValue: string
  redeemMaxPercent: number
  paypal: {
    status: 'none' | 'pending' | 'connected'
    email: string | null
    onboardingAvailable: boolean
    required: boolean
    feePercent: number
  }
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
  allowPoints: boolean
  pointsRedeemed: string
  discount: string
  createdAt: string
  paidAt: string | null
  url?: string
}

export interface Sweep {
  id: string
  amount: string
  display: string
  toOwner: string
  feeAmount: string
  feeDisplay: string
  feeWallet: string | null
  decimals: number
  token: 'USDC' | 'PYUSD'
  toWallet: string
  reason: string | null
  status: 'proposed' | 'signing' | 'submitted' | 'confirmed' | 'cancelled' | 'failed'
  signature: string | null
  error: string | null
}

export interface Refund {
  id: string
  paymentId: string
  amount: string
  display: string
  currency: string
  reason: string | null
  status: 'proposed' | 'processing' | 'pending' | 'completed' | 'failed' | 'cancelled'
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
  refunds: { count: number; total: string }
  netTakings: string
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
  updateShop: (
    patch: Partial<Pick<Merchant, 'name' | 'ownerWallet' | 'pointsPerUnit' | 'token' | 'pointValue' | 'redeemMaxPercent'>> & {
      paypalEmail?: string | null
    },
  ) =>
    request<Merchant>('/shop', { method: 'PATCH', body: JSON.stringify(patch) }),

  createPayment: (amount: string, rail: Rail = 'solana', usePoints = false, loyaltyCode?: string) =>
    request<Payment & { url: string }>('/shop/payments', post({ amount, rail, usePoints, loyaltyCode })),
  connectPayPal: () => request<{ url: string }>('/shop/paypal/connect', post()),
  refreshPayPal: () => request<Merchant>('/shop/paypal/refresh', post()),
  getPayment: (id: string) => request<Payment>(`/shop/payments/${id}`),
  listPayments: () => request<Payment[]>('/shop/payments'),
  getSummary: () => request<{ summary: DailySummary }>('/shop/summary'),
  chat: (messages: ChatTurn[]) =>
    request<{ reply: string; sweeps: Sweep[]; refunds: Refund[] }>('/shop/chat', post({ messages })),

  getRefund: (id: string) => request<Refund>(`/shop/refunds/${id}`),
  refundChallenge: (id: string) => request<{ nonce: string; domain: string; statement: string }>(`/shop/refunds/${id}/challenge`, post()),
  approveRefund: (id: string, signedMessage?: string, signature?: string) =>
    request<Refund>(`/shop/refunds/${id}/approve`, post(signedMessage && signature ? { signedMessage, signature } : {})),
  cancelRefund: (id: string) => request<Refund>(`/shop/refunds/${id}/cancel`, post()),

  beginSweep: (id: string, lastValidBlockHeight: bigint) =>
    request<Sweep>(`/shop/sweeps/${id}/begin`, post({ lastValidBlockHeight: lastValidBlockHeight.toString() })),
  till: () => request<{ token: string; balance: string; display: string }>('/shop/till'),
  proposeSweep: (amount: string, reason?: string) => request<Sweep>('/shop/sweeps', post({ amount, reason })),
  proposeRefund: (paymentId: string, amount?: string, reason?: string) =>
    request<Refund>(`/shop/payments/${paymentId}/refunds`, post({ amount, reason })),
  checkSweep: (id: string) => request<Sweep>(`/shop/sweeps/${id}/check`, post()),
  submitSweep: (id: string, signature: string) => request<Sweep>(`/shop/sweeps/${id}/submit`, post({ signature })),
  cancelSweep: (id: string) => request<Sweep>(`/shop/sweeps/${id}/cancel`, post()),

  // Local browser sandbox only (the server has no /sandbox routes anywhere else).
  sandbox: {
    info: () => request<{ customer: string; owner: string; customerBalances: { USDC: string; PYUSD: string } }>('/sandbox'),
    airdrop: (address: string) => request<{ ok: true }>('/sandbox/airdrop', post({ address })),
    pay: (url: string, amount?: string) => request<{ ok: true; signature?: string; message?: string }>('/sandbox/pay', post({ url, amount })),
    approvePayPal: (url: string) => request<{ ok: true }>('/sandbox/paypal/approve', post({ url })),
    finishPayPalOnboarding: (url: string) => request<{ ok: true }>('/sandbox/paypal/onboard', post({ url })),
  },

  getPoints: (wallet: string) => request<{ points: string; configured: boolean }>(`/points/${wallet}`),
}
