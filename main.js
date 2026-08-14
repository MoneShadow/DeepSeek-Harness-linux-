/**
 * DSH Desktop — Electron 主进程（v0.3：官方 Web UI + 自动更新）
 *
 * 架构：spawn `dsh --profile web --port 0`（随机端口，loopback 信任围栏），
 * 就绪后渲染进程 iframe 嵌入官方 UI（本进程持有顶栏/设置层）。
 *
 * 更新机制：查 npm 仓库 @deepseek-ai/dsh@next（与安装同标签）→ 版本对比 →
 * 停 Web 引擎 → `npm install -g @deepseek-ai/dsh@next` → 验证 → 重启引擎。
 * 自动检查：启动后 + 每 6 小时（可开关）；自动安装默认关（有新版时提示，一键安装）。
 *
 * 安全：导航锁定（仅 file:// 与 127.0.0.1）、同源弹窗放行、外部弹窗拒绝。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');

const HOMEDIR = os.homedir();
const WEB_READY_TIMEOUT_MS = 30000;
const UPDATE_CHECK_TIMEOUT_MS = 15000;
const UPDATE_INSTALL_TIMEOUT_MS = 300000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let win = null;
let webProc = null;
let webUrl = null;
let webReady = false;
let autoCheckTimer = null;

// ---------- dsh 可执行文件定位（桌面入口启动时 PATH 可能不含 ~/.local/bin） ----------
function resolveDsh() {
  const candidates = [
    path.join(HOMEDIR, '.local', 'bin', 'dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return 'dsh';
}
const DSH_BIN = resolveDsh();

// ============================================================================
// 设置持久化（userData/settings.json）
// ============================================================================
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return { autoCheck: true, autoInstall: false, lastCheck: 0, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { autoCheck: true, autoInstall: false, lastCheck: 0 };
  }
}
function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch { /* ignore */ }
  return s;
}

// ============================================================================
// 更新管理器
// ============================================================================
const update = {
  state: 'idle',        // idle | checking | update-available | up-to-date | installing | done | error
  current: '',
  latest: '',
  message: '',
  installing: false,
};

function sendUpdateStatus() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update:status', { ...update });
  }
}

// 版本对比："0.1.0-rc.6" vs "0.1.0-rc.7" / "0.1.0"（正式版高于同版本 rc）
function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function getLocalVersion() {
  return new Promise((resolve) => {
    execFile(DSH_BIN, ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve('');
      resolve(String(stdout).trim().split('\n')[0] || '');
    });
  });
}

function getRemoteVersion() {
  return new Promise((resolve) => {
    execFile('npm', ['view', '@deepseek-ai/dsh@next', 'version', '--json'], { timeout: UPDATE_CHECK_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve('');
      try {
        const v = JSON.parse(stdout.trim());
        resolve(String(Array.isArray(v) ? v[v.length - 1] : v).trim());
      } catch {
        resolve('');
      }
    });
  });
}

async function checkUpdate({ silent = false } = {}) {
  if (update.installing) return;
  update.state = 'checking';
  update.message = '';
  sendUpdateStatus();

  const [current, latest] = await Promise.all([getLocalVersion(), getRemoteVersion()]);
  update.current = current;
  update.latest = latest;

  if (!latest) {
    update.state = 'error';
    update.message = '无法连接 npm 仓库（网络异常或 npm 不可用）';
  } else if (compareVersions(latest, current) > 0) {
    update.state = 'update-available';
    update.message = `发现新版本 ${latest}（当前 ${current || '未知'}）`;
  } else {
    update.state = 'up-to-date';
    update.message = current ? `已是最新版本（${current}）` : '无法获取本地版本';
  }
  saveSettings({ lastCheck: Date.now() });
  sendUpdateStatus();
  return update;
}

