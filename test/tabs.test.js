// The New invoice tab (editor.js), Clients (clients.js) and History (history.js), and how they load.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadApp, plain } = require('./harness');

const client = { id: 'c1', company: 'Northwind', currency: 'GBP', dueDays: 14, hourlyRate: 40, dailyRate: 300, dayOffRate: '', items: [] };
const other = { id: 'c2', company: 'Contoso', currency: 'ZAR', dueDays: 30, hourlyRate: 500, dailyRate: 4000, dayOffRate: '', items: [] };
// A saved History entry for Northwind: saved(n, { inv: { … } }) changes the invoice itself, anything else the entry.
const saved = (number, { inv: fields = {}, ...rest } = {}) => ({
  id: number, inv: { number, clientId: 'c1', date: '2026-11-01', due: '2026-11-15', period: '2026-11', items: [{ kind: 'days', qty: 3, desc: 'Design' }], ...fields },
  c: { ...client }, me: {}, lines: [{ desc: 'Design', amount: 900 }], total: 900, tracked: true, paidAt: null, ...rest,
});
function app(invoices = []) {
  const a = loadApp({ today: '2026-11-27' });
  a.set({ clients: [client, other], invoices, settings: { prefix: 'INV-', nextNumber: 1 }, stock: [], stockMoves: [] });
  a.set({ draft: a.newDraft('c1') });
  return a;
}
const act = (a, action, id) => a.histAction({ target: { dataset: { act: action, id } } });

test('every script in app/ is loaded by the page, renderer.js before the tabs that use it', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const order = [...html.matchAll(/<script src="([\w-]+\.js)">/g)].map(m => m[1]);
  const files = fs.readdirSync(path.join(__dirname, '..', 'app')).filter(f => f.endsWith('.js'));
  assert.deepEqual(files.filter(f => !order.includes(f)), [], 'a file in app/ that index.html never loads');
  for (const f of ['editor.js', 'clients.js', 'history.js', 'reports.js', 'account.js', 'stock.js', 'dashboard.js', 'assistant.js', 'importer.js'])
    assert.ok(order.indexOf('renderer.js') < order.indexOf(f), `${f} loads after renderer.js`);
});

test('editing a saved invoice puts the draft aside, and cancelling brings it back', () => {
  const a = app([saved('INV-4')]);
  a.draft.items = [{ kind: 'hours', qty: 2, desc: 'Half-typed' }];
  a.editSaved(a.invoices[0]);
  assert.equal(a.draft.editing, 'INV-4');
  assert.equal(a.draft.number, 'INV-4');
  assert.equal(a.draft.items[0].desc, 'Design');
  assert.equal(a.settings.putAside.items[0].desc, 'Half-typed');
  a.restoreDraft();
  assert.equal(a.draft.editing, undefined);
  assert.equal(a.draft.number, 'INV-5');
  assert.equal(a.draft.items[0].desc, 'Half-typed');
  assert.equal(a.settings.putAside, undefined);
});

test('a paid invoice asks before editing, and saying no leaves the draft alone', () => {
  const a = app([saved('INV-4', { paidAt: '2026-11-20' })]);
  let asked = '';
  a.context.confirm = msg => { asked = msg; return false; };
  a.editSaved(a.invoices[0]);
  assert.match(asked, /INV-4 is marked as paid/);
  assert.equal(a.draft.editing, undefined);
});

test('leaving an edit you said to keep does nothing', () => {
  const a = app([saved('INV-4')]);
  a.editSaved(a.invoices[0]);
  a.context.confirm = () => false;
  assert.equal(a.leaveEditing(), false);
  assert.equal(a.draft.editing, 'INV-4');
});

test('Invoice now from Clients switches the draft to that client and keeps its number', () => {
  const a = app([saved('INV-4')]);
  a.invoiceClient('c2');
  assert.equal(a.draft.clientId, 'c2');
  assert.equal(a.draft.number, 'INV-5');
  assert.equal(a.draft.due, '2026-12-27', "Contoso's 30-day terms");
  // A quote being drafted becomes an invoice, since reminders are for invoices.
  a.set({ draft: a.newDraft('c1', 'quote') });
  a.invoiceClient('c1');
  assert.equal(a.draft.type, 'invoice');
});

