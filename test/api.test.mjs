// HTTP end-to-end tests. Spawns the real server on a test port with a fresh
// JSON store, then exercises auth, RBAC, and the security fixes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4319;
const BASE = `http://localhost:${PORT}/api`;
const dataDir = mkdtempSync(join(tmpdir(), 'tavo-test-'));

const env = { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, JWT_SECRET: 'test-secret', NODE_ENV: 'test', AUTO_SEED: 'true', LOGIN_MAX_ATTEMPTS: '9999' };

await new Promise((res, rej) => {
    const s = spawn('node', ['src/seed.js'], { env, stdio: 'ignore' });
    s.on('exit', c => c === 0 ? res() : rej(new Error('seed failed')));
});
const srv = spawn('node', ['src/server.js'], { env, stdio: 'ignore' });

async function up() { for (let i = 0; i < 30; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) return; } catch {} await sleep(200); } throw new Error('server did not start'); }
const api = (p, opt = {}) => fetch(BASE + p, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) } });
const login = async (pin, tenant) => (await (await api('/auth/login', { method: 'POST', body: JSON.stringify({ pin, tenant }) })).json()).token;

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  PASS', name); };

try {
    await up();

  await t('login with bad PIN is rejected', async () => {
        const r = await api('/auth/login', { method: 'POST', body: JSON.stringify({ pin: '0000' }) });
        assert.equal(r.status, 401);
  });

  const mgr = await login('1234');
    assert.ok(mgr, 'manager token issued');
    const H = { Authorization: `Bearer ${mgr}` };

  await t('no token -> 401 on menu', async () => {
        assert.equal((await api('/menu')).status, 401);
  });

  await t('kitchen role -> 403 on reports', async () => {
        const kt = await login('3333');
        const r = await api('/reports/summary', { headers: { Authorization: `Bearer ${kt}` } });
        assert.equal(r.status, 403);
  });

  const menu = await (await api('/menu', { headers: H })).json();
    const item = menu[0];

  await t('SECURITY: server ignores client price', async () => {
        const r = await api('/orders', { method: 'POST', headers: H, body: JSON.stringify({ table: 't1', lines: [{ name: item.name, price: 0.01, qty: 1 }] }) });
        const o = await r.json();
        if (!o.lines) throw new Error('no lines: ' + JSON.stringify(o));
        assert.equal(o.lines[0].price, item.price, 'price rewritten from menu');
        assert.ok(o.subtotal >= item.price - 1e-9, 'subtotal uses real price');
  });

  await t('SECURITY: unknown item rejected', async () => {
        const r = await api('/orders', { method: 'POST', headers: H, body: JSON.stringify({ table: 't1', lines: [{ name: 'Free Lunch', price: 0, qty: 1 }] }) });
        assert.equal(r.status, 400);
  });

  let paymentId, orderId;
    await t('full pay flow records succeeded payment', async () => {
          const o = await (await api('/orders', { method: 'POST', headers: H, body: JSON.stringify({ table: 't2', lines: [{ name: item.name, qty: 1 }] }) })).json();
          orderId = o.id;
          const pi = await (await api('/payments/intent', { method: 'POST', headers: H, body: JSON.stringify({ lines: [{ name: item.name, qty: 1 }] }) })).json();
          const pay = await (await api('/payments/complete', { method: 'POST', headers: H, body: JSON.stringify({ intentId: pi.id, orderId, lines: [{ name: item.name, qty: 1 }], method: 'card' }) })).json();
          paymentId = pay.id;
          assert.equal(pay.status, 'succeeded');
    });

  await t('refund once, second refund rejected', async () => {
        const r1 = await api(`/payments/${paymentId}/refund`, { method: 'POST', headers: H, body: '{}' });
        assert.equal(r1.status, 200);
        const r2 = await api(`/payments/${paymentId}/refund`, { method: 'POST', headers: H, body: '{}' });
        assert.equal(r2.status, 400);
  });

  await t('SECURITY: cross-tenant refund/void blocked', async () => {
        await (await api('/tenants', { method: 'POST', body: JSON.stringify({ name: 'B', slug: 'testb', managerPin: '9999' }) })).json();
        const mgrB = await login('9999', 'testb');
        const HB = { Authorization: `Bearer ${mgrB}` };
        assert.equal((await api(`/payments/${paymentId}/refund`, { method: 'POST', headers: HB, body: '{}' })).status, 404);
        assert.equal((await api(`/orders/${orderId}/void`, { method: 'POST', headers: HB, body: '{}' })).status, 404);
        assert.equal((await api(`/orders/${orderId}/bump`, { method: 'POST', headers: HB })).status, 404);
  });

  console.log(`api.test: ${pass} passed`);
} finally {
    srv.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
