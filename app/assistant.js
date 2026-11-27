// Ask Invaro (from 1.27.0): a small assistant built into the app. It runs entirely on this computer:
// nothing you type is sent anywhere. It recognises what a question is about from its words (with
// everyday synonyms), picks out any client, stock item or time period you name, and answers from your
// own data (the same figures as the Dashboard) or from the help below, with buttons that take you there.
// It only knows what's written here, so a question it can't place gets suggestions instead of a guess.
// From 1.30.0, if you add your own Gemini key on My details, those questions go to Google's Gemini
// instead, with a summary of your figures (geminiContext below); see gemini.js.

// ---------- understanding a question ----------
const SYNONYMS = {
  owe: ['owe', 'owes', 'owed', 'owing', 'outstanding', 'unpaid', 'debt', 'debts', 'debtor', 'debtors', 'due', 'chase', 'collect'],
  overdue: ['overdue', 'late', 'pastdue', 'behind'],
  invoice: ['invoice', 'invoices', 'invoiced', 'invoicing', 'bill', 'bills', 'billed', 'billing'],
  paid: ['paid', 'payment', 'payments', 'pay', 'pays', 'settled'],
  sales: ['sales', 'sale', 'revenue', 'income', 'earn', 'earned', 'earning', 'earnings', 'turnover', 'made', 'make', 'takings', 'money', 'total', 'totals', 'figures', 'doing', 'going', 'performance', 'performing'],
  month: ['month', 'monthly', 'months'], year: ['year', 'yearly', 'annual', 'ytd'],
  stock: ['stock', 'stocks', 'inventory', 'item', 'items', 'product', 'products', 'goods', 'sku', 'skus'],
  low: ['low', 'short', 'shortage', 'running', 'reorder', 'restock', 'empty', 'out'],
  top: ['top', 'best', 'most', 'biggest', 'largest', 'highest', 'main', 'favourite'],
  sell: ['sell', 'sells', 'selling', 'sold', 'seller', 'sellers', 'popular'],
  client: ['client', 'clients', 'customer', 'customers', 'account', 'accounts'],
  quote: ['quote', 'quotes', 'quotation', 'quotations', 'estimate', 'estimates', 'proposal'],
  howto: ['set', 'setup', 'change', 'add', 'create', 'new', 'start', 'turn', 'use', 'put', 'import', 'connect'], // plus "how do I…", "make a quote" (below)
  compare: ['compare', 'compared', 'versus', 'vs', 'than', 'ahead', 'better', 'worse', 'trend', 'growth'],
  count: ['many', 'much', 'number', 'count', 'left', 'hand', 'onhand', 'have', 'level'],
  last: ['last', 'latest', 'recent', 'previous', 'newest'], next: ['next', 'upcoming'],
  tax: ['vat', 'tax', 'gst'],
};
const CANON = {};
for (const [k, words] of Object.entries(SYNONYMS)) for (const w of words) (CANON[w] ||= []).push(k);
const STOP = new Set(['the', 'a', 'an', 'i', 'me', 'my', 'is', 'are', 'was', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'it', 'this', 'that', 'what', 'whats', 'who', 'which', 'with', 'from', 'by', 'at', 'so', 'far', 'please', 'you', 'your', 'invaro', 'there', 'any', 'all', 'about', 'tell', 'show', 'give', 'list', 'see']);
const wordsOf = t => String(t).toLowerCase().replace(/[’']/g, '').replace(/past due/g, 'pastdue').replace(/on hand/g, 'onhand').split(/[^a-z0-9.\-]+/).filter(Boolean);
function understand(text) {
  const words = wordsOf(text), tags = new Set();
  for (const w of words) {
    (CANON[w] || []).forEach(t => tags.add(t));
    const stem = w.replace(/(ing|ed|es|s)$/, ''); // "chasing" → "chas"; keeps simple plurals working
    if (stem !== w && CANON[stem]) CANON[stem].forEach(t => tags.add(t));
  }
  const lower = String(text).toLowerCase();
  if (/\b(how (do|can|to|should|would|does)|where (do|can|is|are|does)|can i|is there a way|make (an? |my |the )?(new )?(invoice|quote|quotation|estimate|client))\b/.test(lower)) tags.add('howto');
  return { text: lower, words, tags, has: (...t) => t.some(x => tags.has(x)), word: (...w) => w.some(x => words.includes(x)) };
}
// A client or stock item named in the question (its whole name, or a distinctive word of it).
function findNamed(text, list, nameOf, extra = () => []) {
  const t = ` ${String(text).toLowerCase().replace(/[^a-z0-9&.\- ]+/g, ' ')} `;
  let best = null, bestLen = 0;
  for (const x of list) {
    const names = [nameOf(x), ...extra(x)].filter(Boolean).map(n => n.toLowerCase());
    for (const n of names) {
      if (n.length >= 2 && t.includes(` ${n} `) || (n.length >= 4 && t.includes(n))) { if (n.length > bestLen) { best = x; bestLen = n.length; } continue; }
      // A distinctive word of the name: "acme" for "Acme Builders (Pty) Ltd".
      for (const w of n.split(/[^a-z0-9]+/)) if (w.length >= 4 && !STOP.has(w) && !['ltd', 'limited', 'company', 'group', 'holdings', 'services', 'trading'].includes(w) && t.includes(` ${w} `) && w.length > bestLen) { best = x; bestLen = w.length; }
    }
  }
  return best;
}
// The period a question is about: { from, to, label } (dates as yyyy-mm-dd), or null.
function findPeriod(q) {
  const today = todayIso(), y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const range = (y1, m1, months, label) => {
    const from = `${y1}-${pad(m1)}-01`, end = new Date(y1, m1 - 1 + months, 0);
    return { from, to: iso(end) < today ? iso(end) : today, label };
  };
  if (/\blast month\b|\bprevious month\b/.test(q.text)) { const d = new Date(y, m - 2, 1); return range(d.getFullYear(), d.getMonth() + 1, 1, MONTHS[d.getMonth()]); }
  if (/\bthis month\b|\bso far this month\b|\bmonth to date\b/.test(q.text)) return range(y, m, 1, `${MONTHS[m - 1]} so far`);
  if (/\blast year\b|\bprevious year\b/.test(q.text)) return range(y - 1, 1, 12, String(y - 1));
  if (/\bthis year\b|\bytd\b|\byear to date\b/.test(q.text)) return range(y, 1, 12, `${y} so far`);
  if (/\btoday\b/.test(q.text)) return { from: today, to: today, label: 'today' };
  if (/\bthis week\b/.test(q.text)) { const d = parseDate(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return { from: iso(d), to: today, label: 'this week' }; }
  const mi = MONTHS.findIndex(n => q.words.includes(n.toLowerCase()) || q.words.includes(n.toLowerCase().slice(0, 3)));
  if (mi >= 0 && !(mi === 4 && q.words.includes('may') && !/\bmay\s+(20\d\d|\d{4})\b|\bin may\b/.test(q.text))) { // "may" is usually the verb
    const yr = Number((q.text.match(/\b(20\d\d)\b/) || [])[1]) || (mi + 1 > m ? y - 1 : y);
    return range(yr, mi + 1, 1, `${MONTHS[mi]} ${yr}`);
  }
  const yr = q.text.match(/\b(20\d\d)\b/);
  if (yr) return range(Number(yr[1]), 1, 12, yr[1]);
  return null;
}

// ---------- answers ----------
const A = (html, actions = []) => ({ html, actions });
const goBtn = (label, tab, then) => ({ label, run: () => { go(tab); if (then) then(); } });
const figuresAllowed = () => can('reports');
const noFigures = () => A(`Money figures are for admins and the accountant in ${esc(teamState.team ? teamState.team.name : 'your team')}. I can still help you find your way around: try “how do I make a quote?”.`);
const curList = () => dashCurrencies();
const M = (v, c) => esc(money(v, c));
const inPeriod = (h, p, by = 'date') => { const d = by === 'paid' ? h.paidAt : h.inv.date; return d && d >= p.from && d <= p.to; };
function perCurrency(fn) { return curList().map(c => fn(c)).filter(Boolean); }

const DATA_INTENTS = [
  { id: 'owe', test: q => q.has('owe') && !q.has('howto') || (q.has('owe') && q.word('who', 'whos')), answer(q, ctx) {
    if (!figuresAllowed()) return noFigures();
    const c = ctx.client;
    if (c) {
      const list = realInvoices().filter(h => h.c.id === c.id && isOwedStatus(h));
      if (!list.length) return A(`${esc(c.company)} doesn't owe you anything: every invoice is paid. 🎉`, [goBtn('History', 'history')]);
      const od = list.filter(h => payStatus(h).key === 'overdue');
      return A(`${esc(c.company)} owes you <b>${M(sumBy(list, owedOn), c.currency)}</b>${homeNote(sumBy(list, owedOn), curCode(c.currency))} on ${list.length} invoice${list.length === 1 ? '' : 's'}${od.length ? `, ${od.length} overdue` : ''}:<ul>${list.map(h => `<li>${esc(h.inv.number)}, ${M(owedOn(h), h.c.currency)}${owedOn(h) < num(h.total) ? ` of ${M(h.total, h.c.currency)}` : ''}, due ${esc(h.inv.due || '–')}${payStatus(h).key === 'overdue' ? ' <span class="status overdue">Overdue</span>' : ''}</li>`).join('')}</ul>`, [{ label: 'Statement for them', run: () => openStatement(c.id) }, goBtn('Open History', 'history')]);
    }
    const parts = perCurrency(cur => { const f = moneyFacts(cur); return f.owed.count ? { cur, f } : null; });
    // Older invoices without a paid status aren't counted as owed: say which, never "everything's paid".
    const unknown = unknownStatus();
    const unknownNote = unknown.length ? `<p>${unknown.length === 1 ? 'One invoice has' : `${unknown.length} invoices have`} no paid status yet, so ${unknown.length === 1 ? "it isn't" : "they aren't"} counted: ${unknown.slice(0, 6).map(h => `${esc(h.inv.number)} (${esc(h.c.company)}, ${M(h.total, h.c.currency)})`).join(', ')}${unknown.length > 6 ? '…' : ''}. If ${unknown.length === 1 ? "it hasn't" : "they haven't"} been paid, they may owe you this too. Mark ${unknown.length === 1 ? 'it' : 'each'} paid or unpaid in History.</p>` : '';
    if (!parts.length) return A(unknown.length ? `No invoice is marked unpaid.${unknownNote}` : 'Nobody owes you anything right now: every invoice is marked paid. 🎉', [goBtn('Open History', 'history')]);
    const home = homeCur(), all = home && (parts.length > 1 || parts[0].cur !== home) ? moneyFacts('all') : null;
    const totalLine = all && !all.missing ? `<p>In all, that's about <b>${esc(wholeMoney(all.owed.total, home))}</b> at today's rates.</p>` : '';
    return A(parts.map(({ cur, f }) => `<p>You're owed <b>${M(f.owed.total, cur)}</b>${homeNote(f.owed.total, cur)} on ${f.owed.count} invoice${f.owed.count === 1 ? '' : 's'}${f.overdue.count ? `, ${M(f.overdue.total, cur)} of it overdue` : ''}. Most is from:</p><ul>${f.debtors.slice(0, 5).map(d => `<li><b>${esc(d.name)}</b>: ${M(d.total, cur)}${homeNote(d.total, cur)} on ${d.count} invoice${d.count === 1 ? '' : 's'}${d.overdue ? `, ${d.overdue} overdue` : ''}</li>`).join('')}</ul>`).join('') + totalLine + unknownNote,
      [goBtn('Open History', 'history'), goBtn('Dashboard', 'dashboard')]);
  } },
  { id: 'overdue', test: q => q.has('overdue') && !q.has('howto'), answer() {
    if (!figuresAllowed()) return noFigures();
    const list = realInvoices().filter(h => payStatus(h).key === 'overdue');
    if (!list.length) return A('Nothing is overdue. ✓', [goBtn('History', 'history')]);
    return A(`<b>${list.length} invoice${list.length === 1 ? ' is' : 's are'} overdue:</b><ul>${list.slice(0, 8).map(h => `<li>${esc(h.inv.number)} · ${esc(h.c.company)} · ${M(owedOn(h), h.c.currency)}${owedOn(h) < num(h.total) ? ` still owed of ${M(h.total, h.c.currency)}` : ''}${homeNote(owedOn(h), invCur(h))}, due ${esc(h.inv.due)}</li>`).join('')}</ul>${list.length > 8 ? `…and ${list.length - 8} more.` : ''} Invaro reminds you about these the day after they're due, then weekly. Mark them paid in History when the money arrives.`,
      [goBtn('Open History', 'history')]);
  } },
  { id: 'lowstock', test: q => q.has('low') && (q.has('stock') || q.word('running', 'out')) || q.word('reorder', 'restock'), answer() {
    const low = liveItems().filter(s => isLow(s)), none = liveItems().filter(s => onHand(s.id) <= 0 && !isLow(s));
    if (!liveItems().length) return A('You have no stock items yet. Add them on the Stock tab, or import them from a spreadsheet or your WooCommerce shop.', [goBtn('Stock', 'stock')]);
    if (!low.length && !none.length) return A('Nothing is low on stock. ✓ (An item counts as low once it reaches the “Low stock at” level you set for it.)', [goBtn('Stock', 'stock')]);
    return A(`${low.length ? `<b>Low on stock:</b><ul>${low.map(s => `<li>${esc(s.name)}: ${esc(qtyText(onHand(s.id), s))} (low at ${esc(qtyText(num(s.lowAt), s))})</li>`).join('')}</ul>` : ''}${none.length ? `<b>None left:</b> ${esc(none.slice(0, 8).map(s => s.name).join(', '))}${none.length > 8 ? '…' : ''}` : ''}`,
      [goBtn('Stock', 'stock', () => { $('#st-low').checked = !!low.length; renderStockList(); })]);
  } },
  { id: 'bestsellers', test: q => (q.has('sell') && (q.has('top') || q.has('stock'))) || (q.has('top') && q.has('stock')), answer() {
    if (!figuresAllowed()) return noFigures();
    const since = monthsBack(12)[0] + '-01';
    const parts = perCurrency(cur => { const b = bestSellers(cur, since); return b.length ? `<b>Best sellers (${cur}, last 12 months):</b><ol>${b.slice(0, 5).map(x => `<li>${esc(x.name)}: ${esc(qtyText(x.qty, x))} sold, ${M(x.sales, cur)}</li>`).join('')}</ol>` : ''; });
    return parts.length ? A(parts.join(''), [goBtn('Dashboard', 'dashboard')]) : A('No stock has been sold on invoices in the last 12 months yet. Add items to an invoice with “+ Add from stock”.', [goBtn('New invoice', 'invoice')]);
  } },
  { id: 'stocklevel', test: (q, ctx) => !!ctx.item && !q.has('howto', 'sell'), answer(q, ctx) {
    const s = ctx.item, prices = Object.entries(s.prices || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => M(v, k));
    return A(`<b>${esc(s.name)}</b>${s.sku ? ` (${esc(s.sku)})` : ''}: <b>${esc(qtyText(onHand(s.id), s))}</b> on hand${isLow(s) ? ' <span class="status unpaid">Low</span>' : ''}.${prices.length ? ` Sells for ${prices.join(' · ')}.` : ''}${s.removed ? ' It has been removed from your stock.' : ''}`,
      [goBtn('Open it', 'stock', () => pickStock(s.id))]);
  } },
  { id: 'topclient', test: q => q.has('top') && q.has('client'), answer() {
    if (!figuresAllowed()) return noFigures();
    const parts = perCurrency(cur => { const f = moneyFacts(cur); return f.topClients.length ? `<b>Top clients (${cur}, last 12 months):</b><ol>${f.topClients.slice(0, 5).map(c => `<li>${esc(c.name)}: ${M(c.total, cur)} on ${c.count} invoice${c.count === 1 ? '' : 's'}${f.invoiced.last12 ? ` (${Math.round(c.total / f.invoiced.last12 * 100)}%)` : ''}</li>`).join('')}</ol>` : ''; });
    return parts.length ? A(parts.join(''), [goBtn('Dashboard', 'dashboard')]) : A('No invoices in the last 12 months yet.');
  } },
  { id: 'quotes', test: q => q.has('quote') && !q.has('howto') && !q.word('convert', 'turn'), answer() {
    if (!figuresAllowed()) return noFigures();
    const open = openQuotes();
    if (!open.length) return A('You have no open quotes (ones still in date that haven\'t been made into an invoice).', [goBtn('Make a quote', 'invoice', () => $('#doc-type [data-type="quote"]').click())]);
    return A(`<b>${open.length} open quote${open.length === 1 ? '' : 's'}:</b><ul>${open.slice(0, 8).map(h => `<li>${esc(h.inv.number)} · ${esc(h.c.company)} · ${M(h.total, h.c.currency)}, valid until ${esc(h.inv.due || '–')}</li>`).join('')}</ul>To bill one, click it in History and choose Make invoice.`, [goBtn('Open History', 'history')]);
  } },
  { id: 'lastinvoice', test: q => q.has('last', 'next') && q.has('invoice', 'quote') && !q.has('sales', 'paid') && !findPeriod(q), answer(q) {
    if (q.has('next')) return A(`Your next invoice will be <b>${esc(nextInvoiceNumber('invoice'))}</b> and your next quote <b>${esc(nextInvoiceNumber('quote'))}</b>. You can change the numbering in My details → Invoice settings.`, [goBtn('My details', 'me')]);
    const h = invoices[0];
    if (!h) return A('You haven\'t saved any invoices yet.', [goBtn('New invoice', 'invoice')]);
    return A(`The last one you saved was <b>${esc(h.inv.number)}</b> for ${esc(h.c.company)}, ${M(h.total, h.c.currency)}, dated ${esc(h.inv.date)} (${esc(payStatus(h).label.toLowerCase())}).`, [{ label: 'Show it', run: () => { go('history'); pickHistory(h.id); } }]);
  } },
  { id: 'tax', test: q => q.has('tax') && (q.has('much', 'count', 'sales', 'owe') || !!findPeriod(q)) && !q.has('howto'), answer(q) {
    if (!figuresAllowed()) return noFigures();
    const p = findPeriod(q) || { from: todayIso().slice(0, 4) + '-01-01', to: todayIso(), label: `${todayIso().slice(0, 4)} so far` };
    const label = settings.taxLabel || 'VAT';
    // Less the tax on credit notes dated in the period, as on a VAT return.
    const parts = perCurrency(cur => { const at = h => invCur(h) === cur && inPeriod(h, p); const t = round2(sumBy(realInvoices().filter(at), h => h.tax) - sumBy(creditNotes().filter(at), h => h.tax)); return t ? `${M(t, cur)}` : ''; });
    return A(parts.length ? `${esc(label)} on invoices dated ${esc(p.label)}: <b>${parts.join(' + ')}</b>.` : `No ${esc(label)} on invoices dated ${esc(p.label)}.`, [goBtn('Reports', 'reports')]);
  } },
  // Last: amounts for a period ("how much did I invoice in October?", "how's this month going?").
  { id: 'amounts', test: (q, ctx) => !(ctx.client && !findPeriod(q)) && q.has('sales', 'paid', 'invoice', 'compare') && (q.has('count', 'sales', 'compare', 'paid') || !!findPeriod(q) || q.has('month', 'year')) && !q.has('howto') || (q.has('compare') && q.has('month', 'year')), answer(q, ctx) {
    if (!figuresAllowed()) return noFigures();
    const p = findPeriod(q);
    const byPaid = q.has('paid') && !q.has('invoice');
    if (!p || q.has('compare') || (/\bhow.*(going|doing)\b/.test(q.text))) {
      const parts = perCurrency(cur => { const f = moneyFacts(cur); return f.list.length ? `<p><b>${cur}:</b> invoiced ${M(f.invoiced.thisM, cur)} in ${esc(monthName(f.thisM).split(' ')[0])} so far${f.invoiced.lastM ? ` (${esc(changeText(f.invoiced.thisM, f.invoiced.lastM, 'last month'))})` : ''}, ${M(f.paid.thisM, cur)} paid to you. ${f.invoiced.lastY ? `Same month last year: ${M(f.invoiced.lastY, cur)}.` : ''} You're owed ${M(f.owed.total, cur)}${f.overdue.count ? `, ${M(f.overdue.total, cur)} of it overdue` : ''}.</p>` : ''; });
      return A(parts.join('') || 'No invoices yet, so there\'s nothing to compare.', [goBtn('Dashboard', 'dashboard')]);
    }
    const parts = perCurrency(cur => {
      const mine = h => invCur(h) === cur && (!ctx.client || h.c.id === ctx.client.id);
      if (byPaid) { // the payments made in the period, part payments included
        const pays = realInvoices().filter(mine).flatMap(h => paymentsOf(h).filter(x => x.on >= p.from && x.on <= p.to).map(x => ({ h, amount: num(x.amount) })));
        const n = new Set(pays.map(x => x.h.id)).size;
        return pays.length ? `<b>${M(sumBy(pays, x => x.amount), cur)}</b> on ${n} invoice${n === 1 ? '' : 's'}` : '';
      }
      // Invoiced, less credit notes dated in the period.
      const list = realInvoices().filter(h => mine(h) && inPeriod(h, p)), cn = creditNotes().filter(h => mine(h) && inPeriod(h, p));
      return list.length || cn.length ? `<b>${M(sumBy(list, h => h.total) - sumBy(cn, h => h.total), cur)}</b> on ${list.length} invoice${list.length === 1 ? '' : 's'}${cn.length ? `, after ${cn.length} credit note${cn.length === 1 ? '' : 's'}` : ''}` : '';
    });
    const who = ctx.client ? ` for ${esc(ctx.client.company)}` : '';
    return A(parts.length ? `${byPaid ? 'Paid to you' : 'Invoiced'}${who} in ${esc(p.label)}: ${parts.join(' and ')}. ${byPaid ? '(By the day each payment was made.)' : '(By invoice date, including VAT/tax.)'}` : `Nothing ${byPaid ? 'was paid' : 'was invoiced'}${who} in ${esc(p.label)}.`,
      [goBtn('Reports', 'reports'), goBtn('Dashboard', 'dashboard')]);
  } },
  { id: 'clientinfo', test: (q, ctx) => !!ctx.client && !q.has('howto'), answer(q, ctx) {
    const c = ctx.client, list = realInvoices().filter(h => h.c.id === c.id);
    const since = monthsBack(12)[0] + '-01', last = list[0];
    const owed = list.filter(isOwedStatus);
    const bits = [`<b>${esc(c.company)}</b>: billed in ${esc(curCode(c.currency))}${num(c.dailyRate) ? `, ${M(c.dailyRate, c.currency)}/day` : ''}${num(c.hourlyRate) ? `, ${M(c.hourlyRate, c.currency)}/hour` : ''}, payment terms ${esc(c.dueDays ?? '–')} days.`];
    if (figuresAllowed()) {
      bits.push(`Invoiced in the last 12 months: <b>${M(sumBy(list.filter(h => h.inv.date >= since), h => h.total), c.currency)}</b>.`);
      bits.push(owed.length ? `They owe you ${M(sumBy(owed, owedOn), c.currency)} on ${owed.length} invoice${owed.length === 1 ? '' : 's'}.` : 'Nothing outstanding.');
    }
    if (last) bits.push(`Last invoice: ${esc(last.inv.number)} on ${esc(last.inv.date)}.`);
    return A(bits.join(' '), [{ label: 'Invoice them', run: () => invoiceClient(c.id) }, ...(figuresAllowed() && owed.length ? [{ label: 'Statement', run: () => openStatement(c.id) }] : []), { label: 'Client details', run: () => { editingClient = c.id; go('clients'); } }]);
  } },
];

// How-to answers: the words that point to each, and what to say. (Kept in step with the app's labels.)
const HELP = [
  { k: ['invoice', 'new', 'make', 'create', 'start', 'bill'], need: ['invoice', 'bill'], t: 'Make an invoice', a: 'On <b>New invoice</b>, pick the client, check the number and dates, and fill in the lines (days, hours, items or fixed amounts are priced from the client\'s rates). The preview on the right updates as you type. Click <b>Save invoice</b> to save the PDF in the client\'s folder and record it in History.', go: 'invoice' },
  { k: ['quote', 'quotation', 'estimate', 'make', 'create', 'new'], need: ['quote', 'quotation', 'estimate'], t: 'Make a quote', a: 'On <b>New invoice</b>, switch the toggle at the top right from Invoice to <b>Quote</b>. Quotes have their own numbering and a “valid until” date, and don\'t take stock off. Click <b>Save quote</b> when it\'s ready.', go: 'invoice', then: () => $('#doc-type [data-type="quote"]').click() },
  { k: ['convert', 'turn', 'quote', 'into', 'invoice', 'accepted'], need: ['convert', 'turn', 'accepted', 'into'], t: 'Turn a quote into an invoice', a: 'In <b>History</b>, click the quote and choose <b>Make invoice</b>. A new invoice starts with the quote\'s lines; check it and click Save invoice.', go: 'history' },
  { k: ['mark', 'paid', 'payment', 'received', 'unpaid', 'undo', 'invoice'], need: ['mark', 'paid', 'received'], t: 'Mark an invoice paid', a: 'In <b>History</b>, click <b>Mark paid</b> next to the invoice (Undo reverses it). For a quote paid in parts, click <b>Payments</b> and tick each line as it\'s paid.', go: 'history' },
  { k: ['part', 'partial', 'deposit', 'instalment', 'installment', 'some', 'payment', 'paid', 'invoice'], need: ['part', 'partial', 'deposit', 'instalment', 'installment'], t: 'Record a part payment', a: 'In <b>History</b>, click <b>Payments</b> next to the invoice, type the amount and date, and click <b>Add payment</b>. The invoice shows what’s still owed, and it’s marked paid once the payments cover it.', go: 'history' },
  { k: ['credit', 'note', 'cancel', 'refund', 'reduce', 'return', 'returned', 'invoice', 'vat'], need: ['credit', 'cancel', 'refund', 'reduce'], t: 'Cancel or reduce an invoice (credit note)', a: 'In <b>History</b>, click the invoice and choose <b>Credit note</b>. It starts as the whole invoice: change or remove lines to credit only part of it, give a reason, and click <b>Save credit note</b>. It comes off what the client owes, and off your sales and VAT in Reports. (Admins only, in a team.)', go: 'history' },
  { k: ['statement', 'statements', 'account', 'balance', 'owes', 'chase', 'client'], need: ['statement', 'statements', 'chase'], t: 'Send a client a statement', a: 'On <b>Clients</b>, pick the client and, under <b>Statement</b>, choose the dates and click <b>Save statement PDF</b>. It lists their invoices, credit notes and payments with a running balance and what’s overdue. The overdue bars and invoice reminders offer one when a client owes you.', go: 'clients' },
  { k: ['tax', 'year', 'financial', 'fiscal', 'april', 'march', 'july', 'start', 'starts'], need: ['fiscal', 'financial', 'april', 'july'], also: ['year'], t: 'Change when your tax year starts', a: 'On <b>Reports</b>, choose when your tax year starts (1 March for South Africa, 6 April for UK personal tax, 1 July for Australia, or the 1st of any month for a company year end). The periods change to match.', go: 'reports' },
  { k: ['edit', 'change', 'fix', 'mistake', 'saved', 'correct', 'update', 'invoice', 'quote'], need: ['edit', 'fix', 'mistake', 'correct'], t: 'Change a saved invoice', a: 'In <b>History</b>, click the invoice and choose <b>Edit</b>. Make your changes and click <b>Save changes</b>: it keeps its number, file and paid status, and stock is adjusted by the difference.', go: 'history' },
  { k: ['delete', 'remove', 'invoice', 'history'], need: ['delete', 'remove'], not: ['stock', 'item', 'client', 'logo'], t: 'Remove an invoice', a: 'In <b>History</b>, click it and choose <b>Remove</b>. The PDF file stays in its folder, and any stock it took is put back.', go: 'history' },
  { k: ['folder', 'file', 'pdf', 'find', 'where', 'saved', 'open', 'show', 'invoice'], need: ['folder', 'file', 'pdf', 'find'], t: 'Find an invoice\'s PDF', a: 'In <b>History</b>, click the invoice and choose <b>Show in folder</b> (or <b>Open</b>). PDFs are saved in a folder per client inside your data folder.', go: 'history' },
  { k: ['client', 'customer', 'add', 'new', 'create'], need: ['client', 'customer'], t: 'Add a client', a: 'On <b>Clients</b>, click <b>+ New client</b> and fill in their company, contacts, address, currency, payment terms and rates. The preview on the right shows how they\'ll appear on an invoice.', go: 'clients' },
  { k: ['rate', 'rates', 'hourly', 'daily', 'price', 'terms', 'currency'], need: ['rate', 'rates', 'hourly', 'daily', 'terms', 'currency'], t: 'Client rates, currency and terms', a: 'Each client has its own currency, payment terms (days), hourly and daily rate, day-off reduction and tax rate, on the <b>Clients</b> tab. Hours and days on invoices are priced from these.', go: 'clients' },
  { k: ['hide', 'rates', 'show', 'pdf'], need: ['hide'], t: 'Leave rates off the PDF', a: 'On <b>New invoice</b>, untick <b>Show rates on the PDF</b> to show only quantities and amounts. New invoices start the way you last chose.', go: 'invoice' },
  { k: ['discount', 'off', 'percent', 'percentage', 'reduce'], need: ['discount', 'percent', 'percentage'], t: 'Give a discount', a: 'Click <b>%</b> beside a line for a discount on that line (a percentage or an amount), or tick <b>Discount on the whole invoice</b> under the lines and type a percentage and a reason.', go: 'invoice' },
  { k: ['stock', 'item', 'product', 'add', 'new', 'create'], need: ['stock', 'item', 'product', 'inventory'], not: ['import', 'csv', 'woocommerce', 'picture', 'photo', 'image', 'count', 'received', 'invoice', 'quote'], t: 'Add stock items', a: 'On <b>Stock</b>, click <b>+ New item</b>, then give it a name, code, unit and a price in each currency you sell in. Set how many you have with <b>Counted</b> and <b>Update stock</b>.', go: 'stock' },
  { k: ['stock', 'item', 'invoice', 'quote', 'add', 'line'], need: ['stock', 'item', 'product'], also: ['invoice', 'quote', 'line'], t: 'Put stock on an invoice or quote', a: 'On <b>New invoice</b>, click <b>+ Add from stock</b>, search, and pick the item: it\'s added at its price in the client\'s currency. Saving an invoice takes it off what\'s on hand; quotes don\'t.', go: 'invoice' },
  { k: ['count', 'received', 'delivery', 'adjust', 'stocktake', 'update', 'stock'], need: ['count', 'received', 'delivery', 'adjust', 'stocktake'], t: 'Update stock counts', a: 'On <b>Stock</b>, click the item, choose <b>Received</b>, <b>Taken out</b> or <b>Counted</b>, type the number and click <b>Update stock</b>. Each change is kept in the item\'s history.', go: 'stock' },
  { k: ['import', 'csv', 'spreadsheet', 'excel', 'upload', 'stock', 'bulk'], need: ['import', 'csv', 'spreadsheet', 'excel', 'bulk'], not: ['woocommerce', 'woo', 'wordpress', 'website', 'shop'], t: 'Import stock from a spreadsheet', a: 'On <b>Stock</b>, click <b>Import CSV…</b> (in Excel, save as CSV first). Rows match your items by code, or by name; you see every change before it\'s saved. <b>Download a template</b> shows the columns.', go: 'stock' },
  { k: ['woocommerce', 'woo', 'wordpress', 'website', 'shop', 'online', 'store', 'import', 'connect', 'sync'], need: ['woocommerce', 'woo', 'wordpress', 'website', 'shop', 'online'], t: 'Bring in products from WooCommerce', a: 'On <b>Stock</b>, under <b>Your WooCommerce shop</b>, type your website address and a read-only REST API key (WooCommerce → Settings → Advanced → REST API → Add key, permissions Read), click <b>Connect</b>, then <b>Import from WooCommerce</b>. Names, codes, categories, prices, stock levels and pictures come in.', go: 'stock' },
  { k: ['picture', 'pictures', 'photo', 'photos', 'image', 'images', 'stock', 'item'], need: ['picture', 'pictures', 'photo', 'photos', 'image', 'images'], not: ['logo'], t: 'Add pictures to stock', a: 'On <b>Stock</b>, click an item and choose <b>Add picture…</b>. Items imported from WooCommerce bring their shop picture with them.', go: 'stock' },
  { k: ['quickbooks', 'xero', 'sage', 'wave', 'zoho', 'freshbooks', 'import', 'move', 'switch', 'migrate', 'old', 'previous', 'invoices', 'customers', 'clients', 'bring'], need: ['quickbooks', 'xero', 'sage', 'wave', 'zoho', 'freshbooks', 'migrate', 'switch', 'previous', 'old'], not: ['pdf', 'pdfs'], t: 'Move from another app', a: 'Export your customers, products and services, and invoices from the old app as CSV or Excel. Then use <b>Import…</b> on the Clients tab (customers), <b>Import CSV…</b> on Stock (products), <b>Import invoices…</b> on History, or <b>My details → Moving from another app</b> for any of them. You see everything before it\'s added.', go: 'history' },
  { k: ['pdf', 'pdfs', 'old', 'previous', 'invoices', 'add', 'import', 'past'], need: ['pdf', 'pdfs'], also: ['old', 'previous', 'past', 'import', 'add', 'existing'], t: 'Add old PDF invoices', a: 'On <b>History</b>, click <b>Add old PDFs…</b> and choose the files. Invaro reads each one and suggests its client, number, dates and total for you to check; then each PDF is copied into its client\'s folder and counts in your reports.', go: 'history' },
  { k: ['currency', 'home', 'my', 'own', 'convert', 'brackets', 'rand', 'pounds', 'worth', 'today'], need: ['currency', 'convert', 'brackets'], not: ['client', 'customer', 'report', 'reports'], t: 'Your currency', a: 'On <b>My details</b>, set <b>Your currency</b>. Amounts owed in other currencies then show what they\'re worth in yours today, in brackets, and the Dashboard can add everything up in your currency, split by currency.', go: 'me' },
  { k: ['logo', 'brand', 'branding'], need: ['logo', 'brand', 'branding'], t: 'Add your logo', a: 'On <b>My details</b>, under <b>Invoice design</b>, click <b>Choose logo…</b>. A PNG with a transparent background looks best. The preview on the right shows it on an example invoice.', go: 'me' },
  { k: ['design', 'template', 'colour', 'color', 'look', 'style', 'theme'], need: ['design', 'template', 'colour', 'color', 'look', 'style'], t: 'Change how invoices look', a: 'On <b>My details</b>, under <b>Invoice design</b>, pick one of the nine templates and your colours. The preview shows the change straight away.', go: 'me' },
  { k: ['bank', 'banking', 'eft', 'account', 'branch', 'swift', 'details'], need: ['bank', 'banking', 'eft', 'branch', 'swift'], t: 'Add your banking details', a: 'On <b>My details</b>, under <b>Banking details (EFT)</b>, tick <b>Show banking details</b> and fill them in. Picking a South African bank fills in its branch and SWIFT codes. They print at the bottom of invoices (not quotes).', go: 'me' },
  { k: ['vat', 'tax', 'gst', 'number', 'registration', 'rate', 'charge'], need: ['vat', 'tax', 'gst'], t: 'VAT / tax', a: 'Set the <b>Tax rate to charge</b> on each client (Clients tab) to add a VAT line to their invoices. Your own VAT, tax and registration numbers go in <b>My details</b>, and the name of the tax (VAT, GST…) under Invoice settings.', go: 'clients' },
  { k: ['number', 'numbering', 'prefix', 'sequence', 'start'], need: ['number', 'numbering', 'prefix', 'sequence'], t: 'Invoice numbering', a: 'On <b>My details</b>, under <b>Invoice settings</b>, set the invoice and quote prefixes and the next numbers. Invaro never goes backwards past a number you\'ve already used.', go: 'me' },
  { k: ['reminder', 'reminders', 'notification', 'notifications', 'remind', 'alert'], need: ['reminder', 'reminders', 'notification', 'notifications', 'remind', 'alert'], t: 'Reminders', a: 'On <b>Notifications</b>, pick a day of the month for each client. Your computer reminds you once a day from then until you\'ve invoiced them, even when Invaro is closed. Overdue invoices remind you too.', go: 'notifications' },
  { k: ['backup', 'backups', 'drive', 'onedrive', 'google', 'cloud'], need: ['backup', 'backups', 'drive', 'onedrive'], t: 'Back up your invoices', a: 'On <b>My details</b>, under <b>Invoice backup</b>, choose Google Drive, OneDrive or another folder. Every saved PDF is copied there, and History shows ✓ when it\'s backed up.', go: 'me' },
  { k: ['team', 'partner', 'share', 'invite', 'member', 'accountant', 'colleague', 'staff'], need: ['team', 'partner', 'invite', 'member', 'accountant', 'colleague', 'staff'], t: 'Work as a team', a: 'On <b>My details</b>, sign in with Google, create a team and invite people by email as an admin, accountant or team member. The roles table there shows what each can do.', go: 'me' },
  { k: ['sign', 'login', 'account', 'sync', 'computer', 'computers', 'laptop'], need: ['sign', 'login', 'sync', 'computers', 'laptop'], t: 'Use Invaro on more than one computer', a: 'On <b>My details</b>, under <b>Account &amp; sync</b>, click <b>Sign in with Google</b> on each computer. Your clients, stock, settings and invoice history sync; PDF files stay on each computer.', go: 'me' },
  { k: ['report', 'reports', 'export', 'accountant', 'spreadsheet', 'year', 'csv'], need: ['report', 'reports', 'export'], not: ['stock'], t: 'Reports', a: 'On <b>Reports</b>, pick a tax year or calendar year to see what you invoiced, were paid, are owed and charged in VAT, by client and by month. <b>Export to spreadsheet (CSV)</b> gives your accountant the list.', go: 'reports' },
  { k: ['rand', 'zar', 'exchange', 'convert', 'currency', 'rate', 'rates', 'pounds', 'dollars', 'euros'], need: ['rand', 'zar', 'exchange'], t: 'Totals in rand', a: 'On <b>Reports</b>, tick <b>Also show what\'s been paid in rand</b> and pick your bank. What\'s been paid in other currencies gets its rand value at that bank\'s buying rate on the day each payment was made, part payments included.', go: 'reports' },
  { k: ['dashboard', 'analysis', 'chart', 'graph', 'trend', 'overview', 'insights'], need: ['dashboard', 'analysis', 'chart', 'graph', 'overview', 'insights'], t: 'The Dashboard', a: 'The <b>Dashboard</b> shows this month against last month and last year, the last 12 months as a chart, who owes you, top clients and best-selling stock.', go: 'dashboard' },
  { k: ['email', 'send', 'mail', 'whatsapp', 'invoice', 'quote'], need: ['email', 'send', 'mail', 'whatsapp'], t: 'Send an invoice', a: 'Invaro saves the PDF; it doesn\'t send email itself. After saving, click the invoice in <b>History</b> and choose <b>Show in folder</b>, then attach the PDF to your email.', go: 'history' },
  { k: ['data', 'folder', 'move', 'location', 'json'], need: ['data'], t: 'Where your data is kept', a: 'Your clients, stock, settings and history are JSON files in your data folder. See <b>My details → Data</b> to open it or move it (e.g. into OneDrive).', go: 'me' },
  { k: ['update', 'updates', 'version', 'upgrade'], need: ['update', 'updates', 'version', 'upgrade'], not: ['stock', 'count'], t: 'Updates', a: 'Invaro checks for new versions every 30 minutes and shows a bar at the top when one\'s ready. <b>My details → Updates → Check now</b> checks straight away.', go: 'me' },
];
function bestHelp(q) {
  let best = null, bestScore = 0;
  for (const h of HELP) {
    if (!h.need.some(w => q.words.includes(w) || q.words.includes(w + 's'))) continue;
    if (h.not && h.not.some(w => q.words.includes(w))) continue;
    if (h.also && !h.also.some(w => q.words.includes(w))) continue;
    const hit = w => q.words.includes(w) || q.words.includes(w + 's');
    const score = h.k.filter(hit).length + 2 * h.need.filter(hit).length + (h.also ? 2 : 0);
    if (score > bestScore) { best = h; bestScore = score; }
  }
  return best;
}

// The answer to a question: data first when it's asking for figures, otherwise help.
function answer(text) {
  const q = understand(text);
  if (!q.words.length) return null;
  if (/^(hi|hello|hey|howzit|morning|good (morning|afternoon|evening))\b/.test(q.text.trim())) return A(`Hello! Ask me about your invoices, clients or stock (“who owes me money?”, “how much did I invoice in October?”), or how to do something (“how do I add my logo?”).`);
  if (/^(thanks|thank you|cheers|great|ok|okay)\b/.test(q.text.trim())) return A('Any time. 🙂');
  if (/\b(help|what can you do)\b/.test(q.text) && q.words.length <= 5) return A(`I can answer questions about your figures and stock, and show you how to do things in Invaro. For example:<ul><li>Who owes me money?</li><li>How much did I invoice last month?</li><li>How is this month going?</li><li>What's low on stock?</li><li>How many interior doors do I have?</li><li>How do I make a quote?</li><li>How do I import from WooCommerce?</li></ul>Everything stays on this computer.`);
  const ctx = {
    client: findNamed(text, clients, c => c.company),
    item: findNamed(text, stock, s => s.name, s => [s.sku]),
  };
  // "How do I…" asks for help; "how much / how many / how is…" asks for figures.
  const asksHow = /^\s*(how (do|can|to|should|would|does)|where|can i|is there a way|what do i do)\b/.test(q.text);
  if (!asksHow) for (const i of DATA_INTENTS) if (i.test(q, ctx)) return i.answer(q, ctx);
  const h = bestHelp(q);
  if (h) return A(h.a, [{ label: `Go to ${({ invoice: 'New invoice', me: 'My details' })[h.go] || h.go[0].toUpperCase() + h.go.slice(1)}`, run: () => { go(h.go); if (h.then) h.then(); } }]);
  if (asksHow) for (const i of DATA_INTENTS) if (i.test(q, ctx)) return i.answer(q, ctx);
  return null;
}

// ---------- Gemini (optional, with your own key) ----------
let geminiState = null;
const geminiOn = () => !!(geminiState && geminiState.connected);
const plain = html => { const d = document.createElement('div'); d.innerHTML = html; d.querySelectorAll('li').forEach(li => li.prepend('- ')); d.querySelectorAll('li, p, br').forEach(el => el.append('\n')); return d.textContent.replace(/\n{3,}/g, '\n\n').trim(); };
const askHistory = []; // what's been said, as plain text, for follow-up questions
// What Gemini is told about your business: figures only for those allowed to see them (as in the rest of Ask).
function geminiContext() {
  const L = [], figs = figuresAllowed(), me = settings.me || {};
  L.push(`Today: ${todayIso()}. Business: ${me.company || me.name || '(not set)'}. Your currency: ${homeCur() || '(not set)'}. Tax is called ${settings.taxLabel || 'VAT'}.`);
  L.push(`Next invoice number: ${nextInvoiceNumber('invoice')}; next quote number: ${nextInvoiceNumber('quote')}.`);
  if (!figs) L.push('This person is a team member without access to money figures: do not discuss amounts, totals, who owes what or sales. Help them use the app instead.');
  L.push('', '## Clients (name | currency | payment terms in days | daily rate | hourly rate | tax rate %)');
  for (const c of clients.slice(0, 300)) L.push(`${c.company || 'Client'} | ${curCode(c.currency)} | ${c.dueDays ?? ''} | ${figs ? num(c.dailyRate) || '' : ''} | ${figs ? num(c.hourlyRate) || '' : ''} | ${c.taxRate ?? ''}`);
  if (figs) {
    for (const cur of curList()) {
      const f = moneyFacts(cur); if (!f.list.length) continue;
      L.push('', `## Summary in ${cur}`,
        `Owed: ${money(f.owed.total, cur)} on ${f.owed.count} invoices; overdue: ${money(f.overdue.total, cur)} on ${f.overdue.count}.`,
        `Invoiced this year: ${money(f.invoiced.year, cur)}; paid this year: ${money(f.paid.year, cur)}; last 12 months: ${money(f.invoiced.last12, cur)}.`,
        'Month | invoiced (by invoice date) | paid (by date marked paid)', ...f.series.map(m => `${m.m} | ${money(m.invoiced, cur)} | ${money(m.paid, cur)}`));
    }
    const home = homeCur();
    if (home && curList().some(c => c !== home)) {
      const all = moneyFacts('all');
      if (!all.missing) L.push('', `## Everything in ${home} at today's rates`, `Owed: ${money(all.owed.total, home)}; invoiced this year: ${money(all.invoiced.year, home)}; paid this year: ${money(all.paid.year, home)}.`);
    }
    const list = realInvoices();
    L.push('', `## Invoices, newest first (${Math.min(list.length, 400)} of ${list.length}; number | date | client | total incl. tax | tax | due | status)`);
    for (const h of list.slice(0, 400)) L.push(`${h.inv.number} | ${h.inv.date || ''} | ${h.c.company || ''} | ${money(h.total, h.c.currency)} | ${money(h.tax || 0, h.c.currency)} | ${h.inv.due || ''} | ${payStatus(h).key === 'untracked' ? 'paid status not set' : payStatus(h).label}`);
    const q = openQuotes();
    if (q.length) { L.push('', '## Open quotes (number | date | client | total | valid until)'); for (const h of q.slice(0, 100)) L.push(`${h.inv.number} | ${h.inv.date || ''} | ${h.c.company || ''} | ${money(h.total, h.c.currency)} | ${h.inv.due || ''}`); }
    const since = monthsBack(12)[0] + '-01';
    for (const cur of curList()) { const b = bestSellers(cur, since); if (b.length) L.push('', `## Best-selling stock, last 12 months (${cur})`, ...b.slice(0, 15).map(x => `${x.name}: ${qtyText(x.qty, x)} sold, ${money(x.sales, cur)}`)); }
  }
  const items = liveItems();
  if (items.length) {
    L.push('', `## Stock (${Math.min(items.length, 400)} of ${items.length}; name | code | category | on hand | low at | prices)`);
    for (const st of items.slice(0, 400)) L.push(`${st.name} | ${st.sku || ''} | ${st.category || ''} | ${qtyText(onHand(st.id), st)} | ${hasLowLevel(st) ?qtyText(num(st.lowAt), st) : ''} | ${figs ? Object.entries(st.prices || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => money(v, k)).join(', ') : ''}`);
  }
  L.push('', '## How to use Invaro (help text)');
  for (const h of HELP) L.push(`${h.t}: ${plain(h.a)}`);
  return L.join('\n');
}
// Gemini's reply as safe HTML: everything escaped, then **bold** and "- " lists.
function replyHtml(text) {
  const out = []; let list = null;
  for (const raw of esc(text).split('\n')) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const m = line.match(/^\s*[-*•]\s+(.*)$/);
    if (m) { (list ||= []).push(`<li>${m[1]}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line.trim()) out.push(`<p>${line}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}
const geminiSettings = () => goBtn('Gemini settings', 'me', () => $('#gemini-box').scrollIntoView({ block: 'center' }));
let geminiBusy = false;
async function askGemini(text) {
  if (geminiBusy) return;
  geminiBusy = true;
  const el = askSay('bot', '<span class="muted">Asking Gemini…</span>');
  let r;
  try { r = await store.geminiAsk(text, geminiContext(), askHistory.slice(0, -1)); } catch (e) { r = { error: e.message }; }
  geminiBusy = false;
  el.remove();
  if (!r || r.error) return askSay('bot', esc((r && r.error) || 'Gemini didn\'t answer.'), [geminiSettings()]);
  askHistory.push({ who: 'bot', text: r.text });
  askSay('bot', replyHtml(r.text) + '<p class="ask-src">Answered by Google Gemini. Check figures before relying on them.</p>');
}
async function renderGemini() {
  if (!store.geminiStatus) { $('#gemini-box').hidden = true; return; }
  $('#gemini-box').hidden = false;
  if (!geminiState) geminiState = await store.geminiStatus();
  const on = geminiOn() && !$('#gemini-form').dataset.editing;
  $('#gemini-status').className = 'drive-status' + (geminiOn() ? ' on' : '');
  $('#gemini-status').textContent = geminiOn() ? `On, with the key ending …${geminiState.keyEnd}. Questions Ask Invaro can't answer itself go to Gemini.` : 'Off. Ask Invaro answers everything on this computer.';
  $('#gemini-form').hidden = on;
  $('#gemini-on').hidden = !on;
  $('#gemini-cancel').hidden = !geminiOn();
  $('#ask-note').textContent = geminiOn() ? 'Questions it can\'t answer go to Google Gemini.' : 'Runs on this computer. Nothing is sent anywhere.';
}
$('#gemini-get').onclick = () => store.openExternal && store.openExternal('https://aistudio.google.com/apikey');
$('#gemini-connect').onclick = async () => {
  const b = $('#gemini-connect'); b.disabled = true; b.textContent = 'Checking…';
  const r = await store.geminiConnect($('#gemini-key').value);
  b.disabled = false; b.textContent = 'Turn on';
  if (r && r.error) return toast(r.error);
  geminiState = r; $('#gemini-key').value = ''; delete $('#gemini-form').dataset.editing;
  renderGemini();
  toast('Gemini is on. Questions Ask Invaro can\'t answer itself now go to Gemini.');
};
$('#gemini-change').onclick = () => { $('#gemini-form').dataset.editing = '1'; renderGemini(); $('#gemini-key').focus(); };
$('#gemini-cancel').onclick = () => { delete $('#gemini-form').dataset.editing; renderGemini(); };
$('#gemini-disconnect').onclick = async () => {
  if (!confirm('Turn off Gemini? The key is removed from this computer and Ask Invaro goes back to answering everything here.')) return;
  geminiState = await store.geminiDisconnect(); renderGemini();
};
renderGemini();

// ---------- the panel ----------
const SUGGEST = ['Who owes me money?', 'How is this month going?', 'What\'s low on stock?', 'How do I make a quote?', 'Import stock from WooCommerce', 'How much did I invoice last month?'];
function askSay(who, html, actions = []) {
  const el = document.createElement('div'); el.className = `ask-msg ${who}`;
  el.innerHTML = `<div class="ask-bubble">${html}</div>`;
  if (actions.length) {
    const row = document.createElement('div'); row.className = 'ask-acts';
    actions.forEach(a => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = a.label; b.onclick = a.run; row.append(b); });
    el.append(row);
  }
  $('#ask-log').append(el);
  $('#ask-log').scrollTop = $('#ask-log').scrollHeight;
  return el;
}
function ask(text) {
  text = String(text || '').trim(); if (!text || geminiBusy) return;
  askSay('me', esc(text));
  askHistory.push({ who: 'me', text });
  let r = null;
  try { r = answer(text); } catch (e) { r = A(`Sorry, something went wrong working that out (${esc(e.message)}).`); }
  if (!r && geminiOn()) return askGemini(text);
  if (!r) r = A(`I'm not sure about that one. I know about your invoices, clients, stock and how to use Invaro. Try one of these:`, [
    ...SUGGEST.slice(0, 4).map(s => ({ label: s, run: () => ask(s) })),
    ...(store.geminiStatus ? [{ ...geminiSettings(), label: 'Answer more with Gemini…' }] : []),
  ]);
  askHistory.push({ who: 'bot', text: plain(r.html) });
  // A local answer can still go to Gemini, for when it took the question the wrong way.
  const actions = geminiOn() ? [...r.actions, { label: 'Ask Gemini instead', run: () => { askHistory.push({ who: 'me', text }); askGemini(text); } }] : r.actions;
  askSay('bot', r.html, actions);
}
function openAsk() {
  $('#ask').hidden = false; $('#ask-btn').classList.add('on');
  if (!$('#ask-log').children.length) askSay('bot', `Hi! Ask me about your invoices, clients and stock, or how to do something in Invaro. ${geminiOn() ? 'I answer what I can on this computer and pass anything else to Google Gemini.' : 'Everything stays on this computer.'}`, SUGGEST.map(s => ({ label: s, run: () => ask(s) })));
  $('#ask-q').focus();
}
const closeAsk = () => { $('#ask').hidden = true; $('#ask-btn').classList.remove('on'); };
$('#ask-btn').onclick = () => $('#ask').hidden ? openAsk() : closeAsk();
$('#ask-close').onclick = closeAsk;
$('#ask-form').onsubmit = e => { e.preventDefault(); const v = $('#ask-q').value; $('#ask-q').value = ''; ask(v); };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#ask').hidden) closeAsk();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#ask').hidden ? openAsk() : $('#ask-q').focus(); }
});
