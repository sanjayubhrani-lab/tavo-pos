# Valor PayTech terminal integration

Tavo processes cards through a **pluggable gateway layer** (`src/gateways/`). Each
processor is one file implementing the same interface; you pick the active one with
the `PAYMENT_GATEWAY` environment variable. Valor is shipped as `src/gateways/valor.js`.

Out of the box it runs in **simulated mode** (approves a fake sale) so the whole POS
works with no hardware. Add your Valor credentials and it switches to live calls.

---

## Integration models

| Model | Use it for | Card data touches Tavo? |
|-------|------------|--------------------------|
| **Valor Connect** (cloud semi‑integration) | Card‑present at the counter — Tavo sends a sale to Valor's cloud, which rings the physical terminal (VL100 / VL300 / VL500 / RCKT). | **No** — stays on the certified terminal (minimal PCI scope) |
| **Merchant / Gateway API** | Card‑not‑present — online ordering, QR pay‑at‑table, stored cards. JSON charge to the securelink endpoint. | Tokenized only |
| **Valor Pay SDK** | Running Tavo *natively on* a Valor VL500 / RCKT Android device via the Capacitor wrapper. | On‑device (certified SDK) |

Most deployments use **Connect for the register + the Gateway API for online**.

---

## 1. Get your Valor credentials

From Valor PayTech or your ISO/reseller (Tavo never stores these in code — they are
environment variables only):

- A **boarded Valor merchant account**.
- **App ID** and **App Key** (API credentials).
- A registered terminal **EPI** (device serial / endpoint identifier) per terminal.
- **Staging access**: `securelink-staging.valorpaytech.com:4430`.
- The **Valor Connect spec** and **POS Integration Specification** PDF (for the exact
  request paths / field names — fill them into `valor.js` where marked `REAL:`).

Docs: <https://developer.valorpaytech.com> · <https://valorapi.readme.io> ·
<https://valorpaytech.com/resources/apis-and-sdks/>

---

## 2. Configure Tavo

Set these environment variables (e.g. in Render → Environment, or your `.env`):

```bash
PAYMENT_GATEWAY=valor
VALOR_APP_ID=your_app_id
VALOR_APP_KEY=your_app_key
VALOR_EPI=your_terminal_epi          # default terminal; can be overridden per sale
VALOR_ENV=staging                    # staging | prod
# VALOR_BASE_URL=...                 # optional override of the securelink endpoint
```

With `VALOR_APP_ID` + `VALOR_APP_KEY` present, the gateway leaves simulated mode and
makes real calls. Without them it logs `running in SIMULATED mode` and approves test sales.

---

## 3. Finish the live calls

`src/gateways/valor.js` has the correct structure and reads all credentials from env.
Before going live, fill in the exact request path and field names from your Valor
Connect spec at the lines marked `REAL:` in `createCharge`, `retrieveStatus`, and
`refund`. The interface Tavo relies on never changes:

```js
createCharge(amount, meta)  // meta.cardPresent, meta.epi, meta.orderId
retrieveStatus(id)          // poll until approved/declined (card‑present is async)
refund(id, amount)          // refund or void
publishableKey()            // null — the terminal collects the card
```

---

## 4. Counter flow (what staff see)

1. Cashier builds the check and taps **Pay**.
2. Tavo posts the sale to Valor's cloud with the terminal's EPI.
3. The terminal lights up; the customer taps / inserts / swipes.
4. Valor returns **approved + auth code + last 4**; Tavo records the payment via
   `/api/payments/complete` (exactly like the current mock flow) and prints / emails
   the receipt.

---

## 5. Before production

- Test end‑to‑end on **staging** first.
- Complete **Valor's integration certification** (required before live processing).
- Keep cards on the certified terminal (semi‑integrated / P2PE) to stay at the lighter
  PCI tier — never pass raw PAN through Tavo.

---

## Switching processors

Tavo already supports `mock`, `stripe`, `fiserv`, `tsys`, and now `valor`. Change
`PAYMENT_GATEWAY` to swap — no code changes. See `PROCESSORS.md` for the others.
