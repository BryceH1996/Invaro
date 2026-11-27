// Part payments and credit notes: what's still owed on an invoice, and how History, the Dashboard and
// Reports count them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness');

const client = { id: 'c1', company: 'Northwind', currency: 'GBP', dueDays: 14, hourlyRate: 40, dailyRate: 300, dayOffRate: '', taxRate: 15, items: [] };
// A saved invoice for Northwind: invoice(n, { inv: { … } }) changes the invoice itself, anything else the entry.
const invoice = (number, { inv: fields = {}, ...rest } = {}) => ({
  id: number, savedAt: '2026-11-01T10:00:00Z', inv: { number, clientId: 'c1', date: '2026-11-01', due: '2026-12-01', period: '2026-11', items: [{ kind: 'days', qty: 3, desc: 'Design' }], ...fields },
  c: { ...client }, me: {}, lines: [{ desc: 'Design', amount: 900 }], subtotal: 900, tax: 135, total: 1035, tracked: true, paidAt: null, ...rest,
});
const credit = (number, creditFor, total, { inv: fields = {}, ...rest } = {}) => invoice(number, { inv: { type: 'credit', creditFor, reason: 'Cancelled', due: '', items: [], ...fields },
  total, subtotal: round(total / 1.15), tax: round(total - total / 1.15), tracked: undefined, ...rest });
const round = n => Math.round(n * 100) / 100;
function app(invoices, today = '2026-11-27') {
  const a = loadApp({ today });
  a.set({ clients: [client], invoices, settings: { prefix: 'INV-', nextNumber: 1 }, stock: [], stockMoves: [] });
  a.set({ draft: a.newDraft('c1') });
  return a;
}

test('a part payment leaves the rest owed, and the last one marks it paid', () => {
  const a = app([invoice('INV-1')]);
  assert.equal(a.addPayment('INV-1', 400, '2026-11-10', 'EFT 123'), true);
  const h = a.invoices[0];
  assert.equal(a.balanceOf(h), 635);
  assert.equal(a.owedOn(h), 635);
  assert.deepEqual(plain(a.payStatus(h)), { key: 'part', label: '£635.00 left' });
  assert.equal(a.isOwedStatus(h), true);
  a.addPayment('INV-1', 635, '2026-11-20');
  assert.equal(h.paidAt, '2026-11-20', 'paid in full on the last payment\'s date');
  assert.equal(a.payStatus(h).key, 'paid');
  assert.equal(a.owedOn(h), 0);
});

test('a part-paid invoice past its due date is overdue, with what\'s left', () => {
  const a = app([invoice('INV-1', { inv: { due: '2026-11-15' } })]);
  a.addPayment('INV-1', 35, '2026-11-10');
  assert.deepEqual(plain(a.payStatus(a.invoices[0])), { key: 'overdue', label: 'Overdue · £1000.00 left' });
});

test('a payment that isn\'t a positive amount on a real date is refused', () => {
  const a = app([invoice('INV-1')]);
  assert.equal(a.addPayment('INV-1', 0, '2026-11-10'), false);
  assert.equal(a.addPayment('INV-1', 50, ''), false);
  assert.equal(a.invoices[0].payments, undefined);
});

test('paying more than is owed asks first, then leaves the client in credit', () => {
  const a = app([invoice('INV-1')]);
  let asked = '';
  a.context.confirm = msg => { asked = msg; return false; };
  assert.equal(a.addPayment('INV-1', 2000, '2026-11-10'), false);
  assert.match(asked, /more than the £1035.00 still owed/);
  a.context.confirm = () => true;
  a.addPayment('INV-1', 2000, '2026-11-10');
  assert.equal(a.balanceOf(a.invoices[0]), -965);
  assert.equal(a.owedOn(a.invoices[0]), 0);
});

test('Mark paid records the rest as a payment, and Undo takes only that back', () => {
  const a = app([invoice('INV-1')]);
  a.addPayment('INV-1', 400, '2026-11-10');
  a.setPaid('INV-1', true);
  const h = a.invoices[0];
  assert.deepEqual(plain(h.payments.map(p => [p.amount, p.on, !!p.full])), [[400, '2026-11-10', false], [635, '2026-11-27', true]]);
  a.setPaid('INV-1', false);
  assert.equal(h.paidAt, null);
  assert.deepEqual(plain(h.payments.map(p => p.amount)), [400]);
  assert.equal(a.owedOn(h), 635);
});

