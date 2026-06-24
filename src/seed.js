// Force-seed the configured database (JSON file or Postgres) with default data.
// WARNING: this REPLACES existing data. Run with: npm run seed
import 'dotenv/config';
import { getStore, storeKind } from './store/index.js';
import { buildSeedData } from './seedData.js';

const data = buildSeedData();
const store = await getStore();
await store.reset(data);

console.log(`Seeded ${storeKind().toUpperCase()} store: ${data.menu.length} menu items, ${data.tables.length} tables, ${data.staff.length} staff, ${data.users.length} login users.`);
console.log('Demo PINs → Manager 1234 · Server 1111 / 2222 · Kitchen 3333');
process.exit(0);
