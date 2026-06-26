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
function priceLines(lines) {
  const subtotal = round(lines.reduce((a, l) => {
    const mods = (l.mods || []).reduce((s, m) => {
      const x = String(m).match(/\+\$([0-9.]+)/); return s + (x ? parseFloat(x[1]) : 0);
    }, 0);
    return a + (l.price + mods) * l.qty;
  }, 0));
  const tax = round(subtotal * TAX_RATE);
  return { subtotal, tax, total: round(subtotal + tax) };
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
app.post('/api/auth/login', h(async (req, res) => {
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
  const menu = (await store.listMenu(t.id)).filter(m => m.active !== false);
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
  res.json(t ? { id: t.id, name: t.name, slug: t.slug, mode: t.mode || 'restaurant' } : { id: DEFAULT_TENANT, name: 'Tavo', slug: DEFAULT_TENANT, mode: 'restaurant' });
}));

app.put('/api/tenant', requireAuth, requireRole('manager'), h(async (req, res) => {
  const patch = {};
  if (req.body.mode && ['restaurant', 'retail'].includes(req.body.mode)) patch.mode = req.body.mode;
  if (req.body.name) patch.name = String(req.body.name);
  let t = await store.updateTenant(tid(req), patch);
  if (!t) {
    // No tenant row yet (legacy default store) — create it, then apply.
    await store.createTenant({ id: tid(req), name: patch.name || 'Tavo', slug: tid(req), plan: 'free', mode: patch.mode || 'restaurant', createdAt: Date.now() });
    t = await store.getTenant(tid(req));
  }
  res.json({ id: t.id, name: t.name, slug: t.slug, mode: t.mode || 'restaurant' });
}));

app.post('/api/menu', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { category, name, price, emoji, image, sortOrder, modifierGroups, recipe, sku, barcode, stock, trackStock } = req.body;
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
  const order = { id: nanoid(10), number: 1000 + count + 1, table, lines, ...totals, status: 'open', tenantId: tid(req), createdAt: Date.now() };
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
  const { intentId, method = 'card', lines = [], tip = 0, orderId = null, table = null, customerId = null, pointsRedeemed = 0, discount = 0 } = req.body;
  const status = await retrieveStatus(intentId);
  const totals = priceLines(lines);
  const disc = Math.max(0, round(Number(discount) || 0));
  const total = Math.max(0, round(totals.total + Number(tip || 0) - disc));

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
    id: nanoid(10), orderId, table, lines, ...totals, tip: Number(tip || 0), total,
    method, status, stripeId: intentId || null, confirmed: false,
    refundedAmount: 0, refundedAt: null, discount: disc,
    customerId: member ? member.id : null, pointsEarned, pointsRedeemed: member ? Math.round(Number(pointsRedeemed) || 0) : 0,
    tenantId: tid(req), createdAt: Date.now(),
  };
  await store.createPayment(payment);
  await depleteProductStock(lines, tid(req));   // retail: decrement product stock for tracked SKUs
  if (orderId) await store.updateOrder(orderId, { status: 'paid' });
  if (table) await store.setTableStatus(table, 'open', null, tid(req));
  res.status(201).json({ ...payment, pointsBalance: member ? (await store.getCustomer(member.id)).points : null });
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

  res.json({ gross, refunds, net, tips, tax, orders, avgCheck, byMethod, topSellers, openChecks,
    foodCost, foodCostPct, grossProfit, lowStock, stockValue, inventoryCount: inventory.length });
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
  const { name, phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const existing = await store.findCustomerByPhone(phone, tid(req));
  if (existing) return res.json(existing);   // idempotent — return the existing member
  const c = { id: nanoid(10), name: (name || 'Guest').toString().slice(0, 60), phone: String(phone), points: 0, visits: 0, totalSpent: 0, tenantId: tid(req), createdAt: Date.now() };
  await store.createCustomer(c);
  res.status(201).json(c);
}));

app.put('/api/customers/:id', requireAuth, h(async (req, res) => {
  const patch = {};
  for (const k of ['name', 'phone']) if (req.body[k] != null) patch[k] = String(req.body[k]);
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

// ---- staff ----
app.get('/api/staff', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listStaff(tid(req)))));

async function start() {
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
