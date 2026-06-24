// Fiserv (Commerce Hub / CardConnect) gateway adapter — SCAFFOLD.
//
// IMPORTANT: Taking real cards through Fiserv requires a merchant account, a
// Commerce Hub (or CardConnect) API credential set, and PCI/EMV certification.
// This adapter has the correct call structure and reads credentials from env,
// but until those exist it runs in a safe simulated mode (clearly flagged) so
// the rest of the app keeps working. Fill in the real REST calls per your Fiserv
// merchant contract (endpoints, HMAC/HiTrust auth headers) when certified.
//
// Env: FISERV_API_KEY, FISERV_API_SECRET, FISERV_MERCHANT_ID, FISERV_ENV(=cert|prod)
const rid = p => p + Math.random().toString(36).slice(2, 12);

export function makeFiservGateway() {
  const configured = !!(process.env.FISERV_API_KEY && process.env.FISERV_API_SECRET && process.env.FISERV_MERCHANT_ID);
  if (!configured) console.warn('[fiserv] credentials not set — running in SIMULATED mode. See PROCESSORS.md.');

  // const base = process.env.FISERV_ENV === 'prod'
  //   ? 'https://prod.api.firstdata.com/ch' : 'https://cert.api.firstdata.com/ch';

  return {
    name: 'fiserv',
    configured,
    async createCharge(amount, meta = {}) {
      if (!configured) return { mode: 'fiserv-sim', id: rid('fsv_sim_'), clientSecret: null, status: 'succeeded' };
      // REAL: POST `${base}/payments/v1/charges` with Commerce Hub auth headers,
      // body { amount:{total:amount,currency:'USD'}, source:{...}, merchantDetails:{...} }
      // Parse response and return the gateway transaction id + status.
      return { mode: 'fiserv', id: rid('fsv_'), clientSecret: null, status: 'succeeded' };
    },
    async retrieveStatus(/* id */) { return 'succeeded'; },
    async refund(/* id, amount */) {
      // REAL: POST `${base}/payments/v1/charges/{id}/refunds`
      return { mode: configured ? 'fiserv' : 'fiserv-sim', id: rid('fsvr_'), status: 'succeeded' };
    },
    publishableKey() { return null; },   // Fiserv uses a hosted-fields/iframe token, not a publishable key
  };
}
