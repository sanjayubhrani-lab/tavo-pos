// Builds the default starter dataset (menu, tables, staff, login users).
// Shared by the manual `npm run seed` and the automatic seed-if-empty on boot.
import { MENU_SEED, STAFF_SEED } from './data/menu.seed.js';
import { hashPin } from './auth.js';
import { nanoid } from 'nanoid';

// Demo PINs — override via env in production, or change here and re-seed.
const USERS_SEED = [
  ['Alex Rivera', 'manager', process.env.SEED_MANAGER_PIN || '1234'],
  ['Jordan Lee',  'server',  process.env.SEED_SERVER_PIN  || '1111'],
  ['Sam Patel',   'server',  '2222'],
  ['Casey Wu',    'kitchen', process.env.SEED_KITCHEN_PIN || '3333'],
];

export function buildSeedData() {
  const menu = MENU_SEED.map(([category, name, price, emoji], i) => ({
    id: nanoid(8), category, name, price, emoji, image: null, sortOrder: i, active: true,
  }));
  const tables = Array.from({ length: 12 }, (_, i) => ({
    number: i + 1, status: 'open', orderId: null,
  }));
  const staff = STAFF_SEED.map(([name, role]) => ({
    id: nanoid(8), name, role, clockedInAt: role === 'Bartender' ? null : Date.now(),
  }));
  const users = USERS_SEED.map(([name, role, pin]) => ({
    id: nanoid(8), name, role, pinHash: hashPin(pin),
  }));
  return { menu, tables, staff, users };
}
