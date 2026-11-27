// The Reports tab, and the exchange rates behind amounts in rand: each bank's rate on the day an
// invoice was marked paid (the Dashboard, History and My details use them too).
// Loaded after renderer.js, whose helpers ($, esc, money, persist, invoices, settings, payStatus, homeNote…) it uses.

// ---------- reports ----------
// Periods: tax years and calendar years that have invoices. The tax year starts on settings.taxYearStart
// ("MM-DD"): 1 March by default (South Africa); 6 April for UK self-assessment, 1 July for Australia,
// or your company's own year end. Starting on 1 January, tax years are just calendar years.
const TAX_YEAR_STARTS = [['03-01', '1 March (South Africa)'], ['04-06', '6 April (UK personal tax)'], ['04-01', '1 April (UK companies, India, Japan)'], ['07-01', '1 July (Australia, Egypt)'], ['10-01', '1 October (US federal)'], ['01-01', '1 January (calendar year)']];
const taxYearStart = () => /^(0[1-9]|1[0-2])-(0[1-9]|1\d|2[0-8])$/.test(settings.taxYearStart || '') ? settings.taxYearStart : '03-01';
// The tax year a date falls in, by the year it starts in.
const taxYearOf = date => { const y = Number(date.slice(0, 4)); return date.slice(5) >= taxYearStart() ? y : y - 1; };
function taxYear(y) {
  const start = taxYearStart(), from = `${y}-${start}`;
  const end = parseDate(`${y + 1}-${start}`); end.setDate(end.getDate() - 1);
  const to = iso(end), short = s => `${Number(s.slice(8))} ${MONTHS[Number(s.slice(5, 7)) - 1].slice(0, 3)} ${s.slice(0, 4)}`;
  return { id: `tax-${y}`, label: `Tax year ${y}/${String(y + 1).slice(2)} (${short(from)} – ${short(to)})`, from, to };
}
function reportPeriods() {
  const dated = invoices.filter(h => docType(h) !== 'quote').map(h => h.inv.date).filter(Boolean);
  const today = todayIso(), calendar = taxYearStart() === '01-01';
  const cal = new Set([...dated.map(d => Number(d.slice(0, 4))), Number(today.slice(0, 4))]);
  const tax = new Set([...dated.map(taxYearOf), taxYearOf(today)]);
  const list = [];
  for (const y of [...new Set([...cal, ...tax])].sort((a, b) => b - a)) {
    if (tax.has(y) && !calendar) list.push(taxYear(y));
    if (cal.has(y)) list.push({ id: `cal-${y}`, label: `Calendar year ${y}`, from: `${y}-01-01`, to: `${y}-12-31` });
  }
  return { list, current: calendar ? `cal-${taxYearOf(today)}` : `tax-${taxYearOf(today)}` };
}
// Invoices and credit notes dated in the period. A credit note counts negative (amount and VAT), in the
// period of its own date, as on a VAT return. paid: everything paid on the invoice so far; owed: what's still owed.
function reportRows(p) {
  return invoices.filter(h => docType(h) !== 'quote' && h.inv.date >= p.from && h.inv.date <= p.to).map(h => {
    const kind = docType(h), sign = kind === 'credit' ? -1 : 1;
    const subtotal = h.subtotal ?? round2((h.lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0));
    const tax = h.tax ?? round2((h.total || 0) - subtotal);
    return { h, kind, cur: curCode(h.c.currency), subtotal: sign * subtotal, tax: sign * tax, total: sign * (Number(h.total) || 0),
      paid: kind === 'invoice' ? paidOn(h) : 0, owed: owedOn(h), status: payStatus(h) };
  });
}
// ---------- rand values: exchange rates on the day each payment was made ----------
// With "Also show what's been paid in rand" on (settings.reportCurrency = 'ZAR'), what's been paid on an
// invoice in another currency gets a rand value: each payment at the chosen bank's buying rate on the day
// it was made (settings.fxBank: standard, absa or nedbank; both settings stay on this computer; see fx.js).
// The rand can move between part payments, so each payment keeps its own rates (from 1.31.1), one per
// bank, so the report doesn't change afterwards and you can switch banks:
//   h.payments[i].fx.ZAR = { standard: { rate, on, kind, source }, absa: …, nedbank: …, manual: … }
// An invoice marked paid before part payments existed (only h.paidAt, no h.payments) keeps its rates on
// the invoice, each with the paid date it's for ('for'):
//   h.fx.ZAR = { standard: { rate, on, kind, source, for }, absa: …, nedbank: …, manual: … }
// 'manual' is a rate you typed in yourself, and wins. A rate on the invoice that isn't for its paid date
// (1.23.0's invoice-date rates, or a payment that was undone) is ignored.
// Recording a payment records every bank's rate that day. Absa and Nedbank only publish today's rates,
// so for an earlier date with none recorded, Standard Bank's is used and the report says so.
const reportCur = () => settings.reportCurrency || '';
const FX_BANKS = { standard: 'Standard Bank', absa: 'Absa', nedbank: 'Nedbank' };
const fxBank = () => FX_BANKS[settings.fxBank] ? settings.fxBank : 'standard';
const fxMemo = {}; // rates for invoices this computer mayn't change (an accountant's view), kept in memory
const fxTried = new Set(); // "invoice|bank" lookups that failed this session (not tried again)
let fxBusy = false, fxError = '';
// Whether this computer may store the rate on the invoice (the team's roles decide who changes invoices).
const canStoreFx = h => !teamState.team || !!h.private || can('editBilling') || (can('createInvoices') && !h.savedBy);
// The invoice's rates for one currency, by bank: only those for its paid date.
function fxRates(h, to) {
  const v = (h.fx && h.fx[to]) || {};
  const all = { ...(v.rate ? {} : v), ...(fxMemo[`${h.inv.number}|${to}`] || {}) }; // (1.23.0's single rate was for the invoice date)
  return Object.fromEntries(Object.entries(all).filter(([, r]) => r && r.for && r.for === h.paidAt));
}
// The rate the report uses: yours, else the chosen bank's, else (for a bank without history) Standard Bank's.
// key names the invoice ("INV-4") or one of its payments ("INV-4#1") in fxTried.
function pickRate(all, key) {
  const bank = fxBank();
  if (all.manual) return { ...all.manual, kind: 'manual' };
  if (all[bank]) return { ...all[bank], bank };
  if (bank !== 'standard' && all.standard && fxTried.has(`${key}|${bank}`)) return { ...all.standard, bank: 'standard', instead: bank };
  return null;
}
// The invoice's own rate (for one paid in full before part payments existed).
function fxOf(h, to) {
  if (curCode(h.c.currency) === to) return { rate: 1, kind: 'same' };
  return pickRate(fxRates(h, to), h.inv.number);
}
function setFx(h, to, bank, v) { // bank: a bank's id, or 'manual'; v null removes it
  const all = fxRates(h, to);
  if (v) all[bank] = { ...v, for: h.paidAt }; else delete all[bank];
  if (!canStoreFx(h)) { fxMemo[`${h.inv.number}|${to}`] = all; return false; }
  h.fx = { ...(h.fx || {}) };
  if (Object.keys(all).length) h.fx[to] = all; else delete h.fx[to];
  if (!Object.keys(h.fx).length) delete h.fx;
  return true;
}
// ---------- each payment's rate ----------
// The payments on an invoice, each with i: its index in h.payments, or null for an invoice paid in full
// before part payments existed (whose rates are on the invoice itself).
const paidWith = h => docType(h) !== 'invoice' ? [] : paymentsOf(h).map((p, k) => ({ p, i: p.implied ? null : k }));
const payKey = (h, i) => i == null ? h.inv.number : `${h.inv.number}#${i}`;
function payFxRates(h, i, to) {
  if (i == null) return fxRates(h, to);
  const p = (h.payments && h.payments[i]) || {};
  return { ...((p.fx && p.fx[to]) || {}), ...(fxMemo[`${payKey(h, i)}|${to}`] || {}) };
}
function payFxOf(h, i, to) {
  if (curCode(h.c.currency) === to) return { rate: 1, kind: 'same' };
  return i == null ? fxOf(h, to) : pickRate(payFxRates(h, i, to), payKey(h, i));
}
function setPayFx(h, i, to, bank, v) { // like setFx, for payment i (null: the invoice's own rates)
  if (i == null) return setFx(h, to, bank, v);
  const all = payFxRates(h, i, to);
  if (v) all[bank] = { ...v }; else delete all[bank];
  if (!canStoreFx(h)) { fxMemo[`${payKey(h, i)}|${to}`] = all; return false; }
  h.payments = h.payments.map((p, k) => {
    if (k !== i) return p;
    const fx = { ...(p.fx || {}) };
    if (Object.keys(all).length) fx[to] = all; else delete fx[to];
    const { fx: _old, ...rest } = p;
    return Object.keys(fx).length ? { ...rest, fx } : rest;
  });
  return true;
}
// What's been paid on an invoice, in `to`: each payment at its own rate. null until every rate is known.
function paidIn(h, to) {
  let v = 0;
  for (const { p, i } of paidWith(h)) {
    const f = payFxOf(h, i, to);
    if (!f || !(Number(f.rate) > 0)) return null;
    v += num(p.amount) * Number(f.rate);
  }
  return round2(v);
}
// The average rate over what's been paid (rand per unit), or null.
const paidRate = (h, to) => { const paid = paidOn(h), v = paid > 0 ? paidIn(h, to) : null; return v == null ? null : v / paid; };

