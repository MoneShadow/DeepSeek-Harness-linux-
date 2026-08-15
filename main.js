/**
 * DSH Desktop — Electron 主进程（v0.4：单实例 + 更新强化 + 引擎自愈）
 *
 * 架构：spawn `dsh --profile web --port 0`（随机端口，loopback 信任围栏），
 * 就绪后渲染进程 iframe 嵌入官方 UI（本进程持有顶栏/设置层）。
 *
 * 更新机制：查 npm 仓库 @deepseek-ai/dsh@<channel>（next/latest 可切换）→ 版本对比 →
 * 停 Web 引擎 → `npm install -g` → 验证 → 失败自动回滚旧版本 → 重启引擎。
 * 自动检查：启动后 + 每 6 小时（开关即时生效）；自动安装默认关（判定在 main 进程，
 * 避免渲染层状态不同步导致的竞态）。
 *
 * 稳定性：单实例锁（重复启动聚焦已有窗口）；Web 引擎意外退出自动重启（指数退避，
 * 上限 5 次）；引擎与 npm 输出进内存日志环（设置面板可查看）。
 *
 * 安全：导航锁定（仅 renderer/ 与 127.0.0.1 同源精确匹配，杜绝 startsWith 前缀绕过）、
 * 同源弹窗放行、外部弹窗拒绝。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { spawn, execFile } = require('node:child_process');
const { compareVersions, stripAnsi, sameLoopbackOrigin } = require('./lib/pure.js');
const { readVisionSettings, writeVisionSettings } = require('./lib/vision-settings.js');

const HOMEDIR = os.homedir();
const WEB_READY_TIMEOUT_MS = 30000;
const UPDATE_CHECK_TIMEOUT_MS = 15000;
const UPDATE_INSTALL_TIMEOUT_MS = 300000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_RESTART_ATTEMPTS = 5;   // 引擎意外退出自动重启上限（指数退避）
const LOG_MAX = 400;              // 内存日志环行数上限

let win = null;
let webProc = null;
let webUrl = null;
let webReady = false;
let webIntentionalStop = false;   // killWeb() 主动停止标记（不触发自动重启）
let restartTimer = null;
let restartAttempts = 0;
let autoCheckTimer = null;
const logRing = [];               // 引擎/npm 输出日志环（设置面板可查）

// ---------- 可执行文件定位（桌面入口启动时 PATH 可能不含 ~/.local/bin，须显式定位） ----------
function resolveBin(candidates, fallback) {
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch { /* next */ }
  }
  return fallback;
}
const DSH_BIN = resolveBin([
  path.join(HOMEDIR, '.local', 'bin', 'dsh'),
  '/usr/local/bin/dsh',
  '/usr/bin/dsh',
], 'dsh');
const NPM_BIN = resolveBin([
  path.join(HOMEDIR, '.local', 'bin', 'npm'),
  '/usr/local/bin/npm',
  '/usr/bin/npm',
], 'npm');

// ---------- 内存日志环 ----------
function ringLog(tag, text) {
  if (!text) return;
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    logRing.push(`[${t}] ${tag}: ${line}`);
  }
  if (logRing.length > LOG_MAX) logRing.splice(0, logRing.length - LOG_MAX);
}

// 视觉助手配置读写见 lib/vision-settings.js（行级手术，引擎热更新）


// ============================================================================
// 设置持久化（userData/settings.json）
// ============================================================================
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return { autoCheck: true, autoInstall: false, channel: 'next', lastCheck: 0, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { autoCheck: true, autoInstall: false, channel: 'next', lastCheck: 0 };
  }
}
function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  try { fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch { /* ignore */ }
  return s;
}
/** 把设置同步进 update 状态对象，随 update:status 一起回传渲染层（此前渲染层永远拿不到） */
function syncSettingsToUpdate() {
  const s = loadSettings();
  update.autoCheck = s.autoCheck !== false;
  update.autoInstall = !!s.autoInstall;
  update.channel = s.channel === 'latest' ? 'latest' : 'next';
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
  autoCheck: true,
  autoInstall: false,
  channel: 'next',
};

function sendUpdateStatus() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('update:status', { ...update });
  }
}

function getLocalVersion() {
  return new Promise((resolve) => {
    execFile(DSH_BIN, ['--version'], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve('');
      resolve(String(stdout).trim().split('\n')[0] || '');
    });
  });
}

