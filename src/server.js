import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { getStore, storeKind } from './store/index.js';
import { buildSeedData } from './seedData.js';
import { createPaymentIntent, retrieveStatus, createRefund, usingStripe, stripeClient, paymentGateway, publishableKey } from './payments.js';
import { verifyPin, hashPin, issueToken, requireAuth, requireRole, ROLE_ROUTES } from './auth.js';
import { normalizeIncoming, exportMenu } from './integrations.js';
import { answer as askTavo, suggestions as askSuggestions } from './ask.js';
import { deliver, messagingMode, validateRecipient } from './messaging.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);   // correct client IP / protocol behind a load balancer (Render, Fly, etc.)
const PORT = process.env.PORT || 4242;
const TAX_RATE = parseFloat(process.env.TAX_RATE || '0.0825');
// Loyalty: earn N points per $1 of pre-tax spend; each point is worth $REDEEM at redemption.
const LOYALTY_EARN = parseFloat(process.env.LOYALTY_EARN_RATE || '1');      // points per $1
const LOYALTY_REDEEM = parseFloat(process.env.LOYALTY_REDEEM_RATE || '0.05'); // $ per point (100pts = $5)

// Store is initialized in start(); handlers access it via this reference.
let store;
// Small async wrapper so route handlers can throw and we still return JSON 500s.
const h = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e); res.status(500).json({ error: e.message });
});

// Resolve the tenant for a request from its auth token (defaults to the single
// 'default' tenant, so a one-store deployment behaves exactly as before).
const DEFAULT_TENANT = 'default';
const tid = req => (req && req.user && req.user.tenantId) || DEFAULT_TENANT;

// Resolve a public (guest) request's tenant from a ?tenant=slug param.
// Returns { id, slug, name } or null if the slug is unknown.
async function resolveTenant(slug) {
  if (!slug || slug === DEFAULT_TENANT) return { id: DEFAULT_TENANT, slug: DEFAULT_TENANT, name: 'Tavo' };
  const t = await store.getTenantBySlug(String(slug));
  return t ? { id: t.id, slug: t.slug, name: t.name } : null;
}

app.use(cors());

// ---- security headers (lightweight, no extra deps) ----
const PROD = process.env.NODE_ENV === 'production';
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// ---- brute-force throttle for PIN login (in-memory, per IP+tenant) ----
// PINs are short, so cap attempts: after MAX failures in WINDOW, lock for LOCK ms.
const LOGIN_MAX = parseInt(process.env.LOGIN_MAX_ATTEMPTS || '12', 10);
const LOGIN_WINDOW = 15 * 60 * 1000;   // 15 min
const LOGIN_LOCK = 15 * 60 * 1000;     // 15 min lockout
const loginHits = new Map();           // key -> { count, first, lockUntil }
function loginThrottle(req, res, next) {
  const key = (req.ip || 'ip') + '|' + (req.body && req.body.tenant || 'default');
  const now = Date.now();
  let e = loginHits.get(key);
  if (e && e.lockUntil && now < e.lockUntil)
    return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' });
  if (!e || now - e.first > LOGIN_WINDOW) { e = { count: 0, first: now, lockUntil: 0 }; loginHits.set(key, e); }
  req._loginKey = key;   // login handler clears this on success
  if (e.count >= LOGIN_MAX) { e.lockUntil = now + LOGIN_LOCK; return res.status(429).json({ error: 'Too many attempts — locked for 15 minutes.' }); }
  e.count++;
  next();
}
function loginSucceeded(req) { if (req._loginKey) loginHits.delete(req._loginKey); }   // reset on success
// occasional cleanup so the map can't grow unbounded
setInterval(() => { const now = Date.now(); for (const [k, e] of loginHits) if (now - e.first > LOGIN_WINDOW && (!e.lockUntil || now > e.lockUntil)) loginHits.delete(k); }, 10 * 60 * 1000).unref?.();

// ---- Stripe webhook (MUST be registered with the raw body, before express.json) ----
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), h(async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (usingStripe && secret) {
      const sig = req.headers['stripe-signature'];
      event = stripeClient().webhooks.constructEvent(req.body, sig, secret);
    } else {
      event = JSON.parse(req.body.toString() || '{}');   // dev fallback (no secret configured)
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const p = await store.findPaymentByStripeId(pi.id);
    if (p) await store.updatePayment(p.id, { status: 'succeeded', confirmed: true });
    console.log(`✓ Webhook confirmed payment ${pi.id}`);
  } else if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const p = await store.findPaymentByStripeId(pi.id);
    if (p) await store.updatePayment(p.id, { status: 'failed' });
    console.log(`✗ Webhook: payment failed ${pi.id}`);
  }
  res.json({ received: true });
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- helpers ----
const round = n => Math.round(n * 100) / 100;
// Tax is computed per line so items can carry their own rate (e.g. alcohol,
// non-taxable groceries). Lines without a taxRate fall back to the tenant default.
function priceLines(lines) {
  let subtotal = 0, taxFull = 0;
  for (const l of (lines || [])) {
    const mods = (l.mods || []).reduce((s, m) => {
      const x = String(m).match(/\+\$([0-9.]+)/); return s + (x ? parseFloat(x[1]) : 0);
    }, 0);
    const lineSub = (l.price + mods) * l.qty;
    subtotal += lineSub;
    const rate = (l.taxRate != null && l.taxRate !== '') ? Number(l.taxRate) : TAX_RATE;
    taxFull += lineSub * rate;
  }
  subtotal = round(subtotal);
  const effRate = subtotal > 0 ? taxFull / subtotal : TAX_RATE;
  return { subtotal, tax: round(taxFull), total: round(subtotal + taxFull), effRate };
}

// Final settlement math: a check-level discount reduces the taxable subtotal
// (like Toast/Square), a service charge is added, tax is on the discounted
// subtotal, and tip is added last. Discounts are true price reductions;
// gift cards are a tender and do NOT reduce the recorded sale total.
function settle(lines, { discount = 0, serviceCharge = 0, tip = 0, taxExempt = false } = {}) {
  const pl = priceLines(lines);
  const sub = pl.subtotal;
  const disc = round(Math.min(sub, Math.max(0, Number(discount) || 0)));
  const taxable = round(sub - disc);
  const svc = round(Math.max(0, Number(serviceCharge) || 0));
  const tax = taxExempt ? 0 : round(taxable * pl.effRate);
  const t = round(Math.max(0, Number(tip) || 0));
  const total = round(taxable + svc + tax + t);
  return { subtotal: sub, discount: disc, serviceCharge: svc, tax, tip: t, total, taxExempt: !!taxExempt };
}

// ---- scheduled (happy-hour) discounts ----
// Is a discount's schedule window active at `now`? Supports overnight windows
// (e.g. 22:00–02:00) that wrap past midnight. No schedule = not auto-active.
function discountInWindow(schedule, now = new Date()) {
  if (!schedule || !Array.isArray(schedule.days) || !schedule.days.length) return false;
  const day = now.getDay();
  const cur = now.getHours() * 60 + now.getMinutes();
  const parse = (s, d) => { const [h, m] = String(s || d).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const start = parse(schedule.start, '00:00');
  const end = parse(schedule.end, '23:59');
  if (end > start) return schedule.days.includes(day) && cur >= start && cur < end;
  // overnight wrap: active late today (after start) or early today carried from yesterday (before end)
  const prev = (day + 6) % 7;
  return (schedule.days.includes(day) && cur >= start) || (schedule.days.includes(prev) && cur < end);
}
// Dollar amount a preset takes off a given subtotal.
function discountAmountFor(preset, subtotal) {
  const v = Number(preset.value) || 0;
  const amt = preset.kind === 'amount' ? v : (subtotal * v) / 100;
  return round(Math.min(subtotal, Math.max(0, amt)));
}
// Sanitize a schedule object from request input.
function cleanSchedule(s) {
  if (!s || typeof s !== 'object') return null;
  const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter(d => d >= 0 && d <= 6))] : [];
  if (!days.length) return null;
  const hhmm = (x, d) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(x || d)); if (!m) return d; const h = Math.min(23, +m[1]), mi = Math.min(59, +m[2]); return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0'); };
  return { days: days.sort(), start: hhmm(s.start, '16:00'), end: hhmm(s.end, '18:00') };
}

// Deplete ingredient stock for an order based on each menu item's recipe.
// recipe = [{ invId, qty }]; consumed = qty × line.qty. Best-effort, never throws.
async function depleteForOrder(order, tenantId = DEFAULT_TENANT) {
  try {
    const menu = await store.listMenu(tenantId);
    const recipeOf = new Map(menu.map(m => [m.id, m.recipe || []]));
    const byName = new Map(menu.map(m => [m.name, m.recipe || []]));
    const used = new Map();   // invId → total qty consumed
    for (const l of (order.lines || [])) {
      const recipe = recipeOf.get(l.id) || byName.get(l.name) || [];
      for (const r of recipe) {
        if (!r || !r.invId) continue;
        used.set(r.invId, (used.get(r.invId) || 0) + (Number(r.qty) || 0) * (Number(l.qty) || 1));
      }
    }
    for (const [invId, qty] of used) if (qty > 0) await store.adjustInventory(invId, -qty);
  } catch (e) { console.error('inventory depletion skipped:', e.message); }
}

// Retail: decrement a product's own stock when it's sold (for trackStock items).
async function depleteProductStock(lines, tenantId = DEFAULT_TENANT) {
  try {
    const menu = await store.listMenu(tenantId);
    const byId = new Map(menu.map(m => [m.id, m]));
    const byName = new Map(menu.map(m => [m.name, m]));
    for (const l of (lines || [])) {
      const p = byId.get(l.id) || byName.get(l.name);
      if (p && p.trackStock) await store.adjustMenuStock(p.id, -(Number(l.qty) || 1));
    }
  } catch (e) { console.error('product stock depletion skipped:', e.message); }
}

// Sum the ingredient cost of an order's lines (for food-cost reporting).
function orderFoodCost(lines, recipeOf, costOf) {
  let c = 0;
  for (const l of (lines || [])) {
    const recipe = recipeOf.get(l.id) || recipeOf.get('name:' + l.name) || [];
    for (const r of recipe) c += (Number(costOf.get(r.invId)) || 0) * (Number(r.qty) || 0) * (Number(l.qty) || 1);
  }
  return round(c);
}

// Dayparting: is this item available at `now` per its schedule {days,start,end}?
function availableNow(item, now = new Date()) {
  const s = item && item.schedule;
  if (!s || (!s.start && !s.end && (!Array.isArray(s.days) || !s.days.length))) return true;
  if (Array.isArray(s.days) && s.days.length && !s.days.includes(now.getDay())) return false;
  if (s.start || s.end) {
    const mins = now.getHours() * 60 + now.getMinutes();
    const toM = t => { const p = String(t).split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };
    const a = s.start ? toM(s.start) : 0, b = s.end ? toM(s.end) : 1440;
    if (a <= b) { if (mins < a || mins >= b) return false; }
    else if (mins < a && mins >= b) return false;   // overnight window
  }
  return true;
}

// ---- config / health ----
app.get('/api/health', (req, res) =>
  res.json({ ok: true, paymentMode: paymentGateway, taxRate: TAX_RATE, db: storeKind() }));

app.get('/api/config', (req, res) => res.json({
  publishableKey: publishableKey(),
  paymentMode: paymentGateway,
  taxRate: TAX_RATE,
}));

