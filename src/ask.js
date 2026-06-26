// "Ask Tavo" — a natural-language business assistant.
// Parses a plain-English question and answers it by computing over the
// tenant's own data (payments, orders, menu, inventory, customers, gift cards).
// Deterministic and offline by design — no external LLM key required. If an
// LLM is wired up later, this same computed context can be handed to it.

const round = n => Math.round(n * 100) / 100;
const money = n => '$' + round(n || 0).toFixed(2);

// ---- time windows ----
function windowFor(text, now = Date.now()) {
  const d = new Date(now);
  const startOfDay = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  if (/yesterday/.test(text)) {
    const s = startOfDay(now) - 86400000;
    return { from: s, to: s + 86400000, label: 'yesterday' };
  }
  if (/this week|past week|last 7|week/.test(text)) {
    return { from: startOfDay(now) - 6 * 86400000, to: now, label: 'the last 7 days' };
  }
  if (/this month|past month|last 30|month/.test(text)) {
    return { from: startOfDay(now) - 29 * 86400000, to: now, label: 'the last 30 days' };
  }
  if (/all time|ever|total|overall|so far/.test(text)) {
    return { from: 0, to: now, label: 'all time' };
  }
  // default: today
  return { from: startOfDay(now), to: now + 1, label: 'today' };
}

const inWin = (t, w) => t != null && t >= w.from && t < w.to;

// Aggregate the common sales stats over a window.
function salesStats(payments, w) {
  const pays = payments.filter(p => inWin(p.createdAt, w));
  const gross = round(pays.reduce((a, p) => a + (p.total || 0), 0));
  const refunds = round(pays.reduce((a, p) => a + (p.refundedAmount || 0), 0));
  const tips = round(pays.reduce((a, p) => a + (p.tip || 0), 0));
  const tax = round(pays.reduce((a, p) => a + (p.tax || 0), 0));
  const count = pays.length;
  const net = round(gross - refunds);
  const avg = count ? round(gross / count) : 0;
  const byMethod = {};
  pays.forEach(p => { byMethod[p.method] = round((byMethod[p.method] || 0) + (p.total || 0)); });
  const itemCounts = {};
  pays.forEach(p => (p.lines || []).forEach(l => { itemCounts[l.name] = (itemCounts[l.name] || 0) + (l.qty || 0); }));
  return { pays, gross, refunds, tips, tax, count, net, avg, byMethod, itemCounts };
}

