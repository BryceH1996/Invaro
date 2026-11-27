// History: every saved invoice and quote, paid / unpaid / overdue, and quotes paid in steps.
// Loaded after renderer.js, whose helpers ($, esc, money, persist, invoices, draft, savePdf, backupPdf, refreshPreview…) it uses.

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
    const box = edit ? `<input type="checkbox" data-step="${i}" data-id="${esc(h.id)}" ${d ? 'checked' : ''}>` : `<span>${d ? '✓' : ''}</span>`;
    return `<label class="step${d ? ' done' : ''}">${box}<span class="step-desc">${esc(l.desc || '(no description)')}${l.detail || off ? ` <span class="muted">${esc((l.detail || '') + off)}</span>` : ''}</span>
      <span class="num">${esc(money(round2(stepNet(lines, i) * s.factor), cur))}</span>
      <span class="muted step-date">${d ? 'Paid ' + esc(shortDate(d)) : ''}</span></label>`;
  }).join('');
  const all = edit ? (s.paidCount === s.count
    ? `<button class="link" data-act="steps-none" data-id="${esc(h.id)}">Clear all</button>`
    : `<button class="link" data-act="steps-all" data-id="${esc(h.id)}">Mark all paid</button>`) : '';
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

// ---------- payments and credit notes: what's still owed on an invoice ----------
// h.payments: [{ amount, on, note?, full? }], every payment towards an invoice (from 1.31.0). "Mark paid"
// records whatever was still owed as a payment ({ full: true }) and sets h.paidAt; the last of several
// part payments sets h.paidAt too. Invoices marked paid before 1.31.0 have only h.paidAt: paid in full
// that day. h.paidAt stays "the day it was paid in full", which Reports' exchange rates and the
// reminders (main.js) go by.
// A credit note (inv.type 'credit', inv.creditFor = the invoice's number) takes its total off what the
// invoice owes. Its total is positive; Reports and the Dashboard count it as a negative amount.
const isCredit = h => docType(h) === 'credit';
const creditsFor = h => docType(h) !== 'invoice' ? [] : invoices.filter(x => isCredit(x) && x.inv.creditFor === h.inv.number);
const creditedOn = h => round2(creditsFor(h).reduce((s, x) => s + num(x.total), 0));
const paymentsOf = h => Array.isArray(h.payments) ? h.payments : h.paidAt ? [{ on: h.paidAt, amount: num(h.total), implied: true }] : [];
const paidOn = h => round2(paymentsOf(h).reduce((s, p) => s + num(p.amount), 0));
// What the client still owes on it: below zero when they've paid more than it now comes to (in credit).
const balanceOf = h => docType(h) !== 'invoice' ? 0 : round2(num(h.total) - creditedOn(h) - paidOn(h));
// What counts as owed: nothing on a paid invoice, or one saved before paid tracking began (1.12.0).
const owedOn = h => docType(h) !== 'invoice' || h.paidAt || !h.tracked ? 0 : Math.max(0, balanceOf(h));

