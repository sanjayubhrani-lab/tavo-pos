// PostgreSQL storage backend.
// Used automatically when DATABASE_URL is set. Implements the same async API
// as the JSON backend. A pool can be injected (used by tests with pg-mem).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TENANT = 'default';
const T = x => x || DEFAULT_TENANT;

// ---- row mappers (snake_case DB → camelCase app objects) ----
const num = v => (v == null ? v : Number(v));
const mMenu = r => ({ id: r.id, category: r.category, name: r.name, price: num(r.price), emoji: r.emoji,
  image: r.image ?? null, sortOrder: num(r.sort_order) || 0, modifierGroups: r.modifier_groups ?? [], recipe: r.recipe ?? [],
  sku: r.sku ?? null, barcode: r.barcode ?? null, stock: r.stock == null ? null : num(r.stock), trackStock: r.track_stock ?? false,
  active: r.active, tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mInv = r => ({ id: r.id, name: r.name, unit: r.unit ?? 'unit', qty: num(r.qty) || 0, parLevel: num(r.par_level) || 0, cost: num(r.cost) || 0, tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mCust = r => ({ id: r.id, name: r.name, phone: r.phone, points: num(r.points) || 0, visits: num(r.visits) || 0, totalSpent: num(r.total_spent) || 0, tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at) });
const mGift = r => ({ id: r.id, code: r.code, balance: num(r.balance) || 0, initialBalance: num(r.initial_balance) || 0, active: r.active, tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at) });
const mTable = r => ({ number: num(r.number), status: r.status, orderId: r.order_id, tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mOrder = r => ({ id: r.id, number: num(r.number), table: r.table_no == null ? null : num(r.table_no),
  lines: r.lines, subtotal: num(r.subtotal), tax: num(r.tax), total: num(r.total),
  status: r.status, voidReason: r.void_reason ?? null,
  channel: r.channel ?? 'pos', platform: r.platform ?? null, customer: r.customer ?? null, externalId: r.external_id ?? null,
  createdAt: num(r.created_at), firedAt: r.fired_at == null ? undefined : num(r.fired_at), tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mPay = r => ({ id: r.id, orderId: r.order_id, table: r.table_no == null ? null : num(r.table_no),
  lines: r.lines, subtotal: num(r.subtotal), tax: num(r.tax), tip: num(r.tip), total: num(r.total),
  method: r.method, status: r.status, stripeId: r.stripe_id, confirmed: r.confirmed,
  refundedAmount: num(r.refunded_amount) || 0, refundedAt: r.refunded_at == null ? null : num(r.refunded_at),
  createdAt: num(r.created_at), tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mUser = r => ({ id: r.id, name: r.name, role: r.role, pinHash: r.pin_hash, tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mStaff = r => ({ id: r.id, name: r.name, role: r.role, clockedInAt: r.clocked_in_at == null ? null : num(r.clocked_in_at), tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mTenant = r => ({ id: r.id, name: r.name, slug: r.slug, plan: r.plan, mode: r.mode ?? 'restaurant', createdAt: num(r.created_at) });

// Insert one tenant's rows (stamped with tenant_id) without wiping others.
async function insertSeed(q, { menu = [], tables = [], staff = [], users = [], inventory = [] }) {
  for (const m of menu)
    await q('INSERT INTO menu(id,category,name,price,emoji,image,sort_order,modifier_groups,recipe,sku,barcode,stock,track_stock,active,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
      [m.id, m.category, m.name, m.price, m.emoji, m.image ?? null, m.sortOrder ?? 0, JSON.stringify(m.modifierGroups ?? []), JSON.stringify(m.recipe ?? []), m.sku ?? null, m.barcode ?? null, m.stock ?? null, m.trackStock ?? false, m.active, T(m.tenantId)]);
  for (const t of tables)
    await q('INSERT INTO tables(number,status,order_id,tenant_id) VALUES($1,$2,$3,$4)', [t.number, t.status, t.orderId, T(t.tenantId)]);
  for (const s of staff)
    await q('INSERT INTO staff(id,name,role,clocked_in_at,tenant_id) VALUES($1,$2,$3,$4,$5)', [s.id, s.name, s.role, s.clockedInAt, T(s.tenantId)]);
  for (const u of users)
    await q('INSERT INTO users(id,name,role,pin_hash,tenant_id) VALUES($1,$2,$3,$4,$5)', [u.id, u.name, u.role, u.pinHash, T(u.tenantId)]);
  for (const i of inventory)
    await q('INSERT INTO inventory(id,name,unit,qty,par_level,cost,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [i.id, i.name, i.unit ?? 'unit', i.qty ?? 0, i.parLevel ?? 0, i.cost ?? 0, T(i.tenantId)]);
}

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
        "ALTER TABLE orders ADD COLUMN channel TEXT DEFAULT 'pos'",
        'ALTER TABLE orders ADD COLUMN platform TEXT',
        'ALTER TABLE orders ADD COLUMN customer TEXT',
        'ALTER TABLE orders ADD COLUMN external_id TEXT',
        "ALTER TABLE menu ADD COLUMN modifier_groups JSONB DEFAULT '[]'",
        "ALTER TABLE menu ADD COLUMN tenant_id TEXT DEFAULT 'default'",
        "ALTER TABLE tables ADD COLUMN tenant_id TEXT DEFAULT 'default'",
        "ALTER TABLE orders ADD COLUMN tenant_id TEXT DEFAULT 'default'",
        "ALTER TABLE payments ADD COLUMN tenant_id TEXT DEFAULT 'default'",
        "ALTER TABLE users ADD COLUMN tenant_id TEXT DEFAULT 'default'",
        "ALTER TABLE staff ADD COLUMN tenant_id TEXT DEFAULT 'default'",
        // table numbers repeat per tenant — drop the old single-column PK if present.
        'ALTER TABLE tables DROP CONSTRAINT tables_pkey',
        // inventory + recipe costing
        "ALTER TABLE menu ADD COLUMN recipe JSONB DEFAULT '[]'",
        `CREATE TABLE IF NOT EXISTS inventory (
           id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT DEFAULT 'unit',
           qty NUMERIC(12,3) DEFAULT 0, par_level NUMERIC(12,3) DEFAULT 0,
           cost NUMERIC(10,4) DEFAULT 0, tenant_id TEXT DEFAULT 'default')`,
        // loyalty + gift cards
        `CREATE TABLE IF NOT EXISTS customers (
           id TEXT PRIMARY KEY, name TEXT, phone TEXT, points INTEGER DEFAULT 0,
           visits INTEGER DEFAULT 0, total_spent NUMERIC(12,2) DEFAULT 0,
           tenant_id TEXT DEFAULT 'default', created_at BIGINT)`,
        `CREATE TABLE IF NOT EXISTS giftcards (
           id TEXT PRIMARY KEY, code TEXT, balance NUMERIC(10,2) DEFAULT 0,
           initial_balance NUMERIC(10,2) DEFAULT 0, active BOOLEAN DEFAULT TRUE,
           tenant_id TEXT DEFAULT 'default', created_at BIGINT)`,
        // retail mode: business type + product SKU/barcode/stock
        "ALTER TABLE tenants ADD COLUMN mode TEXT DEFAULT 'restaurant'",
        'ALTER TABLE menu ADD COLUMN sku TEXT',
        'ALTER TABLE menu ADD COLUMN barcode TEXT',
        'ALTER TABLE menu ADD COLUMN stock NUMERIC(12,3)',
        'ALTER TABLE menu ADD COLUMN track_stock BOOLEAN DEFAULT FALSE',
      ];
      for (const u of upgrades) { try { await q(u); } catch { /* column already present */ } }
    },

    // ---- tenants ----
    async createTenant(t) {
      await q('INSERT INTO tenants(id,name,slug,plan,mode,created_at) VALUES($1,$2,$3,$4,$5,$6)', [t.id, t.name, t.slug, t.plan ?? 'free', t.mode ?? 'restaurant', t.createdAt ?? Date.now()]);
      return t;
    },
    async updateTenant(id, patch) {
      const cur = (await q('SELECT * FROM tenants WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mTenant(cur), ...patch };
      await q('UPDATE tenants SET name=$2,mode=$3 WHERE id=$1', [id, n.name, n.mode ?? 'restaurant']);
      return n;
    },
    async getTenant(id) { const r = (await q('SELECT * FROM tenants WHERE id=$1', [id])).rows[0]; return r ? mTenant(r) : null; },
    async getTenantBySlug(slug) { const r = (await q('SELECT * FROM tenants WHERE slug=$1', [slug])).rows[0]; return r ? mTenant(r) : null; },
    async listTenants() { return (await q('SELECT * FROM tenants ORDER BY created_at')).rows.map(mTenant); },
    async seedTenant(data) { await insertSeed(q, data); },

    async reset({ menu = [], tables = [], staff = [], users = [], inventory = [], tenants } = {}) {
      for (const t of ['menu', 'tables', 'orders', 'payments', 'users', 'staff', 'inventory', 'customers', 'giftcards', 'tenants'])
        await q(`DELETE FROM ${t}`);
      const tlist = tenants || [{ id: DEFAULT_TENANT, name: 'Default', slug: DEFAULT_TENANT, plan: 'free', mode: 'restaurant', createdAt: Date.now() }];
      for (const t of tlist)
        await q('INSERT INTO tenants(id,name,slug,plan,mode,created_at) VALUES($1,$2,$3,$4,$5,$6)', [t.id, t.name, t.slug, t.plan ?? 'free', t.mode ?? 'restaurant', t.createdAt ?? Date.now()]);
      await insertSeed(q, { menu, tables, staff, users, inventory });
    },

    // menu (tenant-scoped)
    async listMenu(tenantId) { return (await q('SELECT * FROM menu WHERE tenant_id=$1 ORDER BY sort_order, category, name', [T(tenantId)])).rows.map(mMenu); },
    async createMenuItem(i) {
      await q('INSERT INTO menu(id,category,name,price,emoji,image,sort_order,modifier_groups,recipe,sku,barcode,stock,track_stock,active,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
        [i.id, i.category, i.name, i.price, i.emoji, i.image ?? null, i.sortOrder ?? 0, JSON.stringify(i.modifierGroups ?? []), JSON.stringify(i.recipe ?? []), i.sku ?? null, i.barcode ?? null, i.stock ?? null, i.trackStock ?? false, i.active, T(i.tenantId)]);
      return i;
    },
    async updateMenuItem(id, patch) {
      const cur = (await q('SELECT * FROM menu WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mMenu(cur), ...patch };
      await q('UPDATE menu SET category=$2,name=$3,price=$4,emoji=$5,image=$6,sort_order=$7,modifier_groups=$8,recipe=$9,sku=$10,barcode=$11,stock=$12,track_stock=$13,active=$14 WHERE id=$1',
        [id, n.category, n.name, n.price, n.emoji, n.image ?? null, n.sortOrder ?? 0, JSON.stringify(n.modifierGroups ?? []), JSON.stringify(n.recipe ?? []), n.sku ?? null, n.barcode ?? null, n.stock ?? null, n.trackStock ?? false, n.active]);
      return n;
    },
    async deleteMenuItem(id) { await q('DELETE FROM menu WHERE id=$1', [id]); },
    // Atomically add `delta` to a product's stock (retail). Clamps at 0. Returns the product.
    async adjustMenuStock(id, delta) {
      const r = (await q('UPDATE menu SET stock = GREATEST(0, COALESCE(stock,0) + $2) WHERE id=$1 RETURNING *', [id, delta])).rows[0];
      return r ? mMenu(r) : null;
    },
    async findProductByCode(code, tenantId) {
      const k = String(code).trim();
      const rows = (await q('SELECT * FROM menu WHERE tenant_id=$1', [T(tenantId)])).rows.map(mMenu);
      return rows.find(m => (m.barcode && m.barcode === k) || (m.sku && m.sku.toUpperCase() === k.toUpperCase())) || null;
    },

    // tables (tenant-scoped)
    async listTables(tenantId) { return (await q('SELECT * FROM tables WHERE tenant_id=$1 ORDER BY number', [T(tenantId)])).rows.map(mTable); },
    async setTableStatus(number, status, orderId = null, tenantId) {
      await q('UPDATE tables SET status=$2, order_id=$3 WHERE number=$1 AND tenant_id=$4', [number, status, orderId, T(tenantId)]);
    },

    // orders (tenant-scoped)
    async listOrders(status, tenantId) {
      const r = status
        ? await q('SELECT * FROM orders WHERE tenant_id=$2 AND status=$1 ORDER BY created_at', [status, T(tenantId)])
        : await q('SELECT * FROM orders WHERE tenant_id=$1 ORDER BY created_at', [T(tenantId)]);
      return r.rows.map(mOrder);
    },
    async countOrders(tenantId) { return Number((await q('SELECT COUNT(*) AS c FROM orders WHERE tenant_id=$1', [T(tenantId)])).rows[0].c); },
    async getOrder(id) { const r = (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0]; return r ? mOrder(r) : null; },
    async findOrderByExternalId(externalId, tenantId) { const r = (await q('SELECT * FROM orders WHERE external_id=$1 AND tenant_id=$2', [externalId, T(tenantId)])).rows[0]; return r ? mOrder(r) : null; },
    async createOrder(o) {
      await q(`INSERT INTO orders(id,number,table_no,lines,subtotal,tax,total,status,channel,platform,customer,external_id,created_at,fired_at,tenant_id)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [o.id, o.number, o.table, JSON.stringify(o.lines), o.subtotal, o.tax, o.total, o.status,
         o.channel ?? 'pos', o.platform ?? null, o.customer ?? null, o.externalId ?? null, o.createdAt, o.firedAt ?? null, T(o.tenantId)]);
      return o;
    },
    async updateOrder(id, patch) {
      const cur = (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mOrder(cur), ...patch };
      await q('UPDATE orders SET status=$2, fired_at=$3, void_reason=$4 WHERE id=$1',
        [id, n.status, n.firedAt ?? null, n.voidReason ?? null]);
      return n;
    },

    // payments (tenant-scoped)
    async listPayments(tenantId) { return (await q('SELECT * FROM payments WHERE tenant_id=$1 ORDER BY created_at', [T(tenantId)])).rows.map(mPay); },
    async createPayment(p) {
      await q(`INSERT INTO payments(id,order_id,table_no,lines,subtotal,tax,tip,total,method,status,stripe_id,confirmed,created_at,tenant_id)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [p.id, p.orderId, p.table, JSON.stringify(p.lines), p.subtotal, p.tax, p.tip, p.total, p.method, p.status, p.stripeId, p.confirmed ?? false, p.createdAt, T(p.tenantId)]);
      return p;
    },
    async findPaymentByStripeId(stripeId, tenantId) {
      const sql = tenantId == null ? 'SELECT * FROM payments WHERE stripe_id=$1' : 'SELECT * FROM payments WHERE stripe_id=$1 AND tenant_id=$2';
      const r = (await q(sql, tenantId == null ? [stripeId] : [stripeId, T(tenantId)])).rows[0]; return r ? mPay(r) : null;
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

    // users / staff (tenant-scoped)
    async listUsers(tenantId) { return (await q('SELECT * FROM users WHERE tenant_id=$1', [T(tenantId)])).rows.map(mUser); },
    async listStaff(tenantId) { return (await q('SELECT * FROM staff WHERE tenant_id=$1', [T(tenantId)])).rows.map(mStaff); },

    // inventory (tenant-scoped)
    async listInventory(tenantId) { return (await q('SELECT * FROM inventory WHERE tenant_id=$1 ORDER BY name', [T(tenantId)])).rows.map(mInv); },
    async getInventoryItem(id) { const r = (await q('SELECT * FROM inventory WHERE id=$1', [id])).rows[0]; return r ? mInv(r) : null; },
    async createInventoryItem(i) {
      await q('INSERT INTO inventory(id,name,unit,qty,par_level,cost,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [i.id, i.name, i.unit ?? 'unit', i.qty ?? 0, i.parLevel ?? 0, i.cost ?? 0, T(i.tenantId)]);
      return i;
    },
    async updateInventoryItem(id, patch) {
      const cur = (await q('SELECT * FROM inventory WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mInv(cur), ...patch };
      await q('UPDATE inventory SET name=$2,unit=$3,qty=$4,par_level=$5,cost=$6 WHERE id=$1',
        [id, n.name, n.unit ?? 'unit', n.qty ?? 0, n.parLevel ?? 0, n.cost ?? 0]);
      return n;
    },
    async deleteInventoryItem(id) { await q('DELETE FROM inventory WHERE id=$1', [id]); },
    async adjustInventory(id, delta) {
      const r = (await q('UPDATE inventory SET qty = GREATEST(0, qty + $2) WHERE id=$1 RETURNING *', [id, delta])).rows[0];
      return r ? mInv(r) : null;
    },

    // customers / loyalty (tenant-scoped)
    async listCustomers(tenantId) { return (await q('SELECT * FROM customers WHERE tenant_id=$1 ORDER BY points DESC', [T(tenantId)])).rows.map(mCust); },
    async getCustomer(id) { const r = (await q('SELECT * FROM customers WHERE id=$1', [id])).rows[0]; return r ? mCust(r) : null; },
    async findCustomerByPhone(phone, tenantId) {
      const p = String(phone).replace(/\D/g, '');
      const rows = (await q('SELECT * FROM customers WHERE tenant_id=$1', [T(tenantId)])).rows;
      const r = rows.find(x => String(x.phone || '').replace(/\D/g, '') === p);
      return r ? mCust(r) : null;
    },
    async createCustomer(c) {
      await q('INSERT INTO customers(id,name,phone,points,visits,total_spent,tenant_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [c.id, c.name, c.phone, c.points ?? 0, c.visits ?? 0, c.totalSpent ?? 0, T(c.tenantId), c.createdAt ?? Date.now()]);
      return c;
    },
    async updateCustomer(id, patch) {
      const cur = (await q('SELECT * FROM customers WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mCust(cur), ...patch };
      await q('UPDATE customers SET name=$2,phone=$3,points=$4,visits=$5,total_spent=$6 WHERE id=$1',
        [id, n.name, n.phone, n.points ?? 0, n.visits ?? 0, n.totalSpent ?? 0]);
      return n;
    },

    // gift cards (tenant-scoped)
    async listGiftCards(tenantId) { return (await q('SELECT * FROM giftcards WHERE tenant_id=$1 ORDER BY created_at DESC', [T(tenantId)])).rows.map(mGift); },
    async getGiftCardByCode(code, tenantId) {
      const k = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
      const rows = (await q('SELECT * FROM giftcards WHERE tenant_id=$1', [T(tenantId)])).rows;
      const r = rows.find(x => String(x.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === k);
      return r ? mGift(r) : null;
    },
    async createGiftCard(g) {
      await q('INSERT INTO giftcards(id,code,balance,initial_balance,active,tenant_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [g.id, g.code, g.balance ?? 0, g.initialBalance ?? g.balance ?? 0, g.active ?? true, T(g.tenantId), g.createdAt ?? Date.now()]);
      return g;
    },
    async updateGiftCard(id, patch) {
      const cur = (await q('SELECT * FROM giftcards WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mGift(cur), ...patch };
      await q('UPDATE giftcards SET code=$2,balance=$3,initial_balance=$4,active=$5 WHERE id=$1',
        [id, n.code, n.balance ?? 0, n.initialBalance ?? 0, n.active ?? true]);
      return n;
    },
  };
}