// ---- tenant signup (multi-tenant) ----
app.post('/api/tenants', h(async (req, res) => {
  const { name, slug, managerPin } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'business name and slug required' });
  const cleanSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!cleanSlug) return res.status(400).json({ error: 'invalid slug' });
  if (cleanSlug === DEFAULT_TENANT || await store.getTenantBySlug(cleanSlug))
    return res.status(409).json({ error: 'that address is taken' });
  const mode = ['restaurant', 'retail'].includes(req.body.mode) ? req.body.mode : 'restaurant';
  const tenant = { id: nanoid(10), name: String(name), slug: cleanSlug, plan: 'free', mode, createdAt: Date.now() };
  await store.createTenant(tenant);
  // Seed this tenant's own starter menu/tables/staff/users/inventory (stamped with its id).
  const data = buildSeedData();
  const pin = String(managerPin || '1234');
  // Inventory ids are global PKs, so give this tenant fresh ids and rewrite the
  // recipe references on its menu to match (prevents cross-tenant id collisions).
  const idMap = {};
  (data.inventory || []).forEach(inv => { const nid = nanoid(8); idMap[inv.id] = nid; inv.id = nid; });
  data.menu.forEach(m => { m.recipe = (m.recipe || []).map(r => ({ ...r, invId: idMap[r.invId] || r.invId })); });
  for (const arr of [data.menu, data.tables, data.staff, data.users, data.inventory]) arr.forEach(x => { x.tenantId = tenant.id; });
  const mgr = data.users.find(u => u.role === 'manager'); if (mgr) mgr.pinHash = hashPin(pin);
  await store.seedTenant(data);
  res.status(201).json({ tenant: { id: tenant.id, name: tenant.name, slug: cleanSlug }, managerPin: pin, loginHint: `log in with ?tenant=${cleanSlug}` });
}));

// ---- auth ----
app.post('/api/auth/login', loginThrottle, h(async (req, res) => {
  const { pin, tenant } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  let tenantId = DEFAULT_TENANT, tenantSlug = DEFAULT_TENANT, tenantName = 'Tavo', tenantMode = 'restaurant';
  if (tenant && tenant !== DEFAULT_TENANT) {
    const tt = await store.getTenantBySlug(String(tenant));
    if (!tt) return res.status(404).json({ error: 'unknown business' });
    tenantId = tt.id; tenantSlug = tt.slug; tenantName = tt.name; tenantMode = tt.mode || 'restaurant';
  } else {
    const def = await store.getTenant(DEFAULT_TENANT);
    if (def && def.mode) tenantMode = def.mode;
  }
  const users = await store.listUsers(tenantId);
  const user = users.find(u => verifyPin(pin, u.pinHash));
  if (!user) return res.status(401).json({ error: 'Invalid PIN' });
  loginSucceeded(req);   // clear the throttle counter on a good login
  const token = issueToken({ ...user, tenantId, tenantSlug, tenantName, tenantMode });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, tenantId, tenantSlug, tenantName, tenantMode, routes: ROLE_ROUTES[user.role] || [] } });
}));

app.get('/api/auth/me', requireAuth, (req, res) =>
  res.json({ ...req.user, routes: ROLE_ROUTES[req.user.role] || [] }));

// ===================================================================
//  GUEST  ·  QR Mobile Order & Pay  (public, no login — scoped by ?tenant=slug)
// ===================================================================
// A diner scans the QR on their table → opens /order.html?tenant=slug&table=N.
// These endpoints are intentionally unauthenticated but strictly read-only
// for menu/config, and write-only for creating their own order + payment.

// Public storefront config (branding + payment publishable key).
app.get('/api/guest/config', h(async (req, res) => {
  const t = await resolveTenant(req.query.tenant);
  if (!t) return res.status(404).json({ error: 'restaurant not found' });
  res.json({
    tenant: { slug: t.slug, name: t.name },
    publishableKey: publishableKey(),
    paymentMode: paymentGateway,
    taxRate: TAX_RATE,
  });
}));

// Public menu for the guest storefront (active items only).
app.get('/api/guest/menu', h(async (req, res) => {
  const t = await resolveTenant(req.query.tenant);
  if (!t) return res.status(404).json({ error: 'restaurant not found' });
  const menu = (await store.listMenu(t.id)).filter(m => m.active !== false && availableNow(m));
  res.json(menu);
}));

// Sanitize guest-submitted cart lines against the real menu so prices/mods
// can never be tampered with from the client. Returns priced server-side lines.
async function buildGuestLines(tenantId, rawLines) {
  const menu = await store.listMenu(tenantId);
  const byId = new Map(menu.map(m => [m.id, m]));
  const lines = [];
  for (const l of (rawLines || [])) {
    const item = byId.get(l.id) || menu.find(m => m.name === l.name);
    if (!item || item.active === false) continue;
    const qty = Math.max(1, Math.min(99, parseInt(l.qty, 10) || 1));
    // Validate modifiers against the item's modifier groups (use trusted prices).
    const mods = [];
    const groups = item.modifierGroups || [];
    for (const chosen of (l.mods || [])) {
      const name = typeof chosen === 'string' ? chosen.replace(/\s*\(\+\$[0-9.]+\)\s*$/, '') : chosen.name;
      let opt = null;
      for (const g of groups) { const o = (g.options || []).find(o => o.name === name); if (o) { opt = o; break; } }
      if (!opt) continue;
      mods.push(opt.price ? `${opt.name} (+$${Number(opt.price).toFixed(2)})` : opt.name);
    }
    lines.push({ id: item.id, name: item.name, price: item.price, qty, mods });
  }
  return lines;
}

// Place an order from the table (pay at counter / add to tab — staff settles it).
app.post('/api/guest/orders', h(async (req, res) => {
  const t = await resolveTenant(req.body.tenant);
  if (!t) return res.status(404).json({ error: 'restaurant not found' });
  const lines = await buildGuestLines(t.id, req.body.lines);
  if (!lines.length) return res.status(400).json({ error: 'your cart is empty' });
  const table = req.body.table != null ? Number(req.body.table) : null;
  const totals = priceLines(lines);
  const count = await store.countOrders(t.id);
  const order = {
    id: nanoid(10), number: 1000 + count + 1, table, lines, ...totals,
    status: 'open', channel: 'qr', customer: (req.body.name || 'Table guest').toString().slice(0, 60),
    tenantId: t.id, createdAt: Date.now(),
  };
  await store.createOrder(order);
  if (table) await store.setTableStatus(table, 'seated', order.id, t.id);
  res.status(201).json({ ok: true, order: { number: order.number, total: order.total, status: order.status } });
}));

// Step 1 of guest pay: create a payment intent for the cart.
app.post('/api/guest/pay/intent', h(async (req, res) => {
  const t = await resolveTenant(req.body.tenant);
  if (!t) return res.status(404).json({ error: 'restaurant not found' });
  const lines = await buildGuestLines(t.id, req.body.lines);
  if (!lines.length) return res.status(400).json({ error: 'your cart is empty' });
  const totals = priceLines(lines);
  const tip = Math.max(0, Number(req.body.tip || 0));
  const grand = round(totals.total + tip);
  const intent = await createPaymentIntent(grand, { tenant: t.slug, table: String(req.body.table || '') });
  res.json({ ...intent, amount: grand, ...totals, tip });
}));

// Step 2 of guest pay: confirm → record payment + fire the order to the kitchen.
app.post('/api/guest/pay/complete', h(async (req, res) => {
  const t = await resolveTenant(req.body.tenant);
  if (!t) return res.status(404).json({ error: 'restaurant not found' });
  const lines = await buildGuestLines(t.id, req.body.lines);
  if (!lines.length) return res.status(400).json({ error: 'your cart is empty' });
  const table = req.body.table != null ? Number(req.body.table) : null;
  const tip = Math.max(0, Number(req.body.tip || 0));
  const totals = priceLines(lines);
  const total = round(totals.total + tip);
  const status = await retrieveStatus(req.body.intentId);
  const count = await store.countOrders(t.id);
  const order = {
    id: nanoid(10), number: 1000 + count + 1, table, lines, ...totals,
    status: 'cooking', channel: 'qr', customer: (req.body.name || 'Table guest').toString().slice(0, 60),
    paid: true, tenantId: t.id, createdAt: Date.now(), firedAt: Date.now(),
  };
  await store.createOrder(order);
  await depleteForOrder(order, t.id);   // paid guest order fires to kitchen
  await store.createPayment({
    id: nanoid(10), orderId: order.id, table, lines, ...totals, tip, total,
    method: 'card', status, stripeId: req.body.intentId || null, confirmed: false,
    refundedAmount: 0, refundedAt: null, tenantId: t.id, createdAt: Date.now(),
  });
  if (table) await store.setTableStatus(table, 'seated', order.id, t.id);
  res.status(201).json({ ok: true, order: { number: order.number, total, status: order.status } });
}));

// ---- menu ----
app.get('/api/menu', requireAuth, h(async (req, res) => res.json(await store.listMenu(tid(req)))));

// Retail: look up a product by scanned barcode or typed SKU.
app.get('/api/products/lookup', requireAuth, h(async (req, res) => {
  if (!req.query.code) return res.status(400).json({ error: 'code required' });
  const p = await store.findProductByCode(req.query.code, tid(req));
  p ? res.json(p) : res.status(404).json({ error: 'no product with that code' });
}));

// ---- tenant / business mode (retail vs restaurant) ----
app.get('/api/tenant', requireAuth, h(async (req, res) => {
  const t = await store.getTenant(tid(req));
  res.json(t ? { id: t.id, name: t.name, slug: t.slug, mode: t.mode || 'restaurant', settings: t.settings || {} } : { id: DEFAULT_TENANT, name: 'Tavo', slug: DEFAULT_TENANT, mode: 'restaurant', settings: {} });
}));

app.put('/api/tenant', requireAuth, requireRole('manager'), h(async (req, res) => {
  const patch = {};
  if (req.body.mode && ['restaurant', 'retail'].includes(req.body.mode)) patch.mode = req.body.mode;
  if (req.body.name) patch.name = String(req.body.name);
  if (req.body.settings && typeof req.body.settings === 'object') {
    const cur = await store.getTenant(tid(req));
    patch.settings = { ...((cur && cur.settings) || {}), ...req.body.settings };
  }
  let t = await store.updateTenant(tid(req), patch);
  if (!t) {
    // No tenant row yet (legacy default store) — create it, then apply.
    await store.createTenant({ id: tid(req), name: patch.name || 'Tavo', slug: tid(req), plan: 'free', mode: patch.mode || 'restaurant', settings: patch.settings || {}, createdAt: Date.now() });
    t = await store.getTenant(tid(req));
  }
  res.json({ id: t.id, name: t.name, slug: t.slug, mode: t.mode || 'restaurant', settings: t.settings || {} });
}));

app.post('/api/menu', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { category, name, price, emoji, image, sortOrder, modifierGroups, recipe, sku, barcode, stock, trackStock, taxRate, schedule, isCombo, comboItems, weighted, weightUnit } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name and price required' });
  const existing = await store.listMenu(tid(req));
  const item = {
    id: nanoid(8), category: category || 'Other', name, price: Number(price),
    emoji: emoji || '🍽️', image: image || null,
    sortOrder: sortOrder != null ? Number(sortOrder) : existing.length,
    modifierGroups: Array.isArray(modifierGroups) ? modifierGroups : [],
    recipe: Array.isArray(recipe) ? recipe : [],
    sku: sku ? String(sku) : null, barcode: barcode ? String(barcode) : null,
    stock: stock != null && stock !== '' ? Number(stock) : null, trackStock: !!trackStock,
    taxRate: taxRate != null && taxRate !== '' ? Number(taxRate) : null,
    schedule: schedule && typeof schedule === 'object' ? schedule : null,
    isCombo: !!isCombo, comboItems: Array.isArray(comboItems) ? comboItems : [],
    weighted: !!weighted, weightUnit: weightUnit ? String(weightUnit) : 'lb',
    tenantId: tid(req), active: true,
  };
  await store.createMenuItem(item);
  res.status(201).json(item);
}));

// Bulk reorder: body { order: [id1, id2, ...] } sets sort_order by position
app.post('/api/menu/reorder', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { order = [] } = req.body;
  for (let i = 0; i < order.length; i++) await store.updateMenuItem(order[i], { sortOrder: i });
  res.json(await store.listMenu());
}));

app.put('/api/menu/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const out = await store.updateMenuItem(req.params.id, req.body);
  out ? res.json(out) : res.status(404).json({ error: 'not found' });
}));

app.delete('/api/menu/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  await store.deleteMenuItem(req.params.id);
  res.status(204).end();
}));

// ---- tables ----
app.get('/api/tables', requireAuth, h(async (req, res) => res.json(await store.listTables(tid(req)))));

