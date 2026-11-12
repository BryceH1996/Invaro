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
  async saveInvoice(bytes, client, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); a.download = name; a.click(); return { path: name };
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
// Preview zoom: null = fit to width, otherwise a percentage. Remembered in settings.
const ZOOMS = [50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300];
const previewView = () => settings.previewZoom ? `zoom=${settings.previewZoom}` : 'view=FitH';
function renderZoom() {
  const z = settings.previewZoom;
  $('#zoom-level').textContent = z ? z + '%' : 'Fit';
  $('#zoom-out').disabled = z === ZOOMS[0];
  $('#zoom-in').disabled = z === ZOOMS[ZOOMS.length - 1];
}
// Fit width is roughly 100% on a typical window, so stepping from "Fit" starts there.
function zoomBy(step) {
  const z = settings.previewZoom || 100;
  const i = step > 0 ? ZOOMS.findIndex(v => v > z) : ZOOMS.findLastIndex(v => v < z);
  setZoom(i < 0 ? z : ZOOMS[i]);
}
function setZoom(z) {
  if (z === settings.previewZoom) return;
  settings.previewZoom = z; persist('settings'); renderZoom(); refreshPreview(0);
}
$('#zoom-in').onclick = () => zoomBy(1);
$('#zoom-out').onclick = () => zoomBy(-1);
$('#zoom-level').onclick = () => setZoom(null);
// Ctrl + / Ctrl − / Ctrl 0 (the PDF viewer handles Ctrl+wheel itself until the next refresh).
window.addEventListener('keydown', e => {
  if (!e.ctrlKey || e.altKey) return;
  if (e.key === '+' || e.key === '=') zoomBy(1);
  else if (e.key === '-') zoomBy(-1);
  else if (e.key === '0') setZoom(null);
  else return;
  e.preventDefault();
});
function refreshPreview(delay = 250) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const c = client(draft.clientId);
    if (!c) { $('#preview').removeAttribute('src'); return; }
    const doc = buildPdf({ me: settings.me || {}, c, inv: draft, lines: priced(draft.items, c), pageSize: settings.pageSize });
    const url = doc.output('bloburl');
    $('#preview').src = `${url}#${previewView()}&toolbar=0&navpanes=0`;
    if (previewUrl) setTimeout(URL.revokeObjectURL.bind(URL, previewUrl), 2000);
    previewUrl = url;
  }, delay);
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
$('#open-client-folder').onclick = () => {
  const c = client(draft.clientId);
  if (c && store.openClientFolder) store.openClientFolder(c.company);
};
$('#reset-draft').onclick =() => { draft = newDraft(draft.clientId); renderInvoice(); changed(); };

