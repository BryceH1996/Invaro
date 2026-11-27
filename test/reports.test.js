// reports.js: the exchange rate behind each paid invoice's rand value.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness');

const gbp = (extra = {}) => ({ id: 'INV-1', inv: { number: 'INV-1', date: '2026-11-01' }, c: { currency: 'GBP', company: 'A' }, total: 100, tracked: true, paidAt: '2026-11-10', ...extra });
function app(settings = {}) {
  const a = loadApp({ today: '2026-11-27' });
  a.set({ settings: { reportCurrency: 'ZAR', ...settings }, invoices: [] });
  return a;
}

test('a rate is kept per bank, for the day the invoice was paid', () => {
  const a = app();
  const h = gbp();
  assert.equal(a.setFx(h, 'ZAR', 'standard', { rate: 23.1, on: '2026-11-10' }), true);
  assert.deepEqual(plain(h.fx), { ZAR: { standard: { rate: 23.1, on: '2026-11-10', for: '2026-11-10' } } });
  assert.equal(a.fxOf(h, 'ZAR').rate, 23.1);
  assert.equal(a.fxOf(h, 'GBP').kind, 'same');
});

test('your own rate wins, and removing it goes back to the bank\'s', () => {
  const a = app();
  const h = gbp();
  a.setFx(h, 'ZAR', 'standard', { rate: 23.1 });
  a.setFx(h, 'ZAR', 'manual', { rate: 22.5 });
  assert.deepEqual([a.fxOf(h, 'ZAR').rate, a.fxOf(h, 'ZAR').kind], [22.5, 'manual']);
  a.setFx(h, 'ZAR', 'manual', null);
  assert.equal(a.fxOf(h, 'ZAR').rate, 23.1);
  a.setFx(h, 'ZAR', 'standard', null);
  assert.equal(h.fx, undefined, 'nothing left: no fx at all');
});

test('a rate for another day is ignored once the paid date changes', () => {
  const a = app();
  const h = gbp();
  a.setFx(h, 'ZAR', 'standard', { rate: 23.1 });
  h.paidAt = '2026-11-20'; // marked unpaid, then paid again later
  assert.equal(a.fxOf(h, 'ZAR'), null);
  // 1.23.0 kept one rate, for the invoice date: never used.
  assert.equal(a.fxOf(gbp({ fx: { ZAR: { rate: 20, on: '2026-11-01' } } }), 'ZAR'), null);
});

test('the chosen bank\'s rate, else Standard Bank\'s once the bank has none for that day', () => {
  const a = app({ fxBank: 'absa' });
  const h = gbp();
  a.setFx(h, 'ZAR', 'standard', { rate: 23.1, on: '2026-11-10' });
  assert.equal(a.fxOf(h, 'ZAR'), null, 'not asked Absa yet');
  a.run('fxTried').add('INV-1|absa');
  assert.deepEqual(plain(a.fxOf(h, 'ZAR')), { rate: 23.1, on: '2026-11-10', for: '2026-11-10', bank: 'standard', instead: 'absa' });
  assert.equal(a.fxLabel(a.fxOf(h, 'ZAR')), 'Standard Bank, 10 Nov 2026 (Absa had no rate for this date)');
  a.setFx(h, 'ZAR', 'absa', { rate: 23.4, on: '2026-11-10' });
  assert.equal(a.fxOf(h, 'ZAR').rate, 23.4);
  assert.equal(a.fxLabel(a.fxOf(h, 'ZAR')), 'Absa, 10 Nov 2026');
});

test('in a team, someone who may not change an invoice keeps rates in memory only', () => {
  const a = app();
  a.set({ teamState: { team: { name: 'Acme', role: 'accountant', can: { reports: true } } } });
  const h = gbp({ savedBy: 'sam@example.com' });
  assert.equal(a.setFx(h, 'ZAR', 'standard', { rate: 23.1 }), false);
  assert.equal(h.fx, undefined, 'the shared invoice is unchanged');
  assert.equal(a.fxOf(h, 'ZAR').rate, 23.1, 'but the report still has it');
});

test('marking an invoice paid records every bank\'s rate that day', async () => {
  const a = app();
  const h = gbp();
  a.set({ invoices: [h] });
  a.run('store').fxRates = async (cur, day) => ({ standard: { rate: 23.1, on: day, kind: 'current' }, absa: { rate: 23.3, on: day }, nedbank: { error: 'offline' } });
  await a.captureFx(a.invoices[0]);
  assert.deepEqual(Object.keys(a.invoices[0].fx.ZAR).sort(), ['absa', 'standard']);
  // Rand invoices, quotes and unpaid invoices have nothing to record.
  const zar = gbp({ c: { currency: 'ZAR' } });
  await a.captureFx(zar);
  assert.equal(zar.fx, undefined);
});

// ---------- each payment's own rate (1.31.1) ----------
// A £1000 invoice (£869.57 + VAT), paid £400 on 10 Nov at 23 and £600 on 20 Nov at 24.
const twoPays = (extra = {}) => gbp({ total: 1000, subtotal: 869.57, tax: 130.43, paidAt: '2026-11-20',
  payments: [{ amount: 400, on: '2026-11-10', fx: { ZAR: { standard: { rate: 23, on: '2026-11-10' } } } }, { amount: 600, on: '2026-11-20', fx: { ZAR: { standard: { rate: 24, on: '2026-11-20' } } } }], ...extra });
