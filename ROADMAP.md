# Tavo — Toast Feature Parity & Roadmap

Goal: a sellable, multi-industry (restaurant + retail) POS platform that matches and
beats Toast / Square / Clover. This maps every Toast capability to where Tavo stands
today, and the honest path to the rest.

Legend: ✅ done · 🟡 partial · ⬜ planned · 🏷️ needs a business/compliance step (not just code)

## What Tavo already has ✅
- POS ordering with categories, photos, **modifier groups** (required/optional, min/max, per-option pricing)
- Tables / floor management, open checks
- **Kitchen Display System (KDS)** with timers + bump
- Tipping, split-friendly checkout, receipts (print + email)
- **Refunds & voids**
- **Offline mode** — keep taking orders + cash payments, auto-sync on reconnect
- **Online ordering channel** + DoorDash/Uber Eats/Grubhub webhook intake (via aggregator)
- **Multi-processor payments** (Stripe live; Fiserv/TSYS adapter-ready)
- Daily **Z-report** close-out, sales dashboard, top sellers, payment-method split
- PIN login with manager/server/kitchen **roles**
- PostgreSQL, auto-migrate/seed, Docker, one-click cloud deploy + custom domain (HTTPS)
- iPad + Android apps (Capacitor)

## Toast features → Tavo status

| Toast capability | Tavo status | Notes / what's needed |
|---|---|---|
| Handheld tableside ordering (Toast Go) | ✅ | The web/Capacitor app already runs on a tablet/handheld. Needs ruggedized hardware (yours to source). |
| Kitchen Display System | ✅ | Built. Could add multi-station routing ⬜. |
| Self-ordering kiosk | ⬜ | A "kiosk mode" = the existing menu UI, full-screen, guest-facing, pay-at-kiosk. ~Medium build. |
| Menu management + 86 across terminals | ✅ | Edit items/modifiers/photos; availability toggle. Real-time push to all terminals ⬜ (websockets). |
| Inventory tracking + recipe/food cost | ⬜ | New module: ingredients, per-item recipes, depletion on sale, waste, cost reports. ~Large. |
| Offline mode (orders + card payments) | 🟡 | Orders + **cash** offline today. Offline **card** needs a terminal that stores-and-forwards EMV 🏷️. |
| Branded online ordering site | 🟡 | Online order channel + menu exist; a public guest-facing storefront page ⬜ (~Medium). |
| QR Mobile Order & Pay | ⬜ | Guest scans table QR → web menu → order → pay. High-value, ~Medium. Strong next pick. |
| Third-party delivery integration | ✅ | Webhook + normalizer ready; connect via Otter/Deliverect or direct 🏷️. |
| Real-time reporting on phone | 🟡 | Dashboard + Z-report exist and are mobile-friendly; a dedicated owner app ⬜. |
| AI assistant (Toast IQ) | ⬜ | "Ask Tavo" — natural-language queries over your sales data. ~Medium (LLM + your data). |
| Loyalty & guest management | ⬜ | Customers, points, visit history, targeted email. ~Large. |
| Gift cards | ⬜ | Issue/redeem digital + physical balances. ~Medium. |
| Email marketing campaigns | ⬜ | Needs an email provider (SendGrid/Postmark) + audience tools. ~Medium 🏷️. |
| Payroll & scheduling | ⬜ 🏷️ | Time clock exists (basic). Full payroll = tax filing/compliance — best via a partner (Gusto/Check API), not built from scratch. |
| Lending / Capital | ⬜ 🏷️ | A regulated financial product. Realistically a partner integration, not in-house. |
| Multi-tenant SaaS (sell to many businesses) | ⬜ | The platform foundation: each restaurant = a tenant with isolated data, billing, onboarding. **This is the most important build for "sell everywhere."** ~Large. |
| Retail mode (sell to retail too) | ⬜ | Barcode scan, SKU/variant catalog, no tables/KDS. Reuses most of Tavo. ~Medium. |

## Recommended build order (highest leverage first)

1. **Multi-tenant foundation** — without this you can't sell to more than one business. Tenants, isolated data, signup, subscription billing (Stripe Billing).
2. **QR Mobile Order & Pay** — biggest guest-facing differentiator, drives revenue, reuses the menu + payments you already have.
3. **Self-order kiosk mode** — same engine, full-screen guest UI.
4. **Inventory + recipe costing** — the operational backbone restaurants pay for.
5. **Loyalty + gift cards** — retention and prepaid revenue.
6. **Retail mode** — unlock the retail market with barcode/SKU support.
7. **"Ask Tavo" AI insights** — modern, demoable, sticky.
8. Partner integrations for **payroll** and **capital** (don't build regulated finance in-house).

## Honest framing
Toast is a ~$1B+/yr company with hundreds of engineers; full parity is a multi-year,
multi-person effort, and a few items (payroll, lending, EMV card-present, direct
processor certs) are business/compliance work, not just code. But Tavo already covers
the core POS exceptionally well, and the roadmap above is buildable **one solid module
at a time** — each shippable on its own. Tell me which to build next and we'll do it.
