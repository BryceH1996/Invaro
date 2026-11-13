// Teams: two or more people working on the same business (supabase/teams.sql, SYNC.md).
//
// While you're in a team, your clients, invoices and business details are shared record by
// record in the Supabase table public.records, instead of your personal whole-file sync (cloud.js).
// The local JSON files stay the working copy:
//   - after every save, Invaro works out which records changed (by hash) and uploads just those
//   - every 10 seconds (60 when the window isn't focused) it downloads what changed since last time
//   - if you and someone else changed the same record, the later change wins and the other version
//     is kept in <data folder>/conflicts
// A few things stay on each computer and are never shared: the half-typed draft, backup settings,
// page size and zoom, and where each invoice's PDF is saved and backed up.
//
// Personal clients and invoices ("private": true) are never shared either. A personal client isn't
// uploaded at all (making a shared client personal removes it from the team). A personal invoice
// only reserves its number, as { private: true }, so nobody else in the team uses the same number.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE_OF = { client: 'clients', invoice: 'invoices', business: 'settings' };
const LOCAL_SETTINGS = ['draft', 'backupProvider', 'backupDir', 'backupFolder', 'backupSharedDrive', 'pageSize', 'previewZoom'];
const LOCAL_INVOICE = ['file', 'backup', 'backupError', 'backedUpAt', 'savedBy'];
const omit = (o, keys) => { const r = { ...o }; for (const k of keys) delete r[k]; return r; };
// Postgres stores jsonb with its own key order, so hashes use sorted keys.
const canon = v => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}`
  : JSON.stringify(v ?? null);
const hash = v => crypto.createHash('sha1').update(canon(v)).digest('hex');
const DELETED = 'deleted';
const COUNTERS = ['nextNumber', 'nextQuoteNumber'];
const RESERVED = { private: true }; // a personal invoice's record: just the number, no details
const isPrivate = x => !!(x && x.private);
const isReserved = data => !!(data && data.private);
const RESERVED_HASH = hash(RESERVED);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function createTeam({ cloud, dataDir, readLocal, writeLocal, onRemoteChange, onStatus, focused }) {
  const statePath = () => path.join(app.getPath('userData'), 'team.json');
  let state = load(), busy = null, error = '', notice = '', again = false, pushTimer = null;
  let members = [], invites = [], myInvites = [], lastSync = null, lastFull = 0, lastRefresh = 0;

  function load() { try { return { synced: {}, versions: {}, dirtyAt: {}, ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) }; } catch (e) { return { synced: {}, versions: {}, dirtyAt: {} }; } }
  function save() { fs.mkdirSync(path.dirname(statePath()), { recursive: true }); fs.writeFileSync(statePath(), JSON.stringify(state)); }
  function reset(extra = {}) { state = { synced: {}, versions: {}, dirtyAt: {}, ...extra }; members = []; invites = []; save(); }
  const active = () => !!(state.team && cloud.signedIn());
  const me = () => ({ id: cloud.userId(), email: (cloud.status().email || '').toLowerCase() });
  const status = () => ({
    configured: cloud.status().configured, signedIn: cloud.signedIn(), team: active() ? state.team : null,
    members, invites, myInvites, busy, error, notice, lastSync, me: me().email,
  });
  const report = () => onStatus(status());
  const request = (p, opts) => cloud.request(p, opts);
  const enc = encodeURIComponent;

  // ---------- local data as records ----------
  const read = name => { try { return readLocal(name); } catch (e) { return name === 'settings' ? {} : []; } };
  const invoiceData = h => isPrivate(h) ? RESERVED : omit(h, LOCAL_INVOICE);
  function localRecords() {
    const out = new Map();
    for (const c of read('clients')) if (c && c.id && !isPrivate(c)) out.set(`client:${c.id}`, { kind: 'client', id: String(c.id), data: c });
    for (const h of read('invoices')) if (h && h.inv && h.inv.number) out.set(`invoice:${h.inv.number}`, { kind: 'invoice', id: String(h.inv.number), data: invoiceData(h) });
    out.set('business:business', { kind: 'business', id: 'business', data: cloud.withLogos(omit(read('settings'), LOCAL_SETTINGS)) });
    return out;
  }
  // Keys of this computer's personal clients and invoices.
  const personalKeys = () => new Set([
    ...read('clients').filter(isPrivate).map(c => `client:${c.id}`),
    ...read('invoices').filter(h => isPrivate(h) && h.inv).map(h => `invoice:${h.inv.number}`),
  ]);
  // Writes remote rows into the local files (one write per file). rows: [{ kind, id, data, deleted, by }]
  function applyRows(rows) {
    const kinds = new Set(rows.map(r => r.kind));
    if (kinds.has('client')) {
      let list = read('clients');
      for (const r of rows.filter(x => x.kind === 'client')) {
        const i = list.findIndex(c => String(c.id) === r.id);
        if (i >= 0 && isPrivate(list[i])) continue; // personal here: the team's copy doesn't replace it
        if (r.deleted) { if (i >= 0) list.splice(i, 1); } else if (i >= 0) list[i] = r.data; else list.push(r.data);
      }
      writeLocal('clients', list);
    }
    if (kinds.has('invoice')) {
      let list = read('invoices');
      for (const r of rows.filter(x => x.kind === 'invoice')) {
        const i = list.findIndex(h => h.inv && String(h.inv.number) === r.id);
        if (i >= 0 && isPrivate(list[i])) continue; // personal here: the team's copy doesn't replace it
        // Deleted, or made personal by whoever saved it: it leaves everyone else's history.
        if (r.deleted || isReserved(r.data)) { if (i >= 0) list.splice(i, 1); continue; }
        const keep = i >= 0 ? Object.fromEntries(LOCAL_INVOICE.filter(k => k in list[i]).map(k => [k, list[i][k]])) : {};
        if (r.by && r.by !== me().email) keep.savedBy = r.by; else delete keep.savedBy;
        const entry = { ...r.data, ...keep };
        if (i >= 0) list[i] = entry; else list.push(entry);
      }
      list.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || ''))); // newest first, as in History
      writeLocal('invoices', list);
    }
    if (kinds.has('business')) {
      const r = rows.filter(x => x.kind === 'business').pop();
      if (!r.deleted) {
        const local = read('settings');
        const kept = Object.fromEntries(LOCAL_SETTINGS.filter(k => k in local).map(k => [k, local[k]]));
        writeLocal('settings', { ...cloud.takeLogos(r.data), ...kept });
      }
    }
    return [...kinds].map(k => FILE_OF[k]);
  }
  function keepConflict(key, data) {
    const dir = path.join(dataDir(), 'conflicts'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key.replace(/[^\w.-]+/g, ' ').trim()} ${stamp()}.json`), JSON.stringify(data ?? null, null, 2));
  }

  // ---------- sync ----------
  const emailOf = id => (members.find(m => m.user_id === id) || {}).email || '';
  const COLS = 'kind,id,data,deleted,updated_at,updated_by,version';
  async function fetchSince(cursor) {
    const rows = [];
    for (;;) {
      const page = await request(`/rest/v1/records?select=${COLS}&team_id=eq.${state.team.id}&version=gt.${cursor}&order=version.asc&limit=500`) || [];
      rows.push(...page);
      if (page.length < 500) return rows;
      cursor = page[page.length - 1].version;
    }
  }
  async function pull() {
    // Every 5 minutes, also check for changes a quick "since" query could have missed
    // (two saves committing out of order).
    let cursor = state.cursor || 0;
    if (Date.now() - lastFull > 5 * 60 * 1000) {
      lastFull = Date.now();
      const all = await request(`/rest/v1/records?select=kind,id,version&team_id=eq.${state.team.id}&limit=100000`) || [];
      const missed = all.filter(r => (state.versions[`${r.kind}:${r.id}`] || 0) < r.version).map(r => r.version);
      if (missed.length) cursor = Math.min(cursor, Math.min(...missed) - 1);
    }
    const rows = await fetchSince(cursor);
    if (!rows.length) return [];
    const local = localRecords(), personal = personalKeys(), apply = [];
    for (const row of rows) {
      const key = `${row.kind}:${row.id}`;
      state.cursor = Math.max(state.cursor || 0, row.version);
      state.versions[key] = Math.max(state.versions[key] || 0, row.version);
      const remoteHash = row.deleted ? DELETED : hash(row.data);
      if (state.synced[key] === remoteHash) continue; // our own change coming back
      if (personal.has(key)) { state.synced[key] = remoteHash; continue; } // ours is personal: pushed (removed / reserved) next
      const mine = local.get(key), mineHash = mine ? hash(mine.data) : DELETED;
      const changedHere = mineHash !== (state.synced[key] || DELETED);
      if (changedHere && mineHash !== remoteHash && row.kind === 'business' && !row.deleted && mine) {
        // Both saved invoices, so both moved the "next number" counters on: not a real conflict.
        // Take theirs with the higher counters (anything left that's ours is uploaded next).
        const a = mine.data, b = row.data || {};
        const differ = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => canon(a[k]) !== canon(b[k]));
        if (differ.every(k => COUNTERS.includes(k))) {
          const merged = { ...b };
          for (const k of COUNTERS) if (a[k] !== undefined || b[k] !== undefined) merged[k] = Math.max(Number(a[k]) || 0, Number(b[k]) || 0);
          apply.push({ kind: row.kind, id: row.id, data: merged, deleted: false, by: emailOf(row.updated_by) });
          state.synced[key] = remoteHash;
          continue;
        }
      }
      if (changedHere && mineHash !== remoteHash) {
        // Both sides changed it: the later change wins, the other is kept in conflicts/.
        const remoteLater = Date.parse(row.updated_at) >= (state.dirtyAt[key] || 0);
        keepConflict(key, remoteLater ? (mine && mine.data) : row.data);
        if (!remoteLater) { state.synced[key] = remoteHash; continue; } // ours is pushed next
        const what = row.kind === 'invoice' ? row.id : row.kind === 'client' ? (row.data && row.data.company) || 'a client' : 'the business details';
        notice = `${emailOf(row.updated_by) || 'Someone else'} changed ${what} at the same time as you. Their later change was kept; yours is saved in the conflicts folder.`;
      }
      apply.push({ kind: row.kind, id: row.id, data: row.data, deleted: row.deleted, by: emailOf(row.updated_by) });
      state.synced[key] = remoteHash;
      delete state.dirtyAt[key];
    }
    save();
    return apply.length ? applyRows(apply) : [];
  }
  async function push() {
    const local = localRecords(), up = [];
    for (const [key, r] of local) {
      const h = hash(r.data);
      if (state.synced[key] !== h) up.push({ key, h, row: { team_id: state.team.id, kind: r.kind, id: r.id, data: r.data, deleted: false } });
    }
    for (const key of Object.keys(state.synced)) {
      // A reserved number (someone's personal invoice) stays reserved, even though it isn't in our list.
      if (local.has(key) || state.synced[key] === DELETED || state.synced[key] === RESERVED_HASH) continue;
      const [kind, ...rest] = key.split(':');
      if (kind === 'business') continue;
      up.push({ key, h: DELETED, row: { team_id: state.team.id, kind, id: rest.join(':'), data: null, deleted: true } });
    }
    for (let i = 0; i < up.length; i += 100) {
      const batch = up.slice(i, i + 100);
      const res = await request('/rest/v1/records?on_conflict=team_id,kind,id', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: batch.map(b => b.row),
      }) || [];
      for (const b of batch) { state.synced[b.key] = b.h; delete state.dirtyAt[b.key]; }
      for (const r of res) { const k = `${r.kind}:${r.id}`; state.versions[k] = Math.max(state.versions[k] || 0, r.version); }
      save();
    }
  }
  async function sync(reason) {
    if (!active()) return status();
    if (busy) { again = true; return status(); }
    busy = 'syncing'; report();
    let changed = [];
    try {
      // Who's in the team changes rarely: check it once a minute, and on demand.
      if (reason !== 'timer' || Date.now() - lastRefresh > 60 * 1000) { lastRefresh = Date.now(); await refresh(false); }
      if (active()) { changed = await pull(); await push(); }
      lastSync = new Date().toISOString(); error = '';
    } catch (e) { error = e.message; }
    busy = null; report();
    if (changed.length) onRemoteChange(changed);
    if (again) { again = false; return sync('queued'); }
    return status();
  }
  // A local save: note when each record changed (for "later change wins"), and upload soon.
  function markDirty(name) {
    if (!active() || !Object.values(FILE_OF).includes(name)) return false;
    const kind = Object.keys(FILE_OF).find(k => FILE_OF[k] === name);
    const now = Date.now();
    const local = localRecords();
    for (const [key, r] of local) if (r.kind === kind && state.synced[key] !== hash(r.data)) state.dirtyAt[key] ||= now;
    for (const key of Object.keys(state.synced)) if (key.startsWith(kind + ':') && !local.has(key) && state.synced[key] !== DELETED) state.dirtyAt[key] ||= now;
    save();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => sync('save'), 1000);
    return true;
  }

  // A brand-new invoice number is claimed straight away, insert-only, so two people can't both
  // save the same number. Returns { ok } or { taken, by }.
  async function claimInvoice(entry) {
    if (!active()) return { ok: true };
    const data = invoiceData(entry), id = String(entry.inv.number), key = `invoice:${id}`;
    const body = { team_id: state.team.id, kind: 'invoice', id, data, deleted: false };
    try {
      const [r] = await request('/rest/v1/records', { method: 'POST', headers: { Prefer: 'return=representation' }, body: [body] });
      state.synced[key] = hash(data); state.versions[key] = r ? r.version : state.versions[key]; save();
      return { ok: true };
    } catch (e) {
      if (e.status !== 409) throw e;
      const [row] = await request(`/rest/v1/records?select=deleted,updated_by&team_id=eq.${state.team.id}&kind=eq.invoice&id=eq.${enc(id)}`) || [];
      if (row && row.deleted) { // the number was used by an invoice that's since been deleted: reuse it
        await request('/rest/v1/records?on_conflict=team_id,kind,id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: [body] });
        state.synced[key] = hash(data); save();
        return { ok: true };
      }
      await sync('claim'); // fetch the invoice that took the number
      return { taken: true, by: row ? emailOf(row.updated_by) : '' };
    }
  }

  // ---------- membership ----------
  // Loads which team you're in, its people and invitations, and invitations for you.
  async function refresh(notify = true) {
    if (!cloud.signedIn()) { members = []; invites = []; myInvites = []; if (notify) report(); return status(); }
    const m = me();
    const mine = await request(`/rest/v1/team_members?select=team_id,role,teams(name)&user_id=eq.${m.id}`) || [];
    const row = mine[0];
    if (!row && state.team) { // removed by the owner, or the team was deleted: keep your copy and go back to personal sync
      notice = `You're no longer in "${state.team.name}". Your copy of its data is still on this computer.`;
      reset({ userId: m.id }); cloud.resumePersonal();
    } else if (row && (!state.team || state.team.id !== row.team_id)) {
      // In a team this computer didn't know about (e.g. signed in on another computer): switch to its data.
      await switchTo(row.team_id, (row.teams && row.teams.name) || 'your team', row.role, 'joining');
    } else if (row) {
      state.team = { ...state.team, name: (row.teams && row.teams.name) || state.team.name, role: row.role }; save();
    }
    if (state.team) {
      members = await request(`/rest/v1/team_members?select=user_id,email,role,joined_at&team_id=eq.${state.team.id}&order=joined_at.asc`) || [];
      invites = state.team.role === 'owner' ? await request(`/rest/v1/team_invites?select=id,email,created_at&team_id=eq.${state.team.id}&order=created_at.asc`) || [] : [];
      myInvites = [];
    } else {
      members = []; invites = [];
      myInvites = (await request(`/rest/v1/team_invites?select=id,team_id,inviter_email,teams(name)&email=eq.${enc(m.email)}`) || [])
        .map(i => ({ id: i.id, team: (i.teams && i.teams.name) || 'a team', from: i.inviter_email }));
    }
    if (notify) report();
    return status();
  }
  // Switches this computer to a team's data: backs up the local files, then downloads everything.
  async function switchTo(teamId, name, role, why) {
    const backup = path.join(dataDir(), 'backups', `before ${why} ${name.replace(/[\\/:*?"<>|]/g, '')} ${stamp()}`);
    fs.mkdirSync(backup, { recursive: true });
    for (const n of ['clients', 'settings', 'invoices']) { const f = path.join(dataDir(), `${n}.json`); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backup, `${n}.json`)); }
    reset({ userId: me().id, team: { id: teamId, name, role } });
    members = await request(`/rest/v1/team_members?select=user_id,email,role,joined_at&team_id=eq.${teamId}`) || [];
    const rows = await fetchSince(0);
    // Start from an empty copy (keeping this computer's own settings), then fill in the team's data.
    const settings = read('settings');
    const myClients = read('clients').filter(isPrivate), myInvoices = read('invoices').filter(isPrivate);
    writeLocal('clients', []);
    writeLocal('invoices', []);
    writeLocal('settings', Object.fromEntries(LOCAL_SETTINGS.filter(k => k in settings).map(k => [k, settings[k]])));
    const apply = rows.filter(r => !r.deleted && !isReserved(r.data)).map(r => ({ kind: r.kind, id: r.id, data: r.data, deleted: false, by: emailOf(r.updated_by) }));
    if (apply.length) applyRows(apply);
    // Your personal clients and invoices come along. A personal invoice whose number the team
    // already uses can't sit next to it (invoices are known by their number), so it stays in the backup.
    const taken = new Set(rows.filter(r => r.kind === 'invoice' && !r.deleted).map(r => r.id));
    const clash = myInvoices.filter(h => taken.has(String(h.inv.number)));
    if (myClients.length) writeLocal('clients', [...read('clients'), ...myClients.filter(c => !read('clients').some(x => x.id === c.id))]);
    if (myInvoices.length > clash.length) writeLocal('invoices', [...read('invoices'), ...myInvoices.filter(h => !clash.includes(h))]
      .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || ''))));
    if (clash.length) notice = `${clash.length === 1 ? 'Your personal invoice' : `${clash.length} of your personal invoices`} (${clash.map(h => h.inv.number).join(', ')}) use${clash.length === 1 ? 's a number' : ' numbers'} the team already has, so ${clash.length === 1 ? "it isn't" : "they aren't"} in your History here. You'll find ${clash.length === 1 ? 'it' : 'them'} in ${backup}.`;
    for (const r of rows) { const k = `${r.kind}:${r.id}`; state.synced[k] = r.deleted ? DELETED : hash(r.data); state.versions[k] = r.version; state.cursor = Math.max(state.cursor || 0, r.version); }
    // Recompute the business hash from what was written (logos are re-read from disk).
    const biz = localRecords().get('business:business');
    if (rows.some(r => r.kind === 'business')) state.synced['business:business'] = hash(biz.data);
    lastSync = new Date().toISOString();
    save();
    onRemoteChange(['clients', 'settings', 'invoices'], true);
  }

  async function create(name) {
    name = String(name || '').trim();
    if (!name) throw new Error('Give your team a name, like your company name.');
    const id = await request('/rest/v1/rpc/create_team', { method: 'POST', body: { team_name: name } });
    reset({ userId: me().id, team: { id, name, role: 'owner' } });
    await refresh(false);
    await push(); // your data becomes the team's
    lastSync = new Date().toISOString();
    report();
    return status();
  }
  async function invite(email) {
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter an email address, like partner@example.com.');
    if (members.some(m => m.email.toLowerCase() === email)) throw new Error(`${email} is already in the team.`);
    try {
      await request('/rest/v1/team_invites', { method: 'POST', body: { team_id: state.team.id, email, inviter_email: me().email } });
    } catch (e) { if (e.status !== 409) throw e; } // already invited: fine
    return refresh();
  }
  async function cancelInvite(id) { await request(`/rest/v1/team_invites?id=eq.${enc(id)}`, { method: 'DELETE' }); return refresh(); }
  async function removeMember(userId) { await request(`/rest/v1/team_members?team_id=eq.${state.team.id}&user_id=eq.${enc(userId)}`, { method: 'DELETE' }); return refresh(); }
  async function leave() {
    if (state.team.role === 'owner') throw new Error('You own this team. Delete the team instead, or remove everyone else first.');
    await request(`/rest/v1/team_members?team_id=eq.${state.team.id}&user_id=eq.${me().id}`, { method: 'DELETE' });
    reset({ userId: me().id }); notice = ''; cloud.resumePersonal();
    return refresh();
  }
  async function deleteTeam() {
    await request(`/rest/v1/teams?id=eq.${state.team.id}`, { method: 'DELETE' });
    reset({ userId: me().id }); notice = ''; cloud.resumePersonal();
    return refresh();
  }
  async function acceptInvite(id) {
    const inv = myInvites.find(i => i.id === id);
    const teamId = await request('/rest/v1/rpc/accept_invite', { method: 'POST', body: { invite_id: id } });
    await switchTo(teamId, inv ? inv.team : 'your team', 'member', 'joining');
    await refresh(false);
    report();
    return status();
  }
  // After switching data folders: fill the new folder with the team's data.
  async function reload() { if (active()) await switchTo(state.team.id, state.team.name, state.team.role, 'switching folders to'); return status(); }
  async function declineInvite(id) { await request(`/rest/v1/team_invites?id=eq.${enc(id)}`, { method: 'DELETE' }); return refresh(); }

  // After signing in: returns true when you're in a team (so the personal first sync is skipped).
  async function afterSignIn() {
    if (state.userId && state.userId !== me().id) reset();
    state.userId = me().id; save();
    await refresh(false);
    report();
    return !!state.team;
  }
  function signedOut() { reset(); myInvites = []; notice = ''; report(); }
  const clearNotice = () => { notice = ''; report(); };

  // Every 10 seconds while the window is focused, every 60 otherwise.
  let lastTick = 0;
  setInterval(() => {
    if (!active()) return;
    if (focused() || Date.now() - lastTick > 60 * 1000) { lastTick = Date.now(); sync('timer'); }
  }, 10 * 1000);

  return { active, status, refresh, sync, markDirty, claimInvoice, create, invite, cancelInvite, removeMember, leave, deleteTeam, acceptInvite, declineInvite, afterSignIn, signedOut, clearNotice, reload };
}

module.exports = { createTeam };