// ---------- paid / unpaid / overdue ----------
// Invoices saved from 1.12.0 on are tracked; older ones show "–" (but can still be marked paid).
function payStatus(h) {
  if (docType(h) === 'quote') {
    const s = stepSummary(h);
    if (s.count && s.paidCount === s.count) return { key: 'paid', label: 'Paid in full' };
    if (s.paidCount) return { key: 'part', label: `${s.paidCount} of ${s.count} paid` };
    return h.convertedTo ? { key: 'quote', label: `Invoiced (${h.convertedTo})` } : { key: 'quote', label: 'Quote' };
  }
  if (isCredit(h)) return { key: 'credit', label: `Credit for ${h.inv.creditFor || 'an invoice'}` };
  if (h.paidAt) return { key: 'paid', label: `Paid ${shortDate(h.paidAt)}` };
  if (!h.tracked) return { key: 'untracked', label: '–' };
  const left = owedOn(h), some = paidOn(h) > 0 || creditedOn(h) > 0, cur = h.c.currency;
  if (left <= 0.004) return { key: 'credited', label: paidOn(h) > 0 ? 'Settled' : 'Credited' }; // credit notes (and payments) cover it
  if (h.inv.due && h.inv.due < todayIso()) return { key: 'overdue', label: some ? `Overdue · ${money(left, cur)} left` : 'Overdue' };
  return some ? { key: 'part', label: `${money(left, cur)} left` } : { key: 'unpaid', label: 'Unpaid' };
}
const overdueList = () => invoices.filter(h => payStatus(h).key === 'overdue');
function renderOverdue() {
  // At most three bars: with many overdue (e.g. after importing old invoices), the rest are summed in one.
  const list = overdueList(), shown = list.length > 3 ? list.slice(0, 2) : list, rest = list.slice(shown.length);
  const sums = {}; for (const h of rest) { const c = curCode(h.c.currency); sums[c] = round2((sums[c] || 0) + owedOn(h)); }
  // A client with more than one invoice overdue gets a statement suggested (see statements.js).
  const many = new Set(list.filter((h, i) => list.findIndex(x => x.c.id === h.c.id) !== i).map(h => h.c.id));
  const stmt = h => client(h.c.id) ? `<button class="btn" data-statement="${esc(h.c.id)}" title="A statement of everything ${esc(h.c.company)} owes, to send with a reminder">Statement</button>` : '';
  $('#overdue-bars').innerHTML = shown.map(h =>
    `<div class="update-bar remind overdue"><span><b>${esc(h.inv.number)}</b> for ${esc(h.c.company)} (${esc(money(owedOn(h), h.c.currency))}${paidOn(h) || creditedOn(h) ? ' still owed' : ''}${esc(homeNote(owedOn(h), invCur(h), false).replace(/^ \((.*)\)$/, ', $1 today'))}) was due on ${esc(shortDate(h.inv.due))}.${many.has(h.c.id) ? ` ${esc(h.c.company)} has other invoices overdue too.` : ''}</span>
     ${can('markPaid') ? `<button class="btn primary" data-pay="${esc(h.id)}">Mark paid</button>` : ''}
     ${stmt(h)}<button class="btn" data-go-hist="1">History</button></div>`).join('')
    + (rest.length ? `<div class="update-bar remind overdue"><span><b>${rest.length} more invoices are overdue</b> (${esc(Object.entries(sums).map(([c, v]) => money(v, c) + homeNote(v, c, false)).join(' + '))}).</span>
     <button class="btn" data-go-hist="1">See them in History</button></div>` : '');
}
// Paid in full (records what was still owed as a payment today), or back to unpaid (removes that payment).
function setPaid(id, paid) {
  const h = invoices.find(x => x.id === id); if (!h) return;
  if (paid) {
    const left = balanceOf(h);
    h.payments = [...(Array.isArray(h.payments) ? h.payments : []), ...(left > 0.004 ? [{ amount: left, on: todayIso(), full: true }] : [])];
    h.paidAt = todayIso();
  } else {
    h.paidAt = null;
    if (h.payments) { h.payments = h.payments.filter(p => !p.full); if (!h.payments.length) delete h.payments; }
    delete h.fx; // its rates were for that payment
  }
  if (docType(h) === 'invoice') h.tracked = true; // you've said whether it's paid, so it counts as owed when it isn't
  persist('invoices'); renderHistory(); renderOverdue();
  if (paid) captureFx(h); // every bank's rate today, for its rand value in Reports (in the background)
  toast(paid ? `${h.inv.number} marked as paid` : `${h.inv.number} marked as unpaid`);
}
// A part payment. Once the payments cover what's owed, the invoice is paid (on the last payment's date).
// Returns false (and says why) when the amount or date won't do.
function addPayment(id, amount, on, note = '') {
  const h = invoices.find(x => x.id === id); if (!h || docType(h) !== 'invoice') return false;
  amount = round2(num(amount));
  if (!(amount > 0)) { toast('Type the amount that was paid.'); return false; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on || '')) { toast('Choose the date it was paid.'); return false; }
  const left = balanceOf(h), cur = h.c.currency;
  if (amount > left + 0.004 && !confirm(`${money(amount, cur)} is more than the ${money(Math.max(0, left), cur)} still owed on ${h.inv.number}. Record it anyway? ${h.c.company} will be in credit.`)) return false;
  h.payments = [...(h.payments || []), { amount, on, ...(note.trim() ? { note: note.trim() } : {}) }];
  h.tracked = true;
  const done = balanceOf(h) <= 0.004;
  if (done && !h.paidAt) h.paidAt = h.payments.map(p => p.on).sort().pop();
  persist('invoices'); renderHistory(); renderOverdue();
  captureFx(h); // every bank's rate on this payment's day, for its rand value in Reports
  toast(done ? `${h.inv.number} is paid in full` : `${money(amount, cur)} paid on ${h.inv.number}, ${money(balanceOf(h), cur)} still owed`);
  return true;
}
function removePayment(id, i) {
  const h = invoices.find(x => x.id === id); if (!h || !h.payments || !h.payments[i]) return;
  h.payments = h.payments.filter((_, k) => k !== i);
  if (h.paidAt && balanceOf(h) > 0.004) { h.paidAt = null; delete h.fx; } // not paid in full any more
  if (!h.payments.length && !h.paidAt) delete h.payments;
  persist('invoices'); renderHistory(); renderOverdue();
}
// The payments and credit notes on an invoice, with a form to add a payment (History, under its row).
function paymentsRow(h) {
  const cur = h.c.currency, edit = can('markPaid'), pays = paymentsOf(h), credits = creditsFor(h);
  const rows = pays.map((p, i) => `<div class="step pay"><span>${p.implied ? '✓' : '💳'}</span>
      <span class="step-desc">${p.implied ? 'Paid in full' : p.full ? 'Paid the rest' : 'Payment'}${p.note ? ` <span class="muted">${esc(p.note)}</span>` : ''}</span>
      <span class="num">${esc(money(p.amount, cur))}</span>
      <span class="muted step-date">${esc(shortDate(p.on))} ${esc(String(p.on).slice(0, 4))}${edit && !p.implied ? ` <button class="link warn" data-act="pay-del" data-i="${i}" data-id="${esc(h.id)}" title="Remove this payment">×</button>` : ''}</span></div>`)
    .concat(credits.map(x => `<div class="step pay"><span>↩</span><span class="step-desc">Credit note ${esc(x.inv.number)}${x.inv.reason ? ` <span class="muted">${esc(x.inv.reason)}</span>` : ''}</span>
      <span class="num">−${esc(money(x.total, cur))}</span><span class="muted step-date">${esc(shortDate(x.inv.date))} ${esc(String(x.inv.date).slice(0, 4))}</span></div>`)).join('');
  const bal = balanceOf(h);
  const form = edit && !h.paidAt && h.tracked !== false ? `<div class="pay-form" data-id="${esc(h.id)}">
      <input type="number" step="0.01" min="0" class="pay-amt" placeholder="Amount" value="${bal > 0 ? bal.toFixed(2) : ''}" aria-label="Amount paid">
      <input type="date" class="pay-on" value="${todayIso()}" aria-label="Date paid">
      <input type="text" class="pay-note" placeholder="Note (optional), e.g. EFT ref" aria-label="Note">
      <button class="btn primary" data-act="pay-add" data-id="${esc(h.id)}">Add payment</button></div>` : '';
  return `<tr class="steps-row"><td colspan="7"><div class="steps">
    ${rows || '<p class="muted">No payments yet.</p>'}
    <div class="steps-sum"><span>Invoiced <b>${esc(money(h.total, cur))}</b>${credits.length ? ` · Credited <b>${esc(money(creditedOn(h), cur))}</b>` : ''} · Paid <b>${esc(money(paidOn(h), cur))}</b> · ${bal < -0.004 ? `In credit <b>${esc(money(-bal, cur))}</b>` : `Still owed <b>${esc(money(h.paidAt ? 0 : Math.max(0, bal), cur))}</b>`}</span></div>
    ${form}
  </div></td></tr>`;
}
$('#overdue-bars').onclick = e => {
  if (e.target.dataset.pay) setPaid(e.target.dataset.pay, true);
  else if (e.target.dataset.statement) openStatement(e.target.dataset.statement);
  else if (e.target.dataset.goHist) go('history');
};

