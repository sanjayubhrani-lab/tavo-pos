// Mock payment gateway — simulates an authorized payment. Default when no real
// processor is configured, so the whole app runs end-to-end with zero setup.
const rid = (p) => p + Math.random().toString(36).slice(2, 12);

export function makeMockGateway() {
  return {
    name: 'mock',
    configured: true,
    async createCharge(/* amount, meta */) {
      return { mode: 'mock', id: rid('pi_mock_'), clientSecret: null, status: 'succeeded' };
    },
    async retrieveStatus(/* id */) { return 'succeeded'; },
    async refund(/* id, amount */) {
      return { mode: 'mock', id: rid('re_mock_'), status: 'succeeded' };
    },
    publishableKey() { return null; },
  };
}