// ---- orders ----
app.get('/api/orders', requireAuth, h(async (req, res) => {
  res.json(await store.listOrders(req.query.status, tid(req)));
}));

app.post('/api/orders', requireAuth, h(async (req, res) => {
  const { lines = [], table = null } = req.body;
  if (!lines.length) return res.status(400).json({ error: 'order has no items' });
  const totals = priceLines(lines);
  const count = await store.countOrders(tid(req));
  const order = { id: nanoid(10), number: 1000 + count + 1, table, lines, ...totals, status: 'open', firedCourses: [], tenantId: tid(req), createdAt: Date.now() };
  await store.createOrder(order);
  if (table) await store.setTableStatus(table, 'seated', order.id, tid(req));
  res.status(201).json(order);
}));

// send order to kitchen
app.post('/api/orders/:id/fire', requireAuth, h(async (req, res) => {
  const before = await store.getOrder(req.params.id);
  const out = await store.updateOrder(req.params.id, { status: 'cooking', firedAt: Date.now() });
  if (!out) return res.status(404).json({ error: 'not found' });
  // Deplete stock only on the first fire (open → cooking), so re-fires don't double-count.
  if (before && before.status !== 'cooking') await depleteForOrder(out, tid(req));
  res.json(out);
}));

// Fire a single course to the kitchen (coursing). Sends just that course's items,
// depletes their stock once, and records the course as fired so it isn't re-sent.
app.post('/api/orders/:id/fire-course', requireAuth, h(async (req, res) => {
  const order = await store.getOrder(req.params.id);
  if (!order || (order.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const course = String(req.body.course ?? '');
  if (!course) return res.status(400).json({ error: 'course required' });
  const courseLines = (order.lines || []).filter(l => String(l.course ?? '') === course);
  if (courseLines.length === 0) return res.status(400).json({ error: 'no items in that course' });
  const fired = Array.isArray(order.firedCourses) ? order.firedCourses.slice() : [];
  if (fired.includes(course)) return res.status(400).json({ error: 'course already fired' });
  fired.push(course);
  // deplete only this course's lines
  await depleteForOrder({ ...order, lines: courseLines }, tid(req));
  const patch = { firedCourses: fired };
  if (order.status === 'open') { patch.status = 'cooking'; patch.firedAt = Date.now(); }
  const out = await store.updateOrder(req.params.id, patch);
  res.json(out);
}));

// bump (kitchen marks ready)
app.post('/api/orders/:id/bump', requireAuth, h(async (req, res) => {
  const out = await store.updateOrder(req.params.id, { status: 'ready' });
  out ? res.json(out) : res.status(404).json({ error: 'not found' });
}));

// ---- payments ----
// Step 1: create a payment intent for an order (or ad-hoc amount)
app.post('/api/payments/intent', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const { lines = [], tip = 0, orderId = null, table = null } = req.body;
  const totals = priceLines(lines);
  const grand = round(totals.total + Number(tip || 0));
  const intent = await createPaymentIntent(grand, { orderId: orderId || '', table: String(table || '') });
  res.json({ ...intent, amount: grand, ...totals, tip: Number(tip || 0) });
}));

// Step 2: record the completed payment + close the order/table
app.post('/api/payments/complete', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const { intentId, method = 'card', lines = [], tip = 0, orderId = null, table = null, customerId = null, pointsRedeemed = 0,
    discount = 0, discountReason = null, serviceCharge = 0, comp = false, taxExempt = false } = req.body;
  // Comps (zeroing or near-zeroing a check) require a manager.
  const sub0 = priceLines(lines).subtotal;
  if ((comp || (Number(discount) || 0) >= sub0 - 1e-9) && (Number(discount) || 0) > 0 && req.user.role !== 'manager')
    return res.status(403).json({ error: 'comps require a manager' });
  const status = await retrieveStatus(intentId);
  const totals = settle(lines, { discount, serviceCharge, tip, taxExempt });
  const total = totals.total;

  // ---- loyalty: award points + apply any redemption to the attached member ----
  let pointsEarned = 0, member = null;
  if (customerId) {
    member = await store.getCustomer(customerId);
    if (member && (member.tenantId || DEFAULT_TENANT) === tid(req)) {
      pointsEarned = Math.floor(totals.subtotal * LOYALTY_EARN);
      const redeem = Math.max(0, Math.min(Math.round(Number(pointsRedeemed) || 0), member.points || 0));
      const newPoints = Math.max(0, (member.points || 0) - redeem + pointsEarned);
      await store.updateCustomer(member.id, {
        points: newPoints,
        visits: (member.visits || 0) + 1,
        totalSpent: round((member.totalSpent || 0) + total),
      });
    } else { member = null; }
  }

  const payment = {
    id: nanoid(10), orderId, table, lines, ...totals,
    method, status, stripeId: intentId || null, confirmed: false,
    refundedAmount: 0, refundedAt: null,
    discountReason: totals.discount > 0 ? (discountReason || (comp ? 'Comp' : 'Discount')) : null,
    customerId: member ? member.id : null, pointsEarned, pointsRedeemed: member ? Math.round(Number(pointsRedeemed) || 0) : 0,
    userId: req.user && req.user.id || null, userName: req.user && req.user.name || null,
    tenantId: tid(req), createdAt: Date.now(),
  };
  await store.createPayment(payment);
  await depleteProductStock(lines, tid(req));   // retail: decrement product stock for tracked SKUs
  if (orderId) await store.updateOrder(orderId, { status: 'paid' });
  if (table) await store.setTableStatus(table, 'open', null, tid(req));
  res.status(201).json({ ...payment, pointsBalance: member ? (await store.getCustomer(member.id)).points : null });
}));

// Split a check across multiple tenders (e.g., $20 cash + the rest card, or an
// even split). The first tender carries the full lines + tax/discount breakdown
// so item counts aren't double-counted; the rest carry only the tendered amount.
app.post('/api/payments/split', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const { lines = [], tip = 0, discount = 0, discountReason = null, serviceCharge = 0, comp = false, taxExempt = false,
    orderId = null, table = null, tenders = [], customerId = null, pointsRedeemed = 0 } = req.body;
  if (!Array.isArray(tenders) || tenders.length < 1) return res.status(400).json({ error: 'at least one tender required' });
  const sub0 = priceLines(lines).subtotal;
  if ((comp || (Number(discount) || 0) >= sub0 - 1e-9) && (Number(discount) || 0) > 0 && req.user.role !== 'manager')
    return res.status(403).json({ error: 'comps require a manager' });
  const totals = settle(lines, { discount, serviceCharge, tip, taxExempt });
  const paid = round(tenders.reduce((a, t) => a + (Number(t.amount) || 0), 0));
  if (Math.abs(paid - totals.total) > 0.01) return res.status(400).json({ error: `tenders total ${paid.toFixed(2)} must equal the check total ${totals.total.toFixed(2)}` });

  // loyalty (award once on the whole check)
  let pointsEarned = 0, member = null;
  if (customerId) {
    member = await store.getCustomer(customerId);
    if (member && (member.tenantId || DEFAULT_TENANT) === tid(req)) {
      pointsEarned = Math.floor(totals.subtotal * LOYALTY_EARN);
      const redeem = Math.max(0, Math.min(Math.round(Number(pointsRedeemed) || 0), member.points || 0));
      await store.updateCustomer(member.id, { points: Math.max(0, (member.points || 0) - redeem + pointsEarned), visits: (member.visits || 0) + 1, totalSpent: round((member.totalSpent || 0) + totals.total) });
    } else { member = null; }
  }

  const created = [];
  for (let i = 0; i < tenders.length; i++) {
    const t = tenders[i];
    const first = i === 0;
    const payment = {
      id: nanoid(10), orderId, table,
      lines: first ? lines : [],
      subtotal: first ? totals.subtotal : 0, discount: first ? totals.discount : 0, serviceCharge: first ? totals.serviceCharge : 0,
      tax: first ? totals.tax : 0, tip: first ? totals.tip : 0,
      total: round(Number(t.amount) || 0),
      method: t.method || 'card', status: 'succeeded', stripeId: null, confirmed: false,
      refundedAmount: 0, refundedAt: null,
      discountReason: first && totals.discount > 0 ? (discountReason || (comp ? 'Comp' : 'Discount')) : null,
      customerId: first && member ? member.id : null, pointsEarned: first ? pointsEarned : 0, pointsRedeemed: first && member ? Math.round(Number(pointsRedeemed) || 0) : 0,
      userId: req.user && req.user.id || null, userName: req.user && req.user.name || null,
      split: true, splitCount: tenders.length, tenantId: tid(req), createdAt: Date.now(),
    };
    await store.createPayment(payment);
    created.push(payment);
  }
  await depleteProductStock(lines, tid(req));
  if (orderId) await store.updateOrder(orderId, { status: 'paid' });
  if (table) await store.setTableStatus(table, 'open', null, tid(req));
  res.status(201).json({ ok: true, total: totals.total, tenders: created.length, payments: created.map(p => ({ id: p.id, method: p.method, total: p.total })) });
}));

app.get('/api/payments', requireAuth, h(async (req, res) => res.json(await store.listPayments(tid(req)))));

// Refund a payment (full or partial). Manager only.
app.post('/api/payments/:id/refund', requireAuth, requireRole('manager'), h(async (req, res) => {
  const pay = await store.getPayment(req.params.id);
  if (!pay) return res.status(404).json({ error: 'payment not found' });
  const already = pay.refundedAmount || 0;
  const refundable = round(pay.total - already);
  if (refundable <= 0) return res.status(400).json({ error: 'payment already fully refunded' });
  let amount = req.body.amount == null ? refundable : Number(req.body.amount);
  if (!(amount > 0)) return res.status(400).json({ error: 'refund amount must be positive' });
  if (amount > refundable + 1e-9) return res.status(400).json({ error: `max refundable is ${refundable.toFixed(2)}` });
  amount = round(amount);

  const refund = await createRefund(pay.stripeId, amount);   // Stripe (or mock)
  const newRefunded = round(already + amount);
  const status = newRefunded >= pay.total - 1e-9 ? 'refunded' : 'partially_refunded';
  const updated = await store.updatePayment(pay.id, { refundedAmount: newRefunded, refundedAt: Date.now(), status });
  res.json({ ...updated, refund });
}));

// Void an order that hasn't been paid yet (cancel before settlement).
app.post('/api/orders/:id/void', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const order = await store.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.status === 'paid') return res.status(400).json({ error: 'paid orders must be refunded, not voided' });
  const out = await store.updateOrder(order.id, { status: 'voided', voidReason: req.body.reason || 'staff void' });
  if (order.table) await store.setTableStatus(order.table, 'open', null, tid(req));
  res.json(out);
}));

