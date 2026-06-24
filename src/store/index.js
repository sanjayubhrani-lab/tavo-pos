// Picks the storage backend:
//   - PostgreSQL when DATABASE_URL is set
//   - JSON file otherwise (zero-setup default)
import { makeJsonStore } from './json.js';
import { makePgStore } from './pg.js';

let _store = null;

export async function getStore() {
  if (_store) return _store;
  if (process.env.DATABASE_URL) {
    _store = await makePgStore();
  } else {
    _store = makeJsonStore();
  }
  await _store.init();
  return _store;
}

export function storeKind() {
  return process.env.DATABASE_URL ? 'postgres' : 'json';
}