const dayLabel = d => `${shortDate(d)} ${d.slice(0, 4)}`;
const fxLabel = f => !f ? '' : f.kind === 'manual' ? 'Your rate'
  : `${FX_BANKS[f.bank] || 'Standard Bank'}, ${dayLabel(f.on)}${f.kind === 'current' || f.kind === 'opening' ? ' (rate when paid)' : f.kind === 'closing' ? ' closing' : ''}`
    + (f.instead ? ` (${FX_BANKS[f.instead]} had no rate for this date)` : '');
// The payments still without a rate, on invoices in other currencies: [{ h, p, i, cur }].
const missingRates = (rows, to) => rows.filter(r => r.kind === 'invoice' && r.cur !== to)
  .flatMap(r => paidWith(r.h).filter(({ i }) => !payFxOf(r.h, i, to)).map(x => ({ ...x, h: r.h, cur: r.cur })));
// Looks up the missing rates one payment at a time, then shows the report again.
async function fillRates(rows, to) {
  const bank = fxBank();
  const missing = missingRates(rows, to).filter(({ h, i }) => !fxTried.has(`${payKey(h, i)}|${bank}|failed`));
  if (fxBusy || !missing.length || !store.fxRate) return;
  fxBusy = true; fxError = ''; renderReports();
  let stored = false;
  for (const { h, p, i, cur } of missing) {
    const key = payKey(h, i);
    let res = fxTried.has(`${key}|${bank}`) ? null : await store.fxRate(bank, cur, p.on);
    if (res && res.noHistory) { fxTried.add(`${key}|${bank}`); res = null; }
    if (!res) res = payFxRates(h, i, to).standard ? null : await store.fxRate('standard', cur, p.on); // fall back to Standard Bank's history
    if (res && res.error) { fxTried.add(`${key}|${bank}|failed`); fxError = res.error; continue; }
    if (res) stored = setPayFx(h, i, to, res.bank || 'standard', { rate: res.rate, on: res.on, kind: res.kind, source: res.source }) || stored;
  }
  fxBusy = false;
  if (stored) persist('invoices');
  if (tabShown('reports')) renderReports();
}
// When a payment is made on an invoice in another currency, every bank's rate that day is recorded there
// and then, for each payment that doesn't have them yet.
async function captureFx(h) {
  const to = reportCur() || (homeCur() === 'ZAR' ? 'ZAR' : '');
  if (!to || !store.fxRates || docType(h) !== 'invoice' || curCode(h.c.currency) === to) return;
  let stored = false;
  for (const { p, i } of paidWith(h)) {
    if (Object.keys(payFxRates(h, i, to)).length) continue;
    const res = await store.fxRates(curCode(h.c.currency), p.on);
    // Reports tries again later; and a payment removed meanwhile needs none.
    const still = i == null ? h.paidAt === p.on && !Array.isArray(h.payments)
      : !!(h.payments && h.payments[i] && h.payments[i].on === p.on && h.payments[i].amount === p.amount);
    if (!res || res.error || !still) continue;
    for (const [bank, v] of Object.entries(res)) {
      if (v && !v.error && !payFxRates(h, i, to)[bank]) stored = setPayFx(h, i, to, bank, { rate: v.rate, on: v.on, kind: v.kind, source: v.source }) || stored;
    }
  }
  if (stored) persist('invoices');
}
$('#rep-zar').onchange = e => {
  settings.reportCurrency = e.target.checked ? 'ZAR' : ''; persist('settings');
  fxTried.clear(); renderReports();
};
$('#rep-bank').onchange = e => { settings.fxBank = e.target.value; persist('settings'); fxError = ''; renderReports(); };

