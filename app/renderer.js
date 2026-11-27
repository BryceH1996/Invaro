const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const clone = o => JSON.parse(JSON.stringify(o));
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
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
// Invoices, quotes and credit notes are numbered separately (INV-…, QUO-… and CN-… by default).
const DOC_TYPES = ['invoice', 'quote', 'credit'];
const docType = h => DOC_TYPES.includes(h.inv && h.inv.type) ? h.inv.type : 'invoice';
const prefixFor = type => type === 'quote' ? (settings.quotePrefix ?? 'QUO-') : type === 'credit' ? (settings.creditPrefix ?? 'CN-') : (settings.prefix || '');
function nextNumberValue(type = 'invoice') {
  const used = invoices.filter(h => docType(h) === type).map(h => numberOf(h.inv.number)).filter(n => !isNaN(n));
  const floor = type === 'quote' ? num(settings.nextQuoteNumber || 1) : type === 'credit' ? num(settings.nextCreditNumber || 1) : num(settings.nextNumber);
  return Math.max(floor, used.length ? Math.max(...used) + 1 : 0);
}
const nextInvoiceNumber = (type = 'invoice') => prefixFor(type) + nextNumberValue(type);
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
// New invoice: the invoice being drafted. Clients: an example invoice for the selected client. My details:
// an example invoice with your details, design and banking. History: the invoice you pick. The other
// tabs use the whole window and have no preview.
const PREVIEW_TABS = ['invoice', 'clients', 'me', 'history'];
let currentTab = 'invoice', histPick = null;
const previewUrls = [];
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
      const c = draftClient(); // a credit note is priced as its invoice was
      if (!c) return showPreview([], { empty: 'Add a client on the Clients tab to start an invoice.' });
      return showPreview([{ url: buildPdf(draftOptions(c, draft)).output('bloburl'), title: 'Invoice preview' }], { zoom: true });
    }
    if (tab === 'clients') {
      const c = client(editingClient);
      if (!c) return showPreview([], { empty: 'Add a client to see how they appear on your invoices.' });
      if (statementShown(c.id)) return showPreview([{ url: buildStatement(statementOptions(c)).output('bloburl'), title: `Statement for ${c.company}` }],
        { zoom: true, caption: `Statement for ${c.company || 'this client'}: what's been invoiced, paid and is still owed` });
      return showPreview([{ url: buildPdf(draftOptions(c, sampleInvoice(c))).output('bloburl'), title: 'How this client appears on an invoice' }],
        { zoom: true, caption: `How ${c.company || 'this client'} appears on an invoice${c.items && c.items.length ? ', with their default lines' : ' (example line)'}` });
    }
    if (tab === 'me') {
      const c = sampleClient();
      return showPreview([{ url: buildPdf(draftOptions(c, sampleInvoice(c))).output('bloburl'), title: 'Your invoices' }],
        { zoom: true, caption: 'Your details, logo, design and banking details, on an example invoice' });
    }
    const h = invoices.find(x => x.id === histPick);
    if (!h) return showPreview([], { empty: invoices.length ? 'Click an invoice or quote to see it here.' : 'Saved invoices and quotes appear here.' });
    if (h.imported && h.imported.pdf) {
      if (!h.file || !store.readPdf) return showPreview([], { empty: `${h.inv.number} was added as a PDF on another computer, so it can't be shown here.` });
      return store.readPdf(h.file).then(r => {
        if (!r || r.error || histPick !== h.id) return r && r.error ? showPreview([], { empty: `Can't show ${h.inv.number}: ${r.error}` }) : null;
        showPreview([{ url: URL.createObjectURL(new Blob([r], { type: 'application/pdf' })), title: `${h.inv.number} preview` }], { zoom: true, caption: `Added from ${h.imported.from}` });
      });
    }
    showPreview([{ url: buildPdf(pdfOptions(h)).output('bloburl'), title: `${h.inv.number} preview` }], { zoom: true, caption: h.imported ? `Imported from ${h.imported.from}. Invaro makes this PDF from what was imported.` : '' });
  }, delay);
}

