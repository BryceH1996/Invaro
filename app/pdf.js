// Draws the invoice with jsPDF. Layout mirrors the original Word template.
// lines: [{ desc, detail, amount }] — amounts already priced.
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function parseDate(s) { const [y, m, d] = (s || '').split('-').map(Number); return y ? new Date(y, (m || 1) - 1, d || 1) : null; }
function ordinal(d) { return (d % 100 >= 11 && d % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th'); }
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

function buildPdf({ me, c, inv, lines, pageSize }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: pageSize || 'letter' });
  const W = doc.internal.pageSize.getWidth();
  const L = (W - 469) / 2, R = L + 469, M = L + 264;
  const LIGHT = [255, 229, 153], DARK = [191, 144, 0], TEAL = [74, 143, 176];
  const cur = c.currency || '';

  // header blocks
  doc.setFillColor(...LIGHT); doc.rect(L, 87, M - L, 161, 'F');
  doc.setFillColor(...DARK);  doc.rect(M, 87, R - M, 161, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(20); doc.setTextColor(255);
  doc.text('INVOICE', R - 6, 121, { align: 'right' });

  // my details, bottom-aligned in the light block
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(0);
  const EMAIL = {};
  const rows = [...(me.address || '').split('\n').filter(Boolean), me.email ? EMAIL : null, me.phone].filter(Boolean);
  let y = 241 - 19.5 * (rows.length - 1);
  doc.text(me.name || '', L + 6, Math.max(y - 28, 105));
  for (const ln of rows) {
    if (ln === EMAIL) {
      doc.setTextColor(17, 85, 204);
      doc.textWithLink(me.email, L + 6, y, { url: 'mailto:' + me.email });
      doc.setDrawColor(17, 85, 204); doc.setLineWidth(0.6);
      doc.line(L + 6, y + 1.6, L + 6 + doc.getTextWidth(me.email), y + 1.6);
      doc.setTextColor(0);
    } else doc.text(ln, L + 6, y);
    y += 19.5;
  }

  // invoice meta
  doc.setFont('helvetica', 'bold'); doc.setTextColor(255);
  const lx = M + 6, vx = M + 82;
  doc.text('Invoice No.:', lx, 164);  doc.text(inv.number || '', vx, 164);
  doc.text('Invoice Date:', lx, 183); drawDate(doc, inv.date, vx, 183, 11);
  doc.text('Due Date:', lx, 202);     drawDate(doc, inv.due, vx, 202, 11);

  // bill to
  doc.setTextColor(0); doc.setFontSize(11);
  doc.text('BILL TO:', L + 6, 272);
  doc.setFont('helvetica', 'normal');
  y = 285.5;
  for (const ln of (c.address || '').split('\n').filter(Boolean)) { doc.text(ln, L + 6, y); y += 14; }
  if (c.contacts) { doc.text(c.contacts, L + 6, y); y += 18; }
  const co = [c.company, c.phone].filter(Boolean).join(' | ');
  if (co) { doc.text(co, L + 6, y); y += 14; }

  // table header
  let t = Math.max(354, y - 2);
  doc.setFillColor(...DARK); doc.rect(L, t, R - L, 30, 'F');
  doc.setFontSize(14); doc.setTextColor(255);
  doc.text('DESCRIPTION', L + 6, t + 20); doc.text('AMOUNT', R - 6, t + 20, { align: 'right' });
  t += 30;

  // rows
  const n = Math.max(8, lines.length);
  for (let i = 0; i < n; i++) {
    if (i % 2 === 1) { doc.setFillColor(...LIGHT); doc.rect(L, t, R - L, 30, 'F'); }
    const it = lines[i];
    if (it) {
      doc.setFontSize(11); doc.setTextColor(0);
      const amtText = money(it.amount, cur);
      const room = R - L - 24 - doc.getTextWidth(amtText);
      const d = doc.splitTextToSize(it.desc || '', room)[0] || '';
      doc.text(d, L + 6, t + 19);
      if (it.detail) {
        const x = L + 6 + doc.getTextWidth(d) + 8;
        doc.setFontSize(9); doc.setTextColor(110);
        const det = doc.splitTextToSize(it.detail, Math.max(room - (x - L - 6), 10))[0] || '';
        doc.text(det, x, t + 19);
        doc.setFontSize(11); doc.setTextColor(0);
      }
      doc.text(amtText, R - 6, t + 19, { align: 'right' });
    }
    t += 30;
  }

  // total
  t += 31;
  doc.setFontSize(11); doc.setTextColor(0);
  doc.setDrawColor(...TEAL); doc.setLineWidth(0.9);
  doc.line(M, t, R, t);
  doc.text('TOTAL', M - 6, t + 15.5, { align: 'right' });
  doc.text(money(lines.reduce((s, l) => s + l.amount, 0), cur), R - 6, t + 15.5, { align: 'right' });
  doc.line(M, t + 31, R, t + 31);

  // optional payment details / notes
  if (me.notes && me.notes.trim()) {
    doc.setFontSize(9.5); doc.setTextColor(80);
    let ny = t + 60;
    for (const ln of me.notes.split('\n')) {
      for (const part of doc.splitTextToSize(ln || ' ', R - L - 12)) { doc.text(part, L + 6, ny); ny += 13; }
    }
  }
  return doc;
}

function drawDate(doc, s, x, y, size) {
  const d = parseDate(s); if (!d) return;
  const day = String(d.getDate());
  doc.setFontSize(size); doc.text(day, x, y); x += doc.getTextWidth(day);
  doc.setFontSize(size * 0.62); const suf = ordinal(d.getDate());
  doc.text(suf, x + 0.3, y - size * 0.36); x += doc.getTextWidth(suf) + 0.6;
  doc.setFontSize(size); doc.text(` ${MONTHS[d.getMonth()]} ${d.getFullYear()}`, x, y);
}