function topSellers(itemCounts, n = 5) {
  return Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

// The suggested prompts shown in the UI (mode-aware).
export function suggestions(mode = 'restaurant') {
  const common = [
    'How much did I make today?',
    'What are my top sellers this week?',
    "What's running low on stock?",
    "What's my average check today?",
    'How much did I make this week?',
    'How much is owed on gift cards?',
  ];
  if (mode === 'retail') {
    return [
      'How much did I sell today?',
      'What are my best sellers this week?',
      "What products are low on stock?",
      "What's my average sale today?",
      'How many sales did I make today?',
      'Who are my top loyalty members?',
    ];
  }
  return common;
}

// Main entry: returns { answer, kind, data? }
export function answer(question, ctx) {
  const q = String(question || '').toLowerCase().trim();
  const { payments = [], orders = [], menu = [], inventory = [], customers = [], giftcards = [], taxRate = 0, loyalty = { redeemRate: 0.05 }, mode = 'restaurant' } = ctx;
  const sale = mode === 'retail' ? 'sale' : 'check';
  const sell = mode === 'retail' ? 'sold' : 'made';

  if (!q) return { kind: 'help', answer: "Ask me about your sales, top sellers, stock, tips, loyalty, or gift cards.", data: { suggestions: suggestions(mode) } };

  // ---- help ----
  if (/^(help|what can|how do you|what do you)/.test(q)) {
    return { kind: 'help', answer: 'You can ask me things like:', data: { suggestions: suggestions(mode) } };
  }

  // ---- low stock / reorder ----
  if (/low|reorder|out of stock|running (out|low)|restock/.test(q)) {
    const lowIng = inventory.filter(i => (i.qty || 0) <= (i.parLevel || 0));
    const lowProd = menu.filter(m => m.trackStock && (Number(m.stock) || 0) <= 5);
    const lines = [
      ...lowIng.map(i => `• ${i.name}: ${round(i.qty)} ${i.unit} left (par ${i.parLevel})`),
      ...lowProd.map(m => `• ${m.name}: ${Number(m.stock) || 0} in stock`),
    ];
    if (!lines.length) return { kind: 'stock', answer: '✅ Nothing is low right now — everything is above its reorder level.' };
    return { kind: 'stock', answer: `${lines.length} item${lines.length > 1 ? 's' : ''} need attention:\n${lines.join('\n')}`, data: { count: lines.length } };
  }

  // ---- gift card liability ----
  if (/gift card|giftcard|gift-card/.test(q)) {
    const active = giftcards.filter(g => g.active !== false && (g.balance || 0) > 0);
    const liability = round(active.reduce((a, g) => a + (g.balance || 0), 0));
    const issued = round(giftcards.reduce((a, g) => a + (g.initialBalance || 0), 0));
    return { kind: 'giftcards', answer: `You have ${active.length} active gift card${active.length === 1 ? '' : 's'} with ${money(liability)} in outstanding balance (a liability until spent). ${money(issued)} has been loaded in total.`, data: { liability, active: active.length } };
  }

  // ---- loyalty / members ----
  if (/loyal|member|points|top customer|best customer|regular/.test(q)) {
    if (!customers.length) return { kind: 'loyalty', answer: 'No loyalty members yet. Add one by attaching a phone number to a check.' };
    const top = [...customers].sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 5);
    const totalPts = customers.reduce((a, c) => a + (c.points || 0), 0);
    const lines = top.map(c => `• ${c.name || 'Member'} — ${c.points} pts, ${c.visits || 0} visits, ${money(c.totalSpent)} spent`);
    return { kind: 'loyalty', answer: `You have ${customers.length} loyalty member${customers.length === 1 ? '' : 's'} holding ${totalPts.toLocaleString()} points. Your top members:\n${lines.join('\n')}`, data: { members: customers.length } };
  }

  // ---- top sellers / best items ----
  if (/top|best sell|best-sell|most popular|popular|bestseller|best item|selling/.test(q)) {
    const w = windowFor(q);
    const s = salesStats(payments, w);
    const top = topSellers(s.itemCounts, 6);
    if (!top.length) return { kind: 'topsellers', answer: `No sales ${w.label} yet, so there are no top sellers to show.` };
    const lines = top.map(([name, qty], i) => `${i + 1}. ${name} — ${qty} sold`);
    return { kind: 'topsellers', answer: `Top sellers for ${w.label}:\n${lines.join('\n')}`, data: { window: w.label, top } };
  }

  // ---- tips ----
  if (/\btip/.test(q)) {
    const w = windowFor(q);
    const s = salesStats(payments, w);
    return { kind: 'tips', answer: `Tips collected ${w.label}: ${money(s.tips)} across ${s.count} ${sale}${s.count === 1 ? '' : 's'}.`, data: { tips: s.tips } };
  }

  // ---- refunds ----
  if (/refund/.test(q)) {
    const w = windowFor(q);
    const s = salesStats(payments, w);
    const n = s.pays.filter(p => (p.refundedAmount || 0) > 0).length;
    return { kind: 'refunds', answer: `Refunds ${w.label}: ${money(s.refunds)} across ${n} payment${n === 1 ? '' : 's'}.`, data: { refunds: s.refunds } };
  }

  // ---- average check / ticket / sale ----
  if (/average|avg|mean (check|sale|ticket|order)|per (check|sale|order|customer)/.test(q)) {
    const w = windowFor(q);
    const s = salesStats(payments, w);
    if (!s.count) return { kind: 'avg', answer: `No ${sale}s ${w.label} yet, so there's no average to show.` };
    return { kind: 'avg', answer: `Your average ${sale} ${w.label} is ${money(s.avg)} (${money(s.gross)} across ${s.count} ${sale}s).`, data: { avg: s.avg } };
  }

  // ---- food cost / margin / profit ----
  if (/food cost|margin|profit|cost of goods|cogs/.test(q)) {
    const w = windowFor(q);
    const s = salesStats(payments, w);
    const costOf = new Map(inventory.map(i => [i.id, i.cost]));
    const recipeOf = new Map(); menu.forEach(m => { recipeOf.set(m.name, m.recipe || []); });
    let foodCost = 0;
    s.pays.forEach(p => (p.lines || []).forEach(l => {
      (recipeOf.get(l.name) || []).forEach(r => { foodCost += (Number(costOf.get(r.invId)) || 0) * (Number(r.qty) || 0) * (Number(l.qty) || 1); });
    }));
    foodCost = round(foodCost);
    const preTax = round(s.gross - s.tax);
    const pct = preTax > 0 ? round((foodCost / preTax) * 100) : 0;
    const profit = round(preTax - foodCost);
    if (foodCost <= 0) return { kind: 'foodcost', answer: `I can't calculate food cost ${w.label} yet — add recipes to your menu items (ingredients + quantities) under Menu → Edit → Recipe, and stock costs under Inventory.` };
    return { kind: 'foodcost', answer: `For ${w.label}: food cost ${money(foodCost)} on ${money(preTax)} of pre-tax sales = ${pct}% food cost, leaving ${money(profit)} gross profit. ${pct <= 33 ? 'That\'s a healthy margin.' : 'That\'s on the high side — review pricing or portions.'}`, data: { foodCost, pct } };
  }

  // ---- counts / how many / busy ----
  if (/how many|number of|count|busy|busiest|orders?\b|sales?\b/.test(q) && !/much|revenue|made|sold|sales? (figure|total|amount)/.test(q)) {
    const w = windowFor(q);
    const s = salesStats(payments, w);
    return { kind: 'count', answer: `You've had ${s.count} ${sale}${s.count === 1 ? '' : 's'} ${w.label}, totaling ${money(s.gross)}.`, data: { count: s.count } };
  }

  // ---- revenue / how much did I make/sell (catch-all sales question) ----
  if (/how much|revenue|made|sold|sales|sell|earn|take|gross|net|income|total/.test(q)) {
    const w = windowFor(q);
    const s = salesStats(payments, w);
    if (!s.count) return { kind: 'sales', answer: `No sales ${w.label} yet.` };
    const methods = Object.entries(s.byMethod).map(([m, v]) => `${m} ${money(v)}`).join(', ');
    let ans = `You ${sell} ${money(s.gross)} ${w.label} across ${s.count} ${sale}${s.count === 1 ? '' : 's'}`;
    if (s.refunds > 0) ans += `, ${money(s.net)} net of ${money(s.refunds)} refunds`;
    ans += `. Average ${sale} ${money(s.avg)}.`;
    if (methods) ans += `\nBy method: ${methods}.`;
    return { kind: 'sales', answer: ans, data: { gross: s.gross, net: s.net, count: s.count } };
  }

  // ---- fallback ----
  return {
    kind: 'unknown',
    answer: "I'm not sure how to answer that yet. I can help with sales, top sellers, stock levels, tips, refunds, average check, loyalty, and gift cards.",
    data: { suggestions: suggestions(mode) },
  };
}
