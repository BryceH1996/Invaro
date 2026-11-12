const { app, BrowserWindow, ipcMain, dialog, shell, Notification, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
app.setName('Invoicer');
// Tests run with their own profile so they never clash with the installed app.
if (process.env.INVOICER_PROFILE) app.setPath('userData', process.env.INVOICER_PROFILE);
// Started by Windows Task Scheduler to check reminders: no window unless a notification is clicked.
// (--hidden came from 1.6.0's start-with-Windows entry, which is removed on start.)
const CHECK_ONLY = process.argv.includes('--check-reminders') || process.argv.includes('--hidden');
// One copy at a time: starting Invoicer again shows the open window (or just runs the check).
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
  win.on('closed', () => { win = null; });
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
  syncReminderTask(); // the other folder's clients may have different reminders
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
    const inv = invoices.find(h => h.c && h.c.id === c.id && new Date(h.savedAt) >= since);
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
function notify(r) {
  if (process.env.INVOICER_NOTIFY_LOG) fs.appendFileSync(process.env.INVOICER_NOTIFY_LOG, JSON.stringify(r) + '\n');
  if (!Notification.isSupported()) return;
  // timeoutType 'never' keeps it on screen until you click or dismiss it.
  const n = new Notification({ title: `Time to invoice ${r.company}`, body: 'Click to start the invoice.', icon: ICON, timeoutType: 'never' });
  const done = () => { shown.delete(n); quitIfIdle(); };
  n.on('click', () => { openReminder(r.id); done(); });
  n.on('close', done);
  shown.add(n);
  n.show();
}
// Shows each due reminder at most once a day, from 9am. Returns how many were shown.
function checkReminders() {
  const at = now();
  const due = dueReminders(at);
  if (win) win.webContents.send('reminders', due);
  if (at.getHours() < 9) return 0;
  const state = readReminderState(), notified = state.notified || {};
  const fresh = due.filter(r => notified[r.id] !== ymd(at));
  if (!fresh.length) return 0;
  fresh.forEach(r => { notified[r.id] = ymd(at); notify(r); });
  writeReminderState({ ...readReminderState(), notified });
  return fresh.length;
}
// A check-only run quits once there's no window and no notification waiting to be clicked.
function quitIfIdle() { if (CHECK_ONLY && !win && !shown.size) app.quit(); }

// ---------- Windows Task Scheduler ----------
// While any client has a reminder, a scheduled task runs "Invoicer --check-reminders" every
// day at 9am (or as soon as the PC is on and you're signed in, if it was off at 9). With no
// reminders left, the task is deleted. The uninstaller deletes it too (build/installer.nsh).
const TASK = process.env.INVOICER_TASK_NAME || 'Invoicer reminders';
const taskEnabled = () => app.isPackaged || !!process.env.INVOICER_TASK_NAME;
const schtasks = args => new Promise(resolve =>
  execFile('schtasks.exe', args, { windowsHide: true }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || stderr || (err && err.message) || '') })));
const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function taskXml() {
  // In development the exe is electron.exe, which needs the app folder as its first argument.
  const args = (app.isPackaged ? '' : `"${app.getAppPath()}" `) + '--check-reminders';
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Shows Invoicer's invoice reminders. Created by Invoicer and deleted when no client has a reminder.</Description></RegistrationInfo>
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
}
let taskSync = Promise.resolve();
// Creates or deletes the task to match the clients. `verify` also asks Windows whether the task
// exists (on start-up, in case it was deleted by hand); otherwise the last result is trusted.
function syncReminderTask(verify) {
  if (!taskEnabled()) return taskSync;
  taskSync = taskSync.then(async () => {
    const want = remindersOn() ? process.execPath : null;
    let have = readReminderState().task || null;
    if (verify) {
      const q = await schtasks(['/query', '/tn', TASK]);
      if (!q.ok) have = null;
      else if (!have) have = 'unknown'; // exists, but not one we recorded: rewrite or delete it
    }
    if (want === have) return;
    if (want) {
      const xmlFile = path.join(os.tmpdir(), `invoicer-task-${process.pid}.xml`);
      fs.writeFileSync(xmlFile, Buffer.from('﻿' + taskXml(), 'utf16le'));
      const r = await schtasks(['/create', '/tn', TASK, '/xml', xmlFile, '/f']);
      fs.rmSync(xmlFile, { force: true });
      if (!r.ok) { console.error('Could not create the reminder task:', r.out); return; }
    } else {
      const r = await schtasks(['/delete', '/tn', TASK, '/f']);
      if (!r.ok) { console.error('Could not delete the reminder task:', r.out); return; }
    }
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
// Whether the Windows scheduled task is there, and when it runs next.
ipcMain.handle('reminders:task', async () => {
  if (!taskEnabled()) return { enabled: false };
  await syncReminderTask(true); // finish any pending change, and put the task back if it went missing
  const q = await schtasks(['/query', '/tn', TASK, '/fo', 'list', '/v']);
  if (!q.ok) return { enabled: true, exists: false };
  const field = name => (q.out.match(new RegExp('^' + name + ':\\s*(.+)$', 'mi')) || [])[1];
  return { enabled: true, exists: true, nextRun: field('Next Run Time'), lastRun: field('Last Run Time') };
});
ipcMain.handle('reminders:test', () => {
  if (!Notification.isSupported()) return { error: "This version of Windows doesn't support notifications." };
  new Notification({ title: 'Invoicer reminders are working', body: "This is how you'll be reminded to invoice a client.", icon: ICON }).show();
  return {};
});
ipcMain.handle('reminders:takeOpen', () => { const id = pendingOpen; pendingOpen = null; return id; });
ipcMain.handle('reminders:skip', (_e, id) => {
  const r = dueReminders().find(x => x.id === id);
  if (r) { const s = readReminderState(); writeReminderState({ ...s, skipped: { ...(s.skipped || {}), [id]: r.date } }); }
  return dueReminders();
});

// Starting Invoicer while it's already running: a scheduled check just re-checks, anything else shows the window.
app.on('second-instance', (_e, argv) => {
  if (argv.includes('--check-reminders')) checkReminders(); else showWindow();
});
app.whenReady().then(async () => {
  DATA_DIR = resolveDataDir();
  // 1.6.0 started Invoicer with Windows to sit in the tray; the scheduled task replaces that.
  if (app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin) app.setLoginItemSettings({ openAtLogin: false, args: ['--hidden'] });
  if (CHECK_ONLY) {
    await syncReminderTask(true);
    if (!checkReminders()) return app.quit();
    // Wait for a click, but no longer than the task's own 12-hour limit.
    setTimeout(() => app.quit(), 12 * 60 * 60 * 1000);
    return;
  }
  createWindow(true);
  syncReminderTask(true);
  win.webContents.once('did-finish-load', () => setTimeout(checkReminders, 3000));
  setInterval(checkReminders, 15 * 60 * 1000);
  powerMonitor.on('resume', checkReminders);
  powerMonitor.on('unlock-screen', checkReminders);
});
// A check-only run stays up without a window while a notification is waiting to be clicked.
app.on('window-all-closed', () => { if (!CHECK_ONLY || !shown.size) app.quit(); });
