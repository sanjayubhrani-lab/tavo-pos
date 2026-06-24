import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { getStore, storeKind } from './store/index.js';
import { buildSeedData } from './seedData.js';
import { createPaymentIntent, retrieveStatus, createRefund, usingStripe, stripeClient } from './payments.js';
import { verifyPin, issueToken, requireAuth, requireRole, ROLE_ROUTES } from './auth.js';
import { normalizeIncoming, exportMenu } from './integrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);   // correct client IP / protocol behind a load balancer (Render, Fly, etc.)
const PORT = process.env.PORT || 4242;
const TAX_RATE = parseFloat(process.env.TAX_RATE || '0.0825');

// Store is initialized in start(); handlers access it via this reference.
let store;
// Small async wrapper so route handlers can throw and we still return JSON 500s.
const h = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e); res.status(500).json({ error: e.message });
});

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

// ---- config / health ----
app.get('/api/health', (req, res) =>
  res.json({ ok: true, paymentMode: usingStripe ? 'stripe' : 'mock', taxRate: TAX_RATE, db: storeKind() }));

app.get('/api/config', (req, res) => res.json({
  publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
  paymentMode: usingStripe ? 'stripe' : 'mock',
  taxRate: TAX_RATE,
}));

// ---- auth ----
app.post('/api/auth/login', h(async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });
  const users = await store.listUsers();
  const user = users.find(u => verifyPin(pin, u.pinHash));
  if (!user) return res.status(401).json({ error: 'Invalid PIN' });
  const token = issueToken(user);
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, routes: ROLE_ROUTES[user.role] || [] } });
}));

app.get('/api/auth/me', requireAuth, (req, res) =>
  res.json({ ...req.user, routes: ROLE_ROUTES[req.user.role] || [] }));

// ---- menu ----
app.get('/api/menu', requireAuth, h(async (req, res) => res.json(await store.listMenu())));

