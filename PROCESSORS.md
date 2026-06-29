# Tavo — Payment Processors (multi-gateway)

Tavo is **processor-agnostic**. One internal interface, many gateways. Switch with a
single environment variable; no app code changes.

```
PAYMENT_GATEWAY = stripe | fiserv | tsys | valor | globalpayments | mock
```

If unset, Tavo auto-detects Stripe (when `STRIPE_SECRET_KEY` is present) and otherwise
uses the built-in **mock** gateway so everything runs with zero setup.

## How it's built

```
src/gateways/
├─ index.js     # getGateway() — selects the active processor
├─ stripe.js    # Stripe (fully working in test + live)
├─ fiserv.js    # Fiserv Commerce Hub / CardConnect (scaffold)
├─ tsys.js      # TSYS / Global Payments — legacy Genius/TransIT (scaffold)
├─ valor.js     # Valor PayTech terminal / cloud semi-integration (scaffold)
├─ globalpayments.js  # Global Payments GP API — unified commerce (scaffold)
└─ mock.js      # simulated processor (default, no setup)
```

Every gateway implements the same four methods:

```js
createCharge(amountDollars, meta) -> { mode, id, clientSecret, status }
retrieveStatus(id)                -> 'succeeded' | ...
refund(id, amountDollars)         -> { mode, id, status }
publishableKey()                  -> string | null
```

**Adding a new processor (Adyen, Square, Worldpay, Elavon, …):** copy `mock.js`,
implement the four methods against that processor's API, and register it in
`index.js`. Nothing else in Tavo changes.

## The honest part: Fiserv & TSYS aren't "plug-in" APIs

Stripe lets you self-serve test keys today. **Fiserv and TSYS (now Global Payments)
do not.** To take live cards through them you need:

1. A **merchant account** with that processor (often via an ISO/agent or a referral partner).
2. **API/gateway credentials** (Fiserv Commerce Hub or CardConnect; TSYS via the Global
   Payments GP API, TransIT, or Genius).
3. **PCI DSS compliance** for your platform, and for *card-present* (in-restaurant chip/tap)
   you also need **EMV terminal certification** with that processor and approved hardware.
4. Their **certification/onboarding** sign-off before you can process real money.

This is a business + compliance process only you can initiate. The `fiserv.js` and
`tsys.js` adapters are built with the correct call structure and read credentials from
env vars, so the day you're certified it's a "fill in the API call + add credentials"
change — not a rewrite. Until then they run in a clearly-flagged **simulated** mode.

### A faster commercial path
If the goal is to resell Tavo to many merchants, look at **payment facilitator (PayFac)
/ platform** models: Stripe Connect, Adyen for Platforms, or Finix let you onboard
sub-merchants and earn on processing without each one doing a full Fiserv/TSYS
certification. That's how modern POS companies monetize payments.

## Configure a processor

Set the relevant env vars (see `.env.example`) in Render → Environment (or `.env` locally):

- **Stripe:** `PAYMENT_GATEWAY=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` (+ webhook secret).
- **Fiserv:** `PAYMENT_GATEWAY=fiserv`, `FISERV_API_KEY`, `FISERV_API_SECRET`, `FISERV_MERCHANT_ID`.
- **TSYS:** `PAYMENT_GATEWAY=tsys`, `TSYS_MERCHANT_ID`, `TSYS_TRANSACTION_KEY`, `TSYS_DEVICE_ID`.
- **Valor:** `PAYMENT_GATEWAY=valor`, `VALOR_APP_ID`, `VALOR_APP_KEY` (+ terminal EPI). See `VALOR.md`.
- **Global Payments:** `PAYMENT_GATEWAY=globalpayments` (aliases: `global`, `gp`), `GP_API_APP_ID`, `GP_API_APP_KEY`, `GP_API_ENV` (`sandbox`|`production`), optional `GP_API_ACCOUNT_NAME`.

### Global Payments (GP API)

Global Payments' modern **GP API** ([developer.globalpay.com](https://developer.globalpay.com)) is a
unified API for both **card-present** (in-person via a Genius terminal) and **card-not-present**
(e-commerce hosted fields). It uses an OAuth-style flow: your **App ID + App Key** are exchanged
for a short-lived **bearer access token**, then `/transactions` performs the sale or refund.

Tavo's `globalpayments.js` adapter has that flow wired (token caching, sale, refund, card-present
vs CNP channel routing) and reads the env vars above. As with the other real processors, going
live still requires a **Global Payments merchant account, GP API credentials, and PCI/EMV
certification** — until `GP_API_APP_ID`/`GP_API_APP_KEY` are set it runs in clearly-flagged
**simulated** mode. To go live: drop in your sandbox credentials first (`GP_API_ENV=sandbox`),
uncomment the real `fetch` calls in the adapter, certify, then switch to `GP_API_ENV=production`.

The top-bar badge and `GET /api/health` show which processor is active.
