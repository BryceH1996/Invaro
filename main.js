const { app, BrowserWindow, ipcMain, dialog, shell, Notification, powerMonitor, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
app.setName('Invaro');
const IS_MAC = process.platform === 'darwin', IS_WIN = process.platform === 'win32';
// Invaro was called Invoicer up to 1.14. Anyone who used it then keeps their existing folders
// (the app folder, Documents\Invoicer, My Drive\Invoicer Backups): saved invoices remember their
// full paths, and the sign-in is encrypted against the old app folder. New installs use "Invaro".
const OLD_NAME = 'Invoicer';
const keepOld = (oldDir, newDir) => fs.existsSync(oldDir) && !fs.existsSync(newDir) ? oldDir : newDir;
// Tests run with their own profile so they never clash with the installed app.
if (process.env.INVOICER_PROFILE) app.setPath('userData', process.env.INVOICER_PROFILE);
else {
  // Not keepOld: Electron may already have created the new folder by the time this runs.
  const oldProfile = path.join(app.getPath('appData'), OLD_NAME);
  if (fs.existsSync(path.join(oldProfile, 'Local State')) || fs.existsSync(path.join(oldProfile, 'config.json'))) app.setPath('userData', oldProfile);
}
// Started by Windows Task Scheduler to check reminders: no window unless a notification is clicked.
// (--hidden came from 1.6.0's start-with-Windows entry, which is removed on start.)
const CHECK_ONLY = process.argv.includes('--check-reminders') || process.argv.includes('--hidden');
// One copy at a time: starting Invaro again shows the open window (or just runs the check).
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
if (app.isPackaged && IS_WIN) app.setAppUserModelId('local.invoicer.app'); // needed for Windows notifications
const ICON = path.join(__dirname, 'build', 'icon.png');

// Data lives as plain JSON in a folder the user picks (default: Documents\Invaro).
// The chosen folder is remembered in %APPDATA%\Invaro\config.json.
const FILES = { clients: 'clients.json', settings: 'settings.json', invoices: 'invoices.json' };
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() { try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (e) { return {}; } }
function writeConfig(cfg) { fs.mkdirSync(path.dirname(configPath()), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); }
function resolveDataDir() {
  const docs = app.getPath('documents');
  return process.env.INVOICER_DATA || readConfig().dataDir || keepOld(path.join(docs, OLD_NAME), path.join(docs, 'Invaro'));
}
let DATA_DIR;

// Starter data written on first run when the data folder is empty.
// Placeholders only — fill in your real details in the app.
const SEED = {
  clients: [{
    id: 'example-client',
    company: 'Example Client Ltd',
    contacts: 'Jane Doe',
    phone: '+44 20 0000 0000',
    address: '1 Example Road\nExampletown\nAB1 2CD',
    currency: 'GBP',
    dueDays: 14,
    hourlyRate: 0,
    dailyRate: 0,
    dayOffRate: '',
    items: [
      { kind: 'days', desc: 'Development', qty: 1, amount: 0 },
      { kind: 'daysoff', desc: 'Days off', qty: 0, amount: 0 },
    ],
  }],
  settings: {
    me: {
      name: 'Your Name',
      address: '1 Your Street\nYour City, 0000',
      email: 'you@example.com',
      phone: '+00 00 000 0000',
      notes: '',
    },
    prefix: 'INV-',
    nextNumber: 1001,
    pageSize: 'letter',
    lastSaveDir: '',
  },
  invoices: [],
};

function file(name) { return path.join(DATA_DIR, FILES[name]); }

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') { writeJson(name, SEED[name]); return SEED[name]; }
    // Never overwrite a file we couldn't parse — tell the user and stop.
    dialog.showErrorBox('Invaro: could not read data',
      `${file(name)} is not valid JSON:\n\n${e.message}\n\nFix the file (or delete it to start fresh) and reopen Invaro.`);
    app.exit(1);
    throw e;
  }
}

function writeJson(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file(name)); // atomic replace so a crash never leaves half a file
}

