// PostgreSQL storage backend.
// Used automatically when DATABASE_URL is set. Implements the same async API
// as the JSON backend. A pool can be injected (used by tests with pg-mem).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- row mappers (snake_case DB → camelCase app objects) ----
const num = v => (v == null ? v : Number(v));
const mMenu = r => ({ id: r.id, category: r.category, name: r.name, price: num(r.price), emoji: r.emoji,
  image: r.image ?? null, sortOrder: num(r.sort_order) || 0, active: r.active });
const mTable = r => ({ number: num(r.number), status: r.status, orderId: r.order_id });
const mOrder = r => ({ id: r.id, number: num(r.number), table: r.table_no == null ? null : num(r.table_no),
  lines: r.lines, subtotal: num(r.subtotal), tax: num(r.tax), total: num(r.total),
  status: r.status, voidReason: r.void_reason ?? null,
  createdAt: num(r.created_at), firedAt: r.fired_at == null ? undefined : num(r.fired_at) });
const mPay = r => ({ id: r.id, orderId: r.order_id, table: r.table_no == null ? null : num(r.table_no),
  lines: r.lines, subtotal: num(r.subtotal), tax: num(r.tax), tip: num(r.tip), total: num(r.total),
  method: r.method, status: r.status, stripeId: r.stripe_id, confirmed: r.confirmed,
  refundedAmount: num(r.refunded_amount) || 0, refundedAt: r.refunded_at == null ? null : num(r.refunded_at),
  createdAt: num(r.created_at) });
const mUser = r => ({ id: r.id, name: r.name, role: r.role, pinHash: r.pin_hash });
const mStaff = r => ({ id: r.id, name: r.name, role: r.role, clockedInAt: r.clocked_in_at == null ? null : num(r.clocked_in_at) });

export async function makePgStore(poolOverride) {
  let pool = poolOverride;
  if (!pool) {
    const pg = (await import('pg')).default;
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
  }
  const q = (text, params) => pool.query(text, params);

  return {
    kind: 'pg',
    pool,

    async init() {
      const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
      await q(sql);
      // Self-healing upgrades for databases created before these columns existed.
      // On a fresh DB the columns already exist, so these throw "already exists" — ignored.
      const upgrades = [
        'ALTER TABLE payments ADD COLUMN refunded_amount NUMERIC(10,2) DEFAULT 0',
        'ALTER TABLE payments ADD COLUMN refunded_at BIGINT',
        'ALTER TABLE orders ADD COLUMN void_reason TEXT',
        'ALTER TABLE menu ADD COLUMN image TEXT',
        'ALTER TABLE menu ADD COLUMN sort_order INTEGER DEFAULT 0',
      ];
      for (const u of upgrades) { try { await q(u); } catch { /* column already present */ } }
    },

    async reset({ menu = [], tables = [], staff = [], users = [] }) {
      for (const t of ['menu', 'tables', 'orders', 'payments', 'users', 'staff'])
        await q(`DELETE FROM ${t}`);
      for (const m of menu)
        await q('INSERT INTO menu(id,category,name,price,emoji,image,sort_order,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [m.id, m.category, m.name, m.price, m.emoji, m.image ?? null, m.sortOrder ?? 0, m.active]);
      for (const t of tables)
        await q('INSERT INTO tables(number,status,order_id) VALUES($1,$2,$3)', [t.number, t.status, t.orderId]);
      for (const s of staff)
        await q('INSERT INTO staff(id,name,role,clocked_in_at) VALUES($1,$2,$3,$4)', [s.id, s.name, s.role, s.clockedInAt]);
      for (const u of users)
        await q('INSERT INTO users(id,name,role,pin_hash) VALUES($1,$2,$3,$4)', [u.id, u.name, u.role, u.pinHash]);
    },

    // menu
    async listMenu() { return (await q('SELECT * FROM menu ORDER BY sort_order, category, name')).rows.map(mMenu); },
    async createMenuItem(i) {
      await q('INSERT INTO menu(id,category,name,price,emoji,image,sort_order,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [i.id, i.category, i.name, i.price, i.emoji, i.image ?? null, i.sortOrder ?? 0, i.active]);
      return i;
    },
    async updateMenuItem(id, patch) {
      const cur = (await q('SELECT * FROM menu WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mMenu(cur), ...patch };
      await q('UPDATE menu SET category=$2,name=$3,price=$4,emoji=$5,image=$6,sort_order=$7,active=$8 WHERE id=$1',
        [id, n.category, n.name, n.price, n.emoji, n.image ?? null, n.sortOrder ?? 0, n.active]);
      return n;
    },
    async deleteMenuItem(id) { await q('DELETE FROM menu WHERE id=$1', [id]); },

    // tables
    async listTables() { return (await q('SELECT * FROM tables ORDER BY number')).rows.map(mTable); },
    async setTableStatus(number, status, orderId = null) {
      await q('UPDATE tables SET status=$2, order_id=$3 WHERE number=$1', [number, status, orderId]);
    },

    // orders
    async listOrders(status) {
      const r = status
        ? await q('SELECT * FROM orders WHERE status=$1 ORDER BY created_at', [status])
        : await q('SELECT * FROM orders ORDER BY created_at');
      return r.rows.map(mOrder);
    },
    async countOrders() { return Number((await q('SELECT COUNT(*) AS c FROM orders')).rows[0].c); },
    async getOrder(id) { const r = (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0]; return r ? mOrder(r) : null; },
    async createOrder(o) {
      await q(`INSERT INTO orders(id,number,table_no,lines,subtotal,tax,total,status,created_at,fired_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [o.id, o.number, o.table, JSON.stringify(o.lines), o.subtotal, o.tax, o.total, o.status, o.createdAt, o.firedAt ?? null]);
      return o;
    },
    async updateOrder(id, patch) {
      const cur = (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mOrder(cur), ...patch };
      await q('UPDATE orders SET status=$2, fired_at=$3, void_reason=$4 WHERE id=$1',
        [id, n.status, n.firedAt ?? null, n.voidReason ?? null]);
      return n;
    },

    // payments
    async listPayments() { return (await q('SELECT * FROM payments ORDER BY created_at')).rows.map(mPay); },
    async createPayment(p) {
      await q(`INSERT INTO payments(id,order_id,table_no,lines,subtotal,tax,tip,total,method,status,stripe_id,confirmed,created_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [p.id, p.orderId, p.table, JSON.stringify(p.lines), p.subtotal, p.tax, p.tip, p.total, p.method, p.status, p.stripeId, p.confirmed ?? false, p.createdAt]);
      return p;
    },
    async findPaymentByStripeId(stripeId) {
      const r = (await q('SELECT * FROM payments WHERE stripe_id=$1', [stripeId])).rows[0]; return r ? mPay(r) : null;
    },
    async getPayment(id) {
      const r = (await q('SELECT * FROM payments WHERE id=$1', [id])).rows[0]; return r ? mPay(r) : null;
    },
    async updatePayment(id, patch) {
      const cur = (await q('SELECT * FROM payments WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mPay(cur), ...patch };
      await q('UPDATE payments SET status=$2, confirmed=$3, refunded_amount=$4, refunded_at=$5 WHERE id=$1',
        [id, n.status, n.confirmed ?? false, n.refundedAmount ?? 0, n.refundedAt ?? null]);
      return n;
    },

    // users / staff
    async listUsers() { return (await q('SELECT * FROM users')).rows.map(mUser); },
    async listStaff() { return (await q('SELECT * FROM staff')).rows.map(mStaff); },
  };
}
