// Records the landing page's demo video (agent/public/media/tilltide-demo.mp4) from the browser sandbox.
//   npm i playwright-core; node docs/submission/record-demo-video.mjs http://localhost:8790 /tmp/video
// Then crop to the phone screen and encode for the web:
//   ffmpeg -i /tmp/video/<the large .webm> -vf "crop=390:844:0:0,fps=30" -c:v libx264 -pix_fmt yuv420p \
//     -crf 23 -preset slow -movflags +faststart -an agent/public/media/tilltide-demo.mp4
//   ffmpeg -ss 3 -i agent/public/media/tilltide-demo.mp4 -frames:v 1 -q:v 3 agent/public/media/tilltide-demo.jpg
import { chromium } from 'playwright-core'
const BASE = process.argv[2]
const OUT = process.argv[3]
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true })
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'light',
  recordVideo: { dir: OUT, size: { width: 780, height: 1688 } },
})
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('pageerror', e.message))
const pause = (ms = 1600) => page.waitForTimeout(ms)
const tap = async (text) => { await page.getByText(text, { exact: true }).first().click(); await pause(700) }
const keys = async (s) => { for (const ch of s) { await page.locator(`text="${ch}"`).first().click(); await page.waitForTimeout(180) } }
const tab = async (name) => { await page.getByRole('tab', { name }).click(); await pause(900) }
async function caption(text, ms = 2600) {
  await page.evaluate((t) => {
    let el = document.getElementById('cap')
    if (!el) {
      el = document.createElement('div')
      el.id = 'cap'
      el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:74px;z-index:99999;pointer-events:none;background:rgba(20,33,31,.93);color:#fff;font:600 16px/1.35 system-ui,-apple-system,sans-serif;padding:12px 14px;border-radius:14px;box-shadow:0 6px 20px rgba(0,0,0,.25);transition:opacity .25s'
      document.body.appendChild(el)
    }
    el.textContent = t
    el.style.opacity = t ? '1' : '0'
  }, text)
  if (ms) await page.waitForTimeout(ms)
}

await page.goto(BASE)
await page.getByPlaceholder('Shop name (new shops only)').waitFor()
await caption('Tilltide: a PayPal-first till and AI back office for small shops', 3200)
await caption('Sign in with the shop’s wallet. (In this demo, a test wallet is made for you.)', 0)
await page.getByPlaceholder('Shop name (new shops only)').pressSequentially('Pasty Shop', { delay: 70 })
await pause(600)
await tap('Sign in with wallet')
await page.getByText('Pasty Shop').first().waitFor()
await pause(1200)

await tab('Settings')
await caption('Connect the shop’s own PayPal: sales go straight to it', 0)
await tap('Connect PayPal')
await page.getByText('Connected ✓', { exact: false }).waitFor()
await pause(1400)
await caption('Add your best sellers once', 0)
for (const [name, price] of [['Pasty', '4.50'], ['Cream tea', '6.50'], ['Coffee', '3.00']]) {
  await page.getByPlaceholder('Item, e.g. Pasty').fill(name)
  await page.getByPlaceholder('£0.00').fill(price)
  await page.getByText('Add to menu', { exact: true }).first().click()
  await page.getByRole('button', { name: `${name} £${price} Edit` }).waitFor()
  await pause(500)
}
await pause(800)

await tab('Charge')
await caption('Tap what they’re having', 0)
const tile = (name) => page.getByLabel(new RegExp(`^${name}, £`)).click()
await tile('Pasty'); await pause(500)
await tile('Coffee'); await pause(500)
await tile('Pasty'); await pause(1200)
await caption('Charge on PayPal: the customer scans the QR with their phone camera', 0)
await tap('Charge £12.00')
await page.getByText('Customer approves in PayPal').waitFor()
await pause(2400)
await caption('They pay with PayPal or a card…', 1200)
await tap('Customer approves in PayPal')
await page.getByText('Paid', { exact: true }).waitFor()
await caption('Paid ✓ They scan again for a receipt with their loyalty points and code', 3600)

// Grab the receipt's loyalty code off-camera.
const [receipt] = await Promise.all([ctx.waitForEvent('page'), page.getByText('Open receipt', { exact: true }).click()])
await receipt.waitForLoadState()
const code = (await receipt.locator('strong').first().textContent()).trim()
await receipt.close()
await pause(600)

await tap('New sale')
await caption('Customers with a crypto wallet pay in PYUSD, PayPal’s stablecoin, priced in pounds', 0)
await tap('Wallet')
await tap('Keypad')
await keys('4.50')
await pause(600)
await tap('Charge £4.50')
await page.getByText('at today', { exact: false }).waitFor()
await pause(2400)
await tap('Customer pays in full')
await page.getByText('points sent to the customer', { exact: false }).waitFor({ timeout: 30000 })
await caption('Paid ✓ Loyalty points land in the customer’s wallet', 3200)

await tap('New sale')
await caption('Next visit: the customer gives the code from their receipt and spends their points', 0)
await tap('PayPal')
await tap('+ Loyalty code')
await page.getByPlaceholder('Code from their receipt').pressSequentially(code, { delay: 60 })
await keys('8.00')
await pause(500)
await tap('Charge £8.00')
await tap('Customer approves in PayPal')
await page.getByText('Used ', { exact: false }).waitFor()
await caption('Points came off the PayPal bill', 2800)

await tap('New sale')
await caption('Cash and your old card reader are recorded too, with change worked out', 0)
await tap('Cash')
await keys('2.20')
await tap('+ Work out change')
await page.getByPlaceholder(/Cash given/).pressSequentially('5', { delay: 80 })
await page.getByText('Change: £2.80').waitFor()
await pause(1800)
await tap('Record cash sale £2.20')
await page.getByText('in cash', { exact: true }).waitFor()
await pause(1400)

await tab('Activity')
await caption('Every sale, however they paid, in one place', 2600)
await caption('Send the takings to the owner’s wallet: Tilltide’s 0.5% fee is shown first', 0)
await tap('Send takings to owner')
await tap('Review')
await page.getByText(/^Tilltide fee \d/).waitFor()
await pause(2600)
await caption('Nothing moves until the owner signs with their wallet', 0)
await tap('Confirm & sign')
await page.getByText('Sent ✓').waitFor({ timeout: 60000 })
await pause(1800)
await caption('Refunds go back through PayPal, but only after the owner approves with their wallet', 0)
await page.getByText('Refund', { exact: true }).first().click()
await page.getByText('Approve with wallet').waitFor()
await pause(2200)
await tap('Approve with wallet')
await page.getByText('Refunded ✓').waitFor({ timeout: 30000 })
await pause(1800)
await caption('At closing time, the day is written up for you (and your bookkeeper gets a CSV)', 0)
await tap('Write report')
await page.getByText('Average sale', { exact: false }).first().waitFor({ timeout: 30000 })
await page.waitForTimeout(6500)
await page.evaluate(() => window.scrollTo(0, 0))
await pause(1500)
await caption('Try it yourself: demo.tilltide.bytez3.com', 4200)

const video = page.video()
await ctx.close()
console.log('video', await video.path())
await browser.close()
