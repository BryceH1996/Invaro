// Draws invoices with jsPDF. Three templates share the same data:
//   classic  – the original gold block layout
//   wave     – a curved colour header with a boxed table
//   minimal  – plain black and white with a tinted table header
// lines: [{ desc, detail, qty, price, amount }], amounts already priced.
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function parseDate(s) { const [y, m, d] = (s || '').split('-').map(Number); return y ? new Date(y, (m || 1) - 1, d || 1) : null; }
function ordinal(d) { return (d % 100 >= 11 && d % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th'); }
const pdfDate = s => { const d = parseDate(s); return d ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : ''; };
const CURRENCIES = {
  GBP: { symbol: '£', name: 'British pound' },
  USD: { symbol: '$', name: 'US dollar' },
  EUR: { symbol: '€', name: 'Euro' },
  ZAR: { symbol: 'R', name: 'South African rand' },
};
// Accepts a currency code (GBP) or, for older saved data, a bare symbol (£).
function curSymbol(cur) { return (CURRENCIES[cur] && CURRENCIES[cur].symbol) || cur || ''; }
function curCode(cur) {
  if (CURRENCIES[cur]) return cur;
  return Object.keys(CURRENCIES).find(k => CURRENCIES[k].symbol === cur) || 'GBP';
}
function money(n, cur) { n = Math.round((Number(n) || 0) * 100) / 100; return (n < 0 ? '-' : '') + curSymbol(cur) + Math.abs(n).toFixed(2); }

// ---------- templates and colours ----------
const TEMPLATES = {
  classic: { name: 'Classic', color: '#bf9000' },
  wave: { name: 'Wave', color: '#0b3d91' },
  minimal: { name: 'Minimal', color: '#7a7350' },
  bold: { name: 'Bold', color: '#e8590c' },
  elegant: { name: 'Elegant', color: '#8c6d46' },
  sidebar: { name: 'Sidebar', color: '#1d4e5f' },
};
const SWATCHES = ['#bf9000', '#0b3d91', '#0f766e', '#2e7d32', '#9b2335', '#5b3fa6', '#c2410c', '#374151'];
const hexRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const tint = (rgb, t) => rgb.map(v => Math.round(v + (255 - v) * t)); // t = 0 (colour) … 1 (white)
const shade = (rgb, t) => rgb.map(v => Math.round(v * (1 - t)));     // t = 0 (colour) … 1 (black)
const isLight = ([r, g, b]) => (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
// The template and colour to use, filling in defaults for anything missing. Takes either the
// settings form { template, colors: { wave: '#…' } } or a saved invoice's { template, color }.
function resolveDesign(design) {
  const ok = c => /^#[0-9a-f]{6}$/i.test(c || '');
  const template = TEMPLATES[design && design.template] ? design.template : 'classic';
  const color = design && ok(design.color) ? design.color
    : design && design.colors && ok(design.colors[template]) ? design.colors[template] : TEMPLATES[template].color;
  return { template, color: color.toLowerCase() };
}

// ---------- EFT / banking details ----------
// South African banks with their universal branch codes and SWIFT codes, from public directories.
// Codes we couldn't confirm are left blank for you to fill in; everything stays editable.
const SA_BANKS = [
  { id: 'absa', name: 'Absa', branch: '632005', swift: 'ABSAZAJJ' },
  { id: 'african', name: 'African Bank', branch: '430000', swift: 'AFRCZAJJ' },
  { id: 'bankzero', name: 'Bank Zero', branch: '888000', swift: '' },
  { id: 'bidvest', name: 'Bidvest Bank', branch: '462005', swift: 'BIDBZAJJ' },
  { id: 'capitec', name: 'Capitec Bank', branch: '470010', swift: 'CABLZAJJ' },
  { id: 'capitecbiz', name: 'Capitec Business', branch: '450105', swift: '' },
  { id: 'discovery', name: 'Discovery Bank', branch: '679000', swift: '' },
  { id: 'fnb', name: 'FNB (First National Bank)', branch: '250655', swift: 'FIRNZAJJ' },
  { id: 'grindrod', name: 'Grindrod Bank', branch: '', swift: 'GRIDZAJJ' },
  { id: 'investec', name: 'Investec', branch: '580105', swift: 'IVESZAJJ' },
  { id: 'nedbank', name: 'Nedbank', branch: '198765', swift: 'NEDSZAJJ' },
  { id: 'oldmutual', name: 'Old Mutual', branch: '', swift: '' },
  { id: 'standard', name: 'Standard Bank', branch: '051001', swift: 'SBZAZAJJ' },
  { id: 'tyme', name: 'TymeBank', branch: '678910', swift: '' },
];
const ACCOUNT_TYPES = ['Cheque / Current', 'Savings', 'Business', 'Transmission'];
// The label/value rows to print, skipping anything left blank.
function bankRows(bank, inv) {
  if (!bank || !bank.enabled) return [];
  return [
    ['Bank', bank.bankName], ['Account holder', bank.accountName], ['Account number', bank.accountNumber],
    ['Account type', bank.accountType], ['Branch code', bank.branchCode], ['SWIFT / BIC', bank.swift],
    ['Reference', bank.useReference ? (inv.number || '') : ''],
  ].filter(([, v]) => v && String(v).trim());
}
// Draws the "Banking details" box at (x, y), w wide; returns its height (0 when there's nothing to show).
function drawBankBox(doc, { bank, bankLogo, inv, x, y, w, accent }) {
  const rows = bankRows(bank, inv);
  if (!rows.length) return 0;
  const pad = 10, rowH = 13, logoW = bankLogo ? 92 : 0;
  const cols = w - logoW > 330 ? 2 : 1;
  const perCol = Math.ceil(rows.length / cols);
  const h = pad + 16 + perCol * rowH + pad - 3;
  doc.setFillColor(...tint(accent, 0.92)); doc.roundedRect(x, y, w, h, 4, 4, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...shade(accent, 0.35));
  doc.text('Banking details (EFT)', x + pad, y + pad + 8);
  if (bankLogo) drawLogo(doc, bankLogo, x + pad, y + pad + 16, logoW - 16, h - 2 * pad - 16, 'left');
  const colW = (w - 2 * pad - logoW) / cols, x0 = x + pad + logoW;
  doc.setFontSize(9);
  rows.forEach(([k, v], i) => {
    const cx = x0 + Math.floor(i / perCol) * colW, cy = y + pad + 16 + 9 + (i % perCol) * rowH;
    doc.setFont('helvetica', 'normal'); doc.setTextColor(110); doc.text(k, cx, cy);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(30);
    // Long values (e.g. a company name) shrink a little to fit before anything is cut off.
    let size = 9;
    while (size > 7 && doc.setFontSize(size).getTextWidth(String(v)) > colW - 78) size -= 0.5;
    doc.setFontSize(size);
    doc.text(doc.splitTextToSize(String(v), colW - 78)[0] || '', cx + 74, cy);
    doc.setFontSize(9);
  });
  return h;
}

// Subtotal, tax and total for a set of priced lines and a client's tax rate.
function invoiceTotals(lines, c) {
  const r2 = n => Math.round(n * 100) / 100;
  const subtotal = r2(lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const rate = Number(c && c.taxRate) || 0;
  const tax = r2(subtotal * rate / 100);
  return { subtotal, rate, tax, total: r2(subtotal + tax) };
}

// "VAT No: …" style lines for your business and for the client.
function idLines(me) {
  return [
    me.vatNumber && `VAT No: ${me.vatNumber}`,
    me.taxNumber && `Tax No: ${me.taxNumber}`,
    me.regNumber && `Company Reg: ${me.regNumber}`,
  ].filter(Boolean);
}
const clientIdLines = c => [c.vatNumber && `VAT No: ${c.vatNumber}`].filter(Boolean);

// Draws the logo inside a box (x, y, maxW, maxH), keeping its shape. align: 'left' | 'right'. Returns the height used.
function drawLogo(doc, logo, x, y, maxW, maxH, align) {
  if (!logo || !logo.data || !logo.w || !logo.h) return 0;
  const s = Math.min(maxW / logo.w, maxH / logo.h);
  const w = logo.w * s, h = logo.h * s;
  try { doc.addImage(logo.data, 'PNG', align === 'right' ? x + maxW - w : x, y, w, h, undefined, 'FAST'); } catch (e) { return 0; }
  return h;
}

// The words a template prints, for an invoice or a quote (inv.type === 'quote').
const WORDS = {
  invoice: { TITLE: 'INVOICE', Title: 'Invoice', no: 'Invoice No.', noLower: 'Invoice no.', hash: 'Invoice #', date: 'Invoice Date', due: 'Due Date', dueShort: 'Due', amountDue: 'AMOUNT DUE', totalDue: 'Total Due', terms: 'Payment Terms' },
  quote: { TITLE: 'QUOTE', Title: 'Quote', no: 'Quote No.', noLower: 'Quote no.', hash: 'Quote #', date: 'Quote Date', due: 'Valid Until', dueShort: 'Valid until', amountDue: 'QUOTE TOTAL', totalDue: 'Quote Total', terms: 'Validity' },
};
const docWords = inv => WORDS[inv && inv.type === 'quote' ? 'quote' : 'invoice'];

// opts: { me, c, inv, lines, pageSize, design, logo, taxLabel, bank, bankLogo }
function buildPdf(opts) {
  // Quotes aren't payable yet, so they leave out the banking details.
  if (opts.inv && opts.inv.type === 'quote') opts = { ...opts, bank: null, bankLogo: null };
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: opts.pageSize || 'letter' });
  const d = resolveDesign(opts.design);
  const ctx = { ...opts, doc, W: doc.internal.pageSize.getWidth(), H: doc.internal.pageSize.getHeight(),
    accent: hexRgb(d.color), isDefaultColor: d.color.toLowerCase() === TEMPLATES[d.template].color,
    totals: invoiceTotals(opts.lines, opts.c), taxLabel: opts.taxLabel || 'VAT', cur: opts.c.currency || '' };
  ({ classic: drawClassic, wave: drawWave, minimal: drawMinimal, bold: drawBold, elegant: drawElegant, sidebar: drawSidebar })[d.template](ctx);
  return doc;
}

// Wraps text to a width and draws it line by line; returns the y after the last line.
function textBlock(doc, lines, x, y, step, width, align) {
  for (const ln of lines) for (const part of (width ? doc.splitTextToSize(ln || ' ', width) : [ln])) {
    doc.text(part, x, y, align ? { align } : undefined); y += step;
  }
  return y;
}

// ---------- Classic ----------
function drawClassic({ doc, W, me, c, inv, lines, logo, bank, bankLogo, accent, isDefaultColor, totals, taxLabel, cur }) {
  const L = (W - 469) / 2, R = L + 469, M = L + 264;
  const DARK = accent;
  const LIGHT = isDefaultColor ? [255, 229, 153] : tint(accent, 0.72);
  const RULE = isDefaultColor ? [74, 143, 176] : accent;
  const ON = isLight(DARK) ? 0 : 255;

  // header blocks
  doc.setFillColor(...LIGHT); doc.rect(L, 87, M - L, 161, 'F');
  doc.setFillColor(...DARK);  doc.rect(M, 87, R - M, 161, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(ON);
  doc.text(docWords(inv).TITLE, R - 6, 121, { align: 'right' });

  // logo top-left, then my details bottom-aligned in the light block
  const top = 95 + (drawLogo(doc, logo, L + 6, 95, 150, 40) ? 40 + 10 : 0);
  const EMAIL = {};
  // Heading is the business name (or your name); with a business name, your name comes next.
  const heading = me.company || me.name || '';
  const rows = [...(me.company && me.name ? [me.name] : []), ...(me.address || '').split('\n').filter(Boolean),
    me.email ? EMAIL : null, me.phone, ...idLines(me)].filter(Boolean);
  // Bottom-aligned at the original spacing when it fits; otherwise squeezed in under the logo.
  const first = top + 11, gaps = Math.max(rows.length - 1, 0);
  let nameGap = 28, step = 19.5;
  if (first + nameGap + step * gaps > 241) { nameGap = 15; step = gaps ? Math.max(10.5, (241 - first - nameGap) / gaps) : 0; }
  let y = 241 - step * gaps;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(step < 15 ? 9 : 11); doc.setTextColor(0);
  doc.text(heading, L + 6, Math.max(y - nameGap, first));
  for (const ln of rows) {
    if (ln === EMAIL) {
      doc.setTextColor(17, 85, 204);
      doc.textWithLink(me.email, L + 6, y, { url: 'mailto:' + me.email });
      doc.setDrawColor(17, 85, 204); doc.setLineWidth(0.6);
      doc.line(L + 6, y + 1.6, L + 6 + doc.getTextWidth(me.email), y + 1.6);
      doc.setTextColor(0);
    } else doc.text(ln, L + 6, y);
    y += step;
  }

  // invoice meta
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(ON);
  const lx = M + 6, vx = M + 82;
  doc.text(docWords(inv).no + ':', lx, 164);  doc.text(inv.number || '', vx, 164);
  doc.text(docWords(inv).date + ':', lx, 183); drawDate(doc, inv.date, vx, 183, 11);
  doc.text(docWords(inv).due + ':', lx, 202);     drawDate(doc, inv.due, vx, 202, 11);

  // bill to
  doc.setTextColor(0); doc.setFontSize(11);
  doc.text('BILL TO:', L + 6, 272);
  doc.setFont('helvetica', 'normal');
  y = 285.5;
  for (const ln of (c.address || '').split('\n').filter(Boolean)) { doc.text(ln, L + 6, y); y += 14; }
  if (c.contacts) { doc.text(c.contacts, L + 6, y); y += 18; }
  const co = [c.company, c.phone].filter(Boolean).join(' | ');
  if (co) { doc.text(co, L + 6, y); y += 14; }
  for (const ln of clientIdLines(c)) { doc.text(ln, L + 6, y); y += 14; }

  // table header
  let t = Math.max(354, y - 2);
  doc.setFillColor(...DARK); doc.rect(L, t, R - L, 30, 'F');
  doc.setFontSize(14); doc.setTextColor(ON);
  doc.text('DESCRIPTION', L + 6, t + 20); doc.text('AMOUNT', R - 6, t + 20, { align: 'right' });
  t += 30;

  // rows
  const n = Math.max((totals.tax ? 7 : 8) - (bankRows(bank, inv).length ? 3 : 0), lines.length);
  for (let i = 0; i < n; i++) {
    if (i % 2 === 1) { doc.setFillColor(...LIGHT); doc.rect(L, t, R - L, 30, 'F'); }
    const it = lines[i];
    if (it) {
      doc.setFontSize(11); doc.setTextColor(0);
      const amtText = money(it.amount, cur);
      const room = R - L - 24 - doc.getTextWidth(amtText);
      const dsc = doc.splitTextToSize(it.desc || '', room)[0] || '';
      doc.text(dsc, L + 6, t + 19);
      if (it.detail) {
        const x = L + 6 + doc.getTextWidth(dsc) + 8;
        doc.setFontSize(9); doc.setTextColor(110);
        const det = doc.splitTextToSize(it.detail, Math.max(room - (x - L - 6), 10))[0] || '';
        doc.text(det, x, t + 19);
        doc.setFontSize(11); doc.setTextColor(0);
      }
      doc.text(amtText, R - 6, t + 19, { align: 'right' });
    }
    t += 30;
  }

  // subtotal and tax (only when the client is charged tax), then the total
  t += totals.tax ? 14 : 31;
  doc.setFontSize(11); doc.setTextColor(0);
  if (totals.tax) {
    doc.text('SUBTOTAL', M - 6, t + 4, { align: 'right' }); doc.text(money(totals.subtotal, cur), R - 6, t + 4, { align: 'right' });
    doc.text(`${taxLabel.toUpperCase()} (${totals.rate}%)`, M - 6, t + 21, { align: 'right' }); doc.text(money(totals.tax, cur), R - 6, t + 21, { align: 'right' });
    t += 31;
  }
  doc.setDrawColor(...RULE); doc.setLineWidth(0.9);
  doc.line(M, t, R, t);
  doc.text('TOTAL', M - 6, t + 15.5, { align: 'right' });
  doc.text(money(totals.total, cur), R - 6, t + 15.5, { align: 'right' });
  doc.line(M, t + 31, R, t + 31);

  // banking details, then optional notes
  let ny = t + 52;
  const bh = drawBankBox(doc, { bank, bankLogo, inv, x: L, y: ny, w: R - L, accent: DARK });
  ny += bh ? bh + 22 : 8;
  if (me.notes && me.notes.trim()) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(80);
    textBlock(doc, me.notes.split('\n'), L + 6, ny, 13, R - L - 12);
  }
}

function drawDate(doc, s, x, y, size) {
  const d = parseDate(s); if (!d) return;
  const day = String(d.getDate());
  doc.setFontSize(size); doc.text(day, x, y); x += doc.getTextWidth(day);
  doc.setFontSize(size * 0.62); const suf = ordinal(d.getDate());
  doc.text(suf, x + 0.3, y - size * 0.36); x += doc.getTextWidth(suf) + 0.6;
  doc.setFontSize(size); doc.text(` ${MONTHS[d.getMonth()]} ${d.getFullYear()}`, x, y);
}

// Who the invoice is from: your business name (or your name), then the rest.
function fromLines(me) {
  return [me.company && me.name ? me.name : null, ...(me.address || '').split('\n').filter(Boolean), me.email, me.phone, ...idLines(me)].filter(Boolean);
}
function toLines(c) {
  return [c.contacts, ...(c.address || '').split('\n').filter(Boolean), c.phone, ...clientIdLines(c)].filter(Boolean);
}

// Item table with Description / Qty / Price / Total columns, shared by Wave and Minimal.
function itemTable(doc, { x, w, y, lines, cur, minRows, rowH, header, font = 'helvetica', fontSize = 10 }) {
  const cols = header.order.map(k => ({ k, w: w * header.widths[k] }));
  let cx = x; cols.forEach(col => { col.x = cx; cx += col.w; });
  header.draw(cols, y);
  y += header.h;
  const n = Math.max(minRows, lines.length);
  for (let i = 0; i < n; i++) {
    header.row(cols, y, i);
    const it = lines[i];
    if (it) {
      doc.setFont(font, 'normal'); doc.setFontSize(fontSize); doc.setTextColor(60);
      const qty = it.qty === '' || it.qty == null ? '' : String(it.qty);
      const price = it.price === '' || it.price == null ? '' : money(it.price, cur);
      for (const col of cols) {
        const ty = y + rowH / 2 + 3.5;
        if (col.k === 'desc') {
          const text = doc.splitTextToSize(it.desc || '', col.w - 14)[0] || '';
          doc.text(text, col.x + 7, ty);
        } else {
          const v = { qty, price, total: money(it.amount, cur) }[col.k];
          doc.text(v, header.align === 'center' ? col.x + col.w / 2 : col.x + col.w - 7, ty, { align: header.align === 'center' ? 'center' : 'right' });
        }
      }
    }
    y += rowH;
  }
  return y;
}

// ---------- Wave ----------
function drawWave({ doc, W, H, me, c, inv, lines, logo, bank, bankLogo, accent, totals, taxLabel, cur }) {
  const L = 40, R = W - 40;
  const ON = isLight(accent) ? 30 : 255;
  const deep = shade(accent, 0.25), soft = tint(accent, 0.3);

  // curved header band, with a lighter streak across it
  doc.setFillColor(...accent);
  doc.lines([[W, 0], [0, 118], [-W * 0.35, 45, -W * 0.7, 10, -W, 77], [0, -195]], 0, 0, [1, 1], 'F', true);
  // (curve control points relative to (W, 118): (0.65W, 163), (0.3W, 128), ending at (0, 195))
  // a darker slanted panel on the right; its bottom follows the first half of the curve above
  doc.setFillColor(...deep);
  doc.lines([[W * 0.38, 0], [0, 118], [-W * 0.175, 22.5, -W * 0.35, 25, -W * 0.52, 30]], W * 0.62, 0, [1, 1], 'F', true);
  doc.setFillColor(...soft);
  doc.lines([[W * 0.12, -40, W * 0.38, -58, W * 0.66, -60], [-W * 0.06, 0], [-W * 0.26, 4, -W * 0.48, 22, -W * 0.6, 48]], 0, 70, [1, 1], 'F', true);

  doc.setFont('helvetica', 'bold'); doc.setTextColor(ON);
  doc.setFontSize(36); doc.text(docWords(inv).TITLE, L, 104);
  doc.setFontSize(13); doc.text(`NO: ${inv.number || ''}`, R, 104, { align: 'right' });

  // logo in the white space on the right, under the curve
  drawLogo(doc, logo, R - 160, 128, 160, 52, 'right');

  // bill to (left) and from (right)
  let y = 214;
  doc.setTextColor(70); doc.setFontSize(15);
  doc.text('Bill To:', L, y); doc.text('From:', R, y, { align: 'right' });
  doc.setFontSize(11.5);
  doc.text(c.company || '', L, y + 20);
  doc.text(me.company || me.name || '', R, y + 20, { align: 'right' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(95);
  const yl = textBlock(doc, toLines(c), L, y + 36, 14, (R - L) / 2 - 10);
  const yr = textBlock(doc, fromLines(me), R, y + 36, 14, null, 'right');
  y = Math.max(yl, yr) + 10;

  doc.setFontSize(11); doc.setTextColor(70);
  doc.text(`Date: ${pdfDate(inv.date)}`, L, y);
  if (inv.due) doc.text(`${docWords(inv).dueShort}: ${pdfDate(inv.due)}`, L + 190, y);
  y += 22;

  // table
  const grid = [150, 150, 150];
  y = itemTable(doc, { x: L, w: R - L, y, lines, cur, minRows: bankRows(bank, inv).length ? 4 : 6, rowH: 24,
    header: {
      h: 24, align: 'center', order: ['desc', 'qty', 'price', 'total'], widths: { desc: 0.44, qty: 0.12, price: 0.22, total: 0.22 },
      draw(cols, y0) {
        doc.setFillColor(...accent); doc.rect(L, y0, R - L, 24, 'F');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(ON);
        const names = { desc: 'Description', qty: 'Qty', price: 'Price', total: 'Total' };
        for (const col of cols) doc.text(names[col.k], col.x + col.w / 2, y0 + 16, { align: 'center' });
      },
      row(cols, y0) {
        doc.setDrawColor(...grid); doc.setLineWidth(0.6);
        doc.rect(L, y0, R - L, 24);
        for (const col of cols.slice(1)) doc.line(col.x, y0, col.x, y0 + 24);
      },
    } });

  // totals: subtotal and tax rows, then the total in a coloured box
  const bx = L + (R - L) * 0.52;
  y += 14;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(70);
  if (totals.tax) {
    doc.text('Sub Total', bx + 14, y + 12); doc.text(money(totals.subtotal, cur), R - 14, y + 12, { align: 'right' });
    doc.text(`${taxLabel} (${totals.rate}%)`, bx + 14, y + 30); doc.text(money(totals.tax, cur), R - 14, y + 30, { align: 'right' });
    y += 40;
  }
  doc.setFillColor(...accent); doc.rect(bx, y, R - bx, 26, 'F');
  doc.setFont('helvetica', 'bold'); doc.setTextColor(ON);
  doc.text(totals.tax ? 'Total' : 'Sub Total', bx + 14, y + 17);
  doc.text(money(totals.total, cur), R - 14, y + 17, { align: 'right' });
  y += 26;

  // banking details, payment information (your notes) and a thank-you
  let py = y + 28;
  const bh = drawBankBox(doc, { bank, bankLogo, inv, x: L, y: py, w: R - L, accent });
  py = bh ? py + bh + 26 : Math.max(py + 8, H - 190);
  if (me.notes && me.notes.trim()) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(60);
    doc.text('Payment Information:', L, py);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90);
    textBlock(doc, me.notes.split('\n'), L, py + 18, 14, (R - L) * 0.5);
  }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(30); doc.setTextColor(...deep);
  doc.text('Thank You!', R, Math.min(H - 40, Math.max(py + 30, bh ? 0 : H - 120)), { align: 'right' });
}

// ---------- Minimal ----------
function drawMinimal({ doc, W, H, me, c, inv, lines, logo, bank, bankLogo, accent, totals, taxLabel, cur }) {
  const L = 44, R = W - 44;
  const band = tint(accent, 0.9);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(40); doc.setTextColor(0);
  doc.text(docWords(inv).Title, L, 92);
  drawLogo(doc, logo, R - 170, 52, 170, 56, 'right');

  // three columns: from, to, invoice details
  const colW = (R - L) / 3, y0 = 146;
  const label = (text, x) => { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(140); doc.text(text, x, y0); };
  const block = (title, rest, x) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(60);
    let y = textBlock(doc, [title], x, y0 + 18, 13, colW - 14);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(70);
    return textBlock(doc, rest, x, y + 3, 13, colW - 14);
  };
  label('BILL FROM:', L); label('BILL TO:', L + colW);
  const ya = block((me.company || me.name || '').toUpperCase(), fromLines(me), L);
  const yb = block((c.company || '').toUpperCase(), toLines(c), L + colW);
  const mx = L + colW * 2 + 10;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
  [[docWords(inv).hash + ':', inv.number || ''], ['Issue Date:', pdfDate(inv.date)], [docWords(inv).due + ':', pdfDate(inv.due)]].forEach(([k, v], i) => {
    doc.setTextColor(140); doc.text(k, mx, y0 + i * 16);
    doc.setTextColor(40); doc.text(v, R, y0 + i * 16, { align: 'right' });
  });
  let y = Math.max(ya, yb, y0 + 48) + 24;

  // table
  y = itemTable(doc, { x: L, w: R - L, y, lines, cur, minRows: 6, rowH: 26,
    header: {
      h: 30, align: 'right', order: ['desc', 'price', 'qty', 'total'], widths: { desc: 0.52, price: 0.18, qty: 0.12, total: 0.18 },
      draw(cols, y1) {
        doc.setFillColor(...band); doc.rect(L, y1, R - L, 30, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(20);
        const names = { desc: 'Description', price: 'Price', qty: 'QTY', total: 'Total' };
        for (const col of cols) {
          if (col.k === 'desc') doc.text(names[col.k], col.x + 7, y1 + 19);
          else doc.text(names[col.k], col.x + col.w - 7, y1 + 19, { align: 'right' });
        }
      },
      row(cols, y1, i) {
        if (i > 0) { doc.setDrawColor(232); doc.setLineWidth(0.5); doc.line(L, y1, R, y1); }
      },
    } });
  y += 10;
  doc.setDrawColor(180); doc.setLineWidth(0.8); doc.line(L, y, R, y);

  // totals on the right
  const tx = L + (R - L) * 0.62;
  let ty = y + 26;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5); doc.setTextColor(40);
  doc.text('Subtotal', tx, ty); doc.text(money(totals.subtotal, cur), R - 7, ty, { align: 'right' });
  ty += 22;
  doc.text(totals.rate ? `${taxLabel} (${totals.rate}%)` : taxLabel, tx, ty); doc.text(money(totals.tax, cur), R - 7, ty, { align: 'right' });
  ty += 12;
  doc.setDrawColor(180); doc.line(tx, ty, R, ty);
  ty += 18;
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...shade(accent, 0.35));
  doc.text(docWords(inv).totalDue, tx, ty); doc.text(money(totals.total, cur), R - 7, ty, { align: 'right' });

  // payment terms and notes on the left
  let ly = y + 70;
  doc.setTextColor(20); doc.setFontSize(10.5);
  doc.text(docWords(inv).terms + ':', L, ly);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(70);
  const days = Number(c.dueDays);
  ly = textBlock(doc, [inv.type === 'quote' ? (inv.due ? `This quote is valid until ${pdfDate(inv.due)}.` : 'Prices are valid for 30 days.') : inv.due ? `Payment due by ${pdfDate(inv.due)}${days ? ` (${days} days)` : ''}.` : 'Payment due on receipt.'], L, ly + 16, 13, (R - L) * 0.5);
  // banking details across the page, under the totals
  const by = Math.max(ly + 12, ty + 26);
  const bh = drawBankBox(doc, { bank, bankLogo, inv, x: L, y: by, w: R - L, accent });
  if (bh) ly = by + bh + 8;
  if (me.notes && me.notes.trim()) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(20);
    doc.text('Notes:', L, ly + 14);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(70);
    textBlock(doc, me.notes.split('\n'), L, ly + 30, 13, (R - L) * 0.5);
  }
}