let win;
function createWindow(show) {
  win = new BrowserWindow({
    show,
    icon: ICON,
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Invaro',
    autoHideMenuBar: true,
    backgroundColor: '#EEF4F6',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true, // built-in PDF viewer for the live preview
    },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  win.on('closed', () => { win = null; });
  win.on('focus', () => { if (team && team.active()) team.sync('focus'); else if (cloud) cloud.onFocus(); });
  // The window only ever shows the app itself: no navigating away, no new windows.
  // (Reloading the app's own page is allowed: it's how the window shows freshly synced data.)
  win.webContents.on('will-navigate', (e, url) => {
    const page = u => String(u).split('#')[0];
    if (page(url) !== page(win.webContents.getURL())) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}
function showWindow() {
  if (!win) return createWindow(true);
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  return win;
}

ipcMain.handle('data:load', () => ({
  clients: readJson('clients'),
  settings: readJson('settings'),
  invoices: readJson('invoices'),
  dataDir: DATA_DIR,
}));

ipcMain.handle('data:save', (_e, name, value) => {
  if (!FILES[name]) throw new Error('Unknown data file: ' + name);
  writeJson(name, value);
  if (name === 'clients' || name === 'invoices') remindersChanged();
  if (team && team.markDirty(name)) return true; // in a team: shared record by record
  if (cloud) cloud.markDirty(name);
  return true;
});

// Errors are returned as { error } so the UI gets a clean message instead of an IPC stack.
const safe = fn => async (...args) => { try { return await fn(...args); } catch (e) { return { error: e.message || String(e) }; } };

// ---------- account and cloud sync (cloud.js) ----------
let cloud = null, team = null;
function startCloud() {
  const { createCloud } = require('./cloud');
  cloud = createCloud({
    config: require('./package.json').cloud || {},
    dataDir: () => DATA_DIR,
    readLocal: name => JSON.parse(fs.readFileSync(file(name), 'utf8')),
    writeLocal: (name, value) => { writeJson(name, value); if (name !== 'settings') remindersChanged(); },
    onRemoteChange: () => win && win.webContents.send('data:changed'),
    onStatus: s => win && win.webContents.send('cloud:status', s),
    parentWindow: () => win,
    paused: () => !!(team && team.active()),
    onSignedIn: () => team.afterSignIn(),
    onSignedOut: () => team.signedOut(),
  });
  // Teams (team.js): the same business shared between people, synced record by record.
  team = require('./team').createTeam({
    cloud,
    dataDir: () => DATA_DIR,
    readLocal: name => JSON.parse(fs.readFileSync(file(name), 'utf8')),
    writeLocal: (name, value) => { writeJson(name, value); if (name !== 'settings') remindersChanged(); },
    // The window merges the new data in place (no reload), so nobody loses what they're typing.
    onRemoteChange: (kinds, all) => win && win.webContents.send('data:changed', {
      kinds, all: !!all, data: { clients: readJson('clients'), settings: readJson('settings'), invoices: readJson('invoices') },
    }),
    onStatus: s => win && win.webContents.send('team:status', s),
    focused: () => !!(win && win.isFocused()),
  });
}
const teamCall = fn => safe(async (_e, ...args) => { if (!team) throw new Error('Teams need the desktop app.'); return fn(...args); });
ipcMain.handle('team:status', () => team ? team.status() : { configured: false });
ipcMain.handle('team:refresh', teamCall(() => team.refresh()));
ipcMain.handle('team:create', teamCall(name => team.create(name)));
ipcMain.handle('team:invite', teamCall((email, role) => team.invite(email, role)));
ipcMain.handle('team:setRole', teamCall((id, role) => team.setRole(id, role)));
ipcMain.handle('team:cancelInvite', teamCall(id => team.cancelInvite(id)));
ipcMain.handle('team:removeMember', teamCall(id => team.removeMember(id)));
ipcMain.handle('team:leave', teamCall(() => team.leave()));
ipcMain.handle('team:delete', teamCall(() => team.deleteTeam()));
ipcMain.handle('team:accept', teamCall(id => team.acceptInvite(id)));
ipcMain.handle('team:decline', teamCall(id => team.declineInvite(id)));
ipcMain.handle('team:sync', teamCall(() => team.sync('button')));
ipcMain.handle('team:claimInvoice', teamCall(entry => team.claimInvoice(entry)));
ipcMain.handle('team:clearNotice', teamCall(() => team.clearNotice()));
ipcMain.handle('cloud:status', () => cloud ? cloud.status() : { configured: false });
ipcMain.handle('cloud:signIn', safe(() => cloud.signIn()));
ipcMain.handle('cloud:cancelSignIn', safe(() => cloud.cancelSignIn()));
ipcMain.handle('cloud:signOut', safe(() => cloud.signOut()));
ipcMain.handle('cloud:sync', safe(() => team && team.active() ? team.sync('button') : cloud.sync('button')));
ipcMain.handle('cloud:delete', safe(() => cloud.deleteCloudData()));
// A client's company name as a Windows-safe folder name.
const folderName = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim() || 'Unnamed client';

// Invoices are saved straight into <data folder>\<Client>\ (one folder per client).
// `previous` is where this same invoice was saved before: re-saving it overwrites that file.
// Any other invoice already using the name is kept, and this one gets `altName` instead.
ipcMain.handle('pdf:saveToClient', safe((_e, bytes, client, name, altName, previous) => {
  const dir = path.join(DATA_DIR, folderName(client));
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, name);
  if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(previous || '')) dest = path.join(dir, altName);
  try {
    fs.writeFileSync(dest, Buffer.from(bytes));
  } catch (e) {
    if (e.code === 'EBUSY' || e.code === 'EPERM') throw new Error(`${path.basename(dest)} is open in another program. Close it and save again.`);
    throw e;
  }
  return { path: dest };
}));
ipcMain.handle('shell:clientFolder', (_e, client) => {
  const dir = path.join(DATA_DIR, folderName(client));
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

// ---------- company logo ----------
// The chosen image is copied into the data folder as logo.<ext>, so it moves with your data.
const LOGO_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const logoData = name => {
  const p = name && path.join(DATA_DIR, path.basename(name));
  if (!p || !fs.existsSync(p)) return null;
  return `data:${LOGO_TYPES[path.extname(p).toLowerCase()] || 'image/png'};base64,${fs.readFileSync(p).toString('base64')}`;
};
// kind: 'logo' (your company) or 'bank-logo' (the bank on your EFT details).
const LOGO_KINDS = { logo: 'Choose your company logo', 'bank-logo': "Choose your bank's logo" };
const logoKind = k => LOGO_KINDS[k] ? k : 'logo';
const removeLogos = kind => fs.existsSync(DATA_DIR) && fs.readdirSync(DATA_DIR)
  .filter(f => new RegExp(`^${logoKind(kind)}\\.[a-z]+$`, 'i').test(f)).forEach(f => fs.rmSync(path.join(DATA_DIR, f), { force: true }));
ipcMain.handle('logo:load', (_e, name) => logoData(name));
ipcMain.handle('logo:choose', safe(async (_e, kind) => {
  kind = logoKind(kind);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: LOGO_KINDS[kind],
    filters: [{ name: 'Images', extensions: Object.keys(LOGO_TYPES).map(e => e.slice(1)) }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths[0]) return null;
  const ext = path.extname(filePaths[0]).toLowerCase();
  if (!LOGO_TYPES[ext]) throw new Error('Choose a PNG, JPG, WebP or SVG image.');
  if (fs.statSync(filePaths[0]).size > 10 * 1024 * 1024) throw new Error('That image is over 10 MB. Choose a smaller one.');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  removeLogos(kind);
  const name = kind + ext;
  fs.copyFileSync(filePaths[0], path.join(DATA_DIR, name));
  return { name, data: logoData(name) };
}));
ipcMain.handle('logo:remove', (_e, kind) => { removeLogos(kind); return true; });

// ---------- Cloud backups (Google Drive, OneDrive or any folder) ----------
// Google Drive for desktop shows your Drive as a "My Drive" folder (usually G:\My Drive,
// or %USERPROFILE%\My Drive in mirror mode), and OneDrive keeps a OneDrive folder in your
// user folder. Both sync that folder with the cloud in both directions. Invaro copies every
// saved invoice into "<that folder>\Invaro Backups", or into any folder you pick ("other").
const BACKUP_FOLDER = 'Invaro Backups';
const PROVIDERS = { google: 'Google Drive', onedrive: 'OneDrive', other: 'your backup folder' };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
const cloudStorage = prefix => {
  const dir = path.join(os.homedir(), 'Library', 'CloudStorage'); // macOS File Provider folders
  try { return fs.readdirSync(dir).filter(f => f.startsWith(prefix)).map(f => path.join(dir, f)); } catch (e) { return []; }
};
function findMyDrive() {
  if (process.env.INVOICER_MYDRIVE) return isDir(process.env.INVOICER_MYDRIVE) ? process.env.INVOICER_MYDRIVE : null;
  const candidates = [];
  if (IS_MAC) {
    // Google Drive for desktop on macOS: ~/Library/CloudStorage/GoogleDrive-<account>/My Drive
    candidates.push(...cloudStorage('GoogleDrive').map(d => path.join(d, 'My Drive')));
    candidates.push('/Volumes/GoogleDrive/My Drive', path.join(os.homedir(), 'Google Drive', 'My Drive'));
  } else {
    candidates.push(...[...'GDEFHIJKLMNOPQRSTUVWXYZ'].map(l => `${l}:\\My Drive`));
  }
  candidates.push(path.join(os.homedir(), 'My Drive'));
  return candidates.find(isDir) || null;
}
function findOneDrive() {
  if (process.env.INVOICER_ONEDRIVE) return isDir(process.env.INVOICER_ONEDRIVE) ? process.env.INVOICER_ONEDRIVE : null;
  // Windows sets OneDrive (personal or work) and OneDriveConsumer / OneDriveCommercial.
  const candidates = [process.env.OneDriveConsumer, process.env.OneDrive, process.env.OneDriveCommercial].filter(Boolean);
  if (IS_MAC) candidates.push(...cloudStorage('OneDrive'));
  candidates.push(path.join(os.homedir(), 'OneDrive'));
  return candidates.find(isDir) || null;
}
// Google shared drives (team drives) appear as "Shared drives\<name>" beside My Drive. In mirror
// mode My Drive moves to the user folder but shared drives stay on the Drive letter, so check both.
function findSharedDrives() {
  const roots = [];
  const myDrive = findMyDrive();
  if (myDrive) roots.push(path.join(path.dirname(myDrive), 'Shared drives'));
  if (IS_MAC) roots.push(...cloudStorage('GoogleDrive').map(d => path.join(d, 'Shared drives')));
  else roots.push(...[...'GDEFHIJKLMNOPQRSTUVWXYZ'].map(l => `${l}:\\Shared drives`));
  const drives = new Map();
  for (const r of roots.filter(isDir)) {
    try {
      for (const f of fs.readdirSync(r)) if (!drives.has(f) && isDir(path.join(r, f))) drives.set(f, path.join(r, f));
    } catch (e) {}
  }
  return [...drives].map(([name, p]) => ({ name, path: p })).sort((a, b) => a.name.localeCompare(b.name));
}
// Google Drive online (gdrive.js): used instead of the My Drive folder once an account is connected,
// so it works without Google Drive for desktop. Created on first use (safeStorage needs the app ready).
let gdriveApi = null;
// The OAuth client lives in gdrive.config.json, which git ignores (see SYNC.md). Without it the
// Connect button stays hidden.
const gdriveConfig = () => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'gdrive.config.json'), 'utf8')); } catch (e) { return {}; } };
const gdrive = () => gdriveApi || (gdriveApi = require('./gdrive').createGDrive({ config: gdriveConfig() }));
ipcMain.handle('gdrive:status', () => gdrive().status());
ipcMain.handle('gdrive:connect', safe(() => gdrive().connect()));
ipcMain.handle('gdrive:cancel', () => gdrive().cancel());
ipcMain.handle('gdrive:disconnect', safe(() => gdrive().disconnect()));

