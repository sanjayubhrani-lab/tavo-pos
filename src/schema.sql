-- Tavo POS — PostgreSQL schema (multi-tenant)
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  slug       TEXT UNIQUE,
  plan       TEXT DEFAULT 'free',
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

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_payments_stripe ON payments(stripe_id);
