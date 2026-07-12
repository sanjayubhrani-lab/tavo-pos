// Payment gateway contract test: the mock gateway must satisfy the interface
// the server relies on (createCharge -> succeeded, refund -> refunded).
import assert from 'node:assert/strict';
import { getGateway, GATEWAYS } from '../src/gateways/index.js';

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  PASS', name); };

const g = getGateway();

await t('gateway catalog includes mock + stripe', () => {
    assert.ok(GATEWAYS.includes('mock'));
    assert.ok(GATEWAYS.includes('stripe'));
});

await t('mock charge succeeds and is retrievable', async () => {
    const charge = await g.createCharge(1234, { orderId: 'x' });
    assert.ok(charge.id, 'charge has an id');
    const status = await g.retrieveStatus(charge.id);
    assert.equal(status, 'succeeded');
});

await t('mock refund returns a refund object', async () => {
    const charge = await g.createCharge(500, {});
    const refund = await g.refund(charge.id, 500);
    assert.ok(refund, 'refund returned');
});

console.log(`gateways.test: ${pass} passed`);
