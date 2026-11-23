// Dashboard (from 1.27.0): how the months are going. Quotes aren't counted. "Invoiced" goes by each
// invoice's date, "Paid" by the day it was marked paid. The figures here are also what the assistant
// (assistant.js) answers from.
//
// With your currency set (My details, 1.29.0), the Dashboard can show everything in it ("All"): a paid
// invoice in another currency counts at the rate on the day it was paid when Invaro recorded one,
// anything else at today's rate. Amounts owed in another currency show today's value in brackets.
const sumBy = (arr, f) => round2(arr.reduce((t, x) => t + (Number(f(x)) || 0), 0));
const monthKey = d => String(d || '').slice(0, 7);
const monthName = (k, short) => { const d = parseDate(k + '-01'); return `${short ? MONTHS[d.getMonth()].slice(0, 3) : MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
function monthsBack(n, from = todayIso()) {
  const d = parseDate(monthKey(from) + '-01'), out = [];
  for (let i = n - 1; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push(`${x.getFullYear()}-${pad(x.getMonth() + 1)}`); }
  return out;
}
const shiftMonth = (k, by) => monthsBack(1, iso(new Date(parseDate(k + '-01').getFullYear(), parseDate(k + '-01').getMonth() + by, 1)))[0];
const realInvoices = () => invoices.filter(h => docType(h) === 'invoice');
const invCur = h => curCode(h.c && h.c.currency);
function dashCurrencies() {
  const n = {};
  for (const h of realInvoices()) n[invCur(h)] = (n[invCur(h)] || 0) + 1;
  const list = Object.keys(n).sort((a, b) => n[b] - n[a]);
  return list.length ? list : [usualCurrency()];
}
const isOwedStatus = h => ['unpaid', 'overdue'].includes(payStatus(h).key);

// ---------- your currency, and today's rates ----------
const homeCur = () => CURRENCIES[settings.homeCurrency] ? settings.homeCurrency : '';
const todayRand = {}; // currency → { rate (rand per unit), on, bank, source }, from your chosen bank today
let todayAt = 0, todayBank = '', todayBusy = null, todayError = '';
function loadTodayRates(force) {
  if (!store.fxRate || !homeCur()) return null;
  if (todayBusy) return todayBusy;
  if (!force && todayBank === fxBank() && Date.now() - todayAt < 15 * 60 * 1000) return null;
  const bank = fxBank(), want = Object.keys(CURRENCIES).filter(c => c !== 'ZAR');
  todayBusy = Promise.all(want.map(async c => {
    const r = await store.fxRate(bank, c, todayIso());
    if (r && !r.error && r.rate > 0) todayRand[c] = { rate: r.rate, on: r.on, bank: r.bank || bank, source: r.source }; else if (r && r.error) todayError = r.error;
  })).then(() => { todayAt = Date.now(); todayBank = bank; todayBusy = null; homeRatesArrived(); });
  return todayBusy;
}
// Rand per unit of a currency today (1 for rand), or null until it's known.
const randPer = c => c === 'ZAR' ? 1 : todayRand[c] ? todayRand[c].rate : null;
// An amount in another currency in yours, at today's rate (via rand), or null until the rates are in.
function toHome(amount, from) {
  const home = homeCur();
  if (!home || from === home) return home ? num(amount) : null;
  const a = randPer(from), b = randPer(home);
  if (!a || !b) { loadTodayRates(); return null; }
  return round2(num(amount) * a / b);
}
// What an invoice is worth in your currency: the rate on the day it was paid if Invaro has it (rand
// only, since banks quote in rand), otherwise today's.
function homeValue(h) {
  const home = homeCur(), from = invCur(h), t = num(h.total);
  if (!home || from === home) return t;
  if (h.paidAt && home === 'ZAR') { const f = fxOf(h, 'ZAR'); if (f && f.rate > 0) return round2(t * f.rate); }
  return toHome(t, from);
}
const wholeMoney = (v, c) => (v < 0 ? '-' : '') + curSymbol(c) + Math.round(Math.abs(v));
const rateSource = (from, home) => {
  const r = todayRand[from === 'ZAR' ? home : from];
  return r ? `${FX_BANKS[r.bank] || 'Standard Bank'}'s buying rate today` : "today's rate";
};
// " (R39912)" after an amount owed in another currency: plain text, or a span with the rate in its title.
function homeNote(amount, from, html = true) {
  const home = homeCur();
  if (!home || !from || from === home) return '';
  const v = toHome(amount, from);
  if (v == null) return '';
  const text = `(${wholeMoney(v, home)})`;
  if (!html) return ' ' + text;
  const per = round2(randPer(from) / randPer(home));
  return ` <span class="fx-note" title="${esc(`At ${rateSource(from, home)}: 1 ${from} = ${per} ${home}`)}">${esc(text)}</span>`;
}
// Called when today's rates arrive: redraw whatever shows amounts in your currency.
function homeRatesArrived() {
  if (tabShown('dashboard')) renderDashboard();
  if (tabShown('reports')) renderReports();
  renderHistory(); renderOverdue();
}