function getRemoteVersion(channel) {
  return new Promise((resolve) => {
    execFile(NPM_BIN, ['view', `@deepseek-ai/dsh@${channel}`, 'version', '--json'], { timeout: UPDATE_CHECK_TIMEOUT_MS }, (err, stdout) => {
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
  if (update.installing) return update;
  update.state = 'checking';
  update.message = '';
  sendUpdateStatus();

  const [current, latest] = await Promise.all([getLocalVersion(), getRemoteVersion(update.channel)]);
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
  maybeAutoInstall();
  return update;
}

/** 自动安装判定放在 main 进程（渲染层只负责展示，避免状态不同步） */
function maybeAutoInstall() {
  if (update.installing) return;
  if (update.state !== 'update-available') return;
  if (!loadSettings().autoInstall) return;
  installUpdate();
}

/** 执行 `npm install -g <spec>`，返回 { code, tail }；输出进日志环并实时回传界面 */
function npmInstall(spec) {
  return new Promise((resolve) => {
    const npm = spawn(NPM_BIN, ['install', '-g', spec], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const push = (d) => {
      const txt = stripAnsi(d);
      ringLog('npm', txt);
      tail = (tail + txt).slice(-600);
      update.message = '正在安装…\n' + tail.trim().split('\n').slice(-2).join('\n');
      sendUpdateStatus();
    };
    npm.stdout.on('data', push);
    npm.stderr.on('data', push);
    const killer = setTimeout(() => { try { npm.kill('SIGKILL'); } catch { /* gone */ } }, UPDATE_INSTALL_TIMEOUT_MS);
    npm.on('exit', (code) => {
      clearTimeout(killer);
      resolve({ code, tail: tail.trim() });
    });
    npm.on('error', (err) => resolve({ code: 'ERR:' + err.message, tail: '' }));
  });
}

async function installUpdate() {
  if (update.installing) return update;
  if (update.state !== 'update-available') {
    // 手动强制安装（未检查过或已是最新时点击立即更新 → 先检查）
    const u = await checkUpdate({ silent: true });
    if (u.state !== 'update-available') return u;
    if (update.installing) return update; // 自动安装路径已接管
  }
  const oldVersion = update.current || '';
  const channel = update.channel || 'next';
  update.installing = true;
  update.state = 'installing';
  update.message = `正在安装 ${update.latest}…（会短暂重启界面）`;
  sendUpdateStatus();

  // 先停 Web 引擎，避免更新文件时进程正在使用（标记为主动停止，不触发自动重启）
  killWeb();

  const res = await npmInstall(`@deepseek-ai/dsh@${channel}`);
  const installed = await getLocalVersion();
  const ok = res.code === 0 && compareVersions(installed, update.latest) >= 0;

  if (ok) {
    update.installing = false;
    update.current = installed;
    update.state = 'done';
    update.message = `更新完成，当前版本 ${installed}`;
  } else {
    const reason = String(res.code).startsWith('ERR:')
      ? String(res.code).slice(4)
      : (res.code === 0 ? '版本未变更' : `npm 退出码 ${res.code}`);
    // 回滚：仅当安装结果与旧版本不一致（可能半损坏）时重装旧版
    let rollbackMsg = '';
    let rbVer = '';
    if (oldVersion && installed !== oldVersion) {
      update.message = `安装失败（${reason}），正在回滚到 ${oldVersion}…`;
      sendUpdateStatus();
      const rb = await npmInstall(`@deepseek-ai/dsh@${oldVersion}`);
      rbVer = await getLocalVersion();
      if (rb.code === 0 && rbVer && compareVersions(rbVer, oldVersion) >= 0) {
        rollbackMsg = `已回滚到 ${rbVer}`;
      } else {
        rollbackMsg = `回滚失败（npm 退出码 ${rb.code}），请手动执行：npm install -g @deepseek-ai/dsh@${oldVersion}`;
      }
    }
    update.installing = false;
    update.current = rbVer || installed || oldVersion;
    update.state = 'error';
    update.message = `安装失败：${reason}。${rollbackMsg || '本地版本未受影响。'}`;
  }
  sendUpdateStatus();
  // 无论成败都重启引擎（旧版本可用则回到旧版本，界面自动重连）
  startWeb();
  return update;
}

// ============================================================================
// Web 引擎（带意外退出自动重启：指数退避 1s/2s/4s/8s/16s，上限 5 次）
// ============================================================================
function sendWebStatus(state) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('web:status', { state, url: webUrl });
  }
}

function startWeb() {
  if (webProc) return;
  clearTimeout(restartTimer);
  restartTimer = null;
  webUrl = null;
  webReady = false;
  sendWebStatus('starting');
  webProc = spawn(
    DSH_BIN, ['--profile', 'web', '--host', '127.0.0.1', '--port', '0'],
    { cwd: HOMEDIR, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  webProc.stdout.on('data', (d) => {
    const txt = stripAnsi(d);
    ringLog('web', txt);
    const m = txt.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m && !webUrl) {
      const port = Number(m[1]);
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        webUrl = `http://127.0.0.1:${port}`;
        console.log('[web]', webUrl);
        ringLog('web', `URL=${webUrl}`);
        pollWebReady();
      }
    }
  });
  webProc.stderr.on('data', (d) => ringLog('web', stripAnsi(d)));
  webProc.on('exit', (code, signal) => {
    const wasIntentional = webIntentionalStop;
    webIntentionalStop = false;
    webProc = null;
    webUrl = null;
    webReady = false;
    ringLog('web', `进程退出 code=${code} signal=${signal}${wasIntentional ? '（主动停止）' : ''}`);
    if (wasIntentional) {
      sendWebStatus('stopped');
      return;
    }
    scheduleWebRestart();
  });
}

function scheduleWebRestart() {
  restartAttempts += 1;
  if (restartAttempts > MAX_RESTART_ATTEMPTS) {
    ringLog('web', `自动重启超过 ${MAX_RESTART_ATTEMPTS} 次，放弃（可点“重新连接”手动恢复）`);
    sendWebStatus('failed');
    return;
  }
  const delay = Math.min(1000 * 2 ** (restartAttempts - 1), 30000);
  ringLog('web', `异常退出，${delay}ms 后自动重启（第 ${restartAttempts}/${MAX_RESTART_ATTEMPTS} 次）`);
  sendWebStatus('restarting');
  restartTimer = setTimeout(() => { restartTimer = null; startWeb(); }, delay);
}

function pollWebReady() {
  if (!webUrl) return;
  const deadline = Date.now() + WEB_READY_TIMEOUT_MS;
  const tick = () => {
    if (!webUrl || Date.now() > deadline) {
      sendWebStatus('timeout');
      return;
    }
    const req = http.get(webUrl, (res) => {
      res.resume();
      if (res.statusCode === 200) {
        webReady = true;
        restartAttempts = 0; // 恢复成功，重置重启计数
        sendWebStatus('ready');
        setTimeout(() => { patchClipboardInFrames(); patchPasteInFrames(); }, 300); // iframe 加载后注入补丁
        return;
      }
      setTimeout(tick, 400);
    });
    req.setTimeout(5000, () => req.destroy()); // 防挂起：5s 无响应视为失败继续轮询
    req.on('error', () => setTimeout(tick, 400));
  };
  tick();
}

function killWeb() {
  if (!webProc) return;
  webIntentionalStop = true;
  const p = webProc;
  webProc = null;
  // web 服务实测忽略 SIGTERM，直接 SIGKILL
  try { p.kill('SIGKILL'); } catch { /* gone */ }
}

// ============================================================================
// 窗口
// ============================================================================
const RENDERER_PREFIX = pathToFileURL(path.join(__dirname, 'renderer') + path.sep).href;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    title: 'DSH Desktop',
    backgroundColor: '#111418',
    // 无系统标题栏：Wayland/niri 下系统标题栏显示 Electron 默认图标而非应用图标，
    // 且与自绘顶栏重复；窗口拖动由顶栏 -webkit-app-region: drag 承担
    frame: false,
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
  // iframe 每次导航（会话切换/重连）后重新注入剪贴板补丁
  win.webContents.on('frame-navigated', (_e, url, isMainFrame) => {
    if (!isMainFrame && url.startsWith('http://127.0.0.1')) {
      setTimeout(() => { patchClipboardInFrames(); patchPasteInFrames(); }, 200);
    }
  });

  // 导航锁定：仅放行应用自身 renderer/ 页面与 127.0.0.1 官方 UI（精确 origin 比对）
  win.webContents.on('will-navigate', (e, url) => {
    const ok = url.startsWith(RENDERER_PREFIX)
      || (webUrl && sameLoopbackOrigin(url, webUrl));
    if (!ok) e.preventDefault();
  });
  // 同源弹窗放行（官方 UI 内部链接），其余拒绝
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (webUrl && sameLoopbackOrigin(url, webUrl)) return { action: 'allow' };
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
// 无边框窗口控制（frame: false 后由顶栏按钮接管）
ipcMain.on('window:minimize', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.on('window:toggle-maximize', () => {
  if (win && !win.isDestroyed()) (win.isMaximized() ? win.unmaximize() : win.maximize());
});
ipcMain.on('window:close', () => { if (win && !win.isDestroyed()) win.close(); });
// 剪贴板兜底：iframe 内复制失败时经父页面 IPC 走主进程 clipboard（无焦点限制）
const { clipboard } = require('electron');
ipcMain.handle('clipboard:write', (_e, text) => {
  try { clipboard.writeText(String(text ?? '')); return true; } catch { return false; }
});

// ============================================================================
// 粘贴图片自动转路径（桌面端注入功能，受 vision.autoPath 开关控制）
// 用户向官方 UI 输入框粘贴图片 → iframe 补丁拦截（阻止官方附件流程，避免
// DeepSeek 文本模型的 UNSUPPORTED_CONTENT 报错）→ 图片 base64 经父页面 IPC
// 存盘 → 返回真实路径 → 补丁自动插入输入框 → 主模型用 vision_describe 查看。
// ============================================================================
const PASTE_DIR = path.join(HOMEDIR, '.dsh', 'attachments', 'paste');
ipcMain.handle('vision:save-pasted-image', (_e, { data, name, mime }) => {
  try {
    // data 为 dataURL（data:image/png;base64,xxx）
    const m = String(data || '').match(/^data:(image\/[a-z+.-]+);base64,(.+)$/);
    if (!m) return { ok: false, error: '非法的图片数据' };
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[String(mime || m[1])] || 'img');
    fs.mkdirSync(PASTE_DIR, { recursive: true });
    // 剥离 name 自带的扩展名（剪贴板图片常为 image.png），避免 image.png.png 双后缀
    const base = String(name || 'image').replace(/[^\w.-]/g, '_').replace(/\.[A-Za-z0-9]+$/, '') || 'image';
    const file = path.join(PASTE_DIR, `${Date.now()}-${base}.${ext}`);
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    ringLog('vision', `粘贴图片已存盘：${file}`);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// iframe 注入：监听 paste 检测图片 → 拦截 → 存盘 → 路径插入输入框
const PASTE_PATCH_SRC = `(() => {
  if (window.__dshPastePatched) return;
  const PENDING = new Map(); // requestId → 等待插入的图片信息

  // 在输入框光标处插入文本（contenteditable / textarea 兼容）
  const insertText = (target, text) => {
    try {
      if (target.isContentEditable) {
        target.focus();
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else { target.appendChild(document.createTextNode(text)); }
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } else if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
        const s = target.selectionStart ?? target.value.length;
        target.value = target.value.slice(0, s) + text + target.value.slice(target.selectionEnd ?? s);
        target.selectionStart = target.selectionEnd = s + text.length;
        target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    } catch { /* ignore */ }
  };

  // 找输入框：官方 UI 的 composer（contenteditable 优先，其次 textarea）
  const findComposer = () => {
    const el = document.activeElement;
    if (el && (el.isContentEditable || el.tagName === 'TEXTAREA')) return el;
    const editable = document.querySelector('[contenteditable="true"]');
    if (editable) return editable;
    return document.querySelector('textarea');
  };

  // 收父页面回传的路径 → 插入输入框
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'dsh-paste-image-result') return;
    const pending = PENDING.get(d.requestId);
    if (!pending) return;
    PENDING.delete(d.requestId);
    if (!d.ok) return;
    const text = pending.isEditable ? '\\n' : '';
    insertText(pending.target, \`[图片] \${d.path}\${text}\`);
  });

  // 捕获阶段拦截：官方 UI 的粘贴监听器在 composer（目标阶段）先执行，
  // document 冒泡阶段的 preventDefault 太晚（图片已被官方插入/上传）。
  // 捕获阶段 document → 目标，先于任何目标监听器，配合 stopImmediatePropagation
  // 彻底阻断官方图片处理。
  document.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type && f.type.startsWith('image/'));
    if (images.length === 0) return;
    // 拦截官方附件流程（DeepSeek 文本模型不支持 image block，会 UNSUPPORTED_CONTENT）
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const target = findComposer();
    if (!target) return;
    for (const img of images) {
      const requestId = 'p' + Date.now() + Math.random().toString(36).slice(2, 8);
      PENDING.set(requestId, { target, isEditable: target.isContentEditable });
      const reader = new FileReader();
      reader.onload = () => {
        try {
          window.parent.postMessage({
            type: 'dsh-paste-image', requestId,
            data: reader.result, name: img.name || 'image', mime: img.type,
          }, '*');
        } catch { /* ignore */ }
      };
      reader.readAsDataURL(img);
    }
  }, true); // 捕获阶段：先于官方 composer 监听器执行
  window.__dshPastePatched = true;
})();`;

/** 对官方 UI iframe 注入粘贴转路径补丁（受 vision.autoPath 开关控制，幂等）。 */
function patchPasteInFrames() {
  if (!win || win.isDestroyed()) return;
  if (!readVisionSettings().autoPath) return; // 开关关闭则不注入
  let frames = [];
  try { frames = win.webContents.mainFrame.frames; } catch { return; }
  for (const f of frames) {
    if (f.url.startsWith('http://127.0.0.1')) {
      f.executeJavaScript(PASTE_PATCH_SRC).catch(() => { /* 帧可能已销毁 */ });
    }
  }
}

// ============================================================================
// 官方 UI iframe 剪贴板补丁（不魔改官方代码，仅兼容层增强）
// 官方 UI 的 navigator.clipboard.writeText 在文档无焦点时抛 NotAllowedError
// （Electron/iframe 场景），复制静默失败。注入包装：聚焦重试 → execCommand
// 兜底 → postMessage 父页面走主进程 clipboard（最终兜底）。
// ============================================================================
const CLIPBOARD_PATCH_SRC = `(() => {
  if (window.__dshClipboardPatched) return;
  const navClip = navigator.clipboard;
  if (!navClip || typeof navClip.writeText !== 'function') return;
  const orig = navClip.writeText.bind(navClip);
  const fallbackTextarea = (text) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = String(text);
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  };
  navClip.writeText = async (text) => {
    try { return await orig(text); }
    catch (e) {
      // 1) 聚焦后重试（NotAllowedError: Document is not focused）
      try { window.focus(); if (document.body) document.body.focus(); return await orig(text); } catch { /* next */ }
      // 2) execCommand 兜底
      if (fallbackTextarea(text)) return;
      // 3) 父页面 → 主进程 clipboard 最终兜底
      try {
        window.parent.postMessage({ type: 'dsh-clipboard-fallback', text: String(text) }, '*');
      } catch { /* ignore */ }
      throw e;
    }
  };
  window.__dshClipboardPatched = true;
})();`;

/** 对官方 UI iframe 注入剪贴板补丁（幂等，注入主世界）。 */
function patchClipboardInFrames() {
  if (!win || win.isDestroyed()) return;
  let frames = [];
  try { frames = win.webContents.mainFrame.frames; } catch { return; }
  for (const f of frames) {
    if (f.url.startsWith('http://127.0.0.1')) {
      f.executeJavaScript(CLIPBOARD_PATCH_SRC).catch(() => { /* 帧可能已销毁 */ });
    }
  }
}
ipcMain.handle('web:get-state', () => ({ state: webReady ? 'ready' : (webProc ? 'starting' : 'stopped'), url: webUrl }));
ipcMain.handle('web:get-log', () => ({ lines: logRing.slice(-300) }));
ipcMain.on('web:retry', () => {
  killWeb();
  startWeb();
});
ipcMain.on('update:check', (_e, silent) => checkUpdate({ silent: !!silent }));
ipcMain.handle('update:install', () => installUpdate());
ipcMain.handle('update:get-state', () => update);
ipcMain.on('update:set-auto-check', (_e, v) => {
  saveSettings({ autoCheck: !!v });
  syncSettingsToUpdate();
  setAutoCheckTimer(!!v); // 开关即时生效（此前只保存不生效）
  sendUpdateStatus();
});
ipcMain.on('update:set-auto-install', (_e, v) => {
  saveSettings({ autoInstall: !!v });
  syncSettingsToUpdate();
  sendUpdateStatus();
});
ipcMain.on('update:set-channel', (_e, c) => {
  const ch = c === 'latest' ? 'latest' : 'next';
  saveSettings({ channel: ch });
  syncSettingsToUpdate();
  sendUpdateStatus();
  checkUpdate({ silent: true }); // 切通道后立即复查
});

function setAutoCheckTimer(enabled) {
  clearInterval(autoCheckTimer);
  autoCheckTimer = enabled ? setInterval(() => checkUpdate(), AUTO_CHECK_INTERVAL_MS) : null;
}

// ============================================================================
// 视觉助手 IPC（配置存 ~/.dsh/settings.yaml 的 vision 段，引擎热更新）
// ============================================================================
ipcMain.handle('vision:get-config', () => {
  const cfg = readVisionSettings();
  return { ...cfg, apiKey: cfg.apiKey ? '(已设置)' : '' };
});
ipcMain.handle('vision:set-config', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return readVisionSettings();
  const saved = writeVisionSettings(patch);
  ringLog('vision', `配置已保存（enabled=${saved.enabled} model=${saved.model}）`);
  return saved;
});

// ============================================================================
// 自检截图（DSH_DESKTOP_SELFCHECK=1；DSH_DESKTOP_SELFCHECK_CRASH=1 附加崩溃自愈演练）
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
      const panel = document.getElementById('settings-panel');
      const logBox = document.getElementById('web-log');
      return {
        panel: panel.hidden ? '未打开' : '已打开',
        autoCheck: document.getElementById('chk-auto-check').checked,
        autoInstall: document.getElementById('chk-auto-install').checked,
        channel: document.getElementById('sel-channel').value,
        visionEnabled: document.getElementById('vision-enabled').checked,
        visionModel: document.getElementById('vision-model').value,
        visionKeyPlaceholder: document.getElementById('vision-apikey').placeholder,
        logLines: logBox ? logBox.textContent.split('\\n').length : -1,
        logHead: logBox ? logBox.textContent.slice(0, 100) : '',
      };
    })()`)
      .then((r) => log('[diag] ' + label + ' ui: ' + JSON.stringify(r)))
      .catch((e) => log('[diag err] ' + e.message));
    setTimeout(() => snap(label), 400); // 等一帧再截图，避免捕获到面板打开前的画面
  };
  const finish = () => {
    log('[update-state] ' + JSON.stringify(update));
    log('---- 引擎日志尾部 ----');
    log(logRing.slice(-40).join('\n'));
    log('[selfcheck] done');
    killWeb(); // 自检退出前显式回收引擎（app.exit 不触发窗口 close 流程，否则会留孤儿进程）
    app.exit(0); // 自检模式跑完自动退出（此前会一直挂着）
  };
  setTimeout(() => diag('web1'), 10000);
  if (process.env.DSH_DESKTOP_SELFCHECK_CRASH === '1') {
    setTimeout(() => {
      if (webProc) {
        log('[selfcheck] 模拟崩溃：SIGKILL web 引擎，观察自动重启');
        try { webProc.kill('SIGKILL'); } catch { /* gone */ }
      }
    }, 13000);
    setTimeout(() => diag('recovered'), 21000);
    setTimeout(finish, 26000);
  } else {
    setTimeout(() => diag('web2'), 18000);
    setTimeout(finish, 23000);
  }
}

// ============================================================================
// 启动
// ============================================================================
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');

// 单实例锁：重复启动时聚焦已有窗口并退出（此前会再起一个 web 引擎）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[dsh-desktop] 已有实例在运行，本实例退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    createWindow();
    startWeb();
    maybeSelfcheck();

    // 更新管理器初始化 + 自动检查
    syncSettingsToUpdate();
    update.current = await getLocalVersion();
    if (update.autoCheck) {
      setTimeout(() => checkUpdate(), 8000);
      setAutoCheckTimer(true);
    }
    sendUpdateStatus();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  clearInterval(autoCheckTimer);
  clearTimeout(restartTimer);
  app.quit();
});