// History: one row per invoice or quote. Clicking a row previews it on the right and shows what you
// can do with it in the bar above the list.
function renderHistory() {
  $('#hist-empty').style.display = invoices.length ? 'none' : '';
  if (histPick && !invoices.some(h => h.id === histPick)) histPick = null;
  const make = can('createInvoices'); // an accountant only opens and saves the PDFs
  const backupCell = h => h.backup
    ? `<button class="link ok" data-act="drive" data-id="${esc(h.id)}" title="Backed up to ${esc(h.backup)}. Click to show it.">✓</button>`
    : h.backupError !== undefined
      ? `<button class="link warn" data-act="backup" data-id="${esc(h.id)}" title="Not backed up: ${esc(h.backupError)}. Click to retry.">⚠ Retry</button>`
      : '<span class="muted" title="Not backed up">–</span>';
  const statusCell = h => {
    const st = payStatus(h), type = docType(h);
    const toggle = (title, word = 'Payments') => `<button class="link" data-act="steps" data-id="${esc(h.id)}" title="${title}">${openSteps.has(h.id) ? `Hide ${word.toLowerCase()}` : word}</button>`;
    const btn = type === 'quote' ? toggle("Tick off each line of this quote as it's paid")
      : type === 'credit' ? ''
      : [!can('markPaid') || st.key === 'credited' ? ''
          : h.paidAt ? `<button class="link" data-act="unpaid" data-id="${esc(h.id)}">Undo</button>`
            : `<button class="link" data-act="paid" data-id="${esc(h.id)}">Mark paid</button>`,
         h.tracked || h.paidAt ? toggle('Part payments and credit notes on this invoice, and add a payment') : ''].filter(Boolean).join(' ');
    return `<span class="status ${st.key}">${esc(st.label)}</span> ${btn}`;
  };
  $('#hist-empty').textContent = teamState.team && !can('seeAllInvoices') ? "You haven't saved any invoices yet. As a team member, you see only the invoices and quotes you make." : 'No invoices saved yet.';
  $('#hist').innerHTML = invoices.map(h =>
    `<tr data-pick="${esc(h.id)}" tabindex="0" class="${h.id === histPick ? 'on' : ''}"><td>${esc(h.inv.number)}${h.savedBy ? `<div class="muted" title="Saved by ${esc(h.savedBy)}">by ${esc(h.savedBy.split('@')[0])}</div>` : ''}${h.private ? '<div class="muted" title="Personal: not shared with a team">🔒 Personal</div>' : ''}</td>
     <td>${esc(h.c.company)}${h.imported ? `<div class="muted" title="Imported from ${esc(h.imported.from)}">Imported</div>` : ''}</td><td>${esc(h.inv.date)}</td>
     <td class="num">${isCredit(h) ? '−' : ''}${esc(money(h.total, h.c.currency))}${isOwedStatus(h) ? homeNote(owedOn(h), invCur(h)) : ''}</td>
     <td>${statusCell(h)}</td><td class="num">${backupCell(h)}</td></tr>`
     + (!openSteps.has(h.id) ? '' : docType(h) === 'quote' ? stepsRow(h) : docType(h) === 'invoice' ? paymentsRow(h) : '')).join('');
  // What you can do with the one you picked.
  const h = invoices.find(x => x.id === histPick), bar = $('#hist-sel');
  bar.hidden = !h;
  if (!h) return;
  const what = { quote: 'quote', credit: 'credit note' }[docType(h)] || 'invoice', desk = !!window.api, oldPdf = !!(h.imported && h.imported.pdf);
  // A credit note cancels or reduces an invoice: an admin's job, like billing (and only while it still has something to credit).
  const creditable = what === 'invoice' && can('editBilling') && round2(num(h.total) - creditedOn(h)) > 0.004;
  bar.innerHTML = `<div class="hist-sel-what"><b>${esc(h.inv.number)}</b> · ${esc(h.c.company)} · ${what === 'credit note' ? `credit of ${esc(money(h.total, h.c.currency))} on ${esc(h.inv.creditFor || '')}` : esc(money(h.total, h.c.currency))}
      <span class="muted">${h.file ? esc(h.file.split(/[\\/]/).pop()) : desk ? 'Saved on another computer' : ''}</span></div>
    <div class="hist-sel-acts">
    ${h.file && desk ? `<button class="btn" data-act="open" data-id="${esc(h.id)}">Open</button><button class="btn" data-act="folder" data-id="${esc(h.id)}" title="Show the PDF in its folder">Show in folder</button>` : ''}
    ${oldPdf ? '' : h.file || !desk ? (make ? `<button class="btn" data-act="pdf" data-id="${esc(h.id)}" title="Save this again (e.g. after editing your details)">Re-save</button>` : '')
      : `<button class="btn" data-act="pdf" data-id="${esc(h.id)}" title="Saved on another computer. Make the PDF on this one too.">Save PDF here</button>`}
    ${make ? `${oldPdf ? '' : `<button class="btn" data-act="edit" data-id="${esc(h.id)}" title="Change this ${what} and save it again under the same number">Edit</button>`}
      ${what === 'credit note' ? '' : `<button class="btn" data-act="copy" data-id="${esc(h.id)}" title="Start a new invoice with these lines">Copy</button>`}
      ${what === 'quote' ? `<button class="btn" data-act="convert" data-id="${esc(h.id)}" title="Start an invoice from this quote">Make invoice</button>` : ''}
      ${creditable ? `<button class="btn" data-act="credit" data-id="${esc(h.id)}" title="Cancel this invoice, or take part of it off, with a credit note">Credit note</button>` : ''}
      <button class="btn" data-act="private" data-id="${esc(h.id)}" title="${h.private ? 'Share this with your team' : 'Keep this off your team'}">${h.private ? 'Share' : 'Make personal'}</button>
      <button class="btn danger" data-act="del" data-id="${esc(h.id)}" title="Remove from history">Remove</button>` : ''}
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
  } else if (act === 'pay-add') {
    const f = e.target.closest('.pay-form');
    addPayment(id, f.querySelector('.pay-amt').value, f.querySelector('.pay-on').value, f.querySelector('.pay-note').value);
  } else if (act === 'pay-del') {
    const p = h.payments[Number(e.target.dataset.i)];
    if (p && confirm(`Remove the ${money(p.amount, h.c.currency)} payment of ${shortDate(p.on)} from ${h.inv.number}?`)) removePayment(id, Number(e.target.dataset.i));
  } else if (act === 'credit') {
    startCredit(h);
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
  } else if (act === 'del' && confirm(`Remove ${h.inv.number} from history${teamState.team && !h.private ? ` for everyone in ${teamState.team.name}` : ''}? (PDF files are not deleted.)${isCredit(h) ? `\n\n${h.inv.creditFor} goes back to owing what it did before this credit note.` : creditsFor(h).length ? `\n\nIts credit notes (${creditsFor(h).map(x => x.inv.number).join(', ')}) stay in History.` : ''}`)) {
    invoices = invoices.filter(x => x.id !== id); persist('invoices'); renderHistory(); refreshPreview(0);
    const back = settleStock(h.inv.number, []);
    if (back) toast(`${h.inv.number} removed. Its stock (${back}) is back on hand.`);
  }
}
