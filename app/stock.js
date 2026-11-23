// Stock (from 1.25.0): the Stock tab, adding stock to quotes and invoices, and importing it.
// Loaded after renderer.js, whose helpers ($, esc, money, persist, draft, teamState…) it uses.
//
// stock: the items you sell, { id, name, sku, unit, category, supplier, cost, costCurrency,
//   prices: { ZAR: 1200, GBP: 50 } (a price in each currency you bill in), lowAt, notes, removed, wooId }.
// stockMoves: every change to a count, { id, stockId, qty (+ in / − out), at, why, invoice, note, by },
//   never changed once made. What's on hand is the sum of an item's moves, so two people saving
//   invoices at the same time (in a team) never clash over a count.
// Saving an invoice (not a quote) takes its stock lines off; saving it again after an edit moves only
// the difference; removing it from History puts them back. Removing an item keeps it ("removed"), so
// old invoices and its history still make sense.
const MOVE_WHY = { opening: 'Opening stock', received: 'Received', removed: 'Taken out', count: 'Counted', invoice: 'Invoice', returned: 'Back from invoice' };
const round3 = n => Math.round(n * 1000) / 1000;
const stockItem = id => stock.find(s => s.id === id);
const onHand = id => round3(stockMoves.filter(m => m.stockId === id).reduce((t, m) => t + num(m.qty), 0));
const qtyText = (q, it) => `${round3(q)}${it && it.unit ? ' ' + it.unit : ''}`;
const priceIn = (it, cur) => { const v = it && it.prices ? it.prices[curCode(cur || '')] : ''; return v === '' || v == null ? null : num(v); };
const liveItems = () => stock.filter(s => !s.removed);
const hasLowLevel = s => s.lowAt !== '' && s.lowAt != null;
const isLow = (s, left = onHand(s.id)) => hasLowLevel(s) && left <= num(s.lowAt);
const stockMatches = (s, q) => !q || [s.name, s.sku, s.category, s.supplier].some(v => String(v || '').toLowerCase().includes(q));
const myEmail = () => (teamState.team && teamState.me) || '';
const csvCell = v => /[",\r\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
let liveStockRows = []; // the rows under stock lines on the invoice being drafted (renderItems resets it)
const refreshStockRows = () => liveStockRows.forEach(r => r.update());

function addMove(stockId, qty, why, extra = {}) {
  const m = { id: uid(), stockId, qty: round3(qty), at: new Date().toISOString(), why, ...extra };
  if (myEmail()) m.by = myEmail();
  stockMoves.push(m);
  return m;
}
// Redraws whatever shows stock after a change to items or counts.
function stockChanged(...names) {
  names.forEach(persist);
  if (tabShown('stock')) renderStock();
  refreshStockRows();
}

// ---------- invoices taking stock ----------
// How much of each item an invoice has taken so far (by its number), from its moves.
function takenBy(number) {
  const out = {};
  for (const m of stockMoves) if (m.invoice === number && (m.why === 'invoice' || m.why === 'returned')) out[m.stockId] = round3((out[m.stockId] || 0) - num(m.qty));
  return out;
}
function wantedBy(items) {
  const out = {};
  for (const it of items || []) if (it.stockId && it.kind === 'item' && num(it.qty) > 0) out[it.stockId] = round3((out[it.stockId] || 0) + num(it.qty));
  return out;
}
// Brings an invoice's stock moves in line with its lines (items: [] puts everything back).
// Returns what changed, e.g. "3 m Cable, 1 Door", or '' when nothing did.
function settleStock(number, items) {
  const had = takenBy(number), want = wantedBy(items), changes = [];
  for (const id of new Set([...Object.keys(had), ...Object.keys(want)])) {
    const diff = round3((want[id] || 0) - (had[id] || 0));
    if (!diff) continue;
    addMove(id, -diff, diff > 0 ? 'invoice' : 'returned', { invoice: number });
    const s = stockItem(id);
    changes.push(`${qtyText(Math.abs(diff), s)} ${s ? s.name : 'item'}`);
  }
  if (changes.length) stockChanged('stockmoves');
  return changes.join(', ');
}
// Before saving an invoice: says which items it would take below zero, and asks.
function stockOkToSave(entry) {
  if (docType(entry) !== 'invoice') return true;
  const had = takenBy(entry.inv.number), want = wantedBy(entry.inv.items), short = [];
  for (const [id, q] of Object.entries(want)) {
    const s = stockItem(id), left = onHand(id) + (had[id] || 0); // what this invoice already took is still its own
    if (s && q > left) short.push(`${s.name}: ${qtyText(Math.max(0, left), s)} on hand, ${qtyText(q, s)} on this invoice`);
  }
  return !short.length || confirm(`Not enough stock:\n\n${short.join('\n')}\n\nSave the invoice anyway? The stock count goes below zero until you add more.`);
}

// The row under a stock line on the invoice: its code and what's on hand.
function stockLineRow(it) {
  const el = document.createElement('div'); el.className = 'stock-row';
  const update = () => {
    const s = stockItem(it.stockId);
    if (!s) { el.textContent = '📦 This stock item isn\'t on this computer'; return; }
    const own = draft.editing ? takenBy(draft.editing)[s.id] || 0 : 0, left = round3(onHand(s.id) + own);
    const quote = draft.type === 'quote', short = !quote && num(it.qty) > left;
    const notes = [short ? 'not enough' : isLow(s, left) ? 'low' : '', s.removed ? 'removed from stock' : ''].filter(Boolean);
    el.classList.toggle('short', short);
    el.innerHTML = `📦 ${s.sku ? `<b>${esc(s.sku)}</b> · ` : ''}${esc(qtyText(left, s))} ${own ? `available (${esc(qtyText(own, s))} already on this invoice)` : 'on hand'}`
      + notes.map(n => ` · ${esc(n)}`).join('') + (quote ? ' <span class="muted">(quotes don\'t take stock)</span>' : '');
  };
  update();
  const row = { el, update };
  liveStockRows.push(row);
  return row;
}

// ---------- adding from stock (the picker on the invoice) ----------
function openStockPicker() {
  const c = client(draft.clientId) || {};
  if (!liveItems().length) {
    const edit = can('editStock');
    toast(edit ? 'Add your stock items on the Stock tab first' : 'There are no stock items yet', edit ? 'Stock' : '', edit ? () => go('stock') : null);
    return;
  }
  $('#stock-dlg-cur').textContent = `Prices in ${curCode(c.currency || '')}. Type to search, Enter adds the first match.`;
  $('#stock-dlg-q').value = '';
  renderStockPicker();
  $('#stock-dlg').showModal();
  $('#stock-dlg-q').focus();
}
function renderStockPicker() {
  const c = client(draft.clientId) || {}, q = $('#stock-dlg-q').value.trim().toLowerCase();
  const list = liveItems().filter(s => stockMatches(s, q)).sort((a, b) => a.name.localeCompare(b.name));
  $('#stock-dlg-list').innerHTML = list.length ? list.map(s => {
    const p = priceIn(s, c.currency), left = onHand(s.id);
    return `<button type="button" data-pick="${esc(s.id)}"><span class="pick-name">${esc(s.name)}<small>${esc([s.sku, s.category].filter(Boolean).join(' · '))}</small></span>
      <span class="pick-qty${left <= 0 ? ' none' : ''}">${esc(qtyText(left, s))}</span><span class="pick-price">${p == null ? '<span class="muted">No price</span>' : esc(money(p, c.currency))}</span></button>`;
  }).join('') : '<p class="muted">Nothing matches. Try part of the name, code, category or supplier.</p>';
}
function addStockLine(id) {
  const s = stockItem(id), c = client(draft.clientId) || {}; if (!s) return;
  const p = priceIn(s, c.currency);
  // An empty line (a new invoice's blank Fixed line) makes way for it.
  const blank = draft.items.length === 1 && draft.items[0].kind === 'fixed' && !draft.items[0].desc.trim() && !num(draft.items[0].amount);
  if (blank) draft.items = [];
  draft.items.push(normItem({ kind: 'item', desc: s.name, qty: 1, price: p ?? 0, stockId: s.id, sku: s.sku, unit: s.unit }));
  $('#stock-dlg').close();
  renderItems(); changed();
  $$('#inv-items input[type=number]').filter(el => el.step === '0.25').pop()?.select(); // the new line's quantity
  if (p == null) toast(`${s.name} has no price in ${curCode(c.currency || '')}. Type one in on the line.`);
}
$('#add-stock').onclick = openStockPicker;
$('#stock-dlg-q').oninput = renderStockPicker;
$('#stock-dlg-q').onkeydown = e => {
  if (e.key === 'Enter') { const b = $('#stock-dlg-list [data-pick]'); if (b) { e.preventDefault(); addStockLine(b.dataset.pick); } }
  if (e.key === 'ArrowDown') { e.preventDefault(); $('#stock-dlg-list [data-pick]')?.focus(); }
};
$('#stock-dlg-list').onkeydown = e => {
  const b = e.target.closest('[data-pick]'); if (!b) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); b.nextElementSibling?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); (b.previousElementSibling || $('#stock-dlg-q')).focus(); }
};
$('#stock-dlg-list').onclick = e => { const b = e.target.closest('[data-pick]'); if (b) addStockLine(b.dataset.pick); };
$('#stock-dlg-cancel').onclick = () => $('#stock-dlg').close();