const row = (a, h) => a.reportRows({ from: '2026-03-01', to: '2027-02-28' }).find(r => r.h.inv.number === h.inv.number);

test('each payment is valued at the rate on its own day', () => {
  const a = app();
  const h = twoPays();
  a.set({ invoices: [h] });
  assert.equal(a.paidIn(h, 'ZAR'), 23600, '400 × 23 + 600 × 24');
  assert.equal(a.paidRate(h, 'ZAR'), 23.6);
  const x = a.randOf(row(a, h), 'ZAR');
  assert.deepEqual(plain(x.home), { subtotal: 20521.85, tax: 3078.15, total: 23600 });
  assert.deepEqual(plain(x.fx), { rate: 23.6, kind: 'average', count: 2 });
});

test('a part-paid invoice gets a rand value for what has been paid so far', () => {
  const a = app();
  const h = twoPays({ paidAt: null, payments: [twoPays().payments[0]] });
  a.set({ invoices: [h] });
  const x = a.randOf(row(a, h), 'ZAR');
  assert.equal(x.home.total, 9200);
  assert.equal(x.fx.rate, 23);
  assert.deepEqual(plain(a.randCells(row(a, h), 'ZAR')), [23, '2026-11-10', 'Standard Bank, 10 Nov 2026', '8000.04', '1199.96', '9200.00'], '40% of the invoice paid, at 23');
});

test('until every payment has a rate, there is no rand value, and the missing one is looked up', () => {
  const a = app();
  const h = twoPays();
  delete h.payments[1].fx;
  a.set({ invoices: [h] });
  assert.equal(a.paidIn(h, 'ZAR'), null);
  assert.equal(a.randOf(row(a, h), 'ZAR').home, null);
  assert.deepEqual(plain(a.missingRates([row(a, h)], 'ZAR').map(m => [m.i, m.p.on])), [[1, '2026-11-20']]);
  assert.deepEqual(plain(a.randCells(row(a, h), 'ZAR')).slice(0, 3), ['', '', 'No rate yet']);
});

test('your own rate on one payment leaves the others at the bank\'s', () => {
  const a = app();
  const h = twoPays();
  a.set({ invoices: [h] });
  assert.equal(a.setPayFx(h, 1, 'ZAR', 'manual', { rate: 25, on: '2026-11-20', kind: 'manual' }), true);
  assert.equal(a.payFxOf(h, 1, 'ZAR').kind, 'manual');
  assert.equal(a.payFxOf(h, 0, 'ZAR').rate, 23);
  assert.equal(a.paidIn(h, 'ZAR'), 400 * 23 + 600 * 25);
  a.setPayFx(h, 1, 'ZAR', 'manual', null);
  assert.equal(a.payFxOf(h, 1, 'ZAR').rate, 24, 'back to the bank\'s');
});

test('recording a payment records every bank\'s rate on that payment\'s day', async () => {
  const a = app();
  const h = gbp({ paidAt: null, total: 1000 });
  a.set({ invoices: [h] });
  const asked = [];
  a.run('store').fxRates = async (cur, day) => { asked.push(day); return { standard: { rate: day === '2026-11-10' ? 23 : 24, on: day }, absa: { rate: 23.5, on: day } }; };
  a.addPayment('INV-1', 400, '2026-11-10');
  await new Promise(r => setTimeout(r, 10));
  a.addPayment('INV-1', 600, '2026-11-20');
  await new Promise(r => setTimeout(r, 10));
  const pays = a.invoices[0].payments;
  assert.deepEqual(asked, ['2026-11-10', '2026-11-20'], 'each payment looked up once, on its own date');
  assert.deepEqual(plain(pays.map(p => p.fx.ZAR.standard.rate)), [23, 24]);
  assert.deepEqual(Object.keys(pays[0].fx.ZAR).sort(), ['absa', 'standard']);
});

test('removing a payment takes its rates with it', () => {
  const a = app();
  const h = twoPays();
  a.set({ invoices: [h] });
  a.removePayment('INV-1', 0);
  assert.equal(a.invoices[0].payments.length, 1);
  assert.equal(a.invoices[0].payments[0].fx.ZAR.standard.rate, 24);
});

test('someone who may not change a shared invoice keeps payment rates in memory only', () => {
  const a = app();
  a.set({ teamState: { team: { name: 'Acme', role: 'accountant', can: { reports: true } } } });
  const h = twoPays({ savedBy: 'sam@example.com' });
  delete h.payments[1].fx;
  assert.equal(a.setPayFx(h, 1, 'ZAR', 'standard', { rate: 24.2, on: '2026-11-20' }), false);
  assert.equal(h.payments[1].fx, undefined, 'the shared invoice is unchanged');
  assert.equal(a.payFxOf(h, 1, 'ZAR').rate, 24.2, 'but the report still has it');
});

test('the Dashboard counts each payment at its own day\'s rate when your currency is rand', () => {
  const a = loadApp({ today: '2026-11-27' });
  a.set({ settings: { homeCurrency: 'ZAR' }, invoices: [twoPays()] });
  a.run('todayRand.GBP = { rate: 30 }');
  const f = a.moneyFacts('all');
  assert.equal(f.paid.thisM, 23600, 'not today\'s rate of 30');
  assert.equal(a.homeValue(a.invoices[0]), 23600, 'the invoice at the average of its payments\' rates');
});
