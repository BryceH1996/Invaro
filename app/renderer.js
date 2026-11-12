const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clone = o => JSON.parse(JSON.stringify(o));
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + Number(n || 0)); return iso(d); };
const num = v => Number(v) || 0;
const round2 = n => Math.round(n * 100) / 100;

// In Electron, window.api comes from preload.js. In a plain browser (for testing) fall back to localStorage.
const store = window.api || {
  async load() {
    const g = k => { try { return JSON.parse(localStorage.getItem('invoicer.' + k)); } catch (e) { return null; } };
    return { clients: g('clients') || [], settings: g('settings') || { me: {}, prefix: 'INV-', nextNumber: 1, pageSize: 'letter' }, invoices: g('invoices') || [], dataDir: '(browser storage)' };
  },
  async save(k, v) { localStorage.setItem('invoicer.' + k, JSON.stringify(v)); },
  async savePdf(bytes, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); a.download = name; a.click(); return name;
  },
  async open() {}, async showInFolder() {}, async openDataDir() {},
};

let clients = [], settings = {}, invoices = [], draft = null, dataDir = '';

// ---------- persistence (debounced per file) ----------
const timers = {};
function persist(name) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => {
    const value = { clients, settings, invoices }[name];
    store.save(name, value).catch(e => toast('Could not save ' + name + ': ' + e.message));
  }, 300);
}
// Write any pending saves right now (used before switching data folders).
async function flushSaves() {
  const pending = Object.keys(timers).filter(k => timers[k]);
  pending.forEach(k => { clearTimeout(timers[k]); timers[k] = null; });
  await Promise.all(pending.map(k => store.save(k, { clients, settings, invoices }[k])));
}

// ---------- pricing ----------
const KINDS = { hours: 'Hours', days: 'Days', daysoff: 'Days off', fixed: 'Fixed' };
const dayOffRate = c => (c.dayOffRate === '' || c.dayOffRate == null) ? num(c.dailyRate) : num(c.dayOffRate);
const rateFor = (kind, c) => ({ hours: num(c.hourlyRate), days: num(c.dailyRate), daysoff: dayOffRate(c) }[kind] ?? 0);

function lineAmount(it, c) {
  const q = num(it.qty);
  switch (it.kind) {
    case 'hours': return round2(q * num(c.hourlyRate));
    case 'days': return round2(q * num(c.dailyRate));
    case 'daysoff': return round2(-q * dayOffRate(c));
    default: return round2(num(it.amount));
  }
}
function lineDetail(it, c) {
  const q = num(it.qty), cur = c.currency || '';
  const plural = (w) => q === 1 ? w : w + 's';
  if (it.kind === 'hours') return `${q} ${plural('hr')} @ ${money(c.hourlyRate, cur)}/hr`;
  if (it.kind === 'days') return `${q} ${plural('day')} @ ${money(c.dailyRate, cur)}/day`;
  if (it.kind === 'daysoff') return `${q} ${plural('day')} × ${money(dayOffRate(c), cur)}`;
  return '';
}
// Lines as they appear on the PDF (zero-value lines dropped).
function priced(items, c) {
  return items.map(it => ({ desc: it.desc, detail: lineDetail(it, c), amount: lineAmount(it, c) }))
    .filter(l => l.amount !== 0);
}
const normItem = it => ({ kind: KINDS[it.kind] ? it.kind : 'fixed', desc: it.desc || '', qty: it.qty ?? 1, amount: it.amount ?? 0 });

// ---------- drafts ----------
const client = id => clients.find(c => c.id === id);
// Next invoice number = one past the highest number already saved in History,
// never lower than the "Next invoice number" setting (so you can skip ahead).
const numberOf = s => { const m = String(s || '').match(/(\d+)\D*$/); return m ? parseInt(m[1], 10) : NaN; };
function nextNumberValue() {
  const used = invoices.map(h => numberOf(h.inv.number)).filter(n => !isNaN(n));
  return Math.max(num(settings.nextNumber), used.length ? Math.max(...used) + 1 : 0);
}
const nextInvoiceNumber = () => (settings.prefix || '') + nextNumberValue();
const numberUsed = s => invoices.some(h => h.inv.number === s);