async function installUpdate() {
  if (update.installing) return;
  if (update.state !== 'update-available') {
    // 手动强制安装（未检查过或已是最新时点击立即更新 → 先检查）
    const u = await checkUpdate({ silent: true });
    if (u.state !== 'update-available') return u;
  }
  update.installing = true;
  update.state = 'installing';
  update.message = `正在安装 ${update.latest}…（会短暂重启界面）`;
  sendUpdateStatus();

  // 先停 Web 引擎，避免更新文件时进程正在使用
  killWeb();

  await new Promise((resolve) => {
    const npm = spawn('npm', ['install', '-g', '@deepseek-ai/dsh@next'], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const push = (d) => {
      tail = (tail + String(d)).slice(-600);
      update.message = '正在安装…\n' + tail.trim().split('\n').slice(-2).join('\n');
      sendUpdateStatus();
    };
    npm.stdout.on('data', push);
    npm.stderr.on('data', push);
    const killer = setTimeout(() => { try { npm.kill('SIGKILL'); } catch { /* gone */ } }, UPDATE_INSTALL_TIMEOUT_MS);
    npm.on('exit', (code) => {
      clearTimeout(killer);
      resolve(code);
    });
    npm.on('error', (err) => resolve('ERR:' + err.message));
  }).then(async (code) => {
    const installed = await getLocalVersion();
    update.installing = false;
    update.current = installed;
    if (String(code).startsWith('ERR:')) {
      update.state = 'error';
      update.message = '安装失败：' + String(code).slice(4);
    } else if (code !== 0) {
      update.state = 'error';
      update.message = `安装失败（npm 退出码 ${code}）`;
    } else if (compareVersions(installed, update.latest) >= 0) {
      update.state = 'done';
      update.message = `更新完成，当前版本 ${installed}`;
    } else {
      update.state = 'error';
      update.message = `安装结束但版本未变（当前 ${installed}）`;
    }
    sendUpdateStatus();
    // 重启 Web 引擎，界面自动重连
    startWeb();
  });
}

// ============================================================================
// Web 引擎
// ============================================================================
function sendWebStatus(state) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('web:status', { state, url: webUrl });
  }
}

function startWeb() {
  if (webProc) return;
  webUrl = null;
  webReady = false;
  sendWebStatus('starting');
  webProc = spawn(
    DSH_BIN, ['--profile', 'web', '--host', '127.0.0.1', '--port', '0'],
    { cwd: HOMEDIR, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  webProc.stdout.on('data', (d) => {
    const m = String(d).match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m && !webUrl) {
      const port = Number(m[1]);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        webUrl = `http://127.0.0.1:${port}`;
        console.log('[web]', webUrl);
        pollWebReady();
      }
    }
  });
  webProc.stderr.on('data', () => { /* 不刷屏 */ });
  webProc.on('exit', () => {
    webProc = null;
    webUrl = null;
    webReady = false;
    sendWebStatus('stopped');
  });
}

function pollWebReady() {
  if (!webUrl) return;
  const deadline = Date.now() + WEB_READY_TIMEOUT_MS;
  const tick = () => {
    if (!webUrl || Date.now() > deadline) {
      sendWebStatus('timeout');
      return;
    }
    http.get(webUrl, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        webReady = true;
        sendWebStatus('ready');
        return;
      }
      setTimeout(tick, 400);
    }).on('error', () => setTimeout(tick, 400));
  };
  tick();
}

function killWeb() {
  if (!webProc) return;
  const p = webProc;
  webProc = null;
  // web 服务实测忽略 SIGTERM，直接 SIGKILL
  try { p.kill('SIGKILL'); } catch { /* gone */ }
}

// ============================================================================
// 窗口
// ============================================================================
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'DSH Desktop',
    backgroundColor: '#111418',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  win.on('close', () => killWeb());

  // 导航锁定：仅放行本地页面与 127.0.0.1 官方 UI
  win.webContents.on('will-navigate', (e, url) => {
    const ok = url.startsWith('file://')
      || (webUrl && url.startsWith(webUrl));
    if (!ok) e.preventDefault();
  });
  // 同源弹窗放行（官方 UI 内部链接），其余拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (webUrl && url.startsWith(webUrl)) return { action: 'allow' };
    return { action: 'deny' };
  });
  // 固定窗口标题为应用名
  win.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
    win.setTitle('DSH Desktop');
  });
}

