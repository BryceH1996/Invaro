// Moving from another app: reading dates, and invoices exported from QuickBooks, Xero and others.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness');

test('dates in the formats other apps export', () => {
  const app = loadApp();
  app.set({ dayFirst: true });
  assert.equal(app.parseAnyDate('2025-03-14'), '2025-03-14');
  assert.equal(app.parseAnyDate('14/03/2025'), '2025-03-14');
  assert.equal(app.parseAnyDate('03/14/2025'), '2025-03-14', 'a month over 12 can only be the day');
  assert.equal(app.parseAnyDate('14.03.25'), '2025-03-14');
  assert.equal(app.parseAnyDate('14 Mar 2025'), '2025-03-14');
  assert.equal(app.parseAnyDate('1st March 25'), '2025-03-01');
  assert.equal(app.parseAnyDate('Mar 14, 2025'), '2025-03-14');
  assert.equal(app.parseAnyDate('soon'), '');
  assert.equal(app.parseAnyDate(''), '');
  app.set({ dayFirst: false });
  assert.equal(app.parseAnyDate('03/04/2025'), '2025-03-04');
});

// Up to 1.30.1, "31/02/2025" came in as 2025-02-31: only the day being 1–31 was checked.
test('dates that don\'t exist are not read, in any format', () => {
  const app = loadApp();
  app.set({ dayFirst: true });
  for (const s of ['31/02/2025', '31/04/2025', '29/02/2025', '2025-02-30', '2025-13-01', '0/03/2025', '31 Feb 2025', 'Apr 31, 2025'])
    assert.equal(app.parseAnyDate(s), '', s);
  assert.equal(app.parseAnyDate('29/02/2024'), '2024-02-29', 'a leap year');
  assert.equal(app.parseAnyDate('31/12/25'), '2025-12-31');
  app.set({ dayFirst: false });
  assert.equal(app.parseAnyDate('02/30/2025'), '');
  assert.equal(app.parseAnyDate('02/28/2025'), '2025-02-28');
});

test('an invoice with an impossible date is skipped, not imported', () => {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ settings: {}, clients: [], invoices: [] });
  const header = ['Invoice No', 'Customer', 'Invoice Date', 'Due Date', 'Total'];
  const rows = [['2001', 'Acme', '31/02/2025', '30/03/2025', '100'], ['2002', 'Acme', '15/03/2025', '31/04/2025', '100']];
  const plan = app.planInvoices(Object.assign(rows, { header }), app.columnsFor(header, 'invoices'), { headerRow: 0, currency: 'ZAR' });
  assert.equal(plan[0].status, 'skip');
  assert.equal(plan[0].why, 'No date Invaro can read');
  assert.equal(plan[1].status, 'new');
  assert.equal(plan[1].due, '', 'an impossible due date is left empty, as an unreadable one is');
});

test('a file is read month first only when its dates say so', () => {
  const app = loadApp();
  assert.equal(app.guessDayFirst(['03/14/2025', '04/01/2025']), false);
  assert.equal(app.guessDayFirst(['14/03/2025', '01/04/2025']), true);
  assert.equal(app.guessDayFirst(['01/02/2025']), true, 'South African and UK exports are usually day first');
});

// One row per invoice, the way QuickBooks' invoice list exports it.
function planOneRowEach(existing = []) {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ settings: {}, clients: [], invoices: existing });
  const header = ['Invoice No', 'Customer', 'Invoice Date', 'Due Date', 'Total', 'Tax', 'Balance', 'Status'];
  const rows = [
    ['1001', 'Acme', '14/03/2025', '13/04/2025', '1150.00', '150.00', '0.00', ''],
    ['1002', 'Acme', '20/03/2025', '19/04/2025', 'R575', '75', '575', ''],
    ['1003', 'Beta', '21/03/2025', '20/04/2025', '100', '0', '100', ''],
    ['1004', 'Beta', '22/03/2025', '21/04/2025', '100', '0', '100', 'Void'],
    ['Total', '', '', '', '1925', '', '', ''],
  ];
  const cols = app.columnsFor(header, 'invoices');
  return { app, plan: app.planInvoices(Object.assign(rows, { header }), cols, { headerRow: 0, currency: 'ZAR' }) };
}

test('invoices with one row each: totals, VAT and paid status', () => {
  const { plan } = planOneRowEach();
  const [a, b] = plan;
  assert.equal(a.status, 'new');
  assert.deepEqual([a.date, a.due, a.total, a.subtotal, a.tax, a.paid], ['2025-03-14', '2025-04-13', 1150, 1000, 150, true]);
  assert.equal(a.paidAt, '2025-04-13', 'with no payment date, the due date');
  assert.equal(a.guessedPaid, true);
  assert.deepEqual(plain(a.items), [{ kind: 'fixed', desc: 'Invoice 1001', amount: 1000 }]);
  assert.deepEqual([b.total, b.subtotal, b.paid, b.paidAt], [575, 500, false, null]);
});

test('one new client per customer name, report totals and voided invoices skipped', () => {
  const { plan } = planOneRowEach();
  assert.equal(plan.length, 4, 'the Total row is not an invoice');
  assert.equal(plan[0].client, plan[1].client);
  assert.equal(plan[0].client.company, 'Acme');
  assert.equal(plan[0].client.currency, 'ZAR');
  assert.equal(plan[0].client.dueDays, 30);
  assert.deepEqual(plain(plan.map(p => p.status)), ['new', 'new', 'new', 'skip']);
  assert.match(plan[3].why, /Void/);
});

test('an invoice already in History is skipped', () => {
  const { plan } = planOneRowEach([{ inv: { number: '1002', date: '2025-01-01' }, c: {} }]);
  assert.equal(plan[1].status, 'skip');
  assert.equal(plan[1].why, 'Already in History');
});

test('invoices with a row per line: lines, quantities and the VAT left over', () => {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ settings: {}, clients: [{ id: 'c1', company: 'Acme Ltd', currency: 'GBP' }], invoices: [] });
  const header = ['Invoice Number', 'Customer', 'Date', 'Description', 'Quantity', 'Unit Price', 'Total'];
  const rows = [
    ['INV-0007', 'acme ltd', '2025-06-01', 'Design', '2', '500', '1320'],
    ['INV-0007', 'acme ltd', '2025-06-01', 'Hosting', '1', '100', '1320'],
  ];
  const plan = app.planInvoices(Object.assign(rows, { header }), app.columnsFor(header, 'invoices'), { headerRow: 0, currency: 'ZAR' });
  assert.equal(plan.length, 1);
  const p = plan[0];
  assert.equal(p.client.id, 'c1', 'matched to the client you have, whatever the case');
  assert.equal(p.cur, 'GBP');
  assert.deepEqual(plain(p.items), [{ kind: 'item', desc: 'Design', qty: 2, price: 500 }, { kind: 'item', desc: 'Hosting', qty: 1, price: 100 }]);
  assert.deepEqual([p.subtotal, p.tax, p.total], [1100, 220, 1320]);

  // Bringing it in: its VAT rate is worked out, and numbering carries on after it.
  app.set({ draft: { number: 'INV-1', type: 'invoice', items: [] }, settings: { prefix: 'INV-', nextNumber: 1 } });
  assert.match(app.applyInvoices(plan, 'xero.csv'), /^1 invoice added to History/);
  const saved = app.invoices[0];
  assert.equal(saved.c.taxRate, 20);
  assert.equal(saved.tracked, true);
  assert.equal(app.settings.nextNumber, 8);
});
