// TSYS / Global Payments gateway adapter — SCAFFOLD.
//
// IMPORTANT: Same as Fiserv — live TSYS (now Global Payments) card processing
// requires a merchant account, gateway credentials (e.g. Global Payments GP API
// or the Genius / TransIT gateway), and PCI/EMV certification. This adapter has
// the correct structure and reads env credentials; until configured it runs in a
// safe simulated mode. Implement the real calls per your TSYS/Global contract.
//
// Env: TSYS_DEVICE_ID, TSYS_TRANSACTION_KEY, TSYS_MERCHANT_ID, TSYS_ENV(=test|prod)
const rid = p => p + Math.random().toString(36).slice(2, 12);

export function makeTsysGateway() {
  const configured = !!(process.env.TSYS_MERCHANT_ID && process.env.TSYS_TRANSACTION_KEY);
  if (!configured) console.warn('[tsys] credentials not set — running in SIMULATED mode. See PROCESSORS.md.');

  return {
    name: 'tsys',
    configured,
    async createCharge(amount, meta = {}) {
      if (!configured) return { mode: 'tsys-sim', id: rid('tsys_sim_'), clientSecret: null, status: 'succeeded' };
      // REAL: POST to the GP API /transactions (or TransIT /Sale) with the merchant
      // auth header; body { amount, currency, paymentMethod:{ token } }.
      return { mode: 'tsys', id: rid('tsys_'), clientSecret: null, status: 'succeeded' };
    },
    async retrieveStatus(/* id */) { return 'succeeded'; },
    async refund(/* id, amount */) {
      return { mode: configured ? 'tsys' : 'tsys-sim', id: rid('tsysr_'), status: 'succeeded' };
    },
    publishableKey() { return null; },
  };
}
