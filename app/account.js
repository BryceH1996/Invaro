// My details → Account & sync: signing in, cloud sync, and teams (who's in the team, roles, invitations,
// and merging your team's changes into what's on screen). The syncing itself runs in the main process:
// cloud.js and team.js. can() here says what your role allows, everywhere in the app.
// Loaded after renderer.js, whose helpers ($, esc, persist, clients, invoices, settings, flushSaves, go…) it uses.

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
  $('#hist-tools').hidden = !can('createInvoices') || (!!teamState.team && !can('editBilling'));
  $('#cl-import').hidden = !can('addClients');
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
