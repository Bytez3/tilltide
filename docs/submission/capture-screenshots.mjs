// Recaptures docs/submission/screenshots from the browser sandbox (needs the sandbox running).
// npm i playwright-core; node docs/submission/capture-screenshots.mjs docs/submission/screenshots
import { chromium } from 'playwright-core'
const OUT = process.argv[2]
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light' })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror', e.message))
const shot = async (name, p = page) => { await p.waitForTimeout(600); await p.screenshot({ path: `${OUT}/${name}.png` }); console.log('saved', name) }
const tap = (text) => page.getByText(text, { exact: true }).first().click()
const keys = async (s) => { for (const ch of s) await page.locator(`text="${ch}"`).first().click() }
const tab = (name) => page.getByRole('tab', { name }).click()

await page.goto('http://localhost:8081')
await page.getByPlaceholder('Shop name (new shops only)').fill('Pasty Shop')
await tap('Sign in with wallet')
await page.getByText('Pasty Shop').first().waitFor()

// Settings: connect PayPal, Seeker bonus x2, points worth 10p.
await tab('Settings')
await tap('Connect PayPal')
await page.getByText('Connected ✓', { exact: false }).waitFor()
await tap('×2')
await page.locator('input[value="0.01"]').fill('0.10')
await tap('Save')
await page.getByText('Saved', { exact: true }).waitFor()
await shot('07-settings-paypal-connected')

// The shop's menu: items the till taps into a sale.
for (const [name, price] of [['Pasty', '4.50'], ['Cream tea', '6.50'], ['Coffee', '3.00'], ['Saffron bun', '2.20']]) {
  await page.getByPlaceholder('Item, e.g. Pasty').fill(name)
  await page.getByPlaceholder('£0.00').fill(price)
  await tap('Add to menu')
  await page.getByRole('button', { name: `${name} £${price} Edit` }).waitFor()
}
await page.getByText('Items the till can tap into a sale', { exact: false }).scrollIntoViewIfNeeded()
await page.evaluate(() => window.scrollBy(0, -80))
await shot('13-menu-settings')

// PayPal sale.
await tab('Charge')
const tile = (name) => page.getByLabel(new RegExp(`^${name}, £`)).click()
await tile('Pasty')
await tile('Coffee')
await tile('Pasty')
await shot('01-till-paypal')
await tap('Charge £12.00')
await page.getByText('Customer approves in PayPal').waitFor()
await shot('02-paypal-qr')
await tap('Customer approves in PayPal')
await page.getByText('Paid', { exact: true }).waitFor()
await shot('03-paid-paypal')

// The customer's receipt.
const [receipt] = await Promise.all([ctx.waitForEvent('page'), tap('Open receipt')])
await receipt.waitForLoadState()
await receipt.setViewportSize({ width: 390, height: 844 })
await shot('04-receipt-paypal-loyalty', receipt)
const code = (await receipt.locator('strong').first().textContent()).trim()
await receipt.close()

// Wallet sale in pounds, Seeker customer.
await tap('New sale')
await tap('Wallet')
await tap('Keypad')
await keys('4.50')
await tap('Charge £4.50')
await page.getByText('at today', { exact: false }).waitFor()
await shot('05-wallet-qr-pyusd')
await tap('Customer pays in full')
await page.getByText('points sent to the customer', { exact: false }).waitFor({ timeout: 30000 })
await shot('06-paid-wallet-seeker-bonus')

// Next visit: PayPal sale spending points with the loyalty code.
await tap('New sale')
await tap('PayPal')
await tap('+ Loyalty code')
await page.getByPlaceholder('Code from their receipt').fill(code)
await keys('8.00')
await tap('Charge £8.00')
await tap('Customer approves in PayPal')
await page.getByText('Used ', { exact: false }).waitFor()
await shot('08-paid-with-points')

// A cash sale, recorded for the books, with change worked out.
await tap('New sale')
await tap('Cash')
await keys('2.20')
await tap('+ Work out change')
await page.getByPlaceholder(/Cash given/).fill('5')
await page.getByText('Change: £2.80').waitFor()
await shot('14-cash-change')
await tap('Record cash sale £2.20')
await page.getByText('in cash', { exact: true }).waitFor()

// Activity: send takings (fee shown), refund, end of day.
await tab('Activity')
await tap('Send takings to owner')
await tap('Review')
await page.getByText(/^Tilltide fee \d/).waitFor()
await shot('09-send-takings-fee')
await tap('Confirm & sign')
await page.getByText('Sent ✓').waitFor({ timeout: 60000 })
await page.getByText('Refund', { exact: true }).first().click()
await page.getByText('Approve with wallet').waitFor()
await shot('10-refund-proposed')
await tap('Approve with wallet')
await page.getByText('Refunded ✓').waitFor({ timeout: 30000 })
await tap('Write report')
await page.getByText('Average sale', { exact: false }).first().waitFor({ timeout: 30000 })
await page.waitForTimeout(6500) // finished approval cards clear themselves
await page.evaluate(() => window.scrollTo(0, 0))
await shot('11-activity-end-of-day')

// Staff device pairing code.
await tab('Settings')
await page.getByPlaceholder('Name, e.g. Saturday till').fill('Saturday till')
await tap('Add staff device')
await page.getByText('Pairing code', { exact: true }).scrollIntoViewIfNeeded()
await shot('12-staff-pairing')

await browser.close()
