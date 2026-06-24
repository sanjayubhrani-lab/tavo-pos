// JSON-file storage backend — the zero-setup default.
// Implements the same async API as the Postgres backend so the rest of the
// app doesn't care which one is in use.
import { read, write } from '../db.js';

export function makeJsonStore() {
  return {
    kind: 'json',
    async init() { /* nothing to do */ },

    // bulk reset (used by seed)
    async reset({ menu = [], tables = [], staff = [], users = [] }) {
      const db = read();
      db.menu = menu; db.tables = tables; db.staff = staff; db.users = users;
      db.orders = []; db.payments = [];
      write(db);
    },

    // menu
    async listMenu() { return [...read().menu].sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0)); },
    async createMenuItem(item) { const db = read(); db.menu.push(item); write(db); return item; },
    async updateMenuItem(id, patch) {
      const db = read(); const it = db.menu.find(m => m.id === id);
      if (!it) return null; Object.assign(it, patch); write(db); return it;
    },
    async deleteMenuItem(id) { const db = read(); db.menu = db.menu.filter(m => m.id !== id); write(db); },

    // tables
    async listTables() { return read().tables; },
    async setTableStatus(number, status, orderId = null) {
      const db = read(); const t = db.tables.find(x => x.number === number);
      if (t) { t.status = status; t.orderId = orderId; write(db); }
    },

    // orders
    async listOrders(status) {
      const orders = read().orders; return status ? orders.filter(o => o.status === status) : orders;
    },
    async countOrders() { return read().orders.length; },
    async getOrder(id) { return read().orders.find(o => o.id === id) || null; },
    async findOrderByExternalId(externalId) { return read().orders.find(o => o.externalId === externalId) || null; },
    async createOrder(order) { const db = read(); db.orders.push(order); write(db); return order; },
    async updateOrder(id, patch) {
      const db = read(); const o = db.orders.find(x => x.id === id);
      if (!o) return null; Object.assign(o, patch); write(db); return o;
    },

    // payments
    async listPayments() { return read().payments; },
    async createPayment(p) { const db = read(); db.payments.push(p); write(db); return p; },
    async findPaymentByStripeId(stripeId) { return read().payments.find(p => p.stripeId === stripeId) || null; },
    async getPayment(id) { return read().payments.find(p => p.id === id) || null; },
    async updatePayment(id, patch) {
      const db = read(); const p = db.payments.find(x => x.id === id);
      if (!p) return null; Object.assign(p, patch); write(db); return p;
    },

    // users / staff
    async listUsers() { return read().users; },
    async listStaff() { return read().staff; },
  };
}
