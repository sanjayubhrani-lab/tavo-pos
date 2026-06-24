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
  // Example modifier groups (required/optional, min/max, per-option pricing) so the
  // menu shows the professional model out of the box. Keyed by item name.
  const grp = (name, required, min, max, options) => ({ id: nanoid(6), name, required, min, max, options });
  const MODS_BY_NAME = {
    'Classic Cheeseburger': [
      grp('Temperature', true, 1, 1, [{ name: 'Rare', price: 0 }, { name: 'Medium', price: 0 }, { name: 'Well done', price: 0 }]),
      grp('Add-ons', false, 0, 4, [{ name: 'Bacon', price: 2 }, { name: 'Extra cheese', price: 1.5 }, { name: 'Avocado', price: 2 }, { name: 'Fried egg', price: 1.5 }]),
      grp('Remove', false, 0, 3, [{ name: 'No onions', price: 0 }, { name: 'No pickles', price: 0 }, { name: 'No sauce', price: 0 }]),
    ],
    'Bacon BBQ Burger': [
      grp('Temperature', true, 1, 1, [{ name: 'Rare', price: 0 }, { name: 'Medium', price: 0 }, { name: 'Well done', price: 0 }]),
      grp('Add-ons', false, 0, 3, [{ name: 'Extra bacon', price: 2.5 }, { name: 'Jalapeños', price: 1 }, { name: 'Onion rings', price: 2 }]),
    ],
    'Margherita': [grp('Size', true, 1, 1, [{ name: '10"', price: 0 }, { name: '14"', price: 4 }, { name: '18"', price: 8 }])],
    'Pepperoni': [grp('Size', true, 1, 1, [{ name: '10"', price: 0 }, { name: '14"', price: 4 }, { name: '18"', price: 8 }]),
      grp('Extra toppings', false, 0, 5, [{ name: 'Extra cheese', price: 2 }, { name: 'Mushrooms', price: 1.5 }, { name: 'Olives', price: 1.5 }])],
    'Soft Drink': [grp('Size', true, 1, 1, [{ name: 'Small', price: 0 }, { name: 'Medium', price: 0.75 }, { name: 'Large', price: 1.25 }]),
      grp('Ice', false, 0, 1, [{ name: 'No ice', price: 0 }, { name: 'Light ice', price: 0 }])],
    'Coffee': [grp('Milk', false, 0, 1, [{ name: 'Oat milk', price: 0.6 }, { name: 'Almond milk', price: 0.6 }, { name: 'Whole milk', price: 0 }]),
      grp('Extras', false, 0, 3, [{ name: 'Extra shot', price: 0.9 }, { name: 'Vanilla', price: 0.5 }, { name: 'Caramel', price: 0.5 }])],
  };
  const menu = MENU_SEED.map(([category, name, price, emoji], i) => ({
    id: nanoid(8), category, name, price, emoji, image: null, sortOrder: i,
    modifierGroups: MODS_BY_NAME[name] || [], active: true,
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