// ---- reports ----
app.get('/api/reports/summary', requireAuth, requireRole('manager'), h(async (req, res) => {
  const pays = await store.listPayments(tid(req));
  const tables = await store.listTables(tid(req));
  const gross = round(pays.reduce((a, p) => a + p.total, 0));
  const refunds = round(pays.reduce((a, p) => a + (p.refundedAmount || 0), 0));
  const net = round(gross - refunds);
  const tips = round(pays.reduce((a, p) => a + p.tip, 0));
  const tax = round(pays.reduce((a, p) => a + p.tax, 0));
  const discounts = round(pays.reduce((a, p) => a + (p.discount || 0), 0));
  const serviceCharges = round(pays.reduce((a, p) => a + (p.serviceCharge || 0), 0));
  const comps = pays.filter(p => (p.discount || 0) > 0 && String(p.discountReason || '').toLowerCase().includes('comp')).length;
  const orders = pays.length;
  const avgCheck = orders ? round(gross / orders) : 0;
  const byMethod = {};
  pays.forEach(p => { byMethod[p.method] = round((byMethod[p.method] || 0) + p.total); });
  const itemCounts = {};
  pays.forEach(p => (p.lines || []).forEach(l => { itemCounts[l.name] = (itemCounts[l.name] || 0) + (l.qty || 0); }));
  const topSellers = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const openChecks = tables.filter(t => t.status !== 'open').length;

  // ---- food cost & inventory health ----
  const menu = await store.listMenu(tid(req));
  const inventory = await store.listInventory(tid(req));
  const costOf = new Map(inventory.map(i => [i.id, i.cost]));
  const recipeOf = new Map();
  menu.forEach(m => { recipeOf.set(m.id, m.recipe || []); recipeOf.set('name:' + m.name, m.recipe || []); });
  const foodCost = round(pays.reduce((a, p) => a + orderFoodCost(p.lines, recipeOf, costOf), 0));
  const netSalesForPct = round(gross - tax);   // food cost is measured against pre-tax sales
  const foodCostPct = netSalesForPct > 0 ? round((foodCost / netSalesForPct) * 100) : 0;
  const grossProfit = round(netSalesForPct - foodCost);
  const lowStock = inventory.filter(i => i.qty <= (i.parLevel || 0)).map(i => ({ id: i.id, name: i.name, qty: i.qty, parLevel: i.parLevel, unit: i.unit }));
  const stockValue = round(inventory.reduce((a, i) => a + i.qty * i.cost, 0));

  // ---- labor (today) ----
  const st = (() => { const x = new Date(); x.setHours(0, 0, 0, 0); return x.getTime(); })();
  const shifts = await store.listShifts(tid(req));
  const todayShifts = shifts.filter(s => (s.clockIn || 0) >= st);
  const laborHours = round(todayShifts.reduce((a, s) => a + shiftHours(s), 0));
  const laborCost = round(todayShifts.reduce((a, s) => a + shiftHours(s) * (s.wage || 0), 0));
  const todayGross = round(pays.filter(p => p.createdAt >= st).reduce((a, p) => a + (p.total || 0), 0));
  const laborPct = todayGross > 0 ? round((laborCost / todayGross) * 100) : 0;
  const clockedIn = shifts.filter(s => s.status === 'open').length;

  res.json({ gross, refunds, net, tips, tax, discounts, serviceCharges, comps, orders, avgCheck, byMethod, topSellers, openChecks,
    foodCost, foodCostPct, grossProfit, lowStock, stockValue, inventoryCount: inventory.length,
    laborCost, laborHours, laborPct, clockedIn });
}));

// ============================================================================
//  Advanced analytics — breakdowns, heatmaps, period comparison, report builder
// ============================================================================
const DAYPARTS = [
  { key: 'Morning', from: 5, to: 11 }, { key: 'Lunch', from: 11, to: 14 },
  { key: 'Afternoon', from: 14, to: 17 }, { key: 'Dinner', from: 17, to: 22 },
  { key: 'Late night', from: 22, to: 29 },   // 22:00–05:00 (wraps)
];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function daypartOf(hr) { for (const d of DAYPARTS) { const h = hr < 5 ? hr + 24 : hr; if (h >= d.from && h < d.to) return d.key; } return 'Late night'; }
const payNet = p => round((p.total || 0) - (p.refundedAmount || 0));
function defaultRange(q) {
  const to = q.to ? Number(q.to) : Date.now();
  const from = q.from ? Number(q.from) : to - 30 * 86400000;
  return { from, to };
}

// One call: every standard breakdown over a date range, plus a previous-period comparison.
app.get('/api/reports/analytics', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { from, to } = defaultRange(req.query);
  const all = (await store.listPayments(tid(req))).filter(p => p.status !== 'voided');
  const inRange = all.filter(p => (p.createdAt || 0) >= from && (p.createdAt || 0) < to);
  const menu = await store.listMenu(tid(req));
  const catOf = new Map(); menu.forEach(m => catOf.set(m.name, m.category || 'Other'));

  const sum = arr => round(arr.reduce((a, p) => a + payNet(p), 0));
  const bucket = (keyFn) => {
    const m = {};
    for (const p of inRange) { const k = keyFn(p); if (k == null) continue; (m[k] ||= { key: k, sales: 0, orders: 0, tips: 0 }); m[k].sales = round(m[k].sales + payNet(p)); m[k].orders++; m[k].tips = round(m[k].tips + (p.tip || 0)); }
    return Object.values(m).sort((a, b) => b.sales - a.sales);
  };
  const byEmployee = bucket(p => p.userName || 'Unassigned');
  const byMethod = bucket(p => p.method || 'other');
  const byDaypart = bucket(p => daypartOf(new Date(p.createdAt).getHours()));
  const byDow = DOW.map((d, i) => { const ps = inRange.filter(p => new Date(p.createdAt).getDay() === i); return { key: d, sales: sum(ps), orders: ps.length }; });
  const byHour = Array.from({ length: 24 }, (_, hr) => { const ps = inRange.filter(p => new Date(p.createdAt).getHours() === hr); return { hour: hr, sales: sum(ps), orders: ps.length }; });

  // category needs per-line attribution
  const catMap = {};
  for (const p of inRange) for (const l of (p.lines || [])) {
    const c = catOf.get(l.name) || 'Other'; const amt = round((l.price || 0) * (l.qty || 0));
    (catMap[c] ||= { key: c, sales: 0, units: 0 }); catMap[c].sales = round(catMap[c].sales + amt); catMap[c].units = round(catMap[c].units + (l.qty || 0));
  }
  const byCategory = Object.values(catMap).sort((a, b) => b.sales - a.sales);

  // discounts + taxes
  const discountRows = {};
  inRange.filter(p => (p.discount || 0) > 0).forEach(p => { const r = p.discountReason || 'Discount'; (discountRows[r] ||= { key: r, amount: 0, count: 0 }); discountRows[r].amount = round(discountRows[r].amount + p.discount); discountRows[r].count++; });
  const discounts = { total: round(inRange.reduce((a, p) => a + (p.discount || 0), 0)), byReason: Object.values(discountRows).sort((a, b) => b.amount - a.amount) };
  const taxTotal = round(inRange.reduce((a, p) => a + (p.tax || 0), 0));
  const exemptCount = inRange.filter(p => (p.subtotal || 0) > 0 && (p.tax || 0) === 0).length;

  // previous equal-length period for comparison
  const span = to - from;
  const prev = all.filter(p => (p.createdAt || 0) >= (from - span) && (p.createdAt || 0) < from);
  const pct = (cur, was) => was > 0 ? round(((cur - was) / was) * 100) : (cur > 0 ? 100 : 0);
  const netNow = sum(inRange), netPrev = sum(prev);
  const compare = { netSales: netNow, prevNetSales: netPrev, salesChangePct: pct(netNow, netPrev), orders: inRange.length, prevOrders: prev.length, ordersChangePct: pct(inRange.length, prev.length) };

  res.json({ range: { from, to }, totals: { netSales: netNow, orders: inRange.length, avgCheck: inRange.length ? round(netNow / inRange.length) : 0, tax: taxTotal, taxExemptOrders: exemptCount },
    byEmployee, byCategory, byDaypart, byDow, byHour, byMethod, discounts, compare });
}));

// Flexible report builder: choose a dimension to group by and a metric to measure.
app.get('/api/reports/build', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { from, to } = defaultRange(req.query);
  const groupBy = String(req.query.groupBy || 'employee');
  const metric = String(req.query.metric || 'sales');
  const pays = (await store.listPayments(tid(req))).filter(p => p.status !== 'voided' && (p.createdAt || 0) >= from && (p.createdAt || 0) < to);
  const menu = await store.listMenu(tid(req));
  const catOf = new Map(); menu.forEach(m => catOf.set(m.name, m.category || 'Other'));
  const keyFns = {
    employee: p => p.userName || 'Unassigned', method: p => p.method || 'other',
    daypart: p => daypartOf(new Date(p.createdAt).getHours()),
    hour: p => String(new Date(p.createdAt).getHours()).padStart(2, '0') + ':00',
    dow: p => DOW[new Date(p.createdAt).getDay()],
    day: p => new Date(p.createdAt).toISOString().slice(0, 10),
  };
  if (groupBy === 'category') {
    const m = {};
    for (const p of pays) for (const l of (p.lines || [])) { const c = catOf.get(l.name) || 'Other'; (m[c] ||= { sales: 0, orders: 0, units: 0 }); m[c].sales = round(m[c].sales + (l.price || 0) * (l.qty || 0)); m[c].units += (l.qty || 0); }
    const rows = Object.entries(m).map(([key, v]) => ({ key, value: metric === 'units' ? v.units : v.sales })).sort((a, b) => b.value - a.value);
    return res.json({ groupBy, metric: metric === 'units' ? 'units' : 'sales', range: { from, to }, rows });
  }
  const kf = keyFns[groupBy] || keyFns.employee;
  const m = {};
  for (const p of pays) { const k = kf(p); (m[k] ||= { sales: 0, orders: 0, tips: 0 }); m[k].sales = round(m[k].sales + payNet(p)); m[k].orders++; m[k].tips = round(m[k].tips + (p.tip || 0)); }
  const valueOf = v => metric === 'orders' ? v.orders : metric === 'avg' ? (v.orders ? round(v.sales / v.orders) : 0) : metric === 'tips' ? v.tips : v.sales;
  const rows = Object.entries(m).map(([key, v]) => ({ key, value: valueOf(v) })).sort((a, b) => b.value - a.value);
  res.json({ groupBy, metric, range: { from, to }, rows });
}));

// ---- delivery-platform integrations (DoorDash / Uber Eats / Grubhub / aggregators) ----
function requireIntegrationKey(req, res, next) {
  const key = process.env.INTEGRATION_API_KEY;
  if (!key) return res.status(503).json({ error: 'integrations not configured — set INTEGRATION_API_KEY' });
  if (req.headers['x-integration-key'] !== key) return res.status(401).json({ error: 'invalid integration key' });
  next();
}

// Shared: turn a normalized incoming order into a live Tavo order (+ payment for reporting).
async function createDeliveryOrder(norm, tenantId = DEFAULT_TENANT) {
  if (norm.externalId) {
    const existing = await store.findOrderByExternalId(norm.externalId, tenantId);
    if (existing) return { order: existing, duplicate: true };   // idempotent
  }
  const totals = priceLines(norm.lines);
  const count = await store.countOrders(tenantId);
  const order = {
    id: nanoid(10), number: 1000 + count + 1, table: null, lines: norm.lines, ...totals,
    status: 'cooking', channel: 'delivery', platform: norm.platform, customer: norm.customer,
    externalId: norm.externalId, tenantId, createdAt: Date.now(), firedAt: Date.now(),
  };
  await store.createOrder(order);
  await depleteForOrder(order, tenantId);   // delivery orders go straight to the kitchen
  // The platform already collected payment from the customer — record it so it shows in sales/reports by platform.
  await store.createPayment({
    id: nanoid(10), orderId: order.id, table: null, lines: norm.lines, ...totals,
    tip: 0, total: totals.total, method: norm.platform, status: 'succeeded', stripeId: null,
    confirmed: true, refundedAmount: 0, refundedAt: null, tenantId, createdAt: Date.now(),
  });
  return { order, duplicate: false };
}

