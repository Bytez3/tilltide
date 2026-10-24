import { AppConfig } from '@/constants/app-config'
import { reportReachable } from '@/lib/connectivity'

export interface Merchant {
  id: string
  name: string
  wallet: string
  ownerWallet: string | null
  token: 'USDC' | 'PYUSD'
  pointsPerUnit: number
  timezone: string
  /** Prices, takings and points are in this currency. */
  currency: 'GBP' | 'USD' | 'EUR'
  /** Local closing time (HH:MM): the end-of-day report is written then. */
  closeTime: string
  cluster: 'devnet' | 'mainnet'
  pointsMint: string | null
  paypalEnabled: boolean
  /** What one point is worth when spent, e.g. "0.01". */
  pointValue: string
  redeemMaxPercent: number
  /** Points multiplier for Seeker owners (1 = off). */
  seekerBonus: number
  /** 'staff' on a paired till device: can take payments, nothing else. */
  role?: 'owner' | 'staff'
  staffLabel?: string | null
  paypal: {
    status: 'none' | 'pending' | 'connected'
    email: string | null
    onboardingAvailable: boolean
    required: boolean
    feePercent: number
  }
}

/** 'cash' and 'card' (the shop's own card reader) record a sale paid outside Tilltide, for complete books. */
export type Rail = 'solana' | 'paypal' | 'cash' | 'card'

export interface Payment {
  id: string
  rail: Rail
  reference: string | null
  amount: string
  decimals: number
  currency: string
  /** Wallet sales: what the customer sends, in `token`. */
  tokenAmount: string | null
  token: string
  label: string | null
  /** The basket, when the sale was made from the item menu. Prices are per unit in `decimals` units. */
  items?: { id: string | null; name: string; price: string; qty: number }[] | null
  status: 'pending' | 'paid' | 'failed' | 'expired' | 'void'
  signature: string | null
  payer: string | null
  failureReason: string | null
  points: string | null
  pointsIssued: boolean
  /** Points were multiplied by the shop's Seeker bonus. */
  seekerBonus?: boolean
  allowPoints: boolean
  pointsRedeemed: string
  discount: string
  createdAt: string
  paidAt: string | null
  url?: string
}

/** One item on the shop's quick-sale menu. `price` is a decimal string in the shop's currency, e.g. "4.5". */
export interface Item {
  id: string
  name: string
  /** Key into ITEM_ICONS (components/item-icon.tsx). */
  icon: string
  price: string
  position: number
}

