import { AppConfig } from '@/constants/app-config'

export interface Merchant {
  id: string
  name: string
  wallet: string
  ownerWallet: string | null
  token: 'USDC' | 'PYUSD'
  pointsPerUnit: number
  bonusMultiplier: number
  timezone: string
  cluster: 'devnet' | 'mainnet'
  pointsMint: string | null
}

export interface Payment {
  id: string
  reference: string
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
  status: 'proposed' | 'confirmed' | 'cancelled'
  signature: string | null
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
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export class ApiError extends Error {}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${AppConfig.apiUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-api-key': AppConfig.apiKey, ...init.headers },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`)
  return body as T
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

export const api = {
  registerMerchant: (name: string, wallet: string) => request<Merchant>('/merchants', json({ name, wallet })),
  getMerchant: (id: string) => request<Merchant>(`/merchants/${id}`),
  updateMerchant: (id: string, patch: Partial<Pick<Merchant, 'name' | 'ownerWallet' | 'pointsPerUnit' | 'token'>>) =>
    request<Merchant>(`/merchants/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  createPayment: (merchantId: string, amount: string, label?: string) =>
    request<Payment & { url: string }>(`/merchants/${merchantId}/payments`, json({ amount, label })),
  getPayment: (id: string) => request<Payment>(`/payments/${id}`),
  listPayments: (merchantId: string) => request<Payment[]>(`/merchants/${merchantId}/payments`),
  getSummary: (merchantId: string) => request<{ summary: DailySummary }>(`/merchants/${merchantId}/summary`),
  chat: (merchantId: string, messages: ChatTurn[]) =>
    request<{ reply: string; sweeps: Sweep[] }>(`/merchants/${merchantId}/chat`, json({ messages })),
  confirmSweep: (id: string, signature: string) => request<Sweep>(`/sweeps/${id}/confirm`, json({ signature })),
  cancelSweep: (id: string) => request<Sweep>(`/sweeps/${id}/cancel`, json({})),
  getPoints: (wallet: string) => request<{ points: string; configured: boolean }>(`/points/${wallet}`),
}