function newDraft(clientId) {
  const c = client(clientId) || clients[0];
  const today = iso(new Date());
  return {
    clientId: c ? c.id : null, number: nextInvoiceNumber(),
    date: today, due: c ? addDays(today, c.dueDays) : today, period: today.slice(0, 7),
    items: c && c.items && c.items.length ? clone(c.items).map(normItem) : [normItem({ kind: 'fixed' })],
  };
}

// ---------- preview ----------
let previewUrl = null, previewTimer = null;
function refreshPreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const c = client(draft.clientId);
    if (!c) { $('#preview').removeAttribute('src'); return; }
    const doc = buildPdf({ me: settings.me || {}, c, inv: draft, lines: priced(draft.items, c), pageSize: settings.pageSize });
    const url = doc.output('bloburl');
    $('#preview').src = url + '#view=FitH&toolbar=0&navpanes=0';
    if (previewUrl) setTimeout(URL.revokeObjectURL.bind(URL, previewUrl), 2000);
    previewUrl = url;
  }, 250);
}

// ---------- invoice tab ----------
function renderClientOptions() {
  const opts = clients.map(c => `<option value="${c.id}">${esc(c.company || '(unnamed)')}</option>`).join('');
  $('#inv-client').innerHTML = opts; $('#cl-select').innerHTML = opts;
  $('#inv-client').value = draft.clientId || '';
}
function renderRates() {
  const c = client(draft.clientId);
  if (!c) { $('#inv-rates').textContent = 'Add a client on the Clients tab first.'; return; }
  const cur = c.currency || '';
  const parts = [`${curCode(cur)} (${curSymbol(cur)})`];
  if (num(c.hourlyRate)) parts.push(`${money(c.hourlyRate, cur)}/hr`);
  if (num(c.dailyRate)) parts.push(`${money(c.dailyRate, cur)}/day`);
  if (dayOffRate(c)) parts.push(`day off −${money(dayOffRate(c), cur)}`);
  $('#inv-rates').textContent = 'Billing in ' + parts.join(' · ') + (parts.length > 1 ? '' : ' · no rates set yet (Clients tab)');
}
function renderInvoice() {
  renderClientOptions(); renderRates();
  $('#inv-number').value = draft.number; $('#inv-period').value = draft.period;
  $('#inv-date').value = draft.date; $('#inv-due').value = draft.due;
  renderItems();
}
function renderItems() {
  const box = $('#inv-items');
  box.innerHTML = '<div class="hd">Type</div><div class="hd">Description</div><div class="hd">Qty</div><div class="hd">Amount</div><div></div>';
  const c = client(draft.clientId) || {};
  draft.items.forEach((it, i) => {
    const kind = document.createElement('select');
    kind.innerHTML = Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    kind.value = it.kind;
    const desc = document.createElement('input'); desc.value = it.desc; desc.placeholder = 'e.g. Frontend Development';
    const qty = document.createElement('input'); qty.type = 'number'; qty.step = '0.25'; qty.min = '0'; qty.value = it.qty;
    const amt = document.createElement('input'); amt.type = 'number'; amt.step = '0.01';
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove line';
    const sync = () => {
      const fixed = it.kind === 'fixed';
      qty.disabled = fixed; qty.style.visibility = fixed ? 'hidden' : '';
      amt.readOnly = !fixed;
      amt.value = fixed ? it.amount : lineAmount(it, c).toFixed(2);
      amt.title = fixed ? '' : lineDetail(it, c);
    };
    kind.onchange = () => {
      const was = it.kind; it.kind = kind.value;
      if (!it.desc || it.desc === 'Days off') it.desc = it.kind === 'daysoff' ? 'Days off' : (was === 'daysoff' ? '' : it.desc);
      desc.value = it.desc;
      if (it.kind !== 'fixed' && !num(it.qty)) it.qty = 1;
      qty.value = it.qty;
      if (it.kind !== 'fixed' && !rateFor(it.kind, c)) toast(`${c.company || 'This client'} has no ${KINDS[it.kind].toLowerCase()} rate set`);
      sync(); changed();
    };
    desc.oninput = () => { it.desc = desc.value; changed(); };
    qty.oninput = () => { it.qty = parseFloat(qty.value) || 0; sync(); changed(); };
    amt.oninput = () => { if (it.kind === 'fixed') { it.amount = parseFloat(amt.value) || 0; changed(); } };
    x.onclick = () => { draft.items.splice(i, 1); renderItems(); changed(); };
    sync();
    box.append(kind, desc, qty, amt, x);
  });
  updateTotal();
}
function updateTotal() {
  const c = client(draft.clientId) || {};
  $('#inv-total').textContent = money(priced(draft.items, c).reduce((s, l) => s + l.amount, 0), c.currency);
}
function changed() { settings.draft = draft; persist('settings'); updateTotal(); refreshPreview(); }

