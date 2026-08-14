/**
 * DSH Desktop — preload 安全桥（contextIsolation 开启）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  onWebStatus: (cb) => ipcRenderer.on('web:status', (_e, s) => cb(s)),
  retry: () => ipcRenderer.send('web:retry'),
});
