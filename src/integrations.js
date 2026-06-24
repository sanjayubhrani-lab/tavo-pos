// Delivery-platform integration layer.
// Third-party orders (DoorDash, Uber Eats, Grubhub, or an aggregator like Otter/
// Deliverect) arrive as a webhook and are normalized into Tavo's order shape.
//
// Two ways to send us an order:
//   1) Already-normalized payload  → { platform, externalId, customer, lines:[{name,price,qty,mods}] }
//   2) Provider-native payload     → { provider:'doordash'|'ubereats'|'grubhub', payload:{...} }
//      and we map it here. The mappers below cover the common shape of each
//      provider's order push; extend them to match your exact contract/aggregator.

export const PLATFORMS = ['doordash', 'ubereats', 'grubhub', 'other'];

const money = v => (v == null ? 0 : Number(v));

// --- provider-specific mappers (best-effort, adjust to your real contract) ---
const mappers = {
  // DoorDash Marketplace order push (simplified)
  doordash(p) {
    return {
      platform: 'doordash',
      externalId: String(p.id || p.order_id || p.external_delivery_id || ''),
      customer: p.consumer?.first_name || p.customer?.name || 'DoorDash customer',
      lines: (p.items || p.order_items || []).map(i => ({
        name: i.name || i.title, price: money(i.price ?? i.unit_price), qty: i.quantity || 1,
        mods: (i.options || i.modifiers || []).map(m => m.name || m),
      })),
    };
  },
  // Uber Eats order.notification (simplified)
  ubereats(p) {
    const cart = p.cart || p;
    return {
      platform: 'ubereats',
      externalId: String(p.id || p.order_id || ''),
      customer: p.eater?.first_name || 'Uber Eats customer',
      lines: (cart.items || []).map(i => ({
        name: i.title || i.name, price: money(i.price?.unit_price?.amount ?? i.price), qty: i.quantity || 1,
        mods: (i.selected_modifier_groups || []).flatMap(g => (g.selected_items || []).map(s => s.title)),
      })),
    };
  },
  // Grubhub order (simplified)
  grubhub(p) {
    return {
      platform: 'grubhub',
      externalId: String(p.order_id || p.id || ''),
      customer: p.diner?.first_name || 'Grubhub customer',
      lines: (p.lines || p.items || []).map(i => ({
        name: i.name, price: money(i.price), qty: i.quantity || 1,
        mods: (i.modifiers || []).map(m => m.name || m),
      })),
    };
  },
};

/** Turn any accepted body into a normalized order, or throw a helpful error. */
export function normalizeIncoming(body) {
  let norm;
  if (body.provider && body.payload) {
    const fn = mappers[body.provider];
    if (!fn) throw new Error(`unknown provider: ${body.provider}`);
    norm = fn(body.payload);
  } else {
    norm = {
      platform: (body.platform || 'other').toLowerCase(),
      externalId: body.externalId != null ? String(body.externalId) : null,
      customer: body.customer || null,
      lines: body.lines || [],
    };
  }
  if (!PLATFORMS.includes(norm.platform)) norm.platform = 'other';
  norm.lines = (norm.lines || []).filter(l => l && l.name).map(l => ({
    name: String(l.name), price: money(l.price), qty: Number(l.qty) || 1, mods: l.mods || [],
  }));
  if (!norm.lines.length) throw new Error('order has no recognizable line items');
  return norm;
}

/** Export the menu in a neutral shape suitable for pushing to platforms/aggregators. */
export function exportMenu(items) {
  const byCat = {};
  for (const it of items) {
    if (it.active === false) continue;
    (byCat[it.category] ||= []).push({
      id: it.id, name: it.name, price: it.price, description: '', image: it.image || null,
    });
  }
  return {
    currency: 'USD',
    categories: Object.entries(byCat).map(([name, products]) => ({ name, products })),
  };
}
