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
    return { clients: g('clients') || [], settings: g('settings') || { me: {}, prefix: 'INV-', nextNumber: 1, pageSize: 'letter' }, invoices: g('invoices') || [],
      stock: g('stock') || [], stockmoves: g('stockmoves') || [], dataDir: '(browser storage)' };
  },
  async save(k, v) { localStorage.setItem('invoicer.' + k, JSON.stringify(v)); },
  async saveInvoice(bytes, client, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); a.download = name; a.click(); return { path: name };
  },
  async open() {}, async showInFolder() {}, async openDataDir() {},
};

let clients = [], settings = {}, invoices = [], draft = null, dataDir = '';
let stock = [], stockMoves = []; // stock items, and every change to their counts (see stock.js)
const dataOf = name => ({ clients, settings, invoices, stock, stockmoves: stockMoves }[name]);

// ---------- persistence (debounced per file) ----------
const timers = {};
// base[name]: the data as this window last saved or received it. Changes from your team are merged
// against it, so whatever you've changed since (even if not saved yet) is kept.
const base = {};
function persist(name) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => {
    timers[name] = null;
    const value = dataOf(name);
    base[name] = clone(value);
    store.save(name, value).catch(e => toast('Could not save ' + name + ': ' + e.message));
  }, 300);
}
// Write any pending saves right now (used before switching data folders).
async function flushSaves() {
  const pending = Object.keys(timers).filter(k => timers[k]);
  pending.forEach(k => { clearTimeout(timers[k]); timers[k] = null; });
  pending.forEach(k => { base[k] = clone(dataOf(k)); });
  await Promise.all(pending.map(k => store.save(k, dataOf(k))));
}

// ---------- pricing ----------
// "item" is a quantity at a price of its own (e.g. 4 × doors @ R1,200), for itemised quotes.
const KINDS = { hours: 'Hours', days: 'Days', daysoff: 'Days off', item: 'Item', fixed: 'Fixed' };
const dayOffRate = c => (c.dayOffRate === '' || c.dayOffRate == null) ? num(c.dailyRate) : num(c.dayOffRate);
const rateFor = (kind, c) => ({ hours: num(c.hourlyRate), days: num(c.dailyRate), daysoff: dayOffRate(c) }[kind] ?? 0);

function lineAmount(it, c) {
  const q = num(it.qty);
  switch (it.kind) {
    case 'hours': return round2(q * num(c.hourlyRate));
    case 'days': return round2(q * num(c.dailyRate));
    case 'daysoff': return round2(-q * dayOffRate(c));
    case 'item': return round2(q * num(it.price));
    default: return round2(num(it.amount));
  }
}
function lineDetail(it, c) {
  const q = num(it.qty), cur = c.currency || '';
  const plural = (w) => q === 1 ? w : w + 's';
  if (it.kind === 'hours') return `${q} ${plural('hr')} @ ${money(c.hourlyRate, cur)}/hr`;
  if (it.kind === 'days') return `${q} ${plural('day')} @ ${money(c.dailyRate, cur)}/day`;
  if (it.kind === 'daysoff') return `${q} ${plural('day')} × ${money(dayOffRate(c), cur)}`;
  if (it.kind === 'item') return `${skuPrefix(it)}${q}${it.unit ? ' ' + it.unit : ''} × ${money(it.price, cur)}`;
  return '';
}
// A stock line can show its item code before the quantity, e.g. "DR-200 · 4 × R1,200.00".
const skuPrefix = it => it.sku && settings.stockShowSku !== false ? `${it.sku} · ` : '';
// All the lines of an invoice or quote: its priced lines, then any discount on the whole invoice
// (inv.discount = { pct, reason }) as a last line, a percentage of everything above it, before tax.
function docLines(inv, c) {
  const lines = priced(inv.items || [], c);
  const d = inv.discount || {}, pct = Math.min(100, num(d.pct));
  const base = round2(lines.reduce((s, l) => s + num(l.amount), 0));
  const saving = pct > 0 && base > 0 ? round2(base * pct / 100) : 0;
  if (saving) lines.push({ desc: `Discount (${pct}%)${d.reason ? ': ' + d.reason : ''}`, detail: `on ${money(base, c.currency)}`,
    qty: '', price: '', amount: -saving, discount: true, whole: true });
  return lines;
}
// A line can have a discount: a percentage of the line (disc 'pct') or a whole amount ('amt').
// Returns the saving as a positive number, never more than the line itself.
function lineDiscount(it, c) {
  const base = lineAmount(it, c), v = num(it.discValue);
  if (!it.disc || v <= 0 || base <= 0) return 0;
  return Math.min(base, round2(it.disc === 'pct' ? base * Math.min(v, 100) / 100 : v));
}
const discLabel = it => it.disc === 'pct' ? `Discount (${num(it.discValue)}%)` : 'Discount';
// The detail without the rate, for when rates are hidden: "2.5 hrs", "3 days", "Qty 4".
function lineBrief(it) {
  const q = num(it.qty), s = (one, many) => `${q} ${q === 1 ? one : many}`;
  return { hours: s('hr', 'hrs'), days: s('day', 'days'), daysoff: s('day', 'days'), item: skuPrefix(it) + (it.unit ? `${q} ${it.unit}` : `Qty ${q}`) }[it.kind] || '';
}
// Lines as they appear on the PDF (zero-value lines dropped). A discount is a line of its own straight
// under the line it's for, showing the saving, so the total is worked out after it's taken off.
// qty and price feed the templates with Qty / Price columns (days off show a negative price; a discount none).
function priced(items, c) {
  return items.flatMap(it => {
    const amount = lineAmount(it, c);
    if (amount === 0) return [];
    const fixed = it.kind === 'fixed';
    const price = fixed ? amount : it.kind === 'item' ? num(it.price) : (it.kind === 'daysoff' ? -1 : 1) * rateFor(it.kind, c);
    const out = [{ desc: it.desc, detail: lineDetail(it, c), brief: lineBrief(it), qty: fixed ? 1 : num(it.qty), price, amount, unit: it.kind }];
    const saving = lineDiscount(it, c);
    if (saving) out.push({ desc: discLabel(it), detail: it.desc ? `on ${it.desc}` : '', qty: '', price: '', amount: -saving, discount: true });
    return out;
  });
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
// A line added from Stock is an item line that also has stockId (and the item's code and unit).
const normItem = it => ({ kind: KINDS[it.kind] ? it.kind : 'fixed', desc: it.desc || '', qty: it.qty ?? 1, amount: it.amount ?? 0, price: it.price ?? 0,
  disc: ['pct', 'amt'].includes(it.disc) ? it.disc : '', discValue: it.discValue ?? 0,
  ...(it.stockId && it.kind === 'item' ? { stockId: it.stockId, sku: it.sku || '', unit: it.unit || '' } : {}) });

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
    type, clientId: c ? c.id : null, number: nextInvoiceNumber(type), private: !!(c && c.private),
    date: today, due: type === 'quote' ? addDays(today, 30) : c ? addDays(today, c.dueDays) : today, period: today.slice(0, 7),
    items: c && c.items && c.items.length ? clone(c.items).map(normItem) : [normItem({ kind: 'fixed' })],
    hideRates: !!settings.hideRates, // as you last chose
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
// ---------- what the preview shows on each tab ----------
// New invoice: the invoice being drafted. Clients: an example invoice for the selected client, cropped
// to the top (your header, their details and the lines). My details: an example invoice cropped to its
// top (your details, logo and design) and bottom (banking details and notes). History: the invoice
// you pick. The other tabs use the whole window and have no preview.
const PREVIEW_TABS = ['invoice', 'clients', 'me', 'history'];
let currentTab = 'invoice', histPick = null;
const previewUrls = [];
// The PDF with its first page narrowed to part of the page (from / to: fractions from the top).
function croppedUrl(doc, from, to) {
  let s = doc.output();
  s = s.replace(/\/MediaBox \[([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)\]/, (m, x0, y0, w, h) => {
    const H = Number(h);
    return `/MediaBox [0 ${(H * (1 - to)).toFixed(2)} ${Number(w).toFixed(2)} ${(H * (1 - from)).toFixed(2)}]`.padEnd(m.length, ' '); // same length: nothing else moves
  });
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 255;
  return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
}
// An example invoice: the client's default lines, or one line priced from their rates.
function sampleInvoice(c) {
  const today = iso(new Date());
  const items = c.items && c.items.length ? c.items.map(normItem)
    : [num(c.dailyRate) ? normItem({ kind: 'days', desc: 'Example: days worked', qty: 5 })
      : num(c.hourlyRate) ? normItem({ kind: 'hours', desc: 'Example: hours worked', qty: 10 })
      : normItem({ kind: 'fixed', desc: 'Example line', amount: 1000 })];
  return { type: 'invoice', number: nextInvoiceNumber('invoice'), date: today, due: addDays(today, c.dueDays || 14), period: today.slice(0, 7), items, hideRates: !!settings.hideRates };
}
const sampleClient = () => ({ id: 'sample', company: 'Your client', contacts: 'Their contact', address: 'Their address\nTheir city', currency: usualCurrency(), dueDays: 14, items: [] });
const draftOptions = (c, inv) => pdfOptions({ me: settings.me || {}, c, inv, lines: docLines(inv, c), pageSize: settings.pageSize, design: settings.design });
function showPreview(frames, { caption = '', empty = '', zoom = false } = {}) {
  const box = $('.preview');
  box.classList.toggle('split', frames.length > 1);
  $('#preview-empty').hidden = !empty; $('#preview-empty').textContent = empty;
  $('#preview-cap').hidden = !caption; $('#preview-cap').textContent = caption;
  $('.zoom').hidden = !zoom;
  const old = previewUrls.splice(0);
  [$('#preview'), $('#preview2')].forEach((f, i) => {
    const fr = frames[i];
    f.hidden = !fr;
    if (!fr) { f.removeAttribute('src'); return; }
    f.title = fr.title || 'Preview';
    f.src = `${fr.url}#${fr.view || previewView()}&toolbar=0&navpanes=0`;
    previewUrls.push(fr.url);
  });
  setTimeout(() => old.forEach(u => URL.revokeObjectURL(u)), 2000);
}
function refreshPreview(delay = 250) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const tab = currentTab;
    if (!PREVIEW_TABS.includes(tab)) return;
    if (tab === 'invoice') {
      const c = client(draft.clientId);
      if (!c) return showPreview([], { empty: 'Add a client on the Clients tab to start an invoice.' });
      return showPreview([{ url: buildPdf(draftOptions(c, draft)).output('bloburl'), title: 'Invoice preview' }], { zoom: true });
    }
    if (tab === 'clients') {
      const c = client(editingClient);
      if (!c) return showPreview([], { empty: 'Add a client to see how they appear on your invoices.' });
      return showPreview([{ url: croppedUrl(buildPdf(draftOptions(c, sampleInvoice(c))), 0, 0.62), view: 'view=FitH', title: 'How this client appears on an invoice' }],
        { caption: `How ${c.company || 'this client'} appears on an invoice${c.items && c.items.length ? ', with their default lines' : ' (example line)'}` });
    }
    if (tab === 'me') {
      const c = sampleClient(), doc = buildPdf(draftOptions(c, sampleInvoice(c)));
      return showPreview([
        { url: croppedUrl(doc, 0, 0.4), view: 'view=FitH', title: 'Top of your invoices' },
        { url: croppedUrl(doc, 0.58, 1), view: 'view=FitH', title: 'Bottom of your invoices' },
      ], { caption: 'Your details, logo and design (top) and banking details and notes (bottom), on an example invoice' });
    }
    const h = invoices.find(x => x.id === histPick);
    if (!h) return showPreview([], { empty: invoices.length ? 'Click an invoice or quote to see it here.' : 'Saved invoices and quotes appear here.' });
    showPreview([{ url: buildPdf(pdfOptions(h)).output('bloburl'), title: `${h.inv.number} preview` }], { zoom: true });
  }, delay);
}