$('#inv-client').onchange = e => {
  const keep = draft.number;
  draft = newDraft(e.target.value); draft.number = keep;
  renderInvoice(); changed();
};
$('#inv-number').oninput = e => { draft.number = e.target.value; changed(); };
$('#inv-period').oninput = e => { draft.period = e.target.value; changed(); };
$('#inv-date').oninput = e => {
  draft.date = e.target.value;
  const c = client(draft.clientId);
  if (c && e.target.value) { draft.due = addDays(e.target.value, c.dueDays); $('#inv-due').value = draft.due; }
  changed();
};
$('#inv-due').oninput = e => { draft.due = e.target.value; changed(); };
$('#add-item').onclick = () => { draft.items.push(normItem({ kind: 'fixed' })); renderItems(); changed(); };
$('#save-default').onclick = () => {
  const c = client(draft.clientId); if (!c) return;
  c.items = clone(draft.items); persist('clients'); toast(`Saved as default lines for ${c.company}`);
};
$('#reset-draft').onclick = () => { draft = newDraft(draft.clientId); renderInvoice(); changed(); };

function fileName(c, inv, me) {
  const p = parseDate((inv.period || inv.date.slice(0, 7)) + '-01');
  return `${c.company || 'Client'} Invoice - ${MONTHS[p.getMonth()]} ${p.getFullYear()} - ${me.name || 'Me'}.pdf`.replace(/[\\/:*?"<>|]/g, '');
}

const pdfBytes = entry => buildPdf({ me: entry.me, c: entry.c, inv: entry.inv, lines: entry.lines, pageSize: entry.pageSize }).output('arraybuffer');
// Backup copies are prefixed with the invoice number so two invoices in the same month never clash.
const backupName = entry => `${entry.inv.number} - ${fileName(entry.c, entry.inv, entry.me)}`.replace(/[\\/:*?"<>|]/g, '');

// ---------- Google Drive backup ----------
let driveState = { connected: false };

// Uploads the invoice to Google Drive. Records the result on the history entry; returns true on success.
async function backupPdf(entry, bytes) {
  if (!driveState.connected || !store.driveUpload) return false;
  const res = await store.driveUpload(bytes || pdfBytes(entry), backupName(entry));
  if (res && !res.error) {
    entry.backup = res.link; entry.backupError = null; entry.backedUpAt = new Date().toISOString();
    return true;
  }
  entry.backup = null; entry.backupError = (res && res.error) || 'Upload failed';
  if (/not connected|expired/i.test(entry.backupError)) refreshDriveStatus();
  return false;
}

// Retries any invoices whose Drive upload failed earlier (e.g. while offline).
let retrying = false;
async function retryPendingBackups() {
  if (retrying || !driveState.connected) return;
  const pending = invoices.filter(h => !h.backup && h.backupError !== undefined);
  if (!pending.length) return;
  retrying = true;
  let ok = 0;
  for (const h of pending) if (await backupPdf(h)) ok++;
  retrying = false;
  persist('invoices'); renderHistory();
  if (ok) toast(`Backed up ${ok} invoice${ok === 1 ? '' : 's'} to Google Drive`);
}

async function savePdf(entry) {
  const bytes = pdfBytes(entry);
  const path = await store.savePdf(bytes, fileName(entry.c, entry.inv, entry.me), settings.lastSaveDir);
  if (path && window.api) {
    settings.lastSaveDir = path.replace(/[\\/][^\\/]*$/, ''); persist('settings');
    const name = path.split(/[\\/]/).pop();
    if (!driveState.connected) {
      entry.backupError = 'Google Drive not connected';
      toast(`Saved ${name}. Not backed up: Google Drive isn't connected (My details).`, 'Open', () => store.open(path));
    } else {
      toast(`Saved ${name}. Uploading to Google Drive…`);
      if (await backupPdf(entry, bytes)) toast(`Saved ${name} and backed up to Google Drive`, 'Open', () => store.open(path));
      else toast(`Saved ${name}, but the Google Drive backup failed: ${entry.backupError}. It will retry automatically.`, 'Open', () => store.open(path));
    }
  }
  return path;
}

$('#download').onclick = async () => {
  const c = client(draft.clientId);
  if (!c) return toast('Add a client first');
  const entry = {
    id: uid(), savedAt: new Date().toISOString(), pageSize: settings.pageSize,
    inv: clone(draft), c: clone(c), me: clone(settings.me || {}), lines: priced(draft.items, c),
  };
  entry.total = round2(entry.lines.reduce((s, l) => s + l.amount, 0));
  const path = await savePdf(entry);
  if (!path) return; // cancelled
  entry.file = path;
  const idx = invoices.findIndex(h => h.inv.number === entry.inv.number);
  if (idx >= 0) invoices[idx] = entry; else invoices.unshift(entry);
  persist('invoices');
  settings.nextNumber = nextNumberValue();
  // Invoice is done: start the next one for the same client with the following number.
  draft = newDraft(draft.clientId);
  renderInvoice(); changed(); renderHistory(); renderMe();
};

// ---------- clients tab ----------
let editingClient = null;
function renderClients() {
  renderClientOptions();
  const c = client(editingClient) || clients[0];
  $('#cl-form').style.display = c ? '' : 'none';
  if (!c) return;
  editingClient = c.id; $('#cl-select').value = c.id;
  $$('[data-cl]').forEach(el => el.value = c[el.dataset.cl] ?? '');
  $('#cl-items').textContent = (c.items || []).length
    ? c.items.map(normItem).map(i => i.kind === 'fixed' ? `${i.desc} ${money(i.amount, c.currency)}` : `${i.desc} (${KINDS[i.kind].toLowerCase()})`).join(' · ')
    : 'None yet. Fill in lines on an invoice and click "Save lines as client default".';
}
$('#cl-select').onchange = e => { editingClient = e.target.value; renderClients(); };
$$('[data-cl]').forEach(el => el.oninput = () => {
  const c = client(editingClient); if (!c) return;
  c[el.dataset.cl] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
  persist('clients'); renderClientOptions(); $('#cl-select').value = c.id;
  if (c.id === draft.clientId) { renderRates(); renderItems(); refreshPreview(); }
});
$('#cl-new').onclick = () => {
  const c = { id: uid(), company: 'New client', contacts: '', phone: '', address: '', currency: 'GBP', dueDays: 14,
    hourlyRate: '', dailyRate: '', dayOffRate: '', items: [] };
  clients.push(c); editingClient = c.id; persist('clients'); renderClients();
  $('[data-cl="company"]').select();
};
$('#cl-delete').onclick = () => {
  const c = client(editingClient); if (!c) return;
  if (!confirm(`Delete ${c.company}? Past invoices in History are kept.`)) return;
  clients = clients.filter(x => x.id !== c.id);
  if (draft.clientId === c.id) { draft = newDraft(); changed(); }
  editingClient = clients[0]?.id; persist('clients'); renderClients(); renderInvoice(); refreshPreview();
};
$('#cl-invoice').onclick = () => {
  const keep = draft.number;
  draft = newDraft(editingClient); draft.number = keep;
  renderInvoice(); changed(); go('invoice');
};

// ---------- me tab ----------
function renderMe() {
  const me = settings.me || {};
  $$('[data-me]').forEach(el => el.value = me[el.dataset.me] ?? '');
  $$('[data-set]').forEach(el => el.value = settings[el.dataset.set] ?? '');
  $('#data-dir').textContent = dataDir;
}
$$('[data-me]').forEach(el => el.oninput = () => { (settings.me ||= {})[el.dataset.me] = el.value; persist('settings'); refreshPreview(); });
$$('[data-set]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
  settings[el.dataset.set] = el.type === 'number' ? num(el.value) : el.value;
  persist('settings'); refreshPreview();
}));
$('#open-data').onclick = () => store.openDataDir();
$('#change-data').onclick = async () => {
  if (!store.chooseDataDir) return;
  await flushSaves();
  if (await store.chooseDataDir()) location.reload();
};

// ---------- Google Drive settings ----------
async function refreshDriveStatus(errorMsg) {
  if (!store.driveStatus) { $('#drive-status').textContent = 'Google Drive backup is only available in the desktop app.'; $('#drive-connect').hidden = true; return; }
  driveState = await store.driveStatus();
  const s = $('#drive-status');
  s.className = 'drive-status' + (errorMsg ? ' err' : driveState.connected ? ' on' : '');
  s.textContent = errorMsg || (driveState.connected
    ? `Connected${driveState.email ? ' as ' + driveState.email : ''}. Invoices are backed up to “Invoicer Backups”.`
    : 'Not connected. Saved invoices are not being backed up.');
  $('#drive-setup').hidden = driveState.connected;
  if (!$('#drive-client-id').value) $('#drive-client-id').value = driveState.clientId || '';
  $('#drive-secret').placeholder = driveState.hasSecret ? '(saved, leave blank to keep)' : '';
  $('#drive-connect').hidden = driveState.connected;
  $('#drive-open').hidden = $('#drive-disconnect').hidden = !driveState.connected;
  const missing = invoices.filter(h => !h.backup).length;
  $('#drive-retry').hidden = !driveState.connected || !missing;
  $('#drive-retry').textContent = `Back up ${missing} missing invoice${missing === 1 ? '' : 's'}`;
}
$('#drive-connect').onclick = async () => {
  const btn = $('#drive-connect');
  btn.disabled = true; btn.textContent = 'Waiting for Google sign-in in your browser…';
  const res = await store.driveConnect($('#drive-client-id').value, $('#drive-secret').value);
  btn.disabled = false; btn.textContent = 'Connect Google Drive';
  $('#drive-secret').value = '';
  if (res && res.error) return refreshDriveStatus(res.error);
  await refreshDriveStatus();
  toast('Google Drive connected');
  retryPendingBackups();
};
$('#drive-disconnect').onclick = async () => {
  if (!confirm('Disconnect Google Drive? New invoices will not be backed up until you reconnect. Files already in Drive stay there.')) return;
  await store.driveDisconnect(); refreshDriveStatus();
};
$('#drive-open').onclick = async () => { const r = await store.driveOpenFolder(); if (r && r.error) toast(r.error); };
$('#drive-retry').onclick = async () => {
  // Include invoices saved before Drive was connected.
  invoices.forEach(h => { if (!h.backup && h.backupError === undefined) h.backupError = 'Not backed up yet'; });
  $('#drive-retry').disabled = true;
  await retryPendingBackups();
  $('#drive-retry').disabled = false;
  refreshDriveStatus();
};

// ---------- history tab ----------
function renderHistory() {
  $('#hist-empty').style.display = invoices.length ? 'none' : '';
  const driveCell = h => h.backup
    ? `<button class="link ok" data-act="drive" data-id="${h.id}" title="Open in Google Drive">✓ Drive</button>`
    : h.backupError !== undefined
      ? `<button class="link warn" data-act="backup" data-id="${h.id}" title="${esc(h.backupError)}. Click to retry.">⚠ Retry</button>`
      : '<span class="muted">–</span>';
  $('#hist').innerHTML = invoices.map(h =>
    `<tr><td>${esc(h.inv.number)}</td><td>${esc(h.c.company)}</td><td>${esc(h.inv.date)}</td>
     <td class="num">${esc(money(h.total, h.c.currency))}</td>
     <td>${driveCell(h)}</td>
     <td class="num"><button class="btn" data-act="pdf" data-id="${h.id}">Save PDF</button>
     <button class="btn" data-act="copy" data-id="${h.id}" title="Start a new invoice with these lines">Copy</button>
     <button class="x" data-act="del" data-id="${h.id}" title="Remove from history">×</button></td></tr>`).join('');
}
$('#hist').onclick = async e => {
  const { act, id } = e.target.dataset;
  const h = invoices.find(x => x.id === id); if (!h) return;
  if (act === 'pdf') { if (await savePdf(h)) { persist('invoices'); renderHistory(); } }
  else if (act === 'drive') store.openExternal(h.backup);
  else if (act === 'backup') {
    if (!driveState.connected) return toast('Connect Google Drive in My details first');
    e.target.disabled = true; e.target.textContent = 'Uploading…';
    const ok = await backupPdf(h);
    persist('invoices'); renderHistory();
    toast(ok ? `${h.inv.number} backed up to Google Drive` : `Backup failed: ${h.backupError}`);
  } else if (act === 'copy') {
    draft = newDraft(client(h.c.id) ? h.c.id : undefined);
    draft.items = clone(h.inv.items).map(normItem);
    renderInvoice(); changed(); go('invoice');
  } else if (act === 'del' && confirm(`Remove ${h.inv.number} from history? (The PDF file itself is not deleted.)`)) {
    invoices = invoices.filter(x => x.id !== id); persist('invoices'); renderHistory();
  }
};

// ---------- misc ----------
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function toast(msg, actLabel, act) {
  const t = $('#toast'); $('#toast-msg').textContent = msg;
  const b = $('#toast-act'); b.textContent = actLabel || ''; b.onclick = act || null;
  t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), act ? 6000 : 2500);
}
function go(tab) {
  $$('section[data-tab]').forEach(s => s.classList.toggle('show', s.dataset.tab === tab));
  $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.go === tab));
  if (tab === 'clients') renderClients();
}
$$('nav button').forEach(b => b.onclick = () => go(b.dataset.go));

