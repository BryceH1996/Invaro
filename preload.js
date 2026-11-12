const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (name, value) => ipcRenderer.invoke('data:save', name, value),
  savePdf: (bytes, defaultName, dir) => ipcRenderer.invoke('pdf:save', bytes, defaultName, dir),
  open: p => ipcRenderer.invoke('shell:open', p),
  showInFolder: p => ipcRenderer.invoke('shell:show', p),
  openDataDir: () => ipcRenderer.invoke('shell:dataDir'),
  chooseDataDir: () => ipcRenderer.invoke('data:chooseDir'),
  driveStatus: () => ipcRenderer.invoke('drive:status'),
  driveConnect: (clientId, secret) => ipcRenderer.invoke('drive:connect', clientId, secret),
  driveDisconnect: () => ipcRenderer.invoke('drive:disconnect'),
  driveUpload: (bytes, name) => ipcRenderer.invoke('drive:upload', bytes, name),
  driveOpenFolder: () => ipcRenderer.invoke('drive:openFolder'),
  openExternal: url => ipcRenderer.invoke('shell:external', url),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  version: () => ipcRenderer.invoke('app:version'),
});