// A report row's value in `to` (rand): each payment with its rate (pays), what's been paid at those rates
// (home: { subtotal, tax, total }, the paid share of the invoice's subtotal and tax; null until every
// payment has a rate), and the rate behind it (fx: the payment's, or for several their average).
function randOf(r, to) {
  if (!to || r.kind !== 'invoice' || !(r.paid > 0)) return { pays: [], home: null, fx: null };
  const pays = paidWith(r.h).map(x => ({ ...x, f: payFxOf(r.h, x.i, to) }));
  const total = paidIn(r.h, to);
  if (total == null) return { pays, home: null, fx: pays.length === 1 ? pays[0].f : null };
  const share = r.total ? r.paid / r.total : 0, avg = total / r.paid;
  return { pays, home: { subtotal: round2(r.subtotal * share * avg), tax: round2(r.tax * share * avg), total },
    fx: pays.length === 1 ? pays[0].f : { rate: round2(avg * 10000) / 10000, kind: 'average', count: pays.length } };
}
// The CSV's rate columns for a row: the rate (several payments: their average), its date, where it came
// from, and what's been paid in rand, excluding tax, the tax, and in all.
function randCells(r, to) {
  if (!to) return [];
  if (r.kind !== 'invoice') return ['', '', '', '', '', ''];
  if (!(r.paid > 0)) return ['', '', 'Not paid yet', '', '', ''];
  const x = randOf(r, to);
  if (!x.home) return ['', '', 'No rate yet', '', '', ''];
  const f = x.fx, one = x.pays.length === 1 ? x.pays[0] : null;
  return [f.rate, one ? (f.on || one.p.on) : '', f.kind === 'same' ? '' : f.kind === 'average' ? `${f.count} payments, each at its own rate` : fxLabel(f),
    x.home.subtotal.toFixed(2), x.home.tax.toFixed(2), x.home.total.toFixed(2)];
}

