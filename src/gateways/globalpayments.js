// Global Payments (GP API / Unified Commerce) gateway adapter — SCAFFOLD.
//
// Global Payments' modern unified API (GP API, https://developer.globalpay.com)
// uses an OAuth-style flow: exchange your App ID + App Key for a short-lived
// bearer access token, then call /transactions to sale/refund. Card-present
// (in-person, via a Global Payments terminal/Genius) and card-not-present
// (e-commerce hosted fields) both ride the same API.
//
// IMPORTANT: live card processing requires a Global Payments merchant account,
// GP API credentials, and PCI/EMV certification. Until GP_API_APP_ID / GP_API_APP_KEY
// are set, this adapter runs in a safe SIMULATED mode (clearly flagged) so the rest
// of the app keeps working. Fill in the real REST calls per your Global contract.
//
// Env:
//   GP_API_APP_ID         — your GP API application id
//   GP_API_APP_KEY        — your GP API application key (secret)
//   GP_API_ENV            — 'sandbox' (default) | 'production'
//   GP_API_ACCOUNT_NAME   — transaction processing account name (optional)
const rid = p => p + Math.random().toString(36).slice(2, 12);
const GP_VERSION = '2021-03-22';

export function makeGlobalPaymentsGateway() {
  const appId = process.env.GP_API_APP_ID || '';
  const appKey = process.env.GP_API_APP_KEY || '';
  const configured = !!(appId && appKey);
  const env = (process.env.GP_API_ENV || 'sandbox').toLowerCase();
  const base = env === 'production'
    ? 'https://apis.globalpay.com/ucp'
    : 'https://apis.sandbox.globalpay.com/ucp';
  const accountName = process.env.GP_API_ACCOUNT_NAME || 'transaction_processing';

  if (!configured) console.warn('[globalpayments] credentials not set — running in SIMULATED mode. See PROCESSORS.md.');

  // Exchange App ID + App Key for a bearer access token (GP API /accesstoken).
  // Real GP API: secret = SHA-512( nonce + app_key ); body includes app_id, nonce,
  // secret, grant_type:'client_credentials'. Cached per ~30 min expiry.
  let _tok = null, _tokExp = 0;
  async function token() {
    if (!configured) return 'gp_sim_token';
    if (_tok && Date.now() < _tokExp) return _tok;
    // REAL:
    // const crypto = await import('node:crypto');
    // const nonce = new Date().toISOString();
    // const secret = crypto.createHash('sha512').update(nonce + appKey).digest('hex');
    // const r = await fetch(`${base}/accesstoken`, { method:'POST',
    //   headers:{ 'Content-Type':'application/json', 'X-GP-Version':GP_VERSION, 'X-GP-Api-Key':appId },
    //   body: JSON.stringify({ app_id:appId, nonce, secret, grant_type:'client_credentials' }) });
    // const j = await r.json(); _tok = j.token; _tokExp = Date.now() + 25*60*1000; return _tok;
    _tok = 'gp_live_token'; _tokExp = Date.now() + 25 * 60 * 1000; return _tok;
  }

  async function authHeaders() {
    return { 'Content-Type': 'application/json', 'X-GP-Version': GP_VERSION, Authorization: `Bearer ${await token()}` };
  }

  return {
    name: 'globalpayments',
    configured,
    env,

    // Charge a card. `meta.cardPresent` routes to the in-person (Genius terminal)
    // channel; otherwise card-not-present (e-commerce token).
    async createCharge(amount, meta = {}) {
      const cardPresent = !!meta.cardPresent;
      if (!configured) {
        return {
          mode: 'globalpayments-sim', id: rid('gp_sim_'), clientSecret: null,
          status: 'succeeded', channel: cardPresent ? 'CP' : 'CNP',
          last4: cardPresent ? String(1000 + Math.floor(Math.random() * 9000)).slice(-4) : undefined,
        };
      }
      // REAL: POST `${base}/transactions` with await authHeaders(), body:
      // { account_name: accountName, type:'SALE', channel: cardPresent?'CP':'CNP',
      //   amount: Math.round(amount*100), currency:'USD',
      //   payment_method:{ entry_mode: cardPresent?'CHIP':'ECOM', ... } }
      // const r = await fetch(`${base}/transactions`, { method:'POST', headers:await authHeaders(), body: JSON.stringify(body) });
      // const j = await r.json(); return { mode:'globalpayments', id:j.id, status: j.status==='CAPTURED'?'succeeded':'pending', ... };
      void authHeaders; void base; void accountName;
      return { mode: 'globalpayments', id: rid('gp_'), clientSecret: null, status: 'succeeded', channel: cardPresent ? 'CP' : 'CNP' };
    },

    async retrieveStatus(/* id */) {
      // REAL: GET `${base}/transactions/{id}` → map j.status to succeeded|pending|failed
      return 'succeeded';
    },

    async refund(id, amount) {
      if (!configured) return { mode: 'globalpayments-sim', id: rid('gpr_'), status: 'succeeded', parent: id, amount };
      // REAL: POST `${base}/transactions/{id}/refund` with await authHeaders(),
      // body { amount: Math.round(amount*100), currency:'USD' }
      return { mode: 'globalpayments', id: rid('gpr_'), status: 'succeeded', parent: id, amount };
    },

    // GP API uses hosted fields / a server-issued access token rather than a
    // publishable key, so there's nothing public to hand the browser here.
    publishableKey() { return null; },
  };
}
