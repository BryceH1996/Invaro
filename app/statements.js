// Client statements (from 1.31.0): everything a client has been invoiced, credited and has paid, with a
// running balance, what they owe now and how overdue it is (pdf.js draws it). On the Clients tab, and
// suggested on the overdue bars and the "time to invoice" reminders when a client owes you.
// Loaded after renderer.js and history.js, whose helpers (paymentsOf, creditsFor, owedOn…) it uses.

// statementView: { clientId, from, to } while the Clients preview shows a statement instead of an example invoice.
let statementView = null;
const statementShown = id => !!statementView && statementView.clientId === id;
const daysLate = (due, on) => Math.round((parseDate(on) - parseDate(due)) / 864e5);

// What goes on a client's statement, per currency, from `from` (everything earlier is the balance
// brought forward; '' for no brought-forward line) to `to`. Quotes aren't on it, nor invoices saved before
// paid tracking began (1.12.0) that were never marked paid or unpaid: nobody knows if they're owed.
function statementData(clientId, { from = '', to = todayIso() } = {}) {
  const mine = invoices.filter(h => h.c && h.c.id === clientId);
  const events = [];
  for (const h of mine) {
    const type = docType(h), cur = curCode(h.c.currency);
    if (type === 'invoice' && (h.tracked || h.paidAt)) {
      events.push({ cur, date: h.inv.date, order: 0, ref: h.inv.number, desc: `Invoice${h.inv.due ? `, due ${shortDate(h.inv.due)} ${h.inv.due.slice(0, 4)}` : ''}`, debit: num(h.total) });
      for (const p of paymentsOf(h))
        events.push({ cur, date: p.on, order: 2, ref: h.inv.number, desc: `Payment received${p.note ? ` (${p.note})` : ''}, thank you`, credit: num(p.amount) });
    } else if (type === 'credit') {
      events.push({ cur, date: h.inv.date, order: 1, ref: h.inv.number, desc: `Credit note for ${h.inv.creditFor || 'an invoice'}${h.inv.reason ? `: ${h.inv.reason}` : ''}`, credit: num(h.total) });
    }
  }
  const curs = [...new Set(events.map(e => e.cur))];
  return curs.map(cur => {
    const all = events.filter(e => e.cur === cur && e.date && e.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order || a.ref.localeCompare(b.ref));
    const net = e => num(e.debit) - num(e.credit);
    const opening = round2(all.filter(e => from && e.date < from).reduce((s, e) => s + net(e), 0));
    let bal = opening;
    const rows = all.filter(e => !from || e.date >= from).map(e => ({ ...e, balance: (bal = round2(bal + net(e))) }));
    // What's owed now, by how long ago it was due.
    const aging = { current: 0, d30: 0, d60: 0, d90: 0, older: 0 };
    for (const h of mine.filter(x => docType(x) === 'invoice' && curCode(x.c.currency) === cur && x.inv.date <= to)) {
      const owed = owedOn(h); if (!owed) continue;
      const late = h.inv.due ? daysLate(h.inv.due, to) : 0;
      const k = late <= 0 ? 'current' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'older';
      aging[k] = round2(aging[k] + owed);
    }
    return { cur, opening, rows, closing: bal, aging };
  });
}
// From the start of the month two months back (three months in all), or earlier if something older is still owed.
function statementFrom(clientId, to = todayIso()) {
  const d = parseDate(to), start = iso(new Date(d.getFullYear(), d.getMonth() - 2, 1));
  const oldest = invoices.filter(h => h.c && h.c.id === clientId && owedOn(h) > 0).map(h => h.inv.date).sort()[0];
  return oldest && oldest < start ? oldest.slice(0, 8) + '01' : start;
}
const statementOptions = c => {
  const v = statementView && statementView.clientId === c.id ? statementView : { from: statementFrom(c.id), to: todayIso() };
  return { me: settings.me || {}, c, groups: statementData(c.id, v), from: v.from, to: v.to, pageSize: settings.pageSize,
    design: settings.design, logo, bank: settings.bank, bankLogo };
};
// What a client owes now, per currency: "£1,200.00 (£500.00 overdue)".
function owesText(clientId) {
  const today = todayIso();
  const parts = statementData(clientId, { to: today }).filter(g => Math.abs(g.closing) > 0.004).map(g => {
    const late = round2(g.aging.d30 + g.aging.d60 + g.aging.d90 + g.aging.older);
    return g.closing < 0 ? `${money(-g.closing, g.cur)} in credit` : `${money(g.closing, g.cur)}${late ? ` (${money(late, g.cur)} overdue)` : ''}`;
  });
  return parts.join(' and ');
}
const clientOwes = clientId => invoices.some(h => h.c && h.c.id === clientId && owedOn(h) > 0);

// The Statement box on the Clients tab.
function renderStatementBox(c) {
  if (!c) return;
  const v = statementShown(c.id) ? statementView : { from: statementFrom(c.id), to: todayIso() };
  setVal($('#st-from'), v.from); setVal($('#st-to'), v.to);
  const owes = owesText(c.id);
  $('#cl-owes').textContent = owes ? `${c.company || 'This client'} owes ${owes}.` : `${c.company || 'This client'} doesn't owe you anything right now.`;
  $('#st-show').textContent = statementShown(c.id) ? 'Show the example invoice' : 'Show statement';
}
// Shows a client's statement on the Clients tab (from the overdue bars and reminders).
function openStatement(clientId) {
  const c = client(clientId); if (!c) return;
  editingClient = c.id;
  statementView = { clientId: c.id, from: statementFrom(c.id), to: todayIso() };
  go('clients');
  $('#cl-statement').scrollIntoView({ block: 'center', behavior: 'smooth' });
}
const statementDates = () => {
  const from = $('#st-from').value, to = $('#st-to').value || todayIso();
  return { from: from && from <= to ? from : '', to };
};
$('#st-show').onclick = () => {
  const c = client(editingClient); if (!c) return;
  statementView = statementShown(c.id) ? null : { clientId: c.id, ...statementDates() };
  renderStatementBox(c); refreshPreview(0);
};
for (const id of ['#st-from', '#st-to']) $(id).onchange = () => {
  const c = client(editingClient); if (!c) return;
  statementView = { clientId: c.id, ...statementDates() };
  renderStatementBox(c); refreshPreview(0);
};
$('#st-save').onclick = async () => {
  const c = client(editingClient); if (!c) return;
  statementView = { clientId: c.id, ...statementDates() };
  const opts = statementOptions(c);
  const bytes = buildStatement(opts).output('arraybuffer');
  const name = `${c.company || 'Client'} Statement - ${pdfDate(opts.to)} - ${(settings.me || {}).name || 'Me'}.pdf`.replace(/[\\/:*?"<>|]/g, '');
  const res = await store.saveInvoice(bytes, c.company, name, name.replace(/\.pdf$/i, ` - ${uid()}.pdf`), '');
  if (!res || res.error) return toast('Could not save the statement: ' + ((res && res.error) || 'unknown error'));
  renderStatementBox(c); refreshPreview(0);
  if (window.api) toast(`Statement saved to ${res.path.split(/[\\/]/).slice(-2).join(IS_MAC ? '/' : '\\')}`, 'Open', () => store.open(res.path));
};
