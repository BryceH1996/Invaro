// Google Drive backup: OAuth sign-in (loopback + PKCE) and PDF uploads via the Drive v3 REST API.
// Uses the drive.file scope, so Invoicer can only see files it created itself.
// Credentials live in %APPDATA%\Invoicer\google.json, encrypted with Windows DPAPI (safeStorage).
const { app, safeStorage, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const ABOUT = 'https://www.googleapis.com/drive/v3/about';
const FOLDER_NAME = 'Invoicer Backups';

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const credPath = () => path.join(app.getPath('userData'), 'google.json');

function enc(s) {
  if (!s) return '';
  return safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : 'raw:' + s;
}
function dec(s) {
  if (!s) return '';
  if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
  return s.replace(/^raw:/, '');
}

let creds = null;
let access = { token: null, exp: 0 };

function get() {
  if (creds) return creds;
  try {
    const raw = JSON.parse(fs.readFileSync(credPath(), 'utf8'));
    creds = { ...raw, secret: dec(raw.secret), refreshToken: dec(raw.refreshToken) };
  } catch (e) { creds = {}; }
  return creds;
}
function save() {
  const c = get();
  fs.mkdirSync(path.dirname(credPath()), { recursive: true });
  fs.writeFileSync(credPath(), JSON.stringify({
    clientId: c.clientId || '', secret: enc(c.secret), refreshToken: enc(c.refreshToken),
    email: c.email || '', folderId: c.folderId || '',
  }, null, 2));
}

function status() {
  const c = get();
  return { connected: !!c.refreshToken, email: c.email || '', clientId: c.clientId || '', hasSecret: !!c.secret, folderId: c.folderId || '' };
}

const donePage = ok => `<!doctype html><meta charset="utf-8"><title>Invoicer</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#333">
<div style="text-align:center"><h2 style="color:${ok ? '#bf9000' : '#b3261e'}">${ok ? 'Invoicer is connected to Google Drive' : 'Google sign-in did not complete'}</h2>
<p>You can close this tab and go back to Invoicer.</p></div>`;

async function connect(clientId, secret) {
  clientId = String(clientId || '').trim();
  secret = String(secret || '').trim() || get().secret;
  if (!clientId || !secret) throw new Error('Enter the client ID and client secret first.');

  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  // Google sends the browser back to this temporary local address with the sign-in code.
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;

  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Google sign-in.')), 5 * 60 * 1000);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirect);
      if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const ok = !err && code && u.searchParams.get('state') === state;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(donePage(ok));
      clearTimeout(timer);
      if (ok) resolve(code);
      else reject(new Error(err ? `Google sign-in was cancelled (${err}).` : 'Google sign-in response did not match. Try again.'));
    });
  });

  shell.openExternal(AUTH + '?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state,
    access_type: 'offline', prompt: 'consent',
  }));

  let code;
  try { code = await codePromise; } finally { server.close(); }

  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) throw new Error('Google sign-in failed: ' + (j.error_description || j.error || `HTTP ${r.status}`));

  const prev = get();
  creds = { clientId, secret, refreshToken: j.refresh_token, email: '', folderId: prev.clientId === clientId ? prev.folderId : '' };
  access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  try {
    const a = await (await api(ABOUT + '?fields=user(emailAddress)')).json();
    creds.email = (a.user && a.user.emailAddress) || '';
  } catch (e) { /* email is only for display */ }
  save();
  return status();
}

async function disconnect() {
  const c = get();
  if (c.refreshToken) {
    fetch(REVOKE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: c.refreshToken }) }).catch(() => {});
  }
  creds = { clientId: c.clientId, secret: c.secret, refreshToken: '', email: '', folderId: c.folderId };
  access = { token: null, exp: 0 };
  save();
  return status();
}

async function accessToken() {
  if (access.token && Date.now() < access.exp - 60 * 1000) return access.token;
  const c = get();
  if (!c.refreshToken) throw new Error('Google Drive is not connected. Connect it in My details.');
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, refresh_token: c.refreshToken, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === 'invalid_grant') {
      creds.refreshToken = ''; save();
      throw new Error('Google Drive access has expired. Reconnect in My details.');
    }
    throw new Error('Could not reach Google: ' + (j.error_description || j.error || `HTTP ${r.status}`));
  }
  access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return access.token;
}

async function api(url, opts = {}) {
  const token = await accessToken();
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) } });
  if (!r.ok) {
    let msg = '';
    try { const j = await r.json(); msg = (j.error && j.error.message) || ''; } catch (e) {}
    const err = new Error(`Google Drive error ${r.status}${msg ? ': ' + msg : ''}`);
    err.status = r.status;
    throw err;
  }
  return r;
}

async function folderId() {
  const c = get();
  if (c.folderId) {
    try {
      const f = await (await api(`${FILES}/${c.folderId}?fields=id,trashed`)).json();
      if (!f.trashed) return f.id;
    } catch (e) { if (e.status !== 404) throw e; }
  }
  const f = await (await api(FILES + '?fields=id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  })).json();
  creds.folderId = f.id; save();
  return f.id;
}

// Uploads a PDF into the backup folder; a file with the same name is replaced (re-saved invoice).
async function upload(bytes, name) {
  const parent = await folderId();
  const q = `name='${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and '${parent}' in parents and trashed=false`;
  const existing = (await (await api(`${FILES}?q=${encodeURIComponent(q)}&fields=files(id)`)).json()).files || [];
  const pdf = Buffer.from(bytes);
  let r;
  if (existing[0]) {
    r = await api(`${UPLOAD}/${existing[0].id}?uploadType=media&fields=id,webViewLink`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/pdf' }, body: pdf,
    });
  } else {
    const boundary = 'invoicer' + crypto.randomBytes(8).toString('hex');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name, parents: [parent], mimeType: 'application/pdf' }) +
        `\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      pdf,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    r = await api(`${UPLOAD}?uploadType=multipart&fields=id,webViewLink`, {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
  }
  const f = await r.json();
  return { id: f.id, link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view` };
}

async function folderLink() { return `https://drive.google.com/drive/folders/${await folderId()}`; }

module.exports = { status, connect, disconnect, upload, folderLink };
