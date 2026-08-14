/**
 * DSH Desktop — Electron 主进程（v0.3：纯官方 Web UI，无终端）
 *
 * 架构：spawn `dsh --profile web --port 0`（随机端口，loopback 信任围栏），
 * 就绪后 BrowserWindow 直接 loadURL 官方 UI。窗口加载期间显示本地启动页。
 *
 * 安全：导航锁定（仅 file:// 启动页与 127.0.0.1 官方 UI）、同源弹窗放行、
 * 外部弹窗拒绝、页面标题固定为应用名。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const HOMEDIR = os.homedir();
const WEB_READY_TIMEOUT_MS = 30000;
const WEB_LOAD_TIMEOUT_MS = 30000;

let win = null;
let webProc = null;
let webUrl = null;
let loaded = false;

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

function sendStatus(state) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('web:status', { state });
  }
}

// ============================================================================
// Web 引擎
// ============================================================================
function startWeb() {
  if (webProc) return;
  webUrl = null;
  loaded = false;
  sendStatus('starting');
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
    loaded = false;
    sendStatus('stopped');
  });
}

function pollWebReady() {
  if (!webUrl) return;
  const deadline = Date.now() + WEB_READY_TIMEOUT_MS;
  const tick = () => {
    if (!webUrl || Date.now() > deadline) {
      sendStatus('timeout');
      return;
    }
    http.get(webUrl, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        loadApp();
        return;
      }
      setTimeout(tick, 400);
    }).on('error', () => setTimeout(tick, 400));
  };
  tick();
}

function loadApp() {
  if (loaded || !win || win.isDestroyed() || !webUrl) return;
  loaded = true;
  sendStatus('ready');
  win.loadURL(webUrl);
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
  // 启动页（本地），Web 就绪后 loadURL 官方 UI
  win.loadFile(path.join(__dirname, 'renderer', 'loading.html'));
  win.on('closed', () => { win = null; });
  win.on('close', () => killWeb());

  // 导航锁定：仅放行本地启动页与 127.0.0.1 官方 UI
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
ipcMain.on('web:retry', () => {
  killWeb();
  startWeb();
});

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
    win.webContents.executeJavaScript(`(() => {
      const txt = document.body ? document.body.innerText.slice(0, 600) : '(无 body)';
      const url = location.href;
      const title = document.title;
      return JSON.stringify({ label: ${JSON.stringify(label)}, url, title, txt });
    })()`)
      .then((r) => log('[diag] ' + r))
      .catch((e) => log('[diag err] ' + e.message));
  };
  setTimeout(() => { diag('web1'); snap('web1'); }, 10000);
  setTimeout(() => { diag('web2'); snap('web2'); }, 18000);
}

// ============================================================================
// 启动
// ============================================================================
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.whenReady().then(() => {
  createWindow();
  startWeb();
  maybeSelfcheck();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