function fileName(c, inv, me) {
  const p = parseDate((inv.period || inv.date.slice(0, 7)) + '-01');
  const word = { quote: 'Quote', credit: 'Credit Note' }[inv.type] || 'Invoice';
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
  if (!bytes && entry.imported && entry.imported.pdf) { // an old PDF brought in: back up the file itself
    const r = entry.file && store.readPdf ? await store.readPdf(entry.file) : null;
    if (!r || r.error) { entry.backup = null; entry.backupError = (r && r.error) || 'The PDF is only on the computer it was added on'; return false; }
    bytes = r;
  }
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
  // A client who still owes you gets a statement suggested, to send with this month's invoice.
  const owes = r => can('reports') && clientOwes(r.id) ? owesText(r.id) : '';
  $('#remind-bars').innerHTML = (due || []).map(r =>
    `<div class="update-bar remind"><span>Time to invoice <b>${esc(r.company)}</b> (reminder on ${esc(shortDate(r.date))}).${owes(r) ? ` They still owe ${esc(owes(r))}.` : ''}</span>
     <button class="btn primary" data-remind="invoice" data-id="${esc(r.id)}">Invoice now</button>
     ${owes(r) ? `<button class="btn" data-remind="statement" data-id="${esc(r.id)}" title="A statement of what ${esc(r.company)} owes, to send with the invoice">Statement</button>` : ''}
     <button class="btn" data-remind="skip" data-id="${esc(r.id)}" title="No more reminders for ${esc(r.company)} until next month">Skip this month</button></div>`).join('');
}
$('#remind-bars').onclick = async e => {
  const { remind, id } = e.target.dataset;
  if (remind === 'invoice') invoiceClient(id);
  else if (remind === 'statement') openStatement(id);
  else if (remind === 'skip') { renderReminders(await store.skipReminder(id)); if (tabShown('notifications')) renderNotifications(); }
};

// ---------- me tab ----------
function renderMe() {
  const me = settings.me || {};
  $$('[data-me]').forEach(el => setVal(el, me[el.dataset.me] ?? ''));
  $$('[data-set]').forEach(el => setVal(el, settings[el.dataset.set] ?? ''));
  $('#home-bank').value = fxBank();
  $('#home-bank-row').hidden = !homeCur() || !store.fxRate;
  $('#data-dir').textContent = dataDir;
}
$$('[data-me]').forEach(el => el.oninput = () => { (settings.me ||= {})[el.dataset.me] = el.value; persist('settings'); refreshPreview(); });
$$('[data-set]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
  settings[el.dataset.set] = el.type === 'number' ? num(el.value) : el.value;
  persist('settings'); refreshPreview();
  if (el.dataset.set === 'homeCurrency' || el.dataset.set === 'fxBank') { renderMe(); loadTodayRates(true); homeRatesArrived(); }
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
  // editor.js, clients.js, history.js, reports.js, account.js, stock.js and the rest load after this file: wait for them
  // (and the rest of the page) before starting. Code that runs as this file loads can't use them yet.
  if (document.readyState === 'loading') await new Promise(r => document.addEventListener('DOMContentLoaded', r, { once: true }));
  const d = await store.load();
  clients = d.clients; settings = d.settings; invoices = d.invoices; dataDir = d.dataDir;
  stock = d.stock || []; stockMoves = d.stockmoves || [];
  Object.assign(base, clone({ clients, settings, invoices, stock, stockmoves: stockMoves }));
  $('#home-cur').innerHTML = '<option value="">None</option>' + Object.entries(CURRENCIES).map(([code, { symbol, name }]) => `<option value="${code}">${code} (${symbol}) – ${name}</option>`).join('');
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
  let fixed = 0;
  for (const h of invoices) if (docType(h) === 'invoice' && !h.tracked && 'paidAt' in h) { h.tracked = true; fixed++; }
  if (fixed) await store.save('invoices', invoices);
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
