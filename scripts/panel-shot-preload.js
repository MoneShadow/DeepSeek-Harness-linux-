/**
 * 截图工具 mock preload：给 renderer 提供假数据（不连真实引擎）
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  getAppInfo: () => Promise.resolve({ version: '0.4.0', dshPath: '/home/mone/.local/bin/dsh' }),
  onWebStatus: () => {},
  getWebState: () => Promise.resolve({ state: 'ready', url: 'http://127.0.0.1:1' }),
  retry: () => {},
  getWebLog: () => Promise.resolve({ lines: [
    '[10:00:01] web: dsh web: http://127.0.0.1:41341',
    '[10:00:02] web: URL=http://127.0.0.1:41341',
    '[10:00:20] vision: 配置已保存（enabled=true model=gpt-4o-mini）',
  ] }),
  onUpdateStatus: () => {},
  checkUpdate: () => {},
  installUpdate: () => Promise.resolve({}),
  getUpdateState: () => Promise.resolve({
    state: 'up-to-date', current: '0.1.0-rc.6', latest: '0.1.0-rc.6',
    message: '已是最新版本（0.1.0-rc.6）', installing: false,
    autoCheck: true, autoInstall: false, channel: 'next',
  }),
  setAutoCheck: () => {},
  setAutoInstall: () => {},
  setChannel: () => {},
  getVisionConfig: () => Promise.resolve({
    enabled: true, baseURL: 'https://api.openai.com/v1',
    apiKey: '(已设置)', model: 'gpt-4o-mini', timeoutMs: 60000,
  }),
  setVisionConfig: () => Promise.resolve({}),
});
