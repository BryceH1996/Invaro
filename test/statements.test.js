// Client statements (statements.js, buildStatement in pdf.js), credit notes on every PDF design, and
// choosing when the tax year starts (reports.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness');

const client = { id: 'c1', company: 'Northwind', currency: 'GBP', dueDays: 14, hourlyRate: 40, dailyRate: 300, dayOffRate: '', items: [], address: '1 High St' };
const inv = (number, date, due, total, extra = {}) => ({ id: number, inv: { number, clientId: 'c1', date, due, items: [] }, c: { ...client }, total, tracked: true, paidAt: null, ...extra });
function app(invoices, today = '2026-11-27') {
  const a = loadApp({ today });
  a.set({ clients: [client], invoices, settings: { me: { name: 'Me', company: 'My Co' }, pageSize: 'a4' }, stock: [], stockMoves: [] });
  return a;
}
const history = () => [
  inv('INV-1', '2026-06-01', '2026-06-15', 500, { paidAt: '2026-06-20' }),                                  // paid before 1.31.0
  inv('INV-2', '2026-09-01', '2026-09-15', 1000, { payments: [{ amount: 300, on: '2026-09-30', note: 'EFT' }] }),
  inv('INV-3', '2026-10-20', '2026-11-03', 400),
  inv('INV-4', '2026-11-20', '2026-12-04', 250),
  { ...inv('CN-1', '2026-10-25', '', 100), inv: { number: 'CN-1', type: 'credit', creditFor: 'INV-3', reason: 'Short delivery', date: '2026-10-25', clientId: 'c1' }, tracked: undefined },
  { ...inv('QUO-1', '2026-11-01', '2026-12-01', 9999), inv: { number: 'QUO-1', type: 'quote', date: '2026-11-01', clientId: 'c1' } },  // not on a statement
  inv('INV-0', '2025-01-01', '', 777, { tracked: false }),                                                     // no paid status: left off
];

test('a statement: balance brought forward, then invoices, credit notes and payments with a running balance', () => {
  const a = app(history());
  const [g] = plain(a.statementData('c1', { from: '2026-09-01', to: '2026-11-27' }));
  assert.equal(g.cur, 'GBP');
  assert.equal(g.opening, 0, 'INV-1 was invoiced and paid before the period');
  assert.deepEqual(g.rows.map(r => [r.date, r.ref, r.debit || -r.credit, r.balance]), [
    ['2026-09-01', 'INV-2', 1000, 1000],
    ['2026-09-30', 'INV-2', -300, 700],
    ['2026-10-20', 'INV-3', 400, 1100],
    ['2026-10-25', 'CN-1', -100, 1000],
    ['2026-11-20', 'INV-4', 250, 1250],
  ]);
  assert.equal(g.closing, 1250);
  assert.match(g.rows[1].desc, /Payment received \(EFT\)/);
  assert.match(g.rows[3].desc, /Credit note for INV-3: Short delivery/);
});

test('what\'s owed, by how long it has been overdue', () => {
  const a = app(history());
  const [g] = plain(a.statementData('c1', { to: '2026-11-27' }));
  // INV-2: 700 owed, due 15 Sep (73 days late); INV-3: 300 owed, due 3 Nov (24 days); INV-4: not yet due.
  assert.deepEqual(g.aging, { current: 250, d30: 300, d60: 0, d90: 700, older: 0 });
  assert.equal(g.closing, 1250, 'the closing balance is the same as what\'s owed');
});

test('a brought-forward balance, and one table per currency', () => {
  const a = app([...history(), { ...inv('INV-9', '2026-11-01', '2026-11-30', 80), c: { ...client, currency: 'EUR' } }]);
  const groups = plain(a.statementData('c1', { from: '2026-10-01', to: '2026-11-27' }));
  assert.deepEqual(groups.map(g => [g.cur, g.opening, g.closing]), [['GBP', 700, 1250], ['EUR', 0, 80]]);
});

test('the statement starts three months back, or at the oldest invoice still owed', () => {
  const a = app(history());
  assert.equal(a.statementFrom('c1', '2026-11-27'), '2026-09-01');
  a.invoices.push(inv('INV-5', '2026-02-10', '2026-02-24', 10));
  assert.equal(a.statementFrom('c1', '2026-11-27'), '2026-02-01');
});

