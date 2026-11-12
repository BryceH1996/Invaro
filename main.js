const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
app.setName('Invoicer');
// Tests run with their own profile so they never clash with the installed app.
if (process.env.INVOICER_PROFILE) app.setPath('userData', process.env.INVOICER_PROFILE);
// One copy at a time: starting Invoicer again (e.g. while it's in the tray) shows the open window.
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
if (app.isPackaged) app.setAppUserModelId('local.invoicer.app'); // needed for Windows notifications
const ICON = path.join(__dirname, 'build', 'icon.png');

// Data lives as plain JSON in a folder the user picks (default: Documents\Invoicer).
// The chosen folder is remembered in %APPDATA%\Invoicer\config.json.
const FILES = { clients: 'clients.json', settings: 'settings.json', invoices: 'invoices.json' };
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() { try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (e) { return {}; } }
function writeConfig(cfg) { fs.mkdirSync(path.dirname(configPath()), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); }
function resolveDataDir() {
  return process.env.INVOICER_DATA || readConfig().dataDir || path.join(app.getPath('documents'), 'Invoicer');
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
    dialog.showErrorBox('Invoicer: could not read data',
      `${file(name)} is not valid JSON:\n\n${e.message}\n\nFix the file (or delete it to start fresh) and reopen Invoicer.`);
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
    title: 'Invoicer',
    autoHideMenuBar: true,
    backgroundColor: '#f7f5ef',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      plugins: true, // built-in PDF viewer for the live preview
    },
  });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  // With reminders on, closing the window keeps Invoicer running in the tray.
  win.on('close', e => {
    if (quitting || !remindersOn()) return;
    e.preventDefault();
    win.hide();
    const state = readReminderState();
    if (!state.trayHintShown && tray) {
      tray.displayBalloon({ title: 'Invoicer is still running', content: "It'll remind you when it's time to invoice. Right-click the tray icon to quit.", iconType: 'info' });
      writeReminderState({ ...state, trayHintShown: true });
    }
  });
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
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
  return true;
});

// Errors are returned as { error } so the UI gets a clean message instead of an IPC stack.
const safe = fn => async (...args) => { try { return await fn(...args); } catch (e) { return { error: e.message || String(e) }; } };
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

// ---------- Google Drive backups ----------
// Google Drive for desktop shows your Drive as a "My Drive" folder (usually G:\My Drive,
// or %USERPROFILE%\My Drive in mirror mode) and syncs it online. Invoicer copies every
// saved invoice into "My Drive\Invoicer Backups", or into a folder you pick yourself.
const BACKUP_FOLDER = 'Invoicer Backups';
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } };
function findMyDrive() {
  if (process.env.INVOICER_MYDRIVE) return isDir(process.env.INVOICER_MYDRIVE) ? process.env.INVOICER_MYDRIVE : null;
  const candidates = [...'GDEFHIJKLMNOPQRSTUVWXYZ'].map(l => `${l}:\\My Drive`);
  candidates.push(path.join(os.homedir(), 'My Drive'));
  return candidates.find(isDir) || null;
}
// The folder to back up to: the user's choice, else My Drive\Invoicer Backups.
function backupTarget(chosen) {
  const myDrive = findMyDrive();
  const dir = chosen || (myDrive ? path.join(myDrive, BACKUP_FOLDER) : null);
  return { myDrive, dir, auto: !chosen, ready: !!dir && (isDir(dir) || isDir(path.dirname(dir))) };
}
ipcMain.handle('backup:status', (_e, chosen) => backupTarget(chosen));
// Backups mirror the client folders: <backup folder>\<Client>\<file>.
ipcMain.handle('backup:write', safe((_e, bytes, name, chosen, client) => {
  const t = backupTarget(chosen);
  if (!t.dir) throw new Error("Google Drive for desktop isn't installed or signed in");
  // Create "Invoicer Backups" inside an existing folder, but never invent the drive itself:
  // a missing parent usually means Google Drive isn't running.
  if (!isDir(t.dir)) {
    if (!isDir(path.dirname(t.dir))) throw new Error(`Can't reach ${t.dir}. Is Google Drive running?`);
    fs.mkdirSync(t.dir);
  }
  const sub = path.join(t.dir, folderName(client));
  fs.mkdirSync(sub, { recursive: true });
  const dest = path.join(sub, name);
  fs.writeFileSync(dest, Buffer.from(bytes));
  return { path: dest };
}));
ipcMain.handle('backup:chooseDir', async (_e, current) => {
  const t = backupTarget(current);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose where invoice backups go',
    defaultPath: t.dir && isDir(t.dir) ? t.dir : (t.myDrive || app.getPath('documents')),
    properties: ['openDirectory', 'createDirectory'],
  });
  return canceled || !filePaths[0] ? null : filePaths[0];
});
ipcMain.handle('backup:open', safe((_e, chosen) => {
  const t = backupTarget(chosen);
  if (!t.dir || !isDir(t.dir)) throw new Error('The backup folder will be created when you save your first invoice.');
  return shell.openPath(t.dir);
}));
ipcMain.handle('shell:external', (_e, url) => {
  if (url === 'https://www.google.com/drive/download/') return shell.openExternal(url);
});

