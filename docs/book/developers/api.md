# API reference

Base URL: your deployment, for example `https://tilltide.bytez3.com`. Requests and responses are JSON. Errors are `{ "error": "…" }` with a 4xx or 5xx status, and the message is written for the shop owner.

Money is sent as decimal strings in the shop's currency (`"4.50"`). Sales in responses use integer strings in 6-decimal base units (`"4500000"`) with `decimals: 6`. Menu items return a decimal `price` (`"4.5"`), and sweeps and the till balance are in token units (USDC or PYUSD), with a `display` string alongside.

## Signing in

The till signs in with its wallet (Sign In With Solana). Staff phones pair with a one-time code.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/auth/nonce` | – | `{ nonce, domain, statement }` to build the sign-in message |
| POST | `/auth/verify` | `{ address, signedMessage, signature }` | `{ token, wallet }` |
| POST | `/auth/staff` | `{ code }` | `{ token, label }` for a staff phone |

Send the token as `Authorization: Bearer <token>` on every `/shop` request. Staff tokens can take payments, read the menu, sales and summaries, and sign out; everything else returns 403.

## The shop

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/shop` | The shop and its settings (404 before it's registered) |
| POST | `/shop` | Register: `{ name }` |
| PATCH | `/shop` | Settings: `name`, `ownerWallet`, `token`, `currency`, `pointsPerUnit`, `pointValue`, `redeemMaxPercent`, `seekerBonus`, `closeTime`, `timezone`, `paypalEmail` |
| POST | `/shop/logout` | Ends the session |
| POST | `/shop/paypal/connect` | Starts PayPal partner onboarding: `{ url }` |
| POST | `/shop/paypal/refresh` | Asks PayPal whether onboarding finished |

## Menu

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/shop/items` | Staff allowed |
| POST | `/shop/items` | `{ name, price, icon? }` |
| PATCH | `/shop/items/:id` | Any of `name`, `price`, `icon`, `position` |
| DELETE | `/shop/items/:id` | Archives it; past sales keep their copy |

`icon` is one of: pastry, bread, cake, cupcake, cookie, icecream, coffee, tea, soda, water, beer, wine, pizza, burger, sandwich, noodles, fish, veg, fruit, flower, gift, clothing, book, other.

## Sales

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/shop/payments` | Create a sale (below). Staff allowed |
| GET | `/shop/payments` | Recent sales. Staff allowed |
| GET | `/shop/payments/:id` | One sale, refreshed from PayPal or the chain. Staff allowed |
| POST | `/shop/payments/:id/void` | Owner only; cash and card sales only |
| GET | `/shop/summary` | Takings split by rail, best sellers. `?date=YYYY-MM-DD` for another day, `&reconcile=true` to check the till against the chain. Staff allowed |

Creating a sale:

```json
{
  "rail": "paypal",
  "items": [{ "id": "…", "qty": 2 }],
  "amount": "1.00",
  "loyaltyCode": "KYJZV-BKKT9",
  "label": "Table 4"
}
```

* `rail`: `paypal`, `solana`, `cash` or `card`.
* `items`: optional basket. The server prices it from the shop's menu; the till never sends prices. With `items`, `amount` is added on top as "Other".
* `amount`: the keypad price, if there's no basket.
* `usePoints` (wallet only) or `loyaltyCode` (PayPal only) spend loyalty points. A shop only honours points it issued itself.
* `label`: an optional description for a keypad sale. With a basket, the server writes the label from the items.

The response is the sale plus `url`: the PayPal checkout link or the Solana Pay URL to show as a QR code. Cash and card sales come back already `paid`, with `url: null`.

## Takings, refunds and reports (owner only)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/shop/till` | Till wallet balance |
| GET | `/shop/blockhash` | A recent blockhash for signing a transfer on the phone (so the app needs no RPC of its own) |
| GET | `/shop/points/:wallet` | Points this customer can spend at this shop |
| GET | `/shop/sweeps` · `/shop/refunds` · `/shop/refunds/:id` | List sweeps and refunds |
| POST | `/shop/sweeps` | Propose sending takings: `{ amount, reason? }` |
| POST | `/shop/sweeps/:id/begin` · `/submit` · `/check` · `/cancel` | Sign, submit and confirm a sweep |
| POST | `/shop/payments/:id/refunds` | Propose a PayPal refund |
| POST | `/shop/refunds/:id/challenge` · `/approve` · `/cancel` | Get the wording to sign, approve with the signature, or cancel |
| GET | `/shop/reports` · POST `/shop/reports` | List or write end-of-day reports |
| POST | `/shop/export` | `{ from, to }` → a one-time CSV link, valid for 5 minutes |
| POST | `/shop/chat` | The assistant: `{ messages }` → `{ reply, sweeps, refunds }` |
| POST | `/shop/staff/invites` | `{ label }` → `{ code, expiresInMinutes }`: a one-time pairing code |
| GET | `/shop/staff` · POST `/shop/staff/:id/remove` | List or sign out staff phones |

## Public

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | Landing page |
| GET | `/r/:id` | The customer's receipt |
| GET | `/export/:file` | The one-time CSV download from `POST /shop/export` |
| GET | `/privacy` · `/terms` | Policies |
| GET | `/points/:wallet` | A wallet's total points tokens (across all shops) |
| GET/POST | `/pay/:id` | Solana Pay transaction request (wallet sales that spend points) |
| GET | `/paypal/return` · `/paypal/cancel` | Where PayPal sends the customer back |
| GET | `/paypal/onboarded` | Where PayPal sends the owner after connecting (checked with PayPal, never trusted on its own) |
| GET | `/health` · `/ready` | Liveness, and a check that the database and Solana RPC answer |