// Webhook: external platforms / aggregators POST incoming orders here.
// The integration key can carry a tenant via the `x-tenant` header (defaults to 'default').
app.post('/api/integrations/orders', requireIntegrationKey, h(async (req, res) => {
  let norm;
  try { norm = normalizeIncoming(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  const { order, duplicate } = await createDeliveryOrder(norm, req.headers['x-tenant'] || DEFAULT_TENANT);
  res.status(duplicate ? 200 : 201).json({ received: true, duplicate, order });
}));

// Menu export for pushing to platforms/aggregators.
app.get('/api/integrations/menu', requireIntegrationKey, h(async (req, res) =>
  res.json(exportMenu(await store.listMenu(req.headers['x-tenant'] || DEFAULT_TENANT)))));

// Sandbox: a logged-in manager can simulate an incoming delivery order (no key needed).
app.post('/api/integrations/simulate', requireAuth, requireRole('manager'), h(async (req, res) => {
  const platform = String(req.body.platform || 'doordash');
  const menu = (await store.listMenu(tid(req))).filter(m => m.active !== false);
  if (!menu.length) return res.status(400).json({ error: 'no menu items to build a test order' });
  const pick = () => menu[Math.floor(Math.random() * menu.length)];
  const lines = [pick(), pick()].map(it => ({ name: it.name, price: it.price, qty: 1 + Math.floor(Math.random() * 2), mods: [] }));
  const names = ['Alex R.', 'Sam P.', 'Jordan L.', 'Riley C.', 'Casey W.', 'Morgan D.'];
  const norm = {
    platform, externalId: platform + '_' + Date.now(),
    customer: names[Math.floor(Math.random() * names.length)] + ' (delivery)', lines,
  };
  const { order } = await createDeliveryOrder(norm, tid(req));
  res.status(201).json({ simulated: true, order });
}));

// ---- Z report (end-of-day close-out) ----
app.get('/api/reports/zreport', requireAuth, requireRole('manager'), h(async (req, res) => {
  const d = req.query.date ? new Date(req.query.date + 'T00:00:00') : new Date();
  if (isNaN(d)) return res.status(400).json({ error: 'invalid date' });
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const inDay = t => t != null && t >= start && t < end;

  const pays = (await store.listPayments(tid(req))).filter(p => inDay(p.createdAt));
  const orders = (await store.listOrders(undefined, tid(req))).filter(o => inDay(o.createdAt));

  const sum = (arr, f) => round(arr.reduce((a, x) => a + (f(x) || 0), 0));
  const gross = sum(pays, p => p.total);
  const refunds = sum(pays, p => p.refundedAmount);
  const net = round(gross - refunds);
  const tax = sum(pays, p => p.tax);
  const tips = sum(pays, p => p.tip);
  const subtotalSales = sum(pays, p => p.subtotal);
  const count = pays.length;
  const avgCheck = count ? round(gross / count) : 0;

  const byMethod = {};
  pays.forEach(p => { byMethod[p.method] = round((byMethod[p.method] || 0) + p.total); });

  const itemCounts = {};
  pays.forEach(p => (p.lines || []).forEach(l => { itemCounts[l.name] = (itemCounts[l.name] || 0) + (l.qty || 0); }));
  const topSellers = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const itemsSold = Object.values(itemCounts).reduce((a, c) => a + c, 0);

  const voids = orders.filter(o => o.status === 'voided').length;
  const refundCount = pays.filter(p => (p.refundedAmount || 0) > 0).length;

  res.json({
    date: new Date(start).toISOString().slice(0, 10),
    subtotalSales, tax, tips, gross, refunds, refundCount, net,
    count, avgCheck, itemsSold, voids, byMethod, topSellers,
    generatedAt: Date.now(),
  });
}));

// ---- inventory (stock + ingredients) ----
app.get('/api/inventory', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listInventory(tid(req)))));

app.post('/api/inventory', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { name, unit, qty, parLevel, cost } = req.body;
  if (!name) return res.status(400).json({ error: 'ingredient name required' });
  const item = {
    id: nanoid(8), name: String(name), unit: unit || 'unit',
    qty: Number(qty) || 0, parLevel: Number(parLevel) || 0, cost: Number(cost) || 0,
    tenantId: tid(req),
  };
  await store.createInventoryItem(item);
  res.status(201).json(item);
}));

app.put('/api/inventory/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const patch = {};
  for (const k of ['name', 'unit', 'qty', 'parLevel', 'cost'])
    if (req.body[k] != null) patch[k] = k === 'name' || k === 'unit' ? String(req.body[k]) : Number(req.body[k]);
  const out = await store.updateInventoryItem(req.params.id, patch);
  out ? res.json(out) : res.status(404).json({ error: 'not found' });
}));

// Quick stock movement: receive a delivery (+) or record waste/usage (−).
app.post('/api/inventory/:id/adjust', requireAuth, requireRole('manager'), h(async (req, res) => {
  const delta = Number(req.body.delta);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'delta must be a number' });
  const out = await store.adjustInventory(req.params.id, delta);
  out ? res.json(out) : res.status(404).json({ error: 'not found' });
}));

app.delete('/api/inventory/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  await store.deleteInventoryItem(req.params.id);
  res.status(204).end();
}));

// ============================================================================
//  Purchasing — vendors, purchase orders, receiving stock
// ============================================================================

// ---- vendors / suppliers ----
app.get('/api/vendors', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listVendors(tid(req)))));
app.post('/api/vendors', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { name, contact, email, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'vendor name required' });
  const v = { id: nanoid(8), name: String(name).slice(0, 80), contact: contact ? String(contact) : '', email: email ? String(email) : '', phone: phone ? String(phone) : '', notes: notes ? String(notes).slice(0, 300) : '', tenantId: tid(req), createdAt: Date.now() };
  await store.createVendor(v);
  res.status(201).json(v);
}));
app.put('/api/vendors/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const cur = await store.getVendor(req.params.id);
  if (!cur || (cur.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const patch = {};
  for (const k of ['name', 'contact', 'email', 'phone', 'notes']) if (req.body[k] != null) patch[k] = String(req.body[k]);
  res.json(await store.updateVendor(req.params.id, patch));
}));
app.delete('/api/vendors/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const cur = await store.getVendor(req.params.id);
  if (!cur || (cur.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  await store.deleteVendor(req.params.id);
  res.status(204).end();
}));

// ---- discount presets + scheduled (happy-hour) discounts ----
// Managers define presets; any staff can read the ones active right now so the
// POS can auto-apply a happy-hour discount during its window.
app.get('/api/discounts', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listDiscountPresets(tid(req)))));

// Presets active at this moment (auto-apply + scheduled window matches now), highest value first.
// Optional ?subtotal= returns the computed dollar amount for each.
app.get('/api/discounts/active', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const now = new Date();
  const sub = Number(req.query.subtotal) || 0;
  const active = (await store.listDiscountPresets(tid(req)))
    .filter(d => d.active && d.autoApply && discountInWindow(d.schedule, now))
    .map(d => ({ ...d, amount: sub > 0 ? discountAmountFor(d, sub) : undefined }))
    .sort((a, b) => (b.amount ?? b.value) - (a.amount ?? a.value));
  res.json(active);
}));

app.post('/api/discounts', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { name, kind = 'percent', value, reason, autoApply = false, active = true, schedule } = req.body;
  if (!name) return res.status(400).json({ error: 'discount name required' });
  const k = kind === 'amount' ? 'amount' : 'percent';
  const v = Math.max(0, Number(value) || 0);
  if (k === 'percent' && v > 100) return res.status(400).json({ error: 'percent cannot exceed 100' });
  const sched = cleanSchedule(schedule);
  const d = {
    id: nanoid(8), name: String(name).slice(0, 60), kind: k, value: v,
    reason: reason ? String(reason).slice(0, 60) : (name ? String(name).slice(0, 60) : 'Discount'),
    scope: 'check', schedule: sched, autoApply: !!autoApply && !!sched, active: !!active,
    tenantId: tid(req), createdAt: Date.now(),
  };
  await store.createDiscountPreset(d);
  res.status(201).json(d);
}));

app.put('/api/discounts/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const cur = await store.getDiscountPreset(req.params.id);
  if (!cur || (cur.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const patch = {};
  if (req.body.name != null) patch.name = String(req.body.name).slice(0, 60);
  if (req.body.kind != null) patch.kind = req.body.kind === 'amount' ? 'amount' : 'percent';
  if (req.body.value != null) patch.value = Math.max(0, Number(req.body.value) || 0);
  if (req.body.reason != null) patch.reason = String(req.body.reason).slice(0, 60);
  if (req.body.active != null) patch.active = !!req.body.active;
  if ('schedule' in req.body) patch.schedule = cleanSchedule(req.body.schedule);
  if (req.body.autoApply != null) patch.autoApply = !!req.body.autoApply;
  // autoApply only valid with a schedule
  const sched = 'schedule' in patch ? patch.schedule : cur.schedule;
  if (!sched) patch.autoApply = false;
  const kind = patch.kind || cur.kind;
  const value = patch.value != null ? patch.value : cur.value;
  if (kind === 'percent' && value > 100) return res.status(400).json({ error: 'percent cannot exceed 100' });
  res.json(await store.updateDiscountPreset(req.params.id, patch));
}));

app.delete('/api/discounts/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const cur = await store.getDiscountPreset(req.params.id);
  if (!cur || (cur.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  await store.deleteDiscountPreset(req.params.id);
  res.status(204).end();
}));

// ---- purchase orders ----
const poTotal = lines => round((lines || []).reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0));

app.get('/api/purchase-orders', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listPurchaseOrders(tid(req)))));
app.get('/api/purchase-orders/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const po = await store.getPurchaseOrder(req.params.id);
  (po && (po.tenantId || DEFAULT_TENANT) === tid(req)) ? res.json(po) : res.status(404).json({ error: 'not found' });
}));
app.post('/api/purchase-orders', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { vendorId = null, status = 'ordered', lines = [], notes = '' } = req.body;
  if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'at least one line item required' });
  let vendorName = '';
  if (vendorId) { const v = await store.getVendor(vendorId); if (v && (v.tenantId || DEFAULT_TENANT) === tid(req)) vendorName = v.name; }
  const clean = lines.map(l => ({ productId: l.productId || null, name: String(l.name || 'Item'), sku: l.sku || null, qty: Number(l.qty) || 0, cost: Number(l.cost) || 0 }));
  const po = { id: nanoid(8), vendorId, vendorName, status: status === 'draft' ? 'draft' : 'ordered', lines: clean, total: poTotal(clean), notes: String(notes).slice(0, 300), receivedAt: null, tenantId: tid(req), createdAt: Date.now() };
  await store.createPurchaseOrder(po);
  res.status(201).json(po);
}));
app.put('/api/purchase-orders/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const po = await store.getPurchaseOrder(req.params.id);
  if (!po || (po.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  if (po.status === 'received') return res.status(400).json({ error: 'received POs are locked' });
  const patch = {};
  if (Array.isArray(req.body.lines)) { patch.lines = req.body.lines.map(l => ({ productId: l.productId || null, name: String(l.name || 'Item'), sku: l.sku || null, qty: Number(l.qty) || 0, cost: Number(l.cost) || 0 })); patch.total = poTotal(patch.lines); }
  if (req.body.notes != null) patch.notes = String(req.body.notes).slice(0, 300);
  if (req.body.status && ['draft', 'ordered', 'cancelled'].includes(req.body.status)) patch.status = req.body.status;
  res.json(await store.updatePurchaseOrder(req.params.id, patch));
}));

// Receive a PO: mark received and add each line's qty to the linked product's stock.
app.post('/api/purchase-orders/:id/receive', requireAuth, requireRole('manager'), h(async (req, res) => {
  const po = await store.getPurchaseOrder(req.params.id);
  if (!po || (po.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  if (po.status === 'received') return res.status(400).json({ error: 'already received' });
  let stocked = 0;
  for (const l of po.lines || []) {
    if (l.productId && (Number(l.qty) || 0) > 0) { const p = await store.adjustMenuStock(l.productId, Number(l.qty)); if (p) stocked++; }
  }
  const out = await store.updatePurchaseOrder(req.params.id, { status: 'received', receivedAt: Date.now() });
  res.json({ ...out, stockedLines: stocked });
}));

// ============================================================================
//  Stocktakes / cycle counts
// ============================================================================
app.get('/api/stocktakes', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listStocktakes(tid(req)))));
app.get('/api/stocktakes/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const s = await store.getStocktake(req.params.id);
  (s && (s.tenantId || DEFAULT_TENANT) === tid(req)) ? res.json(s) : res.status(404).json({ error: 'not found' });
}));

// Start a count: snapshot the current tracked products as the expected on-hand.
app.post('/api/stocktakes', requireAuth, requireRole('manager'), h(async (req, res) => {
  const products = (await store.listMenu(tid(req))).filter(p => p.trackStock);
  if (products.length === 0) return res.status(400).json({ error: 'no stock-tracked products to count' });
  const counts = products.map(p => ({ productId: p.id, name: p.name, sku: p.sku || null, expected: Number(p.stock) || 0, counted: null, variance: null }));
  const s = { id: nanoid(8), name: String(req.body.name || `Count ${new Date().toLocaleDateString()}`).slice(0, 80), status: 'open', counts, tenantId: tid(req), createdAt: Date.now(), closedAt: null };
  await store.createStocktake(s);
  res.status(201).json(s);
}));

