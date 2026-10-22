# Launch plan

Dates: Hacker House **1 Nov** · PayPal AI Hackathon deadline **12 Nov, 12pm PST** · Breakpoint London **15–17 Nov** · then pilots.

Each task is marked **Steven** (accounts, keys, approvals, people) or **Claude** (code, config, tests).

## Week 1 (to 1 Nov): live on devnet

| Task | Who | Notes |
| --- | --- | --- |
| Fix Railway billing on the "My Projects" workspace | Steven | Deploys are blocked until then |
| Cloudflare: CNAME `tilltide` → `ay4np0it.up.railway.app` (proxied), TXT `_railway-verify.tilltide`, Transform Rule adding `x-tilltide-origin` | Steven | Values in the chat history |
| PayPal sandbox app: client id and secret | Steven | developer.paypal.com → Apps & Credentials |
| `ANTHROPIC_API_KEY` | Steven | console.anthropic.com |
| Treasury wallet address (public address only) | Steven | Receives the 0.5% sweep fee |
| Devnet SOL to the points authority `FHNy3Tw6P48MDe9QUFSgEXzxPxhzsPduZ47fhiyZiv9n` | Steven | faucet.solana.com |
| Deploy; switch `AUTH_DOMAIN`/`PUBLIC_URL`/app identity to `tilltide.bytez3.com`; set `ORIGIN_SECRET` | Claude | After DNS verifies |
| Real PayPal sandbox sale + refund; agent questions live | Claude | |
| Real Android phone with Phantom or Solflare: sign in, PayPal sale, PYUSD sale, sweep | Together | The biggest remaining unknown |
| CI on GitHub (typecheck, unit tests, e2e) | Claude | Done |
| Alerts for anything that needs attention | Claude | Done (`ALERT_WEBHOOK_URL`) |

## Week 2 (to 12 Nov): submit to PayPal

| Task | Who | Notes |
| --- | --- | --- |
| Apply for PayPal partner status (Partner Referrals, `PARTNER_FEE`, BN code) | Steven | Can take a while: start now. Sandbox works meanwhile |
| Fix whatever the real-phone test finds | Claude | |
| Make the GitHub repo public | Steven | Required by the rules |
| Record the video from `submission/DEMO-SCRIPT.md` and upload it publicly | Steven | Under 3 minutes |
| Devpost screenshots and final write-up pass | Claude | `submission/SUBMISSION.md` |
| Submit | Steven | |

## Breakpoint and pilots (15 Nov onwards)

| Task | Who | Notes |
| --- | --- | --- |
| 1–2 Cornwall shops agree to pilot | Steven | Bytez3 local outreach |
| Terms, privacy policy and UK crypto-promotion check, reviewed by a professional | Steven | Claude drafts them |
| Mainnet: paid RPC (e.g. Helius), backups, alerts, `SOLANA_CLUSTER=mainnet` | Claude | |
| Solana dApp Store listing for Seeker | Both | Needs a signed release build and a publisher account |
| SKR bonus points for Seeker holders | Claude | Done: Seeker Genesis Token or SKR, verified mint `SKRbvo6…GZhW3`; needs `SEEKER_RPC_URL` (mainnet RPC) |
| Solana Mobile and Foundation grants, with pilot numbers | Both | `agent-pay-kit` is the public good |
| Colosseum Eternal | Steven | |

## Measure from day one of the pilots

These are what grant reviewers and judges will ask about:
- sales per day
- the split between PayPal and wallet payments
- how many customers come back (points earned, then spent)
- refunds
- what the shop pays Tilltide compared with its card reader
