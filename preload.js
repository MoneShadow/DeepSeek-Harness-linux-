/**
 * DSH Desktop — preload 安全桥（contextIsolation 开启，渲染进程只能走这里）
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  // 终端数据流
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, data) => cb(data)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, code) => cb(code)),
  onPtyStatus: (cb) => ipcRenderer.on('pty:status', (_e, s) => cb(s)),
  write: (data) => ipcRenderer.send('pty:write', data),
  resize: (cols, rows) => ipcRenderer.send('pty:resize', cols, rows),

  // 侧栏
  onSessions: (cb) => ipcRenderer.on('sessions:update', (_e, payload) => cb(payload)),
  newSession: () => ipcRenderer.send('session:new'),
  resumeSession: (id) => ipcRenderer.send('session:resume', id),

  // 剪贴板
  paste: () => ipcRenderer.send('clipboard:paste'),
});