// ---------- the Stock tab ----------
let editingStock = null;
function initStock() {
  const cur = Object.keys(CURRENCIES);
  $('#st-prices').innerHTML = cur.map(k => `<div><label for="st-price-${k}">Price in ${k} (${esc(curSymbol(k))})</label><input id="st-price-${k}" data-price="${k}" type="number" step="0.01" min="0" placeholder="Not sold in ${k}"></div>`).join('');
  $('[data-st="costCurrency"]').innerHTML = cur.map(k => `<option value="${k}">${k}</option>`).join('');
  $('#imp-cur').innerHTML = cur.map(k => `<option value="${k}">${k} (${esc(curSymbol(k))})</option>`).join('');
  $('#st-show-sku').checked = settings.stockShowSku !== false;
  $$('[data-price]').forEach(el => el.oninput = () => {
    const s = stockItem(editingStock); if (!s) return;
    s.prices ||= {};
    if (el.value === '') delete s.prices[el.dataset.price]; else s.prices[el.dataset.price] = Number(el.value);
    persist('stock'); renderStockList();
  });
  $$('[data-st]').forEach(el => el.oninput = () => {
    const s = stockItem(editingStock); if (!s) return;
    const k = el.dataset.st;
    s[k] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    persist('stock'); renderStockList();
    if (k === 'unit' || k === 'sku') refreshStockLines(s);
    if (k === 'unit') $('#st-adj-unit').textContent = s.unit || '';
    if (k === 'name') $('#st-title').textContent = s.name || 'Stock item';
    if (k === 'lowAt') renderOnHand(s);
  });
}
const usualCurrency = () => {
  const n = {};
  for (const c of clients) { const k = curCode(c.currency); n[k] = (n[k] || 0) + 1; }
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || 'GBP';
};
// A changed code or unit shows on the lines being drafted straight away (saved invoices keep theirs).
function refreshStockLines(s) {
  let hit = false;
  for (const it of draft.items) if (it.stockId === s.id) { it.sku = s.sku || ''; it.unit = s.unit || ''; hit = true; }
  if (hit) { renderItems(); changed(); }
}
function renderStockSync() {
  const el = $('#st-sync'); if (!el) return;
  const msg = (teamState.team && teamState.stockError) || (!teamState.team && cloudState.signedIn && cloudState.stockError) || '';
  el.hidden = !msg; el.textContent = msg;
}
function renderStock() {
  const edit = can('editStock');
  $('#st-new').hidden = !edit;
  $('#st-import-box').hidden = !edit;
  $('#st-locked').hidden = edit;
  $('#st-locked').textContent = teamState.team ? `As ${aRole(teamState.team.role)}, you can see ${teamState.team.name}'s stock and add it to invoices and quotes. Only an admin adds items, changes prices, updates counts or imports.` : '';
  const cats = [...new Set(stock.map(s => s.category).filter(Boolean))].sort();
  const sel = $('#st-cat'), was = sel.value;
  sel.innerHTML = '<option value="">All categories</option>' + cats.map(c => `<option>${esc(c)}</option>`).join('');
  sel.value = cats.includes(was) ? was : '';
  sel.hidden = !cats.length;
  $('#st-cats').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
  $('#st-sups').innerHTML = [...new Set(stock.map(s => s.supplier).filter(Boolean))].sort().map(c => `<option value="${esc(c)}">`).join('');
  renderStockSync();
  renderStockList();
  renderStockForm();
  if (edit) renderWoo();
}
function renderStockList() {
  const q = $('#st-search').value.trim().toLowerCase(), cat = $('#st-cat').value;
  const lowOnly = $('#st-low').checked, showRemoved = $('#st-removed').checked;
  const list = stock.filter(s => (showRemoved || !s.removed) && (!cat || s.category === cat) && (!lowOnly || isLow(s)) && stockMatches(s, q))
    .sort((a, b) => (a.removed ? 1 : 0) - (b.removed ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  const live = liveItems().length;
  $('#st-count').textContent = live ? `${live} item${live === 1 ? '' : 's'}${list.length !== live ? `, ${list.length} shown` : ''}` : '';
  $('#st-empty').hidden = list.length > 0;
  $('#st-empty').textContent = !stock.length ? (can('editStock') ? 'No stock items yet. Click "+ New item", or import them from a spreadsheet or your WooCommerce shop below.' : 'No stock items yet.') : 'Nothing matches.';
  $('#st-table').hidden = !list.length;
  $('#st-list').innerHTML = list.map(s => {
    const prices = Object.entries(s.prices || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => money(v, k)).join(' · ');
    const left = onHand(s.id), low = isLow(s, left);
    return `<tr data-id="${esc(s.id)}" tabindex="0" class="${s.id === editingStock ? 'on' : ''}${s.removed ? ' removed' : ''}">
      <td>${esc(s.sku || '')}</td><td>${esc(s.name)}${s.category ? `<div class="muted">${esc(s.category)}</div>` : ''}</td>
      <td class="num${left <= 0 ? ' none' : low ? ' low' : ''}">${esc(qtyText(left, s))}${low ? ' <span class="status unpaid">Low</span>' : ''}</td>
      <td class="num">${prices ? esc(prices) : '<span class="muted">–</span>'}</td></tr>`;
  }).join('');
  // What the stock on hand cost you, per currency.
  const value = {};
  for (const s of liveItems()) { const left = onHand(s.id), k = s.costCurrency || 'GBP'; if (left > 0 && num(s.cost)) value[k] = (value[k] || 0) + left * num(s.cost); }
  const parts = Object.entries(value).map(([k, v]) => money(v, k));
  $('#st-value').textContent = parts.length ? `Stock on hand at cost: ${parts.join(' + ')}` : '';
}
function renderOnHand(s) {
  const left = onHand(s.id), low = isLow(s, left);
  $('#st-onhand').textContent = `${qtyText(left, s)} on hand${low ? ', at or below your low stock level' : ''}`;
  $('#st-onhand').className = 'drive-status' + (left < 0 ? ' err' : low ? ' warn' : ' on');
}
function renderStockForm() {
  const s = stockItem(editingStock);
  $('#st-form').hidden = !s;
  if (!s) return;
  const edit = can('editStock'), locked = !edit || !!s.removed;
  $$('[data-st]').forEach(el => { setVal(el, s[el.dataset.st] ?? ''); el.disabled = locked; });
  $$('[data-price]').forEach(el => { setVal(el, s.prices && s.prices[el.dataset.price] != null ? s.prices[el.dataset.price] : ''); el.disabled = locked; });
  $('#st-title').textContent = s.name || 'Stock item';
  $('#st-from-woo').hidden = !s.wooId;
  renderOnHand(s);
  $('#st-adjust').hidden = locked;
  $('#st-adj-unit').textContent = s.unit || '';
  adjPlaceholder();
  $('#st-remove').hidden = !edit || !!s.removed;
  $('#st-restore').hidden = !edit || !s.removed;
  const moves = stockMoves.filter(m => m.stockId === s.id).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  $('#st-moves-empty').hidden = moves.length > 0;
  $('#st-moves').hidden = !moves.length;
  $('#st-moves tbody').innerHTML = moves.slice(0, 200).map(m => {
    const why = esc(MOVE_WHY[m.why] || m.why);
    const what = m.invoice ? `${why} <button class="link" data-inv="${esc(m.invoice)}">${esc(m.invoice)}</button>` : why;
    return `<tr><td>${esc(String(m.at).slice(0, 10))}</td><td>${what}${m.note ? `<div class="muted">${esc(m.note)}</div>` : ''}${m.by ? `<div class="muted">by ${esc(m.by.split('@')[0])}</div>` : ''}</td>
      <td class="num ${num(m.qty) < 0 ? 'out' : 'in'}">${num(m.qty) > 0 ? '+' : ''}${esc(qtyText(m.qty, s))}</td></tr>`;
  }).join('');
}
const adjPlaceholder = () => { $('#st-adj-qty').placeholder = $('#st-adj-kind').value === 'count' ? 'Counted' : 'How many'; };
function pickStock(id) { editingStock = id; renderStockList(); renderStockForm(); }
$('#st-search').oninput = renderStockList;
$('#st-cat').onchange = renderStockList;
$('#st-low').onchange = renderStockList;
$('#st-removed').onchange = renderStockList;
$('#st-list').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) pickStock(tr.dataset.id); };
$('#st-list').onkeydown = e => { const tr = e.target.closest('tr[data-id]'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickStock(tr.dataset.id); } };
$('#st-moves').onclick = e => {
  const n = e.target.dataset.inv; if (!n) return;
  go('history');
  if (!invoices.some(x => x.inv.number === n)) toast(`${n} isn't in your History${teamState.team && !can('seeAllInvoices') ? ' (it was made by someone else in your team)' : ''}.`);
};
const newStockItem = fields => ({ id: uid(), name: '', sku: '', unit: '', category: '', supplier: '', cost: '', costCurrency: usualCurrency(), prices: {}, lowAt: '', notes: '', createdAt: new Date().toISOString(), ...fields });
$('#st-new').onclick = () => {
  const s = newStockItem({ name: 'New item' });
  stock.push(s); editingStock = s.id; persist('stock');
  $('#st-search').value = ''; $('#st-low').checked = false; $('#st-cat').value = '';
  renderStock();
  $('#st-adj-kind').value = 'count'; adjPlaceholder();
  $('[data-st="name"]').select();
};
$('#st-adj').onclick = () => {
  const s = stockItem(editingStock); if (!s) return;
  const kind = $('#st-adj-kind').value, v = parseFloat($('#st-adj-qty').value), note = $('#st-adj-note').value.trim();
  if (isNaN(v) || v < 0 || (kind !== 'count' && v === 0)) { toast(kind === 'count' ? 'Type how many you counted' : 'Type how many'); $('#st-adj-qty').focus(); return; }
  const first = !stockMoves.some(m => m.stockId === s.id);
  const qty = kind === 'received' ? v : kind === 'removed' ? -v : round3(v - onHand(s.id));
  if (!qty) { toast(`${s.name} is already at ${qtyText(v, s)}`); return; }
  addMove(s.id, qty, first && kind !== 'removed' ? 'opening' : kind, note ? { note } : {});
  $('#st-adj-qty').value = ''; $('#st-adj-note').value = '';
  stockChanged('stockmoves');
  toast(`${s.name}: ${qtyText(onHand(s.id), s)} on hand`);
};
$('#st-adj-qty').onkeydown = e => { if (e.key === 'Enter') $('#st-adj').click(); };
$('#st-adj-kind').onchange = adjPlaceholder;
$('#st-remove').onclick = () => {
  const s = stockItem(editingStock); if (!s) return;
  if (!confirm(`Remove ${s.name} from your stock?\n\nIt's no longer offered on new invoices and quotes. Invoices that already have it, and its stock history, are kept, and you can bring it back with "Show removed items".`)) return;
  s.removed = true; stockChanged('stock');
  toast(`${s.name} removed from stock`);
};
$('#st-restore').onclick = () => {
  const s = stockItem(editingStock); if (!s) return;
  delete s.removed; stockChanged('stock');
  toast(`${s.name} is back in your stock`);
};
$('#st-show-sku').onchange = e => { settings.stockShowSku = e.target.checked; persist('settings'); renderItems(); refreshPreview(); };