// The folder inside the drive, as typed or picked ("Finance/Invoices"): split into safe parts.
// Empty means the default "Invaro Backups". ".." and characters Drive or Windows reject are dropped.
function folderParts(folder) {
  const parts = String(folder || '').split(/[\\/]+/).map(p => p.replace(/[<>:"|?*\x00-\x1f]/g, '').trim().replace(/[. ]+$/, ''))
    .filter(p => p && p !== '.' && p !== '..');
  return parts.length ? parts : null;
}
// sel is { provider, dir, shared, folder }; a plain string is a folder chosen before providers existed.
// shared is the name of a Google shared drive (empty means My Drive); folder is the path inside the drive.
function backupTarget(sel) {
  if (typeof sel === 'string' || !sel) sel = { provider: sel ? 'other' : 'google', dir: sel || '' };
  const provider = PROVIDERS[sel.provider] ? sel.provider : 'google';
  const custom = folderParts(sel.folder), parts = custom || [BACKUP_FOLDER];
  let root = null, dir = null, name = PROVIDERS[provider], shared = null;
  if (provider === 'google' && gdrive().status().connected) {
    shared = sel.shared || null;
    const where = `${shared ? `Shared drives/${shared}` : 'My Drive'}/${parts.join('/')}`;
    return { provider, online: true, email: gdrive().status().email, name: shared ? `the "${shared}" shared drive` : 'Google Drive',
      shared, parts, root: where, myDrive: findMyDrive(), dir: where, auto: true, ready: true };
  }
  if (provider === 'other') dir = sel.dir || null;
  else {
    if (provider === 'google' && sel.shared) {
      shared = sel.shared;
      name = `the "${shared}" shared drive`;
      const found = findSharedDrives().find(d => d.name === shared);
      root = found ? found.path : null;
    } else root = provider === 'onedrive' ? findOneDrive() : findMyDrive();
    if (root) dir = provider === 'google' && !shared && !custom
      ? keepOld(path.join(root, `${OLD_NAME} Backups`), path.join(root, BACKUP_FOLDER)) : path.join(root, ...parts);
  }
  // The sync app's own folder must exist; the folders inside it are created as needed.
  const base = provider === 'other' ? dir && path.dirname(dir) : root;
  return { provider, name, shared, parts, root, myDrive: provider === 'google' ? findMyDrive() : undefined, dir, auto: provider !== 'other',
    ready: !!dir && (isDir(dir) || isDir(base)) };
}
ipcMain.handle('backup:status', (_e, sel) => backupTarget(sel));
ipcMain.handle('backup:sharedDrives', async () => {
  if (!gdrive().status().connected) return findSharedDrives();
  try { return await gdrive().listSharedDrives(); } catch (e) { return []; } // offline: the renderer keeps the chosen one
});
// Backups mirror the client folders: <backup folder>\<Client>\<file>.
ipcMain.handle('backup:write', safe((_e, bytes, name, sel, client) => {
  const t = backupTarget(sel);
  if (t.online) return gdrive().upload({ bytes, name, folders: [...t.parts, folderName(client)], shared: t.shared });
  if (!t.dir) throw new Error(t.provider === 'other' ? 'No backup folder chosen' : `${t.name} isn't installed or signed in`);
  // Create the backup folder inside the drive, but never invent the drive itself:
  // a missing drive folder usually means the sync app isn't running.
  if (!isDir(t.dir)) {
    if (!t.ready) throw new Error(`Can't reach ${t.dir}. Is ${t.provider === 'other' ? 'the drive connected' : t.name + ' running'}?`);
    fs.mkdirSync(t.dir, { recursive: true });
  }
  const sub = path.join(t.dir, folderName(client));
  fs.mkdirSync(sub, { recursive: true });
  const dest = path.join(sub, name);
  fs.writeFileSync(dest, Buffer.from(bytes));
  return { path: dest };
}));
ipcMain.handle('backup:chooseDir', async (_e, sel) => {
  const t = backupTarget(sel);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose where invoice backups go',
    defaultPath: t.dir && isDir(t.dir) ? t.dir : (findMyDrive() || findOneDrive() || app.getPath('documents')),
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled || !filePaths[0] ? null : filePaths[0];
});
ipcMain.handle('backup:open', safe(async (_e, sel) => {
  const t = backupTarget(sel);
  if (t.online) return shell.openExternal(await gdrive().folderLink(t.parts, t.shared));
  if (!t.dir || !isDir(t.dir)) throw new Error('The backup folder will be created when you save your first invoice.');
  return shell.openPath(t.dir);
}));
// Sharing the backup folder with a partner or colleague. Only possible with Google Drive connected online.
const onlineTarget = sel => {
  const t = backupTarget(sel);
  if (!t.online) throw new Error('Connect Google Drive to share your invoices.');
  return t;
};
ipcMain.handle('backup:shares', safe(async (_e, sel) => { const t = onlineTarget(sel); return gdrive().listShares(t.parts, t.shared); }));
ipcMain.handle('backup:share', safe(async (_e, sel, email, role, message) => {
  const t = onlineTarget(sel); return gdrive().share(t.parts, t.shared, String(email || ''), role, String(message || ''));
}));
ipcMain.handle('backup:unshare', safe(async (_e, sel, id) => { const t = onlineTarget(sel); return gdrive().unshare(t.parts, t.shared, String(id)); }));
// For the folder picker: the folders inside <drive>/<path>, where path is an array of names.
ipcMain.handle('backup:folders', safe(async (_e, sel, parts) => {
  const t = backupTarget(sel);
  parts = folderParts((parts || []).join('/')) || [];
  if (t.online) return gdrive().listFolders(parts, t.shared);
  if (!t.root || !isDir(t.root)) throw new Error(`Can't reach ${t.name}. Is it running?`);
  const dir = path.join(t.root, ...parts);
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.') && !(parts.length === 0 && /^\$|^System Volume Information$/i.test(d.name)))
    .map(d => d.name).sort((a, b) => a.localeCompare(b));
}));
// Only these pages can be opened in the browser from the app.
const EXTERNAL_OK = [/^https:\/\/www\.google\.com\/drive\/download\/$/, /^https:\/\/www\.microsoft\.com\/microsoft-365\/onedrive\/download$/,
  /^https:\/\/drive\.google\.com\/(file\/d|drive\/folders)\/[\w-]+(\/view)?(\?[\w=&-]*)?$/, /^https:\/\/bryceh1996\.github\.io\/invoicer\/[a-z.-]*$/];
ipcMain.handle('shell:external', (_e, url) => {
  if (EXTERNAL_OK.some(re => re.test(String(url)))) return shell.openExternal(url);
});

// Switch data folder. If the chosen folder already has Invaro data, use it;
// otherwise copy the current files there. Returns the new folder or null.
ipcMain.handle('data:chooseDir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose where Invaro keeps its data',
    defaultPath: DATA_DIR,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return null;
  const target = filePaths[0];
  if (path.resolve(target) === path.resolve(DATA_DIR)) return null;
  const hasData = fs.existsSync(path.join(target, FILES.clients));
  if (hasData) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Use that data', 'Cancel'], defaultId: 0, cancelId: 1,
      message: 'That folder already has Invaro data.',
      detail: 'Invaro will switch to the clients and history in that folder. Your current folder is left untouched.',
    });
    if (response !== 0) return null;
  } else {
    fs.mkdirSync(target, { recursive: true });
    const logos = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).filter(f => /^(bank-)?logo\.[a-z]+$/i.test(f)) : [];
    for (const f of [...Object.values(FILES), ...logos]) {
      const src = path.join(DATA_DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, f));
    }
  }
  writeConfig({ ...readConfig(), dataDir: target });
  DATA_DIR = target;
  syncReminderTask(); // the other folder's clients may have different reminders
  // Signed in: treat the new folder like a first sign-in (asks which copy to keep if both have data).
  if (team && team.active()) await team.reload().catch(() => {}); // in a team: fill the new folder with the team's data
  else if (cloud && cloud.status().signedIn) await cloud.firstSync().catch(() => {});
  return target;
});

