# Tavo — Delivery Platform Integrations

Bring **DoorDash, Uber Eats, Grubhub** (and any aggregator) orders straight into Tavo.
Incoming orders appear live on the **Online** screen and the **Kitchen Display**, tagged by
platform, and their revenue rolls into your reports and Z-report by platform.

## The honest part: how connections actually work

These platforms do **not** offer open, self-serve APIs. To receive live orders you need one of:

1. **An aggregator / middleware (recommended, fastest).** Companies like **Otter, Deliverect,
   Cuboh, Chowly, or ItsaCheckmate** already hold the partnerships with every delivery app.
   You connect your delivery accounts to them once, and they send all orders to Tavo through
   the single webhook below. This is how most independent restaurants do it.
2. **Direct partnerships.** Apply to each platform's developer/partner program
   (DoorDash Marketplace, Uber Eats Integration, Grubhub API). This means business review and
   contracts, and is mainly worth it at scale.

Either way, Tavo is ready: everything points at one webhook.

## Your webhook

Configure your aggregator (or the platform) to POST each order to:

```
POST https://YOUR-APP.onrender.com/api/integrations/orders
Header:  x-integration-key: <the value of INTEGRATION_API_KEY>
```

Set `INTEGRATION_API_KEY` to a long random string in your environment (Render → Environment).
Until it's set, the webhook is disabled (returns 503) — but the in-app **simulate** button
still works so you can try the flow.

### Order formats accepted

**A) Already-normalized** (what most aggregators can send, or you can map to):

```json
{
  "platform": "doordash",
  "externalId": "dd_10293",
  "customer": "Jamie R.",
  "lines": [
    { "name": "Margherita", "price": 14.00, "qty": 2, "mods": ["extra basil"] },
    { "name": "Draft Beer", "price": 6.50, "qty": 1 }
  ]
}
```

**B) Provider-native** — send the raw payload and tell us the provider; Tavo maps it
(`doordash`, `ubereats`, `grubhub` mappers are in `src/integrations.js` — adjust to your exact contract):

```json
{ "provider": "ubereats", "payload": { /* the platform's order JSON */ } }
```

Responses: `201` with the created order, or `200` with `duplicate:true` if the same
`externalId` was already received (safe to retry — it's idempotent).

## Pushing your menu out

Platforms need your menu. Export it in a neutral shape:

```
GET https://YOUR-APP.onrender.com/api/integrations/menu
Header: x-integration-key: <key>
```

Returns categories and products (name, price, image) built from your live, available menu items.
Most aggregators accept a feed like this or let you map fields to it.

## Try it right now (no accounts needed)

1. Log in as **Manager**.
2. Open the **Online** screen.
3. Click **DoorDash**, **Uber Eats**, or **Grubhub** under "simulate an incoming order."
4. Watch the order appear on **Online** and on the **Kitchen** display, and the revenue land in
   **Reports** under that platform. That's the exact path a real order takes.

## What happens to a delivery order

- Created with `channel: "delivery"`, the platform name, and the customer.
- Fired straight to the kitchen (`cooking`), since the platform already accepted it.
- A payment is recorded with the platform as the tender (the platform collected the money),
  so **Reports → Payment Methods** and the **Z-report** show revenue per platform.
- Staff tap **Mark Ready** when it's done.

## Going live checklist

1. Pick an aggregator (or get direct API access).
2. Set `INTEGRATION_API_KEY` in Render and give it (plus your webhook URL) to the aggregator.
3. Map their fields to format **A**, or extend the provider mapper in `src/integrations.js`.
4. Share your menu via the export endpoint.
5. Send a test order from their sandbox and confirm it appears on the Online screen.
