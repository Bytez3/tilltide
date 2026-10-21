# API reference

Base URL: your deployment, for example `https://tilltide.bytez3.com`. Requests and responses are JSON. Errors are `{ "error": "…" }` with a 4xx or 5xx status, and the message is written for the shop owner.

Money is sent as decimal strings in the shop's currency (`"4.50"`). Responses use integer strings in 6-decimal base units (`"4500000"`) with `decimals: 6`.

## Signing in

The till signs in with its wallet (Sign In With Solana). Staff phones pair with a one-time code.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/auth/nonce` | – | `{ nonce, domain, statement }` to build the sign-in message |
| POST | `/auth/verify` | `{ address, signedMessage, signature }` | `{ token, wallet }` |
| POST | `/auth/staff` | `{ code }` | `{ token, label }` for a staff phone |

Send the token as `Authorization: Bearer <token>` on every `/shop` request. Staff tokens are limited to taking payments and reading today's figures; everything else returns 403.

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
| GET | `/shop/summary` | Today's takings, split by rail, best sellers. Staff allowed |

Creating a sale:

```json
{
  "rail": "paypal",
  "items": [{ "id": "…", "qty": 2 }],
  "amount": "1.00",
  "loyaltyCode": "KYJZV-BKKT9"
}
```

* `rail`: `paypal`, `solana`, `cash` or `card`.
* `items`: optional basket. The server prices it from the shop's menu; the till never sends prices. With `items`, `amount` is added on top as "Other".
* `amount`: the keypad price, if there's no basket.
* `usePoints` (wallet only) or `loyaltyCode` (PayPal only) spend loyalty points.

The response is the sale plus `url`: the PayPal checkout link or the Solana Pay URL to show as a QR code. Cash and card sales come back already `paid`, with `url: null`.

## Takings, refunds and reports (owner only)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/shop/till` | Till wallet balance |
| POST | `/shop/sweeps` | Propose sending takings: `{ amount, reason? }` |
| POST | `/shop/sweeps/:id/begin` · `/submit` · `/check` · `/cancel` | Sign, submit and confirm a sweep |
| POST | `/shop/payments/:id/refunds` | Propose a PayPal refund |
| POST | `/shop/refunds/:id/challenge` · `/approve` · `/cancel` | Get the wording to sign, approve with the signature, or cancel |
| GET | `/shop/reports` · POST `/shop/reports` | List or write end-of-day reports |
| POST | `/shop/export` | `{ from, to }` → a one-time CSV link, valid for 5 minutes |
| POST | `/shop/chat` | The assistant: `{ messages }` → `{ reply, sweeps, refunds }` |
| POST | `/shop/staff/invites` · GET `/shop/staff` · POST `/shop/staff/:id/remove` | Staff phones |

## Public

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/` | Landing page |
| GET | `/r/:id` | The customer's receipt |
| GET | `/points/:wallet` | A wallet's points balance |
| GET/POST | `/pay/:id` | Solana Pay transaction request (wallet sales that spend points) |
| GET | `/paypal/return` | Where PayPal sends the customer back |
| GET | `/health` · `/ready` | Liveness, and a check that the database and Solana RPC answer |
