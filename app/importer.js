// Bringing your data in from other apps (from 1.28.0): QuickBooks (Online and Desktop), Xero, Sage,
// Wave, Zoho, FreshBooks or your own spreadsheet, exported as CSV or Excel (.xlsx), and old invoices
// that only exist as PDFs.
//
// A spreadsheet can hold customers (→ Clients), products and services (→ Stock) or invoices
// (→ History). Invaro works out which from its column names, which it reads the way each of those apps
// names them, and skips report headings and "Total for…" rows. Nothing changes until you've seen
// what will happen and clicked Import.
//
// Imported invoices count in History, Reports and the Dashboard with their paid status, and invoice
// numbering carries on after the highest one. They don't take stock off: that happened in the old app.

// ---------- reading a file: CSV, or Excel (.xlsx) unzipped here, with no add-ons ----------
async function readTableFile(file) {
  if (/\.xlsx$/i.test(file.name)) return readXlsx(await file.arrayBuffer());
  if (/\.(xls|numbers|ods)$/i.test(file.name)) throw new Error(`Invaro can't read ${file.name.split('.').pop().toUpperCase()} files. Open it and save it as Excel (.xlsx) or CSV first.`);
  return parseCsv(await file.text());
}
async function unzip(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf), files = {};
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("That file isn't a working Excel file.");
  let p = v.getUint32(eocd + 16, true);
  const count = v.getUint16(eocd + 10, true), dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    files[name] = { method, size, local };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return async name => {
    const f = files[name]; if (!f) return null;
    const start = f.local + 30 + v.getUint16(f.local + 26, true) + v.getUint16(f.local + 28, true);
    const data = u8.subarray(start, start + f.size);
    if (f.method === 0) return dec.decode(data);
    const out = new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')));
    return dec.decode(await out.arrayBuffer());
  };
}
const xmlDoc = s => new DOMParser().parseFromString(s, 'application/xml');
const DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);
async function readXlsx(buf) {
  const get = await unzip(buf);
  const wb = xmlDoc(await get('xl/workbook.xml') || '<x/>'), rels = xmlDoc(await get('xl/_rels/workbook.xml.rels') || '<x/>');
  const first = wb.getElementsByTagName('sheet')[0];
  const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
  let target = 'worksheets/sheet1.xml';
  for (const r of rels.getElementsByTagName('Relationship')) if (r.getAttribute('Id') === rid) target = r.getAttribute('Target');
  const sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  const strings = [...xmlDoc(await get('xl/sharedStrings.xml') || '<x/>').getElementsByTagName('si')].map(si => [...si.getElementsByTagName('t')].map(t => t.textContent).join(''));
  // Which cell styles are dates, so 45678 becomes 2025-01-21.
  const styles = xmlDoc(await get('xl/styles.xml') || '<x/>'), custom = {};
  for (const f of styles.getElementsByTagName('numFmt')) custom[f.getAttribute('numFmtId')] = f.getAttribute('formatCode') || '';
  const xfs = styles.getElementsByTagName('cellXfs')[0];
  const isDateStyle = [...(xfs ? xfs.getElementsByTagName('xf') : [])].map(x => {
    const id = Number(x.getAttribute('numFmtId'));
    return DATE_FORMATS.has(id) || (custom[id] && /[dy]/i.test(custom[id].replace(/"[^"]*"|\[[^\]]*\]/g, '')));
  });
  const sheet = xmlDoc(await get(sheetPath) || '<x/>'), rows = [];
  const colOf = ref => { let n = 0; for (const ch of String(ref).replace(/\d+$/, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  for (const row of sheet.getElementsByTagName('row')) {
    const cells = [];
    let next = 0;
    for (const c of row.getElementsByTagName('c')) {
      const i = c.getAttribute('r') ? colOf(c.getAttribute('r')) : next; next = i + 1;
      const t = c.getAttribute('t'), vEl = c.getElementsByTagName('v')[0], raw = vEl ? vEl.textContent : '';
      let val = raw;
      if (t === 's') val = strings[Number(raw)] ?? '';
      else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map(x => x.textContent).join('');
      else if (t === 'b') val = raw === '1' ? 'TRUE' : 'FALSE';
      else if ((!t || t === 'n') && raw !== '' && isDateStyle[Number(c.getAttribute('s') || 0)]) val = iso(new Date(Date.UTC(1899, 11, 30) + Math.round(Number(raw) * 86400000) + new Date().getTimezoneOffset() * 60000));
      cells[i] = val;
    }
    rows.push(Array.from(cells, x => x ?? ''));
  }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// ---------- what's in it ----------
const colKey = h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELDS = {
  customers: {
    display: ['customer', 'customername', 'displayname', 'customerfullname', 'contactname', 'client', 'clientname', 'name', 'accountname'],
    company: ['company', 'companyname', 'organisation', 'organization', 'business', 'businessname', 'legalname'],
    person: ['fullname', 'contactperson', 'primarycontact', 'attention', 'attentionto', 'poattentionto', 'mainContact'.toLowerCase()],
    first: ['firstname', 'givenname'], last: ['lastname', 'surname', 'familyname'],
    email: ['email', 'emailaddress', 'mainemail', 'primaryemail', 'contactemail'],
    phone: ['phone', 'phonenumber', 'telephone', 'tel', 'mainphone', 'workphone', 'mobile', 'mobilenumber', 'cell', 'cellphone', 'mobilephone'],
    line1: ['billingaddress', 'billingstreet', 'billingaddressline1', 'billingaddress1', 'billingstreet1', 'street', 'streetaddress', 'address', 'address1', 'addressline1', 'poaddressline1', 'line1', 'billtoaddress', 'billto1', 'billto'],
    line2: ['billingaddressline2', 'billingaddress2', 'billingstreet2', 'address2', 'addressline2', 'poaddressline2', 'line2', 'billto2'],
    line3: ['billingaddressline3', 'addressline3', 'poaddressline3', 'address3', 'line3', 'billto3'],
    city: ['city', 'billingcity', 'pocity', 'town', 'suburb', 'billingaddresscity'],
    region: ['state', 'region', 'province', 'county', 'billingstate', 'poregion', 'billingaddressstate', 'billingprovince'],
    postcode: ['zip', 'zipcode', 'postcode', 'postalcode', 'billingzip', 'popostalcode', 'billingpostalcode', 'billingaddresspostalcode'],
    country: ['country', 'billingcountry', 'pocountry', 'billingaddresscountry'],
    vatNumber: ['taxnumber', 'vatnumber', 'vatno', 'vatregistrationnumber', 'taxid', 'taxregistrationnumber', 'taxregno', 'businessnumber', 'abn', 'gstnumber', 'gstregistrationnumber', 'taxresaleno', 'resalenum', 'gstin'],
    currency: ['currency', 'currencycode', 'defaultcurrency'],
    terms: ['terms', 'paymentterms', 'paymentterm', 'termsname', 'duedatesalesday'],
  },
  invoices: {
    number: ['invoicenumber', 'invoiceno', 'invoicenum', 'invno', 'num', 'no', 'number', 'docnumber', 'documentnumber', 'transactionno', 'transactionnumber', 'invoice', 'invoiceid', 'refno', 'refnumber'],
    client: ['customer', 'customername', 'customerfullname', 'contactname', 'client', 'clientname', 'name', 'customerjob', 'billto', 'companyname', 'company', 'accountname'],
    date: ['invoicedate', 'date', 'txndate', 'transactiondate', 'issuedate', 'dateissued', 'documentdate', 'createddate'],
    due: ['duedate', 'datedue', 'due', 'paymentdue', 'paymentduedate'],
    type: ['transactiontype', 'type', 'doctype', 'documenttype', 'txntype'],
    status: ['status', 'invoicestatus', 'paymentstatus'],
    currency: ['currency', 'currencycode', 'invoicecurrency'],
    total: ['total', 'invoicetotal', 'totalamount', 'grandtotal', 'amountincltax', 'totalincltax', 'totalinclvat', 'gross', 'grossamount', 'invoiceamount', 'totalinclusive'],
    subtotal: ['subtotal', 'amountexcltax', 'netamount', 'net', 'totalexcltax', 'totalexclvat', 'excltax', 'nettotal'],
    tax: ['taxtotal', 'totaltax', 'tax', 'vat', 'vatamount', 'salestax', 'gst', 'taxamount', 'vattotal'],
    paid: ['amountpaid', 'invoiceamountpaid', 'paid', 'paidamount', 'totalpaid', 'payments', 'paymentsapplied'],
    balance: ['balance', 'openbalance', 'amountdue', 'invoiceamountdue', 'balancedue', 'outstanding', 'outstandingamount', 'dueamount'],
    paidDate: ['paiddate', 'datepaid', 'fullypaidondate', 'paymentdate', 'lastpaymentdate', 'paidon', 'datefullypaid'],
    desc: ['description', 'memodescription', 'linedescription', 'itemdescription', 'memo', 'productservice', 'productservicename', 'item', 'itemname', 'product', 'service', 'details'],
    qty: ['quantity', 'qty', 'units', 'hours'],
    price: ['unitamount', 'unitprice', 'rate', 'salesprice', 'salespricerate', 'price', 'unitrate'],
    amount: ['lineamount', 'linetotal', 'amount', 'itemamount', 'lineamountexcltax', 'linesubtotal'],
  },
  products: {
    name: ['productservicename', 'productservice', 'itemname', 'productname', 'item', 'product', 'name', 'service'],
    sku: ['sku', 'code', 'itemcode', 'productcode', 'stockcode', 'partnumber', 'partno'],
    price: ['salespricerate', 'salesprice', 'rate', 'price', 'sellingprice', 'unitprice', 'saleprice', 'retailprice'],
    cost: ['purchasecost', 'cost', 'costprice', 'unitcost', 'purchaseprice', 'buyprice'],
    onHand: ['quantityonhand', 'qtyonhand', 'onhand', 'stockonhand', 'quantity', 'stock'],
    type: ['type', 'itemtype', 'producttype'],
  },
};
// The columns that only one kind of file has, to tell them apart.
const MARKS = {
  customers: ['billingaddress', 'billingstreet', 'billingcity', 'poaddressline1', 'emailaddress', 'email', 'phone', 'mobile', 'taxnumber', 'vatnumber', 'firstname', 'lastname', 'terms', 'paymentterms', 'country', 'city', 'postcode', 'zip', 'postalcode', 'displayname', 'customerfullname'],
  invoices: ['invoicenumber', 'invoiceno', 'num', 'invoicedate', 'duedate', 'transactiontype', 'invoiceamountdue', 'invoiceamountpaid', 'openbalance', 'balancedue', 'amountdue', 'amountpaid', 'taxtotal', 'invoicetotal', 'txndate', 'paiddate'],
  products: ['sku', 'productservicename', 'productservice', 'quantityonhand', 'qtyonhand', 'purchasecost', 'salespricerate', 'reorderpoint', 'itemcode', 'stockcode', 'costprice'],
};
// Reports put a title, your company name and dates above the table: find the row of column names.
function findHeader(table) {
  let best = 0, bestScore = 0;
  const known = new Set(Object.values(FIELDS).flatMap(f => Object.values(f).flat()));
  for (let i = 0; i < Math.min(25, table.length); i++) {
    const score = table[i].filter(c => known.has(colKey(c))).length;
    if (score > bestScore) { best = i; bestScore = score; }
  }
  return bestScore >= 2 ? best : -1;
}
function detectKind(header) {
  const keys = header.map(colKey), score = {};
  for (const [k, marks] of Object.entries(MARKS)) score[k] = keys.filter(x => marks.includes(x)).length;
  return Object.keys(score).sort((a, b) => score[b] - score[a])[0];
}
// field → the columns it can come from, in order of preference.
function columnsFor(header, kind) {
  const keys = header.map(colKey), out = {};
  for (const [field, names] of Object.entries(FIELDS[kind])) out[field] = names.map(n => keys.indexOf(n)).filter(i => i >= 0);
  return out;
}
const cellOf = (row, cols, field) => { for (const i of cols[field] || []) { const v = String(row[i] ?? '').trim(); if (v) return v; } return ''; };
// Dates as yyyy-mm-dd from "2025-03-14", "14/03/2025", "03/14/2025", "14 Mar 2025", "Mar 14, 2025"…
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
let dayFirst = true; // set per file from dates that can only be read one way
// yyyy-mm-dd, or '' for a day that doesn't exist (31 February, 31 April, 29 February outside a leap year).
function realDate(y, mo, d) {
  if (y < 100) y += 2000;
  const t = new Date(y, mo - 1, d);
  return mo >= 1 && mo <= 12 && d >= 1 && t.getFullYear() === y && t.getMonth() === mo - 1 && t.getDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : '';
}
function parseAnyDate(s) {
  s = String(s || '').trim(); if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return realDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    let d = dayFirst ? a : b, mo = dayFirst ? b : a;
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return realDate(y, mo, d);
  }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([a-z]{3})[a-z]*\.?[\s\-,]+(\d{2,4})/i);
  if (m && MON.includes(m[2].toLowerCase())) return realDate(+m[3], MON.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  m = s.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i);
  if (m && MON.includes(m[1].toLowerCase())) return realDate(+m[3], MON.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  return '';
}
// "14/03/2025" says day first; "03/14/2025" says month first. Most South African and UK exports are day first.
function guessDayFirst(values) {
  let df = 0, mf = 0;
  for (const v of values) { const m = String(v).match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-]\d{2,4}/); if (!m) continue; if (+m[1] > 12) df++; if (+m[2] > 12) mf++; }
  return mf > df ? false : true;
}
const termsDays = t => { t = String(t || '').toLowerCase(); if (/receipt|immediate|cod|cash/.test(t)) return 0; const m = t.match(/(\d{1,3})/); return m ? Number(m[1]) : null; };
// A client by its name, or by another name the old app knew it by (c.aka: QuickBooks' "display name").
const findClientByName = name => {
  const k = String(name || '').trim().toLowerCase(); if (!k) return null;
  return clients.find(c => String(c.company || '').trim().toLowerCase() === k) || clients.find(c => (c.aka || []).some(a => String(a).trim().toLowerCase() === k)) || null;
};
const money2 = v => { const n = parseNumber(v); return n === undefined ? undefined : round2(n); };

// ---------- customers → Clients ----------
function planCustomers(table, cols, opts) {
  const seen = new Set();
  return table.map((row, n) => {
    const line = opts.headerRow + n + 2;
    const shown = cellOf(row, cols, 'display'), company = cellOf(row, cols, 'company') || shown;
    if (!company) return { line, status: 'skip', why: 'No name' };
    if (/^total\b/i.test(company)) return null;
    const k = company.toLowerCase();
    if (seen.has(k)) return { line, name: company, status: 'skip', why: 'Already earlier in the file' };
    seen.add(k);
    const person = cellOf(row, cols, 'person') || [cellOf(row, cols, 'first'), cellOf(row, cols, 'last')].filter(Boolean).join(' ');
    const address = [cellOf(row, cols, 'line1'), cellOf(row, cols, 'line2'), cellOf(row, cols, 'line3'),
      [cellOf(row, cols, 'city'), cellOf(row, cols, 'region'), cellOf(row, cols, 'postcode')].filter(Boolean).join(' '), cellOf(row, cols, 'country')].filter(Boolean).join('\n');
    const cur = cellOf(row, cols, 'currency').toUpperCase();
    const data = {
      company, contacts: person && person.toLowerCase() !== k ? person : '', email: cellOf(row, cols, 'email'), phone: cellOf(row, cols, 'phone'),
      address, vatNumber: cellOf(row, cols, 'vatNumber'), currency: CURRENCIES[cur] ? cur : '', dueDays: termsDays(cellOf(row, cols, 'terms')),
    };
    // Invoices from the old app name the customer the way it showed them, so that name is kept too.
    if (shown && shown.toLowerCase() !== k) data.aka = [shown];
    const item = findClientByName(company) || (shown && findClientByName(shown));
    if (!item) return { line, name: company, status: 'new', data };
    if (data.aka && (item.aka || []).some(a => a.toLowerCase() === shown.toLowerCase()) || item.company.toLowerCase() === (shown || '').toLowerCase()) delete data.aka;
    // An existing client only gets what's missing: nothing you've typed in Invaro is overwritten.
    const fill = Object.keys(data).filter(f => !['company', 'aka'].includes(f) && data[f] !== '' && data[f] != null && (item[f] === '' || item[f] == null));
    if (data.aka) fill.push('aka'); // the name its invoices use
    return { line, name: company, item, status: fill.length ? 'update' : 'same', data, fill };
  }).filter(Boolean);
}
const CLIENT_FIELD_NAMES = { aka: 'the name its invoices use', contacts: 'contact', email: 'email', phone: 'phone', address: 'address', vatNumber: 'VAT number', currency: 'currency', dueDays: 'payment terms' };
function newClient(fields) {
  return { id: uid(), company: '', contacts: '', phone: '', address: '', currency: usualCurrency(), dueDays: 30, hourlyRate: '', dailyRate: '', dayOffRate: '', items: [], ...fields };
}
function applyCustomers(plan) {
  let added = 0, updated = 0;
  for (const p of plan) {
    if (p.status === 'new') {
      const d = Object.fromEntries(Object.entries(p.data).filter(([, v]) => v !== '' && v != null));
      clients.push(newClient(d)); added++;
    } else if (p.status === 'update') { for (const f of p.fill) if (f !== 'aka') p.item[f] = p.data[f]; updated++; }
    if (p.item && p.data && p.data.aka) p.item.aka = [...new Set([...(p.item.aka || []), ...p.data.aka])];
  }
  persist('clients'); renderClients(); renderInvoice();
  return `${added} client${added === 1 ? '' : 's'} added${updated ? `, ${updated} filled in` : ''}`;
}

// ---------- invoices → History ----------
const NOT_INVOICE = /payment|credit|refund|estimate|quote|quotation|bill\b|expense|deposit|journal|receipt|sales receipt|statement|purchase|transfer|cheque|check/i;
const SKIP_STATUS = /void|deleted|draft|cancel|written off|write.?off/i;
function planInvoices(table, cols, opts) {
  dayFirst = guessDayFirst(table.flatMap(r => [cellOf(r, cols, 'date'), cellOf(r, cols, 'due')]));
  const lineMode = cols.desc.length > 0 && (cols.qty.length > 0 || cols.price.length > 0 || cols.amount.length > 0);
  const groups = new Map(), out = [];
  table.forEach((row, n) => {
    const line = opts.headerRow + n + 2, first = String(row.find(c => String(c).trim()) || '');
    if (/^total\b/i.test(first) || /^total for\b/i.test(first)) return; // report subtotals
    const number = cellOf(row, cols, 'number').replace(/^#/, '');
    if (!number) return;
    const type = cellOf(row, cols, 'type');
    if (type && NOT_INVOICE.test(type) && !/invoice/i.test(type)) return; // payments, credit notes… in a transaction list
    if (!groups.has(number)) groups.set(number, { number, line, rows: [] });
    groups.get(number).rows.push(row);
  });
  const used = new Set(invoices.map(h => String(h.inv.number).toLowerCase()));
  const newClients = new Map();
  for (const g of groups.values()) {
    const r0 = g.rows[0], get = f => { for (const r of g.rows) { const v = cellOf(r, cols, f); if (v) return v; } return ''; };
    const base = { line: g.line, number: g.number };
    if (used.has(g.number.toLowerCase())) { out.push({ ...base, status: 'skip', why: 'Already in History' }); continue; }
    const status = get('status');
    if (SKIP_STATUS.test(status)) { out.push({ ...base, status: 'skip', why: `${status} in the old app` }); continue; }
    const clientName = get('client');
    if (!clientName) { out.push({ ...base, status: 'skip', why: 'No customer' }); continue; }
    const date = parseAnyDate(get('date'));
    if (!date) { out.push({ ...base, clientName, status: 'skip', why: 'No date Invaro can read' }); continue; }
    const due = parseAnyDate(get('due')) || '';
    // Lines: one row per line, or one row per invoice.
    let items = [];
    if (lineMode) {
      for (const r of g.rows) {
        const desc = cellOf(r, cols, 'desc'), q = parseNumber(cellOf(r, cols, 'qty')), p = parseNumber(cellOf(r, cols, 'price')), a = parseNumber(cellOf(r, cols, 'amount'));
        if (!desc && a === undefined && p === undefined) continue;
        if (q !== undefined && p !== undefined && q !== 0) items.push({ kind: 'item', desc: desc || 'Item', qty: q, price: p });
        else items.push({ kind: 'fixed', desc: desc || 'Item', amount: a ?? 0 });
      }
    }
    // Totals as the old app had them.
    const lineish = cols.tax.length && ['taxamount'].includes(colKey((table.header || [])[cols.tax[0]]));
    let tax = lineMode && lineish ? round2(g.rows.reduce((t, r) => t + (parseNumber(cellOf(r, cols, 'tax')) || 0), 0)) : money2(get('tax'));
    let total = money2(get('total')), subtotal = money2(get('subtotal'));
    const linesSum = round2(items.reduce((t, it) => t + (it.kind === 'item' ? round2(num(it.qty) * num(it.price)) : num(it.amount)), 0));
    if (!lineMode && total === undefined && cols.amount.length) total = money2(get('amount'));
    if (subtotal === undefined && total !== undefined && tax !== undefined) subtotal = round2(total - tax);
    if (subtotal === undefined) subtotal = items.length ? linesSum : undefined;
    if (tax === undefined) tax = total !== undefined && subtotal !== undefined ? round2(total - subtotal) : 0;
    if (total === undefined && subtotal !== undefined) total = round2(subtotal + tax);
    if (total === undefined) { out.push({ ...base, clientName, status: 'skip', why: 'No amount' }); continue; }
    if (!items.length) items = [{ kind: 'fixed', desc: `Invoice ${g.number}`, amount: subtotal }];
    else if (Math.abs(linesSum - subtotal) > 0.01) {
      // Lines that included VAT, or a difference the old app had: one line makes the total match.
      items.push({ kind: 'fixed', desc: Math.abs(linesSum - total) <= 0.01 && tax ? `Less ${settings.taxLabel || 'VAT'} included above` : 'Adjustment (from the old app)', amount: round2(subtotal - linesSum) });
    }
    // Paid or not.
    const bal = money2(get('balance')), paidAmt = money2(get('paid'));
    const paid = /\bpaid\b/i.test(status) && !/partial|part paid|unpaid|not paid/i.test(status)
      || (bal !== undefined && Math.abs(bal) < 0.005 && total > 0)
      || (paidAmt !== undefined && paidAmt >= total - 0.005 && total > 0);
    const paidDate = parseAnyDate(get('paidDate'));
    const curCol = get('currency').toUpperCase();
    let client = findClientByName(clientName) || newClients.get(clientName.toLowerCase()) || null;
    if (!client) { client = newClient({ company: clientName, currency: CURRENCIES[curCol] ? curCol : opts.currency, dueDays: due ? Math.max(0, Math.round((parseDate(due) - parseDate(date)) / 864e5)) : 30, _new: true }); newClients.set(clientName.toLowerCase(), client); }
    const cur = CURRENCIES[curCol] ? curCol : curCode(client.currency || opts.currency);
    out.push({ ...base, status: 'new', clientName, client, date, due, cur, items, total, subtotal, tax, paid, paidAt: paid ? (paidDate || due || date) : null, guessedPaid: paid && !paidDate,
      partly: !paid && paidAmt > 0 ? paidAmt : 0 });
  }
  return out;
}
function applyInvoices(plan, source) {
  let n = 0;
  const made = new Set();
  for (const p of plan) {
    if (p.status !== 'new') continue;
    let c = p.client;
    if (c._new && !made.has(c)) { delete c._new; clients.push(c); made.add(c); }
    c = { ...clone(c), currency: p.cur, taxRate: p.tax && p.subtotal ? round2(p.tax / p.subtotal * 100) : 0 };
    const inv = { type: 'invoice', number: p.number, clientId: c.id, date: p.date, due: p.due || p.date, period: p.date.slice(0, 7), items: p.items.map(normItem), hideRates: false };
    const entry = {
      id: uid(), savedAt: p.date + 'T12:00:00.000Z', pageSize: settings.pageSize, inv, c, me: clone(settings.me || {}), lines: docLines(inv, c),
      design: clone(designNow()), taxLabel: settings.taxLabel || 'VAT', bank: clone(settings.bank || {}),
      total: p.total, subtotal: p.subtotal, tax: p.tax, tracked: true, paidAt: p.paidAt, imported: { from: source, at: new Date().toISOString() },
      // Partly paid in the old app: that much comes in as a part payment (dated the invoice, as the file has no date for it).
      ...(p.partly ? { payments: [{ amount: p.partly, on: p.date, note: `Paid before moving to Invaro (${source})` }] } : {}),
    };
    invoices.push(entry); n++;
  }
  invoices.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  if (made.size) { persist('clients'); renderClients(); }
  persist('invoices');
  settings.nextNumber = nextNumberValue('invoice'); persist('settings');
  if (!draft.editing && numberUsed(draft.number)) draft.number = nextInvoiceNumber(draft.type || 'invoice');
  renderInvoice(); renderHistory(); renderOverdue(); refreshPreview(0);
  return `${n} invoice${n === 1 ? '' : 's'} added to History${made.size ? `, with ${made.size} new client${made.size === 1 ? '' : 's'}` : ''}`;
}

// ---------- the import window ----------
let imx = null;
function imxOpen(o) {
  imx = o;
  $('#imx-title').textContent = o.title;
  $('#imx-note').innerHTML = o.note || ''; $('#imx-note').hidden = !o.note;
  $('#imx-opts').innerHTML = o.opts || ''; $('#imx-opts').hidden = !o.opts;
  if (o.bind) o.bind();
  imxRender();
  $('#imx-dlg').showModal();
}
function imxRender() {
  const r = imx.render();
  $('#imx-summary').innerHTML = r.summary;
  $('#imx-head').innerHTML = `<tr>${r.head.map((h, i) => `<th${r.num && r.num.includes(i) ? ' class="num"' : ''}>${h}</th>`).join('')}</tr>`;
  $('#imx-list').innerHTML = r.rows;
  $('#imx-go').disabled = !r.todo;
  $('#imx-go').textContent = r.todo ? r.go : 'Nothing to import';
}
$('#imx-cancel').onclick = () => { $('#imx-dlg').close(); imx = null; };
$('#imx-go').onclick = async () => {
  if (!imx) return;
  const b = $('#imx-go'); b.disabled = true;
  const msg = await imx.apply();
  if (msg === false) { b.disabled = false; return; }
  $('#imx-dlg').close(); imx = null;
  toast(msg);
};
const rowClass = st => `imp-${st === 'new' ? 'new' : st === 'update' ? 'update' : st === 'skip' ? 'skip' : 'same'}`;

// Picks a spreadsheet, works out what's in it and opens the right preview.
let imxWant = '';
function importSpreadsheet(want = '') { imxWant = want; $('#imx-file').value = ''; $('#imx-file').click(); }
$('#imx-file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  let table;
  try { table = await readTableFile(f); } catch (err) { return toast(err.message); }
  const h = findHeader(table);
  if (h < 0) return toast(`Couldn't find the column headings in ${f.name}. Export the list (not a summary report) and try again.`);
  const header = table[h], rows = table.slice(h + 1);
  let kind = detectKind(header);
  if (imxWant && kind !== imxWant && Object.values(columnsFor(header, imxWant)).some(c => c.length)) kind = imxWant === 'products' && kind === 'invoices' ? kind : imxWant;
  openSpreadsheet(f.name, header, rows, kind, h);
};
const KIND_NAMES = { customers: 'Customers → Clients', products: 'Products & services → Stock', invoices: 'Invoices → History' };
function kindPicker(kind) {
  return `<label class="check"><span>This file has</span> <select id="imx-kind">${Object.entries(KIND_NAMES).map(([k, v]) => `<option value="${k}"${k === kind ? ' selected' : ''}>${v}</option>`).join('')}</select></label>`;
}
function openSpreadsheet(name, header, rows, kind, headerRow) {
  const source = `${name}`;
  if (kind === 'products') {
    // Products go through the Stock tab's import, which knows stock (and QuickBooks' column names).
    const cols = columnsFor(header, 'products');
    const mapped = [header, ...rows.filter(r => !/^total\b/i.test(String(r.find(c => String(c).trim()) || '')))];
    if (!can('editStock')) return toast('Only an admin can import stock.');
    go('stock');
    openImport({ title: `Import ${name}`, source: `Spreadsheet: ${name}`, table: mapped, setCounts: cols.onHand.length ? 'ask' : false,
      note: 'Products and services from your old app. Services come in without a stock count.' });
    return;
  }
  if (kind === 'customers') {
    if (!can('addClients')) return toast("Your role in the team can't add clients.");
    const cols = columnsFor(header, 'customers');
    imxOpen({
      title: `Import ${name}`, opts: kindPicker(kind),
      note: 'New customers become clients. A client you already have (same name) only gets the details it\'s missing: nothing you\'ve typed in Invaro is changed. Rates and tax are left for you to set on the Clients tab.',
      bind: () => { $('#imx-kind').onchange = e => { $('#imx-dlg').close(); openSpreadsheet(name, header, rows, e.target.value, headerRow); }; },
      render() {
        this.plan = planCustomers(rows, cols, { headerRow });
        const n = st => this.plan.filter(p => p.status === st).length;
        return {
          summary: `${this.plan.length} customers: ${[[n('new'), 'new'], [n('update'), 'to fill in'], [n('same'), 'already the same'], [n('skip'), 'skipped']].filter(x => x[0]).map(x => x.join(' ')).join(', ')}.`,
          head: ['Customer', 'What happens'], todo: n('new') + n('update'), go: `Import ${n('new') + n('update')} client${n('new') + n('update') === 1 ? '' : 's'}`,
          rows: this.plan.slice(0, 500).map(p => `<tr class="${rowClass(p.status)}"><td>${esc(p.name || '')}</td><td>${p.status === 'new' ? 'New client' : p.status === 'update' ? 'Fills in ' + esc(p.fill.map(f => CLIENT_FIELD_NAMES[f] || f).join(', ')) : p.status === 'skip' ? esc(p.why) : 'No change'}</td></tr>`).join(''),
        };
      },
      apply() { return applyCustomers(this.plan); },
    });
    return;
  }
  // Invoices
  if (!can('createInvoices') || (teamState.team && !can('editBilling'))) return toast('Only an admin can import invoices into a team.');
  const cols = columnsFor(header, 'invoices');
  imxOpen({
    title: `Import ${name}`,
    opts: kindPicker(kind) + `<label class="check"><span>Customers without a currency in the file are billed in</span> <select id="imx-cur">${Object.keys(CURRENCIES).map(k => `<option${k === usualCurrency() ? ' selected' : ''}>${k}</option>`).join('')}</select></label>`,
    note: 'Invoices come into History with their paid status, and count in Reports and the Dashboard. They don\'t take stock off. Customers you don\'t have yet are added as clients. Invaro makes a PDF from each one when you open it.',
    bind: () => {
      $('#imx-kind').onchange = e => { $('#imx-dlg').close(); openSpreadsheet(name, header, rows, e.target.value, headerRow); };
      $('#imx-cur').onchange = imxRender;
    },
    render() {
      this.plan = planInvoices(Object.assign(rows, { header }), cols, { headerRow, currency: $('#imx-cur').value });
      const add = this.plan.filter(p => p.status === 'new'), skip = this.plan.filter(p => p.status === 'skip');
      const newC = new Set(add.filter(p => p.client._new).map(p => p.client));
      const unpaid = add.filter(p => !p.paid).length;
      const nums = [...invoices.filter(h => docType(h) === 'invoice').map(h => h.inv.number), ...add.map(p => p.number)].map(numberOf).filter(x => !isNaN(x));
      const next = Math.max(num(settings.nextNumber), nums.length ? Math.max(...nums) + 1 : 0);
      return {
        summary: `${add.length} invoice${add.length === 1 ? '' : 's'} to add (${add.length - unpaid} paid, ${unpaid} unpaid)${skip.length ? `, ${skip.length} skipped` : ''}${newC.size ? `, ${newC.size} new client${newC.size === 1 ? '' : 's'}` : ''}. Your next invoice will be ${esc((settings.prefix || '') + next)}.`,
        head: ['No.', 'Customer', 'Date', 'Total', 'Status'], num: [3], todo: add.length, go: `Import ${add.length} invoice${add.length === 1 ? '' : 's'}`,
        rows: [...add, ...skip].slice(0, 500).map(p => p.status === 'skip'
          ? `<tr class="imp-skip"><td>${esc(p.number)}</td><td>${esc(p.clientName || '')}</td><td colspan="3">${esc(p.why)}</td></tr>`
          : `<tr class="imp-new"><td>${esc(p.number)}</td><td>${esc(p.clientName)}${p.client._new ? ' <span class="muted">(new client)</span>' : ''}</td><td>${esc(p.date)}</td><td class="num">${esc(money(p.total, p.cur))}</td>
             <td>${p.paid ? `<span class="status paid">Paid${p.paidAt ? ' ' + esc(shortDate(p.paidAt)) : ''}</span>${p.guessedPaid ? ' <span class="muted" title="The file has no payment date, so it\'s the due date">(date guessed)</span>' : ''}` : `<span class="status unpaid">Unpaid</span>${p.partly ? ` <span class="muted">${esc(money(p.partly, p.cur))} paid so far</span>` : ''}`}</td></tr>`).join(''),
      };
    },
    apply() { return applyInvoices(this.plan, name); },
  });
}

// ---------- old PDF invoices ----------
// Invaro reads each PDF's text and suggests its client, number, dates and total; you check them,
// then each PDF is copied into its client's folder and listed in History as it is.
function guessFromPdf(f) {
  const text = String(f.text || ''), flat = text.replace(/\s+/g, ' ');
  dayFirst = guessDayFirst(flat.match(/\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/g) || []);
  const datesIn = s => (s.match(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b|\b\d{1,2}(?:st|nd|rd|th)?[\s\-]+[A-Za-z]{3,9}\.?[\s\-,]+\d{4}\b|\b[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/g) || []).map(parseAnyDate).filter(Boolean);
  const after = (re, len = 60) => { const m = flat.match(re); return m ? flat.slice(m.index + m[0].length, m.index + m[0].length + len) : ''; };
  const number = (flat.match(/(?:tax\s+)?invoice\s*(?:no\.?|number|num|#)\s*[:#.]?\s*([A-Z0-9][A-Z0-9\-\/_.]*\d[A-Z0-9\-\/_]*)/i) || flat.match(/\b(?:inv|invoice)[\s\-#:]*([A-Z]*-?\d{2,})\b/i) || [])[1]
    || (f.name.match(/([A-Z]{0,5}-?\d{3,})/i) || [])[1] || '';
  const date = datesIn(after(/invoice date|date of issue|issue date|invoice dated|\bdate\b/i))[0] || datesIn(flat)[0] || '';
  const due = datesIn(after(/due date|payment due|due by|\bdue\b/i))[0] || '';
  const AMT = /(?:R|ZAR|£|GBP|\$|USD|€|EUR)?\s?-?(?:\d{1,3}(?:[ ,]\d{3})+|\d+)[.,]\d{2}\b/g;
  const amountAfter = re => { let m, last = null; const g = new RegExp(re.source, 'gi'); while ((m = g.exec(flat))) last = m; if (!last) return undefined; const a = flat.slice(last.index + last[0].length, last.index + last[0].length + 40).match(AMT); return a ? parseNumber(a[0]) : undefined; };
  const total = amountAfter(/(?:total due|amount due|balance due|grand total|total amount|invoice total|total (?:incl\.?|including) (?:vat|tax))/) ?? amountAfter(/(?<!sub)\btotal\b/);
  const tax = amountAfter(/\b(?:vat|gst|sales tax)\b(?!\s*(?:no|number|reg))/) ?? 0;
  const sym = (flat.match(/(R|ZAR|£|GBP|\$|USD|€|EUR)\s?\d/) || [])[1] || '';
  const curGuess = { R: 'ZAR', ZAR: 'ZAR', '£': 'GBP', GBP: 'GBP', $: 'USD', USD: 'USD', '€': 'EUR', EUR: 'EUR' }[sym] || '';
  const known = findNamed(text, clients, c => c.company);
  let client = known ? known.company : '';
  if (!client) { const m = text.match(/(?:bill(?:ed)? to|invoice to|customer|client|to)\s*:?\s*\n?\s*([^\n]{2,60})/i); if (m) client = m[1].trim().replace(/[,:]$/, ''); }
  const paid = /\bpaid\b/i.test(flat) && !/unpaid|not paid/i.test(flat) || /(?:amount|balance) due\s*:?\s*(?:R|£|\$|€)?\s?0[.,]00\b/i.test(flat);
  return { file: f, include: !f.error, client, number, date, due, total, tax, cur: (known && curCode(known.currency)) || curGuess || usualCurrency(), paidSaid: paid };
}
async function importPdfs() {
  if (!store.pickOldPdfs) return toast('Adding old PDFs works in the desktop app.');
  if (!can('createInvoices') || (teamState.team && !can('editBilling'))) return toast('Only an admin can add old invoices to a team.');
  toast('Reading your PDFs…');
  const files = await store.pickOldPdfs();
  if (!files || files.error) return toast(files ? files.error : 'Couldn\'t open them');
  if (!files.length) return;
  const rows = files.map(guessFromPdf);
  const used = new Set(invoices.map(h => String(h.inv.number).toLowerCase()));
  imxOpen({
    title: `Add ${rows.length} old invoice${rows.length === 1 ? '' : 's'}`,
    note: 'Invaro has read what it can from each PDF. Check each row, fill in any gaps, and untick any you don\'t want. Each PDF is copied into its client\'s folder and shows in History as it is. New client names become clients.',
    opts: `<label class="check"><span>Paid status</span> <select id="imx-paid"><option value="all">All of these are paid (on their due date)</option><option value="each" selected>I'll tick the paid ones</option><option value="none">None of these are paid yet</option></select></label>
      <datalist id="imx-clients">${clients.map(c => `<option value="${esc(c.company)}">`).join('')}</datalist>`,
    bind: () => {
      $('#imx-paid').onchange = e => { const v = e.target.value; if (v !== 'each') rows.forEach(r => { r.paid = v === 'all'; }); imxRender(); };
      rows.forEach(r => { r.paid = r.paidSaid; });
      $('#imx-list').oninput = $('#imx-list').onchange = e => {
        const tr = e.target.closest('tr[data-i]'); if (!tr) return;
        const r = rows[tr.dataset.i], f = e.target.dataset.f;
        r[f] = e.target.type === 'checkbox' ? e.target.checked : ['total', 'tax'].includes(f) ? parseNumber(e.target.value) : e.target.value;
        if (f === 'client') { const c = findClientByName(r.client); if (c) { r.cur = curCode(c.currency); tr.querySelector('[data-f=cur]').value = r.cur; } }
        imxCheck(rows, used);
        const t = rows.filter(x => x.include && !x.problem).length;
        $('#imx-go').disabled = !t; $('#imx-go').textContent = t ? `Add ${t} invoice${t === 1 ? '' : 's'}` : 'Nothing to add';
        tr.className = r.problem ? 'imp-skip' : r.include ? 'imp-new' : 'imp-same';
        tr.querySelector('.imx-why').textContent = r.problem || '';
        $('#imx-summary').textContent = imxSummary(rows);
      };
    },
    render() {
      imxCheck(rows, used);
      const cur = Object.keys(CURRENCIES).map(k => `<option>${k}</option>`).join('');
      return {
        summary: imxSummary(rows), head: ['', 'PDF', 'Client', 'No.', 'Date', 'Due', 'Currency', 'Total', esc(settings.taxLabel || 'VAT'), 'Paid'], num: [7, 8],
        todo: rows.filter(x => x.include && !x.problem).length, go: `Add ${rows.filter(x => x.include && !x.problem).length} invoices`,
        rows: rows.map((r, i) => `<tr data-i="${i}" class="${r.problem ? 'imp-skip' : r.include ? 'imp-new' : 'imp-same'}">
          <td><input type="checkbox" data-f="include"${r.include ? ' checked' : ''}${r.file.error ? ' disabled' : ''}></td>
          <td class="imx-file" title="${esc(r.file.path)}">${esc(r.file.name)}<div class="muted imx-why">${esc(r.problem || '')}</div></td>
          <td><input data-f="client" list="imx-clients" value="${esc(r.client)}" placeholder="Client"></td>
          <td><input data-f="number" value="${esc(r.number)}" placeholder="No." class="imx-s"></td>
          <td><input data-f="date" type="date" value="${esc(r.date)}"></td>
          <td><input data-f="due" type="date" value="${esc(r.due)}"></td>
          <td><select data-f="cur">${cur.replace(`<option>${r.cur}</option>`, `<option selected>${r.cur}</option>`)}</select></td>
          <td><input data-f="total" type="number" step="0.01" value="${r.total ?? ''}" class="imx-n"></td>
          <td><input data-f="tax" type="number" step="0.01" value="${r.tax ?? ''}" class="imx-n"></td>
          <td><input type="checkbox" data-f="paid"${r.paid ? ' checked' : ''}></td></tr>`).join(''),
      };
    },
    async apply() { return applyPdfs(rows, used); },
  });
}
function imxCheck(rows, used) {
  const seen = new Set();
  for (const r of rows) {
    const n = String(r.number || '').trim().toLowerCase();
    r.problem = r.file.error ? r.file.error
      : !r.include ? ''
      : !String(r.client || '').trim() ? 'Which client?'
      : !n ? 'Type its invoice number'
      : used.has(n) ? 'That number is already in History'
      : seen.has(n) ? 'Same number as another PDF here'
      : !r.date ? 'Type its date'
      : !(r.total > 0) ? 'Type its total' : '';
    if (n) seen.add(n);
  }
}
const imxSummary = rows => { const ok = rows.filter(x => x.include && !x.problem).length, bad = rows.filter(x => x.include && x.problem).length; return `${ok} ready to add${bad ? `, ${bad} need${bad === 1 ? 's' : ''} checking (in red)` : ''}.`; };
async function applyPdfs(rows, used) {
  imxCheck(rows, used);
  const todo = rows.filter(x => x.include && !x.problem);
  if (!todo.length) return false;
  let added = 0, failed = 0; const made = [];
  for (const r of todo) {
    let c = findClientByName(r.client);
    if (!c) { c = newClient({ company: r.client.trim(), currency: r.cur, dueDays: r.due ? Math.max(0, Math.round((parseDate(r.due) - parseDate(r.date)) / 864e5)) : 30 }); clients.push(c); made.push(c); }
    const copy = await store.copyOldPdf(r.file.path, c.company);
    if (!copy || copy.error) { failed++; r.problem = copy ? copy.error : 'Couldn\'t copy it'; continue; }
    const total = round2(r.total), tax = round2(r.tax || 0), subtotal = round2(total - tax);
    const cc = { ...clone(c), currency: r.cur, taxRate: tax && subtotal ? round2(tax / subtotal * 100) : 0 };
    const inv = { type: 'invoice', number: r.number.trim(), clientId: c.id, date: r.date, due: r.due || r.date, period: r.date.slice(0, 7), items: [normItem({ kind: 'fixed', desc: `Invoice ${r.number.trim()} (see the PDF)`, amount: subtotal })], hideRates: false };
    const entry = {
      id: uid(), savedAt: r.date + 'T12:00:00.000Z', pageSize: settings.pageSize, inv, c: cc, me: clone(settings.me || {}), lines: docLines(inv, cc),
      design: clone(designNow()), taxLabel: settings.taxLabel || 'VAT', bank: clone(settings.bank || {}), total, subtotal, tax, tracked: true,
      paidAt: r.paid ? (r.due || r.date) : null, file: copy.path, imported: { from: r.file.name, at: new Date().toISOString(), pdf: true },
    };
    invoices.push(entry); used.add(entry.inv.number.toLowerCase()); added++;
    backupPdf(entry).then(() => persist('invoices'));
  }
  invoices.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  if (made.length) { persist('clients'); renderClients(); }
  persist('invoices');
  settings.nextNumber = nextNumberValue('invoice'); persist('settings');
  if (!draft.editing && numberUsed(draft.number)) draft.number = nextInvoiceNumber(draft.type || 'invoice');
  renderInvoice(); renderHistory(); renderOverdue(); refreshPreview(0);
  return `${added} old invoice${added === 1 ? '' : 's'} added to History${made.length ? `, with ${made.length} new client${made.length === 1 ? '' : 's'}` : ''}${failed ? `. ${failed} couldn't be copied.` : '.'}`;
}

$('#hist-import').onclick = () => importSpreadsheet('invoices');
$('#hist-pdfs').onclick = importPdfs;
$('#cl-import').onclick = () => importSpreadsheet('customers');
$('#me-import').onclick = () => importSpreadsheet('');
