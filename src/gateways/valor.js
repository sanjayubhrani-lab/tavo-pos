// Valor PayTech gateway adapter — SCAFFOLD (cloud semi-integration + gateway API).
//
// Two transaction paths, both behind the same interface:
//   • CARD-PRESENT (Valor Connect): the POS sends a sale to Valor's cloud, which
//     dispatches it to a physical terminal (VL100/VL300/VL500/RCKT). The customer
//     taps/inserts; the card never touches Tavo (semi-integrated → minimal PCI).
//     Pass meta.cardPresent = true (and the terminal EPI) to use this path.
//   • CARD-NOT-PRESENT (Merchant/Gateway API): a JSON charge for online ordering,
//     QR pay-at-table, or stored cards.
//
// IMPORTANT: real processing needs a boarded Valor merchant account, API
// credentials, a registered terminal EPI, and Valor integration certification.
// Until VALOR_APP_ID / VALOR_APP_KEY are set this runs in a safe SIMULATED mode
// (clearly flagged) so the rest of Tavo works end-to-end. Wire the real REST
// calls per the Valor Connect + POS Integration specs when certified. See VALOR.md.
//
// Env: VALOR_APP_ID, VALOR_APP_KEY, VALOR_EPI (default terminal),
//      VALOR_BASE_URL (default staging securelink), VALOR_ENV(=staging|prod)
const rid = p => p + Math.random().toString(36).slice(2, 12);

export function makeValorGateway() {
  const configured = !!(process.env.VALOR_APP_ID && process.env.VALOR_APP_KEY);
  if (!configured) console.warn('[valor] credentials not set — running in SIMULATED mode. See VALOR.md.');

  const base = process.env.VALOR_BASE_URL
    || (process.env.VALOR_ENV === 'prod'
        ? 'https://securelink.valorpaytech.com:4430'
        : 'https://securelink-staging.valorpaytech.com:4430');

  // Common credential block sent with every Valor request.
  const creds = () => ({ appid: process.env.VALOR_APP_ID, appkey: process.env.VALOR_APP_KEY, epi: process.env.VALOR_EPI || null });

  async function valorPost(path, body) {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...creds(), ...body }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`valor ${r.status}: ${data.error_message || data.message || 'request failed'}`);
    return data;
  }

  return {
    name: 'valor',
    configured,

    // Start a sale. Card-present → dispatched to the terminal via the cloud.
    async createCharge(amount, meta = {}) {
      const cents = Math.round(Number(amount) * 100);
      if (!configured) {
        // Simulated approval so the POS flow completes without real hardware.
        return { mode: 'valor-sim', id: rid('vlr_sim_'), clientSecret: null, status: 'succeeded',
                 cardPresent: !!meta.cardPresent, last4: '4242', authCode: 'SIMOK' };
      }
      // REAL (card-present / Valor Connect): POST a sale; the cloud rings the
      // terminal whose EPI is supplied. The call returns a transaction id; poll
      // retrieveStatus() until the customer finishes (approved/declined).
      //   const res = await valorPost('/?', { txn_type: 'sale', amount: cents,
      //     epi: meta.epi || process.env.VALOR_EPI, invoice: meta.orderId });
      // REAL (card-not-present / gateway): include the tokenized card / hosted field.
      const res = await valorPost('/', { txn_type: 'sale', amount: cents, epi: meta.epi || process.env.VALOR_EPI, invoice: meta.orderId || null });
      return { mode: 'valor', id: res.txn_id || res.rrn || rid('vlr_'), clientSecret: null,
               status: (res.response_code === '00' || res.approved) ? 'succeeded' : 'requires_action',
               last4: res.card_last4 || null, authCode: res.auth_code || null };
    },

    // Poll a transaction's status (card-present sales complete asynchronously).
    async retrieveStatus(id) {
      if (!configured) return 'succeeded';
      const res = await valorPost('/', { txn_type: 'status', txn_id: id });
      return (res.response_code === '00' || res.approved) ? 'succeeded'
           : (res.declined ? 'failed' : 'pending');
    },

    // Refund or void a prior transaction.
    async refund(id, amount) {
      if (!configured) return { mode: 'valor-sim', id: rid('vlrr_sim_'), status: 'succeeded' };
      const res = await valorPost('/', { txn_type: 'refund', txn_id: id, amount: Math.round(Number(amount) * 100) });
      return { mode: 'valor', id: res.txn_id || rid('vlrr_'), status: (res.response_code === '00' || res.approved) ? 'succeeded' : 'failed' };
    },

    // The terminal collects the card — there is no browser publishable key.
    publishableKey() { return null; },
  };
}
