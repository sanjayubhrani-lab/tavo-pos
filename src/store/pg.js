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
  taxRate: r.tax_rate == null ? null : num(r.tax_rate), schedule: r.schedule ?? null, isCombo: r.is_combo ?? false, comboItems: r.combo_items ?? [],
  weighted: r.weighted ?? false, weightUnit: r.weight_unit ?? 'lb',
  active: r.active, tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mVendor = r => ({ id: r.id, name: r.name, contact: r.contact ?? '', email: r.email ?? '', phone: r.phone ?? '', notes: r.notes ?? '', tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at) });
const mPO = r => ({ id: r.id, vendorId: r.vendor_id ?? null, vendorName: r.vendor_name ?? '', status: r.status, lines: r.lines ?? [], total: num(r.total) || 0, notes: r.notes ?? '', receivedAt: r.received_at == null ? null : num(r.received_at), tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at) });
const mStocktake = r => ({ id: r.id, name: r.name, status: r.status, counts: r.counts ?? [], tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at), closedAt: r.closed_at == null ? null : num(r.closed_at) });
const mResv = r => ({ id: r.id, kind: r.kind, name: r.name, phone: r.phone ?? '', partySize: num(r.party_size) || 1, time: r.time == null ? null : num(r.time), quotedWait: r.quoted_wait == null ? null : num(r.quoted_wait), status: r.status, tableNumber: r.table_number == null ? null : num(r.table_number), notes: r.notes ?? '', tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at), seatedAt: r.seated_at == null ? null : num(r.seated_at) });
const mHouse = r => ({ id: r.id, name: r.name, contact: r.contact ?? '', email: r.email ?? '', phone: r.phone ?? '', creditLimit: num(r.credit_limit) || 0, balance: num(r.balance) || 0, tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at) });
const mInvoice = r => ({ id: r.id, accountId: r.account_id, accountName: r.account_name ?? '', lines: r.lines ?? [], total: num(r.total) || 0, status: r.status, dueDate: r.due_date == null ? null : num(r.due_date), notes: r.notes ?? '', tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at), paidAt: r.paid_at == null ? null : num(r.paid_at) });
const mLocation = r => ({ id: r.id, name: r.name, address: r.address ?? '', slug: r.slug, tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at) });
const mInv = r => ({ id: r.id, name: r.name, unit: r.unit ?? 'unit', qty: num(r.qty) || 0, parLevel: num(r.par_level) || 0, cost: num(r.cost) || 0, tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mCust = r => ({ id: r.id, name: r.name, phone: r.phone, email: r.email ?? null, notes: r.notes ?? '', marketingOptIn: r.marketing_opt_in !== false, points: num(r.points) || 0, visits: num(r.visits) || 0, totalSpent: num(r.total_spent) || 0, tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at) });
const mMsg = r => ({ id: r.id, channel: r.channel, kind: r.kind, to: r.to_addr, customerId: r.customer_id ?? null, campaignId: r.campaign_id ?? null, subject: r.subject ?? '', body: r.body ?? '', status: r.status, error: r.error ?? null, tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at) });
const mCampaign = r => ({ id: r.id, name: r.name, channel: r.channel, segment: r.segment, subject: r.subject ?? '', body: r.body ?? '', recipients: num(r.recipients) || 0, sent: num(r.sent) || 0, failed: num(r.failed) || 0, tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at) });
const mGift = r => ({ id: r.id, code: r.code, balance: num(r.balance) || 0, initialBalance: num(r.initial_balance) || 0, active: r.active, tenantId: r.tenant_id ?? DEFAULT_TENANT, createdAt: num(r.created_at) });
const mShift = r => ({ id: r.id, userId: r.user_id, name: r.name, role: r.role, clockIn: num(r.clock_in), clockOut: r.clock_out == null ? null : num(r.clock_out),
  breakMins: num(r.break_mins) || 0, wage: num(r.wage) || 0, status: r.status, tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mDrawer = r => ({ id: r.id, openedBy: r.opened_by, openedAt: num(r.opened_at), startingFloat: num(r.starting_float) || 0,
  paidIn: num(r.paid_in) || 0, paidOut: num(r.paid_out) || 0, closedBy: r.closed_by ?? null, closedAt: r.closed_at == null ? null : num(r.closed_at),
  expected: r.expected == null ? null : num(r.expected), counted: r.counted == null ? null : num(r.counted), variance: r.variance == null ? null : num(r.variance),
  status: r.status, tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mTable = r => ({ number: num(r.number), status: r.status, orderId: r.order_id, tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mOrder = r => ({ id: r.id, number: num(r.number), table: r.table_no == null ? null : num(r.table_no),
  lines: r.lines, subtotal: num(r.subtotal), tax: num(r.tax), total: num(r.total),
  status: r.status, voidReason: r.void_reason ?? null,
  channel: r.channel ?? 'pos', platform: r.platform ?? null, customer: r.customer ?? null, externalId: r.external_id ?? null,
  firedCourses: r.fired_courses ?? [],
  createdAt: num(r.created_at), firedAt: r.fired_at == null ? undefined : num(r.fired_at), tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mPay = r => ({ id: r.id, orderId: r.order_id, table: r.table_no == null ? null : num(r.table_no),
  lines: r.lines, subtotal: num(r.subtotal), tax: num(r.tax), tip: num(r.tip), total: num(r.total),
  discount: num(r.discount) || 0, discountReason: r.discount_reason ?? null, serviceCharge: num(r.service_charge) || 0,
  method: r.method, status: r.status, stripeId: r.stripe_id, confirmed: r.confirmed,
  customerId: r.customer_id ?? null, pointsEarned: num(r.points_earned) || 0, pointsRedeemed: num(r.points_redeemed) || 0,
  userId: r.user_id ?? null, userName: r.user_name ?? null,
  refundedAmount: num(r.refunded_amount) || 0, refundedAt: r.refunded_at == null ? null : num(r.refunded_at),
  createdAt: num(r.created_at), tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mUser = r => ({ id: r.id, name: r.name, role: r.role, pinHash: r.pin_hash, tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mStaff = r => ({ id: r.id, name: r.name, role: r.role, clockedInAt: r.clocked_in_at == null ? null : num(r.clocked_in_at), tenantId: r.tenant_id ?? DEFAULT_TENANT });
const mTenant = r => ({ id: r.id, name: r.name, slug: r.slug, plan: r.plan, mode: r.mode ?? 'restaurant', settings: r.settings ?? {}, createdAt: num(r.created_at) });

// Insert one tenant's rows (stamped with tenant_id) without wiping others.
async function insertSeed(q, { menu = [], tables = [], staff = [], users = [], inventory = [] }) {
  for (const m of menu)
    await q('INSERT INTO menu(id,category,name,price,emoji,image,sort_order,modifier_groups,recipe,sku,barcode,stock,track_stock,tax_rate,schedule,is_combo,combo_items,active,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',
      [m.id, m.category, m.name, m.price, m.emoji, m.image ?? null, m.sortOrder ?? 0, JSON.stringify(m.modifierGroups ?? []), JSON.stringify(m.recipe ?? []), m.sku ?? null, m.barcode ?? null, m.stock ?? null, m.trackStock ?? false, m.taxRate ?? null, m.schedule ? JSON.stringify(m.schedule) : null, m.isCombo ?? false, JSON.stringify(m.comboItems ?? []), m.active, T(m.tenantId)]);
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
        "ALTER TABLE orders ADD COLUMN fired_courses JSONB DEFAULT '[]'",
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
        `CREATE TABLE IF NOT EXISTS drawers (
           id TEXT PRIMARY KEY, opened_by TEXT, opened_at BIGINT, starting_float NUMERIC(10,2) DEFAULT 0,
           paid_in NUMERIC(10,2) DEFAULT 0, paid_out NUMERIC(10,2) DEFAULT 0, closed_by TEXT, closed_at BIGINT,
           expected NUMERIC(10,2), counted NUMERIC(10,2), variance NUMERIC(10,2),
           status TEXT DEFAULT 'open', tenant_id TEXT DEFAULT 'default')`,
        `CREATE TABLE IF NOT EXISTS shifts (
           id TEXT PRIMARY KEY, user_id TEXT, name TEXT, role TEXT, clock_in BIGINT, clock_out BIGINT,
           break_mins INTEGER DEFAULT 0, wage NUMERIC(10,2) DEFAULT 0, status TEXT DEFAULT 'open', tenant_id TEXT DEFAULT 'default')`,
        // retail mode: business type + product SKU/barcode/stock
        "ALTER TABLE tenants ADD COLUMN mode TEXT DEFAULT 'restaurant'",
        "ALTER TABLE tenants ADD COLUMN settings JSONB DEFAULT '{}'",
        'ALTER TABLE payments ADD COLUMN discount NUMERIC(10,2) DEFAULT 0',
        'ALTER TABLE payments ADD COLUMN discount_reason TEXT',
        'ALTER TABLE payments ADD COLUMN service_charge NUMERIC(10,2) DEFAULT 0',
        // CRM: link payments to a customer (for profile order history + digital receipts)
        'ALTER TABLE payments ADD COLUMN customer_id TEXT',
        'ALTER TABLE payments ADD COLUMN points_earned INTEGER DEFAULT 0',
        'ALTER TABLE payments ADD COLUMN points_redeemed INTEGER DEFAULT 0',
        // reporting: which staff member rang the sale
        'ALTER TABLE payments ADD COLUMN user_id TEXT',
        'ALTER TABLE payments ADD COLUMN user_name TEXT',
        'ALTER TABLE menu ADD COLUMN sku TEXT',
        'ALTER TABLE menu ADD COLUMN barcode TEXT',
        'ALTER TABLE menu ADD COLUMN stock NUMERIC(12,3)',
        'ALTER TABLE menu ADD COLUMN track_stock BOOLEAN DEFAULT FALSE',
        // menu sophistication: per-item tax, dayparting schedule, combos
        'ALTER TABLE menu ADD COLUMN tax_rate NUMERIC(6,4)',
        'ALTER TABLE menu ADD COLUMN schedule JSONB',
        'ALTER TABLE menu ADD COLUMN is_combo BOOLEAN DEFAULT FALSE',
        "ALTER TABLE menu ADD COLUMN combo_items JSONB DEFAULT '[]'",
        // CRM: richer customer profile
        'ALTER TABLE customers ADD COLUMN email TEXT',
        'ALTER TABLE customers ADD COLUMN notes TEXT',
        'ALTER TABLE customers ADD COLUMN marketing_opt_in BOOLEAN DEFAULT TRUE',
        // messaging: digital receipts + marketing sends
        `CREATE TABLE IF NOT EXISTS messages (
           id TEXT PRIMARY KEY, channel TEXT, kind TEXT, to_addr TEXT, customer_id TEXT, campaign_id TEXT,
           subject TEXT, body TEXT, status TEXT DEFAULT 'sent', error TEXT,
           tenant_id TEXT DEFAULT 'default', created_at BIGINT)`,
        `CREATE TABLE IF NOT EXISTS campaigns (
           id TEXT PRIMARY KEY, name TEXT, channel TEXT, segment TEXT, subject TEXT, body TEXT,
           recipients INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
           tenant_id TEXT DEFAULT 'default', created_at BIGINT)`,
        // retail depth: weighted items
        'ALTER TABLE menu ADD COLUMN weighted BOOLEAN DEFAULT FALSE',
        "ALTER TABLE menu ADD COLUMN weight_unit TEXT DEFAULT 'lb'",
        // purchasing + stock control
        `CREATE TABLE IF NOT EXISTS vendors (
           id TEXT PRIMARY KEY, name TEXT, contact TEXT, email TEXT, phone TEXT, notes TEXT,
           tenant_id TEXT DEFAULT 'default', created_at BIGINT)`,
        `CREATE TABLE IF NOT EXISTS purchase_orders (
           id TEXT PRIMARY KEY, vendor_id TEXT, vendor_name TEXT, status TEXT DEFAULT 'draft',
           lines JSONB DEFAULT '[]', total NUMERIC(12,2) DEFAULT 0, notes TEXT, received_at BIGINT,
           tenant_id TEXT DEFAULT 'default', created_at BIGINT)`,
        `CREATE TABLE IF NOT EXISTS stocktakes (
           id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'open', counts JSONB DEFAULT '[]',
           tenant_id TEXT DEFAULT 'default', created_at BIGINT, closed_at BIGINT)`,
        // reservations + waitlist
        `CREATE TABLE IF NOT EXISTS reservations (
           id TEXT PRIMARY KEY, kind TEXT DEFAULT 'reservation', name TEXT, phone TEXT, party_size INTEGER DEFAULT 1,
           time BIGINT, quoted_wait INTEGER, status TEXT DEFAULT 'booked', table_number INTEGER, notes TEXT,
           tenant_id TEXT DEFAULT 'default', created_at BIGINT, seated_at BIGINT)`,
        // house accounts + invoicing
        `CREATE TABLE IF NOT EXISTS house_accounts (
           id TEXT PRIMARY KEY, name TEXT, contact TEXT, email TEXT, phone TEXT,
           credit_limit NUMERIC(12,2) DEFAULT 0, balance NUMERIC(12,2) DEFAULT 0,
           tenant_id TEXT DEFAULT 'default', created_at BIGINT)`,
        `CREATE TABLE IF NOT EXISTS invoices (
           id TEXT PRIMARY KEY, account_id TEXT, account_name TEXT, lines JSONB DEFAULT '[]',
           total NUMERIC(12,2) DEFAULT 0, status TEXT DEFAULT 'open', due_date BIGINT, notes TEXT,
           tenant_id TEXT DEFAULT 'default', created_at BIGINT, paid_at BIGINT)`,
        // multi-location registry
        `CREATE TABLE IF NOT EXISTS locations (
           id TEXT PRIMARY KEY, name TEXT, address TEXT, slug TEXT,
           tenant_id TEXT DEFAULT 'default', created_at BIGINT)`,
      ];
      for (const u of upgrades) { try { await q(u); } catch { /* column already present */ } }
    },

    // ---- tenants ----
    async createTenant(t) {
      await q('INSERT INTO tenants(id,name,slug,plan,mode,settings,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [t.id, t.name, t.slug, t.plan ?? 'free', t.mode ?? 'restaurant', JSON.stringify(t.settings ?? {}), t.createdAt ?? Date.now()]);
      return t;
    },
    async updateTenant(id, patch) {
      const cur = (await q('SELECT * FROM tenants WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mTenant(cur), ...patch };
      await q('UPDATE tenants SET name=$2,mode=$3,settings=$4 WHERE id=$1', [id, n.name, n.mode ?? 'restaurant', JSON.stringify(n.settings ?? {})]);
      return n;
    },
    async getTenant(id) { const r = (await q('SELECT * FROM tenants WHERE id=$1', [id])).rows[0]; return r ? mTenant(r) : null; },
    async getTenantBySlug(slug) { const r = (await q('SELECT * FROM tenants WHERE slug=$1', [slug])).rows[0]; return r ? mTenant(r) : null; },
    async listTenants() { return (await q('SELECT * FROM tenants ORDER BY created_at')).rows.map(mTenant); },
    async seedTenant(data) { await insertSeed(q, data); },

    async reset({ menu = [], tables = [], staff = [], users = [], inventory = [], tenants } = {}) {
      for (const t of ['menu', 'tables', 'orders', 'payments', 'users', 'staff', 'inventory', 'customers', 'giftcards', 'drawers', 'shifts', 'messages', 'campaigns', 'vendors', 'purchase_orders', 'stocktakes', 'reservations', 'house_accounts', 'invoices', 'locations', 'tenants'])
        await q(`DELETE FROM ${t}`);
      const tlist = tenants || [{ id: DEFAULT_TENANT, name: 'Default', slug: DEFAULT_TENANT, plan: 'free', mode: 'restaurant', createdAt: Date.now() }];
      for (const t of tlist)
        await q('INSERT INTO tenants(id,name,slug,plan,mode,settings,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [t.id, t.name, t.slug, t.plan ?? 'free', t.mode ?? 'restaurant', JSON.stringify(t.settings ?? {}), t.createdAt ?? Date.now()]);
      await insertSeed(q, { menu, tables, staff, users, inventory });
    },

    // menu (tenant-scoped)
    async listMenu(tenantId) { return (await q('SELECT * FROM menu WHERE tenant_id=$1 ORDER BY sort_order, category, name', [T(tenantId)])).rows.map(mMenu); },
    async createMenuItem(i) {
      await q('INSERT INTO menu(id,category,name,price,emoji,image,sort_order,modifier_groups,recipe,sku,barcode,stock,track_stock,tax_rate,schedule,is_combo,combo_items,weighted,weight_unit,active,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)',
        [i.id, i.category, i.name, i.price, i.emoji, i.image ?? null, i.sortOrder ?? 0, JSON.stringify(i.modifierGroups ?? []), JSON.stringify(i.recipe ?? []), i.sku ?? null, i.barcode ?? null, i.stock ?? null, i.trackStock ?? false, i.taxRate ?? null, i.schedule ? JSON.stringify(i.schedule) : null, i.isCombo ?? false, JSON.stringify(i.comboItems ?? []), i.weighted ?? false, i.weightUnit ?? 'lb', i.active, T(i.tenantId)]);
      return i;
    },
    async updateMenuItem(id, patch) {
      const cur = (await q('SELECT * FROM menu WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mMenu(cur), ...patch };
      await q('UPDATE menu SET category=$2,name=$3,price=$4,emoji=$5,image=$6,sort_order=$7,modifier_groups=$8,recipe=$9,sku=$10,barcode=$11,stock=$12,track_stock=$13,tax_rate=$14,schedule=$15,is_combo=$16,combo_items=$17,weighted=$18,weight_unit=$19,active=$20 WHERE id=$1',
        [id, n.category, n.name, n.price, n.emoji, n.image ?? null, n.sortOrder ?? 0, JSON.stringify(n.modifierGroups ?? []), JSON.stringify(n.recipe ?? []), n.sku ?? null, n.barcode ?? null, n.stock ?? null, n.trackStock ?? false, n.taxRate ?? null, n.schedule ? JSON.stringify(n.schedule) : null, n.isCombo ?? false, JSON.stringify(n.comboItems ?? []), n.weighted ?? false, n.weightUnit ?? 'lb', n.active]);
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
      await q(`INSERT INTO orders(id,number,table_no,lines,subtotal,tax,total,status,channel,platform,customer,external_id,fired_courses,created_at,fired_at,tenant_id)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [o.id, o.number, o.table, JSON.stringify(o.lines), o.subtotal, o.tax, o.total, o.status,
         o.channel ?? 'pos', o.platform ?? null, o.customer ?? null, o.externalId ?? null, JSON.stringify(o.firedCourses ?? []), o.createdAt, o.firedAt ?? null, T(o.tenantId)]);
      return o;
    },
    async updateOrder(id, patch) {
      const cur = (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mOrder(cur), ...patch };
      await q('UPDATE orders SET status=$2, fired_at=$3, void_reason=$4, fired_courses=$5 WHERE id=$1',
        [id, n.status, n.firedAt ?? null, n.voidReason ?? null, JSON.stringify(n.firedCourses ?? [])]);
      return n;
    },

    // payments (tenant-scoped)
    async listPayments(tenantId) { return (await q('SELECT * FROM payments WHERE tenant_id=$1 ORDER BY created_at', [T(tenantId)])).rows.map(mPay); },
    async createPayment(p) {
      await q(`INSERT INTO payments(id,order_id,table_no,lines,subtotal,tax,tip,total,discount,discount_reason,service_charge,method,status,stripe_id,confirmed,customer_id,points_earned,points_redeemed,user_id,user_name,created_at,tenant_id)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [p.id, p.orderId, p.table, JSON.stringify(p.lines), p.subtotal, p.tax, p.tip, p.total, p.discount ?? 0, p.discountReason ?? null, p.serviceCharge ?? 0, p.method, p.status, p.stripeId, p.confirmed ?? false, p.customerId ?? null, p.pointsEarned ?? 0, p.pointsRedeemed ?? 0, p.userId ?? null, p.userName ?? null, p.createdAt, T(p.tenantId)]);
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
      await q('INSERT INTO customers(id,name,phone,email,notes,marketing_opt_in,points,visits,total_spent,tenant_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [c.id, c.name, c.phone, c.email ?? null, c.notes ?? '', c.marketingOptIn !== false, c.points ?? 0, c.visits ?? 0, c.totalSpent ?? 0, T(c.tenantId), c.createdAt ?? Date.now()]);
      return c;
    },
    async updateCustomer(id, patch) {
      const cur = (await q('SELECT * FROM customers WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mCust(cur), ...patch };
      await q('UPDATE customers SET name=$2,phone=$3,email=$4,notes=$5,marketing_opt_in=$6,points=$7,visits=$8,total_spent=$9 WHERE id=$1',
        [id, n.name, n.phone, n.email ?? null, n.notes ?? '', n.marketingOptIn !== false, n.points ?? 0, n.visits ?? 0, n.totalSpent ?? 0]);
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

    // cash drawer sessions (tenant-scoped)
    async getOpenDrawer(tenantId) { const r = (await q("SELECT * FROM drawers WHERE tenant_id=$1 AND status='open' ORDER BY opened_at DESC LIMIT 1", [T(tenantId)])).rows[0]; return r ? mDrawer(r) : null; },
    async getDrawer(id) { const r = (await q('SELECT * FROM drawers WHERE id=$1', [id])).rows[0]; return r ? mDrawer(r) : null; },
    async listDrawers(tenantId) { return (await q('SELECT * FROM drawers WHERE tenant_id=$1 ORDER BY opened_at DESC', [T(tenantId)])).rows.map(mDrawer); },
    async createDrawer(d) {
      await q('INSERT INTO drawers(id,opened_by,opened_at,starting_float,paid_in,paid_out,status,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [d.id, d.openedBy, d.openedAt, d.startingFloat ?? 0, d.paidIn ?? 0, d.paidOut ?? 0, d.status ?? 'open', T(d.tenantId)]);
      return d;
    },
    async updateDrawer(id, patch) {
      const cur = (await q('SELECT * FROM drawers WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mDrawer(cur), ...patch };
      await q('UPDATE drawers SET paid_in=$2,paid_out=$3,closed_by=$4,closed_at=$5,expected=$6,counted=$7,variance=$8,status=$9 WHERE id=$1',
        [id, n.paidIn ?? 0, n.paidOut ?? 0, n.closedBy ?? null, n.closedAt ?? null, n.expected ?? null, n.counted ?? null, n.variance ?? null, n.status]);
      return n;
    },

    // shifts / time clock (tenant-scoped)
    async listShifts(tenantId) { return (await q('SELECT * FROM shifts WHERE tenant_id=$1 ORDER BY clock_in DESC', [T(tenantId)])).rows.map(mShift); },
    async getShift(id) { const r = (await q('SELECT * FROM shifts WHERE id=$1', [id])).rows[0]; return r ? mShift(r) : null; },
    async getOpenShiftFor(userId, tenantId) { const r = (await q("SELECT * FROM shifts WHERE tenant_id=$1 AND user_id=$2 AND status='open' ORDER BY clock_in DESC LIMIT 1", [T(tenantId), userId])).rows[0]; return r ? mShift(r) : null; },
    async createShift(s) {
      await q('INSERT INTO shifts(id,user_id,name,role,clock_in,clock_out,break_mins,wage,status,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [s.id, s.userId, s.name, s.role, s.clockIn, s.clockOut ?? null, s.breakMins ?? 0, s.wage ?? 0, s.status ?? 'open', T(s.tenantId)]);
      return s;
    },
    async updateShift(id, patch) {
      const cur = (await q('SELECT * FROM shifts WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mShift(cur), ...patch };
      await q('UPDATE shifts SET clock_out=$2,break_mins=$3,wage=$4,status=$5 WHERE id=$1',
        [id, n.clockOut ?? null, n.breakMins ?? 0, n.wage ?? 0, n.status]);
      return n;
    },

    // messages (digital receipts + marketing sends) (tenant-scoped)
    async listMessages(tenantId) { return (await q('SELECT * FROM messages WHERE tenant_id=$1 ORDER BY created_at DESC', [T(tenantId)])).rows.map(mMsg); },
    async createMessage(m) {
      await q('INSERT INTO messages(id,channel,kind,to_addr,customer_id,campaign_id,subject,body,status,error,tenant_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [m.id, m.channel, m.kind, m.to, m.customerId ?? null, m.campaignId ?? null, m.subject ?? '', m.body ?? '', m.status ?? 'sent', m.error ?? null, T(m.tenantId), m.createdAt ?? Date.now()]);
      return m;
    },
    async updateMessage(id, patch) {
      const cur = (await q('SELECT * FROM messages WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mMsg(cur), ...patch };
      await q('UPDATE messages SET status=$2,error=$3 WHERE id=$1', [id, n.status, n.error ?? null]);
      return n;
    },

    // marketing campaigns (tenant-scoped)
    async listCampaigns(tenantId) { return (await q('SELECT * FROM campaigns WHERE tenant_id=$1 ORDER BY created_at DESC', [T(tenantId)])).rows.map(mCampaign); },
    async getCampaign(id) { const r = (await q('SELECT * FROM campaigns WHERE id=$1', [id])).rows[0]; return r ? mCampaign(r) : null; },
    async createCampaign(c) {
      await q('INSERT INTO campaigns(id,name,channel,segment,subject,body,recipients,sent,failed,tenant_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [c.id, c.name, c.channel, c.segment, c.subject ?? '', c.body ?? '', c.recipients ?? 0, c.sent ?? 0, c.failed ?? 0, T(c.tenantId), c.createdAt ?? Date.now()]);
      return c;
    },
    async updateCampaign(id, patch) {
      const cur = (await q('SELECT * FROM campaigns WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mCampaign(cur), ...patch };
      await q('UPDATE campaigns SET recipients=$2,sent=$3,failed=$4 WHERE id=$1', [id, n.recipients ?? 0, n.sent ?? 0, n.failed ?? 0]);
      return n;
    },

    // vendors / suppliers (tenant-scoped)
    async listVendors(tenantId) { return (await q('SELECT * FROM vendors WHERE tenant_id=$1 ORDER BY name', [T(tenantId)])).rows.map(mVendor); },
    async getVendor(id) { const r = (await q('SELECT * FROM vendors WHERE id=$1', [id])).rows[0]; return r ? mVendor(r) : null; },
    async createVendor(v) {
      await q('INSERT INTO vendors(id,name,contact,email,phone,notes,tenant_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [v.id, v.name, v.contact ?? '', v.email ?? '', v.phone ?? '', v.notes ?? '', T(v.tenantId), v.createdAt ?? Date.now()]);
      return v;
    },
    async updateVendor(id, patch) {
      const cur = (await q('SELECT * FROM vendors WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mVendor(cur), ...patch };
      await q('UPDATE vendors SET name=$2,contact=$3,email=$4,phone=$5,notes=$6 WHERE id=$1', [id, n.name, n.contact ?? '', n.email ?? '', n.phone ?? '', n.notes ?? '']);
      return n;
    },
    async deleteVendor(id) { await q('DELETE FROM vendors WHERE id=$1', [id]); },

    // purchase orders (tenant-scoped)
    async listPurchaseOrders(tenantId) { return (await q('SELECT * FROM purchase_orders WHERE tenant_id=$1 ORDER BY created_at DESC', [T(tenantId)])).rows.map(mPO); },
    async getPurchaseOrder(id) { const r = (await q('SELECT * FROM purchase_orders WHERE id=$1', [id])).rows[0]; return r ? mPO(r) : null; },
    async createPurchaseOrder(p) {
      await q('INSERT INTO purchase_orders(id,vendor_id,vendor_name,status,lines,total,notes,received_at,tenant_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [p.id, p.vendorId ?? null, p.vendorName ?? '', p.status ?? 'draft', JSON.stringify(p.lines ?? []), p.total ?? 0, p.notes ?? '', p.receivedAt ?? null, T(p.tenantId), p.createdAt ?? Date.now()]);
      return p;
    },
    async updatePurchaseOrder(id, patch) {
      const cur = (await q('SELECT * FROM purchase_orders WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mPO(cur), ...patch };
      await q('UPDATE purchase_orders SET vendor_id=$2,vendor_name=$3,status=$4,lines=$5,total=$6,notes=$7,received_at=$8 WHERE id=$1',
        [id, n.vendorId ?? null, n.vendorName ?? '', n.status, JSON.stringify(n.lines ?? []), n.total ?? 0, n.notes ?? '', n.receivedAt ?? null]);
      return n;
    },

    // stocktakes / cycle counts (tenant-scoped)
    async listStocktakes(tenantId) { return (await q('SELECT * FROM stocktakes WHERE tenant_id=$1 ORDER BY created_at DESC', [T(tenantId)])).rows.map(mStocktake); },
    async getStocktake(id) { const r = (await q('SELECT * FROM stocktakes WHERE id=$1', [id])).rows[0]; return r ? mStocktake(r) : null; },
    async createStocktake(s) {
      await q('INSERT INTO stocktakes(id,name,status,counts,tenant_id,created_at,closed_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [s.id, s.name, s.status ?? 'open', JSON.stringify(s.counts ?? []), T(s.tenantId), s.createdAt ?? Date.now(), s.closedAt ?? null]);
      return s;
    },
    async updateStocktake(id, patch) {
      const cur = (await q('SELECT * FROM stocktakes WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mStocktake(cur), ...patch };
      await q('UPDATE stocktakes SET name=$2,status=$3,counts=$4,closed_at=$5 WHERE id=$1', [id, n.name, n.status, JSON.stringify(n.counts ?? []), n.closedAt ?? null]);
      return n;
    },

    // reservations + waitlist (tenant-scoped)
    async listReservations(tenantId) { return (await q('SELECT * FROM reservations WHERE tenant_id=$1 ORDER BY COALESCE(time, created_at)', [T(tenantId)])).rows.map(mResv); },
    async getReservation(id) { const r = (await q('SELECT * FROM reservations WHERE id=$1', [id])).rows[0]; return r ? mResv(r) : null; },
    async createReservation(r) {
      await q('INSERT INTO reservations(id,kind,name,phone,party_size,time,quoted_wait,status,table_number,notes,tenant_id,created_at,seated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
        [r.id, r.kind ?? 'reservation', r.name, r.phone ?? '', r.partySize ?? 1, r.time ?? null, r.quotedWait ?? null, r.status ?? 'booked', r.tableNumber ?? null, r.notes ?? '', T(r.tenantId), r.createdAt ?? Date.now(), r.seatedAt ?? null]);
      return r;
    },
    async updateReservation(id, patch) {
      const cur = (await q('SELECT * FROM reservations WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mResv(cur), ...patch };
      await q('UPDATE reservations SET kind=$2,name=$3,phone=$4,party_size=$5,time=$6,quoted_wait=$7,status=$8,table_number=$9,notes=$10,seated_at=$11 WHERE id=$1',
        [id, n.kind, n.name, n.phone ?? '', n.partySize ?? 1, n.time ?? null, n.quotedWait ?? null, n.status, n.tableNumber ?? null, n.notes ?? '', n.seatedAt ?? null]);
      return n;
    },

    // house accounts (tenant-scoped)
    async listHouseAccounts(tenantId) { return (await q('SELECT * FROM house_accounts WHERE tenant_id=$1 ORDER BY name', [T(tenantId)])).rows.map(mHouse); },
    async getHouseAccount(id) { const r = (await q('SELECT * FROM house_accounts WHERE id=$1', [id])).rows[0]; return r ? mHouse(r) : null; },
    async createHouseAccount(a) {
      await q('INSERT INTO house_accounts(id,name,contact,email,phone,credit_limit,balance,tenant_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [a.id, a.name, a.contact ?? '', a.email ?? '', a.phone ?? '', a.creditLimit ?? 0, a.balance ?? 0, T(a.tenantId), a.createdAt ?? Date.now()]);
      return a;
    },
    async updateHouseAccount(id, patch) {
      const cur = (await q('SELECT * FROM house_accounts WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mHouse(cur), ...patch };
      await q('UPDATE house_accounts SET name=$2,contact=$3,email=$4,phone=$5,credit_limit=$6,balance=$7 WHERE id=$1',
        [id, n.name, n.contact ?? '', n.email ?? '', n.phone ?? '', n.creditLimit ?? 0, n.balance ?? 0]);
      return n;
    },

    // invoices (tenant-scoped)
    async listInvoices(tenantId) { return (await q('SELECT * FROM invoices WHERE tenant_id=$1 ORDER BY created_at DESC', [T(tenantId)])).rows.map(mInvoice); },
    async getInvoice(id) { const r = (await q('SELECT * FROM invoices WHERE id=$1', [id])).rows[0]; return r ? mInvoice(r) : null; },
    async createInvoice(i) {
      await q('INSERT INTO invoices(id,account_id,account_name,lines,total,status,due_date,notes,tenant_id,created_at,paid_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [i.id, i.accountId, i.accountName ?? '', JSON.stringify(i.lines ?? []), i.total ?? 0, i.status ?? 'open', i.dueDate ?? null, i.notes ?? '', T(i.tenantId), i.createdAt ?? Date.now(), i.paidAt ?? null]);
      return i;
    },
    async updateInvoice(id, patch) {
      const cur = (await q('SELECT * FROM invoices WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mInvoice(cur), ...patch };
      await q('UPDATE invoices SET status=$2,paid_at=$3,notes=$4 WHERE id=$1', [id, n.status, n.paidAt ?? null, n.notes ?? '']);
      return n;
    },

    // locations (multi-site registry, tenant-scoped)
    async listLocations(tenantId) { return (await q('SELECT * FROM locations WHERE tenant_id=$1 ORDER BY name', [T(tenantId)])).rows.map(mLocation); },
    async getLocation(id) { const r = (await q('SELECT * FROM locations WHERE id=$1', [id])).rows[0]; return r ? mLocation(r) : null; },
    async createLocation(l) {
      await q('INSERT INTO locations(id,name,address,slug,tenant_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [l.id, l.name, l.address ?? '', l.slug, T(l.tenantId), l.createdAt ?? Date.now()]);
      return l;
    },
    async updateLocation(id, patch) {
      const cur = (await q('SELECT * FROM locations WHERE id=$1', [id])).rows[0];
      if (!cur) return null; const n = { ...mLocation(cur), ...patch };
      await q('UPDATE locations SET name=$2,address=$3,slug=$4 WHERE id=$1', [id, n.name, n.address ?? '', n.slug]);
      return n;
    },
    async deleteLocation(id) { await q('DELETE FROM locations WHERE id=$1', [id]); },
  };
}