// ---------- helpers for the newer templates ----------
// The logo's size when fitted inside maxW × maxH (keeping its shape), or null without a logo.
function logoBox(logo, maxW, maxH) {
  if (!logo || !logo.data || !logo.w || !logo.h) return null;
  const s = Math.min(maxW / logo.w, maxH / logo.h);
  return { w: logo.w * s, h: logo.h * s };
}
function placeLogo(doc, logo, x, y, box) {
  try { doc.addImage(logo.data, 'PNG', x, y, box.w, box.h, undefined, 'FAST'); } catch (e) {}
}
// Logo on a white rounded tile, for dark or coloured backgrounds. Returns the tile height.
function logoTile(doc, logo, x, y, maxW, maxH) {
  const b = logoBox(logo, maxW, maxH); if (!b) return 0;
  doc.setFillColor(255, 255, 255); doc.roundedRect(x, y, b.w + 16, b.h + 16, 6, 6, 'F');
  placeLogo(doc, logo, x + 8, y + 8, b);
  return b.h + 16;
}
const totalRows = (totals, taxLabel) => [['Subtotal', totals.subtotal], ...(totals.tax ? [[`${taxLabel} (${totals.rate}%)`, totals.tax]] : [])];

// ---------- Bold ----------
// Dark header band with a colour stripe, a coloured "Amount due" block, and a dark total bar.
function drawBold({ doc, W, H, me, c, inv, lines, logo, bank, bankLogo, accent, totals, taxLabel, cur }) {
  const L = 40, R = W - 40, DARK = [33, 37, 41], ON = isLight(accent) ? 20 : 255;
  const hasBank = bankRows(bank, inv).length > 0;

  // header band
  doc.setFillColor(...DARK); doc.rect(0, 0, W, 118, 'F');
  doc.setFillColor(...accent); doc.rect(0, 118, W, 6, 'F');
  let hy = 52;
  const th = logoTile(doc, logo, L, 18, 130, 34);
  if (th) hy = 18 + th + 20;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(th ? 13 : 18); doc.setTextColor(255);
  doc.text(me.company || me.name || '', L, hy);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(190);
  doc.text([me.email, me.phone].filter(Boolean).join('   ·   '), L, hy + 14);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(32); doc.setTextColor(255);
  doc.text(docWords(inv).TITLE, R, 66, { align: 'right' });
  doc.setFontSize(12); doc.setTextColor(...accent);
  doc.text(`# ${inv.number || ''}`, R, 88, { align: 'right' });

  // amount due block, top right
  const bw = 176, bx = R - bw, by = 148;
  doc.setFillColor(...accent); doc.rect(bx, by, bw, 76, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(ON);
  doc.text(docWords(inv).amountDue, bx + 14, by + 20);
  doc.setFontSize(21); doc.text(money(totals.total, cur), bx + 14, by + 46);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  if (inv.due) doc.text(`${docWords(inv).dueShort} ${pdfDate(inv.due)}`, bx + 14, by + 64);
  doc.setTextColor(110); doc.text(`Issued ${pdfDate(inv.date)}`, bx, by + 94);

  // billed to and from
  const colW = (bx - L - 20) / 2;
  const block = (title, head, rest, x) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...accent); doc.text(title, x, 160);
    doc.setFontSize(11); doc.setTextColor(25); let y = textBlock(doc, [head], x, 177, 13, colW - 8);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(95);
    return textBlock(doc, rest, x, y + 1, 12, colW - 8);
  };
  const y1 = block('BILLED TO', c.company || '', toLines(c), L);
  const y2 = block('FROM', me.company ? me.name || '' : '', [...(me.address || '').split('\n').filter(Boolean), ...idLines(me)], L + colW + 10);
  let y = Math.max(y1, y2, by + 104) + 16;

  // items
  y = itemTable(doc, { x: L, w: R - L, y, lines, cur, minRows: hasBank ? 3 : 5, rowH: 24,
    header: {
      h: 26, align: 'right', order: ['desc', 'qty', 'price', 'total'], widths: { desc: 0.52, qty: 0.1, price: 0.19, total: 0.19 },
      draw(cols, y0) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...accent);
        const names = { desc: 'DESCRIPTION', qty: 'QTY', price: 'RATE', total: 'AMOUNT' };
        for (const col of cols) col.k === 'desc' ? doc.text(names.desc, col.x + 7, y0 + 16) : doc.text(names[col.k], col.x + col.w - 7, y0 + 16, { align: 'right' });
        doc.setDrawColor(...DARK); doc.setLineWidth(1.4); doc.line(L, y0 + 25, R, y0 + 25);
      },
      row(cols, y0) { doc.setDrawColor(228); doc.setLineWidth(0.6); doc.line(L, y0 + 24, R, y0 + 24); },
    } });

  // totals, then a dark total bar
  const tx = R - 230;
  let ty = y + 22;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(70);
  for (const [k, v] of totalRows(totals, taxLabel)) { doc.text(k, tx, ty); doc.text(money(v, cur), R - 10, ty, { align: 'right' }); ty += 18; }
  doc.setFillColor(...DARK); doc.rect(tx - 10, ty - 6, R - tx + 10, 30, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(255); doc.text('TOTAL', tx, ty + 13);
  doc.setFontSize(13); doc.setTextColor(...(isLight(accent) ? [255, 255, 255] : tint(accent, 0.15))); doc.text(money(totals.total, cur), R - 10, ty + 14, { align: 'right' });
  y = ty + 46;

  // banking details, notes, footer
  const bh = drawBankBox(doc, { bank, bankLogo, inv, x: L, y, w: R - L, accent });
  if (bh) y += bh + 18;
  if (me.notes && me.notes.trim()) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(90);
    textBlock(doc, me.notes.split('\n'), L, y + 4, 13, R - L);
  }
  doc.setDrawColor(...accent); doc.setLineWidth(1.2); doc.line(L, H - 44, R, H - 44);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(120);
  doc.text('Thank you for your business', W / 2, H - 28, { align: 'center' });
}

