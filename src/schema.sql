-- Tavo POS — PostgreSQL schema (multi-tenant)
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  slug       TEXT UNIQUE,
  plan       TEXT DEFAULT 'free',
  mode       TEXT DEFAULT 'restaurant',
  settings   JSONB DEFAULT '{}',
  created_at BIGINT
);

CREATE TABLE IF NOT EXISTS menu (
  id         TEXT PRIMARY KEY,
  category   TEXT,
  name       TEXT NOT NULL,
  price      NUMERIC(10,2) NOT NULL,
  emoji      TEXT,
  image      TEXT,
  sort_order INTEGER DEFAULT 0,
  modifier_groups JSONB DEFAULT '[]',
  recipe     JSONB DEFAULT '[]',
  sku        TEXT,
  barcode    TEXT,
  stock      NUMERIC(12,3),
  track_stock BOOLEAN DEFAULT FALSE,
  tax_rate   NUMERIC(6,4),
  schedule   JSONB,
  is_combo   BOOLEAN DEFAULT FALSE,
  combo_items JSONB DEFAULT '[]',
  weighted   BOOLEAN DEFAULT FALSE,
  weight_unit TEXT DEFAULT 'lb',
  tenant_id  TEXT DEFAULT 'default',
  active     BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS tables (
  number    INTEGER,
  status    TEXT DEFAULT 'open',
  order_id  TEXT,
  tenant_id TEXT DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS orders (
  id         TEXT PRIMARY KEY,
  number     INTEGER,
  table_no   INTEGER,
  lines      JSONB,
  subtotal   NUMERIC(10,2),
  tax        NUMERIC(10,2),
  total      NUMERIC(10,2),
  status     TEXT,
  void_reason TEXT,
  channel    TEXT DEFAULT 'pos',
  platform   TEXT,
  customer   TEXT,
  external_id TEXT,
  fired_courses JSONB DEFAULT '[]',
  tenant_id  TEXT DEFAULT 'default',
  created_at BIGINT,
  fired_at   BIGINT
);

CREATE TABLE IF NOT EXISTS payments (
  id         TEXT PRIMARY KEY,
  order_id   TEXT,
  table_no   INTEGER,
  lines      JSONB,
  subtotal   NUMERIC(10,2),
  tax        NUMERIC(10,2),
  tip        NUMERIC(10,2),
  total      NUMERIC(10,2),
  method     TEXT,
  status     TEXT,
  stripe_id  TEXT,
  confirmed  BOOLEAN DEFAULT FALSE,
  customer_id TEXT,
  points_earned INTEGER DEFAULT 0,
  points_redeemed INTEGER DEFAULT 0,
  user_id    TEXT,
  user_name  TEXT,
  refunded_amount NUMERIC(10,2) DEFAULT 0,
  refunded_at BIGINT,
  tenant_id  TEXT DEFAULT 'default',
  created_at BIGINT
);

CREATE TABLE IF NOT EXISTS users (
  id        TEXT PRIMARY KEY,
  name      TEXT,
  role      TEXT,
  pin_hash  TEXT,
  tenant_id TEXT DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS staff (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  role          TEXT,
  clocked_in_at BIGINT,
  tenant_id     TEXT DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS inventory (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  unit       TEXT DEFAULT 'unit',
  qty        NUMERIC(12,3) DEFAULT 0,
  par_level  NUMERIC(12,3) DEFAULT 0,
  cost       NUMERIC(10,4) DEFAULT 0,
  tenant_id  TEXT DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  phone       TEXT,
  email       TEXT,
  notes       TEXT,
  marketing_opt_in BOOLEAN DEFAULT TRUE,
  points      INTEGER DEFAULT 0,
  visits      INTEGER DEFAULT 0,
  total_spent NUMERIC(12,2) DEFAULT 0,
  tenant_id   TEXT DEFAULT 'default',
  created_at  BIGINT
);

CREATE TABLE IF NOT EXISTS giftcards (
  id              TEXT PRIMARY KEY,
  code            TEXT,
  balance         NUMERIC(10,2) DEFAULT 0,
  initial_balance NUMERIC(10,2) DEFAULT 0,
  active          BOOLEAN DEFAULT TRUE,
  tenant_id       TEXT DEFAULT 'default',
  created_at      BIGINT
);

CREATE TABLE IF NOT EXISTS drawers (
  id             TEXT PRIMARY KEY,
  opened_by      TEXT,
  opened_at      BIGINT,
  starting_float NUMERIC(10,2) DEFAULT 0,
  paid_in        NUMERIC(10,2) DEFAULT 0,
  paid_out       NUMERIC(10,2) DEFAULT 0,
  closed_by      TEXT,
  closed_at      BIGINT,
  expected       NUMERIC(10,2),
  counted        NUMERIC(10,2),
  variance       NUMERIC(10,2),
  status         TEXT DEFAULT 'open',
  tenant_id      TEXT DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS shifts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  name       TEXT,
  role       TEXT,
  clock_in   BIGINT,
  clock_out  BIGINT,
  break_mins INTEGER DEFAULT 0,
  wage       NUMERIC(10,2) DEFAULT 0,
  status     TEXT DEFAULT 'open',
  tenant_id  TEXT DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel     TEXT,
  kind        TEXT,
  to_addr     TEXT,
  customer_id TEXT,
  campaign_id TEXT,
  subject     TEXT,
  body        TEXT,
  status      TEXT DEFAULT 'sent',
  error       TEXT,
  tenant_id   TEXT DEFAULT 'default',
  created_at  BIGINT
);

CREATE TABLE IF NOT EXISTS campaigns (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  channel     TEXT,
  segment     TEXT,
  subject     TEXT,
  body        TEXT,
  recipients  INTEGER DEFAULT 0,
  sent        INTEGER DEFAULT 0,
  failed      INTEGER DEFAULT 0,
  tenant_id   TEXT DEFAULT 'default',
  created_at  BIGINT
);

CREATE TABLE IF NOT EXISTS vendors (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  contact     TEXT,
  email       TEXT,
  phone       TEXT,
  notes       TEXT,
  tenant_id   TEXT DEFAULT 'default',
  created_at  BIGINT
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id          TEXT PRIMARY KEY,
  vendor_id   TEXT,
  vendor_name TEXT,
  status      TEXT DEFAULT 'draft',
  lines       JSONB DEFAULT '[]',
  total       NUMERIC(12,2) DEFAULT 0,
  notes       TEXT,
  received_at BIGINT,
  tenant_id   TEXT DEFAULT 'default',
  created_at  BIGINT
);

CREATE TABLE IF NOT EXISTS stocktakes (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  status      TEXT DEFAULT 'open',
  counts      JSONB DEFAULT '[]',
  tenant_id   TEXT DEFAULT 'default',
  created_at  BIGINT,
  closed_at   BIGINT
);

CREATE TABLE IF NOT EXISTS reservations (
  id           TEXT PRIMARY KEY,
  kind         TEXT DEFAULT 'reservation',
  name         TEXT,
  phone        TEXT,
  party_size   INTEGER DEFAULT 1,
  time         BIGINT,
  quoted_wait  INTEGER,
  status       TEXT DEFAULT 'booked',
  table_number INTEGER,
  notes        TEXT,
  tenant_id    TEXT DEFAULT 'default',
  created_at   BIGINT,
  seated_at    BIGINT
);

CREATE TABLE IF NOT EXISTS house_accounts (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  contact      TEXT,
  email        TEXT,
  phone        TEXT,
  credit_limit NUMERIC(12,2) DEFAULT 0,
  balance      NUMERIC(12,2) DEFAULT 0,
  tenant_id    TEXT DEFAULT 'default',
  created_at   BIGINT
);

CREATE TABLE IF NOT EXISTS invoices (
  id           TEXT PRIMARY KEY,
  account_id   TEXT,
  account_name TEXT,
  lines        JSONB DEFAULT '[]',
  total        NUMERIC(12,2) DEFAULT 0,
  status       TEXT DEFAULT 'open',
  due_date     BIGINT,
  notes        TEXT,
  tenant_id    TEXT DEFAULT 'default',
  created_at   BIGINT,
  paid_at      BIGINT
);

CREATE TABLE IF NOT EXISTS locations (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  address    TEXT,
  slug       TEXT,
  tenant_id  TEXT DEFAULT 'default',
  created_at BIGINT
);

CREATE TABLE IF NOT EXISTS discount_presets (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  kind       TEXT DEFAULT 'percent',   -- 'percent' | 'amount'
  value      NUMERIC(10,2) DEFAULT 0,
  reason     TEXT,
  scope      TEXT DEFAULT 'check',
  schedule   JSONB,                     -- {days:[0-6], start:'HH:MM', end:'HH:MM'} or NULL for always
  auto_apply BOOLEAN DEFAULT FALSE,     -- auto-apply during its schedule window (happy hour)
  active     BOOLEAN DEFAULT TRUE,
  tenant_id  TEXT DEFAULT 'default',
  created_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_payments_stripe ON payments(stripe_id);
