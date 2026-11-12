const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

app.setName('Invoicer');

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
function createWindow() {
  win = new BrowserWindow({
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
  return true;
});

ipcMain.handle('pdf:save', async (_e, bytes, defaultName, dir) => {
  const startDir = dir && fs.existsSync(dir) ? dir : app.getPath('documents');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save invoice',
    defaultPath: path.join(startDir, defaultName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, Buffer.from(bytes));
  return filePath;
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

app.whenReady().then(() => { DATA_DIR = resolveDataDir(); createWindow(); });
app.on('window-all-closed', () => app.quit());