// ---------- Elegant ----------
// A centred serif letterhead with fine double rules, in the style of printed stationery.
function drawElegant({ doc, W, H, me, c, inv, lines, logo, bank, bankLogo, accent, totals, taxLabel, cur }) {
  const L = 56, R = W - 56, MID = W / 2, INK = [40, 36, 32];
  const hasBank = bankRows(bank, inv).length > 0;
  let y = 42;
  const lb = logoBox(logo, 150, 46);
  if (lb) { placeLogo(doc, logo, MID - lb.w / 2, y, lb); y += lb.h + 12; }
  doc.setFont('times', 'bold'); doc.setFontSize(21); doc.setTextColor(...INK);
  doc.text(me.company || me.name || '', MID, y + 16, { align: 'center' }); y += 32;
  doc.setFont('times', 'normal'); doc.setFontSize(10); doc.setTextColor(95);
  const sub = [
    (me.address || '').split('\n').filter(Boolean).join(' · '),
    [me.company ? me.name : '', me.email, me.phone].filter(Boolean).join(' · '),
    idLines(me).join(' · '),
  ].filter(Boolean);
  for (const ln of sub) for (const part of doc.splitTextToSize(ln, R - L)) { doc.text(part, MID, y, { align: 'center' }); y += 13; }
  y += 6;
  doc.setDrawColor(...accent); doc.setLineWidth(0.9); doc.line(L, y, R, y);
  doc.setLineWidth(0.35); doc.line(L, y + 3, R, y + 3);

  doc.setFont('times', 'italic'); doc.setFontSize(30); doc.setTextColor(...accent);
  doc.text(docWords(inv).Title, MID, y + 42, { align: 'center' });
  y += 72;

  // billed to (left) and invoice details (right)
  doc.setFont('times', 'italic'); doc.setFontSize(11); doc.setTextColor(...accent); doc.text('Billed to', L, y);
  doc.setFont('times', 'bold'); doc.setFontSize(12.5); doc.setTextColor(...INK);
  let yl = textBlock(doc, [c.company || ''], L, y + 17, 15, 240);
  doc.setFont('times', 'normal'); doc.setFontSize(10.5); doc.setTextColor(80);
  yl = textBlock(doc, toLines(c), L, yl, 13.5, 240);
  let yr = y;
  for (const [k, v] of [[docWords(inv).noLower, inv.number || ''], ['Date', pdfDate(inv.date)], [docWords(inv).dueShort, pdfDate(inv.due)]]) {
    doc.setFont('times', 'italic'); doc.setFontSize(11); doc.setTextColor(...accent); doc.text(k, R - 170, yr);
    doc.setFont('times', 'normal'); doc.setTextColor(...INK); doc.text(v, R, yr, { align: 'right' });
    yr += 17;
  }
  y = Math.max(yl, yr) + 20;

  // items
  y = itemTable(doc, { x: L, w: R - L, y, lines, cur, minRows: hasBank ? 3 : 5, rowH: 24, font: 'times', fontSize: 11,
    header: {
      h: 26, align: 'right', order: ['desc', 'qty', 'price', 'total'], widths: { desc: 0.54, qty: 0.1, price: 0.18, total: 0.18 },
      draw(cols, y0) {
        doc.setDrawColor(...accent); doc.setLineWidth(0.8); doc.line(L, y0, R, y0); doc.line(L, y0 + 26, R, y0 + 26);
        doc.setFont('times', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK);
        const names = { desc: 'Description', qty: 'Qty', price: 'Rate', total: 'Amount' };
        for (const col of cols) col.k === 'desc' ? doc.text(names.desc, col.x + 7, y0 + 17) : doc.text(names[col.k], col.x + col.w - 7, y0 + 17, { align: 'right' });
      },
      row() {},
    } });
  doc.setDrawColor(...accent); doc.setLineWidth(0.35); doc.line(L, y + 4, R, y + 4);

  // totals
  const tx = R - 210;
  let ty = y + 26;
  doc.setFont('times', 'normal'); doc.setFontSize(11); doc.setTextColor(70);
  for (const [k, v] of totalRows(totals, taxLabel)) { doc.text(k, tx, ty); doc.text(money(v, cur), R - 7, ty, { align: 'right' }); ty += 18; }
  doc.setDrawColor(...accent); doc.setLineWidth(0.8); doc.line(tx, ty - 6, R, ty - 6);
  doc.setFont('times', 'bold'); doc.setFontSize(14); doc.setTextColor(...accent);
  doc.text('Total', tx, ty + 12); doc.text(money(totals.total, cur), R - 7, ty + 12, { align: 'right' });
  y = ty + 36;

  // banking details, notes, footer
  const bh = drawBankBox(doc, { bank, bankLogo, inv, x: L, y, w: R - L, accent });
  if (bh) y += bh + 18;
  if (me.notes && me.notes.trim()) {
    doc.setFont('times', 'italic'); doc.setFontSize(10.5); doc.setTextColor(90);
    textBlock(doc, me.notes.split('\n'), L, y + 4, 14, R - L);
  }
  doc.setFont('times', 'italic'); doc.setFontSize(12); doc.setTextColor(...accent);
  doc.text('With thanks', MID, H - 40, { align: 'center' });
  doc.setLineWidth(0.5); doc.line(MID - 80, H - 44, MID - 40, H - 44); doc.line(MID + 40, H - 44, MID + 80, H - 44);
}