// ---------- export ----------
const CSV_COLUMNS = () => ['Code', 'Item', 'Category', 'Supplier', 'Unit', 'On hand', 'Low stock level', 'Cost', 'Cost currency', ...Object.keys(CURRENCIES).map(k => `Price ${k}`), 'Notes'];
function downloadCsv(rows, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' }));
  a.download = name;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$('#st-csv').onclick = () => {
  const cur = Object.keys(CURRENCIES);
  downloadCsv([CSV_COLUMNS(), ...liveItems().map(s => [s.sku || '', s.name, s.category || '', s.supplier || '', s.unit || '', onHand(s.id), s.lowAt ?? '', s.cost ?? '', s.costCurrency || '',
    ...cur.map(k => s.prices && s.prices[k] != null ? s.prices[k] : ''), s.notes || ''])], `Invaro stock - ${todayIso()}.csv`);
};
$('#st-template').onclick = () => downloadCsv([CSV_COLUMNS(), ['DR-200', 'Interior door', 'Doors', 'Acme Timber', 'each', 10, 2, 650, usualCurrency(), ...Object.keys(CURRENCIES).map(k => k === usualCurrency() ? 1200 : ''), '']], 'Invaro stock template.csv');

// ---------- importing (a spreadsheet, or your WooCommerce shop) ----------
// Both turn into rows of { line, wooId, sku, name, unit, category, supplier, cost, costCurrency, prices, lowAt, notes, onHand },
// where a field that's missing or blank leaves the item's own value as it is.
// A row is matched to an item by its WooCommerce product, then its code, then its name (for an item or a
// row without a code); anything else is a new item. You see what will change before anything does.
function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const outside = first.replace(/"[^"]*"/g, '');
  const delim = [',', ';', '\t'].map(d => [d, outside.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
// "R1,200.50" → 1200.5, "1 200,5" → 1200.5, "" → undefined
function parseNumber(v) {
  let s = String(v ?? '').replace(/[^\d.,\-]/g, '');
  if (!/\d/.test(s)) return undefined;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (/,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return isNaN(n) ? undefined : n;
}
const HEADERS = {
  sku: ['code', 'sku', 'itemcode', 'productcode', 'stockcode', 'partnumber', 'partno'],
  name: ['item', 'name', 'itemname', 'product', 'productname', 'title'],
  category: ['category', 'categories', 'group'],
  supplier: ['supplier', 'vendor', 'brand'],
  unit: ['unit', 'units', 'uom'],
  onHand: ['onhand', 'quantity', 'qty', 'stock', 'stockquantity', 'stocklevel', 'instock', 'count', 'qtyonhand'],
  lowAt: ['lowstocklevel', 'lowstock', 'lowat', 'reorderlevel', 'reorderpoint', 'minimum', 'minstock'],
  cost: ['cost', 'costprice', 'buyprice', 'purchaseprice', 'unitcost'],
  costCurrency: ['costcurrency'],
  notes: ['notes', 'note'],
  price: ['price', 'sellingprice', 'saleprice', 'regularprice', 'retailprice', 'unitprice'],
};
// Works out what each column is. Returns { cols: [{ i, field, cur }], plainPrice, unknown: [header] }.
function csvColumns(header) {
  const cols = [], unknown = []; let plainPrice = false;
  header.forEach((h, i) => {
    const k = String(h).toLowerCase().replace(/[^a-z]/g, '');
    if (!k) return;
    const cur = Object.keys(CURRENCIES).find(c => k === 'price' + c.toLowerCase() || k === c.toLowerCase() + 'price' || k === 'sellingprice' + c.toLowerCase());
    if (cur) return cols.push({ i, field: 'price', cur });
    const field = Object.keys(HEADERS).find(f => HEADERS[f].includes(k));
    if (!field) return unknown.push(h);
    if (cols.some(c => c.field === field && field !== 'price')) return; // the first of two alike columns
    if (field === 'price') plainPrice = true;
    cols.push({ i, field });
  });
  return { cols, plainPrice, unknown };
}
function csvRows(table, priceCur) {
  const { cols } = csvColumns(table[0]);
  return table.slice(1).map((cells, n) => {
    const r = { line: n + 2, prices: {} };
    for (const c of cols) {
      const v = String(cells[c.i] ?? '').trim();
      if (v === '') continue;
      if (c.field === 'price') { const p = parseNumber(v); if (p !== undefined) r.prices[c.cur || priceCur] = p; }
      else if (['onHand', 'lowAt', 'cost'].includes(c.field)) { const p = parseNumber(v); if (p !== undefined) r[c.field] = p; }
      else if (c.field === 'costCurrency') { const k = v.toUpperCase(); if (CURRENCIES[k]) r.costCurrency = k; else r.costCurrency = curCode(v); }
      else r[c.field] = v;
    }
    return r;
  });
}
const FIELD_NAMES = { name: 'name', sku: 'code', unit: 'unit', category: 'category', supplier: 'supplier', cost: 'cost', costCurrency: 'cost currency', lowAt: 'low stock level', notes: 'notes' };
const matchKey = s => String(s || '').trim().toLowerCase();
// What an import would do, row by row: { rows: [{ r, item, status: new|update|same|skip, changes, count, why }] }
function planImport(rows, setCounts) {
  const byWoo = new Map(), bySku = new Map(), byName = new Map();
  // Live items first, so a removed duplicate never wins over the one in use.
  for (const s of [...liveItems(), ...stock.filter(x => x.removed)]) {
    if (s.wooId && !byWoo.has(s.wooId)) byWoo.set(s.wooId, s);
    if (s.sku && !bySku.has(matchKey(s.sku))) bySku.set(matchKey(s.sku), s);
    if (s.name && !byName.has(matchKey(s.name))) byName.set(matchKey(s.name), s);
  }
  const seen = new Map(), out = [];
  for (const r of rows) {
    let item = (r.wooId && byWoo.get(r.wooId)) || (r.sku && bySku.get(matchKey(r.sku))) || null;
    if (!item && r.name) { const n = byName.get(matchKey(r.name)); if (n && (!r.sku || !n.sku)) item = n; } // same name, and no code to tell them apart
    const id = item ? item.id : r.wooId ? 'woo:' + r.wooId : r.sku ? 'sku:' + matchKey(r.sku) : 'name:' + matchKey(r.name);
    if (!item && !r.name) { out.push({ r, status: 'skip', why: r.sku ? `No item has code ${r.sku}, and there's no name to add it with` : 'No name or code' }); continue; }
    if (seen.has(id)) { out.push({ r, status: 'skip', why: `Same item as ${seen.get(id)}` }); continue; }
    seen.set(id, r.line ? `row ${r.line}` : r.name);
    const changes = [];
    if (item) {
      for (const f of Object.keys(FIELD_NAMES)) if (r[f] !== undefined && r[f] !== '' && String(r[f]) !== String(item[f] ?? '')) changes.push(FIELD_NAMES[f]);
      for (const [k, v] of Object.entries(r.prices || {})) if (num(v) !== (item.prices && item.prices[k] != null ? num(item.prices[k]) : null)) changes.push(`${k} price`);
      if (item.removed) changes.push('back in stock');
    }
    let count = null;
    if (setCounts && r.onHand !== undefined && r.onHand !== null) {
      const from = item ? onHand(item.id) : 0;
      if (round3(r.onHand) !== from || (!item && r.onHand)) count = { from, to: round3(r.onHand) };
    }
    out.push({ r, item, status: !item ? 'new' : changes.length || count || (r.wooId && item.wooId !== r.wooId) ? 'update' : 'same', changes, count });
  }
  return out;
}
function applyImport(plan, source) {
  let added = 0, updated = 0, counted = 0;
  for (const p of plan) {
    if (p.status === 'skip' || p.status === 'same') continue;
    const { r } = p;
    let s = p.item;
    if (!s) {
      s = newStockItem({ name: r.name });
      stock.push(s); added++;
    } else updated++;
    for (const f of Object.keys(FIELD_NAMES)) if (r[f] !== undefined && r[f] !== '') s[f] = r[f];
    if (Object.keys(r.prices || {}).length) s.prices = { ...(s.prices || {}), ...r.prices };
    if (r.wooId) s.wooId = r.wooId;
    delete s.removed;
    if (p.count) {
      const qty = round3(p.count.to - (p.item ? onHand(s.id) : 0));
      if (qty) { addMove(s.id, qty, !p.item || !stockMoves.some(m => m.stockId === s.id) ? 'opening' : 'count', { note: source }); counted++; }
    }
  }
  stockChanged('stock', 'stockmoves');
  return { added, updated, counted };
}

// The import preview. imp = { title, source, rows (from csv or the shop), note, setCounts: 'ask' | true, table? }
let imp = null;
function openImport(o) {
  imp = o;
  $('#imp-title').textContent = o.title;
  $('#imp-note').textContent = o.note || '';
  $('#imp-note').hidden = !o.note;
  $('#imp-cur-row').hidden = !o.table || !csvColumns(o.table[0]).plainPrice;
  $('#imp-cur').value = usualCurrency();
  $('#imp-counts-row').hidden = o.setCounts !== 'ask';
  $('#imp-counts').checked = true;
  renderImport();
  $('#imp-dlg').showModal();
}
function renderImport() {
  const rows = imp.table ? csvRows(imp.table, $('#imp-cur').value) : imp.rows;
  const setCounts = imp.setCounts === 'ask' ? $('#imp-counts').checked : !!imp.setCounts;
  imp.plan = planImport(rows, setCounts);
  const n = st => imp.plan.filter(p => p.status === st).length;
  const counts = imp.plan.filter(p => p.count).length;
  const parts = [[n('new'), 'new'], [n('update'), 'to update'], [n('same'), 'already the same'], [n('skip'), 'skipped']].filter(([v]) => v).map(([v, w]) => `${v} ${w}`);
  $('#imp-summary').textContent = imp.plan.length ? `${imp.plan.length} row${imp.plan.length === 1 ? '' : 's'}: ${parts.join(', ')}${counts ? `. ${counts} stock count${counts === 1 ? '' : 's'} change.` : '.'}` : 'There are no rows to import.';
  const order = { new: 0, update: 1, skip: 2, same: 3 };
  const shown = [...imp.plan].sort((a, b) => order[a.status] - order[b.status]).slice(0, 500);
  $('#imp-list').innerHTML = shown.map(p => {
    const name = p.item ? p.item.name : p.r.name || p.r.sku || '';
    const code = p.r.sku || (p.item && p.item.sku) || '';
    const what = p.status === 'new' ? 'New item' : p.status === 'skip' ? esc(p.why) : p.status === 'same' ? 'No change'
      : esc(p.changes.length ? 'Updates ' + p.changes.join(', ') : 'Linked to your shop');
    const unit = { unit: p.r.unit || (p.item && p.item.unit) || '' };
    const count = p.count ? `${esc(qtyText(p.count.from, unit))} → <b>${esc(qtyText(p.count.to, unit))}</b>` : '';
    return `<tr class="imp-${p.status}"><td>${esc(code)}</td><td>${esc(name)}${p.r.line ? `<div class="muted">row ${p.r.line}</div>` : ''}</td><td>${what}</td><td class="num">${count}</td></tr>`;
  }).join('') + (imp.plan.length > shown.length ? `<tr><td colspan="4" class="muted">…and ${imp.plan.length - shown.length} more</td></tr>` : '');
  const todo = imp.plan.filter(p => p.status === 'new' || p.status === 'update').length;
  $('#imp-go').disabled = !todo;
  $('#imp-go').textContent = todo ? `Import ${todo} item${todo === 1 ? '' : 's'}` : 'Nothing to import';
}
$('#imp-cur').onchange = renderImport;
$('#imp-counts').onchange = renderImport;
$('#imp-cancel').onclick = () => { $('#imp-dlg').close(); imp = null; };
$('#imp-go').onclick = () => {
  if (!imp || !imp.plan) return;
  const r = applyImport(imp.plan, imp.source);
  $('#imp-dlg').close(); imp = null;
  const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.counted && `${r.counted} stock count${r.counted === 1 ? '' : 's'} set`].filter(Boolean);
  toast(`Stock imported: ${parts.join(', ') || 'no changes'}.`);
};

// A spreadsheet saved as CSV (Excel: File → Save As → CSV).
$('#st-import').onclick = () => { $('#st-file').value = ''; $('#st-file').click(); };
$('#st-file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  if (!/\.(csv|txt|tsv)$/i.test(f.name)) { toast('Choose a CSV file. In Excel, use File → Save As → CSV.'); return; }
  const table = parseCsv(await f.text());
  if (table.length < 2) { toast(`${f.name} has no rows under its headings.`); return; }
  const { cols, unknown } = csvColumns(table[0]);
  if (!cols.some(c => c.field === 'name' || c.field === 'sku')) { toast(`Couldn't find an Item or Code column in ${f.name}. Download the template to see the headings Invaro reads.`); return; }
  const hasCount = cols.some(c => c.field === 'onHand');
  openImport({
    title: `Import ${f.name}`, source: `Spreadsheet: ${f.name}`, table,
    setCounts: hasCount ? 'ask' : false,
    note: unknown.length ? `Columns Invaro doesn't use: ${unknown.join(', ')}.` : '',
  });
};

// ---------- WooCommerce ----------
let wooState = null;
async function renderWoo() {
  if (!store.wooStatus) { $('#woo-box').hidden = true; return; }
  $('#woo-box').hidden = false;
  if (!wooState) wooState = await store.wooStatus();
  const w = wooState, on = w.connected && !$('#woo-form').dataset.editing;
  $('#woo-status').className = 'drive-status' + (w.connected ? ' on' : '');
  $('#woo-status').textContent = w.connected
    ? `Connected to ${w.site.replace(/^https:\/\//, '')}${w.currency ? `, prices in ${w.currency}` : ''}. ${w.lastImport ? `Last imported ${w.lastImport.slice(0, 10)}.` : ''}`
    : 'Not connected.';
  $('#woo-form').hidden = on;
  $('#woo-on').hidden = !on;
  if (!on) {
    setVal($('#woo-site'), w.site || '');
    $('#woo-key').placeholder = w.keyEnd ? `ck_…${w.keyEnd}` : 'ck_…';
    $('#woo-cancel').hidden = !w.connected;
  }
}
$('#woo-connect').onclick = async () => {
  const b = $('#woo-connect'); b.disabled = true; b.textContent = 'Checking…';
  const r = await store.wooConnect($('#woo-site').value, $('#woo-key').value, $('#woo-secret').value);
  b.disabled = false; b.textContent = 'Connect';
  if (r && r.error) return toast(r.error);
  wooState = r; $('#woo-secret').value = ''; $('#woo-key').value = ''; delete $('#woo-form').dataset.editing;
  renderWoo();
  toast(`Connected to your shop${r.currency ? ` (prices in ${r.currency})` : ''}. Click Import from WooCommerce to bring your products in.`);
};
$('#woo-change').onclick = () => { $('#woo-form').dataset.editing = '1'; renderWoo(); $('#woo-site').focus(); };
$('#woo-cancel').onclick = () => { delete $('#woo-form').dataset.editing; renderWoo(); };
$('#woo-disconnect').onclick = async () => {
  if (!confirm('Disconnect your WooCommerce shop? The key is removed from this computer. Your stock items stay as they are.')) return;
  wooState = await store.wooDisconnect(); renderWoo();
};
$('#woo-import').onclick = async () => {
  const b = $('#woo-import'); b.disabled = true; b.textContent = 'Reading your shop…';
  const r = await store.wooProducts();
  b.disabled = false; b.textContent = 'Import from WooCommerce';
  if (!r || r.error) return toast(`Couldn't read your shop: ${(r && r.error) || 'unknown error'}`);
  wooState = await store.wooStatus(); renderWoo();
  const cur = CURRENCIES[r.currency] ? r.currency : '';
  const rows = r.rows.map(p => {
    const row = { wooId: p.wooId, name: p.name, prices: {} };
    if (p.sku) row.sku = p.sku;
    if (p.category) row.category = p.category;
    if (cur && p.price != null) row.prices[cur] = p.price;
    if (p.stock != null) row.onHand = p.stock;
    return row;
  });
  const untracked = r.rows.filter(p => p.stock == null).length;
  openImport({
    title: 'Import from WooCommerce', source: 'WooCommerce', rows, setCounts: true,
    note: [
      cur ? `Prices are your shop's ${cur} prices.` : `Your shop's prices are in ${r.currency || 'a currency'} Invaro doesn't bill in, so prices aren't imported.`,
      'Stock counts are set to your shop\'s stock levels.',
      untracked ? `${untracked} product${untracked === 1 ? " doesn't" : "s don't"} have stock managed in WooCommerce, so ${untracked === 1 ? 'its count stays' : 'their counts stay'} as in Invaro.` : '',
    ].filter(Boolean).join(' '),
  });
};
