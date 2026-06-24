# Tavo POS

A full-stack, Toast-style restaurant point-of-sale you can run on your own computer and grow into a real product.

It includes order taking with modifiers, table/floor management, a live kitchen display, tipping, split-friendly payments, receipts, menu management, staff, and a sales dashboard — all backed by a real REST API and a **Stripe test-mode** payment integration. It runs out of the box with a built-in mock payment processor, so you can try everything before signing up for anything.

---

## What's inside

```
platepoint/
├─ package.json          # dependencies & run scripts
├─ .env.example          # copy to .env to configure
├─ src/
│  ├─ server.js          # Express API + serves the frontend
│  ├─ auth.js            # PIN login, JWT, role checks
│  ├─ payments.js        # Stripe (test) + mock fallback
│  ├─ schema.sql         # PostgreSQL table definitions
│  ├─ migrate.js         # create DB tables
│  ├─ seed.js            # loads default menu/tables/staff/users
│  ├─ db.js              # low-level JSON file helper
│  ├─ store/             # storage layer (swappable backend)
│  │  ├─ index.js        #   picks Postgres or JSON automatically
│  │  ├─ json.js         #   JSON-file backend (default, zero setup)
│  │  └─ pg.js           #   PostgreSQL backend
│  └─ data/menu.seed.js  # the starter menu
│  └─ seedData.js        # shared default data (menu/tables/users)
├─ test/                 # automated tests
│  ├─ store.test.mjs     #   data layer (JSON + in-memory Postgres)
│  └─ api.test.mjs       #   HTTP endpoints (refunds, voids, roles)
├─ Dockerfile            # production container image
├─ docker-compose.yml    # app + Postgres, one-command local stack
├─ render.yaml           # one-click Render.com deploy (web + managed DB)
├─ Procfile              # generic host start command
└─ public/
   └─ index.html         # the POS app (talks to the API)
```

## Run it (5 steps)

