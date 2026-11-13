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
// qty and price feed the templates with Qty / Price columns (days off show a negative price).
function priced(items, c) {
  return items.map(it => {
    const amount = lineAmount(it, c);
    const fixed = it.kind === 'fixed';
    const price = fixed ? amount : (it.kind === 'daysoff' ? -1 : 1) * rateFor(it.kind, c);
    return { desc: it.desc, detail: lineDetail(it, c), qty: fixed ? 1 : num(it.qty), price, amount };
  }).filter(l => l.amount !== 0);
}

// ---------- invoice design (template, colour, logo) ----------
let logo = null, bankLogo = null; // { data, w, h } with data a PNG data URL, scaled down for the PDF
// Saved invoices keep the banking details they were saved with; older ones use your current details.
const pdfOptions = (entry) => ({
  me: entry.me, c: entry.c, inv: entry.inv, lines: entry.lines, pageSize: entry.pageSize,
  design: entry.design, logo, taxLabel: entry.taxLabel || settings.taxLabel,
  bank: entry.bank || settings.bank, bankLogo,
});

// ---------- banking details (EFT) ----------
function renderBank() {
  const b = settings.bank ||= {};
  $('#bank-pick').innerHTML = '<option value="">Choose your bank…</option>'
    + SA_BANKS.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('') + '<option value="other">Another bank</option>';
  $('#bank-pick').value = b.bankId || '';
  $('#bank-type').innerHTML = '<option value=""></option>' + ACCOUNT_TYPES.map(t => `<option>${esc(t)}</option>`).join('');
  $$('[data-bank]').forEach(el => {
    if (el.type === 'checkbox') el.checked = !!b[el.dataset.bank];
    else el.value = b[el.dataset.bank] ?? '';
  });
  $('#bank-form').hidden = !b.enabled;
  $('#bank-logo-box').innerHTML = bankLogo ? `<img src="${bankLogo.data}" alt="Bank logo">` : '<span class="muted">No logo</span>';
  $('#bank-logo-remove').hidden = !bankLogo;
}
$$('[data-bank]').forEach(el => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
  const b = settings.bank ||= {};
  b[el.dataset.bank] = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.bank === 'enabled') { if (el.checked && b.useReference === undefined) b.useReference = true; renderBank(); }
  persist('settings'); refreshPreview();
}));
$('#bank-pick').onchange = e => {
  const b = settings.bank ||= {};
  const known = SA_BANKS.find(x => x.id === e.target.value);
  b.bankId = e.target.value;
  if (known) Object.assign(b, { bankName: known.name, branchCode: known.branch, swift: known.swift });
  persist('settings'); renderBank(); refreshPreview(0);
  if (!known && e.target.value === 'other') $('[data-bank="bankName"]').focus();
};
$('#bank-logo-choose').onclick = async () => {
  if (!store.chooseLogo) return toast('Logos are only available in the desktop app.');
  const r = await store.chooseLogo('bank-logo');
  if (!r) return;
  if (r.error) return toast(r.error);
  const img = await loadLogoImage(r.data);
  if (!img) { await store.removeLogo('bank-logo'); return toast("Couldn't read that image. Try a PNG or JPG."); }
  bankLogo = img; (settings.bank ||= {}).logo = r.name; persist('settings');
  renderBank(); refreshPreview(0);
};
$('#bank-logo-remove').onclick = async () => {
  await store.removeLogo('bank-logo'); bankLogo = null; (settings.bank ||= {}).logo = ''; persist('settings');
  renderBank(); refreshPreview(0);
};
// Turns any image the browser can show into a PNG no bigger than 800px, for jsPDF.
function loadLogoImage(dataUrl) {
  return new Promise(resolve => {
    if (!dataUrl) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 800 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
      const w = Math.max(1, Math.round((img.naturalWidth || 300) * s)), h = Math.max(1, Math.round((img.naturalHeight || 100) * s));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve({ data: cv.toDataURL('image/png'), w, h, src: dataUrl });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
function designNow() { return resolveDesign(settings.design); }
// Small sketches of each template for the picker, drawn in the chosen colour.
function templateSketch(id, color, c2) {
  c2 = c2 || color;
  const lt = 'rgba(0,0,0,.08)';
  const body = {
    classic: `<rect x="8" y="10" width="44" height="22" fill="${c2}"/><rect x="52" y="10" width="40" height="22" fill="${color}"/>
      <rect x="8" y="44" width="84" height="6" fill="${color}"/><rect x="8" y="56" width="84" height="5" fill="${lt}"/><rect x="8" y="66" width="84" height="5" fill="${c2}" opacity=".6"/>`,
    wave: `<path d="M0 0H100V22C70 30 40 24 0 36Z" fill="${color}"/><path d="M62 0H100V22C88 25 76 26 62 27Z" fill="${c2}"/><rect x="8" y="44" width="84" height="6" fill="${color}"/>
      <rect x="8" y="50" width="84" height="18" fill="none" stroke="#bbb" stroke-width=".8"/><rect x="54" y="72" width="38" height="6" fill="${color}"/>`,
    minimal: `<rect x="8" y="9" width="30" height="8" fill="#222"/><rect x="8" y="24" width="20" height="10" fill="${lt}"/><rect x="38" y="24" width="20" height="10" fill="${lt}"/>
      <rect x="8" y="44" width="84" height="7" fill="${color}" opacity=".25"/><rect x="8" y="57" width="84" height="1" fill="#ccc"/><rect x="60" y="70" width="32" height="5" fill="${color}"/>`,
    bold: `<rect width="100" height="22" fill="${c2}"/><rect y="22" width="100" height="3" fill="${color}"/><rect x="64" y="30" width="28" height="13" fill="${color}"/>
      <rect x="8" y="31" width="22" height="4" fill="${lt}"/><rect x="8" y="50" width="84" height="1.5" fill="${c2}"/><rect x="8" y="58" width="84" height="1" fill="#ddd"/><rect x="56" y="68" width="36" height="7" fill="${c2}"/>`,
    elegant: `<rect x="36" y="7" width="28" height="5" fill="#2b2620"/><rect x="26" y="15" width="48" height="2" fill="${lt}"/>
      <rect x="8" y="21" width="84" height="1" fill="${color}"/><rect x="8" y="23" width="84" height=".5" fill="${color}"/><rect x="40" y="28" width="20" height="5" fill="${color}" opacity=".8"/>
      <rect x="8" y="44" width="84" height=".8" fill="${color}"/><rect x="8" y="51" width="84" height=".8" fill="${color}"/><rect x="62" y="70" width="30" height="4" fill="${color}"/>`,
    sidebar: `<rect width="33" height="84" fill="${color}"/><rect x="6" y="8" width="16" height="6" fill="#fff" opacity=".9"/><rect x="6" y="22" width="20" height="3" fill="#fff" opacity=".5"/>
      <rect x="6" y="30" width="18" height="3" fill="#fff" opacity=".5"/><rect x="40" y="10" width="30" height="5" fill="#333"/><rect x="40" y="30" width="52" height="6" fill="${color}" opacity=".2"/>
      <rect x="40" y="42" width="52" height="1" fill="#ddd"/><rect x="40" y="50" width="52" height="1" fill="#ddd"/><rect x="66" y="66" width="26" height="5" fill="${color}"/>`,
    corporate: `<rect width="100" height="3" fill="${color}"/><rect x="8" y="9" width="16" height="7" fill="${lt}"/><rect x="66" y="9" width="26" height="3" fill="#333"/>
      <rect x="8" y="22" width="26" height="5" fill="${c2}"/><rect x="8" y="31" width="40" height="11" rx="2" fill="#eef0f3"/><rect x="52" y="31" width="40" height="11" rx="2" fill="#eef0f3"/>
      <rect x="8" y="47" width="84" height="5" fill="${color}"/><rect x="8" y="57" width="84" height="4" fill="#eef0f3"/><rect x="60" y="66" width="32" height="10" rx="2" fill="#eef0f3"/>`,
    mono: `<rect x="34" y="8" width="32" height="4" fill="#333"/><rect x="28" y="15" width="44" height="2" fill="${lt}"/>
      <line x1="8" y1="22" x2="92" y2="22" stroke="#888" stroke-dasharray="2 1.5"/><rect x="34" y="27" width="32" height="5" fill="${color}"/>
      <line x1="8" y1="38" x2="92" y2="38" stroke="#888" stroke-dasharray="2 1.5"/><rect x="8" y="44" width="84" height="2" fill="${lt}"/><rect x="8" y="50" width="84" height="2" fill="${lt}"/>
      <line x1="8" y1="58" x2="92" y2="58" stroke="#888" stroke-dasharray="2 1.5"/><rect x="62" y="64" width="30" height="5" fill="${color}"/>`,
    geometric: `<polygon points="62,0 100,0 100,38" fill="${color}"/><polygon points="80,0 100,0 100,20" fill="${c2}"/><polygon points="0,68 0,84 16,84" fill="${c2}" opacity=".6"/>
      <rect x="8" y="12" width="34" height="7" fill="#222"/><rect x="8" y="22" width="12" height="2" fill="${color}"/><rect x="8" y="34" width="84" height="1.5" fill="${color}"/>
      <rect x="8" y="42" width="84" height="1" fill="#ddd"/><rect x="8" y="50" width="84" height="1" fill="#ddd"/><rect x="58" y="62" width="34" height="8" rx="4" fill="${color}"/>`,
  }[id];
  return `<svg viewBox="0 0 100 84"><rect width="100" height="84" fill="#fff"/>${body}</svg>`;
}
function renderDesign() {
  const d = designNow();
  $('#design-templates').innerHTML = Object.entries(TEMPLATES).map(([id, t]) =>
    `<button data-template="${id}" class="${id === d.template ? 'on' : ''}" title="${t.name}">${templateSketch(id, ...sketchColors(id))}${t.name}</button>`).join('');
  const swatches = [...new Set([TEMPLATES[d.template].color, ...SWATCHES])];
  $('#design-swatches').innerHTML = swatches.map(c =>
    `<button data-color="${c}" style="background:${c}" class="${c === d.color.toLowerCase() ? 'on' : ''}" title="${c}"></button>`).join('')
    + `<label title="Pick any colour"><input type="color" id="design-custom" value="${d.color}"> Custom</label>`;
  // Colour two, for templates that use two colours
  const two = TWO_TONE[d.template];
  $('#design-two').hidden = !two;
  if (two) {
    const auto = rgbHex(secondColor({ ...d, color2: null }));
    const cur = d.color2 || auto;
    $('#design-two-what').textContent = two.label + (d.color2 ? '' : ' (automatic until you pick one)');
    $('#design-swatches2').innerHTML = `<button class="auto ${d.color2 ? '' : 'on'}" data-color2="" title="Automatic: ${auto}" style="--c:${auto}">Auto</button>`
      + [...new Set([d.color, ...SWATCHES])].map(c =>
        `<button data-color2="${c}" style="background:${c}" class="${c === d.color2 ? 'on' : ''}" title="${c}"></button>`).join('')
      + `<label title="Pick any colour"><input type="color" id="design-custom2" value="${cur}"> Custom</label>`;
  }
  $('#logo-box').innerHTML = logo ? `<img src="${logo.data}" alt="Your logo">` : '<span class="muted">No logo</span>';
  $('#logo-remove').hidden = !logo;
}
// Colours for a template's sketch: colour one, and colour two (yours, or its tone of colour one).
function sketchColors(id) {
  const d = resolveDesign({ template: id, colors: settings.design?.colors, colors2: settings.design?.colors2 });
  return [d.color, TWO_TONE[id] ? rgbHex(secondColor(d)) : null];
}
// Settings keep a colour one and (optionally) a colour two per template; '' for colour two means Auto.
function designWith(patch) {
  const d = designNow();
  const next = { template: d.template, colors: { ...(settings.design?.colors || {}) }, colors2: { ...(settings.design?.colors2 || {}) } };
  if (patch.template) next.template = patch.template;
  if (patch.color) next.colors[next.template] = patch.color;
  if ('color2' in patch) { if (patch.color2) next.colors2[next.template] = patch.color2; else delete next.colors2[next.template]; }
  return next;
}
function setDesign(patch) {
  settings.design = designWith(patch);
  persist('settings'); renderDesign(); refreshPreview(0);
}
$('#design-templates').onclick = e => { const b = e.target.closest('[data-template]'); if (b) setDesign({ template: b.dataset.template }); };
$('#design-swatches').onclick = e => { const b = e.target.closest('[data-color]'); if (b) setDesign({ color: b.dataset.color }); };
$('#design-swatches').addEventListener('input', e => {
  if (e.target.id !== 'design-custom') return;
  settings.design = designWith({ color: e.target.value });
  persist('settings'); refreshPreview(); // live while dragging; swatches re-render on change
});
$('#design-swatches').addEventListener('change', e => { if (e.target.id === 'design-custom') renderDesign(); });
$('#design-swatches2').onclick = e => { const b = e.target.closest('[data-color2]'); if (b) setDesign({ color2: b.dataset.color2 }); };
$('#design-swatches2').addEventListener('input', e => {
  if (e.target.id !== 'design-custom2') return;
  settings.design = designWith({ color2: e.target.value });
  persist('settings'); refreshPreview();
});
$('#design-swatches2').addEventListener('change', e => { if (e.target.id === 'design-custom2') renderDesign(); });
$('#logo-choose').onclick = async () => {
  if (!store.chooseLogo) return toast('Logos are only available in the desktop app.');
  const r = await store.chooseLogo();
  if (!r) return;
  if (r.error) return toast(r.error);
  const img = await loadLogoImage(r.data);
  if (!img) { await store.removeLogo(); return toast("Couldn't read that image. Try a PNG or JPG."); }
  logo = img; settings.logo = r.name; persist('settings');
  renderDesign(); refreshPreview(0);
};
$('#logo-remove').onclick = async () => {
  await store.removeLogo(); logo = null; settings.logo = ''; persist('settings');
  renderDesign(); refreshPreview(0);
};
const normItem = it => ({ kind: KINDS[it.kind] ? it.kind : 'fixed', desc: it.desc || '', qty: it.qty ?? 1, amount: it.amount ?? 0 });

// ---------- drafts ----------
const client = id => clients.find(c => c.id === id);
// Next invoice number = one past the highest number already saved in History,
// never lower than the "Next invoice number" setting (so you can skip ahead).
const numberOf = s => { const m = String(s || '').match(/(\d+)\D*$/); return m ? parseInt(m[1], 10) : NaN; };
// Invoices and quotes are numbered separately (INV-… and QUO-… by default).
const docType = h => (h.inv && h.inv.type) === 'quote' ? 'quote' : 'invoice';
function nextNumberValue(type = 'invoice') {
  const used = invoices.filter(h => docType(h) === type).map(h => numberOf(h.inv.number)).filter(n => !isNaN(n));
  const floor = type === 'quote' ? num(settings.nextQuoteNumber || 1) : num(settings.nextNumber);
  return Math.max(floor, used.length ? Math.max(...used) + 1 : 0);
}
const nextInvoiceNumber = (type = 'invoice') => (type === 'quote' ? (settings.quotePrefix ?? 'QUO-') : (settings.prefix || '')) + nextNumberValue(type);
const numberUsed = s => invoices.some(h => h.inv.number === s);

// Quotes default to being valid for 30 days; invoices are due after the client's payment terms.
function newDraft(clientId, type = 'invoice') {
  const c = client(clientId) || clients[0];
  const today = iso(new Date());
  return {
    type, clientId: c ? c.id : null, number: nextInvoiceNumber(type),
    date: today, due: type === 'quote' ? addDays(today, 30) : c ? addDays(today, c.dueDays) : today, period: today.slice(0, 7),
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
// Ctrl (⌘ on a Mac) + / − / 0 (the PDF viewer handles Ctrl+wheel itself until the next refresh).
const IS_MAC = (window.api && window.api.platform) === 'darwin';
const MOD = IS_MAC ? '⌘' : 'Ctrl+';
$$('.zoom [data-key]').forEach(b => { b.title += ` (${MOD}${b.dataset.key})`; });
window.addEventListener('keydown', e => {
  if (!(IS_MAC ? e.metaKey : e.ctrlKey) || e.altKey) return;
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
    const doc = buildPdf(pdfOptions({ me: settings.me || {}, c, inv: draft, lines: priced(draft.items, c), pageSize: settings.pageSize, design: settings.design }));
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
  const quote = draft.type === 'quote';
  $$('#doc-type button').forEach(b => b.classList.toggle('on', b.dataset.type === (quote ? 'quote' : 'invoice')));
  $('#inv-heading').textContent = quote ? 'New quote' : 'New invoice';
  $('#lbl-number').textContent = quote ? 'Quote no.' : 'Invoice no.';
  $('#lbl-date').textContent = quote ? 'Quote date' : 'Invoice date';
  $('#lbl-due').textContent = quote ? 'Valid until' : 'Due date';
  $('#download').textContent = quote ? 'Save quote' : 'Save invoice';
  $('#inv-number').value = draft.number; $('#inv-period').value = draft.period;
  $('#inv-date').value = draft.date; $('#inv-due').value = draft.due;
  renderItems();
}
// Switching between invoice and quote keeps the client and lines, with the right number and dates.
$('#doc-type').onclick = e => {
  const type = e.target.dataset.type;
  if (!type || type === (draft.type || 'invoice')) return;
  const items = draft.items, period = draft.period;
  draft = newDraft(draft.clientId, type); draft.items = items; draft.period = period;
  renderInvoice(); changed();
};
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
  const t = invoiceTotals(priced(draft.items, c), c);
  $('#inv-total').textContent = money(t.total, c.currency) + (t.tax ? ` (incl. ${settings.taxLabel || 'VAT'} ${money(t.tax, c.currency)})` : '');
}
function changed() { settings.draft = draft; persist('settings'); updateTotal(); refreshPreview(); }

$('#inv-client').onchange = e => {
  const keep = draft.number;
  draft = newDraft(e.target.value, draft.type); draft.number = keep;
  renderInvoice(); changed();
};
$('#inv-number').oninput = e => { draft.number = e.target.value; changed(); };
$('#inv-period').oninput = e => { draft.period = e.target.value; changed(); };
$('#inv-date').oninput = e => {
  draft.date = e.target.value;
  const c = client(draft.clientId);
  if (c && e.target.value) { draft.due = addDays(e.target.value, draft.type === "quote" ? 30 : c.dueDays); $('#inv-due').value = draft.due; }
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
$('#reset-draft').onclick =() => { draft = newDraft(draft.clientId, draft.type); renderInvoice(); changed(); };

function fileName(c, inv, me) {
  const p = parseDate((inv.period || inv.date.slice(0, 7)) + '-01');
  const word = inv.type === 'quote' ? 'Quote' : 'Invoice';
  return `${c.company || 'Client'} ${word} - ${MONTHS[p.getMonth()]} ${p.getFullYear()} - ${me.name || 'Me'}.pdf`.replace(/[\\/:*?"<>|]/g, '');
}

// History entries keep the design they were saved with (older ones have none, so they stay Classic).
const pdfBytes = entry => buildPdf(pdfOptions(entry)).output('arraybuffer');
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
    const shown = path.split(/[\\/]/).slice(-2).join(IS_MAC ? '/' : '\\'); // e.g. "Client\Client Invoice - ….pdf"
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
    design: clone(designNow()), taxLabel: settings.taxLabel || 'VAT', bank: clone(settings.bank || {}),
  };
  const t = invoiceTotals(entry.lines, entry.c);
  entry.total = t.total; entry.subtotal = t.subtotal; entry.tax = t.tax;
  if (docType(entry) === 'invoice') entry.tracked = true; // paid / overdue tracking (from 1.12.0)
  // Re-saving an invoice number that's already in History overwrites that same file.
  const previous = invoices.find(h => h.inv.number === entry.inv.number);
  entry.file = previous ? previous.file : '';
  if (previous) { entry.paidAt = previous.paidAt; entry.tracked = previous.tracked; }
  const path = await savePdf(entry);
  if (!path) return; // save failed (already reported)
  const idx = invoices.findIndex(h => h.inv.number === entry.inv.number);
  if (idx >= 0) invoices[idx] = entry; else invoices.unshift(entry);
  persist('invoices');
  settings.nextNumber = nextNumberValue('invoice');
  settings.nextQuoteNumber = nextNumberValue('quote');
  // Done: start the next one for the same client, of the same kind, with the following number.
  draft = newDraft(draft.clientId, draft.type);
  renderInvoice(); changed(); renderHistory(); renderMe(); renderOverdue();
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
  if (draft.type === 'quote') draft = newDraft(id, 'invoice'); // reminders are for invoices
  else if (draft.clientId !== id) { const keep = draft.number; draft = newDraft(id, 'invoice'); draft.number = keep; }
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
  if (!t.enabled) { el.className = 'drive-status'; el.textContent = 'The daily check is only set up by the installed app.'; }
  else if (t.problem && anyOn) { el.className = 'drive-status err'; el.textContent = t.problem; }
  else if (t.exists) { el.className = 'drive-status on'; el.textContent = `The daily reminder check is on. Next check: ${t.nextRun || 'unknown'}.`; }
  else if (anyOn) { el.className = 'drive-status err'; el.textContent = "Couldn't set up the daily reminder check, so reminders only appear while Invoicer is open."; }
  else { el.className = 'drive-status'; el.textContent = 'No reminders set, so nothing is scheduled.'; }
}
// How reminders work while Invoicer is closed, in this computer's terms.
$('#rem-how').textContent = IS_MAC
  ? 'Invoicer doesn\'t need to be open. While any client has a reminder or an invoice is unpaid, macOS runs a quick check every day at 9am and when you log in, using a launch agent called "local.invoicer.reminders". It’s removed once there are no reminders and no unpaid invoices. Overdue invoices are also reminded about the day after they’re due, then weekly until marked paid. If you delete Invoicer, turn your reminders off first.'
  : 'Invoicer doesn\'t need to be open. While any client has a reminder or an invoice is unpaid, a Windows Task Scheduler task called "Invoicer reminders" checks every day at 9am, or as soon as your PC is on if it was off then. It’s removed once there are no reminders and no unpaid invoices, or when you uninstall Invoicer. Overdue invoices are also reminded about the day after they’re due, then weekly until marked paid.';
async function setReminder(id, day) {
  const c = client(id); if (!c) return;
  c.reminderDay = day;
  persist('clients'); await flushSaves(); // saved now, so the scheduled check is updated straight away
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
  toast(r && r.error ? r.error : `Test notification sent. If you didn't see it, check ${IS_MAC ? 'System Settings → Notifications → Invoicer' : 'Windows Settings → System → Notifications'}.`);
};
$('#rem-all-off').onclick = async () => {
  if (!confirm('Turn off invoice reminders for every client? This also removes the daily reminder check.')) return;
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
// ---------- reports ----------
// Periods: South African tax years (1 March – end of February) and calendar years that have invoices.
function reportPeriods() {
  const years = new Set(invoices.filter(h => docType(h) === 'invoice').map(h => Number(h.inv.date.slice(0, 4))));
  const now = new Date(); years.add(now.getFullYear());
  const list = [];
  for (const y of [...years].sort((a, b) => b - a)) {
    list.push({ id: `tax-${y}`, label: `Tax year ${y}/${String(y + 1).slice(2)} (Mar ${y} – Feb ${y + 1})`, from: `${y}-03-01`, to: `${y + 1}-02-${(y + 1) % 4 === 0 ? 29 : 28}` });
    list.push({ id: `cal-${y}`, label: `Calendar year ${y}`, from: `${y}-01-01`, to: `${y}-12-31` });
  }
  // The tax year that started before 1 March belongs to the previous year's label.
  const ty = now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();
  if (!list.some(p => p.id === `tax-${ty}`)) list.unshift({ id: `tax-${ty}`, label: `Tax year ${ty}/${String(ty + 1).slice(2)} (Mar ${ty} – Feb ${ty + 1})`, from: `${ty}-03-01`, to: `${ty + 1}-02-${(ty + 1) % 4 === 0 ? 29 : 28}` });
  return { list, current: `tax-${ty}` };
}
function reportRows(p) {
  return invoices.filter(h => docType(h) === 'invoice' && h.inv.date >= p.from && h.inv.date <= p.to).map(h => {
    const subtotal = h.subtotal ?? round2((h.lines || []).reduce((s, l) => s + (Number(l.amount) || 0), 0));
    const tax = h.tax ?? round2((h.total || 0) - subtotal);
    return { h, cur: curCode(h.c.currency), subtotal, tax, total: Number(h.total) || 0, status: payStatus(h) };
  });
}
function renderReports() {
  const { list, current } = reportPeriods();
  const sel = $('#rep-period');
  const keep = sel.value;
  sel.innerHTML = list.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  sel.value = list.some(p => p.id === keep) ? keep : current;
  const p = list.find(x => x.id === sel.value);
  const rows = reportRows(p);
  $('#rep-range').textContent = `${shortDate(p.from)} ${p.from.slice(0, 4)} to ${shortDate(p.to)} ${p.to.slice(0, 4)} · ${rows.length} invoice${rows.length === 1 ? '' : 's'}`;
  if (!rows.length) { $('#rep-body').innerHTML = '<p class="muted">No invoices in this period.</p>'; return; }
  const sum = (arr, f) => round2(arr.reduce((s, r) => s + f(r), 0));
  const byCur = [...new Set(rows.map(r => r.cur))];
  const table = (head, body) => `<table class="report"><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  const tr = cells => `<tr>${cells.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`;
  const label = settings.taxLabel || 'VAT';
  let html = '<h3>Totals</h3>' + table(['Currency', 'Invoices', 'Excl. ' + label, label, 'Total', 'Paid', 'Outstanding'], byCur.map(cur => {
    const r = rows.filter(x => x.cur === cur);
    return tr([cur, r.length, money(sum(r, x => x.subtotal), cur), money(sum(r, x => x.tax), cur), `<b>${money(sum(r, x => x.total), cur)}</b>`,
      money(sum(r.filter(x => x.status.key === 'paid'), x => x.total), cur),
      money(sum(r.filter(x => x.status.key === 'unpaid' || x.status.key === 'overdue'), x => x.total), cur)]);
  }).join(''));
  const clientsIn = [...new Set(rows.map(r => `${r.h.c.company}\u0000${r.cur}`))];
  html += '<h3>By client</h3>' + table(['Client', 'Invoices', 'Total', 'Paid', 'Outstanding'], clientsIn.map(k => {
    const [name, cur] = k.split('\u0000'); const r = rows.filter(x => x.h.c.company === name && x.cur === cur);
    return tr([esc(name), r.length, money(sum(r, x => x.total), cur), money(sum(r.filter(x => x.status.key === 'paid'), x => x.total), cur),
      money(sum(r.filter(x => x.status.key === 'unpaid' || x.status.key === 'overdue'), x => x.total), cur)]);
  }).join(''));
  const months = [...new Set(rows.map(r => r.h.inv.date.slice(0, 7)))].sort();
  html += '<h3>By month</h3>' + table(['Month', ...byCur], months.map(m => {
    const d = parseDate(m + '-01');
    return tr([`${MONTHS[d.getMonth()]} ${d.getFullYear()}`, ...byCur.map(cur => money(sum(rows.filter(x => x.cur === cur && x.h.inv.date.startsWith(m)), x => x.total), cur))]);
  }).join(''));
  $('#rep-body').innerHTML = html;
}
$('#rep-period').onchange = renderReports;
$('#rep-csv').onclick = () => {
  const { list } = reportPeriods(); const p = list.find(x => x.id === $('#rep-period').value) || list[0];
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const lines = [['Invoice', 'Date', 'Due', 'Client', 'Currency', 'Excl. tax', 'Tax', 'Total', 'Status', 'Paid on'].join(',')]
    .concat(reportRows(p).map(r => [r.h.inv.number, r.h.inv.date, r.h.inv.due || '', r.h.c.company, r.cur, r.subtotal.toFixed(2), r.tax.toFixed(2), r.total.toFixed(2), r.status.key === 'untracked' ? '' : r.status.key, r.h.paidAt || ''].map(q).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
  a.download = `Invoicer report - ${p.label.replace(/[\\/:*?"<>|()]/g, '').replace(/\s+/g, ' ').trim()}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// ---------- paid / unpaid / overdue ----------
const todayIso = () => iso(new Date());
// Invoices saved from 1.12.0 on are tracked; older ones show "–" (but can still be marked paid).
function payStatus(h) {
  if (docType(h) === 'quote') return h.convertedTo ? { key: 'quote', label: `Invoiced (${h.convertedTo})` } : { key: 'quote', label: 'Quote' };
  if (h.paidAt) return { key: 'paid', label: `Paid ${shortDate(h.paidAt)}` };
  if (!h.tracked) return { key: 'untracked', label: '–' };
  if (h.inv.due && h.inv.due < todayIso()) return { key: 'overdue', label: 'Overdue' };
  return { key: 'unpaid', label: 'Unpaid' };
}
const overdueList = () => invoices.filter(h => payStatus(h).key === 'overdue');
function renderOverdue() {
  $('#overdue-bars').innerHTML = overdueList().map(h =>
    `<div class="update-bar remind overdue"><span><b>${esc(h.inv.number)}</b> for ${esc(h.c.company)} (${esc(money(h.total, h.c.currency))}) was due on ${esc(shortDate(h.inv.due))}.</span>
     <button class="btn primary" data-pay="${esc(h.id)}">Mark paid</button>
     <button class="btn" data-go-hist="1">History</button></div>`).join('');
}
function setPaid(id, paid) {
  const h = invoices.find(x => x.id === id); if (!h) return;
  h.paidAt = paid ? todayIso() : null;
  persist('invoices'); renderHistory(); renderOverdue();
  toast(paid ? `${h.inv.number} marked as paid` : `${h.inv.number} marked as unpaid`);
}
$('#overdue-bars').onclick = e => {
  if (e.target.dataset.pay) setPaid(e.target.dataset.pay, true);
  else if (e.target.dataset.goHist) go('history');
};

function renderHistory() {
  $('#hist-empty').style.display = invoices.length ? 'none' : '';
  const driveCell = h => h.backup
    ? `<button class="link ok" data-act="drive" data-id="${h.id}" title="Backed up to ${esc(h.backup)}. Click to show it.">✓ Drive</button>`
    : h.backupError !== undefined
      ? `<button class="link warn" data-act="backup" data-id="${h.id}" title="${esc(h.backupError)}. Click to retry.">⚠ Retry</button>`
      : '<span class="muted">–</span>';
  const statusCell = h => {
    const s = payStatus(h);
    const btn = docType(h) === 'quote'
      ? `<button class="link" data-act="convert" data-id="${h.id}" title="Start an invoice from this quote">Make invoice</button>`
      : h.paidAt ? `<button class="link" data-act="unpaid" data-id="${h.id}">Undo</button>`
        : `<button class="link" data-act="paid" data-id="${h.id}">Mark paid</button>`;
    return `<span class="status ${s.key}">${esc(s.label)}</span> ${btn}`;
  };
  $('#hist').innerHTML = invoices.map(h =>
    `<tr><td>${esc(h.inv.number)}</td><td>${esc(h.c.company)}</td><td>${esc(h.inv.date)}</td>
     <td class="num">${esc(money(h.total, h.c.currency))}</td>
     <td>${statusCell(h)}</td>
     <td>${driveCell(h)}</td>
     <td class="num">${h.file && window.api ? `<button class="btn" data-act="open" data-id="${h.id}">Open</button>` : ''}
     <button class="btn" data-act="pdf" data-id="${h.id}" title="Save this again (e.g. after editing your details)">Re-save</button>
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
  } else if (act === 'paid' || act === 'unpaid') {
    setPaid(id, act === 'paid');
  } else if (act === 'convert') {
    // A new invoice for the quote's client, with its lines; the quote remembers which invoice it became.
    draft = newDraft(client(h.c.id) ? h.c.id : undefined, 'invoice');
    draft.items = clone(h.inv.items).map(normItem);
    h.convertedTo = draft.number; persist('invoices'); renderHistory();
    renderInvoice(); changed(); go('invoice');
    toast(`Started ${draft.number} from quote ${h.inv.number}. Check it and click Save invoice.`);
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
  if (tab === 'reports') renderReports();
  if (tab === 'history') renderHistory();
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
  settings.taxLabel ||= 'VAT'; settings.quotePrefix ??= 'QUO-'; settings.nextQuoteNumber ||= 1;
  if (settings.logo && store.loadLogo) logo = await loadLogoImage(await store.loadLogo(settings.logo));
  if (settings.bank?.logo && store.loadLogo) bankLogo = await loadLogoImage(await store.loadLogo(settings.bank.logo));
  renderDesign(); renderBank();
  draft = settings.draft && client(settings.draft.clientId)
    ? { ...settings.draft, items: settings.draft.items.map(normItem) }
    : newDraft();
  // A leftover draft whose number was already saved gets the next free number.
  if (numberUsed(draft.number)) draft.number = nextInvoiceNumber(draft.type || "invoice");
  editingClient = clients[0]?.id;
  renderInvoice(); renderClients(); renderMe(); renderHistory(); renderOverdue(); renderZoom(); refreshPreview();
  if (store.version) $('#app-version').textContent = 'v' + await store.version();
  renderUpdates();
  if (store.cloudStatus) {
    store.onCloudStatus(renderCloud);
    // Newer data arrived from another computer: reload to show it (pending local edits are dropped,
    // since the synced copy already includes everything that was saved).
    store.onDataChanged(() => { Object.keys(timers).forEach(k => { clearTimeout(timers[k]); timers[k] = null; }); location.reload(); });
    renderCloud(await store.cloudStatus());
  } else renderCloud({ configured: false });
  checkForUpdate();
  setInterval(checkForUpdate, 30 * 60 * 1000);
  await refreshBackupStatus();
  retryPendingBackups();
  setInterval(retryPendingBackups, 10 * 60 * 1000);
  window.addEventListener('online', retryPendingBackups);
  if (store.dueReminders) {
    // Main sends this whenever clients or invoices are saved, and on each check.
    store.onReminders(due => { renderReminders(due); if (tabShown('notifications')) renderNotifications(); });
    store.onReminderOpen(id => id === 'history' ? go('history') : invoiceClient(id));
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

// ---------- account & cloud sync ----------
const ago = iso => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};
let cloudState = { configured: false };
function renderCloud(s) {
  cloudState = s || cloudState;
  const c = cloudState, el = $('#cloud-status'), pill = $('#cloud-pill');
  if (!c.configured) { el.className = 'drive-status'; el.textContent = 'Sign-in is only available in the desktop app.'; $('#cloud-signin').hidden = true; $('#cloud-cancel').hidden = true; pill.hidden = true; return; }
  const waiting = c.busy === 'signing-in';
  $('#cloud-signin').hidden = c.signedIn;
  $('#cloud-signin').textContent = waiting ? 'Open the sign-in page again' : 'Sign in with Google';
  $('#cloud-cancel').hidden = !waiting;
  for (const id of ['#cloud-sync', '#cloud-signout', '#cloud-delete']) $(id).hidden = !c.signedIn;
  $('#cloud-sync').disabled = !!c.busy;
  if (!c.signedIn) {
    el.className = 'drive-status' + (c.error ? ' err' : '');
    el.textContent = waiting ? 'Finish signing in with Google in your browser. Closed that tab? Open it again, or Cancel.' : c.error ? `Not signed in. ${c.error}` : 'Not signed in. Your data is only on this computer.';
    pill.hidden = true;
    return;
  }
  const when = c.busy ? 'syncing now…' : `last synced ${ago(c.lastSync)}`;
  el.className = 'drive-status ' + (c.error ? 'err' : 'on');
  el.textContent = `Signed in as ${c.email}, ${when}.` + (c.pending && !c.busy ? ` ${c.pending} change${c.pending === 1 ? '' : 's'} waiting to upload.` : '') + (c.error ? ` Problem: ${c.error}` : '');
  pill.hidden = false;
  pill.className = 'cloud-pill' + (c.error ? ' err' : '');
  pill.textContent = c.error ? '⚠ Sync problem' : c.busy ? '↻ Syncing…' : '☁ Synced';
  pill.title = el.textContent;
}
$('#cloud-pill').onclick = () => { go('me'); $('#account').scrollIntoView({ behavior: 'smooth' }); };
$('#privacy-link').onclick = e => { e.preventDefault(); store.openExternal && store.openExternal(e.target.href); };
$('#cloud-signin').onclick = async () => {
  await flushSaves();
  const r = await store.cloudSignIn();
  if (r && r.error) { if (!/cancelled/i.test(r.error)) toast(r.error); }
  else toast('Signed in. Your data is now backed up to your account.');
  renderCloud(await store.cloudStatus());
};
$('#cloud-cancel').onclick = async () => { await store.cloudCancelSignIn(); renderCloud(await store.cloudStatus()); };
$('#cloud-sync').onclick = async () => { await flushSaves(); const r = await store.cloudSync(); if (r && r.error) toast(r.error); };
$('#cloud-signout').onclick = async () => {
  if (!confirm('Sign out? Your data stays on this computer and in your account; it just stops syncing.')) return;
  await flushSaves(); await store.cloudSignOut(); renderCloud(await store.cloudStatus());
};
$('#cloud-delete').onclick = async () => {
  if (!confirm('Delete your Invoicer data from the cloud and sign out?\n\nYour clients, settings and invoice history are removed from your account. Everything on this computer stays as it is. This can\'t be undone.')) return;
  const r = await store.cloudDelete();
  toast(r && r.error ? `Couldn't delete: ${r.error}` : 'Your cloud data was deleted and you are signed out.');
  renderCloud(await store.cloudStatus());
};
setInterval(() => renderCloud(), 30 * 1000); // keeps "last synced … ago" current

// ---------- updates settings ----------
async function renderUpdates() {
  if (!store.updateInfo) { $('#upd-status').textContent = 'Updates are only available in the desktop app.'; return; }
  const s = await store.updateInfo();
  $('#upd-repo').textContent = s.repo || '';
  $('#upd-status').className = 'drive-status on';
  $('#upd-status').textContent = `You have Invoicer ${s.version}.`;
}
$('#upd-releases').onclick = () => store.openReleases && store.openReleases();
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