// Save entered counts (partial allowed) without applying.
app.put('/api/stocktakes/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const s = await store.getStocktake(req.params.id);
  if (!s || (s.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  if (s.status === 'closed') return res.status(400).json({ error: 'count already applied' });
  const entered = new Map((req.body.counts || []).map(c => [c.productId, c.counted]));
  const counts = s.counts.map(c => entered.has(c.productId) && entered.get(c.productId) !== null && entered.get(c.productId) !== ''
    ? { ...c, counted: Number(entered.get(c.productId)) } : c);
  res.json(await store.updateStocktake(req.params.id, { counts }));
}));

// Apply the count: set each product's stock to its counted value, record variance, close.
app.post('/api/stocktakes/:id/apply', requireAuth, requireRole('manager'), h(async (req, res) => {
  const s = await store.getStocktake(req.params.id);
  if (!s || (s.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  if (s.status === 'closed') return res.status(400).json({ error: 'already applied' });
  let adjusted = 0; const counts = [];
  for (const c of s.counts) {
    if (c.counted == null) { counts.push(c); continue; }
    const cur = (await store.listMenu(tid(req))).find(p => p.id === c.productId);
    const expected = cur ? (Number(cur.stock) || 0) : (Number(c.expected) || 0);
    const delta = Number(c.counted) - expected;
    if (cur && delta !== 0) { await store.adjustMenuStock(c.productId, delta); adjusted++; }
    counts.push({ ...c, expected, variance: round(Number(c.counted) - expected) });
  }
  const out = await store.updateStocktake(req.params.id, { counts, status: 'closed', closedAt: Date.now() });
  res.json({ ...out, adjustedProducts: adjusted });
}));

// ============================================================================
//  Reservations + waitlist
// ============================================================================
const RESV_STATUS = ['booked', 'waiting', 'seated', 'cancelled', 'noshow', 'done'];

app.get('/api/reservations', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  let list = await store.listReservations(tid(req));
  if (req.query.kind) list = list.filter(r => r.kind === req.query.kind);
  res.json(list);
}));

app.post('/api/reservations', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const { kind = 'reservation', name, phone, partySize, time, quotedWait, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'guest name required' });
  if (kind === 'reservation' && !time) return res.status(400).json({ error: 'reservation time required' });
  const r = {
    id: nanoid(8), kind: kind === 'waitlist' ? 'waitlist' : 'reservation',
    name: String(name).slice(0, 60), phone: phone ? String(phone) : '',
    partySize: Math.max(1, Math.round(Number(partySize) || 1)),
    time: kind === 'reservation' ? Number(time) : null,
    quotedWait: kind === 'waitlist' ? Math.max(0, Math.round(Number(quotedWait) || 0)) : null,
    status: kind === 'waitlist' ? 'waiting' : 'booked', tableNumber: null,
    notes: notes ? String(notes).slice(0, 200) : '', tenantId: tid(req), createdAt: Date.now(), seatedAt: null,
  };
  await store.createReservation(r);
  res.status(201).json(r);
}));

app.put('/api/reservations/:id', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const cur = await store.getReservation(req.params.id);
  if (!cur || (cur.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const patch = {};
  for (const k of ['name', 'phone', 'notes']) if (req.body[k] != null) patch[k] = String(req.body[k]).slice(0, 200);
  if (req.body.partySize != null) patch.partySize = Math.max(1, Math.round(Number(req.body.partySize) || 1));
  if (req.body.time != null) patch.time = Number(req.body.time);
  if (req.body.quotedWait != null) patch.quotedWait = Math.max(0, Math.round(Number(req.body.quotedWait) || 0));
  res.json(await store.updateReservation(req.params.id, patch));
}));

// Seat a party: assign a table, mark seated, flag the table occupied on the floor.
app.post('/api/reservations/:id/seat', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const cur = await store.getReservation(req.params.id);
  if (!cur || (cur.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  if (['seated', 'cancelled', 'noshow', 'done'].includes(cur.status)) return res.status(400).json({ error: `already ${cur.status}` });
  const tableNumber = req.body.tableNumber != null ? Math.round(Number(req.body.tableNumber)) : null;
  if (tableNumber != null) { try { await store.setTableStatus(tableNumber, 'seated', null, tid(req)); } catch { /* table may not exist */ } }
  res.json(await store.updateReservation(req.params.id, { status: 'seated', tableNumber, seatedAt: Date.now() }));
}));

// Update status (cancel / no-show / done).
app.post('/api/reservations/:id/status', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const cur = await store.getReservation(req.params.id);
  if (!cur || (cur.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const status = String(req.body.status || '');
  if (!RESV_STATUS.includes(status)) return res.status(400).json({ error: 'invalid status' });
  res.json(await store.updateReservation(req.params.id, { status }));
}));

// ============================================================================
//  House accounts + invoicing (charge now, pay later)
// ============================================================================
app.get('/api/house-accounts', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listHouseAccounts(tid(req)))));
app.get('/api/house-accounts/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const a = await store.getHouseAccount(req.params.id);
  if (!a || (a.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const invoices = (await store.listInvoices(tid(req))).filter(i => i.accountId === a.id);
  res.json({ ...a, invoices, available: round((a.creditLimit || 0) - (a.balance || 0)) });
}));
app.post('/api/house-accounts', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { name, contact, email, phone, creditLimit } = req.body;
  if (!name) return res.status(400).json({ error: 'account name required' });
  const a = { id: nanoid(8), name: String(name).slice(0, 80), contact: contact ? String(contact) : '', email: email ? String(email) : '', phone: phone ? String(phone) : '', creditLimit: Math.max(0, Number(creditLimit) || 0), balance: 0, tenantId: tid(req), createdAt: Date.now() };
  await store.createHouseAccount(a);
  res.status(201).json(a);
}));
app.put('/api/house-accounts/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const cur = await store.getHouseAccount(req.params.id);
  if (!cur || (cur.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const patch = {};
  for (const k of ['name', 'contact', 'email', 'phone']) if (req.body[k] != null) patch[k] = String(req.body[k]);
  if (req.body.creditLimit != null) patch.creditLimit = Math.max(0, Number(req.body.creditLimit) || 0);
  res.json(await store.updateHouseAccount(req.params.id, patch));
}));

// Charge an amount to an account: raises the balance (within credit limit) and opens an invoice.
app.post('/api/house-accounts/:id/charge', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const a = await store.getHouseAccount(req.params.id);
  if (!a || (a.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const { amount, lines = [], notes = '', dueDate = null } = req.body;
  const amt = round(Number(amount) || (Array.isArray(lines) ? priceLines(lines).total : 0));
  if (!(amt > 0)) return res.status(400).json({ error: 'charge amount required' });
  const limit = a.creditLimit || 0;
  if (limit > 0 && (a.balance || 0) + amt > limit + 1e-9) return res.status(400).json({ error: `over credit limit — available ${(limit - a.balance).toFixed(2)}` });
  const invoice = { id: nanoid(8), accountId: a.id, accountName: a.name, lines: Array.isArray(lines) ? lines : [], total: amt, status: 'open', dueDate: dueDate ? Number(dueDate) : null, notes: String(notes).slice(0, 200), tenantId: tid(req), createdAt: Date.now(), paidAt: null };
  await store.createInvoice(invoice);
  const updated = await store.updateHouseAccount(a.id, { balance: round((a.balance || 0) + amt) });
  res.status(201).json({ invoice, account: updated });
}));

app.get('/api/invoices', requireAuth, requireRole('manager'), h(async (req, res) => {
  let list = await store.listInvoices(tid(req));
  if (req.query.accountId) list = list.filter(i => i.accountId === req.query.accountId);
  if (req.query.status) list = list.filter(i => i.status === req.query.status);
  res.json(list);
}));

// Pay an invoice: closes it and lowers the account balance.
app.post('/api/invoices/:id/pay', requireAuth, requireRole('manager'), h(async (req, res) => {
  const inv = await store.getInvoice(req.params.id);
  if (!inv || (inv.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  if (inv.status === 'paid') return res.status(400).json({ error: 'already paid' });
  const a = await store.getHouseAccount(inv.accountId);
  if (a) await store.updateHouseAccount(a.id, { balance: round(Math.max(0, (a.balance || 0) - (inv.total || 0))) });
  const out = await store.updateInvoice(inv.id, { status: 'paid', paidAt: Date.now() });
  res.json(out);
}));

// ============================================================================
//  Customer-facing display — the POS pushes the live cart; a second screen polls it.
//  State is ephemeral (in-memory, per tenant) — exactly what a counter display needs.
// ============================================================================
const displayState = new Map();   // tenantId -> { lines, subtotal, tax, total, message, updatedAt }

// POS pushes the current check (or a thank-you/idle message).
app.post('/api/display', requireAuth, h(async (req, res) => {
  const { lines = [], subtotal = 0, tax = 0, total = 0, message = null } = req.body;
  displayState.set(tid(req), {
    lines: Array.isArray(lines) ? lines.slice(0, 60).map(l => ({ name: String(l.name || ''), qty: Number(l.qty) || 0, price: Number(l.price) || 0 })) : [],
    subtotal: round(Number(subtotal) || 0), tax: round(Number(tax) || 0), total: round(Number(total) || 0),
    message: message ? String(message).slice(0, 120) : null, updatedAt: Date.now(),
  });
  res.json({ ok: true });
}));

// The display device polls this (public — no login on the customer screen).
app.get('/api/display', h(async (req, res) => {
  const t = await resolveTenant(req.query.tenant);
  if (!t) return res.status(404).json({ error: 'unknown business' });
  const s = displayState.get(t.id) || { lines: [], subtotal: 0, tax: 0, total: 0, message: null, updatedAt: 0 };
  res.json({ business: t.name, ...s, checkout: checkoutState.get(t.id) || null });
}));

// ----------------------------------------------------------------------------
//  Interactive dual-screen checkout (Clover-Duo style): the customer screen
//  guides the guest through tip → pay → receipt, posting choices back to the POS.
// ----------------------------------------------------------------------------
const checkoutState = new Map();   // tenantId -> { sessionId, phase, baseTotal, tip, receipt, ... }

// POS starts a customer-screen checkout. Returns the sessionId to poll.
app.post('/api/display/checkout', requireAuth, h(async (req, res) => {
  const { lines = [], subtotal = 0, tax = 0, total = 0, tipPresets } = req.body;
  const presets = Array.isArray(tipPresets) && tipPresets.length
    ? tipPresets.map(n => Math.max(0, Number(n) || 0)).slice(0, 4)
    : [0.18, 0.20, 0.25];
  const session = {
    sessionId: nanoid(10), phase: 'tip',
    lines: (Array.isArray(lines) ? lines : []).slice(0, 60).map(l => ({ name: String(l.name || ''), qty: Number(l.qty) || 0, price: Number(l.price) || 0 })),
    subtotal: round(Number(subtotal) || 0), tax: round(Number(tax) || 0),
    baseTotal: round(Number(total) || 0), tipPresets: presets,
    tip: null, receipt: null, contact: null, message: null, updatedAt: Date.now(),
  };
  checkoutState.set(tid(req), session);
  res.status(201).json(session);
}));

// POS advances the session (approved / declined / done / idle) after processing.
app.post('/api/display/checkout/advance', requireAuth, h(async (req, res) => {
  const cur = checkoutState.get(tid(req));
  const { sessionId, phase, message } = req.body;
  if (!cur || cur.sessionId !== sessionId) return res.status(409).json({ error: 'no matching active checkout' });
  if (!['approved', 'declined', 'done', 'idle', 'await_card'].includes(phase)) return res.status(400).json({ error: 'bad phase' });
  if (phase === 'idle') { checkoutState.delete(tid(req)); return res.json({ ok: true, cleared: true }); }
  cur.phase = phase; cur.message = message ? String(message).slice(0, 120) : cur.message; cur.updatedAt = Date.now();
  res.json(cur);
}));

// The customer screen posts the guest's choices back (public — scoped by session).
app.post('/api/display/respond', h(async (req, res) => {
  const t = await resolveTenant(req.body.tenant);
  if (!t) return res.status(404).json({ error: 'unknown business' });
  const cur = checkoutState.get(t.id);
  if (!cur || cur.sessionId !== req.body.sessionId) return res.status(409).json({ error: 'no matching active checkout' });
  if (req.body.tip != null && cur.phase === 'tip') {
    cur.tip = Math.max(0, round(Number(req.body.tip) || 0));
    cur.phase = 'await_card';   // POS picks this up to charge the card / terminal
  }
  if (req.body.receipt != null && (cur.phase === 'approved')) {
    const r = String(req.body.receipt);
    if (['email', 'sms', 'print', 'none'].includes(r)) {
      cur.receipt = r;
      cur.contact = req.body.contact ? String(req.body.contact).slice(0, 120) : null;
    }
  }
  cur.updatedAt = Date.now();
  res.json({ ok: true, phase: cur.phase });
}));

// ============================================================================
//  Multi-location — a registry of sites + a consolidated cross-site roll-up
// ============================================================================
app.get('/api/locations', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listLocations(tid(req)))));
app.post('/api/locations', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { name, address, slug } = req.body;
  if (!name) return res.status(400).json({ error: 'location name required' });
  if (!slug) return res.status(400).json({ error: 'business slug required' });
  const t = await resolveTenant(slug);
  if (!t) return res.status(404).json({ error: 'no business with that slug — create it via signup first' });
  const l = { id: nanoid(8), name: String(name).slice(0, 80), address: address ? String(address).slice(0, 160) : '', slug: t.slug, tenantId: tid(req), createdAt: Date.now() };
  await store.createLocation(l);
  res.status(201).json(l);
}));
app.put('/api/locations/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const cur = await store.getLocation(req.params.id);
  if (!cur || (cur.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const patch = {};
  for (const k of ['name', 'address']) if (req.body[k] != null) patch[k] = String(req.body[k]);
  if (req.body.slug) { const t = await resolveTenant(req.body.slug); if (!t) return res.status(404).json({ error: 'unknown slug' }); patch.slug = t.slug; }
  res.json(await store.updateLocation(req.params.id, patch));
}));
app.delete('/api/locations/:id', requireAuth, requireRole('manager'), h(async (req, res) => {
  const cur = await store.getLocation(req.params.id);
  if (!cur || (cur.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  await store.deleteLocation(req.params.id);
  res.status(204).end();
}));

// Consolidated roll-up: net sales / orders / tax per registered site + combined totals.
app.get('/api/locations/rollup', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { from, to } = defaultRange(req.query);
  const locs = await store.listLocations(tid(req));
  const rows = [];
  for (const l of locs) {
    const t = await resolveTenant(l.slug);
    let net = 0, orders = 0, tax = 0;
    if (t) {
      const pays = (await store.listPayments(t.id)).filter(p => p.status !== 'voided' && (p.createdAt || 0) >= from && (p.createdAt || 0) < to);
      net = round(pays.reduce((a, p) => a + ((p.total || 0) - (p.refundedAmount || 0)), 0));
      tax = round(pays.reduce((a, p) => a + (p.tax || 0), 0));
      orders = pays.length;
    }
    rows.push({ id: l.id, name: l.name, address: l.address, slug: l.slug, netSales: net, orders, tax, avgCheck: orders ? round(net / orders) : 0 });
  }
  rows.sort((a, b) => b.netSales - a.netSales);
  const combined = {
    netSales: round(rows.reduce((a, r) => a + r.netSales, 0)),
    orders: rows.reduce((a, r) => a + r.orders, 0),
    tax: round(rows.reduce((a, r) => a + r.tax, 0)),
  };
  combined.avgCheck = combined.orders ? round(combined.netSales / combined.orders) : 0;
  res.json({ range: { from, to }, locations: rows, combined });
}));