test('what a client owes, in words, for the reminders', () => {
  const a = app(history());
  assert.equal(a.owesText('c1'), '£1250.00 (£1000.00 overdue)');
  assert.equal(a.clientOwes('c1'), true);
  a.set({ invoices: [inv('INV-1', '2026-06-01', '2026-06-15', 500, { payments: [{ amount: 600, on: '2026-06-20' }], paidAt: '2026-06-20' })] });
  assert.equal(a.owesText('c1'), '£100.00 in credit');
  assert.equal(a.clientOwes('c1'), false);
});

test('the statement PDF draws, over more than one page when it needs to', () => {
  const a = app(history());
  const doc = a.buildStatement(a.statementOptions(a.clients[0]));
  const text = doc.output();
  assert.match(text, /Statement/);
  assert.match(text, /AMOUNT DUE/);
  assert.match(text, /Credit note for INV-3: Short/, 'the reason (it wraps onto the next line)');
  // Many invoices: the table carries on over several pages.
  const many = Array.from({ length: 80 }, (_, i) => inv(`INV-${100 + i}`, `2026-${String(1 + (i % 10)).padStart(2, '0')}-10`, '', 10));
  a.set({ invoices: many });
  const long = a.buildStatement({ ...a.statementOptions(a.clients[0]), from: '' });
  assert.ok(long.getNumberOfPages() > 1);
});

test('a credit note prints on every design, without banking details', () => {
  const a = app([]);
  const c = { ...client, taxRate: 15 };
  const note = { type: 'credit', number: 'CN-3', creditFor: 'INV-7', reason: 'Order cancelled', date: '2026-11-27', due: '', items: [{ kind: 'fixed', amount: 100, desc: 'Refund' }] };
  const lines = plain(a.docLines(note, c));
  const bank = { enabled: true, bankName: 'Test Bank', accountNumber: '123456' };
  for (const template of Object.keys(a.TEMPLATES)) {
    const text = a.buildPdf({ me: { name: 'Me' }, c, inv: note, lines, pageSize: 'a4', design: { template }, bank }).output();
    assert.match(text, /Cs*Rs*Es*Ds*Is*Ts+Ns*Os*Ts*E|Credit Note/i, template); // Mono spaces its title out
    assert.match(text, /INV-7/, `${template} says which invoice it credits`);
    assert.doesNotMatch(text, /123456/, `${template} leaves the bank account off`);
  }
});

test('the tax year can start on any 1st, or 6 April', () => {
  const a = app([inv('INV-1', '2026-04-05', '', 1), inv('INV-2', '2026-04-06', '', 1)], '2026-11-27');
  a.set({ settings: { taxYearStart: '04-06' } });
  const { list, current } = a.reportPeriods();
  const byId = Object.fromEntries(list.map(p => [p.id, p]));
  assert.equal(current, 'tax-2026');
  assert.deepEqual([byId['tax-2026'].from, byId['tax-2026'].to], ['2026-04-06', '2027-04-05']);
  assert.deepEqual([byId['tax-2025'].from, byId['tax-2025'].to], ['2025-04-06', '2026-04-05'], 'INV-1 falls in the year before');
  assert.equal(byId['tax-2026'].label, 'Tax year 2026/27 (6 Apr 2026 – 5 Apr 2027)');
  a.set({ settings: { taxYearStart: '07-01' } });
  assert.equal(a.reportPeriods().current, 'tax-2026');
  assert.equal(a.taxYear(2027).to, '2028-06-30');
});

test('a tax year starting 1 January is just the calendar year', () => {
  const a = app([inv('INV-1', '2026-05-01', '', 1)]);
  a.set({ settings: { taxYearStart: '01-01' } });
  const { list, current } = a.reportPeriods();
  assert.equal(current, 'cal-2026');
  assert.ok(list.every(p => p.id.startsWith('cal-')));
});

test('a tax year start that isn\'t a real date falls back to 1 March', () => {
  const a = app([]);
  for (const bad of ['', '13-01', '02-30', 'April']) {
    a.set({ settings: { taxYearStart: bad } });
    assert.equal(a.taxYearStart(), '03-01', bad);
  }
});