// ---------- updates ----------
// `npm run release` drops the installer + latest.json into <data folder>/updates.
// The installed app looks there and offers to install anything newer.
const updatesDir = () => path.join(DATA_DIR, 'updates');
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
function findUpdate() {
  if (!IS_WIN) return null; // the updates folder only ever holds the Windows installer
  try {
    const info = JSON.parse(fs.readFileSync(path.join(updatesDir(), 'latest.json'), 'utf8'));
    const installer = path.join(updatesDir(), path.basename(info.file || ''));
    if (compareVersions(info.version, app.getVersion()) > 0 && fs.existsSync(installer)) {
      return { version: info.version, notes: info.notes || '', installer };
    }
  } catch (e) { /* no updates folder yet, or unreadable: nothing to offer */ }
  return null;
}
// ---- updates from GitHub Releases ----
// `npm run release` attaches each installer to a release on the public repo in package.json
// ("updateRepo"), so any copy can check for and download updates without signing in.
const UPDATE_REPO = require('./package.json').updateRepo;
const GH_HEADERS = { 'User-Agent': 'Invaro', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
// The newest release on GitHub that has an installer, or null. Throws a readable error.
async function githubLatest() {
  if (!UPDATE_REPO) return null;
  const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: GH_HEADERS });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub said ${res.status}.`);
  const r = await res.json();
  // Windows updates with the installer; macOS with the zipped app (the .dmg is for first installs).
  const asset = (r.assets || []).find(a => (IS_MAC ? /-mac\.zip$/i : /\.exe$/i).test(a.name));
  return asset ? { version: String(r.tag_name).replace(/^v/, ''), notes: r.body || '', source: 'github', asset: asset.browser_download_url, name: asset.name, size: asset.size } : null;
}
// Downloads a release installer to the temp folder, reporting progress to the window.
async function downloadAsset(u) {
  const res = await fetch(u.asset, { headers: { 'User-Agent': 'Invaro' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || u.size || 0;
  const dest = path.join(os.tmpdir(), u.name);
  const out = fs.createWriteStream(dest);
  let got = 0, lastPct = -1;
  for await (const chunk of res.body) {
    out.write(chunk); got += chunk.length;
    const pct = total ? Math.floor(got / total * 100) : 0;
    if (pct !== lastPct && win) { lastPct = pct; win.webContents.send('update:progress', pct); }
  }
  await new Promise((ok, bad) => out.end(err => err ? bad(err) : ok()));
  if (total && got !== total) throw new Error('Download was incomplete. Try again.');
  return dest;
}

// The newest update from either place (the updates folder or GitHub), or null.
let offered = null;
async function bestUpdate() {
  const local = findUpdate();
  const remote = await githubLatest().catch(() => null);
  const newer = remote && compareVersions(remote.version, app.getVersion()) > 0 ? remote : null;
  if (!local) return newer;
  if (!newer) return local;
  return compareVersions(newer.version, local.version) > 0 ? newer : local;
}
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged && !process.env.INVOICER_UPDATE_TEST) return null; // `npm start` is always current
  offered = await bestUpdate();
  return offered && { version: offered.version, notes: offered.notes, current: app.getVersion() };
});
// ---- macOS: replace the .app in place ----
// The update is the zipped app. It's unpacked next to the temp folder, and a small shell script
// swaps it in once Invaro has quit, then opens the new version.
const run = (cmd, args) => new Promise((ok, bad) => execFile(cmd, args, (err, out, errOut) => err ? bad(new Error(String(errOut || err.message).trim())) : ok(String(out))));
const macAppBundle = () => path.resolve(process.execPath, '..', '..', '..'); // …/Invaro.app/Contents/MacOS/Invaro
function macUpdateProblem() {
  const appPath = macAppBundle();
  if (!appPath.endsWith('.app')) return "Invaro isn't running from an app, so it can't update itself.";
  if (appPath.includes('/AppTranslocation/') || appPath.startsWith('/Volumes/')) return 'Move Invaro into your Applications folder and open it from there, then update.';
  try { fs.accessSync(path.dirname(appPath), fs.constants.W_OK); }
  catch (e) { return `Invaro can't replace itself in ${path.dirname(appPath)}. Download the new version from the releases page instead.`; }
  return null;
}
async function installMacUpdate(zip) {
  const problem = macUpdateProblem();
  if (problem) throw new Error(problem);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invaro-update-'));
  await run('/usr/bin/ditto', ['-x', '-k', zip, dir]);
  const fresh = fs.readdirSync(dir).find(f => f.endsWith('.app'));
  if (!fresh) throw new Error('The download had no app in it.');
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    '# $1 = pid to wait for, $2 = installed app, $3 = new app, $4 = where it goes (renamed Invoicer.app → Invaro.app)',
    'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done',
    'rm -rf "$2.old" && mv "$2" "$2.old" && rm -rf "$4" && mv "$3" "$4" && rm -rf "$2.old"',
    'xattr -dr com.apple.quarantine "$4" 2>/dev/null',
    'open "$4"',
  ].join('\n'));
  spawn('/bin/sh', [script, String(process.pid), macAppBundle(), path.join(dir, fresh), path.join(path.dirname(macAppBundle()), fresh)], { detached: true, stdio: 'ignore' }).unref();
}

