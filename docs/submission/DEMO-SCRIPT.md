# Demo video: 2 minutes 45 seconds

The rules cap the video at 3 minutes. Record on a phone (or the browser sandbox at 375px wide), with a second phone or window as the customer. Keep each shot tight; the timings add up to 2:45.

**Before recording**
- PayPal sandbox keys and `ANTHROPIC_API_KEY` set
- The shop has PayPal connected and prices in GBP
- One earlier PayPal sale from the sandbox buyer, so the customer already has points and a loyalty code
- The wallet customer holds a little PYUSD

| # | Time | Shot | Say (voice-over) |
| --- | --- | --- | --- |
| 1 | 0:00–0:12 | A Cornwall shopfront, then the till app on the counter | "Small shops pay card fees on every sale, run loyalty on paper, and do the books at night. Tilltide is a PayPal-first till with an AI back office." |
| 2 | 0:12–0:30 | Settings → PayPal shows "Connected ✓", with Tilltide's 0.5% fee line | "Each shop connects its own PayPal through PayPal's partner onboarding. Sales go straight to the shop, and Tilltide's small fee comes out through PayPal's platform fees. That fee pays for the AI." |
| 3 | 0:30–0:55 | Tap **Cream tea** on the menu; tap **+ Loyalty code** and type the customer's code; QR on screen; the customer phone scans and pays in PayPal sandbox; till flips to **Paid ✓ · Used N points** | "I tap what they're having. This customer has points from last week, so I type the code from their receipt and the points come off the bill. They pay with PayPal… and it's done." |
| 4 | 0:55–1:05 | Customer phone shows the receipt: points balance and loyalty code | "Their receipt shows their new points and the code to spend them next time. No app, no wallet needed." |
| 5 | 1:05–1:25 | Switch to Wallet, charge £4.50; the QR shows "= 6.01 PYUSD at today's rate"; a wallet pays; Paid ✓ | "Customers with a crypto wallet can pay in PYUSD, PayPal's stablecoin, priced in pounds at today's rate. Loyalty points land in their wallet." |
| 6 | 1:25–1:55 | Agent tab: "What did I take today, and what sold best?" → answer with the PayPal and wallet split and the top items. Then "Refund the cream tea, the scone was cold" → refund card | "At the end of the day I just ask. Claude reads the ledger and reconciles PayPal and wallet together. It can even set up a refund, but it can't move money by itself." |
| 7 | 1:55–2:15 | Tap **Approve with wallet**; the wallet prompt shows the exact refund wording; sign; **Refunded ✓** | "I approve by signing the exact refund with my wallet. Only then does Tilltide refund through PayPal, safely, so it can never refund twice." |
| 8 | 2:15–2:30 | Activity: the end-of-day card with Claude's note; tap **Export CSV** | "At closing time it writes my end-of-day report, and my bookkeeper gets a CSV." |
| 9 | 2:30–2:45 | Settings → Staff devices; pair a second phone with a code | "Staff can take payments on their own phone, but only the owner can move money. Tilltide: PayPal at the counter, AI in the back office, the owner in charge." |

**Captions to add:** "PayPal Partner Referrals", "Orders v2 + platform fees", "Payments v2 refund", "PYUSD", "Claude tool use".

**Screenshots for Devpost:** ready-made in [`screenshots/`](screenshots), captured from the sandbox at phone size:
- the till on PayPal, the PayPal QR, and Paid ✓
- the customer receipt with points and loyalty code
- the wallet QR priced in £ and paid in PYUSD, with the Seeker bonus
- PayPal connected in Settings, and a sale paid partly with points
- sending takings with the fee shown, and a refund awaiting approval
- the end-of-day report and staff pairing
- the menu in Settings, and a basket on the till

Add a screenshot of the agent answering once `ANTHROPIC_API_KEY` is set.