// ---------- Sidebar ----------
// A full-height colour sidebar with your logo, details, dates and EFT details; the client and
// items on the right.
function drawSidebar({ doc, W, H, me, c, inv, lines, logo, bank, bankLogo, accent, totals, taxLabel, cur }) {
  const SW = Math.round(W * 0.33), light = isLight(accent);
  const ON = light ? [25, 25, 25] : [255, 255, 255], SUB = light ? [85, 85, 85] : tint(accent, 0.6);
  doc.setFillColor(...accent); doc.rect(0, 0, SW, H, 'F');
  const sx = 26, sw = SW - 50;
  let sy = 36;
  const th = logoTile(doc, logo, sx, sy, sw - 16, 52);
  if (th) sy += th + 26; else sy += 8;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(24); doc.setTextColor(...ON); doc.text(docWords(inv).TITLE, sx, sy + 16);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11.5); doc.text(inv.number || '', sx, sy + 34);
  sy += 64;
  const section = title => { doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...SUB); doc.text(title, sx, sy); sy += 14; };
  const pair = (k, v) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...SUB); doc.text(k, sx, sy);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...ON);
    sy = textBlock(doc, [String(v)], sx, sy + 11, 11, sw) + 5;
  };

  section('FROM');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...ON);
  sy = textBlock(doc, [me.company || me.name || ''], sx, sy, 12, sw) + 1;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  sy = textBlock(doc, fromLines(me), sx, sy, 11, sw) + 16;

  section('DATES');
  pair('Issued', pdfDate(inv.date));
  if (inv.due) pair(docWords(inv).dueShort, pdfDate(inv.due));
  sy += 10;

  const rows = bankRows(bank, inv);
  if (rows.length) {
    section('PAY BY EFT');
    const bt = logoTile(doc, bankLogo, sx, sy - 4, sw - 16, 30);
    if (bt) sy += bt + 8;
    for (const [k, v] of rows) pair(k, v);
  }

  // main column
  const mx = SW + 32, MR = W - 36;
  let y = 64;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...shade(accent, light ? 0.45 : 0)); doc.text('BILLED TO', mx, y);
  doc.setFontSize(16); doc.setTextColor(25); y = textBlock(doc, [c.company || ''], mx, y + 22, 18, MR - mx);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(95);
  y = textBlock(doc, toLines(c), mx, y + 2, 13, MR - mx) + 26;

  y = itemTable(doc, { x: mx, w: MR - mx, y, lines, cur, minRows: 5, rowH: 26,
    header: {
      h: 28, align: 'right', order: ['desc', 'qty', 'price', 'total'], widths: { desc: 0.46, qty: 0.12, price: 0.21, total: 0.21 },
      draw(cols, y0) {
        doc.setFillColor(...tint(accent, 0.88)); doc.rect(mx, y0, MR - mx, 28, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...shade(accent, 0.3));
        const names = { desc: 'DESCRIPTION', qty: 'QTY', price: 'RATE', total: 'AMOUNT' };
        for (const col of cols) col.k === 'desc' ? doc.text(names.desc, col.x + 7, y0 + 18) : doc.text(names[col.k], col.x + col.w - 7, y0 + 18, { align: 'right' });
      },
      row(cols, y0) { doc.setDrawColor(232); doc.setLineWidth(0.6); doc.line(mx, y0 + 26, MR, y0 + 26); },
    } });

  const tx = MR - 200;
  let ty = y + 24;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(70);
  for (const [k, v] of totalRows(totals, taxLabel)) { doc.text(k, tx, ty); doc.text(money(v, cur), MR - 7, ty, { align: 'right' }); ty += 18; }
  doc.setDrawColor(...accent); doc.setLineWidth(1.2); doc.line(tx, ty - 6, MR, ty - 6);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...shade(accent, light ? 0.45 : 0));
  doc.text('Total', tx, ty + 14); doc.text(money(totals.total, cur), MR - 7, ty + 14, { align: 'right' });
  y = ty + 46;

  if (me.notes && me.notes.trim()) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(40); doc.text('Notes', mx, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(90);
    textBlock(doc, me.notes.split('\n'), mx, y + 15, 13, MR - mx);
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...shade(accent, light ? 0.45 : 0));
  doc.text('Thank you!', mx, H - 40);
}
