// Invoice numbering, paid status, quotes paid in steps, and Reports.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness');

// A saved History entry: inv({ inv: { … } }) changes the invoice itself, anything else the entry.
const inv = (number, { inv: fields = {}, ...rest } = {}) => ({
  id: number, inv: { number, date: '2026-11-01', due: '2026-11-15', ...fields }, c: { currency: 'GBP', company: 'Acme' }, total: 100, ...rest,
});

test('the next number is one past the highest saved, and never below the setting', () => {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ settings: { prefix: 'INV-', nextNumber: 5 }, invoices: [inv('INV-7'), inv('INV-12'), inv('INV-9')] });
  assert.equal(app.nextNumberValue('invoice'), 13);
  assert.equal(app.nextInvoiceNumber('invoice'), 'INV-13');
  app.set({ settings: { prefix: 'INV-', nextNumber: 50 } }); // skipped ahead on My details
  assert.equal(app.nextInvoiceNumber('invoice'), 'INV-50');
});

test('invoices and quotes are numbered separately', () => {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ settings: { prefix: 'INV-', nextNumber: 1 }, invoices: [inv('INV-3'), inv('QUO-30', { inv: { type: 'quote' } })] });
  assert.equal(app.nextInvoiceNumber('invoice'), 'INV-4');
  assert.equal(app.nextInvoiceNumber('quote'), 'QUO-31');
  app.set({ invoices: [] });
  assert.equal(app.nextInvoiceNumber('quote'), 'QUO-1');
});

test('the number is read from the end, whatever comes before it', () => {
  const app = loadApp();
  assert.equal(app.numberOf('INV-2026-007'), 7);
  assert.equal(app.numberOf('1043'), 1043);
  assert.equal(app.numberOf('A12-B'), 12);
  assert.ok(Number.isNaN(app.numberOf('DRAFT')));
});

test('paid status: paid, unpaid, overdue, or not tracked', () => {
  const app = loadApp({ today: '2026-11-27' });
  const status = h => app.payStatus(h).key;
  assert.equal(status(inv('1', { tracked: true, paidAt: '2026-11-20' })), 'paid');
  assert.equal(status(inv('2', { tracked: true, paidAt: null, inv: { due: '2026-12-01' } })), 'unpaid');
  assert.equal(status(inv('3', { tracked: true, paidAt: null, inv: { due: '2026-11-26' } })), 'overdue');
  assert.equal(status(inv('4', { tracked: true, paidAt: null, inv: { due: '2026-11-27' } })), 'unpaid'); // due today isn't late yet
  assert.equal(status(inv('5', {})), 'untracked'); // saved before paid status existed
});

test('an invoice marked paid and then unpaid counts as owed again (fixed in 1.28.0)', () => {
  const app = loadApp({ today: '2026-11-27' });
  const h = inv('INV-1', { inv: { due: '2026-11-10' }, fx: { ZAR: { standard: { rate: 22, for: '2026-11-27' } } } });
  app.set({ invoices: [h], settings: {} });
  app.setPaid('INV-1', true);
  const saved = app.invoices[0];
  assert.equal(saved.paidAt, '2026-11-27');
  assert.equal(app.payStatus(saved).key, 'paid');
  app.setPaid('INV-1', false);
  assert.equal(saved.paidAt, null);
  assert.equal(saved.tracked, true);
  assert.equal(saved.fx, undefined, 'the rates were for that payment');
  assert.equal(app.payStatus(saved).key, 'overdue');
});

test('a quote paid in steps spreads its tax across the steps', () => {
  const app = loadApp({ today: '2026-11-27' });
  // Two lines (600 and 400) plus 15% VAT: 1150 in all.
  const q = inv('QUO-1', { inv: { type: 'quote' }, total: 1150, lines: [{ amount: 600 }, { amount: 400 }], paidSteps: { 0: '2026-11-20' } });
  assert.deepEqual(plain(app.stepSummary(q)), { count: 2, paidCount: 1, factor: 1.15, paid: 690, outstanding: 460 });
  assert.deepEqual(plain(app.payStatus(q)), { key: 'part', label: '1 of 2 paid' });
  q.paidSteps[1] = '2026-11-25';
  assert.equal(app.payStatus(q).label, 'Paid in full');
});

test('a step includes the discount straight under its line, but not the whole-quote discount', () => {
  const app = loadApp();
  const lines = [{ amount: 500 }, { amount: -50, discount: true }, { amount: 300 }, { amount: -75, discount: true, whole: true }];
  assert.equal(app.stepNet(lines, 0), 450);
  assert.equal(app.stepNet(lines, 2), 300);
  // 450 + 300 = 750 of steps, scaled to the total of 675
  const s = app.stepSummary({ inv: { type: 'quote' }, total: 675, lines, paidSteps: { 2: '2026-11-01' } });
  assert.equal(s.count, 2);
  assert.equal(s.paid, 270);
  assert.equal(s.outstanding, 405);
});

test('tax years run from 1 March to the end of February, leap years included', () => {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ invoices: [inv('1', { inv: { date: '2027-05-01' } })] });
  const { list, current } = app.reportPeriods();
  const byId = Object.fromEntries(list.map(p => [p.id, p]));
  assert.equal(current, 'tax-2026');
  assert.equal(byId['tax-2026'].from, '2026-03-01');
  assert.equal(byId['tax-2026'].to, '2027-02-28');
  assert.equal(byId['tax-2027'].to, '2028-02-29');
  assert.equal(byId['cal-2027'].to, '2027-12-31');
});

test('in January and February the current tax year is the one that started last March', () => {
  const app = loadApp({ today: '2027-02-10' });
  app.set({ invoices: [] });
  assert.equal(app.reportPeriods().current, 'tax-2026');
});

test('report rows only count invoices in the period, and work out VAT for old ones', () => {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ invoices: [
    inv('A', { inv: { date: '2026-04-01' }, total: 172.5, lines: [{ amount: 100 }, { amount: 50 }] }), // no subtotal saved
    inv('B', { inv: { date: '2026-05-01' }, total: 115, subtotal: 100, tax: 15 }),
    inv('C', { inv: { date: '2026-02-01' }, total: 999 }), // the tax year before
    inv('Q', { inv: { date: '2026-06-01', type: 'quote' }, total: 500 }),
  ] });
  const rows = app.reportRows({ from: '2026-03-01', to: '2027-02-28' });
  assert.deepEqual(plain(rows.map(r => [r.h.inv.number, r.subtotal, r.tax, r.total])),[['A', 150, 22.5, 172.5], ['B', 100, 15, 115]]);
});
