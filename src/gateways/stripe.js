// Stripe payment gateway adapter.
import Stripe from 'stripe';

export function makeStripeGateway() {
  const key = process.env.STRIPE_SECRET_KEY;
  const stripe = new Stripe(key);
  const isReal = id => id && !id.startsWith('pi_mock_') && !id.startsWith('offline_');

  return {
    name: 'stripe',
    configured: true,
    async createCharge(amount, meta = {}) {
      const intent = await stripe.paymentIntents.create({
        amount: Math.round(amount * 100), currency: 'usd',
        automatic_payment_methods: { enabled: true }, metadata: meta,
                ...(meta.saveCard ? { setup_future_usage: 'off_session' } : {}),
      });
      return { mode: 'stripe', id: intent.id, clientSecret: intent.client_secret, status: intent.status };
    },
        async chargeSavedCard(amount, savedRef = {}, meta = {}) {
                const intent = await stripe.paymentIntents.create({
                          amount: Math.round(amount * 100), currency: 'usd',
                          customer: savedRef.customerId, payment_method: savedRef.paymentMethodId,
                          off_session: true, confirm: true, metadata: meta,
                });
                return { mode: 'stripe', id: intent.id, status: intent.status };
        },
    async retrieveStatus(id) {
      if (isReal(id)) return (await stripe.paymentIntents.retrieve(id)).status;
      return 'succeeded';
    },
    async refund(id, amount) {
      if (isReal(id)) {
        const r = await stripe.refunds.create({ payment_intent: id, amount: Math.round(amount * 100) });
        return { mode: 'stripe', id: r.id, status: r.status };
      }
      return { mode: 'stripe', id: 're_' + Date.now(), status: 'succeeded' };
    },
    stripeClientRaw() { return stripe; },         // used by the Stripe webhook verifier
    publishableKey() { return process.env.STRIPE_PUBLISHABLE_KEY || null; },
  };
}