test('removing a payment from a paid invoice makes it owed again', () => {
  const a = app([invoice('INV-1')]);
  a.addPayment('INV-1', 1035, '2026-11-10');
  a.removePayment('INV-1', 0);
  const h = a.invoices[0];
  assert.equal(h.paidAt, null);
  assert.equal(h.payments, undefined);
  assert.equal(a.payStatus(h).key, 'unpaid');
});

test('an invoice marked paid before part payments existed counts as paid in full that day', () => {
  const a = app([invoice('INV-1', { paidAt: '2026-11-05' })]);
  const h = a.invoices[0];
  assert.deepEqual(plain(a.paymentsOf(h)), [{ on: '2026-11-05', amount: 1035, implied: true }]);
  assert.equal(a.balanceOf(h), 0);
});

test('a credit note takes its total off what the invoice owes', () => {
  const a = app([invoice('INV-1'), credit('CN-1', 'INV-1', 345)]);
  const h = a.invoices[0];
  assert.equal(a.creditedOn(h), 345);
  assert.equal(a.owedOn(h), 690);
  assert.deepEqual(plain(a.payStatus(h)), { key: 'part', label: '£690.00 left' });
  assert.equal(a.payStatus(a.invoices[1]).label, 'Credit for INV-1');
  assert.equal(a.owedOn(a.invoices[1]), 0, 'a credit note is never owed');
});

test('an invoice credited in full is no longer owed', () => {
  const a = app([invoice('INV-1', { inv: { due: '2026-11-10' } }), credit('CN-1', 'INV-1', 1035)]);
  const h = a.invoices[0];
  assert.deepEqual(plain(a.payStatus(h)), { key: 'credited', label: 'Credited' });
  assert.equal(a.isOwedStatus(h), false);
  assert.equal(a.overdueList().length, 0, 'and no longer overdue');
});

test('Mark paid on a part-credited invoice records only what was left', () => {
  const a = app([invoice('INV-1'), credit('CN-1', 'INV-1', 35)]);
  a.setPaid('INV-1', true);
  assert.deepEqual(plain(a.invoices[0].payments.map(p => p.amount)), [1000]);
  assert.equal(a.balanceOf(a.invoices[0]), 0);
});

test('credit notes have their own numbering', () => {
  const a = app([invoice('INV-4'), credit('CN-7', 'INV-4', 10)]);
  assert.equal(a.nextInvoiceNumber('credit'), 'CN-8');
  assert.equal(a.nextInvoiceNumber('invoice'), 'INV-5', 'credit notes don\'t move invoice numbers on');
  a.set({ invoices: [], settings: { creditPrefix: 'CR', nextCreditNumber: 100 } });
  assert.equal(a.nextInvoiceNumber('credit'), 'CR100');
});

test('a credit note starts as the whole invoice, priced at the invoice\'s own rates and tax', () => {
  const inv = invoice('INV-1', { inv: { items: [{ kind: 'days', qty: 3, desc: 'Design', disc: 'pct', discValue: 10 }, { kind: 'hours', qty: 2, desc: 'Calls' }, { kind: 'daysoff', qty: 1 }, { kind: 'fixed', amount: 50, desc: 'Hosting' }], discount: { pct: 5, reason: 'Loyal' } } });
  const a = app([inv]);
  const want = a.invoiceTotals(a.docLines(inv.inv, inv.c), inv.c).total;
  a.clients[0].dailyRate = 999; a.clients[0].taxRate = 0; // the client's rates and tax have changed since
  a.startCredit(a.invoices[0]);
  const d = a.draft;
  assert.equal(d.type, 'credit');
  assert.equal(d.creditFor, 'INV-1');
  assert.equal(d.number, 'CN-1');
  assert.deepEqual(plain(d.items.map(it => [it.kind, it.qty, it.price])), [['item', 3, 300], ['item', 2, 40], ['item', 1, -300], ['fixed', 1, 0]]);
  const c = a.draftClient();
  assert.equal(a.invoiceTotals(a.docLines(d, c), c).total, want, 'credits exactly what was invoiced');
});