// ============================================================================
// IPC
// ============================================================================
ipcMain.handle('app:info', () => ({ version: app.getVersion(), dshPath: DSH_BIN }));
ipcMain.handle('web:get-state', () => ({ state: webReady ? 'ready' : (webProc ? 'starting' : 'stopped'), url: webUrl }));
ipcMain.on('web:retry', () => {
  killWeb();
  startWeb();
});
ipcMain.on('update:check', (_e, silent) => checkUpdate({ silent: !!silent }));
ipcMain.handle('update:install', () => installUpdate());
ipcMain.handle('update:get-state', () => update);
ipcMain.on('update:set-auto-check', (_e, v) => saveSettings({ autoCheck: !!v }));
ipcMain.on('update:set-auto-install', (_e, v) => saveSettings({ autoInstall: !!v }));

// ============================================================================
// 自检截图（DSH_DESKTOP_SELFCHECK=1）
// ============================================================================
function maybeSelfcheck() {
  if (process.env.DSH_DESKTOP_SELFCHECK !== '1') return;
  const shotDir = path.join(app.getPath('userData'), 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  const diagLog = path.join(shotDir, 'diag.log');
  const log = (msg) => {
    console.log(msg);
    try { fs.appendFileSync(diagLog, msg + '\n'); } catch { /* ignore */ }
  };
  const snap = (label) => {
    if (!win || win.isDestroyed()) return;
    win.capturePage().then((img) => {
      const file = path.join(shotDir, `selfcheck-${label}-${Date.now()}.png`);
      fs.writeFileSync(file, img.toPNG());
      log(`[selfcheck] saved ${file}`);
    }).catch((err) => log('[selfcheck] capture failed: ' + err.message));
  };
  const diag = (label) => {
    // 用 webFrameMain 直接读 iframe 子帧（跨域安全模型允许主进程这么做）
    let frameReport = [];
    try {
      for (const f of win.webContents.mainFrame.frames) {
        const info = { url: f.url, title: f.title };
        if (f.url.startsWith('http://127.0.0.1')) {
          f.executeJavaScript('document.body ? document.body.innerText.slice(0, 300) : "(无 body)"')
            .then((txt) => log('[iframe-text] ' + label + ' :: ' + JSON.stringify(txt)))
            .catch(() => log('[iframe-text] ' + label + ' :: (读取失败)'));
        }
        frameReport.push(info);
      }
    } catch (e) {
      frameReport = '(frames 枚举失败: ' + e.message + ')';
    }
    log('[diag] ' + label + ' frames: ' + JSON.stringify(frameReport));
    win.webContents.executeJavaScript(`(() => {
      document.getElementById('btn-settings').click();
      return document.getElementById('settings-panel').hidden ? '面板未打开' : '面板已打开';
    })()`)
      .then((r) => log('[diag] ' + label + ' panel: ' + r))
      .catch((e) => log('[diag err] ' + e.message));
    setTimeout(() => snap(label), 400); // 等一帧再截图，避免捕获到面板打开前的画面
  };
  setTimeout(() => diag('web1'), 10000);
  setTimeout(() => {
    log('[update-state] ' + JSON.stringify(update));
    diag('web2');
  }, 18000);
}

// ============================================================================
// 启动
// ============================================================================
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.whenReady().then(async () => {
  createWindow();
  startWeb();
  maybeSelfcheck();

  // 更新管理器初始化 + 自动检查
  const settings = loadSettings();
  update.current = await getLocalVersion();
  if (settings.autoCheck) {
    setTimeout(() => checkUpdate(), 8000);
    autoCheckTimer = setInterval(() => checkUpdate(), AUTO_CHECK_INTERVAL_MS);
  }
  sendUpdateStatus();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  clearInterval(autoCheckTimer);
  app.quit();
});
