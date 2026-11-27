// The Clients tab: each client's details, rates and default lines, personal clients, and starting an invoice for one.
// Loaded after renderer.js, whose helpers ($, esc, money, persist, clients, draft, client, newDraft, reminderLabel…) it uses.

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
  // Statements show money owed, so they're for whoever sees the figures (not a team member).
  $('#cl-statement').hidden = !can('reports');
  if (can('reports')) renderStatementBox(c);
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
