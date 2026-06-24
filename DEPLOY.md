# Getting Tavo Live — Step by Step

A plain-language guide to putting your POS online with a real web address, a real database, and real card payments. No prior server experience needed. Budget about 30–45 minutes.

You'll do three things:
1. Put the code on GitHub.
2. Deploy it on Render (it gives you the server + database + an HTTPS web address, free tier).
3. Turn on Stripe so you can take cards.

---

## Before you start — create three free accounts

- **GitHub** — https://github.com (stores your code)
- **Render** — https://render.com (runs your app online)
- **Stripe** — https://stripe.com (processes card payments)

You can sign up for all three with just an email.

---

## Part 1 — Put the code on GitHub

1. Install Git if you don't have it: https://git-scm.com/downloads
2. Open a terminal **in the `platepoint` folder** and run these lines one at a time:

   ```bash
   git init
   git add .
   git commit -m "Tavo POS"
   ```

3. On GitHub, click **New repository**, name it `platepoint`, leave it **Private**, and click **Create repository**.
4. GitHub shows a box titled "…or push an existing repository." Copy the two lines under it (they look like the below) and run them in your terminal:

   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/platepoint.git
   git branch -M main
   git push -u origin main
   ```

   Refresh the GitHub page — your files should now be there.

> Tip: the included `.gitignore` already keeps secrets (`.env`) and local data out of GitHub. Good.

---

## Part 2 — Deploy on Render

Tavo includes a `render.yaml` blueprint, so Render sets up **both** the app and a PostgreSQL database automatically.

1. Go to the Render dashboard → **New** → **Blueprint**.
2. Click **Connect GitHub**, authorize Render, and pick your `platepoint` repository.
3. Render reads `render.yaml` and shows it will create:
   - a **Web Service** named `platepoint`
   - a **PostgreSQL database** named `platepoint-db`
4. Click **Apply**. Render now builds and launches everything (a few minutes). It automatically:
   - connects the database to the app (`DATABASE_URL`),
   - generates a secure `JWT_SECRET`,
   - creates the tables and loads the starter menu + demo logins on first boot.
5. When the web service shows **Live**, click its URL (looks like `https://platepoint.onrender.com`).
6. Log in with **PIN 1234** (manager). 🎉 You're online.

> The free database expires after a set period and free web services sleep when idle (first visit after sleeping takes ~30s). For a real restaurant, upgrade both to a paid plan (a few dollars/month) so they stay on and your data is retained with backups.

---

## Part 3 — Turn on card payments (Stripe)

Until you do this, the app runs in "mock payment" mode (great for testing, no real cards).

### 3a. Start in TEST mode

1. In Stripe, make sure the **Test mode** toggle (top right) is ON.
2. Go to **Developers → API keys** and copy the two keys:
   - **Secret key** (`sk_test_…`)
   - **Publishable key** (`pk_test_…`)
3. In Render → your `platepoint` service → **Environment**, add:
   - `STRIPE_SECRET_KEY` = your `sk_test_…`
   - `STRIPE_PUBLISHABLE_KEY` = your `pk_test_…`
4. Click **Save** — Render restarts the app. The top bar now shows **💳 Stripe test**.
5. Test a payment with Stripe's test card: **4242 4242 4242 4242**, any future expiry, any CVC. It appears in your Stripe test dashboard.

### 3b. Add the webhook (so payments are confirmed securely)

1. In Stripe → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://YOUR-APP.onrender.com/api/webhooks/stripe`
3. Under "Select events," choose `payment_intent.succeeded` and `payment_intent.payment_failed`.
4. Create it, then copy the **Signing secret** (`whsec_…`).
5. In Render → Environment, add `STRIPE_WEBHOOK_SECRET` = that `whsec_…`, and Save.

### 3c. Go LIVE (when you're ready for real money)

1. Complete Stripe's **business activation** (bank details, business info) — required to accept real cards.
2. Switch Stripe to **Live mode** and copy the **live** keys (`sk_live_…`, `pk_live_…`).
3. Create a **live-mode** webhook the same way as 3b and copy its live signing secret.
4. Replace the three Stripe values in Render with the live ones. Save.

That's it — you're taking real payments over HTTPS.

---

## Important: change the demo PINs

The starter data ships with obvious PINs (1234 / 1111 / 3333). Before real use, set your own:

1. In Render → Environment, add `SEED_MANAGER_PIN`, `SEED_SERVER_PIN`, `SEED_KITCHEN_PIN` with your chosen numbers.
2. These only apply when seeding a fresh database. To re-seed an existing one with new PINs, open the Render service **Shell** and run `npm run seed` (note: this resets data — do it before going live, not after).
3. Once you've built your real menu and staff, set `AUTO_SEED=false` so the app never re-seeds.

---

## Updating the app later

Make changes locally, then:

```bash
git add .
git commit -m "what changed"
git push
```

Render automatically rebuilds and redeploys on every push to `main`.

---

## Quick troubleshooting

| Symptom | Fix |
|---|---|
| Build fails on Render | Check the build log; usually a typo in an env var. The build command is `npm ci`. |
| "login required" everywhere | Your session expired — log in again. |
| Card form doesn't appear | `STRIPE_PUBLISHABLE_KEY` not set or app still in mock mode. Check the top-bar badge. |
| Payments succeed but webhook 400s | The `STRIPE_WEBHOOK_SECRET` doesn't match the endpoint's signing secret. |
| App is slow on first visit | Free Render services sleep when idle. Upgrade the plan to keep it always-on. |

Need a different host? The same repo runs on **Railway** or **Fly.io** too — they use the `Procfile`. Just set `DATABASE_URL` (and `DATABASE_SSL=true`) and the Stripe vars the same way.