// ---------- invoice tab ----------
function renderClientOptions() {
  const opts = clients.map(c => `<option value="${c.id}">${c.private ? '🔒 ' : ''}${esc(c.company || '(unnamed)')}</option>`).join('');
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
  const quote = draft.type === 'quote', editing = !!draft.editing;
  $$('#doc-type button').forEach(b => { b.classList.toggle('on', b.dataset.type === (quote ? 'quote' : 'invoice')); b.disabled = editing; });
  $('#inv-heading').textContent = editing ? `Editing ${draft.editing}` : quote ? 'New quote' : 'New invoice';
  // While editing, the number, client and type stay as saved, so it replaces the right one.
  $('#edit-bar').hidden = !editing; $('#edit-what').textContent = draft.editing || '';
  $('#inv-number').readOnly = editing; $('#inv-client').disabled = editing;
  $('#reset-draft').hidden = editing;
  $('#lbl-number').textContent = quote ? 'Quote no.' : 'Invoice no.';
  $('#lbl-date').textContent = quote ? 'Quote date' : 'Invoice date';
  $('#lbl-due').textContent = quote ? 'Valid until' : 'Due date';
  $('#download').textContent = editing ? 'Save changes' : quote ? 'Save quote' : 'Save invoice';
  $('#inv-private').checked = !!draft.private;
  $('#inv-private-label').textContent = teamState.team ? `Personal: don't share this with ${teamState.team.name}` : "Personal: don't share this with a team";
  $('#inv-number').value = draft.number; $('#inv-period').value = draft.period;
  $('#inv-date').value = draft.date; $('#inv-due').value = draft.due;
  $('#inv-show-rates').checked = !draft.hideRates;
  $('#inv-disc-on').nextSibling.textContent = quote ? ' Discount on the whole quote' : ' Discount on the whole invoice';
  renderWholeDiscount();
  renderItems();
}
// ---------- editing a saved invoice or quote ----------
// Edit in History loads it here with its own number, client, dates and lines (draft.editing is its
// number). Saving replaces it in History and its PDF file, keeping its paid status. Whatever you were
// drafting is put aside (settings.putAside) and comes back when you save or cancel.
function leaveEditing() { // false if you'd rather keep editing
  if (!draft.editing) return true;
  if (!confirm(`Stop editing ${draft.editing}? Changes you haven't saved are lost; the saved one stays as it was.`)) return false;
  restoreDraft();
  return true;
}
function restoreDraft() {
  const back = settings.putAside;
  delete settings.putAside;
  draft = back && client(back.clientId) ? { ...back, items: back.items.map(normItem) } : newDraft(draft.clientId, draft.type);
  delete draft.editing;
  if (numberUsed(draft.number)) draft.number = nextInvoiceNumber(draft.type || 'invoice');
}
function editSaved(h) {
  const c = client(h.c && h.c.id);
  if (!c) return toast(`${h.c.company} isn't one of your clients any more, so ${h.inv.number} can't be edited. Use Copy to start a new one for another client.`);
  if (draft.editing === h.inv.number) return go('invoice');
  if (!leaveEditing()) return;
  const what = docType(h) === 'quote' ? 'quote' : 'invoice';
  if (h.paidAt && !confirm(`${h.inv.number} is marked as paid. Edit it anyway?`)) return;
  settings.putAside = clone(draft);
  draft = { ...clone(h.inv), items: (h.inv.items || []).map(normItem), private: !!h.private, editing: h.inv.number };
  // Hours and days are priced from the client's rates as they are now.
  const moved = ['currency', 'hourlyRate', 'dailyRate', 'dayOffRate', 'taxRate'].filter(k => String(h.c[k] ?? '') !== String(c[k] ?? ''));
  renderInvoice(); changed(); go('invoice');
  toast(moved.length
    ? `Editing ${h.inv.number}. ${c.company}'s rates or tax have changed since it was saved, so it's priced at today's: check the total before saving.`
    : `Editing ${h.inv.number}. Make your changes and click Save changes to update the ${what}.`);
}
$('#edit-cancel').onclick = () => {
  const n = draft.editing;
  restoreDraft(); renderInvoice(); changed();
  toast(`${n} is unchanged.`);
};

// Switching between invoice and quote keeps the client and lines, with the right number and dates.
$('#doc-type').onclick = e => {
  const type = e.target.dataset.type;
  if (!type || type === (draft.type || 'invoice')) return;
  const items = draft.items, period = draft.period, discount = draft.discount;
  const priv = draft.private;
  draft = newDraft(draft.clientId, type); draft.items = items; draft.period = period; draft.private = priv;
  if (discount) draft.discount = discount;
  renderInvoice(); changed();
};
function renderItems() {
  const box = $('#inv-items');
  liveStockRows = [];
  box.innerHTML = '<div class="hd">Type</div><div class="hd">Description</div><div class="hd">Qty</div><div class="hd">Amount</div><div></div><div></div>';
  const c = client(draft.clientId) || {};
  draft.items.forEach((it, i) => {
    const kind = document.createElement('select');
    kind.innerHTML = Object.entries(KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    kind.value = it.kind;
    // The description wraps and grows as you type, so a long one stays readable.
    const desc = document.createElement('textarea'); desc.rows = 1; desc.className = 'desc'; desc.value = it.desc; desc.placeholder = 'e.g. Frontend Development';
    const grow = () => { desc.style.height = 'auto'; desc.style.height = desc.scrollHeight + 2 + 'px'; };
    const qty = document.createElement('input'); qty.type = 'number'; qty.step = '0.25'; qty.min = '0'; qty.value = it.qty;
    const amt = document.createElement('input'); amt.type = 'number'; amt.step = '0.01';
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove line';
    const pct = document.createElement('button'); pct.className = 'disc-btn'; pct.textContent = '%';
    const stockRow = it.stockId ? stockLineRow(it) : null;
    // The line's discount, in a row of its own under it: a value, % or a whole amount, and the saving.
    let disc = null;
    if (it.disc) {
      disc = document.createElement('div'); disc.className = 'disc-row';
      disc.innerHTML = `<span>Discount</span><input type="number" min="0" step="0.01">
        <select><option value="pct">%</option><option value="amt">${esc(curSymbol(c.currency || ''))}</option></select>
        <span class="disc-saving"></span><button class="x" title="Remove the discount">×</button>`;
      const [dv, dt] = [disc.querySelector('input'), disc.querySelector('select')];
      dv.value = it.discValue || ''; dt.value = it.disc;
      dv.oninput = () => { it.discValue = parseFloat(dv.value) || 0; sync(); changed(); };
      dt.onchange = () => { it.disc = dt.value; sync(); changed(); };
      disc.querySelector('.x').onclick = () => { it.disc = ''; it.discValue = 0; renderItems(); changed(); };
    }
    pct.onclick = () => {
      if (!it.disc) { it.disc = 'pct'; it.discValue = 0; renderItems(); changed(); }
      $$('#inv-items .disc-row input')[draft.items.filter((d, k) => k <= i && d.disc).length - 1]?.focus();
    };
    // Fixed: you type the amount. Item: you type the quantity and the price of one. Others: priced from the client's rates.
    const sync = () => {
      pct.hidden = it.kind === 'daysoff' && !it.disc; // a reduction already
      pct.classList.toggle('on', !!it.disc);
      pct.title = it.disc ? 'This line has a discount' : 'Add a discount to this line (a percentage or a whole amount)';
      if (disc) {
        const saving = lineDiscount(it, c);
        disc.querySelector('.disc-saving').textContent = saving ? `Saving ${money(saving, c.currency)} · line ${money(lineAmount(it, c) - saving, c.currency)}` : 'No saving yet';
      }
      const fixed = it.kind === 'fixed', item = it.kind === 'item';
      qty.disabled = fixed; qty.style.visibility = fixed ? 'hidden' : '';
      amt.readOnly = !fixed && !item;
      if (document.activeElement !== amt) amt.value = fixed ? it.amount : item ? it.price : lineAmount(it, c).toFixed(2);
      amt.placeholder = item ? 'Price each' : '';
      amt.title = fixed ? '' : item ? `Price of one. Line total ${money(lineAmount(it, c), c.currency)}` : lineDetail(it, c);
    };
    kind.onchange = () => {
      const was = it.kind; it.kind = kind.value;
      if (it.kind !== 'item' && it.stockId) { delete it.stockId; delete it.sku; delete it.unit; renderItems(); changed(); return; }
      if (!it.desc || it.desc === 'Days off') it.desc = it.kind === 'daysoff' ? 'Days off' : (was === 'daysoff' ? '' : it.desc);
      desc.value = it.desc;
      if (it.kind !== 'fixed' && !num(it.qty)) it.qty = 1;
      if (it.kind === 'item' && was === 'fixed' && !num(it.price)) it.price = it.amount; // keep what was typed
      qty.value = it.qty;
      if (!['fixed', 'item'].includes(it.kind) && !rateFor(it.kind, c)) toast(`${c.company || 'This client'} has no ${KINDS[it.kind].toLowerCase()} rate set`);
      sync(); changed();
    };
    desc.oninput = () => { it.desc = desc.value; grow(); changed(); };
    qty.oninput = () => { it.qty = parseFloat(qty.value) || 0; sync(); if (stockRow) stockRow.update(); changed(); };
    amt.oninput = () => {
      if (it.kind === 'fixed') it.amount = parseFloat(amt.value) || 0;
      else if (it.kind === 'item') { it.price = parseFloat(amt.value) || 0; sync(); }
      else return;
      changed();
    };
    x.onclick = () => { draft.items.splice(i, 1); renderItems(); changed(); };
    sync();
    box.append(kind, desc, qty, amt, pct, x);
    requestAnimationFrame(grow); // once it's on screen and has a width
    if (stockRow) box.append(stockRow.el);
    if (disc) box.append(disc);
  });
  updateTotal();
}
function updateTotal() {
  const c = client(draft.clientId) || {};
  const lines = docLines(draft, c), t = invoiceTotals(lines, c);
  $('#inv-total').textContent = money(t.total, c.currency) + (t.tax ? ` (incl. ${settings.taxLabel || 'VAT'} ${money(t.tax, c.currency)})` : '');
  const whole = lines.find(l => l.whole);
  $('#inv-disc-saving').textContent = whole ? `Saving ${money(-whole.amount, c.currency)} ${whole.detail}, before ${settings.taxLabel || 'VAT'}` : 'Type a percentage to see the saving.';
}
function changed() { settings.draft = draft; persist('settings'); updateTotal(); refreshPreview(); }

// Show or hide the rates on this PDF; new invoices and quotes start the way you last chose.
$('#inv-show-rates').onchange = e => { draft.hideRates = !e.target.checked; settings.hideRates = draft.hideRates; changed(); };

// ---------- discount on the whole invoice ----------
function renderWholeDiscount() {
  const d = draft.discount;
  $('#inv-disc-on').checked = !!d; $('#inv-disc').hidden = !d;
  setVal($('#inv-disc-pct'), d && d.pct ? d.pct : '');
  setVal($('#inv-disc-reason'), d ? d.reason || '' : '');
}
$('#inv-disc-on').onchange = e => {
  if (e.target.checked) draft.discount = { pct: 0, reason: '' }; else delete draft.discount;
  renderWholeDiscount(); changed();
  if (e.target.checked) $('#inv-disc-pct').focus();
};
$('#inv-disc-pct').oninput = e => { (draft.discount ||= { reason: '' }).pct = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)); changed(); };
$('#inv-disc-reason').oninput = e => { (draft.discount ||= { pct: 0 }).reason = e.target.value; changed(); };

$('#inv-client').onchange = e => {
  const keep = draft.number;
  draft = newDraft(e.target.value, draft.type); draft.number = keep;
  renderInvoice(); changed();
};
$('#inv-number').oninput = e => { draft.number = e.target.value; changed(); };
$('#inv-private').onchange = e => { draft.private = e.target.checked; changed(); };
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

// ---------- Invoice backup (Google Drive / OneDrive sync folder, or any folder) ----------
let backupState = { ready: false };
// Before 1.16 a chosen folder meant "not Google Drive", so treat it as "other".
const backupProvider = () => settings.backupProvider || (settings.backupDir ? 'other' : 'google');
// backupSharedDrive is the name of a Google shared drive; empty means My Drive.
const backupShared = () => backupProvider() === 'google' ? settings.backupSharedDrive || '' : '';
// backupFolder is the folder inside Google Drive or OneDrive, e.g. "Finance/Invoices"; empty means "Invaro Backups".
const backupFolder = () => backupProvider() === 'other' ? '' : settings.backupFolder || '';
const backupSel = () => ({ provider: backupProvider(), dir: settings.backupDir || '', shared: backupShared(), folder: backupFolder() });
const backupWhere = () => backupShared() ? `the "${backupShared()}" shared drive`
  : ({ google: 'Google Drive', onedrive: 'OneDrive', other: 'your backup folder' })[backupProvider()];

// Copies the invoice into the backup folder. Records the result on the history entry; returns true on success.
async function backupPdf(entry, bytes) {
  if (!store.backupWrite) return false;
  const res = await store.backupWrite(bytes || pdfBytes(entry), backupName(entry), backupSel(), entry.c.company);
  if (res && !res.error) {
    entry.backup = res.path; entry.backupError = null; entry.backedUpAt = new Date().toISOString();
    return true;
  }
  entry.backup = null; entry.backupError = (res && res.error) || 'Backup failed';
  refreshBackupStatus();
  return false;
}

