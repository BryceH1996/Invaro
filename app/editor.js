// The New invoice tab: the invoice or quote being drafted, its lines and discounts, editing a saved one, and Save invoice.
// Loaded after renderer.js, whose helpers ($, esc, money, persist, draft, client, newDraft, savePdf, refreshPreview…) it uses.

// ---------- invoice tab ----------
function renderClientOptions() {
  const opts = clients.map(c => `<option value="${esc(c.id)}">${c.private ? '🔒 ' : ''}${esc(c.company || '(unnamed)')}</option>`).join('');
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
  const quote = draft.type === 'quote', credit = draft.type === 'credit', editing = !!draft.editing;
  $$('#doc-type button').forEach(b => { b.classList.toggle('on', b.dataset.type === (quote ? 'quote' : 'invoice') && !credit); b.disabled = editing || credit; });
  $('#inv-heading').textContent = editing ? `Editing ${draft.editing}` : credit ? `Credit note for ${draft.creditFor}` : quote ? 'New quote' : 'New invoice';
  // While editing, the number, client and type stay as saved, so it replaces the right one. A credit
  // note stays with its invoice's client.
  $('#edit-bar').hidden = !editing; $('#edit-what').textContent = draft.editing || '';
  $('#credit-bar').hidden = !credit || editing; $('#credit-reason-row').hidden = !credit;
  if (credit) {
    const src = creditSource(draft), cur = draftClient() && draftClient().currency;
    $('#credit-for').textContent = draft.creditFor || '';
    $('#credit-left').textContent = src ? `${money(src.total, cur)}${creditedOn(src) ? `, ${money(creditedOn(src), cur)} already credited` : ''}` : 'no longer in History';
    setVal($('#inv-reason'), draft.reason || '');
  }
  $('#inv-number').readOnly = editing; $('#inv-client').disabled = editing || credit;
  $('#reset-draft').hidden = editing || credit;
  $('#due-cell').hidden = credit;
  $('#lbl-number').textContent = credit ? 'Credit note no.' : quote ? 'Quote no.' : 'Invoice no.';
  $('#lbl-date').textContent = credit ? 'Date' : quote ? 'Quote date' : 'Invoice date';
  $('#lbl-due').textContent = quote ? 'Valid until' : 'Due date';
  $('#download').textContent = editing ? 'Save changes' : credit ? 'Save credit note' : quote ? 'Save quote' : 'Save invoice';
  $('#inv-private').checked = !!draft.private;
  $('#inv-private-label').textContent = teamState.team ? `Personal: don't share this with ${teamState.team.name}` : "Personal: don't share this with a team";
  $('#inv-number').value = draft.number; $('#inv-period').value = draft.period;
  $('#inv-date').value = draft.date; $('#inv-due').value = draft.due;
  $('#inv-show-rates').checked = !draft.hideRates;
  $('#inv-disc-on').nextSibling.textContent = quote ? ' Discount on the whole quote' : credit ? ' Discount on the whole credit note' : ' Discount on the whole invoice';
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
  draft = back && client(back.clientId) ? { ...back, items: back.items.map(normItem) } : newDraft(draft.clientId, draft.type === 'credit' ? 'invoice' : draft.type);
  delete draft.editing;
  if (numberUsed(draft.number)) draft.number = nextInvoiceNumber(draft.type || 'invoice');
}
function editSaved(h) {
  const c = client(h.c && h.c.id);
  if (!c) return toast(`${h.c.company} isn't one of your clients any more, so ${h.inv.number} can't be edited. Use Copy to start a new one for another client.`);
  if (draft.editing === h.inv.number) return go('invoice');
  if (!leaveEditing()) return;
  const what = { quote: 'quote', credit: 'credit note' }[docType(h)] || 'invoice';
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

// ---------- credit notes ----------
// Credit note in History starts one for that invoice, with its lines exactly as they were billed: hours
// and days become items at the rates on the invoice (so a change of rates since doesn't change them),
// and its tax rate and currency come from the invoice too. Change or remove lines to credit only part.
const creditSource = d => d && d.type === 'credit' ? invoices.find(h => h.inv.number === d.creditFor && docType(h) === 'invoice') || null : null;
// The client as the draft is priced: for a credit note, as they were on the invoice it credits.
const draftClient = () => { const src = creditSource(draft); return src ? { ...(client(draft.clientId) || {}), ...src.c } : client(draft.clientId); };
function creditItems(h) {
  return (h.inv.items || []).map(normItem).map(it => {
    if (!['hours', 'days', 'daysoff'].includes(it.kind)) { const { stockId, ...rest } = it; return rest; } // credit notes don't move stock
    const sign = it.kind === 'daysoff' ? -1 : 1;
    return { ...it, kind: 'item', unit: { hours: 'hrs', days: 'days', daysoff: 'days off' }[it.kind], price: sign * rateFor(it.kind, h.c) };
  });
}
function startCredit(h) {
  if (!client(h.c && h.c.id)) return toast(`${h.c.company} isn't one of your clients any more, so ${h.inv.number} can't be credited.`);
  if (!leaveEditing()) return;
  if (draft.type !== 'credit') settings.putAside = clone(draft); // back to it after saving or cancelling
  draft = { type: 'credit', creditFor: h.inv.number, clientId: h.c.id, number: nextInvoiceNumber('credit'), private: !!h.private,
    date: todayIso(), due: '', period: h.inv.period || h.inv.date.slice(0, 7), reason: '',
    items: creditItems(h), hideRates: !!h.inv.hideRates, ...(h.inv.discount ? { discount: clone(h.inv.discount) } : {}) };
  renderInvoice(); changed(); go('invoice');
  if (creditedOn(h) > 0) toast(`${h.inv.number} already has ${money(creditedOn(h), h.c.currency)} credited. Take those lines off this one.`);
  $('#inv-reason').focus();
}
$('#credit-cancel').onclick = () => { const n = draft.creditFor; restoreDraft(); renderInvoice(); changed(); toast(`No credit note made for ${n}.`); };
$('#inv-reason').oninput = e => { draft.reason = e.target.value; changed(); };

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
  const c = draftClient() || {};
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
  const c = draftClient() || {};
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
  if (c && e.target.value && draft.type !== 'credit') { draft.due = addDays(e.target.value, draft.type === "quote" ? 30 : c.dueDays); $('#inv-due').value = draft.due; }
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

$('#download').onclick = async () => {
  const c = draftClient();
  if (!c) return toast('Add a client first');
  if (draft.type === 'credit' && !creditOkToSave()) return;
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
    entry.paidAt = previous.paidAt;
    entry.tracked = docType(entry) === 'invoice' ? true : previous.tracked; // saved again now: its paid status counts from here on
    if (previous.convertedTo) entry.convertedTo = previous.convertedTo; // a quote remembers its invoice
    if (previous.payments) entry.payments = previous.payments; // and an invoice its payments
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
  if (docType(entry) === 'credit') settings.nextCreditNumber = nextNumberValue('credit');
  // Done: back to what you were drafting before the edit or credit note, or on to the next one for the
  // same client, of the same kind, with the following number.
  // (savePdf has already said where it was saved and whether it was backed up.)
  if (editing || docType(entry) === 'credit') restoreDraft();
  else draft = newDraft(draft.clientId, draft.type);
  renderInvoice(); changed(); renderHistory(); renderMe(); renderOverdue();
};
// A credit note needs a reason (accountants and tax returns ask for one), something to credit, and
// shouldn't credit more than is left on the invoice (it asks).
function creditOkToSave() {
  const src = creditSource(draft), c = draftClient();
  if (!src) { toast(`${draft.creditFor} isn't in History any more, so there's nothing to credit.`); return false; }
  if (!String(draft.reason || '').trim()) { toast('Give a reason for the credit note, e.g. "Order cancelled".'); $('#inv-reason').focus(); return false; }
  const t = invoiceTotals(docLines(draft, c), c).total;
  if (!(t > 0)) { toast('The credit note comes to nothing. Keep the lines you\'re crediting.'); return false; }
  const others = creditsFor(src).filter(x => x.inv.number !== (draft.editing || draft.number));
  const room = round2(num(src.total) - others.reduce((s, x) => s + num(x.total), 0));
  return t <= room + 0.004 || confirm(`This credits ${money(t, c.currency)}, more than the ${money(room, c.currency)} left to credit on ${src.inv.number}. Save it anyway?`);
}

// In a team, a new invoice number is claimed before saving, so two people can't both use it.
// If someone just took it, the invoice gets the next free number. Returns false to stop saving.
async function claimNumber(entry) {
  for (let tries = 0; tries < 5; tries++) {
    const r = await store.teamClaimInvoice(entry);
    if (!r || r.ok) return true;
    if (r.error) { toast(`Couldn't check ${entry.inv.number} with your team (${r.error}). Saving it anyway.`); return true; }
    const type = docType(entry), old = entry.inv.number;
    const n = Math.max(nextNumberValue(type), (numberOf(old) || 0) + 1);
    entry.inv.number = prefixFor(type) + n;
    draft.number = entry.inv.number; renderInvoice(); refreshPreview();
    toast(`${old} was just used by ${r.by || 'someone in your team'}, so this one is ${entry.inv.number}.`);
  }
  toast("Couldn't find a free invoice number. Try again in a moment.");
  return false;
}
