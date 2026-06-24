// Payment-gateway selector. One interface, many processors.
// Pick with PAYMENT_GATEWAY=stripe|fiserv|tsys|mock. If unset, auto-detects
// Stripe (when STRIPE_SECRET_KEY is present) else falls back to the mock gateway.
//
// Every gateway implements: createCharge(amount, meta), retrieveStatus(id),
// refund(id, amount), publishableKey(). Add a new processor by dropping a file
// in this folder and registering it below — no other code changes needed.
import { makeMockGateway } from './mock.js';
import { makeStripeGateway } from './stripe.js';
import { makeFiservGateway } from './fiserv.js';
import { makeTsysGateway } from './tsys.js';

let _gw = null;

export function getGateway() {
  if (_gw) return _gw;
  const choice = (process.env.PAYMENT_GATEWAY || '').toLowerCase();
  const hasStripe = (process.env.STRIPE_SECRET_KEY || '').startsWith('sk_');

  if (choice === 'stripe' || (!choice && hasStripe)) {
    _gw = hasStripe ? makeStripeGateway() : makeMockGateway();
  } else if (choice === 'fiserv') {
    _gw = makeFiservGateway();
  } else if (choice === 'tsys') {
    _gw = makeTsysGateway();
  } else {
    _gw = makeMockGateway();
  }
  return _gw;
}

export const GATEWAYS = ['stripe', 'fiserv', 'tsys', 'mock'];