ipcMain.handle('update:install', safe(async () => {
  const u = offered || await bestUpdate();
  if (!u) return false;
  if (IS_MAC && !process.env.INVOICER_UPDATE_TEST && macUpdateProblem()) throw new Error(macUpdateProblem());
  let tmp;
  if (u.source === 'github') tmp = await downloadAsset(u);
  else {
    // Copy out of OneDrive first (makes sure it's downloaded and not locked).
    tmp = path.join(os.tmpdir(), path.basename(u.installer));
    fs.copyFileSync(u.installer, tmp);
  }
  if (process.env.INVOICER_UPDATE_TEST) return { downloaded: tmp, size: fs.statSync(tmp).size }; // tests stop here
  if (IS_MAC) await installMacUpdate(tmp);
  else spawn(tmp, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 300);
  return true;
}));
ipcMain.handle('update:info', () => {
  // 1.7.0 kept a GitHub token for the private repo; updates no longer need one, so forget it.
  const cfg = readConfig();
  if (cfg.ghToken) { delete cfg.ghToken; writeConfig(cfg); }
  return { repo: UPDATE_REPO, version: app.getVersion() };
});
ipcMain.handle('update:releases', () => UPDATE_REPO && shell.openExternal(`https://github.com/${UPDATE_REPO}/releases`));