// ---- loyalty config ----
app.get('/api/loyalty/config', requireAuth, (req, res) =>
  res.json({ earnRate: LOYALTY_EARN, redeemRate: LOYALTY_REDEEM }));

// ---- customers (loyalty members) ----
app.get('/api/customers', requireAuth, h(async (req, res) => res.json(await store.listCustomers(tid(req)))));

// Look up a member by phone (to attach to a check). Returns the customer or null.
app.get('/api/customers/lookup', requireAuth, h(async (req, res) => {
  if (!req.query.phone) return res.status(400).json({ error: 'phone required' });
  res.json(await store.findCustomerByPhone(req.query.phone, tid(req)));
}));

app.post('/api/customers', requireAuth, h(async (req, res) => {
  const { name, phone, email, notes, marketingOptIn } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const existing = await store.findCustomerByPhone(phone, tid(req));
  if (existing) return res.json(existing);   // idempotent — return the existing member
  const c = {
    id: nanoid(10), name: (name || 'Guest').toString().slice(0, 60), phone: String(phone),
    email: email ? String(email).slice(0, 120) : null, notes: notes ? String(notes).slice(0, 500) : '',
    marketingOptIn: marketingOptIn !== false, points: 0, visits: 0, totalSpent: 0,
    tenantId: tid(req), createdAt: Date.now(),
  };
  await store.createCustomer(c);
  res.status(201).json(c);
}));

// Full customer profile: contact, lifetime stats, and recent order/payment history.
app.get('/api/customers/:id', requireAuth, h(async (req, res) => {
  const c = await store.getCustomer(req.params.id);
  if (!c || (c.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const pays = (await store.listPayments(tid(req))).filter(p => p.customerId === c.id || p.customer === c.id);
  const history = pays.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 25)
    .map(p => ({ id: p.id, total: p.total, method: p.method, status: p.status, createdAt: p.createdAt }));
  const lifetime = pays.filter(p => p.status !== 'voided').reduce((s, p) => s + ((p.total || 0) - (p.refundedAmount || 0)), 0);
  res.json({ ...c, history, lifetimeSpend: Math.round(lifetime * 100) / 100, orderCount: history.length });
}));

app.put('/api/customers/:id', requireAuth, h(async (req, res) => {
  const c = await store.getCustomer(req.params.id);
  if (!c || (c.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'not found' });
  const patch = {};
  for (const k of ['name', 'phone', 'email', 'notes']) if (req.body[k] != null) patch[k] = String(req.body[k]).slice(0, 500);
  if (req.body.marketingOptIn != null) patch.marketingOptIn = req.body.marketingOptIn !== false;
  const out = await store.updateCustomer(req.params.id, patch);
  out ? res.json(out) : res.status(404).json({ error: 'not found' });
}));

// Manual points adjustment (manager) — comps, corrections, promos.
app.post('/api/customers/:id/points', requireAuth, requireRole('manager'), h(async (req, res) => {
  const c = await store.getCustomer(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const delta = Math.round(Number(req.body.delta) || 0);
  const points = Math.max(0, (c.points || 0) + delta);
  res.json(await store.updateCustomer(c.id, { points }));
}));

// ============================================================================
//  CRM messaging — digital receipts + email/SMS marketing campaigns
// ============================================================================

// Channel/provider status (simulated vs live) for the UI to show.
app.get('/api/messaging/status', requireAuth, (req, res) => res.json(messagingMode()));

// Render a plain-text receipt for a payment.
function receiptText(p, businessName) {
  const L = [];
  L.push(businessName || 'Tavo');
  L.push('Receipt #' + p.id);
  L.push(new Date(p.createdAt || Date.now()).toLocaleString());
  L.push('—'.repeat(24));
  (p.lines || []).forEach(l => L.push(`${l.qty || 1}x ${l.name}  ${money(((l.price || 0) * (l.qty || 1)))}`));
  L.push('—'.repeat(24));
  if (p.discount) L.push('Discount  -' + money(p.discount));
  if (p.serviceCharge) L.push('Service   ' + money(p.serviceCharge));
  L.push('Subtotal  ' + money(p.subtotal || 0));
  L.push('Tax       ' + money(p.tax || 0));
  if (p.tip) L.push('Tip       ' + money(p.tip));
  L.push('Total     ' + money(p.total || 0));
  L.push('');
  L.push('Thank you!');
  return L.join('\n');
}
function money(n) { return '$' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2); }

// Send a digital receipt for a payment over email or SMS.
app.post('/api/receipts/send', requireAuth, h(async (req, res) => {
  const { paymentId, channel = 'email', to } = req.body;
  if (!['email', 'sms'].includes(channel)) return res.status(400).json({ error: 'channel must be email or sms' });
  const pay = await store.getPayment(paymentId);
  if (!pay || (pay.tenantId || DEFAULT_TENANT) !== tid(req)) return res.status(404).json({ error: 'payment not found' });
  // Resolve recipient: explicit `to`, else the attached customer's contact.
  let dest = to, customerId = pay.customerId || null;
  if (!dest && customerId) { const c = await store.getCustomer(customerId); dest = c ? (channel === 'email' ? c.email : c.phone) : null; }
  const bad = validateRecipient(channel, dest);
  if (bad) return res.status(400).json({ error: bad });
  const t = await store.getTenant(tid(req));
  const subject = `Your receipt from ${(t && t.name) || 'Tavo'}`;
  const body = receiptText(pay, t && t.name);
  const r = await deliver({ channel, to: dest, subject, body });
  const msg = { id: nanoid(10), channel, kind: 'receipt', to: dest, customerId, campaignId: null, subject, body, status: r.status, error: r.error || null, tenantId: tid(req), createdAt: Date.now() };
  await store.createMessage(msg);
  r.ok ? res.status(201).json(msg) : res.status(502).json({ error: r.error || 'send failed', message: msg });
}));

// Resolve a marketing segment to an opted-in, contactable recipient list.
function resolveSegment(customers, segment, channel) {
  const now = Date.now(), DAY = 86400000;
  const contact = c => channel === 'email' ? c.email : c.phone;
  return customers.filter(c => {
    if (c.marketingOptIn === false) return false;
    if (validateRecipient(channel, contact(c))) return false;   // must have a valid address
    if (segment === 'loyalty') return (c.points || 0) > 0;
    if (segment === 'vip') return (c.totalSpent || 0) >= 100;
    if (segment === 'new') return (now - (c.createdAt || 0)) <= 30 * DAY;
    return true;   // 'all'
  });
}

// Preview how many recipients a segment/channel would reach.
app.get('/api/marketing/segments', requireAuth, requireRole('manager'), h(async (req, res) => {
  const customers = await store.listCustomers(tid(req));
  const out = {};
  for (const ch of ['email', 'sms']) {
    out[ch] = {};
    for (const seg of ['all', 'loyalty', 'vip', 'new']) out[ch][seg] = resolveSegment(customers, seg, ch).length;
  }
  res.json({ totalCustomers: customers.length, reach: out });
}));

// Launch a marketing campaign: resolve the segment, deliver each message, log it all.
app.post('/api/marketing/campaign', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { name = 'Campaign', channel = 'email', segment = 'all', subject = '', body = '' } = req.body;
  if (!['email', 'sms'].includes(channel)) return res.status(400).json({ error: 'channel must be email or sms' });
  if (!String(body).trim()) return res.status(400).json({ error: 'message body required' });
  if (channel === 'email' && !String(subject).trim()) return res.status(400).json({ error: 'subject required for email' });
  const customers = await store.listCustomers(tid(req));
  const recipients = resolveSegment(customers, segment, channel);
  if (recipients.length === 0) return res.status(400).json({ error: 'no opted-in recipients match that segment/channel' });

  const campaign = { id: nanoid(10), name: String(name).slice(0, 80), channel, segment, subject: String(subject).slice(0, 160), body: String(body).slice(0, 1000), recipients: recipients.length, sent: 0, failed: 0, tenantId: tid(req), createdAt: Date.now() };
  await store.createCampaign(campaign);

  let sent = 0, failed = 0;
  for (const c of recipients) {
    const dest = channel === 'email' ? c.email : c.phone;
    const r = await deliver({ channel, to: dest, subject: campaign.subject, body: campaign.body });
    await store.createMessage({ id: nanoid(10), channel, kind: 'marketing', to: dest, customerId: c.id, campaignId: campaign.id, subject: campaign.subject, body: campaign.body, status: r.status, error: r.error || null, tenantId: tid(req), createdAt: Date.now() });
    r.ok ? sent++ : failed++;
  }
  const out = await store.updateCampaign(campaign.id, { sent, failed });
  res.status(201).json(out || { ...campaign, sent, failed });
}));

