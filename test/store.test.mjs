// Data-layer tests: JSON store CRUD + tenant scoping.
import assert from 'node:assert/strict';
import { getStore } from '../src/store/index.js';

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  PASS', name); };

const store = await getStore();
await store.init?.();
await store.reset({ menu: [], tables: [], staff: [], users: [], inventory: [] });

await t('createTenant + getTenantBySlug', async () => {
    await store.createTenant({ id: 'ten_a', name: 'A', slug: 'a', plan: 'free', mode: 'restaurant', createdAt: Date.now() });
    const got = await store.getTenantBySlug('a');
    assert.equal(got.id, 'ten_a');
});

await t('menu is scoped by tenant', async () => {
    await store.createMenuItem({ id: 'm_a', name: 'Fries', price: 5, tenantId: 'ten_a' });
    await store.createTenant({ id: 'ten_b', name: 'B', slug: 'b', plan: 'free', mode: 'restaurant', createdAt: Date.now() });
    await store.createMenuItem({ id: 'm_b', name: 'Soda', price: 3, tenantId: 'ten_b' });
    const aMenu = await store.listMenu('ten_a');
    const bMenu = await store.listMenu('ten_b');
    assert.equal(aMenu.length, 1);
    assert.equal(aMenu[0].name, 'Fries');
    assert.equal(bMenu.length, 1);
    assert.equal(bMenu[0].name, 'Soda');
});

await t('order + payment round-trip', async () => {
    await store.createOrder({ id: 'o1', number: 1001, tenantId: 'ten_a', status: 'open', total: 10, lines: [] });
    const o = await store.getOrder('o1');
    assert.equal(o.number, 1001);
    await store.updateOrder('o1', { status: 'paid' });
    assert.equal((await store.getOrder('o1')).status, 'paid');
    await store.createPayment({ id: 'p1', orderId: 'o1', tenantId: 'ten_a', total: 10, status: 'succeeded', refundedAmount: 0 });
    assert.equal((await store.getPayment('p1')).total, 10);
});

console.log(`store.test: ${pass} passed`);