function fileName(c, inv, me) {
  const p = parseDate((inv.period || inv.date.slice(0, 7)) + '-01');
  return `${c.company || 'Client'} Invoice - ${MONTHS[p.getMonth()]} ${p.getFullYear()} - ${me.name || 'Me'}.pdf`.replace(/[\\/:*?"<>|]/g, '');
}

const pdfBytes = entry => buildPdf({ me: entry.me, c: entry.c, inv: entry.inv, lines: entry.lines, pageSize: entry.pageSize }).output('arraybuffer');
// Backup copies are prefixed with the invoice number so two invoices in the same month never clash.
const backupName = entry => `${entry.inv.number} - ${fileName(entry.c, entry.inv, entry.me)}`.replace(/[\\/:*?"<>|]/g, '');

// ---------- Google Drive backup (via Google Drive for desktop's "My Drive" folder) ----------
let backupState = { ready: false };

// Copies the invoice into the backup folder. Records the result on the history entry; returns true on success.
async function backupPdf(entry, bytes) {
  if (!store.backupWrite) return false;
  const res = await store.backupWrite(bytes || pdfBytes(entry), backupName(entry), settings.backupDir || '', entry.c.company);
  if (res && !res.error) {
    entry.backup = res.path; entry.backupError = null; entry.backedUpAt = new Date().toISOString();
    return true;
  }
  entry.backup = null; entry.backupError = (res && res.error) || 'Backup failed';
  refreshBackupStatus();
  return false;
}

// Retries any invoices whose backup failed earlier (e.g. Google Drive wasn't running).
let retrying = false;
async function retryPendingBackups() {
  if (retrying) return;
  if (store.backupStatus) backupState = await store.backupStatus(settings.backupDir || '');
  if (!backupState.ready) return;
  const pending = invoices.filter(h => !h.backup && h.backupError !== undefined);
  if (!pending.length) return;
  retrying = true;
  let ok = 0;
  for (const h of pending) if (await backupPdf(h)) ok++;
  retrying = false;
  persist('invoices'); renderHistory(); refreshBackupStatus();
  if (ok) toast(`Backed up ${ok} invoice${ok === 1 ? '' : 's'} to Google Drive`);
}

// Saves the PDF into <data folder>\<Client>\ and backs it up. Returns the saved path, or null on failure.
async function savePdf(entry) {
  const bytes = pdfBytes(entry);
  const name = fileName(entry.c, entry.inv, entry.me);
  const altName = name.replace(/\.pdf$/i, ` - ${entry.inv.number}.pdf`).replace(/[\\/:*?"<>|]/g, '');
  const res = await store.saveInvoice(bytes, entry.c.company, name, altName, entry.file || '');
  if (!res || res.error) { toast('Could not save the invoice: ' + ((res && res.error) || 'unknown error')); return null; }
  const path = res.path;
  entry.file = path;
  if (window.api) {
    const shown = path.split(/[\\/]/).slice(-2).join('\\'); // e.g. "Client\Client Invoice - ….pdf"
    if (await backupPdf(entry, bytes)) toast(`Saved to ${shown} and backed up to Google Drive`, 'Open', () => store.open(path));
    else toast(`Saved to ${shown}, but NOT backed up: ${entry.backupError}. It will retry automatically.`, 'Open', () => store.open(path));
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
  // Re-saving an invoice number that's already in History overwrites that same file.
  const previous = invoices.find(h => h.inv.number === entry.inv.number);
  entry.file = previous ? previous.file : '';
  const path = await savePdf(entry);
  if (!path) return; // save failed (already reported)
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
  $('#cl-reminder').textContent = reminderLabel(c.reminderDay) + '.';
}
$('#cl-reminder-edit').onclick = () => go('notifications');
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
// Switch the invoice being drafted to this client (keeping its number) and show it.
function invoiceClient(id) {
  if (!client(id)) return;
  if (draft.clientId !== id) { const keep = draft.number; draft = newDraft(id); draft.number = keep; }
  renderInvoice(); changed(); go('invoice');
}
$('#cl-invoice').onclick = () => invoiceClient(editingClient);

// ---------- invoice reminders (the checks and Windows notifications run in main.js) ----------
const reminderOptions = () => '<option value="">Off</option>'
  + Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">On the ${i + 1}${ordinal(i + 1)} of each month</option>`).join('')
  + '<option value="last">On the last working day of each month</option>';
const reminderLabel = day => !day ? 'Off'
  : day === 'last' ? 'On the last working day of each month' : `On the ${day}${ordinal(Number(day))} of each month`;
const shortDate = s => { const d = parseDate(s); return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };
const longDate = s => { const d = parseDate(s); return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };

// ---------- notifications tab ----------
async function renderNotifications() {
  if (!store.reminderOverview) { $('#rem-task').textContent = 'Reminders are only available in the desktop app.'; return; }
  const rows = await store.reminderOverview();
  $('#rem-empty').style.display = rows.length ? 'none' : '';
  const status = r => ({
    off: () => '<span class="muted">–</span>',
    upcoming: () => `Reminds you on ${esc(shortDate(r.date))}`,
    due: () => `<span class="due">Due since ${esc(shortDate(r.date))}</span><br>
      <button class="btn primary" data-remind="invoice" data-id="${esc(r.id)}">Invoice now</button><button class="btn" data-remind="skip" data-id="${esc(r.id)}">Skip this month</button>`,
    invoiced: () => `<span class="ok">✓ Invoiced${r.invoice ? ' (' + esc(r.invoice) + ')' : ''}</span>`,
    skipped: () => '<span class="muted">Skipped this month</span>',
  }[r.status]());
  $('#rem-list').innerHTML = rows.map(r => `<tr>
    <td>${esc(r.company)}</td>
    <td><select data-rem="${esc(r.id)}">${reminderOptions()}</select></td>
    <td>${status(r)}</td>
    <td>${r.status === 'due' ? 'Every day until invoiced' : r.next ? esc(longDate(r.next)) : '<span class="muted">–</span>'}</td></tr>`).join('');
  rows.forEach(r => { $(`[data-rem="${CSS.escape(r.id)}"]`).value = r.reminderDay; });
  $('#rem-all-off').disabled = !rows.some(r => r.reminderDay);
  renderTaskStatus(rows.some(r => r.reminderDay));
}
async function renderTaskStatus(anyOn) {
  const el = $('#rem-task');
  const t = await store.reminderTask();
  if (!t.enabled) { el.className = 'drive-status'; el.textContent = 'The Windows scheduled task is only set up by the installed app.'; }
  else if (t.exists) { el.className = 'drive-status on'; el.textContent = `Windows reminder task is on. Next check: ${t.nextRun || 'unknown'}.`; }
  else if (anyOn) { el.className = 'drive-status err'; el.textContent = "Couldn't set up the Windows reminder task, so reminders only appear while Invoicer is open."; }
  else { el.className = 'drive-status'; el.textContent = 'No reminders set, so there is no Windows task.'; }
}
async function setReminder(id, day) {
  const c = client(id); if (!c) return;
  c.reminderDay = day;
  persist('clients'); await flushSaves(); // saved now, so Windows' task is updated straight away
  if (editingClient === id) $('#cl-reminder').textContent = reminderLabel(day) + '.';
  renderNotifications();
}
$('#rem-list').onchange = e => { if (e.target.dataset.rem) setReminder(e.target.dataset.rem, e.target.value); };
$('#rem-list').onclick = async e => {
  const { remind, id } = e.target.dataset;
  if (remind === 'invoice') invoiceClient(id);
  else if (remind === 'skip') { renderReminders(await store.skipReminder(id)); renderNotifications(); }
};
$('#rem-test').onclick = async () => {
  const r = await store.testNotification();
  toast(r && r.error ? r.error : "Test notification sent. If you didn't see it, check Windows Settings → System → Notifications.");
};
$('#rem-all-off').onclick = async () => {
  if (!confirm('Turn off invoice reminders for every client? This also removes the Windows scheduled task.')) return;
  clients.forEach(c => { c.reminderDay = ''; });
  persist('clients'); await flushSaves();
  renderClients(); renderNotifications();
};
function renderReminders(due) {
  $('#remind-bars').innerHTML = (due || []).map(r =>
    `<div class="update-bar remind"><span>Time to invoice <b>${esc(r.company)}</b> (reminder on ${esc(shortDate(r.date))}).</span>
     <button class="btn primary" data-remind="invoice" data-id="${esc(r.id)}">Invoice now</button>
     <button class="btn" data-remind="skip" data-id="${esc(r.id)}" title="No more reminders for ${esc(r.company)} until next month">Skip this month</button></div>`).join('');
}
$('#remind-bars').onclick = async e => {
  const { remind, id } = e.target.dataset;
  if (remind === 'invoice') invoiceClient(id);
  else if (remind === 'skip') { renderReminders(await store.skipReminder(id)); if (tabShown('notifications')) renderNotifications(); }
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

// ---------- Google Drive backup settings ----------
async function refreshBackupStatus() {
  if (!store.backupStatus) { $('#drive-status').textContent = 'Backups are only available in the desktop app.'; return; }
  backupState = await store.backupStatus(settings.backupDir || '');
  const s = $('#drive-status');
  if (backupState.ready) {
    s.className = 'drive-status on';
    s.textContent = `Backing up every saved invoice to ${backupState.dir}` + (backupState.auto ? ' (synced by Google Drive).' : '.');
  } else if (backupState.dir) {
    s.className = 'drive-status err';
    s.textContent = `Can't reach ${backupState.dir}. Is Google Drive running? Invoices will be backed up once it's back.`;
  } else {
    s.className = 'drive-status err';
    s.textContent = "Google Drive for desktop isn't installed or signed in, so invoices are not being backed up.";
  }
  $('#drive-install').hidden = !!backupState.myDrive || !!settings.backupDir;
  $('#drive-open').hidden = !backupState.ready;
  $('#drive-auto').hidden = !settings.backupDir;
  const missing = invoices.filter(h => !h.backup).length;
  $('#drive-retry').hidden = !backupState.ready || !missing;
  $('#drive-retry').textContent = `Back up ${missing} missing invoice${missing === 1 ? '' : 's'}`;
}
$('#drive-install').onclick = () => store.openExternal('https://www.google.com/drive/download/');
$('#drive-open').onclick = async () => { const r = await store.openBackupDir(settings.backupDir || ''); if (r && r.error) toast(r.error); };
$('#drive-change').onclick = async () => {
  const dir = await store.chooseBackupDir(settings.backupDir || '');
  if (!dir) return;
  settings.backupDir = dir; persist('settings');
  await refreshBackupStatus(); retryPendingBackups();
};
$('#drive-auto').onclick = async () => {
  settings.backupDir = ''; persist('settings');
  await refreshBackupStatus(); retryPendingBackups();
};
$('#drive-retry').onclick = async () => {
  // Include invoices saved before backups were set up.
  invoices.forEach(h => { if (!h.backup && h.backupError === undefined) h.backupError = 'Not backed up yet'; });
  $('#drive-retry').disabled = true;
  await retryPendingBackups();
  $('#drive-retry').disabled = false;
};

// ---------- history tab ----------
function renderHistory() {
  $('#hist-empty').style.display = invoices.length ? 'none' : '';
  const driveCell = h => h.backup
    ? `<button class="link ok" data-act="drive" data-id="${h.id}" title="Backed up to ${esc(h.backup)}. Click to show it.">✓ Drive</button>`
    : h.backupError !== undefined
      ? `<button class="link warn" data-act="backup" data-id="${h.id}" title="${esc(h.backupError)}. Click to retry.">⚠ Retry</button>`
      : '<span class="muted">–</span>';
  $('#hist').innerHTML = invoices.map(h =>
    `<tr><td>${esc(h.inv.number)}</td><td>${esc(h.c.company)}</td><td>${esc(h.inv.date)}</td>
     <td class="num">${esc(money(h.total, h.c.currency))}</td>
     <td>${driveCell(h)}</td>
     <td class="num">${h.file && window.api ? `<button class="btn" data-act="open" data-id="${h.id}">Open</button>` : ''}
     <button class="btn" data-act="pdf" data-id="${h.id}" title="Save this invoice again (e.g. after editing your details)">Re-save</button>
     <button class="btn" data-act="copy" data-id="${h.id}" title="Start a new invoice with these lines">Copy</button>
     <button class="x" data-act="del" data-id="${h.id}" title="Remove from history">×</button></td></tr>`).join('');
}
$('#hist').onclick = async e => {
  const { act, id } = e.target.dataset;
  const h = invoices.find(x => x.id === id); if (!h) return;
  if (act === 'pdf') { if (await savePdf(h)) { persist('invoices'); renderHistory(); } }
  else if (act === 'open') { const r = await store.open(h.file); if (r) toast(`Can't open it: ${r}`); }
  else if (act === 'drive') store.showInFolder(h.backup);
  else if (act === 'backup') {
    e.target.disabled = true; e.target.textContent = 'Backing up…';
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
  if (tab === 'notifications') renderNotifications();
}
const tabShown = tab => $(`section[data-tab="${tab}"]`).classList.contains('show');
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
  renderInvoice(); renderClients(); renderMe(); renderHistory(); renderZoom(); refreshPreview();
  if (store.version) $('#app-version').textContent = 'v' + await store.version();
  renderUpdates();
  checkForUpdate();
  setInterval(checkForUpdate, 30 * 60 * 1000);
  await refreshBackupStatus();
  retryPendingBackups();
  setInterval(retryPendingBackups, 10 * 60 * 1000);
  window.addEventListener('online', retryPendingBackups);
  if (store.dueReminders) {
    // Main sends this whenever clients or invoices are saved, and on each check.
    store.onReminders(due => { renderReminders(due); if (tabShown('notifications')) renderNotifications(); });
    store.onReminderOpen(invoiceClient);
    renderReminders(await store.dueReminders());
    // Opened by clicking a reminder notification while Invoicer was closed.
    const open = await store.takeReminderOpen();
    if (open) invoiceClient(open);
  }
})();

// ---------- updates ----------
let dismissedVersion = null;
// Returns the update on offer (or null). `manual` = the user clicked "Check now".
async function checkForUpdate(manual) {
  if (!store.checkUpdate) return null;
  const u = await store.checkUpdate().catch(() => null);
  if (!u || (u.version === dismissedVersion && !manual)) return u;
  const note = (u.notes || '').split('\n')[0].trim();
  $('#update-msg').textContent = `Invoicer ${u.version} is available (you have ${u.current}).` + (note ? ' ' + note : '');
  $('#update-bar').hidden = false;
  return u;
}

// ---------- updates settings (GitHub token) ----------
async function renderUpdates() {
  if (!store.updateTokenStatus) { $('#upd-status').textContent = 'Updates are only available in the desktop app.'; return; }
  const s = await store.updateTokenStatus();
  $('#upd-repo').textContent = s.repo || '';
  $('#upd-token-remove').hidden = !s.set;
  $('#upd-token').placeholder = s.set ? 'Token saved. Paste a new one to replace it.' : 'GitHub token (github_pat_… or ghp_…)';
  const el = $('#upd-status');
  el.className = 'drive-status' + (s.set ? ' on' : '');
  el.textContent = `You have Invoicer ${s.version}. ` + (s.set ? 'Getting updates from GitHub.' : 'No GitHub token saved, so updates only come from the updates folder.');
}
$('#upd-token-save').onclick = async () => {
  const token = $('#upd-token').value.trim();
  if (!token) return toast('Paste a token first');
  $('#upd-token-save').disabled = true;
  const r = await store.setUpdateToken(token);
  $('#upd-token-save').disabled = false;
  if (r.error) return toast(r.error);
  $('#upd-token').value = '';
  toast('Token saved. ' + (r.latest ? `The newest version on GitHub is ${r.latest}.` : 'There are no releases on GitHub yet.'));
  renderUpdates(); checkForUpdate(true);
};
$('#upd-token-remove').onclick = async () => {
  if (!confirm('Remove the saved GitHub token? Invoicer will stop getting updates from GitHub.')) return;
  await store.setUpdateToken('');
  renderUpdates();
};
$('#upd-check').onclick = async () => {
  $('#upd-check').disabled = true;
  const u = await checkForUpdate(true);
  $('#upd-check').disabled = false;
  if (!u) toast("You're up to date.");
};
if (store.onUpdateProgress) store.onUpdateProgress(pct => { $('#update-msg').textContent = `Downloading the update… ${pct}%`; });
$('#update-later').onclick = () => {
  dismissedVersion = $('#update-msg').textContent.match(/Invoicer (\S+)/)?.[1];
  $('#update-bar').hidden = true;
};
$('#update-install').onclick = async () => {
  $('#update-install').disabled = true;
  $('#update-msg').textContent = 'Saving your work and installing the update…';
  await flushSaves();
  const r = await store.installUpdate();
  if (!r || r.error) {
    $('#update-msg').textContent = r && r.error ? `Couldn't update: ${r.error}` : 'Update file not found. Try again later.';
    $('#update-install').disabled = false;
  }
};