function renderReports() {
  renderTaxYearStart();
  const { list, current } = reportPeriods();
  const sel = $('#rep-period');
  const keep = sel.value;
  sel.innerHTML = list.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  sel.value = list.some(p => p.id === keep) ? keep : current;
  const p = list.find(x => x.id === sel.value);
  const rows = reportRows(p);
  const nInv = rows.filter(r => r.kind === 'invoice').length, nCn = rows.length - nInv;
  $('#rep-range').textContent = `${shortDate(p.from)} ${p.from.slice(0, 4)} to ${shortDate(p.to)} ${p.to.slice(0, 4)} · ${nInv} invoice${nInv === 1 ? '' : 's'}${nCn ? `, ${nCn} credit note${nCn === 1 ? '' : 's'}` : ''}`;
  const to = reportCur(), bankName = FX_BANKS[fxBank()];
  $('#rep-zar').checked = !!to;
  $('#rep-bank-row').hidden = !to; $('#rep-bank').value = fxBank();
  // Rand values: what's been paid, each payment at the rate on its own day (null until the rates are known).
  const isPaid = x => x.status.key === 'paid', hasPaid = x => x.kind === 'invoice' && x.paid > 0, isOwed = x => x.owed > 0, isInv = x => x.kind === 'invoice';
  const foreign = to ? rows.filter(r => r.cur !== to && isInv(r)) : [];
  for (const r of rows) Object.assign(r, randOf(r, to));
  const waiting = to ? missingRates(rows, to).length : 0;
  const fxNote = $('#rep-fx');
  fxNote.hidden = !to || (!waiting && !fxBusy);
  fxNote.className = 'drive-status' + (fxError && waiting ? ' err' : '');
  fxNote.textContent = !store.fxRate ? 'Exchange rates are only available in the desktop app.'
    : fxBusy ? `Getting ${bankName}'s rates for ${waiting} payment${waiting === 1 ? '' : 's'}…`
    : fxError ? `Couldn't get a rate for ${waiting} payment${waiting === 1 ? '' : 's'} (${fxError}). Type the rate in yourself below, or switch rand off and on again to retry.`
    : '';
  if (to && waiting && !fxBusy) fillRates(rows, to);
  if (!rows.length) { $('#rep-body').innerHTML = '<p class="muted">No invoices in this period.</p>'; return; }
  const sum = (arr, f) => round2(arr.reduce((s, r) => s + f(r), 0));
  const byCur = [...new Set(rows.map(r => r.cur))];
  const table = (head, body) => `<table class="report"><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  const tr = cells => `<tr>${cells.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`;
  const label = settings.taxLabel || 'VAT';
  // With rand on, an amount paid in another currency shows the rate behind it in brackets: €1000.00 (21.94).
  // For several payments it's their average (rand ÷ the foreign amount paid), so it matches the rand
  // total. Each payment has the rate of the day it was made.
  const showHome = to && foreign.length;
  const rateNote = arr => {
    if (!showHome) return '';
    const p = arr.filter(hasPaid);
    if (!p.length || p.some(r => r.cur === to || !r.home)) return '';
    const amount = sum(p, r => r.paid), rand = sum(p, r => r.home.total);
    if (!amount) return '';
    const n = p.reduce((t, r) => t + r.pays.length, 0);
    const why = n === 1 ? `${p[0].h.inv.number}: ${fxLabel(p[0].fx)}` : `Average rand per ${p[0].cur} over ${n} payments, each at its own day's rate`;
    return ` <span class="fx-note" title="${esc(why)}">(${(rand / amount).toFixed(2)})</span>`;
  };
  // The headline figures, per currency.
  const tile = (l, v, sub) => `<div class="tile"><div class="tile-label">${l}</div><div class="tile-value">${v}</div><div class="tile-sub">${sub}</div></div>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let html = byCur.map(cur => {
    const r = rows.filter(x => x.cur === cur), inv = r.filter(isInv), cn = r.length - inv.length, paid = r.filter(isPaid), owed = r.filter(isOwed);
    const part = inv.filter(x => x.paid > 0 && !isPaid(x)).length;
    return `${byCur.length > 1 ? `<h3>${cur}</h3>` : ''}<div class="tiles rep-tiles">${[
      tile('Invoiced', money(sum(r, x => x.total), cur), plural(inv.length, 'invoice') + (cn ? `, less ${plural(cn, 'credit note')}` : '')),
      tile('Paid', money(sum(inv, x => x.paid), cur) + rateNote(inv), `${paid.length} of ${inv.length} paid in full${part ? `, ${part} in part` : ''}`),
      tile('Outstanding', money(sum(owed, x => x.owed), cur) + homeNote(sum(owed, x => x.owed), cur), owed.length ? plural(owed.length, 'unpaid invoice') : 'Nothing owed'),
      tile(esc(label), money(sum(r, x => x.tax), cur), `on ${money(sum(r, x => x.subtotal), cur)} excl. ${esc(label)}`),
    ].join('')}</div>`;
  }).join('');
  // What's been paid, all in rand, each payment at its own day's rate.
  const home = (arr, f) => { arr = arr.filter(hasPaid); return arr.some(r => !r.home) ? null : round2(arr.reduce((s, r) => s + f(r.home), 0)); };
  const homeMoney = v => v == null ? '<span class="muted" title="Waiting for an exchange rate">…</span>' : money(v, to);
  if (showHome) {
    const paid = rows.filter(hasPaid);
    html += `<div class="card"><h3>Paid, in rand (${to})</h3>` + table(['', 'Invoices', 'Excl. ' + label, label, 'Total'],
      tr(['All currencies', paid.length, homeMoney(home(paid, h => h.subtotal)), homeMoney(home(paid, h => h.tax)), `<b>${homeMoney(home(paid, h => h.total))}</b>`]))
      + `<p class="muted">What's been paid in other currencies, part payments included, in rand: each payment at ${esc(bankName)}'s buying rate on the day it was paid.</p></div>`;
  }
  const clientsIn = [...new Set(rows.map(r => `${r.h.c.company}\u0000${r.cur}`))];
  html += '<div class="rep-grid"><div class="card"><h3>By client</h3>' + table(['Client', 'Invoices', 'Total', 'Paid', 'Outstanding', ...(showHome ? [`Paid in ${to}`] : [])], clientsIn.map(k => {
    const [name, cur] = k.split('\u0000'); const r = rows.filter(x => x.h.c.company === name && x.cur === cur);
    return tr([esc(name), r.filter(isInv).length, money(sum(r, x => x.total), cur), money(sum(r, x => x.paid), cur) + rateNote(r),
      money(sum(r, x => x.owed), cur) + homeNote(sum(r, x => x.owed), cur), ...(showHome ? [homeMoney(home(r, h => h.total))] : [])]);
  }).join('')) + '</div>';
  const months = [...new Set(rows.map(r => r.h.inv.date.slice(0, 7)))].sort();
  html += '<div class="card"><h3>By month</h3>' + table(['Month', ...byCur, ...(showHome ? [`Paid in ${to}`] : [])], months.map(m => {
    const d = parseDate(m + '-01'), inM = rows.filter(x => x.h.inv.date.startsWith(m));
    return tr([`${MONTHS[d.getMonth()]} ${d.getFullYear()}`, ...byCur.map(cur => money(sum(inM.filter(x => x.cur === cur), x => x.total), cur) + rateNote(inM.filter(x => x.cur === cur))),
      ...(showHome ? [homeMoney(home(inM, h => h.total))] : [])]);
  }).join('')) + '</div></div>';
  // The rate behind each payment in another currency (one row each); type a rate in to use your own.
  if (showHome) {
    const editable = r => canStoreFx(r.h) || !teamState.team;
    const payRows = foreign.flatMap(r => r.pays.length ? r.pays.map((x, k) => ({ r, ...x, k })) : [{ r, unpaid: true }])
      .sort((a, b) => (a.p ? a.p.on : '9999').localeCompare(b.p ? b.p.on : '9999') || a.r.h.inv.date.localeCompare(b.r.h.inv.date));
    const at = x => x.i == null ? '' : String(x.i);
    html += `<div class="card"><h3>Exchange rates</h3><p class="muted">Rand per unit of each invoice's currency: ${esc(bankName)}'s buying rate (what the bank pays you) on the day each payment was made, unless you type in your own. A part payment has its own rate, as the rand moves between payments. Unpaid invoices get one with each payment.</p>`
      + `<table class="report fx"><thead><tr><th>Invoice</th><th>Paid</th><th>Client</th><th class="num">Amount</th><th class="num">Rate</th><th>From</th><th class="num">In ${to}</th></tr></thead><tbody>`
      + payRows.map(x => {
        const { r } = x;
        if (x.unpaid) return `<tr class="unpaid"><td>${esc(r.h.inv.number)}</td><td class="muted">–</td><td>${esc(r.h.c.company)}</td>
          <td class="num">${money(r.total, r.cur)}</td><td class="num muted">–</td><td class="muted" colspan="2">Not paid yet: each payment gets its rate when it's made</td></tr>`;
        const f = x.f, many = r.pays.length > 1;
        return `<tr><td>${esc(r.h.inv.number)}${many ? ` <span class="muted">(${x.k + 1} of ${r.pays.length})</span>` : ''}</td><td>${esc(x.p.on)}</td><td>${esc(r.h.c.company)}</td>
        <td class="num">${money(x.p.amount, r.cur)}</td>
        <td class="num"><input class="fx-rate" type="number" step="0.0001" min="0" data-fx="${esc(r.h.inv.number)}" data-pay="${at(x)}" value="${f && Number(f.rate) > 0 ? Number(f.rate) : ''}" placeholder="${fxBusy ? '…' : 'Rate'}" ${editable(r) ? '' : 'readonly title="Only an admin, or whoever saved it, can change the rate on a shared invoice"'}></td>
        <td class="muted">${esc(fxLabel(f))}${f && f.kind === 'manual' && editable(r) ? ` <button class="link" data-fx-reset="${esc(r.h.inv.number)}" data-pay="${at(x)}" title="Use ${esc(bankName)}'s rate for this date again">Use ${esc(bankName)}'s</button>` : ''}</td>
        <td class="num">${homeMoney(f && Number(f.rate) > 0 ? round2(num(x.p.amount) * f.rate) : null)}</td></tr>`;
      }).join('')
      + '</tbody></table></div>';
  }
  $('#rep-body').innerHTML = html;
}
// Typing a rate in: it's yours from then on (the report uses it, and it's saved with the payment).
// data-pay is the payment's index, or empty for an invoice paid in full before part payments existed.
const payIndex = d => d.pay === '' || d.pay == null ? null : Number(d.pay);
$('#rep-body').addEventListener('change', e => {
  const n = e.target.dataset.fx; if (!n) return;
  const h = invoices.find(x => x.inv.number === n), to = reportCur(); if (!h || !to) return;
  const i = payIndex(e.target.dataset), p = i == null ? { on: h.paidAt } : h.payments[i];
  const v = parseFloat(e.target.value);
  setPayFx(h, i, to, 'manual', v > 0 ? { rate: v, on: p.on, kind: 'manual', source: 'Your rate' } : null);
  persist('invoices'); renderReports();
});
$('#rep-body').addEventListener('click', e => {
  const n = e.target.dataset.fxReset; if (!n) return;
  const h = invoices.find(x => x.inv.number === n), to = reportCur(); if (!h || !to) return;
  setPayFx(h, payIndex(e.target.dataset), to, 'manual', null); persist('invoices'); renderReports();
});
$('#rep-period').onchange = renderReports;
// The named starts first, then the 1st of every other month (a company's year end is usually a month end).
const taxYearOptions = () => [...TAX_YEAR_STARTS, ...MONTHS.map((m, i) => [`${pad(i + 1)}-01`, `1 ${m}`]).filter(([v]) => !TAX_YEAR_STARTS.some(([s]) => s === v))];
function renderTaxYearStart() {
  const sel = $('#rep-ty-start');
  if (!sel.options.length) sel.innerHTML = taxYearOptions().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  sel.value = taxYearStart();
  sel.disabled = !can('editBusiness'); // shared with your team, like the rest of the business details
}
$('#rep-ty-start').onchange = e => {
  const was = $('#rep-period').value.startsWith('tax-');
  settings.taxYearStart = e.target.value; persist('settings');
  if (was) $('#rep-period').value = ''; // show the current tax year under the new dates
  renderReports();
};
$('#rep-csv').onclick = () => {
  const { list } = reportPeriods(); const p = list.find(x => x.id === $('#rep-period').value) || list[0];
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  // With rand on, rows that have been paid (in part or in full) also have their rate, where it came
  // from, and what's been paid in rand (see randCells).
  const to = reportCur();
  const fxCols = to ? [`Rate to ${to}`, 'Rate date', 'Rate from', `Paid excl. tax (${to})`, `Paid tax (${to})`, `Paid (${to})`] : [];
  const fxCells = r => randCells(r, to);
  // Credit notes are rows of their own, negative, with the invoice they're for.
  const lines = [['Type', 'Number', 'Date', 'Due', 'Client', 'Currency', 'Excl. tax', 'Tax', 'Total', 'Paid so far', 'Still owed', 'Status', 'Paid on', 'Credit for', 'Reason', ...fxCols].join(',')]
    .concat(reportRows(p).map(r => [r.kind === 'credit' ? 'Credit note' : 'Invoice', r.h.inv.number, r.h.inv.date, r.h.inv.due || '', r.h.c.company, r.cur, r.subtotal.toFixed(2), r.tax.toFixed(2), r.total.toFixed(2),
      r.kind === 'credit' ? '' : r.paid.toFixed(2), r.kind === 'credit' ? '' : r.owed.toFixed(2), r.status.key === 'untracked' || r.kind === 'credit' ? '' : r.status.key, r.h.paidAt || '', r.h.inv.creditFor || '', r.h.inv.reason || '', ...fxCells(r)].map(q).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
  a.download = `Invaro report - ${p.label.replace(/[\\/:*?"<>|()]/g, '').replace(/\s+/g, ' ').trim()}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};