// Switch data folder. If the chosen folder already has Invoicer data, use it;
// otherwise copy the current files there. Returns the new folder or null.
ipcMain.handle('data:chooseDir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Choose where Invoicer keeps its data',
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
      message: 'That folder already has Invoicer data.',
      detail: 'Invoicer will switch to the clients and history in that folder. Your current folder is left untouched.',
    });
    if (response !== 0) return null;
  } else {
    fs.mkdirSync(target, { recursive: true });
    for (const f of Object.values(FILES)) {
      const src = path.join(DATA_DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(target, f));
    }
  }
  writeConfig({ ...readConfig(), dataDir: target });
  DATA_DIR = target;
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
  try {
    const info = JSON.parse(fs.readFileSync(path.join(updatesDir(), 'latest.json'), 'utf8'));
    const installer = path.join(updatesDir(), path.basename(info.file || ''));
    if (compareVersions(info.version, app.getVersion()) > 0 && fs.existsSync(installer)) {
      return { version: info.version, notes: info.notes || '', installer };
    }
  } catch (e) { /* no updates folder yet, or unreadable: nothing to offer */ }
  return null;
}
ipcMain.handle('update:check', () => {
  if (!app.isPackaged && !process.env.INVOICER_UPDATE_TEST) return null; // `npm start` is always current
  const u = findUpdate();
  return u && { version: u.version, notes: u.notes, current: app.getVersion() };
});
ipcMain.handle('update:install', () => {
  const u = findUpdate();
  if (!u) return false;
  // Copy out of OneDrive first (makes sure it's downloaded and not locked), then run it silently.
  const tmp = path.join(os.tmpdir(), path.basename(u.installer));
  fs.copyFileSync(u.installer, tmp);
  spawn(tmp, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 300);
  return true;
});

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
const remindersOn = () => !!DATA_DIR && (readQuiet('clients') || []).some(c => c.reminderDay);

function reminderDate(day, y, m) {
  const last = new Date(y, m + 1, 0);
  if (day === 'last') { while (last.getDay() === 0 || last.getDay() === 6) last.setDate(last.getDate() - 1); return last; }
  const n = parseInt(day, 10);
  return n ? new Date(y, m, Math.min(n, last.getDate())) : null;
}
// Clients whose reminder for this month has come and who haven't been invoiced (or skipped) since.
function dueReminders(at = now()) {
  if (!DATA_DIR) return [];
  const clients = readQuiet('clients') || [], invoices = readQuiet('invoices') || [];
  const skipped = readReminderState().skipped || {};
  const today = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  return clients.flatMap(c => {
    const d = reminderDate(c.reminderDay, at.getFullYear(), at.getMonth());
    if (!d || d > today || skipped[c.id] === ymd(d)) return [];
    const since = new Date(d); since.setDate(since.getDate() - 7);
    const invoiced = invoices.some(h => h.c && h.c.id === c.id && new Date(h.savedAt) >= since);
    return invoiced ? [] : [{ id: c.id, company: c.company || 'a client', date: ymd(d) }];
  });
}

const shown = []; // keep notifications referenced so their click handlers still work
function notify(r) {
  if (process.env.INVOICER_NOTIFY_LOG) fs.appendFileSync(process.env.INVOICER_NOTIFY_LOG, JSON.stringify(r) + '\n');
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `Time to invoice ${r.company}`, body: 'Click to start the invoice.', icon: ICON });
  n.on('click', () => { showWindow(); win && win.webContents.send('reminder:open', r.id); });
  n.on('close', () => shown.splice(shown.indexOf(n), 1));
  shown.push(n);
  n.show();
}
// Shows each due reminder at most once a day, from 9am.
function checkReminders() {
  const at = now();
  const due = dueReminders(at);
  if (win) win.webContents.send('reminders', due);
  if (at.getHours() < 9) return;
  const state = readReminderState(), notified = state.notified || {};
  const fresh = due.filter(r => notified[r.id] !== ymd(at));
  if (!fresh.length) return;
  fresh.forEach(r => { notified[r.id] = ymd(at); notify(r); });
  writeReminderState({ ...readReminderState(), notified });
}
// Called whenever clients or invoices are saved: refresh the in-app bars and start-with-Windows.
function remindersChanged() {
  if (win) win.webContents.send('reminders', dueReminders());
  if (app.isPackaged) {
    const on = remindersOn();
    if (app.getLoginItemSettings().openAtLogin !== on) app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  }
}
ipcMain.handle('reminders:due', () => dueReminders());
ipcMain.handle('reminders:skip', (_e, id) => {
  const r = dueReminders().find(x => x.id === id);
  if (r) { const s = readReminderState(); writeReminderState({ ...s, skipped: { ...(s.skipped || {}), [id]: r.date } }); }
  return dueReminders();
});

let tray, quitting = false;
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Invoicer');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Invoicer', click: showWindow },
    { type: 'separator' },
    { label: 'Quit Invoicer', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.whenReady().then(() => {
  DATA_DIR = resolveDataDir();
  // Started by Windows at sign-in: stay in the tray until a reminder (or you) opens the window.
  createWindow(!process.argv.includes('--hidden'));
  createTray();
  remindersChanged();
  win.webContents.once('did-finish-load', () => setTimeout(checkReminders, 3000));
  setInterval(checkReminders, 15 * 60 * 1000);
  powerMonitor.on('resume', checkReminders);
  powerMonitor.on('unlock-screen', checkReminders);
});
app.on('window-all-closed', () => app.quit());