// Exchange rates for Reports in rand: Standard Bank's T/T buying rate for an invoice's date (see fx.js).
let fxApi = null;
const fx = () => fxApi || (fxApi = require('./fx')(path.join(app.getPath('userData'), 'fx-cache.json')));
ipcMain.handle('fx:rate', safe((_e, currency, date) => fx().rate(currency, date)));

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
ipcMain.handle('shell:show', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:dataDir', () => { fs.mkdirSync(DATA_DIR, { recursive: true }); return shell.openPath(DATA_DIR); });

// ---------- invoice reminders ----------
// Each client can have a reminder day (1–28, or "last" = last working day of the month).
// From that day, a Windows notification appears once a day until an invoice for that client
// is saved (one saved up to a week before the reminder counts), or you skip the month.
const reminderStatePath = () => path.join(app.getPath('userData'), 'reminders.json');
function readReminderState() { try { return JSON.parse(fs.readFileSync(reminderStatePath(), 'utf8')); } catch (e) { return {}; } }
function writeReminderState(s) { fs.mkdirSync(path.dirname(reminderStatePath()), { recursive: true }); fs.writeFileSync(reminderStatePath(), JSON.stringify(s, null, 2)); }
const readQuiet = name => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch (e) { return null; } };
// INVOICER_NOW lets tests pretend it's another date/time.
const now = () => process.env.INVOICER_NOW ? new Date(process.env.INVOICER_NOW) : new Date();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// The daily check is needed while any client has a reminder, or any invoice is unpaid (for overdue reminders).
const remindersOn = () => !!DATA_DIR && ((readQuiet('clients') || []).some(c => c.reminderDay) || (readQuiet('invoices') || []).some(h => h.tracked && !h.paidAt && !(h.inv && h.inv.type === 'quote')));

function reminderDate(day, y, m) {
  const last = new Date(y, m + 1, 0);
  if (day === 'last') { while (last.getDay() === 0 || last.getDay() === 6) last.setDate(last.getDate() - 1); return last; }
  const n = parseInt(day, 10);
  return n ? new Date(y, m, Math.min(n, last.getDate())) : null;
}
// Clients whose reminder for this month has come and who haven't been invoiced (or skipped) since.
// Where every client stands this month: off, upcoming, due, invoiced or skipped,
// with this month's reminder date and the next one still to come.
function reminderOverview(at = now()) {
  if (!DATA_DIR) return [];
  const clients = readQuiet('clients') || [], invoices = readQuiet('invoices') || [];
  const skipped = readReminderState().skipped || {};
  const today = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  return clients.map(c => {
    const base = { id: c.id, company: c.company || 'a client', reminderDay: c.reminderDay || '' };
    const d = reminderDate(c.reminderDay, at.getFullYear(), at.getMonth());
    if (!d) return { ...base, status: 'off' };
    const following = ymd(reminderDate(c.reminderDay, at.getFullYear(), at.getMonth() + 1));
    if (d > today) return { ...base, status: 'upcoming', date: ymd(d), next: ymd(d) };
    if (skipped[c.id] === ymd(d)) return { ...base, status: 'skipped', date: ymd(d), next: following };
    const since = new Date(d); since.setDate(since.getDate() - 7);
    const inv = invoices.find(h => h.c && h.c.id === c.id && !(h.inv && h.inv.type === 'quote') && new Date(h.savedAt) >= since);
    if (inv) return { ...base, status: 'invoiced', date: ymd(d), next: following, invoice: inv.inv && inv.inv.number };
    return { ...base, status: 'due', date: ymd(d), next: following };
  });
}
// Clients whose reminder for this month has come and who haven't been invoiced (or skipped) since.
const dueReminders = (at = now()) => reminderOverview(at).filter(r => r.status === 'due');

