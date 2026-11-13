// Sign-in with Google (through Supabase) and cloud sync of Invaro's data.
//
// Each data file (clients, settings, invoices) is one row in the Supabase table public.documents,
// owned by the signed-in user; row level security keeps everyone's rows private (see SQL in the
// README). Your logo and bank logo travel inside the settings row.
//
// Sign-in uses the OAuth "PKCE" flow for desktop apps: the browser opens Supabase's Google sign-in,
// which hands a one-time code back to a tiny web server Invaro runs on 127.0.0.1:47823 for a
// few minutes. The session is stored encrypted by the operating system (safeStorage).
//
// Sync rules: local files are always the working copy. Every save marks that file as changed and
// uploads it a few seconds later. Every few minutes (and when the window gets focus) Invaro
// checks for newer copies from your other computers and downloads them. If both sides changed
// the same file, this computer's copy wins and the cloud copy is kept in <data>/conflicts.
const { app, shell, safeStorage, dialog } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NAMES = ['clients', 'settings', 'invoices'];
const PORT = 47823, REDIRECT = `http://127.0.0.1:${PORT}/auth/callback`;
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// paused(): true while you're in a team (team.js), which then syncs your data instead.
// onSignedIn(): runs after sign-in; returning true (you're in a team) skips the personal first sync.
function createCloud({ config, dataDir, readLocal, writeLocal, onRemoteChange, onStatus, parentWindow, paused = () => false, onSignedIn = async () => false, onSignedOut = () => {} }) {
  // Test overrides only work when running from source, never in an installed Invaro.
  const env = app.isPackaged ? {} : process.env;
  const url = env.INVOICER_CLOUD_URL || config.url;
  const key = env.INVOICER_CLOUD_KEY || config.key;
  const statePath = () => path.join(app.getPath('userData'), 'cloud.json');
  let state = load();
  let busy = null, error = '', pushTimer = null;

  // ---------- saved state (session encrypted with the OS keychain / DPAPI) ----------
  function load() {
    try {
      const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      if (s.session) s.session = JSON.parse(safeStorage.decryptString(Buffer.from(s.session, 'base64')));
      return { files: {}, ...s };
    } catch (e) { return { files: {} }; }
  }
  function save() {
    const out = { ...state, session: state.session ? safeStorage.encryptString(JSON.stringify(state.session)).toString('base64') : null };
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(out, null, 2));
  }
  const signedIn = () => !!(state.session && state.session.refresh_token);
  function status() {
    return {
      configured: !!(url && key), signedIn: signedIn(), email: state.session?.user?.email || '',
      lastSync: state.lastSync || null, busy, error,
      pending: NAMES.filter(n => state.files[n]?.dirty).length,
    };
  }
  const report = () => onStatus(status());

  // ---------- HTTP ----------
  async function request(p, { method = 'GET', body, headers = {}, auth = true } = {}) {
    if (auth) await freshToken();
    const res = await fetch(url + p, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${auth ? state.session.access_token : key}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      const msg = (json && (json.msg || json.message || json.error_description || json.error)) || text || res.statusText;
      const err = new Error(`${msg} (${res.status})`); err.status = res.status; throw err;
    }
    return json;
  }
  async function freshToken() {
    if (!signedIn()) throw new Error('Not signed in');
    if (Date.now() / 1000 < (state.session.expires_at || 0) - 60) return;
    try {
      const s = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: state.session.refresh_token } });
      setSession(s);
    } catch (e) {
      if (e.status === 400 || e.status === 401) { state.session = null; save(); report(); throw new Error('Your sign-in has expired. Sign in again.'); }
      throw e;
    }
  }
  function setSession(s) {
    state.session = {
      access_token: s.access_token, refresh_token: s.refresh_token,
      expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
      user: { id: s.user?.id || state.session?.user?.id, email: s.user?.email || state.session?.user?.email },
    };
    save();
  }

  // ---------- sign in / out ----------
  // Starts the local callback server, opens the browser, and resolves with the one-time code.
  // The browser tab can be closed without finishing, so a wait can be cancelled (or replaced by
  // signing in again) and gives up by itself after 3 minutes.
  let abortWait = null, waitClosed = Promise.resolve();
  function cancelled() { const e = new Error('Sign-in was cancelled.'); e.cancelled = true; return e; }
  function cancelSignIn() { if (abortWait) abortWait(cancelled()); return waitClosed; }
  function waitForCode(authorizeUrl) {
    return new Promise((resolve, reject) => {
      let done = false, closed;
      waitClosed = new Promise(r => { closed = r; });
      const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#333"><div style="text-align:center"><h2>${title}</h2><p>${text}</p></div>`;
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, REDIRECT);
        if (u.pathname !== '/auth/callback') { res.writeHead(404); return res.end(); }
        const code = u.searchParams.get('code'), err = u.searchParams.get('error_description') || u.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(code ? page('You\'re signed in', 'You can close this tab and go back to Invaro.') : page('Sign-in didn\'t finish', err || 'Go back to Invaro and try again.'));
        finish(code ? null : new Error(err || 'Sign-in was cancelled'), code);
      });
      const timer = setTimeout(() => finish(new Error('Sign-in timed out. Try again.')), 3 * 60 * 1000);
      function finish(err, code) {
        if (done) return; done = true; abortWait = null; clearTimeout(timer);
        server.close(() => closed()); server.closeAllConnections(); // free the port straight away
        err ? reject(err) : resolve(code);
      }
      abortWait = finish;
      server.on('error', e => finish(new Error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use by another program, so sign-in can't finish.` : e.message)));
      server.listen(PORT, '127.0.0.1', () => {
        if (env.INVOICER_AUTH_TEST) fetch(authorizeUrl).catch(() => {}); // tests: follow the redirects without a browser
        else shell.openExternal(authorizeUrl);
      });
    });
  }
  async function signIn() {
    if (!url || !key) throw new Error('Cloud sync is not set up in this version.');
    await cancelSignIn(); // clicking Sign in again starts over
    busy = 'signing-in'; error = ''; report();
    try {
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const authorizeUrl = `${url}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=s256`;
      const code = await waitForCode(authorizeUrl);
      const s = await request('/auth/v1/token?grant_type=pkce', { method: 'POST', auth: false, body: { auth_code: code, code_verifier: verifier } });
      const switched = state.userId && state.userId !== s.user?.id;
      setSession(s);
      if (switched) state.files = {};
      state.userId = state.session.user.id; save();
      busy = null; report();
      if (!(await onSignedIn())) await firstSync();
      return status();
    } catch (e) {
      if (e.cancelled) { if (busy === 'signing-in' && !abortWait) { busy = null; report(); } throw e; }
      busy = null; error = e.message; report(); throw e;
    }
  }
  async function signOut() {
    try { if (signedIn()) await request('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* signing out locally is what matters */ }
    state = { files: {} }; error = ''; save(); report();
    onSignedOut();
  }

  // ---------- logos ride along inside the settings row ----------
  const logoFile = name => name && path.join(dataDir(), path.basename(name));
  function withLogos(settings) {
    const logos = {};
    for (const name of [settings.logo, settings.bank?.logo]) {
      const f = logoFile(name);
      if (f && fs.existsSync(f) && fs.statSync(f).size < 3 * 1024 * 1024) logos[path.basename(name)] = fs.readFileSync(f).toString('base64');
    }
    return { ...settings, _cloudLogos: logos };
  }
  function takeLogos(settings) {
    const { _cloudLogos: logos, ...rest } = settings || {};
    for (const [name, b64] of Object.entries(logos || {})) {
      if (!/^(bank-)?logo\.[a-z]+$/i.test(name)) continue;
      const buf = Buffer.from(b64, 'base64'), f = logoFile(name);
      if (!fs.existsSync(f) || !fs.readFileSync(f).equals(buf)) {
        for (const old of fs.readdirSync(dataDir())) if (old.startsWith(name.split('.')[0] + '.') && old !== name && /^(bank-)?logo\.[a-z]+$/i.test(old)) fs.rmSync(path.join(dataDir(), old), { force: true });
        fs.writeFileSync(f, buf);
      }
    }
    return rest;
  }

  // ---------- sync ----------
  const fileState = n => (state.files[n] ||= {});
  async function upload(name) {
    let data = readLocal(name);
    if (name === 'settings') { const { draft, ...rest } = data; data = withLogos(rest); } // the half-typed draft stays on this computer
    const rows = await request('/rest/v1/documents?on_conflict=user_id,name', {
      method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: { name, data, updated_at: new Date().toISOString() },
    });
    Object.assign(fileState(name), { dirty: false, remoteAt: rows?.[0]?.updated_at || new Date().toISOString() });
  }
  async function download(name, keepDraft = true) {
    const rows = await request(`/rest/v1/documents?select=data,updated_at&name=eq.${name}`);
    if (!rows || !rows[0]) return false;
    let data = rows[0].data;
    if (name === 'settings') {
      data = takeLogos(data);
      if (keepDraft) { try { const local = readLocal('settings'); if (local.draft) data.draft = local.draft; } catch (e) {} }
    }
    writeLocal(name, data);
    Object.assign(fileState(name), { dirty: false, remoteAt: rows[0].updated_at });
    return true;
  }
  async function pull() {
    const rows = await request('/rest/v1/documents?select=name,updated_at') || [];
    let changed = false;
    for (const row of rows) {
      const fsx = fileState(row.name);
      if (row.updated_at === fsx.remoteAt) continue;
      if (fsx.dirty) {
        // Changed here and elsewhere: keep this computer's version, but save the other one.
        const other = await request(`/rest/v1/documents?select=data&name=eq.${row.name}`);
        const dir = path.join(dataDir(), 'conflicts'); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${row.name} from the cloud ${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify(other?.[0]?.data ?? null, null, 2));
        fsx.remoteAt = row.updated_at; // our upload replaces it
        continue;
      }
      if (await download(row.name)) changed = true;
    }
    return changed;
  }
  async function push() {
    for (const n of NAMES) if (fileState(n).dirty) await upload(n);
  }
  let again = false;
  async function sync(reason) {
    if (!signedIn() || paused()) return status();
    if (busy) { again = true; return status(); } // run once more when the current sync finishes
    busy = 'syncing'; report();
    try {
      const changed = await pull();
      await push();
      state.lastSync = new Date().toISOString(); error = '';
      save();
      if (changed) onRemoteChange();
    } catch (e) { error = e.message; save(); }
    busy = null; report();
    if (again) { again = false; return sync('queued'); }
    return status();
  }
  function markDirty(name) {
    if (!signedIn() || paused() || !NAMES.includes(name)) return;
    fileState(name).dirty = true; save(); report();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => sync('save'), 3000);
  }

  // First sync after signing in (or after switching data folders): decide which copy wins.
  async function firstSync() {
    busy = 'syncing'; report();
    try {
      const rows = await request('/rest/v1/documents?select=name,updated_at') || [];
      const localInvoices = (() => { try { return readLocal('invoices'); } catch (e) { return []; } })();
      const localClients = (() => { try { return readLocal('clients'); } catch (e) { return []; } })();
      const localIsEmpty = !localInvoices.length && localClients.every(c => c.id === 'example-client');
      let choice = rows.length ? (localIsEmpty ? 'cloud' : null) : 'upload';
      if (!choice) {
        const { response } = await dialog.showMessageBox(parentWindow(), {
          type: 'question', buttons: ['Use my cloud data', "Replace the cloud with this computer's data"], defaultId: 0, cancelId: 0,
          message: 'Your account already has Invaro data.',
          detail: "Use my cloud data: this computer switches to the clients and invoices saved in your account (this computer's current files are backed up in the data folder first).\n\nReplace the cloud: this computer's clients and invoices are uploaded and replace what's in your account.",
        });
        choice = response === 0 ? 'cloud' : 'upload';
      }
      if (choice === 'cloud') {
        const backup = path.join(dataDir(), 'backups', `before sign-in ${new Date().toISOString().replace(/[:.]/g, '-')}`);
        fs.mkdirSync(backup, { recursive: true });
        for (const n of NAMES) { const f = path.join(dataDir(), `${n}.json`); if (fs.existsSync(f)) fs.copyFileSync(f, path.join(backup, `${n}.json`)); }
        for (const n of NAMES) await download(n, false);
      } else {
        for (const n of NAMES) await upload(n);
      }
      state.lastSync = new Date().toISOString(); error = ''; save();
      busy = null; report();
      if (choice === 'cloud') onRemoteChange();
    } catch (e) { busy = null; error = e.message; save(); report(); throw e; }
  }

  // Deletes everything in your account: the account itself when the delete_own_account function
  // exists in the database (see README), otherwise just your data rows. Then signs out.
  async function deleteCloudData() {
    if (!signedIn()) return status();
    try { await request('/rest/v1/rpc/delete_own_account', { method: 'POST', body: {} }); }
    catch (e) {
      if (e.status !== 404) throw e;
      await request(`/rest/v1/documents?user_id=eq.${state.session.user.id}`, { method: 'DELETE' });
    }
    await signOut();
    return status();
  }

  // Background syncing: every 5 minutes, and soon after the window gets focus.
  let lastFocusSync = 0;
  setInterval(() => sync('timer'), 5 * 60 * 1000);
  // After leaving a team: this computer's copy becomes your personal data again.
  function resumePersonal() {
    for (const n of NAMES) fileState(n).dirty = true;
    save(); sync('resume');
  }
  return {
    status, signIn, cancelSignIn, signOut, sync, markDirty, firstSync, deleteCloudData, resumePersonal,
    request, signedIn, userId: () => state.session?.user?.id || null, withLogos, takeLogos,
    onFocus() { if (Date.now() - lastFocusSync > 60 * 1000) { lastFocusSync = Date.now(); sync('focus'); } },
  };
}

module.exports = { createCloud };
