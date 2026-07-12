// Payment facade — delegates to the active gateway (Stripe, Fiserv, TSYS, mock).
// The rest of the app calls these functions and never needs to know which
// processor is in use. Swap processors with the PAYMENT_GATEWAY env var.
import { getGateway } from './gateways/index.js';

const gw = getGateway();

export const paymentGateway = gw.name;              // 'stripe' | 'fiserv' | 'tsys' | 'mock'
export const usingStripe = gw.name === 'stripe';    // the Stripe webhook path only applies to Stripe

export function stripeClient() { return gw.stripeClientRaw ? gw.stripeClientRaw() : null; }
export function publishableKey() { return gw.publishableKey ? gw.publishableKey() : null; }

/** Create a charge/intent for an amount (dollars). Returns { mode, id, clientSecret, status }. */
export async function createPaymentIntent(amount, meta = {}) {
  return gw.createCharge(amount, meta);
}

/** Look up the status of a prior charge. */
export async function retrieveStatus(id) {
  return gw.retrieveStatus(id);
}

/** Refund a prior charge (full or partial). */
export async function createRefund(id, amount) {
  return gw.refund(id, amount);
}

/** Card-on-file: charge a customer's previously saved card (tabs, no-show fees). */
export async function chargeSavedCard(amount, savedRef, meta = {}) {
    if (!gw.chargeSavedCard) { const e = new Error('saved-card charges not supported by this processor'); e.status = 400; throw e; }
    return gw.chargeSavedCard(amount, savedRef, meta);
}
