// account.js: what your role in a team allows, and merging your team's changes into what's on screen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness');

const team = can => ({ team: { name: 'Acme', role: 'member', can } });

test('outside a team you can do everything; in one, only what your role allows', () => {
  const a = loadApp();
  assert.equal(a.can('manageTeam'), true);
  a.set({ teamState: team({ createInvoices: true, reports: false }) });
  assert.equal(a.can('createInvoices'), true);
  assert.equal(a.can('reports'), false);
  assert.equal(a.can('markPaid'), false, 'a right that isn\'t listed is not allowed');
});

test('the same data in any key order counts as unchanged', () => {
  const a = loadApp();
  assert.equal(a.same({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }), true);
  assert.equal(a.same({ a: 1, gone: undefined }, { a: 1 }), true);
  assert.equal(a.same([1, 2], [2, 1]), false);
});

test('merging a list: their changes, your changes, and what was added or deleted', () => {
  const a = loadApp();
  const before = [{ id: 1, v: 'old' }, { id: 2, v: 'old' }, { id: 3, v: 'old' }, { id: 4, v: 'old' }, { id: 5, v: 'old' }];
  const mine = [
    { id: 1, v: 'old' },     // untouched here: theirs wins
    { id: 2, v: 'mine' },    // changed here: mine is kept (and uploaded next)
    { id: 3, v: 'old' },     // deleted by them, untouched here: goes
    { id: 4, v: 'mine' },    // deleted by them, but changed here: kept
    { id: 6, v: 'new' },     // added here: kept
  ];                         // 5: deleted here: stays deleted
  const theirs = [{ id: 1, v: 'theirs' }, { id: 2, v: 'theirs' }, { id: 5, v: 'old' }, { id: 7, v: 'theirs' }];
  const merged = plain(a.mergeList(mine, before, theirs, x => x.id));
  assert.deepEqual(merged, [{ id: 1, v: 'theirs' }, { id: 2, v: 'mine' }, { id: 7, v: 'theirs' }, { id: 4, v: 'mine' }, { id: 6, v: 'new' }]);
});

function synced() {
  const a = loadApp({ today: '2026-11-27' });
  const c = { id: 'c1', company: 'Northwind', currency: 'GBP', dueDays: 14, items: [] };
  const inv = n => ({ id: n, inv: { number: n, clientId: 'c1', date: '2026-11-01' }, c, total: 100, savedAt: `2026-11-0${n.slice(-1)}T10:00:00Z` });
  const settings = { prefix: 'INV-', nextNumber: 1, me: { name: 'Me' }, taxLabel: 'VAT' };
  a.set({ clients: [c], invoices: [inv('INV-1')], settings: { ...settings }, stock: [], stockMoves: [] });
  a.run('Object.assign(base, clone({ clients, invoices, settings, stock, stockmoves: stockMoves }))');
  a.set({ draft: a.newDraft('c1') });
  return { a, inv, settings };
}

test('an invoice saved by someone else arrives, and the draft moves on to a free number', () => {
  const { a, inv } = synced();
  assert.equal(a.draft.number, 'INV-2');
  a.mergeRemote({ kinds: ['invoices'], data: { invoices: [{ ...inv('INV-2'), savedBy: 'sam@example.com' }, inv('INV-1')] } });
  assert.deepEqual(plain(a.invoices.map(h => h.inv.number)), ['INV-2', 'INV-1'], 'newest first');
  assert.equal(a.draft.number, 'INV-3');
  assert.equal(a.settings.nextNumber, 3);
});

test('settings: their changes come in, yours and your draft stay', () => {
  const { a, settings } = synced();
  a.settings.taxLabel = 'GST'; // changed here, not saved yet
  const draft = a.settings.draft = { number: 'INV-2', items: [] };
  a.mergeRemote({ kinds: ['settings'], data: { settings: { ...settings, prefix: 'NW-', taxLabel: 'VAT' } } });
  assert.equal(a.settings.prefix, 'NW-', 'their change');
  assert.equal(a.settings.taxLabel, 'GST', 'yours, uploaded next');
  assert.equal(a.settings.draft.number, draft.number, 'the draft is never shared');
});

test('a client someone else edited comes in with its lines tidied', () => {
  const { a } = synced();
  a.mergeRemote({ kinds: ['clients'], data: { clients: [{ id: 'c1', company: 'Northwind Ltd', currency: 'GBP', dueDays: 30, items: [{ kind: 'days', qty: 2 }] }] } });
  assert.equal(a.clients[0].company, 'Northwind Ltd');
  assert.equal(a.clients[0].items[0].desc, '', 'normItem fills in the missing fields');
});
