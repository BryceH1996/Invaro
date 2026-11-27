// Stock: invoices taking stock off (and putting it back), and importing a stock list.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness');

function withCable() {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ settings: {}, stock: [{ id: 'a', name: 'Cable', unit: 'm', prices: {} }], stockMoves: [{ id: 'm0', stockId: 'a', qty: 10, why: 'opening' }] });
  return app;
}
const cable = qty => [{ kind: 'item', stockId: 'a', qty, desc: 'Cable' }];

test('saving an invoice takes its stock off', () => {
  const app = withCable();
  assert.equal(app.settleStock('INV-1', cable(3)), '3 m Cable');
  assert.equal(app.onHand('a'), 7);
});

test('editing an invoice moves only the difference', () => {
  const app = withCable();
  app.settleStock('INV-1', cable(3));
  assert.equal(app.settleStock('INV-1', cable(5)), '2 m Cable');
  assert.equal(app.onHand('a'), 5);
  assert.equal(app.settleStock('INV-1', cable(5)), '', 'saving again unchanged moves nothing');
  assert.equal(app.settleStock('INV-1', cable(1)), '4 m Cable');
  assert.equal(app.onHand('a'), 9);
  assert.equal(app.stockMoves[app.stockMoves.length - 1].why, 'returned');
});

test('removing an invoice puts everything back', () => {
  const app = withCable();
  app.settleStock('INV-1', cable(3));
  app.settleStock('INV-2', cable(2));
  app.settleStock('INV-1', []);
  assert.equal(app.onHand('a'), 8, "INV-2's stock stays taken");
});

test('only item lines from stock take stock, and fractions stay exact', () => {
  const app = withCable();
  app.settleStock('INV-1', [{ kind: 'fixed', stockId: 'a', amount: 50 }, { kind: 'item', qty: 4, price: 10 }]);
  assert.equal(app.onHand('a'), 10);
  for (let i = 1; i <= 3; i++) app.settleStock('INV-1', cable(0.1 * i));
  assert.equal(app.onHand('a'), 9.7);
});

test('saving an invoice that takes more than is on hand asks first', () => {
  const app = withCable();
  let asked = '';
  app.context.confirm = msg => { asked = msg; return false; };
  const entry = (number, qty) => ({ inv: { number, items: cable(qty) } });
  assert.equal(app.stockOkToSave(entry('INV-1', 12)), false);
  assert.match(asked, /Cable: 10 m on hand, 12 m on this invoice/);
  // What the invoice already took is still its own when it's edited.
  app.settleStock('INV-1', cable(8));
  asked = '';
  assert.equal(app.stockOkToSave(entry('INV-1', 10)), true);
  assert.equal(asked, '');
  // Quotes never take stock.
  assert.equal(app.stockOkToSave({ inv: { number: 'QUO-1', type: 'quote', items: cable(99) } }), true);
});

test('numbers from spreadsheets in any format', () => {
  const app = loadApp();
  assert.equal(app.parseNumber('R1,200.50'), 1200.5);
  assert.equal(app.parseNumber('1 200,5'), 1200.5);
  assert.equal(app.parseNumber('1.200,50'), 1200.5);
  assert.equal(app.parseNumber('1,200'), 1200);
  assert.equal(app.parseNumber('-45'), -45);
  assert.equal(app.parseNumber(''), undefined);
  assert.equal(app.parseNumber('n/a'), undefined);
});

test('CSV: quotes, commas, semicolons, line breaks and a BOM', () => {
  const app = loadApp();
  assert.deepEqual(plain(app.parseCsv('a,b\r\n"x, y","say ""hi"""\n\n')), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(plain(app.parseCsv('﻿Code;Item\nDR-1;Door')), [['Code', 'Item'], ['DR-1', 'Door']]);
  assert.deepEqual(plain(app.parseCsv('Item,Notes\nDoor,"two\nlines"')), [['Item', 'Notes'], ['Door', 'two\nlines']]);
});

test('importing a stock list: updates, new items, counts and skipped rows', () => {
  const app = loadApp({ today: '2026-11-27' });
  app.set({ settings: {}, stock: [{ id: 'a', sku: 'DR-1', name: 'Door', prices: { ZAR: 1200 } }], stockMoves: [] });
  const csv = 'Code,Item,Price ZAR,On hand\nDR-1,Door,1300,5\n,Hinge,25,100\nDR-1,Door again,1,1\nXX-9,,5,\n';
  const plan = app.planImport(app.csvRows(app.parseCsv(csv), 'ZAR'), true);
  assert.deepEqual(plain(plan.map(p => p.status)), ['update', 'new', 'skip', 'skip']);
  assert.deepEqual(plain(plan[0].changes), ['ZAR price']);
  assert.deepEqual(plain(plan[0].count), { from: 0, to: 5 });
  assert.match(plan[2].why, /earlier in the file/);
  assert.match(plan[3].why, /No item has code XX-9/);

  assert.deepEqual(plain(app.applyImport(plan, 'test.csv')), { added: 1, updated: 1, counted: 2 });
  assert.equal(app.stock[0].prices.ZAR, 1300);
  assert.equal(app.onHand('a'), 5);
  const hinge = app.stock.find(s => s.name === 'Hinge');
  assert.equal(hinge.prices.ZAR, 25);
  assert.equal(app.onHand(hinge.id), 100);
  assert.ok(app.stockMoves.every(m => m.why === 'opening'));
});

test('a row with the same name but a different code is a new item', () => {
  const app = loadApp();
  app.set({ settings: {}, stock: [{ id: 'a', sku: 'DR-1', name: 'Door', prices: {} }], stockMoves: [] });
  const plan = app.planImport([{ line: 2, sku: 'DR-2', name: 'Door', prices: {} }], false);
  assert.equal(plan[0].status, 'new');
});
