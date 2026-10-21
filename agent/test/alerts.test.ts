import { afterEach, describe, expect, it } from 'vitest'
import { _resetAlerts, alert } from '../src/alerts'

afterEach(() => {
  _resetAlerts()
  delete process.env.ALERT_WEBHOOK_URL
})

describe('alerts', () => {
  it('posts to the webhook in a shape Discord and Slack both read, once per hour per key', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example/abc'
    const bodies: string[] = []
    const fake = (async (_url: string, init: RequestInit) => {
      bodies.push(init.body as string)
      return new Response('ok')
    }) as typeof fetch
    expect(await alert('k1', 'Sweep needs attention', fake)).toBe(true)
    expect(await alert('k1', 'Sweep needs attention', fake)).toBe(false)
    expect(await alert('k2', 'Another thing', fake)).toBe(true)
    expect(JSON.parse(bodies[0]!)).toEqual({ content: 'Tilltide: Sweep needs attention', text: 'Tilltide: Sweep needs attention' })
  })

  it('only logs when no webhook is set, and never throws when delivery fails', async () => {
    expect(await alert('k', 'x')).toBe(false)
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example/abc'
    const broken = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    expect(await alert('k3', 'x', broken)).toBe(false)
  })
})
