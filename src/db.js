// Tiny zero-dependency JSON file database.
// Good enough to launch a prototype; swap for Postgres/MySQL when you scale.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

const DEFAULTS = {
  menu: [],        // {id, category, name, price, emoji, active}
  orders: [],      // {id, table, lines, status, createdAt}
  payments: [],    // {id, orderId, subtotal, tax, tip, total, method, status, stripeId, createdAt}
  tables: [],      // {number, status, orderId}
  staff: [],       // {id, name, role, clockedInAt, tenantId}
  users: [],       // {id, name, role, pinHash, tenantId}  — login accounts
  tenants: [],     // {id, name, slug, plan, createdAt}  — businesses on the platform
  inventory: [],   // {id, name, unit, qty, parLevel, cost, tenantId}  — stock / ingredients
  customers: [],   // {id, name, phone, points, visits, totalSpent, tenantId, createdAt}  — loyalty members
  giftcards: [],   // {id, code, balance, initialBalance, active, tenantId, createdAt}  — gift cards
  drawers: [],     // {id, openedBy, openedAt, startingFloat, paidIn, paidOut, status, ...}  — cash drawer sessions
  shifts: []       // {id, userId, name, role, clockIn, clockOut, breakMins, wage, status, tenantId}  — time clock
};

function ensureFile() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULTS, null, 2));
}

export function read() {
  ensureFile();
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function write(data) {
  ensureFile();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  return data;
}

// Convenience: mutate the db with a callback and persist.
export function update(fn) {
  const db = read();
  const result = fn(db);
  write(db);
  return result;
}