// Retries any invoices whose backup failed earlier (e.g. Google Drive or OneDrive wasn't running).
let retrying = false;
async function retryPendingBackups() {
  if (retrying) return;
  if (store.backupStatus) backupState = await store.backupStatus(backupSel());
  if (!backupState.ready) return;
  const pending = invoices.filter(h => !h.backup && h.backupError !== undefined);
  if (!pending.length) return;
  retrying = true;
  let ok = 0;
  for (const h of pending) if (await backupPdf(h)) ok++;
  retrying = false;
  persist('invoices'); renderHistory(); refreshBackupStatus();
  if (ok) toast(`Backed up ${ok} invoice${ok === 1 ? '' : 's'} to ${backupWhere()}`);
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
    if (await backupPdf(entry, bytes)) toast(`Saved to ${shown} and backed up to ${backupWhere()}`, 'Open', () => store.open(path));
    else toast(`Saved to ${shown}, but NOT backed up: ${entry.backupError}. It will retry automatically.`, 'Open', () => store.open(path));
  }
  return path;
}

$('#download').onclick = async () => {
  const c = client(draft.clientId);
  if (!c) return toast('Add a client first');
  const entry = {
    id: uid(), savedAt: new Date().toISOString(), pageSize: settings.pageSize,
    inv: clone(draft), c: clone(c), me: clone(settings.me || {}), lines: docLines(draft, c),
    design: clone(designNow()), taxLabel: settings.taxLabel || 'VAT', bank: clone(settings.bank || {}),
  };
  const t = invoiceTotals(entry.lines, entry.c);
  entry.total = t.total; entry.subtotal = t.subtotal; entry.tax = t.tax;
  if (docType(entry) === 'invoice') entry.tracked = true; // paid / overdue tracking (from 1.12.0)
  entry.private = !!draft.private; delete entry.inv.private; // personal: never shared with a team
  const editing = draft.editing; delete entry.inv.editing;
  // Re-saving an invoice number that's already in History (e.g. after Edit) overwrites that same file.
  const previous = invoices.find(h => h.inv.number === entry.inv.number);
  entry.file = previous ? previous.file : '';
  if (previous) {
    entry.paidAt = previous.paidAt; entry.tracked = previous.tracked;
    if (previous.convertedTo) entry.convertedTo = previous.convertedTo; // a quote remembers its invoice
    // Its exchange rates (for the day it was marked paid) stay while the currency does.
    if (previous.fx && curCode(previous.c.currency) === curCode(entry.c.currency)) entry.fx = previous.fx;
    const steps = carryPaidSteps(previous, entry.lines);
    if (steps) entry.paidSteps = steps;
  }
  if (!stockOkToSave(entry)) return;
  if (teamState.team && !previous && !(await claimNumber(entry))) return;
  const path = await savePdf(entry);
  if (!path) return; // save failed (already reported)
  const idx = invoices.findIndex(h => h.inv.number === entry.inv.number);
  if (idx >= 0) invoices[idx] = entry; else invoices.unshift(entry);
  persist('invoices');
  settleStock(entry.inv.number, docType(entry) === 'invoice' ? entry.inv.items : []);
  settings.nextNumber = nextNumberValue('invoice');
  settings.nextQuoteNumber = nextNumberValue('quote');
  // Done: back to what you were drafting before the edit, or on to the next one for the same client,
  // of the same kind, with the following number.
  // (savePdf has already said where it was saved and whether it was backed up.)
  if (editing) restoreDraft();
  else draft = newDraft(draft.clientId, draft.type);
  renderInvoice(); changed(); renderHistory(); renderMe(); renderOverdue();
};

// In a team, a new invoice number is claimed before saving, so two people can't both use it.
// If someone just took it, the invoice gets the next free number. Returns false to stop saving.
async function claimNumber(entry) {
  for (let tries = 0; tries < 5; tries++) {
    const r = await store.teamClaimInvoice(entry);
    if (!r || r.ok) return true;
    if (r.error) { toast(`Couldn't check ${entry.inv.number} with your team (${r.error}). Saving it anyway.`); return true; }
    const type = docType(entry), old = entry.inv.number;
    const n = Math.max(nextNumberValue(type), (numberOf(old) || 0) + 1);
    entry.inv.number = (type === 'quote' ? (settings.quotePrefix ?? 'QUO-') : (settings.prefix || '')) + n;
    draft.number = entry.inv.number; renderInvoice(); refreshPreview();
    toast(`${old} was just used by ${r.by || 'someone in your team'}, so this one is ${entry.inv.number}.`);
  }
  toast("Couldn't find a free invoice number. Try again in a moment.");
  return false;
}

