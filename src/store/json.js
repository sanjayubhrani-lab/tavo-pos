// JSON-file storage backend — the zero-setup default.
// Tenant-aware: every business is a "tenant". List/scan methods take a tenantId
// (defaulting to 'default') so a single-store deployment behaves exactly as before,
// while a multi-tenant deployment keeps each tenant's data fully isolated.
import { read, write } from '../db.js';

export const DEFAULT_TENANT = 'default';
const T = x => x || DEFAULT_TENANT;          // normalize a tenantId
const owns = (row, tid) => (row.tenantId || DEFAULT_TENANT) === T(tid);

export function makeJsonStore() {
  return {
    kind: 'json',
    async init() { /* nothing to do */ },

    // bulk reset for one tenant's seed (used by `npm run seed` / first-boot).
    async reset({ menu = [], tables = [], staff = [], users = [], inventory = [], tenants } = {}) {
      const db = read();
      db.menu = menu; db.tables = tables; db.staff = staff; db.users = users; db.inventory = inventory;
      db.orders = []; db.payments = [];
      db.tenants = tenants || [{ id: DEFAULT_TENANT, name: 'Default', slug: DEFAULT_TENANT, plan: 'free', createdAt: Date.now() }];
      write(db);
    },

    // ---- tenants ----
    async createTenant(t) { const db = read(); (db.tenants ||= []).push(t); write(db); return t; },
    async getTenant(id) { return (read().tenants || []).find(t => t.id === id) || null; },
    async getTenantBySlug(slug) { return (read().tenants || []).find(t => t.slug === slug) || null; },
    async listTenants() { return read().tenants || []; },
    // Add one tenant's starter data without wiping others (used by signup).
    async seedTenant({ menu = [], tables = [], staff = [], users = [], inventory = [] }) {
      const db = read();
      db.menu.push(...menu); db.tables.push(...tables); db.staff.push(...staff); db.users.push(...users);
      (db.inventory ||= []).push(...inventory);
      write(db);
    },

    // ---- menu (scoped) ----
    async listMenu(tenantId) { return read().menu.filter(m => owns(m, tenantId)).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)); },
    async createMenuItem(item) { const db = read(); db.menu.push(item); write(db); return item; },
    async updateMenuItem(id, patch) { const db = read(); const it = db.menu.find(m => m.id === id); if (!it) return null; Object.assign(it, patch); write(db); return it; },
    async deleteMenuItem(id) { const db = read(); db.menu = db.menu.filter(m => m.id !== id); write(db); },

    // ---- tables (scoped; table numbers repeat per tenant) ----
    async listTables(tenantId) { return read().tables.filter(t => owns(t, tenantId)); },
    async setTableStatus(number, status, orderId = null, tenantId) {
      const db = read(); const t = db.tables.find(x => x.number === number && owns(x, tenantId));
      if (t) { t.status = status; t.orderId = orderId; write(db); }
    },

    // ---- orders ----
    async listOrders(status, tenantId) {
      return read().orders.filter(o => owns(o, tenantId) && (!status || o.status === status));
    },
    async countOrders(tenantId) { return read().orders.filter(o => owns(o, tenantId)).length; },
    async getOrder(id) { return read().orders.find(o => o.id === id) || null; },
    async findOrderByExternalId(externalId, tenantId) { return read().orders.find(o => o.externalId === externalId && owns(o, tenantId)) || null; },
    async createOrder(order) { const db = read(); db.orders.push(order); write(db); return order; },
    async updateOrder(id, patch) { const db = read(); const o = db.orders.find(x => x.id === id); if (!o) return null; Object.assign(o, patch); write(db); return o; },

    // ---- payments ----
    async listPayments(tenantId) { return read().payments.filter(p => owns(p, tenantId)); },
    async createPayment(p) { const db = read(); db.payments.push(p); write(db); return p; },
    async findPaymentByStripeId(stripeId, tenantId) { return read().payments.find(p => p.stripeId === stripeId && (tenantId == null || owns(p, tenantId))) || null; },
    async getPayment(id) { return read().payments.find(p => p.id === id) || null; },
    async updatePayment(id, patch) { const db = read(); const p = db.payments.find(x => x.id === id); if (!p) return null; Object.assign(p, patch); write(db); return p; },

    // ---- users / staff (scoped) ----
    async listUsers(tenantId) { return read().users.filter(u => owns(u, tenantId)); },
    async listStaff(tenantId) { return read().staff.filter(s => owns(s, tenantId)); },

    // ---- inventory (scoped) ----
    async listInventory(tenantId) { return (read().inventory || []).filter(i => owns(i, tenantId)).sort((a, b) => (a.name || '').localeCompare(b.name || '')); },
    async getInventoryItem(id) { return (read().inventory || []).find(i => i.id === id) || null; },
    async createInventoryItem(item) { const db = read(); (db.inventory ||= []).push(item); write(db); return item; },
    async updateInventoryItem(id, patch) { const db = read(); const it = (db.inventory ||= []).find(i => i.id === id); if (!it) return null; Object.assign(it, patch); write(db); return it; },
    async deleteInventoryItem(id) { const db = read(); db.inventory = (db.inventory || []).filter(i => i.id !== id); write(db); },
    // Atomically add `delta` (can be negative) to an item's on-hand qty. Never goes below 0.
    async adjustInventory(id, delta) {
      const db = read(); const it = (db.inventory || []).find(i => i.id === id); if (!it) return null;
      it.qty = Math.round(((Number(it.qty) || 0) + Number(delta)) * 1000) / 1000;
      if (it.qty < 0) it.qty = 0;
      write(db); return it;
    },
  };
}
