const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('starPunchDevice', {
  getMachine: () => ipcRenderer.invoke('device:machine'),
  getToken: () => ipcRenderer.invoke('device:get'),
  storeToken: token => ipcRenderer.invoke('device:store', token),
  clearToken: () => ipcRenderer.invoke('device:clear'),
  retry: () => ipcRenderer.invoke('device:retry')
});
