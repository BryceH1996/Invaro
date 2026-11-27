// Line amounts, discounts, VAT and totals: what ends up on the invoice and in History.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness');

const app = loadApp({ today: '2026-11-27' });
app.set({ settings: { taxLabel: 'VAT' } });
const client = (extra = {}) => ({ hourlyRate: 40, dailyRate: 300, dayOffRate: '', currency: 'GBP', taxRate: 0, ...extra });
// Lines → { subtotal, tax, total }, the way the app saves an invoice.
const totals = (items, c, discount) => app.invoiceTotals(app.docLines({ items, discount }, c), c);

test('each kind of line is priced from the client', () => {
  const c = client();
  assert.equal(app.lineAmount({ kind: 'hours', qty: 2.5 }, c), 100);
  assert.equal(app.lineAmount({ kind: 'days', qty: 3 }, c), 900);
  assert.equal(app.lineAmount({ kind: 'item', qty: 4, price: 12.345 }, c), 49.38);
  assert.equal(app.lineAmount({ kind: 'fixed', amount: 99.999 }, c), 100);
  assert.equal(app.lineAmount({ kind: 'hours', qty: '' }, c), 0);
});

test('days off take off the daily rate, or their own rate when set', () => {
  assert.equal(app.lineAmount({ kind: 'daysoff', qty: 1 }, client()), -300);
  assert.equal(app.lineAmount({ kind: 'daysoff', qty: 2 }, client({ dayOffRate: 250 })), -500);
  assert.equal(app.lineAmount({ kind: 'daysoff', qty: 1 }, client({ dayOffRate: 0 })), -0);
});

test('amounts are rounded to cents without float noise', () => {
  assert.equal(app.lineAmount({ kind: 'item', qty: 3, price: 0.1 }, client()), 0.3);
  assert.deepEqual(plain(totals([{ kind: 'item', qty: 1, price: 0.1 }, { kind: 'item', qty: 1, price: 0.2 }], client({ taxRate: 15 }))),
    { subtotal: 0.3, rate: 15, tax: 0.05, total: 0.35 });
});

test('a line discount is a percentage or an amount, never more than the line', () => {
  const c = client();
  assert.equal(app.lineDiscount({ kind: 'days', qty: 3, disc: 'pct', discValue: 10 }, c), 90);
  assert.equal(app.lineDiscount({ kind: 'days', qty: 3, disc: 'amt', discValue: 50 }, c), 50);
  assert.equal(app.lineDiscount({ kind: 'days', qty: 3, disc: 'amt', discValue: 1000 }, c), 900);
  assert.equal(app.lineDiscount({ kind: 'days', qty: 3, disc: 'pct', discValue: 150 }, c), 900);
  assert.equal(app.lineDiscount({ kind: 'days', qty: 3, disc: 'pct', discValue: -5 }, c), 0);
  assert.equal(app.lineDiscount({ kind: 'daysoff', qty: 1, disc: 'pct', discValue: 10 }, c), 0); // nothing to discount
});

test('priced lines drop zero lines and put each discount straight under its line', () => {
  const lines = plain(app.priced([
    { kind: 'days', qty: 3, desc: 'Design', disc: 'pct', discValue: 10 },
    { kind: 'hours', qty: 0, desc: 'Nothing' },
    { kind: 'daysoff', qty: 1, desc: 'Holiday' },
  ], client()));
  assert.deepEqual(lines.map(l => [l.desc, l.amount]), [['Design', 900], ['Discount (10%)', -90], ['Holiday', -300]]);
  assert.equal(lines[1].discount, true);
  assert.equal(lines[2].price, -300); // days off show a negative price
});

test('VAT is worked out after every discount', () => {
  const c = client({ taxRate: 15 });
  const items = [{ kind: 'days', qty: 3 }, { kind: 'hours', qty: 2.5 }]; // 900 + 100
  assert.deepEqual(plain(totals(items, c)), { subtotal: 1000, rate: 15, tax: 150, total: 1150 });
  // 10% off the whole invoice: 100 off before VAT
  assert.deepEqual(plain(totals(items, c, { pct: 10, reason: 'Loyal customer' })), { subtotal: 900, rate: 15, tax: 135, total: 1035 });
  // 10% off the days line, then 10% off the whole invoice: (810 + 100) × 0.9 = 819
  const both = [{ kind: 'days', qty: 3, disc: 'pct', discValue: 10 }, { kind: 'hours', qty: 2.5 }];
  assert.deepEqual(plain(totals(both, c, { pct: 10 })), { subtotal: 819, rate: 15, tax: 122.85, total: 941.85 });
});

test('the whole-invoice discount is the last line, named with its reason', () => {
  const lines = plain(app.docLines({ items: [{ kind: 'days', qty: 3 }], discount: { pct: 10, reason: 'Loyal customer' } }, client()));
  const last = lines[lines.length - 1];
  assert.equal(last.desc, 'Discount (10%): Loyal customer');
  assert.equal(last.detail, 'on £900.00');
  assert.equal(last.amount, -90);
  assert.equal(last.whole, true);
});

test('the whole-invoice discount stops at 100% and skips invoices with nothing to discount', () => {
  assert.equal(totals([{ kind: 'days', qty: 1 }], client(), { pct: 250 }).total, 0);
  assert.equal(app.docLines({ items: [{ kind: 'daysoff', qty: 1 }], discount: { pct: 10 } }, client()).length, 1);
  assert.equal(app.docLines({ items: [{ kind: 'days', qty: 1 }], discount: { pct: 0 } }, client()).length, 1);
});

test('no tax rate means no tax', () => {
  assert.deepEqual(plain(app.invoiceTotals([{ amount: 120 }], {})), { subtotal: 120, rate: 0, tax: 0, total: 120 });
});

test('money shows the currency symbol, two decimals and the sign first', () => {
  assert.equal(app.money(1234.5, 'GBP'), '£1234.50');
  assert.equal(app.money(-90, 'ZAR'), '-R90.00');
  assert.equal(app.money('', 'USD'), '$0.00');
});

test('line details read the way they print', () => {
  const c = client();
  assert.equal(app.lineDetail({ kind: 'hours', qty: 1 }, c), '1 hr @ £40.00/hr');
  assert.equal(app.lineDetail({ kind: 'days', qty: 2 }, c), '2 days @ £300.00/day');
  assert.equal(app.lineDetail({ kind: 'item', qty: 4, price: 1200, unit: 'box' }, c), '4 box × £1200.00');
});