// Clicking a notification opens the invoice for that client. If the window had to be
// created first, the UI picks the client up with reminders:takeOpen once it has loaded.
let pendingOpen = null;
function openReminder(id) {
  const w = showWindow();
  if (w.webContents.isLoading()) pendingOpen = id;
  else w.webContents.send('reminder:open', id);
}

const shown = new Set(); // keep notifications referenced so their click handlers still work
// r: { title, body, open } where open is a client id (start an invoice) or 'history'.
function notify(r) {
  if (process.env.INVOICER_NOTIFY_LOG) fs.appendFileSync(process.env.INVOICER_NOTIFY_LOG, JSON.stringify(r) + '\n');
  if (!Notification.isSupported()) return;
  // timeoutType 'never' keeps it on screen until you click or dismiss it.
  const n = new Notification({ title: r.title, body: r.body, icon: ICON, timeoutType: 'never' });
  const done = () => { shown.delete(n); quitIfIdle(); };
  n.on('click', () => { openReminder(r.open); done(); });
  n.on('close', done);
  shown.add(n);
  n.show();
}
// Invoices saved since paid tracking began (1.12.0) that are unpaid and past their due date.
const isOpenInvoice = h => h.tracked && !h.paidAt && !(h.inv && h.inv.type === 'quote');
function overdueInvoices(at = now()) {
  const today = ymd(at);
  return (readQuiet('invoices') || []).filter(h => isOpenInvoice(h) && h.inv.due && h.inv.due < today);
}
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
// From 9am: each due invoice reminder at most once a day, and each overdue invoice on the first
// day it's overdue and then once a week until it's marked paid. Returns how many were shown.
function checkReminders() {
  const at = now();
  const due = dueReminders(at);
  if (win) win.webContents.send('reminders', due);
  if (at.getHours() < 9) return 0;
  const state = readReminderState(), notified = state.notified || {}, overdueSeen = state.overdueNotified || {};
  const fresh = due.filter(r => notified[r.id] !== ymd(at));
  fresh.forEach(r => { notified[r.id] = ymd(at); notify({ title: `Time to invoice ${r.company}`, body: 'Click to start the invoice.', open: r.id }); });
  const late = overdueInvoices(at).filter(h => !overdueSeen[h.id] || daysBetween(overdueSeen[h.id], ymd(at)) >= 7);
  late.forEach(h => {
    overdueSeen[h.id] = ymd(at);
    const amount = `${h.c.currency || ''} ${(Number(h.total) || 0).toFixed(2)}`.trim();
    notify({ title: `${h.inv.number} is overdue`, body: `${h.c.company || 'A client'} owes ${amount}, due ${h.inv.due}. Click to open History.`, open: 'history' });
  });
  if (!fresh.length && !late.length) return 0;
  writeReminderState({ ...readReminderState(), notified, overdueNotified: overdueSeen });
  return fresh.length + late.length;
}
// A check-only run quits once there's no window and no notification waiting to be clicked.
function quitIfIdle() { if (CHECK_ONLY && !win && !shown.size) app.quit(); }

// ---------- the daily reminder check (Windows Task Scheduler / macOS launchd) ----------
// While any client has a reminder, the system runs "Invaro --check-reminders" every day at 9am
// (or as soon as the computer is on and you're signed in, if it was off at 9). With no reminders
// left, it's removed. On Windows the uninstaller removes it too (build/installer.nsh).
const TASK = process.env.INVOICER_TASK_NAME || 'Invaro reminders';
// In development the executable is Electron itself, which needs the app folder as its first argument.
const checkArgs = () => [...(app.isPackaged ? [] : [app.getAppPath()]), '--check-reminders'];
const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const schtasks = args => new Promise(resolve =>
  execFile('schtasks.exe', args, { windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || stderr || (err && err.message) || '') })));
const windowsScheduler = {
  name: 'Windows Task Scheduler',
  problem: () => null,
  exists: async () => (await schtasks(['/query', '/tn', TASK])).ok,
  async create() {
    const args = checkArgs().map(a => a.startsWith('--') ? a : `"${a}"`).join(' ');
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Shows Invaro's invoice reminders. Created by Invaro and deleted when no client has a reminder.</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger><StartBoundary>2026-01-01T09:00:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT12H</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xmlEsc(process.execPath)}</Command><Arguments>${xmlEsc(args)}</Arguments></Exec></Actions>
</Task>`;
    const xmlFile = path.join(os.tmpdir(), `invaro-task-${process.pid}.xml`);
    fs.writeFileSync(xmlFile, Buffer.from('﻿' + xml, 'utf16le'));
    const r = await schtasks(['/create', '/tn', TASK, '/xml', xmlFile, '/f']);
    fs.rmSync(xmlFile, { force: true });
    if (!r.ok) throw new Error(r.out);
  },
  async remove() {
    const r = await schtasks(['/delete', '/tn', TASK, '/f']);
    if (!r.ok && await this.exists()) throw new Error(r.out);
  },
  async info() {
    const q = await schtasks(['/query', '/tn', TASK, '/fo', 'list', '/v']);
    if (!q.ok) return { exists: false };
    const field = name => (q.out.match(new RegExp('^' + name + ':\\s*(.+)$', 'mi')) || [])[1];
    return { exists: true, nextRun: field('Next Run Time') };
  },
};

// macOS: a LaunchAgent in ~/Library/LaunchAgents, loaded into your login session.
const LABEL = process.env.INVOICER_TASK_NAME ? 'local.invoicer.reminders-test' : 'local.invoicer.reminders';
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const launchctl = args => new Promise(resolve => execFile('/bin/launchctl', args, err => resolve(!err)));
const macScheduler = {
  name: 'launchd',
  // A copy run straight from the download (or the disk image) lives at a temporary path, which a
  // daily job can't point at. macOS fixes that once the app is in Applications.
  problem: () => app.isPackaged && (process.execPath.includes('/AppTranslocation/') || process.execPath.startsWith('/Volumes/'))
    ? 'Move Invaro into your Applications folder and open it from there to turn on reminders while it\'s closed.' : null,
  exists: async () => fs.existsSync(plistPath()),
  async create() {
    const programArgs = [process.execPath, ...checkArgs()].map(a => `    <string>${xmlEsc(a)}</string>`).join('\n');
    fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
    fs.writeFileSync(plistPath(), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`);
    const domain = `gui/${process.getuid()}`;
    await launchctl(['bootout', `${domain}/${LABEL}`]); // replace any older copy
    if (!await launchctl(['bootstrap', domain, plistPath()])) throw new Error('launchctl could not load the reminder job');
  },
  async remove() {
    await launchctl(['bootout', `gui/${process.getuid()}/${LABEL}`]);
    fs.rmSync(plistPath(), { force: true });
  },
  async info() { return { exists: fs.existsSync(plistPath()), nextRun: 'every day at 9:00, and when you log in' }; },
};