app.get('/api/marketing/campaigns', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listCampaigns(tid(req)))));

// The message log (receipts + marketing sends), newest first.
app.get('/api/messages', requireAuth, requireRole('manager'), h(async (req, res) => res.json((await store.listMessages(tid(req))).slice(0, 200))));

// ---- gift cards ----
function genGiftCode() {
  const a = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TAVO-${a()}-${a()}`;
}
app.get('/api/giftcards', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listGiftCards(tid(req)))));

// Issue (sell) a gift card loaded with `amount`. The card balance is a liability,
// counted as revenue only when later spent on an order — so no sale is recorded here.
app.post('/api/giftcards', requireAuth, h(async (req, res) => {
  const amount = round(Number(req.body.amount));
  if (!(amount > 0)) return res.status(400).json({ error: 'load amount must be positive' });
  let code = (req.body.code ? String(req.body.code) : genGiftCode()).toUpperCase();
  if (await store.getGiftCardByCode(code, tid(req))) return res.status(409).json({ error: 'that code already exists' });
  const card = { id: nanoid(10), code, balance: amount, initialBalance: amount, active: true, tenantId: tid(req), createdAt: Date.now() };
  await store.createGiftCard(card);
  res.status(201).json(card);
}));

// Check a card's balance by code.
app.get('/api/giftcards/:code', requireAuth, h(async (req, res) => {
  const card = await store.getGiftCardByCode(req.params.code, tid(req));
  card ? res.json(card) : res.status(404).json({ error: 'gift card not found' });
}));

// Redeem (spend) up to `amount` from a card; returns the amount actually applied.
app.post('/api/giftcards/:code/redeem', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const card = await store.getGiftCardByCode(req.params.code, tid(req));
  if (!card) return res.status(404).json({ error: 'gift card not found' });
  if (card.active === false || card.balance <= 0) return res.status(400).json({ error: 'card has no balance' });
  let amount = req.body.amount == null ? card.balance : round(Number(req.body.amount));
  if (!(amount > 0)) return res.status(400).json({ error: 'amount must be positive' });
  const applied = Math.min(amount, card.balance);
  const balance = round(card.balance - applied);
  const updated = await store.updateGiftCard(card.id, { balance, active: balance > 0 });
  res.json({ applied, card: updated });
}));

// ---- Ask Tavo (natural-language business assistant) ----
app.get('/api/ask/suggestions', requireAuth, requireRole('manager'), h(async (req, res) => {
  const t = await store.getTenant(tid(req));
  res.json({ suggestions: askSuggestions((t && t.mode) || 'restaurant') });
}));

app.post('/api/ask', requireAuth, requireRole('manager'), h(async (req, res) => {
  const question = String(req.body.question || '');
  const t = await store.getTenant(tid(req));
  const [payments, orders, menu, inventory, customers, giftcards] = await Promise.all([
    store.listPayments(tid(req)), store.listOrders(undefined, tid(req)), store.listMenu(tid(req)),
    store.listInventory(tid(req)), store.listCustomers(tid(req)), store.listGiftCards(tid(req)),
  ]);
  const result = askTavo(question, {
    payments, orders, menu, inventory, customers, giftcards,
    taxRate: TAX_RATE, loyalty: { earnRate: LOYALTY_EARN, redeemRate: LOYALTY_REDEEM },
    mode: (t && t.mode) || 'restaurant',
  });
  res.json({ question, ...result });
}));

// ---- cash drawer management ----
// Live expected cash = starting float + cash sales during the session + paid-in − paid-out.
async function drawerState(d, tenantId) {
  if (!d) return null;
  const pays = await store.listPayments(tenantId);
  const end = d.closedAt || (Date.now() + 1);
  const cashSales = round(pays.filter(p => p.method === 'cash' && p.createdAt >= d.openedAt && p.createdAt < end).reduce((a, p) => a + (p.total || 0), 0));
  const expected = round((d.startingFloat || 0) + cashSales + (d.paidIn || 0) - (d.paidOut || 0));
  return { ...d, cashSales, expected };
}

app.get('/api/drawer', requireAuth, requireRole('manager', 'server'), h(async (req, res) => {
  const d = await store.getOpenDrawer(tid(req));
  res.json(d ? { open: true, drawer: await drawerState(d, tid(req)) } : { open: false });
}));

app.post('/api/drawer/open', requireAuth, requireRole('manager'), h(async (req, res) => {
  if (await store.getOpenDrawer(tid(req))) return res.status(409).json({ error: 'a drawer is already open — close it first' });
  const d = { id: nanoid(10), openedBy: req.user.name || 'Manager', openedAt: Date.now(), startingFloat: round(Number(req.body.startingFloat) || 0), paidIn: 0, paidOut: 0, status: 'open', tenantId: tid(req) };
  await store.createDrawer(d);
  res.status(201).json(await drawerState(d, tid(req)));
}));

// Paid in / paid out (e.g., petty cash, tips paid out, change drops).
app.post('/api/drawer/movement', requireAuth, requireRole('manager'), h(async (req, res) => {
  const d = await store.getOpenDrawer(tid(req));
  if (!d) return res.status(400).json({ error: 'no open drawer' });
  const amt = round(Math.abs(Number(req.body.amount) || 0));
  if (!(amt > 0)) return res.status(400).json({ error: 'amount must be positive' });
  const patch = req.body.type === 'out' ? { paidOut: round((d.paidOut || 0) + amt) } : { paidIn: round((d.paidIn || 0) + amt) };
  const out = await store.updateDrawer(d.id, patch);
  res.json(await drawerState(out, tid(req)));
}));

app.post('/api/drawer/close', requireAuth, requireRole('manager'), h(async (req, res) => {
  const d = await store.getOpenDrawer(tid(req));
  if (!d) return res.status(400).json({ error: 'no open drawer' });
  const state = await drawerState(d, tid(req));
  const counted = round(Number(req.body.counted) || 0);
  const variance = round(counted - state.expected);
  const out = await store.updateDrawer(d.id, { status: 'closed', closedBy: req.user.name || 'Manager', closedAt: Date.now(), expected: state.expected, counted, variance });
  res.json({ ...out, cashSales: state.cashSales, variance });
}));

app.get('/api/drawers', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listDrawers(tid(req)))));

// ---- time clock (shifts) ----
// Net paid hours for a shift, capping the open end at `end`.
function shiftHours(s, end = Date.now()) {
  const out = s.clockOut || end;
  return Math.max(0, (out - s.clockIn) / 3600000 - (s.breakMins || 0) / 60);
}

app.get('/api/shifts/me', requireAuth, h(async (req, res) => {
  const open = await store.getOpenShiftFor(req.user.id, tid(req));
  const mine = (await store.listShifts(tid(req))).filter(s => s.userId === req.user.id).slice(0, 10);
  res.json({ open, recent: mine });
}));

app.post('/api/shifts/clock-in', requireAuth, h(async (req, res) => {
  if (await store.getOpenShiftFor(req.user.id, tid(req))) return res.status(409).json({ error: "you're already clocked in" });
  const t = await store.getTenant(tid(req));
  const wages = (t && t.settings && t.settings.wages) || {};
  const wage = Number(wages[req.user.name]) || 0;
  const s = { id: nanoid(10), userId: req.user.id, name: req.user.name, role: req.user.role, clockIn: Date.now(), clockOut: null, breakMins: 0, wage, status: 'open', tenantId: tid(req) };
  await store.createShift(s);
  res.status(201).json(s);
}));

// Add break minutes to the open shift (e.g. a 30-minute lunch).
app.post('/api/shifts/break', requireAuth, h(async (req, res) => {
  const s = await store.getOpenShiftFor(req.user.id, tid(req));
  if (!s) return res.status(400).json({ error: "you're not clocked in" });
  const mins = Math.max(0, Math.round(Number(req.body.mins) || 0));
  res.json(await store.updateShift(s.id, { breakMins: (s.breakMins || 0) + mins }));
}));

app.post('/api/shifts/clock-out', requireAuth, h(async (req, res) => {
  const s = await store.getOpenShiftFor(req.user.id, tid(req));
  if (!s) return res.status(400).json({ error: "you're not clocked in" });
  const out = await store.updateShift(s.id, { clockOut: Date.now(), status: 'closed' });
  res.json({ ...out, hours: round(shiftHours(out)), pay: round(shiftHours(out) * (out.wage || 0)) });
}));

// Manager: all shifts (active + history).
app.get('/api/shifts', requireAuth, requireRole('manager'), h(async (req, res) => {
  const shifts = await store.listShifts(tid(req));
  res.json(shifts.map(s => ({ ...s, hours: round(shiftHours(s)), pay: round(shiftHours(s) * (s.wage || 0)) })));
}));

// Tip pool: split the day's tips across staff by hours worked that day.
app.get('/api/tips/pool', requireAuth, requireRole('manager'), h(async (req, res) => {
  const d = req.query.date ? new Date(req.query.date + 'T00:00:00') : new Date();
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = start + 86400000;
  const inDay = t => t != null && t >= start && t < end;
  const pays = (await store.listPayments(tid(req))).filter(p => inDay(p.createdAt));
  const totalTips = round(pays.reduce((a, p) => a + (p.tip || 0), 0));
  const shifts = (await store.listShifts(tid(req))).filter(s => inDay(s.clockIn));
  const byPerson = {};
  shifts.forEach(s => { byPerson[s.name] = (byPerson[s.name] || 0) + shiftHours(s, end); });
  const totalHours = Object.values(byPerson).reduce((a, h) => a + h, 0);
  const splits = Object.entries(byPerson).map(([name, hours]) => ({
    name, hours: round(hours), amount: totalHours > 0 ? round(totalTips * hours / totalHours) : 0,
  })).sort((a, b) => b.amount - a.amount);
  res.json({ date: new Date(start).toISOString().slice(0, 10), totalTips, totalHours: round(totalHours), splits });
}));

// ---- staff ----
app.get('/api/staff', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listStaff(tid(req)))));

async function start() {
  // Refuse to boot in production without a strong, non-default JWT secret —
  // a weak secret would let anyone forge staff/manager sessions.
  const jwt = process.env.JWT_SECRET || '';
  if (PROD && (jwt.length < 24 || jwt === 'dev-only-change-me')) {
    console.error('FATAL: set a strong JWT_SECRET (>=24 chars) before running in production.');
    process.exit(1);
  }
  if (!PROD && jwt.length < 24) console.warn('[security] JWT_SECRET is weak/unset — fine for dev, REQUIRED in production.');
  store = await getStore();             // getStore() runs schema migration in init()
  // Auto-seed a brand-new (empty) database so fresh deploys work out of the box.
  // Existing data is never touched. Disable with AUTO_SEED=false.
  if (process.env.AUTO_SEED !== 'false') {
    const users = await store.listUsers();
    if (users.length === 0) {
      await store.reset(buildSeedData());
      console.log('  Empty database detected → seeded default menu, tables, and users.');
    }
  }
  // Self-heal: ensure the 'default' tenant has a real row (databases created
  // before multi-tenancy stored data under tenant_id='default' but had no tenants row).
  try {
    if (!(await store.getTenant(DEFAULT_TENANT))) {
      await store.createTenant({ id: DEFAULT_TENANT, name: 'Tavo', slug: DEFAULT_TENANT, plan: 'free', mode: 'restaurant', createdAt: Date.now() });
      console.log('  Backfilled the default tenant row.');
    }
  } catch (e) { console.error('default-tenant backfill skipped:', e.message); }
  app.listen(PORT, () => {
    console.log(`\n  Tavo POS running → http://localhost:${PORT}`);
    console.log(`  Database: ${storeKind().toUpperCase()}   Payment mode: ${usingStripe ? 'STRIPE (test)' : 'MOCK (no key set)'}\n`);
  });
}
start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
