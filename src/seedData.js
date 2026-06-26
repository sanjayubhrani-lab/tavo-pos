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
  // Starter inventory (ingredients/stock) with per-unit cost, so recipe costing
  // and food-cost % work out of the box. Stable ids let recipes reference them.
  const inventory = [
    { id: 'inv_beef',    name: 'Beef patty',     unit: 'patty', qty: 80,  parLevel: 24, cost: 1.40 },
    { id: 'inv_bun',     name: 'Burger bun',     unit: 'bun',   qty: 90,  parLevel: 24, cost: 0.35 },
    { id: 'inv_cheese',  name: 'Cheese slice',   unit: 'slice', qty: 120, parLevel: 30, cost: 0.25 },
    { id: 'inv_bacon',   name: 'Bacon strip',    unit: 'strip', qty: 60,  parLevel: 20, cost: 0.45 },
    { id: 'inv_dough',   name: 'Pizza dough',    unit: 'ball',  qty: 40,  parLevel: 12, cost: 0.90 },
    { id: 'inv_sauce',   name: 'Tomato sauce',   unit: 'oz',    qty: 200, parLevel: 48, cost: 0.08 },
    { id: 'inv_mozz',    name: 'Mozzarella',     unit: 'oz',    qty: 180, parLevel: 48, cost: 0.30 },
    { id: 'inv_coffee',  name: 'Coffee beans',   unit: 'oz',    qty: 100, parLevel: 24, cost: 0.55 },
    { id: 'inv_fries',   name: 'Fries portion',  unit: 'portion', qty: 70, parLevel: 20, cost: 0.60 },
  ];
  // Recipes keyed by menu-item name → [{ invId, qty }] consumed per unit sold.
  const RECIPE_BY_NAME = {
    'Classic Cheeseburger': [{ invId: 'inv_beef', qty: 1 }, { invId: 'inv_bun', qty: 1 }, { invId: 'inv_cheese', qty: 1 }, { invId: 'inv_fries', qty: 1 }],
    'Bacon BBQ Burger':     [{ invId: 'inv_beef', qty: 1 }, { invId: 'inv_bun', qty: 1 }, { invId: 'inv_cheese', qty: 1 }, { invId: 'inv_bacon', qty: 2 }, { invId: 'inv_fries', qty: 1 }],
    'Margherita':           [{ invId: 'inv_dough', qty: 1 }, { invId: 'inv_sauce', qty: 4 }, { invId: 'inv_mozz', qty: 5 }],
    'Pepperoni':            [{ invId: 'inv_dough', qty: 1 }, { invId: 'inv_sauce', qty: 4 }, { invId: 'inv_mozz', qty: 5 }],
    'Coffee':               [{ invId: 'inv_coffee', qty: 0.6 }],
  };
  const menu = MENU_SEED.map(([category, name, price, emoji], i) => ({
    id: nanoid(8), category, name, price, emoji, image: null, sortOrder: i,
    modifierGroups: MODS_BY_NAME[name] || [], recipe: RECIPE_BY_NAME[name] || [], active: true,
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
  return { menu, tables, staff, users, inventory };
}
