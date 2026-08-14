/**
 * DSH Desktop — preload 安全桥（contextIsolation 开启）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  // 应用信息
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  // Web 引擎状态
  onWebStatus: (cb) => ipcRenderer.on('web:status', (_e, s) => cb(s)),
  getWebState: () => ipcRenderer.invoke('web:get-state'),
  retry: () => ipcRenderer.send('web:retry'),
  getWebLog: () => ipcRenderer.invoke('web:get-log'),

  // 更新管理
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, s) => cb(s)),
  checkUpdate: (silent) => ipcRenderer.send('update:check', !!silent),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  setAutoCheck: (v) => ipcRenderer.send('update:set-auto-check', !!v),
  setAutoInstall: (v) => ipcRenderer.send('update:set-auto-install', !!v),
  setChannel: (c) => ipcRenderer.send('update:set-channel', c),
});
