// Create database tables (Postgres) from schema.sql.
// Safe to run repeatedly — uses CREATE TABLE IF NOT EXISTS.
// For the JSON backend this is a no-op (the file is created on demand).
// Run with: npm run migrate
import 'dotenv/config';
import { getStore, storeKind } from './store/index.js';

const store = await getStore();   // getStore() already calls init() which runs the schema
console.log(`Migration complete for ${storeKind().toUpperCase()} store.`);
if (storeKind() === 'json') console.log('(JSON backend needs no migration — set DATABASE_URL to use Postgres.)');
process.exit(0);