You need **Node.js 18 or newer** installed (https://nodejs.org). Then, in a terminal:

```bash
cd platepoint
npm install          # 1. install dependencies
cp .env.example .env # 2. create your config (Mac/Linux)  —  on Windows: copy .env.example .env
npm run seed         # 3. load the starter menu, tables, staff
npm start            # 4. start the server
```

5. Open **http://localhost:4242** in your browser. That's it — the POS is live.

By default it uses the **JSON file database** and the **mock payment processor** — no database server, no Stripe account. You can take orders, send to kitchen, pay, tip, and see reports immediately.

## Using PostgreSQL (recommended for real use)

The JSON file store is fine for trying things out, but a real restaurant with several terminals needs a proper database. Switching to PostgreSQL is just an environment variable — no code changes.

1. Install Postgres (or use a hosted one: Supabase, Neon, Render, RDS, etc.) and create a database.
2. Put its connection string in `.env`:

```
DATABASE_URL=postgres://user:password@localhost:5432/platepoint
# DATABASE_SSL=true   # uncomment for most cloud-hosted databases
```

3. Create the tables and load starter data, then start:

```bash
npm run migrate   # creates tables from src/schema.sql
npm run seed      # loads menu, tables, staff, login users
npm start
```

The top bar / `GET /api/health` will report `db: postgres`. When `DATABASE_URL` is empty, it automatically falls back to the JSON file. Both backends are covered by the same test suite:

```bash
npm test          # runs the JSON backend and an in-memory Postgres against identical assertions
```

## Logging in (roles)

The app now opens to a **PIN login** screen. Staff log in with a numeric PIN, and what they can see depends on their role:

| Role | PIN (demo) | Can access |
|---|---|---|
| Manager | `1234` | Everything — order, tables, kitchen, reports, menu, team, setup |
| Server  | `1111` or `2222` | Order, tables, kitchen |
| Kitchen | `3333` | Kitchen display only |

PINs are bcrypt-hashed in the database; the API issues a signed JWT on login and every protected endpoint checks it. **Change the demo PINs and `JWT_SECRET` before any real use** (edit `src/seed.js` and `.env`, then re-run `npm run seed`).

## Turn on real (test-mode) card payments

1. Create a free Stripe account and open the **test** dashboard.
2. Copy your two **test** keys from https://dashboard.stripe.com/test/apikeys
3. Paste them into your `.env` file:

```
STRIPE_SECRET_KEY=sk_test_xxxxxxxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxxxxxxx
```

4. Restart the server (`npm start`). The badge in the top bar will switch to **💳 Stripe test**.
5. On the payment screen, pay with the Stripe test card:

```
Card number : 4242 4242 4242 4242
Expiry      : any future date     CVC: any 3 digits     ZIP: any
```

These are real Stripe API calls in test mode — no real money moves. You'll see the payments appear in your Stripe test dashboard.

## Webhook — confirm payments server-side (recommended)

Trusting the browser to say "payment succeeded" is risky. The server also exposes a **verified webhook** so Stripe itself tells your server the outcome.

To test it locally with the [Stripe CLI](https://stripe.com/docs/stripe-cli):

```bash
stripe login
stripe listen --forward-to localhost:4242/api/webhooks/stripe
```

The CLI prints a signing secret (`whsec_...`). Put it in `.env` as `STRIPE_WEBHOOK_SECRET=` and restart. Now when a test payment succeeds, Stripe calls `/api/webhooks/stripe`, the server **verifies the signature**, and marks that payment `confirmed: true` in the database. Without a valid signature the request is rejected (400).

## Deploying it online

> 📘 **New to deploying?** See **[DEPLOY.md](DEPLOY.md)** for a plain-language, click-by-click walkthrough (GitHub → Render → Stripe). The summary below is the quick version.

The app auto-creates its database tables and seeds a fresh (empty) database on first boot, so deployment is mostly "point it at a Postgres and go."

### Option A — Docker (run the whole stack with one command)

With Docker installed:

```bash
docker compose up --build
```

This starts Tavo **and** a PostgreSQL database together, wires them up, migrates, and seeds. Open http://localhost:4242. Data persists in a Docker volume (`pgdata`). Edit `JWT_SECRET` and the Stripe keys in `docker-compose.yml` before using it for real.

### Option B — Render.com (managed hosting + HTTPS, free tier)

1. Push this project to a GitHub repo.
2. In Render: **New → Blueprint**, pick the repo. Render reads `render.yaml` and provisions the web service **and** a managed PostgreSQL database, generates a `JWT_SECRET`, and wires `DATABASE_URL` automatically.
3. Add your `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` in the dashboard when ready.
4. Render gives you an `https://…onrender.com` URL with TLS already set up.

The same repo also works on Railway, Fly.io, or any host that runs a Node app — they'll use the `Procfile` (`web: node src/server.js`). Set `DATABASE_URL` (and `DATABASE_SSL=true` for most cloud databases).

### First-boot seeding

On an empty database the server seeds the default menu, tables, and demo login users automatically. It never overwrites existing data. To disable (e.g. once you've added your real menu), set `AUTO_SEED=false`. Override the seeded PINs with `SEED_MANAGER_PIN`, `SEED_SERVER_PIN`, `SEED_KITCHEN_PIN`.

## Menu management

The **Menu** screen (managers) is a full editor:

- **Photos** — add a photo to any item by pasting an image URL or uploading a file (stored inline, ~600KB max). Photos appear on the order screen; items without one fall back to an emoji.
- **Edit** every field — name, category, price, emoji, photo, availability.
- **Availability ("86")** — toggle an item out of stock with one tap; it disappears from the order screen but stays in your menu, ready to restore.
- **Categories** — items are grouped by category; type a new or existing category (autocomplete) to move an item. Reorder items within a category with the ↑/↓ buttons — the order carries through to the POS.

## Daily close-out (Z-report)

On the **Reports** screen, managers can run a **Close Out / Z-Report** — the end-of-day summary restaurants print nightly. It shows, for any business date: subtotal sales, tax, tips, gross and net sales, refunds, transaction count, average check, items sold, voids, a payment-method breakdown, and top sellers. Pick a date to re-run a past day, and print it for your records (same 80mm layout as receipts).

## Printing receipts & kitchen tickets

Both the customer receipt and the kitchen ticket print through the browser's print dialog (pick a thermal/receipt printer, a normal printer, or "Save as PDF"). Layouts are sized for an 80mm receipt roll.

- **Receipt** — the "🖨 Print" button on the payment-approved screen. "✉️ Email" opens a pre-filled email with the receipt text.
- **Kitchen ticket** — the 🖨 button on any kitchen ticket.
- **Automatic printing** — under **Setup**, turn on *Auto-print kitchen ticket when an order is sent* and/or *Auto-print customer receipt after payment*. These preferences are remembered per device.

## Offline mode

Restaurants can't stop taking orders when the WiFi drops. Tavo keeps working offline:

- **Detects** lost connectivity automatically (the top-bar badge turns to `📴 Offline`).
- **Keeps serving:** staff can still browse the menu, build checks, send orders to the kitchen, and take **cash** payments. Queued kitchen tickets show a `⏳ Queued` tag.
- **Queues** those actions safely in the browser (an "outbox") and shows how many items are waiting.
- **Auto-syncs** the moment the connection returns — every queued order and cash payment is sent to the server in order, and the badge clears. You can also tap the badge to sync manually.
- Read-only screens (floor, reports, team) show the **last-synced** data with an offline notice instead of breaking.

What still needs a connection: **card payments** (they require Stripe), **refunds**, **voiding already-synced orders**, and **menu editing**. The app tells the user clearly when an action needs to wait.

## API reference (quick)

All `/api` routes except `/health`, `/config`, `/auth/login`, and `/webhooks/stripe` require a `Authorization: Bearer <token>` header obtained from login.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/login` | log in with a PIN → token |
| GET  | `/api/auth/me` | current user + allowed screens |
| POST | `/api/webhooks/stripe` | Stripe-verified payment confirmation |
| GET  | `/api/menu` | list menu items |
| POST | `/api/menu` | add a menu item (name, price, emoji, image, category) |
| PUT  | `/api/menu/:id` | edit an item (price, photo, availability, category…) |
| POST | `/api/menu/reorder` | set item order within categories |
| DELETE | `/api/menu/:id` | remove a menu item |
| GET  | `/api/tables` | floor / table status |
| POST | `/api/orders` | create an order (check) |
| POST | `/api/orders/:id/fire` | send to kitchen |
| POST | `/api/orders/:id/bump` | mark ready (KDS) |
| GET  | `/api/orders?status=cooking` | live kitchen tickets |
| POST | `/api/payments/intent` | start a payment (Stripe/mock) |
| POST | `/api/payments/complete` | record payment & close check |
| POST | `/api/payments/:id/refund` | refund full/partial (manager, Stripe-backed) |
| POST | `/api/orders/:id/void` | void an unpaid order, free the table |
| GET  | `/api/reports/summary` | sales dashboard data |
| GET  | `/api/reports/zreport?date=YYYY-MM-DD` | daily close-out totals (manager) |
| GET  | `/api/staff` | staff & time clock |

## Going to production — the honest checklist

This is a solid foundation, not a finished launch. Already done: ✅ PIN login + roles, ✅ Stripe test payments, ✅ verified webhook, ✅ PostgreSQL support, ✅ refunds (full/partial) & voids, ✅ Docker + cloud deploy with HTTPS, ✅ offline mode with auto-sync. Still to do before taking real customer money:

1. **Activate Stripe live mode** and complete Stripe's business onboarding. Use live keys via secure environment variables, never in code.
2. **PCI compliance.** Because card data is entered into Stripe's hosted Payment Element (not your server), you qualify for the simplest SAQ-A path — keep it that way; never touch raw card numbers.
3. **Harden auth.** Rotate `JWT_SECRET`, set per-user strong PINs/passwords, add rate-limiting on login, and consider httpOnly cookies instead of localStorage for the token.
4. **Database backups** — enable automated backups/point-in-time recovery on your managed Postgres.
5. **Receipt-printer hardware integration and tax compliance** for your jurisdiction.

## License

Your project — use it however you like.