// Everything the dashboard and the assistant say about money: for one currency, or for 'all' of them
// in yours.
function moneyFacts(view, today = todayIso()) {
  const all = view === 'all', cur = all ? homeCur() : view;
  const list = all ? realInvoices() : realInvoices().filter(h => invCur(h) === view);
  const val = all ? homeValue : h => num(h.total);
  let missing = 0;
  const v = h => { const x = val(h); if (x == null) { missing++; return 0; } return x; };
  const thisM = monthKey(today), lastM = shiftMonth(thisM, -1), lastY = shiftMonth(thisM, -12);
  const invoicedIn = m => sumBy(list.filter(h => monthKey(h.inv.date) === m), v);
  const paidIn = m => sumBy(list.filter(h => h.paidAt && monthKey(h.paidAt) === m), v);
  const owed = list.filter(isOwedStatus), overdue = list.filter(h => payStatus(h).key === 'overdue');
  const months = monthsBack(12, today);
  const year = today.slice(0, 4), yearStart = year + '-01-01';
  const inYear = list.filter(h => h.inv.date >= yearStart && h.inv.date <= today);
  const paidInYear = list.filter(h => h.paidAt && h.paidAt >= yearStart && h.paidAt <= today);
  const byClient = {};
  for (const h of list.filter(x => monthKey(x.inv.date) >= months[0])) {
    const k = h.c.company || 'Client';
    byClient[k] ||= { name: k, id: h.c.id, total: 0, count: 0 };
    byClient[k].total = round2(byClient[k].total + v(h)); byClient[k].count++;
  }
  const debtors = {};
  for (const h of owed) {
    const k = `${h.c.company || 'Client'}\u0000${invCur(h)}`;
    debtors[k] ||= { name: h.c.company || 'Client', id: h.c.id, cur: all ? cur : invCur(h), from: invCur(h), total: 0, count: 0, overdue: 0, own: 0 };
    debtors[k].total = round2(debtors[k].total + v(h)); debtors[k].own = round2(debtors[k].own + num(h.total)); debtors[k].count++;
    if (payStatus(h).key === 'overdue') debtors[k].overdue++;
  }
  // The year, per currency, each also in yours (for the split).
  const split = all ? dashCurrencies().map(c => {
    const iy = inYear.filter(h => invCur(h) === c), py = paidInYear.filter(h => invCur(h) === c);
    return { cur: c, invoiced: sumBy(iy, h => h.total), paid: sumBy(py, h => h.total), invoicedHome: sumBy(iy, v), paidHome: sumBy(py, v), count: iy.length };
  }).filter(s => s.count || s.paid) : [];
  return {
    view, all, cur, today, year, thisM, lastM, lastY, months, list,
    invoiced: { thisM: invoicedIn(thisM), lastM: invoicedIn(lastM), lastY: invoicedIn(lastY), year: sumBy(inYear, v), last12: sumBy(list.filter(h => monthKey(h.inv.date) >= months[0]), v) },
    paid: { thisM: paidIn(thisM), lastM: paidIn(lastM), year: sumBy(paidInYear, v) },
    count: { thisM: list.filter(h => monthKey(h.inv.date) === thisM).length },
    owed: { total: sumBy(owed, v), own: all ? null : sumBy(owed, h => h.total), count: owed.length, list: owed },
    overdue: { total: sumBy(overdue, v), own: all ? null : sumBy(overdue, h => h.total), count: overdue.length, list: overdue },
    series: months.map(m => ({ m, invoiced: invoicedIn(m), paid: paidIn(m) })),
    topClients: Object.values(byClient).sort((a, b) => b.total - a.total),
    debtors: Object.values(debtors).sort((a, b) => b.total - a.total),
    split, missing: missing > 0,
  };
}
// Invoices with no paid status (saved before 1.12.0 and never marked paid or unpaid): not counted as owed,
// so the assistant and the Dashboard say so rather than calling everything paid.
const unknownStatus = cur => realInvoices().filter(h => !h.paidAt && payStatus(h).key === 'untracked' && (!cur || invCur(h) === cur));
// Open quotes: not made into an invoice, and still in date.
function openQuotes(cur) {
  const today = todayIso();
  return invoices.filter(h => docType(h) === 'quote' && !h.convertedTo && (!h.inv.due || h.inv.due >= today) && (!cur || invCur(h) === cur));
}
// What sold best in the last 12 months (stock lines on invoices): in one currency, or all in yours.
function bestSellers(view, since) {
  const out = {}, all = view === 'all';
  for (const h of realInvoices().filter(x => (all || invCur(x) === view) && x.inv.date >= since)) {
    for (const it of h.inv.items || []) {
      if (!it.stockId || it.kind !== 'item') continue;
      const s = stockItem(it.stockId), k = it.stockId;
      const amount = lineAmount(it, h.c) - lineDiscount(it, h.c), inView = all ? toHome(amount, invCur(h)) : amount;
      out[k] ||= { id: k, name: s ? s.name : it.desc, unit: s ? s.unit : it.unit, qty: 0, sales: 0 };
      out[k].qty = round3(out[k].qty + num(it.qty));
      out[k].sales = round2(out[k].sales + (inView || 0));
    }
  }
  return Object.values(out).sort((a, b) => b.sales - a.sales);
}
const change = (now, before) => !before ? null : Math.round((now - before) / before * 100);
const changeText = (now, before, what) => {
  const c = change(now, before);
  if (c == null) return now ? `nothing in ${what}` : '';
  return c === 0 ? `same as ${what}` : `${c > 0 ? '▲' : '▼'} ${Math.abs(c)}% vs ${what}`;
};
// Short money for chart axes: R12k, £1.2m
function shortMoney(v, cur) {
  const a = Math.abs(v), sym = curSymbol(cur);
  const t = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'm' : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k' : String(Math.round(a));
  return (v < 0 ? '-' : '') + sym + t.replace('.0', '');
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

// ---------- the Dashboard tab ----------
let dashCur = '', dashTable = false;
function renderDashboard() {
  const curs = dashCurrencies(), home = homeCur();
  const views = home && (curs.length > 1 || curs[0] !== home) ? ['all', ...curs] : curs;
  if (!views.includes(dashCur)) dashCur = views[0];
  const sel = $('#dash-cur');
  sel.innerHTML = views.map(c => c === 'all' ? `<option value="all">All, in ${home} (${esc(curSymbol(home))})</option>` : `<option value="${c}">${c} only (${esc(curSymbol(c))})</option>`).join('');
  sel.value = dashCur; sel.hidden = views.length < 2;
  if (home) loadTodayRates();
  const f = moneyFacts(dashCur), cur = f.cur, M = v => money(v, cur);
  // In one currency, what's owed also shows today's value in yours.
  const inHome = amount => f.all ? '' : homeNote(amount, cur);
  $('#dash-sub').textContent = `${monthName(f.thisM)} so far · ${f.all ? `all currencies in ${cur}` : cur}${f.missing ? (todayError ? ` · couldn't get today's rates (${todayError})` : " · getting today's rates…") : ''}`;
  const quotes = openQuotes(f.all ? '' : cur), quoteValue = f.all ? sumBy(quotes, h => toHome(h.total, invCur(h))) : sumBy(quotes, h => h.total);
  const tile = (label, value, sub, cls = '', go = '') => `<div class="tile ${cls}"${go ? ` data-go-tab="${go}" role="button" tabindex="0"` : ''}><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub || '&nbsp;'}</div></div>`;
  $('#dash-tiles').innerHTML = [
    tile(`Invoiced in ${MONTHS[parseDate(f.thisM + '-01').getMonth()]}`, M(f.invoiced.thisM), [changeText(f.invoiced.thisM, f.invoiced.lastM, 'last month'), f.invoiced.lastY ? changeText(f.invoiced.thisM, f.invoiced.lastY, monthName(f.lastY, true)) : ''].filter(Boolean).map(esc).join('<br>')),
    tile('Paid to you this month', M(f.paid.thisM), esc(changeText(f.paid.thisM, f.paid.lastM, 'last month'))),
    tile('Owed to you', M(f.owed.total) + inHome(f.owed.total), `${f.owed.count} unpaid invoice${f.owed.count === 1 ? '' : 's'}`, '', 'history'),
    tile('Overdue', M(f.overdue.total) + inHome(f.overdue.total), f.overdue.count ? `⚠ ${f.overdue.count} past the due date` : '✓ Nothing overdue', f.overdue.count ? 'bad' : 'good', 'history'),
    tile(`Earned in ${f.year}`, M(f.paid.year) + inHome(f.paid.year), `Paid to you · ${M(f.invoiced.year)} invoiced`),
    tile('Open quotes', M(quoteValue), `${quotes.length} not yet invoiced`, '', 'history'),
  ].join('');
  // The year split by currency (All view).
  $('#dash-split-card').hidden = !f.all || f.split.length < 1;
  if (f.all) {
    const totalPaid = f.paid.year || 1;
    $('#dash-split').innerHTML = `<table><thead><tr><th>Currency</th><th class="num">Invoiced in ${f.year}</th><th class="num">Earned (paid)</th><th class="num">In ${cur}</th><th class="num">Share</th></tr></thead><tbody>${f.split.map(s => `<tr>
      <td><button class="link" data-dash-cur="${esc(s.cur)}" title="Show ${esc(s.cur)} only">${esc(s.cur)}</button></td><td class="num">${esc(money(s.invoiced, s.cur))}</td><td class="num">${esc(money(s.paid, s.cur))}</td>
      <td class="num">${esc(money(s.paidHome, cur))}</td><td class="num">${f.paid.year ? Math.round(s.paidHome / totalPaid * 100) + '%' : '–'}</td></tr>`).join('')}
      <tr class="sum-row"><td><b>All</b></td><td></td><td></td><td class="num"><b>${esc(money(f.paid.year, cur))}</b></td><td class="num">100%</td></tr></tbody></table>`;
  }
  renderDashChart(f);
  // Top clients, last 12 months.
  const top = f.topClients.slice(0, 6), max = Math.max(1, ...top.map(c => c.total));
  $('#dash-clients').innerHTML = top.length ? top.map(c => `<div class="hbar"><div class="hbar-name">${esc(c.name)} <span class="muted">${c.count} invoice${c.count === 1 ? '' : 's'}</span></div>
    <div class="hbar-val">${esc(M(c.total))}</div><div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(1, c.total / max * 100)}%"></div></div></div>`).join('')
    : '<p class="muted">No invoices in the last 12 months.</p>';
  // Best-selling stock.
  const best = bestSellers(dashCur, f.months[0] + '-01').slice(0, 6);
  $('#dash-stock-card').hidden = !stock.length;
  $('#dash-stock').innerHTML = best.length ? `<table><thead><tr><th>Item</th><th class="num">Sold</th><th class="num">Sales</th></tr></thead><tbody>${best.map(b => `<tr><td>${esc(b.name)}</td><td class="num">${esc(qtyText(b.qty, b))}</td><td class="num">${esc(M(b.sales))}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">No stock sold on invoices in the last 12 months yet.</p>';
  // Things worth knowing, each with a button to act on it.
  $('#dash-insights').innerHTML = insights(f).map(i => `<li class="${i.tone || ''}"><span>${i.text}</span>${i.go ? `<button class="link" data-go-tab="${i.go}">${esc(i.label)}</button>` : ''}</li>`).join('')
    || '<li><span>Save a few invoices and Invaro will point out how the months are going.</span></li>';
}
function insights(f) {
  const out = [], M = v => esc(money(v, f.cur)), mon = monthName(f.thisM).split(' ')[0];
  const c = change(f.invoiced.thisM, f.invoiced.lastM);
  if (c != null && f.invoiced.thisM) out.push({ text: `${mon} is ${c >= 0 ? `<b>${c}% ahead of</b>` : `<b>${-c}% behind</b>`} ${monthName(f.lastM).split(' ')[0]} so far (${M(f.invoiced.thisM)} against ${M(f.invoiced.lastM)}).`, tone: c >= 0 ? 'up' : 'down' });
  else if (!f.invoiced.thisM && f.list.length) out.push({ text: `Nothing invoiced in ${mon} yet.`, go: 'invoice', label: 'New invoice' });
  if (f.overdue.count) out.push({ text: `<b>${f.overdue.count} invoice${f.overdue.count === 1 ? ' is' : 's are'} overdue</b>, ${M(f.overdue.total)} in all. The oldest is ${esc(f.overdue.list.map(h => h.inv.number + ' (' + h.c.company + ')').slice(-1)[0])}.`, tone: 'down', go: 'history', label: 'See in History' });
  if (f.debtors[0]) out.push({ text: `${esc(f.debtors[0].name)} owes you the most: ${M(f.debtors[0].total)} on ${f.debtors[0].count} invoice${f.debtors[0].count === 1 ? '' : 's'}.`, go: 'history', label: 'History' });
  if (f.topClients[0] && f.invoiced.last12) out.push({ text: `${esc(f.topClients[0].name)} is your biggest client: ${Math.round(f.topClients[0].total / f.invoiced.last12 * 100)}% of the last 12 months.` });
  const best = [...f.series].sort((a, b) => b.invoiced - a.invoiced)[0];
  if (best && best.invoiced) out.push({ text: `Your best month in the last year was ${monthName(best.m)}, with ${M(best.invoiced)} invoiced.` });
  const low = liveItems().filter(s => isLow(s));
  if (low.length) out.push({ text: `<b>${low.length} stock item${low.length === 1 ? ' is' : 's are'} low</b>: ${esc(low.slice(0, 3).map(s => s.name).join(', '))}${low.length > 3 ? '…' : ''}.`, tone: 'down', go: 'stock', label: 'Stock' });
  const unknown = unknownStatus(f.all ? '' : f.cur);
  if (unknown.length) out.push({ text: `${unknown.length} older invoice${unknown.length === 1 ? ' has' : 's have'} no paid status, so ${unknown.length === 1 ? "it isn't" : "they aren't"} counted as owed: ${esc(unknown.slice(0, 4).map(h => h.inv.number).join(', '))}${unknown.length > 4 ? '…' : ''}. Mark ${unknown.length === 1 ? 'it' : 'them'} paid or unpaid in History.`, tone: 'down', go: 'history', label: 'History' });
  const q = openQuotes(f.all ? '' : f.cur);
  if (q.length) out.push({ text: `${q.length} quote${q.length === 1 ? '' : 's'} worth ${M(sumBy(q, h => f.all ? toHome(h.total, invCur(h)) : h.total))} ${q.length === 1 ? 'is' : 'are'} still open.`, go: 'history', label: 'History' });
  return out;
}
// Invoiced and paid by month, as grouped bars (one y-axis, money).
function renderDashChart(f) {
  const data = f.series, cur = f.cur;
  $('#dash-chart-toggle').textContent = dashTable ? 'Show as chart' : 'Show as table';
  $('#dash-chart').hidden = dashTable; $('#dash-chart-table').hidden = !dashTable;
  $('#dash-chart-table').innerHTML = `<table><thead><tr><th>Month</th><th class="num">Invoiced</th><th class="num">Paid</th></tr></thead><tbody>${data.map(d => `<tr><td>${esc(monthName(d.m))}</td><td class="num">${esc(money(d.invoiced, cur))}</td><td class="num">${esc(money(d.paid, cur))}</td></tr>`).join('')}</tbody></table>`;
  if (dashTable) return;
  const W = 720, H = 240, L = 52, R = 8, T = 10, B = 26, pw = W - L - R, ph = H - T - B;
  // Round steps for the axis: 0, 10k, 20k… (never "38k").
  const raw = Math.max(...data.map(d => Math.max(d.invoiced, d.paid))), step = niceMax(raw / 4 || 1);
  const ticks = Math.max(1, Math.ceil(raw / step)), max = step * ticks;
  const y = v => T + ph - v / max * ph, slot = pw / data.length, bw = Math.min(18, (slot - 10) / 2);
  const bar = (x, v, cls) => {
    if (!v) return '';
    const top = y(v), h = T + ph - top, r = Math.min(4, h, bw / 2);
    return `<path class="${cls}" d="M${x},${T + ph} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${T + ph} Z"/>`;
  };
  const grid = Array.from({ length: ticks + 1 }, (_, k) => step * k).map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(shortMoney(v, cur))}</text>`).join('');
  const bars = data.map((d, i) => {
    const x0 = L + i * slot + (slot - bw * 2 - 2) / 2;
    return `<g>${bar(x0, d.invoiced, 'b-inv')}${bar(x0 + bw + 2, d.paid, 'b-paid')}
      <text class="axis" x="${L + i * slot + slot / 2}" y="${H - 8}" text-anchor="middle">${esc(monthName(d.m, true).replace(/ \d\d(\d\d)$/, i === 0 || d.m.endsWith('-01') ? " '$1" : ''))}</text>
      <rect class="hit" data-i="${i}" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}"/></g>`;
  }).join('');
  $('#dash-chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Invoiced and paid per month, last 12 months">${grid}<line class="base" x1="${L}" x2="${W - R}" y1="${T + ph}" y2="${T + ph}"/>${bars}</svg><div class="tip" id="dash-tip" hidden></div>`;
  const svg = $('#dash-chart svg'), tip = $('#dash-tip');
  svg.onmousemove = e => {
    const r = e.target.closest('rect.hit'); if (!r) { tip.hidden = true; return; }
    const d = data[r.dataset.i];
    tip.innerHTML = `<b>${esc(monthName(d.m))}</b><div><i class="sw inv"></i>Invoiced <span>${esc(money(d.invoiced, cur))}</span></div><div><i class="sw paid"></i>Paid <span>${esc(money(d.paid, cur))}</span></div>`;
    const box = $('#dash-chart').getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = Math.min(box.width - tip.offsetWidth - 4, Math.max(4, e.clientX - box.left + 12)) + 'px';
    tip.style.top = Math.max(0, e.clientY - box.top - 60) + 'px';
    $$('#dash-chart rect.hit').forEach(x => x.classList.toggle('on', x === r));
  };
  svg.onmouseleave = () => { tip.hidden = true; $$('#dash-chart rect.hit').forEach(x => x.classList.remove('on')); };
}
$('#dash-cur').onchange = e => { dashCur = e.target.value; renderDashboard(); };
$('#dash-split').addEventListener('click', e => { const b = e.target.closest('[data-dash-cur]'); if (b) { dashCur = b.dataset.dashCur; renderDashboard(); } });
$('#dash-chart-toggle').onclick = () => { dashTable = !dashTable; renderDashboard(); };
$('section[data-tab="dashboard"]').addEventListener('click', e => { const t = e.target.closest('[data-go-tab]'); if (t) go(t.dataset.goTab); });
$('section[data-tab="dashboard"]').addEventListener('keydown', e => { const t = e.target.closest('.tile[data-go-tab]'); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(t.dataset.goTab); } });