const scheduler = IS_WIN ? windowsScheduler : IS_MAC ? macScheduler : null;
const taskEnabled = () => !!scheduler && (app.isPackaged || !!process.env.INVOICER_TASK_NAME);
let taskSync = Promise.resolve();
// Creates or removes the scheduled check to match the clients. `verify` also asks the system whether
// it exists (on start-up, in case it was deleted by hand); otherwise the last result is trusted.
function syncReminderTask(verify) {
  if (!taskEnabled()) return taskSync;
  taskSync = taskSync.then(async () => {
    const want = remindersOn() && !scheduler.problem() ? process.execPath : null;
    let have = readReminderState().task || null;
    if (verify) {
      // The task was called "Invoicer reminders" up to 1.14; this one replaces it.
      if (IS_WIN && !process.env.INVOICER_TASK_NAME) await schtasks(['/delete', '/tn', `${OLD_NAME} reminders`, '/f']);
      if (!await scheduler.exists()) have = null;
      else if (!have) have = 'unknown'; // exists, but not one we recorded: rewrite or remove it
    }
    if (want === have) return;
    try { await (want ? scheduler.create() : scheduler.remove()); }
    catch (e) { console.error(`Could not ${want ? 'set up' : 'remove'} the reminder check:`, e.message); return; }
    writeReminderState({ ...readReminderState(), task: want });
  });
  return taskSync;
}

// Called whenever clients or invoices are saved: refresh the in-app bars and the scheduled task.
function remindersChanged() {
  if (win) win.webContents.send('reminders', dueReminders());
  syncReminderTask();
}
ipcMain.handle('reminders:due', () => dueReminders());
ipcMain.handle('reminders:overview', () => reminderOverview());
// Whether the daily reminder check is set up, and when it runs next.
ipcMain.handle('reminders:task', async () => {
  if (!taskEnabled()) return { enabled: false, platform: process.platform };
  await syncReminderTask(true); // finish any pending change, and put the check back if it went missing
  return { enabled: true, platform: process.platform, problem: scheduler.problem(), ...await scheduler.info() };
});
ipcMain.handle('reminders:test', () => {
  if (!Notification.isSupported()) return { error: "This computer doesn't support notifications." };
  new Notification({ title: 'Invaro reminders are working', body: "This is how you'll be reminded to invoice a client.", icon: ICON }).show();
  return {};
});
ipcMain.handle('reminders:takeOpen', () => { const id = pendingOpen; pendingOpen = null; return id; });
ipcMain.handle('reminders:skip', (_e, id) => {
  const r = dueReminders().find(x => x.id === id);
  if (r) { const s = readReminderState(); writeReminderState({ ...s, skipped: { ...(s.skipped || {}), [id]: r.date } }); }
  return dueReminders();
});

// Starting Invaro while it's already running: a scheduled check just re-checks, anything else shows the window.
app.on('second-instance', (_e, argv) => {
  if (argv.includes('--check-reminders')) checkReminders(); else showWindow();
});
app.whenReady().then(async () => {
  DATA_DIR = resolveDataDir();
  // 1.6.0 (then called Invoicer) started with Windows to sit in the tray; the scheduled task replaces that.
  if (app.isPackaged && IS_WIN && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin) app.setLoginItemSettings({ openAtLogin: false, args: ['--hidden'] });
  // macOS: the usual app, Edit (for copy and paste) and Window menus. No View menu, so ⌘+ / ⌘− zoom
  // the invoice preview rather than the whole window.
  if (IS_MAC) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
  if (CHECK_ONLY) {
    await syncReminderTask(true);
    if (!checkReminders()) return app.quit();
    // Wait for a click, but no longer than the task's own 12-hour limit.
    setTimeout(() => app.quit(), 12 * 60 * 60 * 1000);
    return;
  }
  startCloud();
  createWindow(true);
  syncReminderTask(true);
  win.webContents.once('did-finish-load', () => { setTimeout(checkReminders, 3000); setTimeout(() => team.active() ? team.sync('start') : cloud.sync('start'), 2000); });
  setInterval(checkReminders, 15 * 60 * 1000);
  powerMonitor.on('resume', checkReminders);
  powerMonitor.on('unlock-screen', checkReminders);
});
// A check-only run stays up without a window while a notification is waiting to be clicked.
// On macOS, closing the window leaves the app in the Dock, as Mac apps usually do.
app.on('window-all-closed', () => {
  if (CHECK_ONLY) { if (!shown.size) app.quit(); return; }
  if (!IS_MAC) app.quit();
});
app.on('activate', () => { if (app.isReady() && !CHECK_ONLY) showWindow(); });