test('a credit note needs a reason, and asks before crediting more than is left', () => {
  const a = app([invoice('INV-1'), credit('CN-1', 'INV-1', 1000)]);
  a.startCredit(a.invoices[0]);
  assert.equal(a.creditOkToSave(), false, 'no reason yet');
  a.draft.reason = 'Hours billed twice';
  let asked = '';
  a.context.confirm = msg => { asked = msg; return false; };
  assert.equal(a.creditOkToSave(), false);
  assert.match(asked, /more than the £35.00 left to credit on INV-1/);
  a.draft.items = [{ kind: 'fixed', amount: 30, desc: 'Part', qty: 1 }].map(a.normItem);
  a.context.confirm = () => { throw new Error('should not ask'); };
  assert.equal(a.creditOkToSave(), true, '30 + 15% VAT = 34.50 fits');
});

test('the Dashboard: payments by the day they were made, credit notes off what was invoiced', () => {
  const a = app([
    invoice('INV-1', { payments: [{ amount: 400, on: '2026-10-20' }, { amount: 635, on: '2026-11-05' }], paidAt: '2026-11-05' }),
    invoice('INV-2', { inv: { date: '2026-11-10', due: '2026-11-20' }, payments: [{ amount: 100, on: '2026-11-12' }] }),
    credit('CN-1', 'INV-2', 135, { inv: { date: '2026-11-15' } }),
  ]);
  const f = a.moneyFacts('GBP');
  assert.equal(f.invoiced.thisM, 2070 - 135, 'two invoices, less the credit note');
  assert.equal(f.paid.thisM, 735);
  assert.equal(f.paid.lastM, 400);
  assert.equal(f.owed.total, 800, '1035 − 100 paid − 135 credited');
  assert.equal(f.overdue.total, 800);
  assert.deepEqual(plain(f.debtors.map(d => [d.name, d.total, d.own])), [['Northwind', 800, 800]]);
  assert.equal(f.count.thisM, 2, 'two invoices this month; the credit note isn\'t counted as one');
});

test('Reports: credit notes count negative in their own period, paid is what\'s been paid so far', () => {
  const a = app([
    invoice('INV-1', { payments: [{ amount: 400, on: '2026-11-10' }] }),
    credit('CN-1', 'INV-1', 115, { inv: { date: '2026-11-20' }, subtotal: 100, tax: 15 }),
  ]);
  const rows = a.reportRows({ from: '2026-03-01', to: '2027-02-28' });
  assert.deepEqual(plain(rows.map(r => [r.kind, r.h.inv.number, r.subtotal, r.tax, r.total, r.paid, r.owed])),
    [['invoice', 'INV-1', 900, 135, 1035, 400, 520], ['credit', 'CN-1', -100, -15, -115, 0, 0]]);
  assert.equal(rows.reduce((s, r) => s + r.tax, 0), 120, 'VAT for the period, net of the credit note');
});

test('History: removing a credit note puts back what the invoice owed', () => {
  const a = app([invoice('INV-1'), credit('CN-1', 'INV-1', 1035)]);
  assert.equal(a.owedOn(a.invoices[0]), 0);
  a.histAction({ target: { dataset: { act: 'del', id: 'CN-1' } } });
  assert.equal(a.invoices.length, 1);
  assert.equal(a.owedOn(a.invoices[0]), 1035);
});

test('History: Add payment reads the form under the invoice', () => {
  const a = app([invoice('INV-1')]);
  const form = { querySelector: sel => ({ '.pay-amt': { value: '250.5' }, '.pay-on': { value: '2026-11-11' }, '.pay-note': { value: ' cash ' } })[sel] };
  a.histAction({ target: { dataset: { act: 'pay-add', id: 'INV-1' }, closest: () => form } });
  assert.deepEqual(plain(a.invoices[0].payments), [{ amount: 250.5, on: '2026-11-11', note: 'cash' }]);
});