app.post('/api/menu', requireAuth, requireRole('manager'), h(async (req, res) => {
  const { category, name, price, emoji, image, sortOrder } = req.body;
  if (!name || price == null) return res.status(400).json({ error: 'name and price required' });
  const existing = await store.listMenu();
  const item = {
    id: nanoid(8), category: category || 'Other', name, price: Number(price),
    emoji: emoji || '🍽️', image: image || null,
    sortOrder: sortOrder != null ? Number(sortOrder) : existing.length,
    active: true,
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
app.get('/api/tables', requireAuth, h(async (req, res) => res.json(await store.listTables())));

// ---- orders ----
app.get('/api/orders', requireAuth, h(async (req, res) => {
  res.json(await store.listOrders(req.query.status));
}));

app.post('/api/orders', requireAuth, h(async (req, res) => {
  const { lines = [], table = null } = req.body;
  if (!lines.length) return res.status(400).json({ error: 'order has no items' });
  const totals = priceLines(lines);
  const count = await store.countOrders();
  const order = { id: nanoid(10), number: 1000 + count + 1, table, lines, ...totals, status: 'open', createdAt: Date.now() };
  await store.createOrder(order);
  if (table) await store.setTableStatus(table, 'seated', order.id);
  res.status(201).json(order);
}));

// send order to kitchen
app.post('/api/orders/:id/fire', requireAuth, h(async (req, res) => {
  const out = await store.updateOrder(req.params.id, { status: 'cooking', firedAt: Date.now() });
  out ? res.json(out) : res.status(404).json({ error: 'not found' });
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
  const { intentId, method = 'card', lines = [], tip = 0, orderId = null, table = null } = req.body;
  const status = await retrieveStatus(intentId);
  const totals = priceLines(lines);
  const total = round(totals.total + Number(tip || 0));
  const payment = {
    id: nanoid(10), orderId, table, lines, ...totals, tip: Number(tip || 0), total,
    method, status, stripeId: intentId || null, confirmed: false,
    refundedAmount: 0, refundedAt: null, createdAt: Date.now(),
  };
  await store.createPayment(payment);
  if (orderId) await store.updateOrder(orderId, { status: 'paid' });
  if (table) await store.setTableStatus(table, 'open', null);
  res.status(201).json(payment);
}));

app.get('/api/payments', requireAuth, h(async (req, res) => res.json(await store.listPayments())));

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
  if (order.table) await store.setTableStatus(order.table, 'open', null);
  res.json(out);
}));

// ---- reports ----
app.get('/api/reports/summary', requireAuth, requireRole('manager'), h(async (req, res) => {
  const pays = await store.listPayments();
  const tables = await store.listTables();
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
  res.json({ gross, refunds, net, tips, tax, orders, avgCheck, byMethod, topSellers, openChecks });
}));

// ---- delivery-platform integrations (DoorDash / Uber Eats / Grubhub / aggregators) ----
function requireIntegrationKey(req, res, next) {
  const key = process.env.INTEGRATION_API_KEY;
  if (!key) return res.status(503).json({ error: 'integrations not configured — set INTEGRATION_API_KEY' });
  if (req.headers['x-integration-key'] !== key) return res.status(401).json({ error: 'invalid integration key' });
  next();
}

// Shared: turn a normalized incoming order into a live Tavo order (+ payment for reporting).
async function createDeliveryOrder(norm) {
  if (norm.externalId) {
    const existing = await store.findOrderByExternalId(norm.externalId);
    if (existing) return { order: existing, duplicate: true };   // idempotent
  }
  const totals = priceLines(norm.lines);
  const count = await store.countOrders();
  const order = {
    id: nanoid(10), number: 1000 + count + 1, table: null, lines: norm.lines, ...totals,
    status: 'cooking', channel: 'delivery', platform: norm.platform, customer: norm.customer,
    externalId: norm.externalId, createdAt: Date.now(), firedAt: Date.now(),
  };
  await store.createOrder(order);
  // The platform already collected payment from the customer — record it so it shows in sales/reports by platform.
  await store.createPayment({
    id: nanoid(10), orderId: order.id, table: null, lines: norm.lines, ...totals,
    tip: 0, total: totals.total, method: norm.platform, status: 'succeeded', stripeId: null,
    confirmed: true, refundedAmount: 0, refundedAt: null, createdAt: Date.now(),
  });
  return { order, duplicate: false };
}

// Webhook: external platforms / aggregators POST incoming orders here.
app.post('/api/integrations/orders', requireIntegrationKey, h(async (req, res) => {
  let norm;
  try { norm = normalizeIncoming(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  const { order, duplicate } = await createDeliveryOrder(norm);
  res.status(duplicate ? 200 : 201).json({ received: true, duplicate, order });
}));

// Menu export for pushing to platforms/aggregators.
app.get('/api/integrations/menu', requireIntegrationKey, h(async (req, res) =>
  res.json(exportMenu(await store.listMenu()))));

// Sandbox: a logged-in manager can simulate an incoming delivery order (no key needed).
app.post('/api/integrations/simulate', requireAuth, requireRole('manager'), h(async (req, res) => {
  const platform = String(req.body.platform || 'doordash');
  const menu = (await store.listMenu()).filter(m => m.active !== false);
  if (!menu.length) return res.status(400).json({ error: 'no menu items to build a test order' });
  const pick = () => menu[Math.floor(Math.random() * menu.length)];
  const lines = [pick(), pick()].map(it => ({ name: it.name, price: it.price, qty: 1 + Math.floor(Math.random() * 2), mods: [] }));
  const names = ['Alex R.', 'Sam P.', 'Jordan L.', 'Riley C.', 'Casey W.', 'Morgan D.'];
  const norm = {
    platform, externalId: platform + '_' + Date.now(),
    customer: names[Math.floor(Math.random() * names.length)] + ' (delivery)', lines,
  };
  const { order } = await createDeliveryOrder(norm);
  res.status(201).json({ simulated: true, order });
}));

// ---- Z report (end-of-day close-out) ----
app.get('/api/reports/zreport', requireAuth, requireRole('manager'), h(async (req, res) => {
  const d = req.query.date ? new Date(req.query.date + 'T00:00:00') : new Date();
  if (isNaN(d)) return res.status(400).json({ error: 'invalid date' });
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = start + 24 * 60 * 60 * 1000;
  const inDay = t => t != null && t >= start && t < end;

  const pays = (await store.listPayments()).filter(p => inDay(p.createdAt));
  const orders = (await store.listOrders()).filter(o => inDay(o.createdAt));

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

// ---- staff ----
app.get('/api/staff', requireAuth, requireRole('manager'), h(async (req, res) => res.json(await store.listStaff())));

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
  app.listen(PORT, () => {
    console.log(`\n  Tavo POS running → http://localhost:${PORT}`);
    console.log(`  Database: ${storeKind().toUpperCase()}   Payment mode: ${usingStripe ? 'STRIPE (test)' : 'MOCK (no key set)'}\n`);
  });
}
start().catch(e => { console.error('Failed to start:', e); process.exit(1); });