// ---------- clients tab ----------
let editingClient = null;
function renderClients() {
  renderClientOptions();
  $('#cl-new').hidden = !can('addClients');
  const c = client(editingClient) || clients[0];
  $('#cl-form').style.display = c ? '' : 'none';
  if (!c) return;
  editingClient = c.id; $('#cl-select').value = c.id;
  $('#cl-private').checked = !!c.private;
  $$('[data-cl]').forEach(el => setVal(el, c[el.dataset.cl] ?? ''));
  // Your role in a team: a personal client is all yours; a shared one only as far as your role goes.
  const mine = !teamState.team || c.private;
  $$('[data-cl]').forEach(el => { el.disabled = !mine && (!can('editClients') || (BILLING.includes(el.dataset.cl) && !can('editBilling'))); });
  $('#cl-private').closest('label').hidden = !mine && !can('deleteClients'); // making it personal takes it off the team
  $('#cl-delete').hidden = !mine && !can('deleteClients');
  $('#cl-invoice').hidden = !can('createInvoices');
  $('#cl-locked').hidden = mine || can('editBilling');
  $('#cl-locked').textContent = !can('editClients') ? `As ${aRole(teamState.team && teamState.team.role)}, you can look at ${teamState.team ? teamState.team.name : 'the team'}'s clients but not change them.`
    : 'Rates, currency, payment terms and tax are greyed out: only an admin can change them for a shared client.';
  $('#cl-items').textContent = (c.items || []).length
    ? c.items.map(normItem).map(i => i.kind === 'fixed' ? `${i.desc} ${money(i.amount, c.currency)}` : i.kind === 'item' ? `${i.desc} (${i.qty} × ${money(i.price, c.currency)})` : `${i.desc} (${KINDS[i.kind].toLowerCase()})`).join(' · ')
    : 'None yet. Fill in lines on an invoice and click "Save lines as client default".';
  $('#cl-reminder').textContent = reminderLabel(c.reminderDay) + '.';
}
$('#cl-reminder-edit').onclick = () => go('notifications');
// Personal client: it and all its invoices stay off the team. Making a shared client personal removes
// it (and its invoices) from everyone else's Invaro; sharing it again leaves its invoices personal.
$('#cl-private').onchange = e => {
  const c = client(editingClient); if (!c) return;
  const on = e.target.checked, team = teamState.team && teamState.team.name;
  const its = invoices.filter(h => h.c && h.c.id === c.id);
  const n = its.length ? ` and its ${its.length} invoice${its.length === 1 ? '' : 's'}` : '';
  if (team && !confirm(on
    ? `Make ${c.company} personal?\n\n${team} stops seeing this client${n}: they're removed from everyone else's Invaro. You keep everything on this computer.`
    : `Share ${c.company} with ${team}?\n\nEveryone in the team will see and can edit this client. Its invoices stay personal; share them one at a time in History if you want to.`)) {
    e.target.checked = !on; return;
  }
  c.private = on;
  if (on) { its.forEach(h => { h.private = true; }); if (draft.clientId === c.id) draft.private = true; }
  persist('clients'); if (on && its.length) persist('invoices');
  renderClientOptions(); $('#cl-select').value = c.id; renderInvoice(); renderHistory();
  toast(on ? `${c.company} is personal${team ? `, and no longer shared with ${team}` : ''}.` : `${c.company} is ${team ? `shared with ${team}` : 'no longer personal'}.`);
};
$('#cl-select').onchange = e => { editingClient = e.target.value; renderClients(); refreshPreview(0); };
$$('[data-cl]').forEach(el => el.oninput = () => {
  const c = client(editingClient); if (!c) return;
  c[el.dataset.cl] = el.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
  persist('clients'); renderClientOptions(); $('#cl-select').value = c.id;
  if (c.id === draft.clientId) { renderRates(); renderItems(); }
  refreshPreview();
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
  if (!leaveEditing()) return;
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
  else if (anyOn) { el.className = 'drive-status err'; el.textContent = "Couldn't set up the daily reminder check, so reminders only appear while Invaro is open."; }
  else { el.className = 'drive-status'; el.textContent = 'No reminders set, so nothing is scheduled.'; }
}
// How reminders work while Invaro is closed, in this computer's terms.
$('#rem-how').textContent = IS_MAC
  ? 'Invaro doesn\'t need to be open. While any client has a reminder or an invoice is unpaid, macOS runs a quick check every day at 9am and when you log in, using a launch agent called "local.invoicer.reminders". It’s removed once there are no reminders and no unpaid invoices. Overdue invoices are also reminded about the day after they’re due, then weekly until marked paid. If you delete Invaro, turn your reminders off first.'
  : 'Invaro doesn\'t need to be open. While any client has a reminder or an invoice is unpaid, a Windows Task Scheduler task called "Invaro reminders" checks every day at 9am, or as soon as your PC is on if it was off then. It’s removed once there are no reminders and no unpaid invoices, or when you uninstall Invaro. Overdue invoices are also reminded about the day after they’re due, then weekly until marked paid.';
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
  toast(r && r.error ? r.error : `Test notification sent. If you didn't see it, check ${IS_MAC ? 'System Settings → Notifications → Invaro' : 'Windows Settings → System → Notifications'}.`);
};
$('#rem-all-off').onclick = async () => {
  if (!confirm('Turn off invoice reminders for every client? This also removes the daily reminder check.')) return;
  clients.forEach(c => { c.reminderDay = ''; });
  persist('clients'); await flushSaves();
  renderClients(); renderNotifications();
};
let lastDue = [];
function renderReminders(due) {
  lastDue = due || [];
  if (!can('createInvoices')) due = []; // reminders to invoice are for whoever makes the invoices
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
  $$('[data-me]').forEach(el => setVal(el, me[el.dataset.me] ?? ''));
  $$('[data-set]').forEach(el => setVal(el, settings[el.dataset.set] ?? ''));
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

// ---------- backup settings ----------
const SEP = IS_MAC ? '/' : '\\';
const BACKUP_HELP = {
  google: f => `Every saved invoice is copied into <b>My Drive${SEP}${f}</b>, in a folder per client. Google Drive for desktop uploads it to drive.google.com, and brings down anything changed online. Invaro finds your My Drive folder automatically.`,
  onedrive: f => `Every saved invoice is copied into <b>OneDrive${SEP}${f}</b>, in a folder per client. The OneDrive app uploads it to onedrive.com, and brings down anything changed online. Invaro finds your OneDrive folder automatically.`,
  other: () => 'Every saved invoice is copied into a folder you choose: a USB drive, a network share, or the folder of another sync app such as Dropbox or iCloud Drive.',
};
// Tidies a typed folder path the same way the main process does: "/Finance\ Invoices/" -> "Finance/Invoices".
const cleanFolder = f => String(f || '').split(/[\\/]+/).map(p => p.replace(/[<>:"|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, ''))
  .filter(p => p && p !== '.' && p !== '..').join('/');
const INSTALL = {
  google: ['Get Google Drive for desktop', 'https://www.google.com/drive/download/'],
  onedrive: ['Get OneDrive', 'https://www.microsoft.com/microsoft-365/onedrive/download'],
};
async function refreshBackupStatus() {
  if (!store.backupStatus) { $('#drive-status').textContent = 'Backups are only available in the desktop app.'; return; }
  const provider = backupProvider();
  $('#drive-provider').value = provider;
  const shared = backupShared();
  const gd = store.gdriveStatus ? await store.gdriveStatus() : { configured: false };
  const online = provider === 'google' && gd.connected;
  await refreshSharedDrives();
  backupState = await store.backupStatus(backupSel());
  $('#drive-folder-row').hidden = provider === 'other' || !store.backupFolders;
  if (document.activeElement !== $('#drive-folder')) $('#drive-folder').value = settings.backupFolder || '';
  const folder = sep => esc((backupState.parts || ['Invaro Backups']).join(sep));
  $('#drive-help').innerHTML = online
    ? `Invaro uploads every saved invoice straight to <b>${shared ? `Shared drives/${esc(shared)}` : 'My Drive'}/${folder('/')}</b> on Google Drive, in a folder per client${shared ? ', where everyone with access to the shared drive can see it' : ''}. Google Drive for desktop isn't needed.`
    : (shared
      ? `Every saved invoice is copied into <b>Shared drives${SEP}${esc(shared)}${SEP}${folder(SEP)}</b>, in a folder per client. Google Drive for desktop uploads it, and everyone with access to the shared drive can see it on drive.google.com.`
      : BACKUP_HELP[provider](folder(SEP)))
      + (provider === 'google' && gd.configured && !online ? " No Google Drive for desktop? Connect your Google Drive and Invaro uploads invoices itself." : '');
  const s = $('#drive-status');
  if (online) {
    s.className = 'drive-status on';
    s.textContent = `Connected to Google Drive${gd.email ? ` as ${gd.email}` : ''}. Backing up every saved invoice to ${backupState.dir}.`;
  } else if (backupState.ready) {
    s.className = 'drive-status on';
    s.textContent = `Backing up every saved invoice to ${backupState.dir}` + (backupState.auto ? ` (synced by ${shared ? 'Google Drive' : backupState.name}).` : '.');
  } else if (shared && backupState.myDrive) {
    s.className = 'drive-status err';
    s.textContent = `Can't find the "${shared}" shared drive. Check you still have access to it, or pick another location. Invoices will be backed up once it's back.`;
  } else if (backupState.dir) {
    s.className = 'drive-status err';
    s.textContent = `Can't reach ${backupState.dir}. ${provider === 'other' ? 'Is the drive connected?' : `Is ${backupState.name} running?`} Invoices will be backed up once it's back.`;
  } else {
    s.className = 'drive-status err';
    s.textContent = provider === 'other' ? 'Choose a folder, and invoices will be backed up there.'
      : provider === 'google' && gd.configured ? 'Invoices are not being backed up yet. Connect your Google Drive, or install Google Drive for desktop.'
      : `${backupState.name}${provider === 'google' ? ' for desktop' : ''} isn't installed or signed in, so invoices are not being backed up.`;
  }
  const install = INSTALL[provider];
  $('#drive-install').hidden = !install || online || !!(provider === 'google' ? backupState.myDrive : backupState.root);
  if (install) $('#drive-install').textContent = install[0];
  $('#drive-install').classList.toggle('primary', !(provider === 'google' && gd.configured));
  const connect = $('#gd-connect');
  connect.hidden = provider !== 'google' || !gd.configured || gd.connected;
  connect.classList.toggle('primary', !backupState.myDrive);
  connect.textContent = gd.connecting ? 'Waiting for Google… (click to cancel)' : (backupState.myDrive ? 'Connect Google Drive online instead' : 'Connect Google Drive');
  $('#gd-disconnect').hidden = !online;
  refreshShares(provider, online, gd);
  $('#drive-open').hidden = !backupState.ready;
  $('#drive-change').hidden = provider !== 'other';
  $('#drive-change').textContent = settings.backupDir ? 'Choose a different folder…' : 'Choose folder…';
  const missing = invoices.filter(h => !h.backup).length;
  $('#drive-retry').hidden = !backupState.ready || !missing;
  $('#drive-retry').textContent = `Back up ${missing} missing invoice${missing === 1 ? '' : 's'}`;
}
$('#drive-provider').onchange = async e => {
  settings.backupProvider = e.target.value; persist('settings');
  await refreshBackupStatus();
  if (e.target.value === 'other' && !settings.backupDir) return $('#drive-change').click();
  retryPendingBackups();
};
// The Google Drive location list: My Drive plus every shared drive Google Drive for desktop shows.
// A chosen shared drive stays in the list even when it can't be found, so the choice isn't lost.
async function refreshSharedDrives() {
  const sel = $('#drive-location');
  const show = backupProvider() === 'google' && !!store.backupSharedDrives;
  sel.parentElement.hidden = !show;
  if (!show) return;
  const names = (await store.backupSharedDrives()).map(d => d.name);
  const cur = settings.backupSharedDrive || '';
  if (cur && !names.includes(cur)) names.push(cur);
  sel.innerHTML = '<option value="">My Drive</option>' + (names.length
    ? `<optgroup label="Shared drives">${names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</optgroup>` : '');
  sel.value = cur;
}
$('#drive-location').onchange = async e => {
  settings.backupSharedDrive = e.target.value; persist('settings');
  await refreshBackupStatus(); retryPendingBackups();
};
// ---------- sharing the backup folder (Google Drive online only) ----------
const ROLES = { reader: 'Can view', commenter: 'Can comment', writer: 'Can edit', fileOrganizer: 'Content manager', organizer: 'Manager', owner: 'Owner' };
async function refreshShares(provider, online, gd) {
  const box = $('#share-box');
  box.hidden = provider !== 'google' || !store.backupShares || !(online || gd.configured);
  if (box.hidden) return;
  $('#share-online').hidden = !online;
  const where = `${backupShared() ? `Shared drives/${esc(backupShared())}` : 'My Drive'}/${esc((backupState.parts || ['Invaro Backups']).join('/'))}`;
  if (!online) {
    $('#share-help').innerHTML = 'Connect Google Drive to share your invoices with your partner or company from here. You can also open the backup folder in Google Drive and use its Share button.';
    return;
  }
  $('#share-help').innerHTML = `People you add can open <b>${where}</b> in Google Drive and see every invoice as soon as it's saved. Google emails them a link.`
    + (backupShared() ? ' Members of the shared drive can already see it.' : '');
  renderShares(await store.backupShares(backupSel()));
}
function renderShares(list) {
  const el = $('#share-list');
  if (list && list.error) { el.innerHTML = `<p class="muted">${esc(list.error)}</p>`; return; }
  if (!list.length) { el.innerHTML = '<p class="muted">Not shared with anyone yet.</p>'; return; }
  el.innerHTML = list.map(p => `<div class="person"><span title="${esc(p.email)}">${esc(p.name && p.name !== p.email ? `${p.name} (${p.email})` : p.email)}</span>`
    + `<small>${esc(ROLES[p.role] || p.role)}${p.inherited ? ' · from the shared drive' : ''}</small>`
    + (p.inherited || p.role === 'owner' ? '' : `<button class="link warn" type="button" data-unshare="${esc(p.id)}" data-email="${esc(p.email)}">Remove</button>`) + '</div>').join('');
  el.querySelectorAll('[data-unshare]').forEach(b => {
    b.onclick = async () => {
      if (!confirm(`Stop sharing your invoices with ${b.dataset.email}? They won't be able to open the folder any more.`)) return;
      b.disabled = true;
      const r = await store.backupUnshare(backupSel(), b.dataset.unshare);
      if (r && r.error) { b.disabled = false; return toast(r.error); }
      renderShares(r); toast(`Stopped sharing with ${b.dataset.email}.`);
    };
  });
}
$('#share-add').onclick = async () => {
  const email = $('#share-email').value.trim(), role = $('#share-role').value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Enter an email address, like partner@example.com.'); return $('#share-email').focus(); }
  const btn = $('#share-add'); btn.disabled = true; btn.textContent = 'Sharing…';
  const r = await store.backupShare(backupSel(), email, role, `${(settings.me || {}).company || (settings.me || {}).name || 'Someone'} shared their invoices with you from Invaro.`);
  btn.disabled = false; btn.textContent = 'Share';
  if (r && r.error) return toast(r.error);
  $('#share-email').value = '';
  renderShares(r);
  toast(`Shared with ${email}. Google has emailed them a link.`);
};
$('#share-email').onkeydown = e => { if (e.key === 'Enter') $('#share-add').click(); };
async function setBackupFolder(value) {
  const f = cleanFolder(value);
  $('#drive-folder').value = f;
  if (f === (settings.backupFolder || '')) return;
  settings.backupFolder = f; persist('settings');
  await refreshBackupStatus(); retryPendingBackups();
}
$('#drive-folder').onchange = e => setBackupFolder(e.target.value);
$('#drive-folder').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
// Folder picker: browses the folders inside the chosen drive (My Drive, a shared drive or OneDrive),
// online through the Drive API when connected, otherwise in the synced folder on this computer.
let pickerPath = [];
async function showPickerFolder(parts) {
  const list = $('#folder-dlg-list');
  const top = backupState && backupState.online ? (backupShared() ? `Shared drives/${backupShared()}` : 'My Drive')
    : backupShared() ? `Shared drives/${backupShared()}` : backupWhere();
  list.innerHTML = '<p class="muted">Loading…</p>';
  $('#folder-dlg-path').textContent = [top, ...parts].join(' / ');
  $('#folder-dlg-up').disabled = !parts.length;
  $('#folder-dlg-use').disabled = !parts.length;
  pickerPath = parts;
  const r = await store.backupFolders(backupSel(), parts);
  if (pickerPath !== parts) return; // the user moved on while this loaded
  if (r && r.error) { list.innerHTML = `<p class="muted">${esc(r.error)}</p>`; return; }
  list.innerHTML = r.length ? r.map(n => `<button type="button" data-f="${esc(n)}">📁 ${esc(n)}</button>`).join('')
    : `<p class="muted">No folders here.${parts.length ? ' Use this folder, or go up.' : ''} To make a new one, type its name in the Folder box instead.</p>`;
  list.querySelectorAll('button').forEach(b => { b.onclick = () => showPickerFolder([...parts, b.dataset.f]); });
}
$('#drive-browse').onclick = () => {
  $('#folder-dlg').showModal();
  const cur = cleanFolder(settings.backupFolder);
  showPickerFolder(cur ? cur.split('/') : []);
};
$('#folder-dlg-up').onclick = () => showPickerFolder(pickerPath.slice(0, -1));
$('#folder-dlg-cancel').onclick = () => $('#folder-dlg').close();
$('#folder-dlg-use').onclick = () => { $('#folder-dlg').close(); setBackupFolder(pickerPath.join('/')); };
$('#gd-connect').onclick = async () => {
  const gd = await store.gdriveStatus();
  if (gd.connecting) { await store.gdriveCancel(); return refreshBackupStatus(); }
  const done = store.gdriveConnect();
  setTimeout(refreshBackupStatus, 300); // show "Waiting for Google…"
  const r = await done;
  await refreshBackupStatus();
  if (r && r.error) { if (!/cancelled/i.test(r.error)) toast(r.error); return; }
  toast(`Google Drive connected${r.email ? ` (${r.email})` : ''}. Invoices will be uploaded there.`);
  retryPendingBackups();
};
$('#gd-disconnect').onclick = async () => {
  if (!confirm('Disconnect Google Drive? Invoices already uploaded stay in your Drive. Invaro stops uploading new ones.')) return;
  await store.gdriveDisconnect();
  await refreshBackupStatus();
  toast('Google Drive disconnected.');
};
$('#drive-install').onclick = () => { const i = INSTALL[backupProvider()]; if (i) store.openExternal(i[1]); };
$('#drive-open').onclick = async () => { const r = await store.openBackupDir(backupSel()); if (r && r.error) toast(r.error); };
$('#drive-change').onclick = async () => {
  const dir = await store.chooseBackupDir(backupSel());
  if (!dir) return;
  settings.backupDir = dir; settings.backupProvider = 'other'; persist('settings');
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
// ---------- rand values: exchange rates on the day each invoice was paid ----------
// With "Also show what's been paid in rand" on (settings.reportCurrency = 'ZAR'), invoices in another
// currency that are marked paid get a rand value, at the chosen bank's buying rate on the day they were
// marked paid (settings.fxBank: standard, absa or nedbank; both settings stay on this computer; see fx.js).
// Rates are stored on the invoice, one per bank, each with the paid date it's for ('for'), so the report
// doesn't change afterwards and you can switch banks:
//   h.fx.ZAR = { standard: { rate, on, kind, source, for }, absa: …, nedbank: …, manual: … }
// 'manual' is a rate you typed in yourself, and wins. A rate that isn't for the invoice's paid date
// (1.23.0's invoice-date rates, or a payment that was undone) is ignored.
// Marking an invoice paid records every bank's rate that day. Absa and Nedbank only publish today's
// rates, so for an earlier paid date with none recorded, Standard Bank's is used and the report says so.
const reportCur = () => settings.reportCurrency || '';
const FX_BANKS = { standard: 'Standard Bank', absa: 'Absa', nedbank: 'Nedbank' };
const fxBank = () => FX_BANKS[settings.fxBank] ? settings.fxBank : 'standard';
const fxMemo = {}; // rates for invoices this computer mayn't change (an accountant's view), kept in memory
const fxTried = new Set(); // "invoice|bank" lookups that failed this session (not tried again)
let fxBusy = false, fxError = '';
// Whether this computer may store the rate on the invoice (the team's roles decide who changes invoices).
const canStoreFx = h => !teamState.team || !!h.private || can('editBilling') || (can('createInvoices') && !h.savedBy);
// The invoice's rates for one currency, by bank: only those for its paid date.
function fxRates(h, to) {
  const v = (h.fx && h.fx[to]) || {};
  const all = { ...(v.rate ? {} : v), ...(fxMemo[`${h.inv.number}|${to}`] || {}) }; // (1.23.0's single rate was for the invoice date)
  return Object.fromEntries(Object.entries(all).filter(([, r]) => r && r.for && r.for === h.paidAt));
}
// The rate the report uses: yours, else the chosen bank's, else (for a bank without history) Standard Bank's.
function fxOf(h, to) {
  if (curCode(h.c.currency) === to) return { rate: 1, kind: 'same' };
  const all = fxRates(h, to), bank = fxBank();
  if (all.manual) return { ...all.manual, kind: 'manual' };
  if (all[bank]) return { ...all[bank], bank };
  if (bank !== 'standard' && all.standard && fxTried.has(`${h.inv.number}|${bank}`)) return { ...all.standard, bank: 'standard', instead: bank };
  return null;
}
function setFx(h, to, bank, v) { // bank: a bank's id, or 'manual'; v null removes it
  const all = fxRates(h, to);
  if (v) all[bank] = { ...v, for: h.paidAt }; else delete all[bank];
  if (!canStoreFx(h)) { fxMemo[`${h.inv.number}|${to}`] = all; return false; }
  h.fx = { ...(h.fx || {}) };
  if (Object.keys(all).length) h.fx[to] = all; else delete h.fx[to];
  if (!Object.keys(h.fx).length) delete h.fx;
  return true;
}
const dayLabel = d => `${shortDate(d)} ${d.slice(0, 4)}`;
const fxLabel = f => !f ? '' : f.kind === 'manual' ? 'Your rate'
  : `${FX_BANKS[f.bank] || 'Standard Bank'}, ${dayLabel(f.on)}${f.kind === 'current' || f.kind === 'opening' ? ' (rate when marked paid)' : f.kind === 'closing' ? ' closing' : ''}`
    + (f.instead ? ` (${FX_BANKS[f.instead]} had no rate for this date)` : '');
const isPaidRow = r => r.status.key === 'paid';
// Looks up the missing rates (paid invoices only) one at a time, then shows the report again.
async function fillRates(rows, to) {
  const bank = fxBank();
  const missing = rows.filter(r => r.cur !== to && isPaidRow(r) && !fxOf(r.h, to) && !fxTried.has(`${r.h.inv.number}|${bank}|failed`));
  if (fxBusy || !missing.length || !store.fxRate) return;
  fxBusy = true; fxError = ''; renderReports();
  let stored = false;
  for (const r of missing) {
    const n = r.h.inv.number;
    let res = fxTried.has(`${n}|${bank}`) ? null : await store.fxRate(bank, r.cur, r.h.paidAt);
    if (res && res.noHistory) { fxTried.add(`${n}|${bank}`); res = null; }
    if (!res) res = fxRates(r.h, to).standard ? null : await store.fxRate('standard', r.cur, r.h.paidAt); // fall back to Standard Bank's history
    if (res && res.error) { fxTried.add(`${n}|${bank}|failed`); fxError = res.error; continue; }
    if (res) stored = setFx(r.h, to, res.bank || 'standard', { rate: res.rate, on: res.on, kind: res.kind, source: res.source }) || stored;
  }
  fxBusy = false;
  if (stored) persist('invoices');
  if (tabShown('reports')) renderReports();
}
// When an invoice in another currency is marked paid, every bank's rate that day is recorded there and then.
async function captureFx(h) {
  const to = reportCur();
  if (!to || !store.fxRates || docType(h) !== 'invoice' || !h.paidAt || curCode(h.c.currency) === to) return;
  const paidAt = h.paidAt;
  const res = await store.fxRates(curCode(h.c.currency), paidAt);
  if (!res || res.error || h.paidAt !== paidAt) return; // Reports tries again later (and an undone payment needs none)
  let stored = false;
  for (const [bank, v] of Object.entries(res)) {
    if (v && !v.error && !fxRates(h, to)[bank]) stored = setFx(h, to, bank, { rate: v.rate, on: v.on, kind: v.kind, source: v.source }) || stored;
  }
  if (stored) persist('invoices');
}
$('#rep-zar').onchange = e => {
  settings.reportCurrency = e.target.checked ? 'ZAR' : ''; persist('settings');
  fxTried.clear(); renderReports();
};
$('#rep-bank').onchange = e => { settings.fxBank = e.target.value; persist('settings'); fxError = ''; renderReports(); };

function renderReports() {
  const { list, current } = reportPeriods();
  const sel = $('#rep-period');
  const keep = sel.value;
  sel.innerHTML = list.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  sel.value = list.some(p => p.id === keep) ? keep : current;
  const p = list.find(x => x.id === sel.value);
  const rows = reportRows(p);
  $('#rep-range').textContent = `${shortDate(p.from)} ${p.from.slice(0, 4)} to ${shortDate(p.to)} ${p.to.slice(0, 4)} · ${rows.length} invoice${rows.length === 1 ? '' : 's'}`;
  const to = reportCur(), bankName = FX_BANKS[fxBank()];
  $('#rep-zar').checked = !!to;
  $('#rep-bank-row').hidden = !to; $('#rep-bank').value = fxBank();
  // Rand values: paid invoices only, each at its invoice date's rate (null until the rate is known).
  const isPaid = x => x.status.key === 'paid', isOwed = x => x.status.key === 'unpaid' || x.status.key === 'overdue';
  const foreign = to ? rows.filter(r => r.cur !== to) : [];
  for (const r of rows) {
    const f = to && isPaid(r) && fxOf(r.h, to);
    r.fx = f || null;
    r.home = f ? { subtotal: round2(r.subtotal * f.rate), tax: round2(r.tax * f.rate), total: round2(r.total * f.rate) } : null;
  }
  const waiting = foreign.filter(r => isPaid(r) && !r.fx).length;
  const fxNote = $('#rep-fx');
  fxNote.hidden = !to || (!waiting && !fxBusy);
  fxNote.className = 'drive-status' + (fxError && waiting ? ' err' : '');
  fxNote.textContent = !store.fxRate ? 'Exchange rates are only available in the desktop app.'
    : fxBusy ? `Getting ${bankName}'s rates for ${waiting} paid invoice${waiting === 1 ? '' : 's'}…`
    : fxError ? `Couldn't get a rate for ${waiting} paid invoice${waiting === 1 ? '' : 's'} (${fxError}). Type the rate in yourself below, or switch rand off and on again to retry.`
    : '';
  if (to && waiting && !fxBusy) fillRates(rows, to);
  if (!rows.length) { $('#rep-body').innerHTML = '<p class="muted">No invoices in this period.</p>'; return; }
  const sum = (arr, f) => round2(arr.reduce((s, r) => s + f(r), 0));
  const byCur = [...new Set(rows.map(r => r.cur))];
  const table = (head, body) => `<table class="report"><thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
  const tr = cells => `<tr>${cells.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`;
  const label = settings.taxLabel || 'VAT';
  // The headline figures, per currency.
  const tile = (l, v, sub) => `<div class="tile"><div class="tile-label">${l}</div><div class="tile-value">${v}</div><div class="tile-sub">${sub}</div></div>`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  let html = byCur.map(cur => {
    const r = rows.filter(x => x.cur === cur), paid = r.filter(isPaid), owed = r.filter(isOwed);
    return `${byCur.length > 1 ? `<h3>${cur}</h3>` : ''}<div class="tiles rep-tiles">${[
      tile('Invoiced', money(sum(r, x => x.total), cur), plural(r.length, 'invoice')),
      tile('Paid', money(sum(paid, x => x.total), cur), `${paid.length} of ${r.length} paid`),
      tile('Outstanding', money(sum(owed, x => x.total), cur), owed.length ? plural(owed.length, 'unpaid invoice') : 'Nothing owed'),
      tile(esc(label), money(sum(r, x => x.tax), cur), `on ${money(sum(r, x => x.subtotal), cur)} excl. ${esc(label)}`),
    ].join('')}</div>`;
  }).join('');
  // What's been paid, all in rand, at each invoice's own rate.
  const home = (arr, f) => arr.some(r => !r.home) ? null : round2(arr.reduce((s, r) => s + f(r.home), 0));
  const homeMoney = v => v == null ? '<span class="muted" title="Waiting for an exchange rate">…</span>' : money(v, to);
  const showHome = to && foreign.length;
  if (showHome) {
    const paid = rows.filter(isPaid);
    html += `<div class="card"><h3>Paid, in rand (${to})</h3>` + table(['', 'Invoices', 'Excl. ' + label, label, 'Total'],
      tr(['All currencies', paid.length, homeMoney(home(paid, h => h.subtotal)), homeMoney(home(paid, h => h.tax)), `<b>${homeMoney(home(paid, h => h.total))}</b>`]))
      + `<p class="muted">Invoices in other currencies get a rand value once they're marked paid, at ${esc(bankName)}'s buying rate on the day they were marked paid.</p></div>`;
  }
  const clientsIn = [...new Set(rows.map(r => `${r.h.c.company}\u0000${r.cur}`))];
  html += '<div class="rep-grid"><div class="card"><h3>By client</h3>' + table(['Client', 'Invoices', 'Total', 'Paid', 'Outstanding', ...(showHome ? [`Paid in ${to}`] : [])], clientsIn.map(k => {
    const [name, cur] = k.split('\u0000'); const r = rows.filter(x => x.h.c.company === name && x.cur === cur);
    return tr([esc(name), r.length, money(sum(r, x => x.total), cur), money(sum(r.filter(isPaid), x => x.total), cur),
      money(sum(r.filter(isOwed), x => x.total), cur), ...(showHome ? [homeMoney(home(r.filter(isPaid), h => h.total))] : [])]);
  }).join('')) + '</div>';
  const months = [...new Set(rows.map(r => r.h.inv.date.slice(0, 7)))].sort();
  html += '<div class="card"><h3>By month</h3>' + table(['Month', ...byCur, ...(showHome ? [`Paid in ${to}`] : [])], months.map(m => {
    const d = parseDate(m + '-01'), inM = rows.filter(x => x.h.inv.date.startsWith(m));
    return tr([`${MONTHS[d.getMonth()]} ${d.getFullYear()}`, ...byCur.map(cur => money(sum(inM.filter(x => x.cur === cur), x => x.total), cur)),
      ...(showHome ? [homeMoney(home(inM.filter(isPaid), h => h.total))] : [])]);
  }).join('')) + '</div></div>';
  // The rate behind each paid invoice in another currency; type a rate in to use your own.
  if (showHome) {
    const editable = r => canStoreFx(r.h) || !teamState.team;
    html += `<div class="card"><h3>Exchange rates</h3><p class="muted">Rand per unit of each invoice's currency: ${esc(bankName)}'s buying rate (what the bank pays you) on the day each invoice was marked paid, unless you type in your own. Unpaid invoices get theirs once they're marked paid.</p>`
      + `<table class="report fx"><thead><tr><th>Invoice</th><th>Paid</th><th>Client</th><th class="num">Total</th><th class="num">Rate</th><th>From</th><th class="num">In ${to}</th></tr></thead><tbody>`
      + foreign.sort((a, b) => (a.h.paidAt || '9999').localeCompare(b.h.paidAt || '9999') || a.h.inv.date.localeCompare(b.h.inv.date)).map(r => isPaid(r) ? `<tr>
        <td>${esc(r.h.inv.number)}</td><td>${esc(r.h.paidAt)}</td><td>${esc(r.h.c.company)}</td>
        <td class="num">${money(r.total, r.cur)}</td>
        <td class="num"><input class="fx-rate" type="number" step="0.0001" min="0" data-fx="${esc(r.h.inv.number)}" value="${r.fx ? r.fx.rate : ''}" placeholder="${fxBusy ? '…' : 'Rate'}" ${editable(r) ? '' : 'readonly title="Only an admin, or whoever saved it, can change the rate on a shared invoice"'}></td>
        <td class="muted">${esc(fxLabel(r.fx))}${r.fx && r.fx.kind === 'manual' && editable(r) ? ` <button class="link" data-fx-reset="${esc(r.h.inv.number)}" title="Use ${esc(bankName)}'s rate for this date again">Use ${esc(bankName)}'s</button>` : ''}</td>
        <td class="num">${homeMoney(r.home && r.home.total)}</td></tr>` : `<tr class="unpaid">
        <td>${esc(r.h.inv.number)}</td><td class="muted">–</td><td>${esc(r.h.c.company)}</td>
        <td class="num">${money(r.total, r.cur)}</td><td class="num muted">–</td><td class="muted" colspan="2">Not paid yet: shown once it's marked paid</td></tr>`).join('')
      + '</tbody></table></div>';
  }
  $('#rep-body').innerHTML = html;
}
// Typing a rate in: it's yours from then on (the report uses it, and it's saved on the invoice).
$('#rep-body').addEventListener('change', e => {
  const n = e.target.dataset.fx; if (!n) return;
  const h = invoices.find(x => x.inv.number === n), to = reportCur(); if (!h || !to) return;
  const v = parseFloat(e.target.value);
  setFx(h, to, 'manual', v > 0 ? { rate: v, on: h.inv.date, kind: 'manual', source: 'Your rate' } : null);
  persist('invoices'); renderReports();
});
$('#rep-body').addEventListener('click', e => {
  const n = e.target.dataset.fxReset; if (!n) return;
  const h = invoices.find(x => x.inv.number === n), to = reportCur(); if (!h || !to) return;
  setFx(h, to, 'manual', null); persist('invoices'); renderReports();
});
$('#rep-period').onchange = renderReports;
$('#rep-csv').onclick = () => {
  const { list } = reportPeriods(); const p = list.find(x => x.id === $('#rep-period').value) || list[0];
  const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  // With rand on, paid rows also have their rate, where it came from, and their amounts in rand.
  const to = reportCur();
  const fxCols = to ? [`Rate to ${to}`, 'Rate date', 'Rate from', `Excl. tax (${to})`, `Tax (${to})`, `Total (${to})`] : [];
  const fxCells = r => {
    if (!to) return [];
    if (r.status.key !== 'paid') return ['', '', 'Not paid yet', '', '', ''];
    const f = fxOf(r.h, to);
    if (!f) return ['', '', 'No rate yet', '', '', ''];
    const x = v => (v * f.rate).toFixed(2);
    return [f.rate, f.on || r.h.inv.date, f.kind === 'same' ? '' : fxLabel(f), x(r.subtotal), x(r.tax), x(r.total)];
  };
  const lines = [['Invoice', 'Date', 'Due', 'Client', 'Currency', 'Excl. tax', 'Tax', 'Total', 'Status', 'Paid on', ...fxCols].join(',')]
    .concat(reportRows(p).map(r => [r.h.inv.number, r.h.inv.date, r.h.inv.due || '', r.h.c.company, r.cur, r.subtotal.toFixed(2), r.tax.toFixed(2), r.total.toFixed(2), r.status.key === 'untracked' ? '' : r.status.key, r.h.paidAt || '', ...fxCells(r)].map(q).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
  a.download = `Invaro report - ${p.label.replace(/[\\/:*?"<>|()]/g, '').replace(/\s+/g, ' ').trim()}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// ---------- quotes paid in steps ----------
// Each line of a saved quote is a step the client pays for. h.paidSteps maps a line's index to the
// date it was paid, e.g. { "0": "2026-11-19", "2": "2026-12-03" }.
// A discount line isn't a step of its own: it comes off the line above it.
const stepPaid = (h, i) => (h.paidSteps || {})[i] || null;
const stepIdx = lines => (lines || []).map((l, i) => l.discount ? -1 : i).filter(i => i >= 0);
function stepNet(lines, i) { // the line plus its own discount straight under it
  let n = num(lines[i].amount);
  for (let k = i + 1; k < lines.length && lines[k].discount && !lines[k].whole; k++) n += num(lines[k].amount);
  return round2(n);
}
function stepSummary(h) {
  const lines = h.lines || [], idx = stepIdx(lines);
  // Scaling the steps to the total spreads tax, and any discount on the whole quote, across every step.
  const steps = idx.reduce((s, i) => s + stepNet(lines, i), 0);
  const factor = steps ? num(h.total) / steps : 1;
  const paidIdx = idx.filter(i => stepPaid(h, i));
  const paid = round2(paidIdx.reduce((s, i) => s + stepNet(lines, i) * factor, 0));
  return { count: idx.length, paidCount: paidIdx.length, factor, paid, outstanding: round2(num(h.total) - paid) };
}
// When a quote is saved again under the same number, lines that are unchanged (discount included) keep their paid dates.
function carryPaidSteps(prev, lines) {
  if (!prev.paidSteps || !prev.lines) return null;
  const used = new Set(), out = {};
  stepIdx(lines).forEach(i => {
    const l = lines[i];
    const j = stepIdx(prev.lines).find(k => !used.has(k) && stepPaid(prev, k) && prev.lines[k].desc === l.desc && stepNet(prev.lines, k) === stepNet(lines, i));
    if (j !== undefined) { used.add(j); out[i] = stepPaid(prev, j); }
  });
  return Object.keys(out).length ? out : null;
}
function setStepPaid(id, i, paid) {
  const h = invoices.find(x => x.id === id); if (!h || !h.lines || !h.lines[i]) return;
  const steps = { ...(h.paidSteps || {}) };
  if (paid) steps[i] = todayIso(); else delete steps[i];
  if (Object.keys(steps).length) h.paidSteps = steps; else delete h.paidSteps;
  persist('invoices'); renderHistory();
  const s = stepSummary(h), cur = h.c.currency;
  toast(s.paidCount === s.count ? `${h.inv.number} is paid in full (${money(h.total, cur)})`
    : `${h.inv.number}: ${money(s.paid, cur)} paid, ${money(s.outstanding, cur)} still to pay`);
}
function setAllStepsPaid(id, paid) {
  const h = invoices.find(x => x.id === id); if (!h || !h.lines) return;
  if (paid) { const today = todayIso(); h.paidSteps = Object.fromEntries(stepIdx(h.lines).map(i => [i, stepPaid(h, i) || today])); }
  else delete h.paidSteps;
  persist('invoices'); renderHistory();
  toast(paid ? `${h.inv.number} is paid in full` : `Cleared the payments on ${h.inv.number}`);
}
const openSteps = new Set(); // quotes whose payment steps are shown in History
function stepsRow(h) {
  const cur = h.c.currency, s = stepSummary(h), edit = can('markPaid');
  const lines = h.lines || [];
  const rows = stepIdx(lines).map(i => {
    const l = lines[i], d = stepPaid(h, i);
    const off = lines[i + 1] && lines[i + 1].discount ? `, less ${lines[i + 1].desc.toLowerCase()}` : '';
    const box = edit ? `<input type="checkbox" data-step="${i}" data-id="${h.id}" ${d ? 'checked' : ''}>` : `<span>${d ? '✓' : ''}</span>`;
    return `<label class="step${d ? ' done' : ''}">${box}<span class="step-desc">${esc(l.desc || '(no description)')}${l.detail || off ? ` <span class="muted">${esc((l.detail || '') + off)}</span>` : ''}</span>
      <span class="num">${esc(money(round2(stepNet(lines, i) * s.factor), cur))}</span>
      <span class="muted step-date">${d ? 'Paid ' + esc(shortDate(d)) : ''}</span></label>`;
  }).join('');
  const all = edit ? (s.paidCount === s.count
    ? `<button class="link" data-act="steps-none" data-id="${h.id}">Clear all</button>`
    : `<button class="link" data-act="steps-all" data-id="${h.id}">Mark all paid</button>`) : '';
  return `<tr class="steps-row"><td colspan="7"><div class="steps">
    ${rows}
    <div class="steps-sum"><span>Paid <b>${esc(money(s.paid, cur))}</b> of ${esc(money(h.total, cur))} · Outstanding <b>${esc(money(s.outstanding, cur))}</b></span>${all}</div>
    ${(() => {
      const whole = lines.find(l => l.whole);
      const notes = [h.tax && `include ${h.taxLabel || 'VAT'}`, whole && `take off the ${whole.desc.replace(/^Discount \((.*?)\).*/, '$1')} discount on the whole quote`].filter(Boolean);
      return notes.length ? `<p class="muted">Amounts ${esc(notes.join(' and '))}.</p>` : '';
    })()}
  </div></td></tr>`;
}

// ---------- paid / unpaid / overdue ----------
const todayIso = () => iso(new Date());
// Invoices saved from 1.12.0 on are tracked; older ones show "–" (but can still be marked paid).
function payStatus(h) {
  if (docType(h) === 'quote') {
    const s = stepSummary(h);
    if (s.count && s.paidCount === s.count) return { key: 'paid', label: 'Paid in full' };
    if (s.paidCount) return { key: 'part', label: `${s.paidCount} of ${s.count} paid` };
    return h.convertedTo ? { key: 'quote', label: `Invoiced (${h.convertedTo})` } : { key: 'quote', label: 'Quote' };
  }
  if (h.paidAt) return { key: 'paid', label: `Paid ${shortDate(h.paidAt)}` };
  if (!h.tracked) return { key: 'untracked', label: '–' };
  if (h.inv.due && h.inv.due < todayIso()) return { key: 'overdue', label: 'Overdue' };
  return { key: 'unpaid', label: 'Unpaid' };
}
const overdueList = () => invoices.filter(h => payStatus(h).key === 'overdue');
function renderOverdue() {
  $('#overdue-bars').innerHTML = overdueList().map(h =>
    `<div class="update-bar remind overdue"><span><b>${esc(h.inv.number)}</b> for ${esc(h.c.company)} (${esc(money(h.total, h.c.currency))}) was due on ${esc(shortDate(h.inv.due))}.</span>
     ${can('markPaid') ? `<button class="btn primary" data-pay="${esc(h.id)}">Mark paid</button>` : ''}
     <button class="btn" data-go-hist="1">History</button></div>`).join('');
}
function setPaid(id, paid) {
  const h = invoices.find(x => x.id === id); if (!h) return;
  h.paidAt = paid ? todayIso() : null;
  if (!paid) delete h.fx; // its rates were for that payment
  persist('invoices'); renderHistory(); renderOverdue();
  if (paid) captureFx(h); // every bank's rate today, for its rand value in Reports (in the background)
  toast(paid ? `${h.inv.number} marked as paid` : `${h.inv.number} marked as unpaid`);
}
$('#overdue-bars').onclick = e => {
  if (e.target.dataset.pay) setPaid(e.target.dataset.pay, true);
  else if (e.target.dataset.goHist) go('history');
};

// History: one row per invoice or quote. Clicking a row previews it on the right and shows what you
// can do with it in the bar above the list.
function renderHistory() {
  $('#hist-empty').style.display = invoices.length ? 'none' : '';
  if (histPick && !invoices.some(h => h.id === histPick)) histPick = null;
  const make = can('createInvoices'); // an accountant only opens and saves the PDFs
  const backupCell = h => h.backup
    ? `<button class="link ok" data-act="drive" data-id="${h.id}" title="Backed up to ${esc(h.backup)}. Click to show it.">✓</button>`
    : h.backupError !== undefined
      ? `<button class="link warn" data-act="backup" data-id="${h.id}" title="Not backed up: ${esc(h.backupError)}. Click to retry.">⚠ Retry</button>`
      : '<span class="muted" title="Not backed up">–</span>';
  const statusCell = h => {
    const st = payStatus(h);
    const btn = docType(h) === 'quote'
      ? `<button class="link" data-act="steps" data-id="${h.id}" title="Tick off each line of this quote as it's paid">${openSteps.has(h.id) ? 'Hide payments' : 'Payments'}</button>`
      : !can('markPaid') ? ''
        : h.paidAt ? `<button class="link" data-act="unpaid" data-id="${h.id}">Undo</button>`
          : `<button class="link" data-act="paid" data-id="${h.id}">Mark paid</button>`;
    return `<span class="status ${st.key}">${esc(st.label)}</span> ${btn}`;
  };
  $('#hist-empty').textContent = teamState.team && !can('seeAllInvoices') ? "You haven't saved any invoices yet. As a team member, you see only the invoices and quotes you make." : 'No invoices saved yet.';
  $('#hist').innerHTML = invoices.map(h =>
    `<tr data-pick="${h.id}" tabindex="0" class="${h.id === histPick ? 'on' : ''}"><td>${esc(h.inv.number)}${h.savedBy ? `<div class="muted" title="Saved by ${esc(h.savedBy)}">by ${esc(h.savedBy.split('@')[0])}</div>` : ''}${h.private ? '<div class="muted" title="Personal: not shared with a team">🔒 Personal</div>' : ''}</td>
     <td>${esc(h.c.company)}</td><td>${esc(h.inv.date)}</td>
     <td class="num">${esc(money(h.total, h.c.currency))}</td>
     <td>${statusCell(h)}</td><td class="num">${backupCell(h)}</td></tr>`
     + (docType(h) === 'quote' && openSteps.has(h.id) ? stepsRow(h) : '')).join('');
  // What you can do with the one you picked.
  const h = invoices.find(x => x.id === histPick), bar = $('#hist-sel');
  bar.hidden = !h;
  if (!h) return;
  const what = docType(h) === 'quote' ? 'quote' : 'invoice', desk = !!window.api;
  bar.innerHTML = `<div class="hist-sel-what"><b>${esc(h.inv.number)}</b> · ${esc(h.c.company)} · ${esc(money(h.total, h.c.currency))}
      <span class="muted">${h.file ? esc(h.file.split(/[\\/]/).pop()) : desk ? 'Saved on another computer' : ''}</span></div>
    <div class="hist-sel-acts">
    ${h.file && desk ? `<button class="btn" data-act="open" data-id="${h.id}">Open</button><button class="btn" data-act="folder" data-id="${h.id}" title="Show the PDF in its folder">Show in folder</button>` : ''}
    ${h.file || !desk ? (make ? `<button class="btn" data-act="pdf" data-id="${h.id}" title="Save this again (e.g. after editing your details)">Re-save</button>` : '')
      : `<button class="btn" data-act="pdf" data-id="${h.id}" title="Saved on another computer. Make the PDF on this one too.">Save PDF here</button>`}
    ${make ? `<button class="btn" data-act="edit" data-id="${h.id}" title="Change this ${what} and save it again under the same number">Edit</button>
      <button class="btn" data-act="copy" data-id="${h.id}" title="Start a new invoice with these lines">Copy</button>
      ${what === 'quote' ? `<button class="btn" data-act="convert" data-id="${h.id}" title="Start an invoice from this quote">Make invoice</button>` : ''}
      <button class="btn" data-act="private" data-id="${h.id}" title="${h.private ? 'Share this with your team' : 'Keep this off your team'}">${h.private ? 'Share' : 'Make personal'}</button>
      <button class="btn danger" data-act="del" data-id="${h.id}" title="Remove from history">Remove</button>` : ''}
    </div>`;
}
function pickHistory(id) {
  histPick = histPick === id ? null : id;
  renderHistory(); refreshPreview(0);
}
$('#hist').onchange = e => { if (e.target.dataset.step != null) setStepPaid(e.target.dataset.id, Number(e.target.dataset.step), e.target.checked); };
$('#hist').onkeydown = e => { const tr = e.target.closest('tr[data-pick]'); if (tr && (e.key === 'Enter' || e.key === ' ') && e.target === tr) { e.preventDefault(); pickHistory(tr.dataset.pick); } };
$('#hist-sel').onclick = e => histAction(e);
$('#hist').onclick = e => {
  if (!e.target.closest('button, input, label')) { const tr = e.target.closest('tr[data-pick]'); if (tr) return pickHistory(tr.dataset.pick); }
  histAction(e);
};
async function histAction(e) {
  const { act, id } = e.target.dataset;
  const h = invoices.find(x => x.id === id); if (!h) return;
  if (act === 'folder') store.showInFolder(h.file);
  else if (act === 'pdf') { if (await savePdf(h)) { persist('invoices'); renderHistory(); } }
  else if (act === 'open') { const r = await store.open(h.file); if (r) toast(`Can't open it: ${r}`); }
  else if (act === 'drive') /^https:\/\//.test(h.backup) ? store.openExternal(h.backup) : store.showInFolder(h.backup);
  else if (act === 'backup') {
    e.target.disabled = true; e.target.textContent = 'Backing up…';
    const ok = await backupPdf(h);
    persist('invoices'); renderHistory();
    toast(ok ? `${h.inv.number} backed up to ${backupWhere()}` : `Backup failed: ${h.backupError}`);
  } else if (act === 'paid' || act === 'unpaid') {
    setPaid(id, act === 'paid');
  } else if (act === 'steps') {
    if (openSteps.has(id)) openSteps.delete(id); else openSteps.add(id);
    renderHistory();
  } else if (act === 'steps-all' || act === 'steps-none') {
    setAllStepsPaid(id, act === 'steps-all');
  } else if (act === 'convert') {
    if (!leaveEditing()) return;
    // A new invoice for the quote's client, with its lines; the quote remembers which invoice it became.
    draft = newDraft(client(h.c.id) ? h.c.id : undefined, 'invoice');
    draft.items = clone(h.inv.items).map(normItem);
    if (h.inv.discount) draft.discount = clone(h.inv.discount);
    draft.hideRates = !!h.inv.hideRates;
    h.convertedTo = draft.number; persist('invoices'); renderHistory();
    renderInvoice(); changed(); go('invoice');
    toast(`Started ${draft.number} from quote ${h.inv.number}. Check it and click Save invoice.`);
  } else if (act === 'private') {
    const on = !h.private, team = teamState.team && teamState.team.name;
    const c = client(h.c && h.c.id);
    if (team && !confirm(on
      ? `Make ${h.inv.number} personal?\n\nIt's removed from everyone else's Invaro in ${team}. Its number stays reserved, so nobody reuses it.`
      : `Share ${h.inv.number} with ${team}?\n\nEveryone in the team will see it${c && c.private ? `, including ${c.company}'s details on it (that client stays personal)` : ''}.`)) return;
    h.private = on; persist('invoices'); renderHistory();
    toast(on ? `${h.inv.number} is personal.` : `${h.inv.number} is ${team ? `shared with ${team}` : 'no longer personal'}.`);
  } else if (act === 'edit') {
    editSaved(h);
  } else if (act === 'copy') {
    if (!leaveEditing()) return;
    draft = newDraft(client(h.c.id) ? h.c.id : undefined);
    draft.items = clone(h.inv.items).map(normItem);
    if (h.inv.discount) draft.discount = clone(h.inv.discount);
    draft.hideRates = !!h.inv.hideRates;
    renderInvoice(); changed(); go('invoice');
  } else if (act === 'del' && confirm(`Remove ${h.inv.number} from history${teamState.team && !h.private ? ` for everyone in ${teamState.team.name}` : ''}? (PDF files are not deleted.)`)) {
    invoices = invoices.filter(x => x.id !== id); persist('invoices'); renderHistory(); refreshPreview(0);
    const back = settleStock(h.inv.number, []);
    if (back) toast(`${h.inv.number} removed. Its stock (${back}) is back on hand.`);
  }
}

// ---------- misc ----------
// Sets a field's value, unless it's the one being typed in (a team change mustn't move the cursor).
function setVal(el, v) { if (el !== document.activeElement || el.value === '') el.value = v; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function toast(msg, actLabel, act) {
  const t = $('#toast'); $('#toast-msg').textContent = msg;
  const b = $('#toast-act'); b.textContent = actLabel || ''; b.onclick = act || null;
  t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), act ? 6000 : 2500);
}
function go(tab) {
  currentTab = tab;
  $('main').classList.toggle('full', !PREVIEW_TABS.includes(tab));
  refreshPreview(0);
  $$('section[data-tab]').forEach(s => s.classList.toggle('show', s.dataset.tab === tab));
  $$('nav button').forEach(b => b.classList.toggle('active', b.dataset.go === tab));
  if (tab === 'clients') renderClients();
  if (tab === 'notifications') renderNotifications();
  if (tab === 'reports') renderReports();
  if (tab === 'history') renderHistory();
  if (tab === 'stock') renderStock();
  if (tab === 'dashboard') renderDashboard();
  if (tab === 'me' && store.teamRefresh && teamState.signedIn) store.teamRefresh().then(r => r && !r.error && renderTeam(r)); // new invitations
}
const tabShown = tab => $(`section[data-tab="${tab}"]`).classList.contains('show');
$$('nav button').forEach(b => b.onclick = () => go(b.dataset.go));

(async function init() {
  // stock.js loads after this file: wait for it (and the rest of the page) before starting.
  if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
  const d = await store.load();
  clients = d.clients; settings = d.settings; invoices = d.invoices; dataDir = d.dataDir;
  stock = d.stock || []; stockMoves = d.stockmoves || [];
  Object.assign(base, clone({ clients, settings, invoices, stock, stockmoves: stockMoves }));
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
  if (draft.editing && !numberUsed(draft.editing)) delete draft.editing; // removed meanwhile: it saves as a new one
  if (!draft.editing && numberUsed(draft.number)) draft.number = nextInvoiceNumber(draft.type || "invoice");
  editingClient = clients[0]?.id;
  initStock();
  renderInvoice(); renderClients(); renderMe(); renderHistory(); renderOverdue(); renderZoom(); refreshPreview();
  if (store.version) $('#app-version').textContent = 'v' + await store.version();
  renderUpdates();
  if (store.cloudStatus) {
    store.onCloudStatus(renderCloud);
    // Newer data arrived from another computer: reload to show it (pending local edits are dropped,
    // since the synced copy already includes everything that was saved).
    store.onDataChanged(change => {
      if (change && change.data && !change.all) return mergeRemote(change); // a team change: merge it in place
      Object.keys(timers).forEach(k => { clearTimeout(timers[k]); timers[k] = null; });
      location.reload();
    });
    if (store.teamStatus) { store.onTeamStatus(renderTeam); renderTeam(await store.teamStatus()); }
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
    // Opened by clicking a reminder notification while Invaro was closed.
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
  $('#update-msg').textContent = `Invaro ${u.version} is available (you have ${u.current}).` + (note ? ' ' + note : '');
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
  renderStockSync();
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
  const t = teamState && teamState.team ? teamState : null; // in a team, the team sync is what counts
  const busy = t ? t.busy : c.busy, err = t ? t.error : c.error;
  const when = busy ? 'syncing now…' : `last synced ${ago(t ? t.lastSync : c.lastSync)}`;
  el.className = 'drive-status ' + (err ? 'err' : 'on');
  el.textContent = `Signed in as ${c.email}${t ? `, working in ${t.team.name}` : ''}, ${when}.` + (!t && c.pending && !busy ? ` ${c.pending} change${c.pending === 1 ? '' : 's'} waiting to upload.` : '') + (err ? ` Problem: ${err}` : '');
  pill.hidden = false;
  pill.className = 'cloud-pill' + (err ? ' err' : '');
  pill.textContent = err ? '⚠ Sync problem' : busy ? '↻ Syncing…' : t ? `☁ ${t.team.name}` : '☁ Synced';
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
  if (!confirm('Delete your Invaro data from the cloud and sign out?\n\nYour clients, settings and invoice history are removed from your account. Everything on this computer stays as it is. This can\'t be undone.')) return;
  const r = await store.cloudDelete();
  toast(r && r.error ? `Couldn't delete: ${r.error}` : 'Your cloud data was deleted and you are signed out.');
  renderCloud(await store.cloudStatus());
};
setInterval(() => renderCloud(), 30 * 1000); // keeps "last synced … ago" current

// ---------- teams (team.js) ----------
// Merging a change from your team into what's on screen. For each client / invoice / setting:
// if you haven't touched it since the last save, take theirs; if you have, keep yours (it's uploaded
// next, and the later change wins). Then only the affected views are redrawn.
const canonJ = v => Array.isArray(v) ? `[${v.map(canonJ).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonJ(v[k])).join(',')}}` : JSON.stringify(v ?? null);
const same = (a, b) => canonJ(a) === canonJ(b);
function mergeList(local, before, theirs, key) {
  const was = new Map((before || []).map(x => [key(x), x])), mine = new Map(local.map(x => [key(x), x]));
  const out = [], seen = new Set();
  for (const t of theirs) {
    const k = key(t); seen.add(k);
    const l = mine.get(k);
    if (!l) { if (!was.has(k)) out.push(t); continue; } // gone here since the last save: stays gone
    out.push(same(l, was.get(k)) ? t : l);
  }
  for (const l of local) { // added here (keep), or deleted by them (drop, unless changed here)
    const k = key(l);
    if (seen.has(k)) continue;
    if (!was.has(k) || !same(l, was.get(k))) out.push(l);
  }
  return out;
}
function mergeRemote({ kinds, data }) {
  let mineToSave = [];
  if (kinds.includes('clients')) {
    const merged = mergeList(clients, base.clients, data.clients, c => c.id);
    merged.forEach(c => { c.items = (c.items || []).map(normItem); });
    clients = merged; base.clients = clone(data.clients);
    if (!same(clients, data.clients)) mineToSave.push('clients');
  }
  if (kinds.includes('invoices')) {
    const merged = mergeList(invoices, base.invoices, data.invoices, h => h.inv.number);
    merged.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    invoices = merged; base.invoices = clone(data.invoices);
    if (!same(invoices, data.invoices)) mineToSave.push('invoices');
  }
  for (const [name, set] of [['stock', v => { stock = v; }], ['stockmoves', v => { stockMoves = v; }]]) {
    if (!kinds.includes(name) || !data[name]) continue;
    const merged = mergeList(dataOf(name), base[name], data[name], x => x.id);
    set(merged); base[name] = clone(data[name]);
    if (!same(merged, data[name])) mineToSave.push(name);
  }
  if (kinds.includes('settings')) {
    const before = base.settings || {}, next = { ...data.settings };
    for (const k of new Set([...Object.keys(settings), ...Object.keys(data.settings)])) {
      if (k === 'draft') continue;
      if (!same(settings[k], before[k])) { if (settings[k] === undefined) delete next[k]; else next[k] = settings[k]; } // changed here
    }
    const logoChanged = next.logo !== settings.logo || !same(next.bank && next.bank.logo, settings.bank && settings.bank.logo);
    next.draft = settings.draft;
    settings = next; base.settings = clone(data.settings);
    if (!same(settings, data.settings)) mineToSave.push('settings');
    if (logoChanged && store.loadLogo) (async () => {
      logo = settings.logo ? await loadLogoImage(await store.loadLogo(settings.logo)) : null;
      bankLogo = settings.bank && settings.bank.logo ? await loadLogoImage(await store.loadLogo(settings.bank.logo)) : null;
      refreshPreview();
    })();
  }
  mineToSave.forEach(persist);
  // Redraw what changed, keeping the draft (and its number, unless someone just used it).
  if (draft && !client(draft.clientId) && clients.length) draft = newDraft();
  else if (draft && !draft.editing && numberUsed(draft.number) && !invoices.some(h => h.inv.number === draft.number && !h.savedBy)) draft.number = nextInvoiceNumber(draft.type || 'invoice');
  settings.nextNumber = nextNumberValue('invoice'); settings.nextQuoteNumber = Math.max(num(settings.nextQuoteNumber), nextNumberValue('quote'));
  if (kinds.includes('clients')) { renderClients(); renderInvoice(); }
  if (kinds.includes('settings')) { renderMe(); renderDesign(); renderBank(); renderInvoice(); }
  if (kinds.includes('invoices')) { renderHistory(); renderOverdue(); if (tabShown('reports')) renderReports(); if (tabShown('dashboard')) renderDashboard(); }
  if (kinds.includes('stock') || kinds.includes('stockmoves')) { liveStockRows.forEach(r => r.update()); if (tabShown('stock')) renderStock(); }
  if (tabShown('notifications')) renderNotifications();
  refreshPreview();
}

let teamState = { configured: false }, seenInvites = '', rightsKey = '';
const ROLE_NAMES = { admin: 'Admin', accountant: 'Accountant', member: 'Team member' };
const aRole = r => ({ admin: 'an admin', accountant: 'the accountant' }[r] || 'a team member');
const ROLE_HELP = {
  admin: team => `You're an admin of ${team}: you see and change everything, and choose who's in the team and what they can do.`,
  accountant: team => `You're the accountant for ${team}: you see every client and invoice and the reports, and mark invoices paid. You can't make or change invoices, clients or the business details.`,
  member: team => `You're a team member of ${team}: you make invoices and quotes, and see only the ones you made. Rates, billing, paid status, reports and the business details are left to the admins and the accountant.`,
};
// What your role in the team lets you do (see RIGHTS in team.js). Outside a team: everything.
const can = right => !teamState.team || !teamState.team.can || !!teamState.team.can[right];
const BILLING = ['currency', 'dueDays', 'hourlyRate', 'dailyRate', 'dayOffRate', 'taxRate'];
// Shows or hides what your role allows, everywhere. Runs when you join a team or your role changes.
function applyRights() {
  const key = JSON.stringify(teamState.team && teamState.team.can || null);
  if (key === rightsKey) return;
  rightsKey = key;
  const tabs = { invoice: can('createInvoices'), notifications: can('createInvoices'), reports: can('reports'), dashboard: can('reports') };
  for (const [tab, on] of Object.entries(tabs)) $(`nav [data-go="${tab}"]`).hidden = !on;
  const now = $$('section[data-tab]').find(s => s.classList.contains('show'));
  if (now && tabs[now.dataset.tab] === false) go(can('createInvoices') ? 'invoice' : 'history');
  const locked = !can('editBusiness');
  $('#biz').inert = locked; $('#biz').classList.toggle('locked', locked);
  $('#biz-locked').hidden = !locked;
  $('#biz-locked').textContent = locked ? `Your business details, banking, invoice design and numbering are shared by ${teamState.team.name}. Only an admin can change them.` : '';
  renderClients(); renderHistory(); renderOverdue(); renderReminders(lastDue);
  if (tabShown('stock')) renderStock();
}
const inviteMessage = (team, email) => `Hi! I've invited you to "${team}" in Invaro, so we can work on the same clients and invoices.

1. Install Invaro: https://github.com/BryceH1996/Invaro/releases/latest
2. Open My details → Account & sync, and sign in with Google as ${email}
3. Click Join next to the invitation.`;
function renderTeam(s) {
  teamState = s || teamState;
  renderStockSync();
  const t = teamState, box = $('#team-box');
  box.hidden = !t.configured || !t.signedIn;
  renderCloud();
  if (box.hidden) return;
  const n = $('#team-notice');
  n.hidden = !t.notice && !t.error;
  n.className = 'drive-status' + (t.error ? ' err' : '');
  n.textContent = t.error ? `Team sync problem: ${t.error}` : t.notice || '';
  n.title = t.notice ? 'Click to dismiss' : '';
  // Invitations for you
  $('#team-invited').innerHTML = (t.myInvites || []).map(i => `<div class="update-bar remind"><span><b>${esc(i.from)}</b> invited you to <b>${esc(i.team)}</b> as ${aRole(i.role)}.</span>
    <button class="btn primary" data-team-join="${esc(i.id)}" data-team-name="${esc(i.team)}">Join</button>
    <button class="btn" data-team-decline="${esc(i.id)}">Not now</button></div>`).join('');
  const key = (t.myInvites || []).map(i => i.id).join();
  if (key && key !== seenInvites) toast(`You've been invited to ${t.myInvites[0].team}.`, 'Show', () => { go('me'); $('#account').scrollIntoView({ behavior: 'smooth' }); });
  seenInvites = key;
  const inTeam = !!t.team, admin = inTeam && can('manageTeam');
  applyRights();
  $('#team-title').textContent = inTeam ? `Team: ${t.team.name}` : 'Work together';
  $('#inv-private-label').textContent = inTeam ? `Personal: don't share this with ${t.team.name}` : "Personal: don't share this with a team";
  $('#team-help').textContent = inTeam
    ? `${(ROLE_HELP[t.team.role] || ROLE_HELP.member)(t.team.name)} Changes show up on each other's screens within seconds. Backups and the PDF folder stay your own.`
    : 'Share one business with your partner or colleagues, kept in sync within seconds. Create a team, then invite people by email as an admin, an accountant or a team member, each seeing only what their role allows.';
  $('#team-none').hidden = inTeam;
  $('#team-in').hidden = !inTeam;
  if (!inTeam) return;
  const roleSelect = m => `<select data-team-role="${esc(m.user_id)}" data-email="${esc(m.email)}" title="Change what ${esc(m.email)} can see and do">`
    + Object.entries(ROLE_NAMES).map(([r, n]) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${n}</option>`).join('') + '</select>';
  const people = (t.members || []).map(m => `<div class="person"><span>${esc(m.email)}${m.email === t.me ? ' (you)' : ''}</span>`
    + (admin ? roleSelect(m) : `<small>${esc(ROLE_NAMES[m.role] || m.role)}</small>`)
    + (admin && m.email !== t.me ? `<button class="link warn" type="button" data-team-remove="${esc(m.user_id)}" data-email="${esc(m.email)}">Remove</button>` : '') + '</div>');
  const pending = (t.invites || []).map(i => `<div class="person"><span>${esc(i.email)}</span><small>Invited as ${esc(ROLE_NAMES[i.role] || 'Team member')}</small>
    <button class="link" type="button" data-team-copy="${esc(i.email)}">Copy invite message</button>
    <button class="link warn" type="button" data-team-cancel="${esc(i.id)}">Cancel</button></div>`);
  $('#team-members').innerHTML = people.concat(pending).join('');
  $('#team-invite-row').hidden = !admin;
  $('#team-delete').hidden = !admin;
}
const teamDo = async (fn, ok) => { const r = await fn(); if (r && r.error) { toast(r.error); return null; } renderTeam(r); if (ok) toast(ok); return r; };
$('#team-notice').onclick = () => store.teamClearNotice && store.teamClearNotice();
$('#team-create').onclick = async () => {
  const name = $('#team-name').value.trim() || (settings.me || {}).company || '';
  if (!name) { toast('Give your team a name, like your company name.'); return $('#team-name').focus(); }
  const pc = clients.filter(c => c.private).length, pi = invoices.filter(h => h.private).length;
  const kept = pc || pi ? `\n\nKept personal (not shared): ${[pc && `${pc} client${pc === 1 ? '' : 's'}`, pi && `${pi} invoice${pi === 1 ? '' : 's'}`].filter(Boolean).join(' and ')}.` : '\n\nTo keep a client or invoice to yourself, tick Personal on it first.';
  if (!confirm(`Create the team "${name}"?\n\nYour clients, invoices and business details on this computer become the team's, and everyone you invite will see and edit them.${kept}`)) return;
  await flushSaves();
  $('#team-create').disabled = true;
  await teamDo(() => store.teamCreate(name), `Team "${name}" created. Now invite your partner by email.`);
  $('#team-create').disabled = false;
};
$('#team-invite').onclick = async () => {
  const email = $('#team-email').value.trim(), role = $('#team-role').value;
  const r = await teamDo(() => store.teamInvite(email, role));
  if (!r) return;
  $('#team-email').value = '';
  const msg = inviteMessage(teamState.team.name, email.toLowerCase());
  toast(`Invited ${email} as ${aRole(role)}. Let them know: they sign in to Invaro with that address and click Join.`, 'Copy message', () => navigator.clipboard.writeText(msg).then(() => toast('Invite message copied. Paste it into an email or chat.')));
};
$('#team-email').onkeydown = e => { if (e.key === 'Enter') $('#team-invite').click(); };
$('#team-in').onclick = async e => {
  const d = e.target.dataset;
  if (d.teamCopy) { await navigator.clipboard.writeText(inviteMessage(teamState.team.name, d.teamCopy)); toast('Invite message copied. Paste it into an email or chat.'); }
  else if (d.teamCancel) teamDo(() => store.teamCancelInvite(d.teamCancel), 'Invitation cancelled.');
  else if (d.teamRemove && confirm(`Remove ${d.email} from ${teamState.team.name}?\n\nThey can't see or change the team's data any more. The copy already on their computer stays there.`))
    teamDo(() => store.teamRemoveMember(d.teamRemove), `${d.email} was removed.`);
};
$('#team-in').onchange = async e => {
  const d = e.target.dataset;
  if (!d.teamRole) return;
  const role = e.target.value, self = d.email === teamState.me;
  const what = { admin: 'see and change everything, and manage the team', accountant: 'see all clients, invoices and reports, and mark invoices paid, but not change anything else', member: 'make invoices and see only their own, without rates, paid status, reports or the business details' }[role];
  if (!confirm(`Make ${self ? 'yourself' : d.email} ${aRole(role)}?\n\n${self ? 'You' : 'They'} will ${what}.${self && role !== 'admin' ? "\n\nYou won't be able to change roles any more." : ''}`)) {
    renderTeam(); return; // puts the old role back in the list
  }
  e.target.disabled = true;
  await teamDo(() => store.teamSetRole(d.teamRole, role), `${self ? 'You are' : `${d.email} is`} now ${aRole(role)}.`);
  renderTeam();
};
$('#team-invited').onclick = async e => {
  const d = e.target.dataset;
  if (d.teamDecline) teamDo(() => store.teamDecline(d.teamDecline), 'Invitation declined.');
  if (!d.teamJoin) return;
  if (!confirm(`Join "${d.teamName}"?\n\nThis computer switches to the team's clients, invoices and business details. Your personal clients and invoices (ticked Personal) come along and stay yours. Your current files are copied to the backups folder in your data folder first.`)) return;
  await flushSaves();
  e.target.disabled = true;
  await teamDo(() => store.teamAccept(d.teamJoin)); // the window reloads with the team's data
};
$('#team-leave').onclick = async () => {
  if (!confirm(`Leave ${teamState.team.name}?\n\nYou keep a copy of everything on this computer, and it goes back to syncing with just your own account.`)) return;
  await flushSaves();
  teamDo(() => store.teamLeave(), 'You left the team. Your copy stays on this computer.');
};
$('#team-delete').onclick = async () => {
  if (!confirm(`Delete the team "${teamState.team.name}" for everyone?\n\nThe shared data is removed from the cloud and nobody can sync it any more. Everyone keeps the copy on their own computer. This can't be undone.`)) return;
  await flushSaves();
  teamDo(() => store.teamDelete(), 'Team deleted. Your copy stays on this computer.');
};

// ---------- updates settings ----------
async function renderUpdates() {
  if (!store.updateInfo) { $('#upd-status').textContent = 'Updates are only available in the desktop app.'; return; }
  const s = await store.updateInfo();
  $('#upd-repo').textContent = s.repo || '';
  $('#upd-status').className = 'drive-status on';
  $('#upd-status').textContent = `You have Invaro ${s.version}.`;
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
  dismissedVersion = $('#update-msg').textContent.match(/Invaro (\S+)/)?.[1];
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
