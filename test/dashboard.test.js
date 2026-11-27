// The Dashboard's figures (also what Ask Invaro answers from), and amounts in your currency.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness');

const h = (number, company, cur, total, date, extra = {}) => ({
  id: number, inv: { number, date, due: extra.due || date, ...(extra.type ? { type: extra.type } : {}) },
  c: { id: company.toLowerCase(), company, currency: cur }, total, tracked: true, paidAt: extra.paidAt || null, ...(extra.fx ? { fx: extra.fx } : {}),
});

function dashboard() {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ settings: {}, invoices: [
    h('1', 'A', 'GBP', 1000, '2026-11-03', { paidAt: '2026-11-20' }),
    h('2', 'B', 'GBP', 500, '2026-10-15', { due: '2026-11-14' }), // overdue
    h('3', 'A', 'GBP', 200, '2026-11-20', { due: '2026-12-20' }), // owed, not yet due
    h('4', 'A', 'GBP', 300, '2025-11-10', { paidAt: '2025-11-30' }), // same month last year
    h('5', 'A', 'GBP', 9999, '2026-11-10', { type: 'quote' }), // quotes don't count
    h('6', 'C', 'USD', 777, '2026-11-05'), // another currency
  ] });
  return app;
}

test('invoiced and paid: this month, last month, a year ago and this year', () => {
  const f = dashboard().moneyFacts('GBP');
  // The last 12 months start in December 2025, so last November's 300 isn't in them.
  assert.deepEqual(plain(f.invoiced), { thisM: 1200, lastM: 500, lastY: 300, year: 1700, last12: 1700 });
  assert.deepEqual(plain(f.paid), { thisM: 1000, lastM: 0, year: 1000 });
  assert.equal(f.count.thisM, 2);
});

test('owed and overdue, and who owes the most', () => {
  const f = dashboard().moneyFacts('GBP');
  assert.equal(f.owed.total, 700);
  assert.equal(f.owed.count, 2);
  assert.equal(f.overdue.total, 500);
  assert.equal(f.overdue.count, 1);
  assert.deepEqual(plain(f.debtors.map(d => [d.name, d.total, d.overdue])), [['B', 500, 1], ['A', 200, 0]]);
});

test('each currency is counted on its own, most used first', () => {
  const app = dashboard();
  assert.deepEqual(plain(app.dashCurrencies()), ['GBP', 'USD']);
  assert.equal(app.moneyFacts('USD').invoiced.thisM, 777);
});

test('the last 12 months, oldest first, ending this month', () => {
  const f = dashboard().moneyFacts('GBP');
  assert.equal(f.series.length, 12);
  assert.equal(f.series[0].m, '2025-12');
  assert.deepEqual(plain(f.series[11]), { m: '2026-11', invoiced: 1200, paid: 1000 });
  assert.deepEqual(plain(f.series[10]), { m: '2026-10', invoiced: 500, paid: 0 });
});

test('amounts in your currency at today\'s rate, going through rand', () => {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ settings: { homeCurrency: 'ZAR' } });
  app.run('todayRand.GBP = { rate: 23 }; todayRand.USD = { rate: 18 }');
  assert.equal(app.toHome(100, 'GBP'), 2300);
  assert.equal(app.toHome(100, 'ZAR'), 100);
  app.set({ settings: { homeCurrency: 'USD' } });
  assert.equal(app.toHome(100, 'GBP'), 127.78);
  assert.equal(app.toHome(100, 'EUR'), null, 'no rate for euros yet');
  app.set({ settings: {} });
  assert.equal(app.toHome(100, 'GBP'), null, 'no currency of your own set');
});

test('a paid invoice counts at the rate on the day it was paid, with your own rate first', () => {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ settings: { homeCurrency: 'ZAR', fxBank: 'standard' } });
  app.run('todayRand.GBP = { rate: 23 }');
  const paid = (fx) => h('1', 'A', 'GBP', 100, '2026-11-01', { paidAt: '2026-11-10', fx });
  assert.equal(app.homeValue(paid({ ZAR: { standard: { rate: 22, for: '2026-11-10' } } })), 2200);
  assert.equal(app.homeValue(paid({ ZAR: { standard: { rate: 22, for: '2026-11-10' }, manual: { rate: 21.5, for: '2026-11-10' } } })), 2150);
  // A rate kept for a different day (a payment that was undone) is ignored: today's rate instead.
  assert.equal(app.homeValue(paid({ ZAR: { standard: { rate: 22, for: '2026-10-01' } } })), 2300);
  assert.equal(app.homeValue(h('2', 'A', 'GBP', 100, '2026-11-01')), 2300); // unpaid: today's rate
});

test('the All view adds every currency up in yours', () => {
  const app = dashboard();
  app.set({ settings: { homeCurrency: 'GBP' } });
  app.run('todayRand.GBP = { rate: 20 }; todayRand.USD = { rate: 16 }');
  const f = app.moneyFacts('all');
  // 1200 GBP + 777 USD × 16/20 = 621.60 GBP
  assert.equal(f.invoiced.thisM, 1821.6);
  assert.equal(f.missing, false);
  assert.deepEqual(plain(f.split.map(s => [s.cur, s.invoiced, s.invoicedHome])), [['GBP', 1700, 1700], ['USD', 777, 621.6]]);
});