test('Make invoice from a quote copies its lines and remembers the invoice', () => {
  const a = app([saved('QUO-2', { inv: { type: 'quote', items: [{ kind: 'days', qty: 5, desc: 'Build' }], discount: { pct: 10, reason: 'Early' } } })]);
  act(a, 'convert', 'QUO-2');
  assert.equal(a.draft.type, 'invoice');
  assert.equal(a.draft.number, 'INV-1');
  assert.equal(a.draft.items[0].desc, 'Build');
  assert.deepEqual(plain(a.draft.discount), { pct: 10, reason: 'Early' });
  assert.equal(a.invoices[0].convertedTo, 'INV-1');
  assert.equal(a.payStatus(a.invoices[0]).label, 'Invoiced (INV-1)');
});

test('Copy starts a new invoice with the same lines', () => {
  const a = app([saved('INV-4')]);
  act(a, 'copy', 'INV-4');
  assert.equal(a.draft.number, 'INV-5');
  assert.equal(a.draft.editing, undefined);
  assert.equal(a.draft.items[0].desc, 'Design');
});

test('Remove takes it out of History and puts its stock back', () => {
  const a = app([saved('INV-4')]);
  a.set({ stock: [{ id: 's1', name: 'Cable', unit: 'm' }], stockMoves: [{ id: 'm0', stockId: 's1', qty: 10, why: 'opening' }] });
  a.settleStock('INV-4', [{ kind: 'item', stockId: 's1', qty: 4 }]);
  assert.equal(a.onHand('s1'), 6);
  act(a, 'del', 'INV-4');
  assert.equal(a.invoices.length, 0);
  assert.equal(a.onHand('s1'), 10);
});

test('saving a quote again keeps the paid dates of lines that are unchanged', () => {
  const a = app();
  const prev = { paidSteps: { 0: '2026-11-01', 1: '2026-11-05' }, lines: [{ desc: 'Design', amount: 900 }, { desc: 'Build', amount: 600 }] };
  // Build's amount changed, and a line was added before it: only Design keeps its date.
  const lines = [{ desc: 'Design', amount: 900 }, { desc: 'Extra', amount: 50 }, { desc: 'Build', amount: 700 }];
  assert.deepEqual(plain(a.carryPaidSteps(prev, lines)), { 0: '2026-11-01' });
  assert.equal(a.carryPaidSteps({ lines: prev.lines }, lines), null);
});

test('in a team, a number someone just took moves this invoice to the next free one', async () => {
  const a = app([saved('INV-4')]);
  const tried = [];
  a.run('store').teamClaimInvoice = async entry => {
    tried.push(entry.inv.number);
    return entry.inv.number === 'INV-5' ? { ok: false, by: 'sam@example.com' } : { ok: true };
  };
  const entry = { inv: { number: 'INV-5' } };
  assert.equal(await a.claimNumber(entry), true);
  assert.deepEqual(tried, ['INV-5', 'INV-6']);
  assert.equal(entry.inv.number, 'INV-6');
  assert.equal(a.draft.number, 'INV-6');
});

test('marking quote steps paid, one at a time and all at once', () => {
  const q = saved('QUO-2', { inv: { type: 'quote' }, total: 1500, lines: [{ desc: 'Design', amount: 900 }, { desc: 'Build', amount: 600 }] });
  const a = app([q]);
  a.setStepPaid('QUO-2', 1, true);
  assert.deepEqual(plain(a.invoices[0].paidSteps), { 1: '2026-11-27' });
  a.setAllStepsPaid('QUO-2', true);
  assert.equal(a.payStatus(a.invoices[0]).label, 'Paid in full');
  a.setAllStepsPaid('QUO-2', false);
  assert.equal(a.invoices[0].paidSteps, undefined);
});
