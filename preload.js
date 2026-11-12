const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (name, value) => ipcRenderer.invoke('data:save', name, value),
  savePdf: (bytes, defaultName, dir) => ipcRenderer.invoke('pdf:save', bytes, defaultName, dir),
  open: p => ipcRenderer.invoke('shell:open', p),
  showInFolder: p => ipcRenderer.invoke('shell:show', p),
  openDataDir: () => ipcRenderer.invoke('shell:dataDir'),
  chooseDataDir: () => ipcRenderer.invoke('data:chooseDir'),
  backupStatus: chosen => ipcRenderer.invoke('backup:status', chosen),
  backupWrite: (bytes, name, chosen) => ipcRenderer.invoke('backup:write', bytes, name, chosen),
  chooseBackupDir: current => ipcRenderer.invoke('backup:chooseDir', current),
  openBackupDir: chosen => ipcRenderer.invoke('backup:open', chosen),
  openExternal: url => ipcRenderer.invoke('shell:external', url),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  version: () => ipcRenderer.invoke('app:version'),
});