(async function init() {
  const d = await store.load();
  clients = d.clients; settings = d.settings; invoices = d.invoices; dataDir = d.dataDir;
  $('#cl-currency').innerHTML = Object.entries(CURRENCIES)
    .map(([code, { symbol, name }]) => `<option value="${code}">${code} (${symbol}) – ${name}</option>`).join('');
  let migrated = false;
  clients.forEach(c => {
    c.items = (c.items || []).map(normItem);
    const code = curCode(c.currency); // older data stored a symbol like "£"
    if (c.currency !== code) { c.currency = code; migrated = true; }
  });
  if (migrated) await store.save('clients', clients);
  settings.nextNumber = nextNumberValue();
  draft = settings.draft && client(settings.draft.clientId)
    ? { ...settings.draft, items: settings.draft.items.map(normItem) }
    : newDraft();
  // A leftover draft whose number was already saved gets the next free number.
  if (numberUsed(draft.number)) draft.number = nextInvoiceNumber();
  editingClient = clients[0]?.id;
  renderInvoice(); renderClients(); renderMe(); renderHistory(); refreshPreview();
  if (store.version) $('#app-version').textContent = 'v' + await store.version();
  checkForUpdate();
  setInterval(checkForUpdate, 30 * 60 * 1000);
  await refreshDriveStatus();
  retryPendingBackups();
  setInterval(retryPendingBackups, 10 * 60 * 1000);
  window.addEventListener('online', retryPendingBackups);
})();

// ---------- updates ----------
let dismissedVersion = null;
async function checkForUpdate() {
  if (!store.checkUpdate) return;
  const u = await store.checkUpdate().catch(() => null);
  if (!u || u.version === dismissedVersion) return;
  $('#update-msg').textContent = `Invoicer ${u.version} is available (you have ${u.current}).` + (u.notes ? ' ' + u.notes : '');
  $('#update-bar').hidden = false;
}
$('#update-later').onclick = () => {
  dismissedVersion = $('#update-msg').textContent.match(/Invoicer (\S+)/)?.[1];
  $('#update-bar').hidden = true;
};
$('#update-install').onclick = async () => {
  $('#update-install').disabled = true;
  $('#update-msg').textContent = 'Saving your work and installing the update…';
  await flushSaves();
  if (!(await store.installUpdate())) { $('#update-msg').textContent = 'Update file not found. Try again later.'; $('#update-install').disabled = false; }
};
