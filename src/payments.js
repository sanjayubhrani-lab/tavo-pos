// Payment processing layer.
// Uses real Stripe (TEST mode) when STRIPE_SECRET_KEY is set,
// otherwise falls back to a built-in mock so the app runs out of the box.
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
export const usingStripe = !!key && key.startsWith('sk_');
const stripe = usingStripe ? new Stripe(key) : null;

// Exposed so the webhook handler can verify event signatures.
export function stripeClient() { return stripe; }

/**
 * Create a PaymentIntent (or a mock equivalent).
 * @param {number} amount  total in dollars
 * @param {object} meta    arbitrary metadata (orderId, table, etc.)
 */
export async function createPaymentIntent(amount, meta = {}) {
  const amountCents = Math.round(amount * 100);

  if (usingStripe) {
    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: meta,
    });
    return {
      mode: 'stripe',
      id: intent.id,
      clientSecret: intent.client_secret,
      status: intent.status,
    };
  }

  // Mock processor — simulates an authorized card payment.
  return {
    mode: 'mock',
    id: 'pi_mock_' + Math.random().toString(36).slice(2, 12),
    clientSecret: null,
    status: 'succeeded',
  };
}

/** Confirm/capture is handled client-side by Stripe.js in real mode.
 *  In mock mode we just echo success. This endpoint records the final state. */
export async function retrieveStatus(intentId) {
  if (usingStripe && intentId && !intentId.startsWith('pi_mock_')) {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    return intent.status;
  }
  return 'succeeded';
}

/** Issue a refund against a previous payment.
 * @param {string} intentId  the original PaymentIntent id
 * @param {number} amount    dollars to refund
 */
export async function createRefund(intentId, amount) {
  const amountCents = Math.round(amount * 100);
  if (usingStripe && intentId && !intentId.startsWith('pi_mock_')) {
    const refund = await stripe.refunds.create({ payment_intent: intentId, amount: amountCents });
    return { mode: 'stripe', id: refund.id, status: refund.status };
  }
  return { mode: 'mock', id: 're_mock_' + Math.random().toString(36).slice(2, 12), status: 'succeeded' };
}
