// Backing up invoices straight to Google Drive online, for people without Google Drive for desktop.
//
// "Connect Google Drive" uses Google's OAuth flow for desktop apps: the browser opens Google's
// consent page, which hands a one-time code back to a tiny web server Invaro runs on a free
// 127.0.0.1 port for a few minutes (PKCE, so the code is useless to anyone else). Invaro keeps
// the refresh token encrypted by the operating system (safeStorage), like the cloud sign-in.
//
// It asks for the full "drive" scope, because writing into a shared drive Invaro didn't create
// needs it. The client ID and secret come from a "Desktop app" OAuth client in Google Cloud (see
// SYNC.md); Google treats a desktop client's secret as public, so it can ship inside the app.
//
// Uploads mirror the local layout: <My Drive or shared drive>/Invaro Backups/<Client>/<file>.
// Saving the same invoice again replaces the file instead of adding a second copy.
const { app, shell, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER = 'application/vnd.google-apps.folder';
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// Text inside a Drive search query: backslashes and single quotes need escaping.
const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function createGDrive({ config = {} }) {
  // The INVOICER_GDRIVE_* overrides are for testing against a stand-in server. They only work
  // when running from source, so nothing can point an installed Invaro at a fake "Google".
  const env = app.isPackaged ? {} : process.env;
  const clientId = env.INVOICER_GDRIVE_CLIENT_ID || config.clientId;
  const clientSecret = env.INVOICER_GDRIVE_CLIENT_SECRET || config.clientSecret;
  const AUTH = env.INVOICER_GDRIVE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN = env.INVOICER_GDRIVE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
  const REVOKE = env.INVOICER_GDRIVE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
  const API = env.INVOICER_GDRIVE_API || 'https://www.googleapis.com';
  const statePath = () => path.join(app.getPath('userData'), 'gdrive.json');
  let state = load(), error = '', connecting = false;
  const folderIds = new Map(); // "<drive>/<folder>/<sub>" -> id, for this run only

  // ---------- saved state (tokens encrypted with the OS keychain / DPAPI) ----------
  function load() {
    try {
      const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
      return s.tokens ? { ...s, tokens: JSON.parse(safeStorage.decryptString(Buffer.from(s.tokens, 'base64'))) } : s;
    } catch (e) { return {}; }
  }
  function save() {
    const out = { ...state, tokens: state.tokens ? safeStorage.encryptString(JSON.stringify(state.tokens)).toString('base64') : null };
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(out, null, 2));
  }
  const connected = () => !!(state.tokens && state.tokens.refresh_token);
  const status = () => ({ configured: !!(clientId && clientSecret), connected: connected(), email: state.email || '', connecting, error });

  // ---------- tokens ----------
  async function tokenRequest(params) {
    const res = await fetch(TOKEN, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(json.error_description || json.error || res.statusText); e.code = json.error; throw e; }
    return json;
  }
  async function accessToken() {
    if (!connected()) throw new Error('Google Drive is not connected');
    const t = state.tokens;
    if (t.access_token && Date.now() / 1000 < (t.expires_at || 0) - 60) return t.access_token;
    try {
      const r = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
      state.tokens = { ...t, access_token: r.access_token, expires_at: Math.floor(Date.now() / 1000) + (r.expires_in || 3600) };
      save();
      return r.access_token;
    } catch (e) {
      if (e.code === 'invalid_grant') { // revoked in the Google account, or the password changed
        state = {}; save(); folderIds.clear();
        throw new Error('Google Drive access was removed or has expired. Connect Google Drive again.');
      }
      throw e;
    }
  }

  // ---------- Drive API ----------
  async function api(p, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const res = await fetch(API + p, { method, body, headers: { Authorization: `Bearer ${await accessToken()}`, ...headers } });
    if (raw) return res;
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const e = new Error((json && json.error && json.error.message) || res.statusText); e.status = res.status; throw e;
    }
    return json;
  }
  const ALL = 'supportsAllDrives=true&includeItemsFromAllDrives=true';
  async function listSharedDrives() {
    const drives = [];
    let page = '';
    do {
      const r = await api(`/drive/v3/drives?pageSize=100&fields=nextPageToken,drives(id,name)${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      drives.push(...(r.drives || []));
      page = r.nextPageToken;
    } while (page);
    return drives.sort((a, b) => a.name.localeCompare(b.name));
  }
  // The Drive to use: My Drive ("root"), or the shared drive with this name.
  async function driveFor(shared) {
    if (!shared) return { driveId: null, rootId: 'root' };
    const d = (await listSharedDrives()).find(x => x.name === shared);
    if (!d) throw new Error(`Can't find the "${shared}" shared drive. Check you still have access to it.`);
    return { driveId: d.id, rootId: d.id };
  }
  async function findChild(parentId, name, driveId, folder) {
    const query = `name='${q(name)}' and '${q(parentId)}' in parents and trashed=false` + (folder ? ` and mimeType='${FOLDER}'` : ` and mimeType!='${FOLDER}'`);
    const scope = driveId ? `&corpora=drive&driveId=${encodeURIComponent(driveId)}` : '';
    const r = await api(`/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,webViewLink)&${ALL}${scope}`);
    return (r.files || [])[0] || null;
  }
  // Finds (and with create, makes) the folder path under the drive's root. Returns its id or null.
  async function folderPath(names, shared, create) {
    const { driveId, rootId } = await driveFor(shared);
    let parent = rootId, key = driveId || 'root';
    for (const name of names) {
      key += '/' + name;
      let id = folderIds.get(key);
      if (!id) {
        const found = await findChild(parent, name, driveId, true);
        if (found) id = found.id;
        else if (!create) return null;
        else id = (await api(`/drive/v3/files?${ALL}&fields=id`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
        })).id;
        folderIds.set(key, id);
      }
      parent = id;
    }
    return { id: parent, driveId };
  }
  async function upload({ bytes, name, folders, shared }) {
    const attempt = async () => {
      const folder = await folderPath(folders, shared, true);
      const pdf = Buffer.from(bytes);
      const existing = await findChild(folder.id, name, folder.driveId, false);
      if (existing) { // re-saved invoice: replace its contents
        return api(`/upload/drive/v3/files/${existing.id}?uploadType=media&${ALL}&fields=id,webViewLink`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/pdf' }, body: pdf,
        });
      }
      const boundary = 'invaro' + crypto.randomBytes(12).toString('hex');
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder.id], mimeType: 'application/pdf' })}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
        pdf, Buffer.from(`\r\n--${boundary}--`),
      ]);
      return api(`/upload/drive/v3/files?uploadType=multipart&${ALL}&fields=id,webViewLink`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      });
    };
    let file;
    try { file = await attempt(); }
    catch (e) {
      if (e.status !== 404) throw e;
      folderIds.clear(); // a remembered folder was deleted or moved: look the path up again
      file = await attempt();
    }
    error = '';
    return { path: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view` };
  }
  // The folders directly inside a folder path (for the folder picker). A missing path has none.
  async function listFolders(names, shared) {
    const f = await folderPath(names, shared, false);
    if (!f) return [];
    const query = `'${q(f.id)}' in parents and trashed=false and mimeType='${FOLDER}'`;
    const scope = f.driveId ? `&corpora=drive&driveId=${encodeURIComponent(f.driveId)}` : '';
    const out = [];
    let page = '';
    do {
      const r = await api(`/drive/v3/files?q=${encodeURIComponent(query)}&pageSize=200&orderBy=name&fields=nextPageToken,files(name)&${ALL}${scope}${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      out.push(...(r.files || []).map(x => x.name));
      page = r.nextPageToken;
    } while (page);
    return [...new Set(out)].sort((a, b) => a.localeCompare(b));
  }
  // ---------- sharing the backup folder ----------
  // People who can open the folder: added by Invaro or in Drive, plus anyone inherited from a parent
  // (e.g. shared drive members), which can only be changed in Drive itself.
  async function listShares(folders, shared) {
    const f = await folderPath(folders, shared, false);
    if (!f) return [];
    const r = await api(`/drive/v3/files/${encodeURIComponent(f.id)}/permissions?supportsAllDrives=true&fields=permissions(id,type,role,emailAddress,domain,displayName,permissionDetails(inherited))`);
    const me = (state.email || '').toLowerCase();
    return (r.permissions || []).filter(p => p.type !== 'anyone' && (p.emailAddress || '').toLowerCase() !== me).map(p => ({
      id: p.id, email: p.emailAddress || (p.domain ? `Anyone at ${p.domain}` : ''), name: p.displayName || '', role: p.role,
      inherited: !!(p.permissionDetails && p.permissionDetails.length && p.permissionDetails.every(d => d.inherited)),
    })).filter(p => p.email);
  }
  // Shares the folder (creating it if needed) with one person: role is "reader" or "writer".
  // Google emails them a link, which also lets people without a Google account accept.
  async function share(folders, shared, email, role, message) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter an email address, like partner@example.com.');
    if (!['reader', 'writer'].includes(role)) throw new Error('Choose "Can view" or "Can edit".');
    const f = await folderPath(folders, shared, true);
    const qs = `supportsAllDrives=true&sendNotificationEmail=true${message ? `&emailMessage=${encodeURIComponent(message.slice(0, 500))}` : ''}`;
    await api(`/drive/v3/files/${encodeURIComponent(f.id)}/permissions?${qs}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role, emailAddress: email.trim() }),
    });
    return listShares(folders, shared);
  }
  async function unshare(folders, shared, permissionId) {
    const f = await folderPath(folders, shared, false);
    if (!f) return [];
    await api(`/drive/v3/files/${encodeURIComponent(f.id)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`, { method: 'DELETE', raw: true })
      .then(async res => { if (!res.ok && res.status !== 404) { const j = await res.json().catch(() => null); throw new Error((j && j.error && j.error.message) || res.statusText); } });
    return listShares(folders, shared);
  }
  async function folderLink(folders, shared) {
    const f = await folderPath(folders, shared, false);
    if (!f) throw new Error('The backup folder will be created when you save your first invoice.');
    return `https://drive.google.com/drive/folders/${f.id}`;
  }

  // ---------- connect / disconnect ----------
  let abortWait = null;
  function cancel() { if (abortWait) abortWait(Object.assign(new Error('Connecting was cancelled.'), { cancelled: true })); }
  // Starts a one-off callback server on a free port, opens Google's consent page, and resolves
  // with the code. Gives up after 3 minutes, or when cancelled.
  function waitForCode(makeUrl) {
    return new Promise((resolve, reject) => {
      let done = false, redirect;
      const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#333"><div style="text-align:center"><h2>${title}</h2><p>${text}</p></div>`;
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, redirect);
        if (u.pathname !== '/drive/callback') { res.writeHead(404); return res.end(); }
        // Only Google's redirect carries our random state. Anything else (another page or program
        // poking this port) is ignored, so it can't cancel connecting.
        if (u.searchParams.get('state') !== expectedState) { res.writeHead(400); return res.end(); }
        const code = u.searchParams.get('code'), err = u.searchParams.get('error');
        const ok = !!code;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ok ? page('Google Drive is connected', 'You can close this tab and go back to Invaro.')
          : page("Google Drive wasn't connected", err === 'access_denied' ? 'Access was not allowed. Go back to Invaro to try again.' : 'Go back to Invaro and try again.'));
        finish(ok ? null : new Error(err === 'access_denied' ? 'Google Drive access was not allowed.' : (err || 'Connecting Google Drive failed.')), code, redirect);
      });
      const expectedState = b64url(crypto.randomBytes(16));
      const timer = setTimeout(() => finish(new Error('Connecting Google Drive timed out. Try again.')), 3 * 60 * 1000);
      function finish(err, code, redir) {
        if (done) return; done = true; abortWait = null; clearTimeout(timer);
        server.close(); server.closeAllConnections();
        err ? reject(err) : resolve({ code, redirect: redir });
      }
      abortWait = finish;
      server.on('error', e => finish(e));
      server.listen(0, '127.0.0.1', () => {
        redirect = `http://127.0.0.1:${server.address().port}/drive/callback`;
        const url = makeUrl(redirect, expectedState);
        if (env.INVOICER_AUTH_TEST) fetch(url).catch(() => {}); // tests: follow the redirects without a browser
        else shell.openExternal(url);
      });
    });
  }
  async function connect() {
    if (!clientId || !clientSecret) throw new Error('Connecting Google Drive is not set up in this version.');
    cancel(); // clicking Connect again starts over
    connecting = true; error = '';
    try {
      const verifier = b64url(crypto.randomBytes(48));
      const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
      const { code, redirect } = await waitForCode((redirect, st) => `${AUTH}?` + new URLSearchParams({
        client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
        access_type: 'offline', prompt: 'consent', state: st, code_challenge: challenge, code_challenge_method: 'S256',
      }));
      const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier });
      if (!t.refresh_token) throw new Error("Google didn't allow ongoing access. Try connecting again.");
      state = { tokens: { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (t.expires_in || 3600) } };
      folderIds.clear();
      try { state.email = (await api('/drive/v3/about?fields=user(emailAddress)')).user.emailAddress; } catch (e) {}
      save();
      return status();
    } catch (e) {
      if (!e.cancelled) error = e.message;
      throw e;
    } finally { connecting = false; }
  }
  async function disconnect() {
    const token = state.tokens && state.tokens.refresh_token;
    state = {}; error = ''; folderIds.clear(); save();
    if (token) { try { await fetch(`${REVOKE}?token=${encodeURIComponent(token)}`, { method: 'POST' }); } catch (e) { /* forgetting it locally is what matters */ } }
    return status();
  }

  return { status, connect, cancel, disconnect, listSharedDrives, listFolders, upload, folderLink, listShares, share, unshare };
}

module.exports = { createGDrive };