/** One line in the till's basket. */
export interface BasketLine {
  id: string
  qty: number
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

/** The shop's assistant allowance this month. */
export interface AssistantUsage {
  plan: 'included' | 'plus'
  used: number
  allowance: number
  /** Top-up questions, used once the month's allowance runs out. */
  credits: number
  /** YYYY-MM-DD, when the month's allowance starts again. */
  resetsOn: string
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
  items?: { name: string; qty: number; sales: string }[]
  topCustomers: { wallet: string; total: string; visits: number }[]
  pointsIssued: string
  stillPending: number
  refunds: { count: number; total: string }
  netTakings: string
  byRail: { solana: string; paypal: string; cash?: string; card?: string }
  voided?: number
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

const REQUEST_TIMEOUT_MS = 20_000

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  // React Native's fetch never times out by itself; a half-dead connection would leave the till spinning.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    res = await fetch(`${AppConfig.apiUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}),
        ...init.headers,
      },
    })
  } catch {
    clearTimeout(timer)
    reportReachable(false)
    throw new ApiError("Can't reach the Tilltide server. Check your connection.", 0)
  }
  // The timeout covers reading the body too: a reply that stalls halfway mustn't leave a spinner forever.
  const body = await res.json().catch(() => (controller.signal.aborted ? null : {}))
  clearTimeout(timer)
  if (body === null) {
    reportReachable(false)
    throw new ApiError("Can't reach the Tilltide server. Check your connection.", 0)
  }
  reportReachable(true)
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
  pairStaff: (code: string) => request<{ token: string; label: string }>('/auth/staff', post({ code })),
  createStaffInvite: (label: string) => request<{ code: string; expiresInMinutes: number }>('/shop/staff/invites', post({ label })),
  listStaff: () => request<{ id: string; label: string; since: string }[]>('/shop/staff'),
  removeStaff: (id: string) => request<{ ok: true }>(`/shop/staff/${id}/remove`, post()),

  getShop: () => request<Merchant>('/shop'),
  registerShop: (name: string) => request<Merchant>('/shop', post({ name })),
  updateShop: (
    patch: Partial<Pick<Merchant, 'name' | 'ownerWallet' | 'pointsPerUnit' | 'token' | 'pointValue' | 'redeemMaxPercent' | 'currency' | 'closeTime' | 'seekerBonus'>> & {
      paypalEmail?: string | null
    },
  ) =>
    request<Merchant>('/shop', { method: 'PATCH', body: JSON.stringify(patch) }),

  /** `amount` is typed on the keypad; with a basket it's added on top as "Other". The server prices the basket. */
  createPayment: (amount: string | undefined, rail: Rail = 'solana', usePoints = false, loyaltyCode?: string, items?: BasketLine[]) =>
    request<Payment & { url: string | null }>('/shop/payments', post({ amount, rail, usePoints, loyaltyCode, items: items?.length ? items : undefined })),
  blockhash: () => request<{ blockhash: string; lastValidBlockHeight: string; slot: string }>('/shop/blockhash'),
  voidSale: (id: string) => request<Payment>(`/shop/payments/${id}/void`, post()),
  listItems: () => request<Item[]>('/shop/items'),
  createItem: (name: string, price: string, icon?: string) => request<Item>('/shop/items', post({ name, price, icon })),
  updateItem: (id: string, changes: { name?: string; price?: string; position?: number; icon?: string }) =>
    request<Item>(`/shop/items/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
  deleteItem: (id: string) => request<{ ok: true }>(`/shop/items/${id}`, { method: 'DELETE' }),
  connectPayPal: () => request<{ url: string }>('/shop/paypal/connect', post()),
  refreshPayPal: () => request<Merchant>('/shop/paypal/refresh', post()),
  getPayment: (id: string) => request<Payment>(`/shop/payments/${id}`),
  ownerWalletChallenge: (ownerWallet: string) =>
    request<{ nonce: string; domain: string; statement: string }>('/shop/owner-wallet/challenge', post({ ownerWallet })),
  approveOwnerWallet: (signedMessage: string, signature: string) => request<Merchant>('/shop/owner-wallet', post({ signedMessage, signature })),
  cancelPayment: (id: string) => request<Payment>(`/shop/payments/${id}/cancel`, post({})),
  listPayments: () => request<Payment[]>('/shop/payments'),
  getSummary: () => request<{ summary: DailySummary }>('/shop/summary'),
  chat: (messages: ChatTurn[]) =>
    request<{ reply: string; sweeps: Sweep[]; refunds: Refund[]; assistant?: AssistantUsage }>('/shop/chat', post({ messages })),
  assistantUsage: () => request<AssistantUsage>('/shop/assistant'),

  getRefund: (id: string) => request<Refund>(`/shop/refunds/${id}`),
  refundChallenge: (id: string) => request<{ nonce: string; domain: string; statement: string }>(`/shop/refunds/${id}/challenge`, post()),
  approveRefund: (id: string, signedMessage?: string, signature?: string) =>
    request<Refund>(`/shop/refunds/${id}/approve`, post(signedMessage && signature ? { signedMessage, signature } : {})),
  cancelRefund: (id: string) => request<Refund>(`/shop/refunds/${id}/cancel`, post()),

  beginSweep: (id: string, lastValidBlockHeight: bigint) =>
    request<Sweep>(`/shop/sweeps/${id}/begin`, post({ lastValidBlockHeight: lastValidBlockHeight.toString() })),
  reports: () => request<{ date: string; text: string; narrative: string | null; createdAt: string }[]>('/shop/reports'),
  writeReport: (date?: string) => request<{ date: string; text: string; narrative: string | null; createdAt: string }>('/shop/reports', post({ date })),
  exportLink: (from: string, to: string) => request<{ url: string; expiresInMinutes: number }>('/shop/export', post({ from, to })),
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

  getPoints: (wallet: string) => request<{ points: string; configured: boolean }>(`/shop/points/${wallet}`),
}
