/**
 * DSH Desktop — Electron 主进程
 *
 * 职责：
 *  - 用 node-pty 派生 `dsh --profile cc-tui`（真实 PTY，满足 TUI 的 TTY 要求）
 *  - PTY 输出/输入经 IPC 与渲染进程的 xterm.js 双向桥接
 *  - 侧栏数据提供：读 ~/.dsh-cc/sessions.sqlite（会话列表）+
 *    ~/.dsh/storages/session_projcache.json（标题/token/上下文占用）+
 *    ~/.dsh-cc/last-used.json（MRU 排序），轮询推送
 *  - 续聊 = 重启 PTY 并注入 DSH_CC_RESUME_SESSION=<id>（cc-tui 官方机制）
 */
const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const HOMEDIR = os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOMEDIR, '.dsh');
const CC_DIR = path.join(HOMEDIR, '.dsh-cc');
const SESSIONS_DB = path.join(CC_DIR, 'sessions.sqlite');
const PROJCACHE = path.join(DSH_HOME, 'storages', 'session_projcache.json');
const LAST_USED = path.join(CC_DIR, 'last-used.json');
const SIDEBAR_POLL_MS = 2000;

let win = null;
let ptyProcess = null;
let currentSessionId = null; // null = 新会话
let sidebarTimer = null;

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
  return 'dsh'; // 最后交给 PATH
}
const DSH_BIN = resolveDsh();

// ---------- PTY 会话管理 ----------
function startPty(sessionId) {
  if (ptyProcess) killPty();
  currentSessionId = sessionId || null;
  sendStatus('starting', currentSessionId);
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  if (currentSessionId) env.DSH_CC_RESUME_SESSION = currentSessionId;

  try {
    ptyProcess = require('node-pty').spawn(DSH_BIN, ['--profile', 'cc-tui'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: HOMEDIR,
      env,
    });
  } catch (err) {
    sendStatus('error', null, `无法启动 dsh（${DSH_BIN}）: ${err.message}`);
    return;
  }

  ptyProcess.onData((data) => {
    if (win && !win.isDestroyed()) win.webContents.send('pty:data', data);
  });
  ptyProcess.onExit(({ exitCode }) => {
    ptyProcess = null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:exit', exitCode);
      win.webContents.send('pty:status', { state: 'exited', sessionId: currentSessionId });
    }
    refreshSessions();
  });
  sendStatus('running', currentSessionId);
  refreshSessions();
}

function killPty() {
  if (!ptyProcess) return;
  const p = ptyProcess;
  ptyProcess = null;
  try { p.kill('SIGTERM'); } catch { /* already gone */ }
  // 兜底：3 秒后仍未退出则强杀
  const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
  t.unref?.();
}

function sendStatus(state, sessionId, message) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('pty:status', { state, sessionId, message });
  }
}

// ---------- 侧栏数据 ----------
// ~/.dsh-cc/sessions.sqlite（WAL 并发安全，只读打开）
function readSessionsSqlite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(SESSIONS_DB, { readOnly: true });
    try {
      return db.prepare('SELECT id, created_at, cwd FROM sessions ORDER BY created_at DESC').all();
    } finally {
      db.close();
    }
  } catch (err) {
    // Electron 内 node:sqlite 不可用时，回退系统 node 子进程
    try {
      const script = `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[1], { readOnly: true });
        console.log(JSON.stringify(db.prepare('SELECT id, created_at, cwd FROM sessions ORDER BY created_at DESC').all()));
        db.close();
      `;
      const out = spawnSync('node', ['-e', script, SESSIONS_DB], { encoding: 'utf8', timeout: 5000 });
      if (out.status === 0) return JSON.parse(out.stdout.trim());
    } catch { /* fall through */ }
    return [];
  }
}

// 首条 user/message 文本（无标题时的回退标签，对齐 cc-tui 的列表做法）
function readFirstUserMessage(id) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(SESSIONS_DB, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT data FROM events WHERE session_id = ? AND type = 'user/message' ORDER BY seq LIMIT 1")
        .get(id);
      if (!row) return '';
      const data = JSON.parse(row.data);
      return typeof data?.text === 'string' ? data.text : '';
    } finally {
      db.close();
    }
  } catch {
    return '';
  }
}

function readProjcache() {
  try {
    return JSON.parse(fs.readFileSync(PROJCACHE, 'utf8'));
  } catch {
    return {};
  }
}

function readLastUsed() {
  try {
    const v = JSON.parse(fs.readFileSync(LAST_USED, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function truncate(s, n = 48) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function buildSidebarPayload() {
  const rows = readSessionsSqlite();
  const proj = readProjcache();
  const projSessions = proj?.tables?.sessions || {};
  const lastUsed = readLastUsed();
  const firstMsgCache = new Map();

  const sessions = rows.map((r) => {
    const p = projSessions[r.id];
    const rowsMap = p?.rows || {};
    const val = (k) => rowsMap[k]?.val;
    const tokenUsage = val('tokenUsage')?.totals || val('tokenUsage') || {};
    const contextPressure = val('contextPressure') || {};
    const stats = val('sessionStats') || {};
    const title = val('title') || (() => {
      if (!firstMsgCache.has(r.id)) firstMsgCache.set(r.id, readFirstUserMessage(r.id));
      return truncate(firstMsgCache.get(r.id)) || '（无标题会话）';
    })();
    const window = contextPressure.contextWindow || 0;
    const pressure = contextPressure.pressureTokens || 0;
    return {
      id: r.id,
      title: truncate(title, 40),
      cwd: r.cwd,
      createdAt: r.created_at,
      lastUsed: lastUsed[r.id] || 0,
      active: r.id === currentSessionId,
      context: {
        pressure,
        window,
        occupancy: window > 0 ? Math.min(1, pressure / window) : 0,
      },
      tokens: {
        input: tokenUsage.uncachedInputTokens || 0,
        cacheRead: tokenUsage.cacheReadTokens || 0,
        cacheWrite: tokenUsage.cacheWriteTokens || 0,
        output: tokenUsage.outputTokens || 0,
      },
      stats: {
        turns: stats.turns || 0,
        steps: stats.steps || 0,
        decodeTokens: stats.decodeTokens || 0,
      },
    };
  });

  // MRU 排序（last-used 优先，回退 createdAt），活跃会话置顶
  sessions.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastUsed || b.createdAt) - (a.lastUsed || a.createdAt);
  });
  return { sessions, dsh: DSH_BIN };
}

function refreshSessions() {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('sessions:update', buildSidebarPayload());
  } catch { /* window tearing down */ }
}

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'DSH Desktop',
    backgroundColor: '#111418',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  win.on('close', () => killPty());
}

// ---------- IPC ----------
ipcMain.on('pty:write', (_e, data) => {
  if (ptyProcess) { try { ptyProcess.write(data); } catch { /* gone */ } }
});
ipcMain.on('pty:resize', (_e, cols, rows) => {
  if (ptyProcess) { try { ptyProcess.resize(cols, rows); } catch { /* gone */ } }
});
ipcMain.on('session:new', () => startPty(null));
ipcMain.on('session:resume', (_e, id) => startPty(String(id)));
ipcMain.on('clipboard:paste', () => {
  if (!ptyProcess) return;
  try { ptyProcess.write(clipboard.readText()); } catch { /* gone */ }
});

// ---------- 自检截图（DSH_DESKTOP_SELFCHECK=1） ----------
function maybeSelfcheck() {
  if (process.env.DSH_DESKTOP_SELFCHECK !== '1') return;
  // 打包后 __dirname 在只读 asar 内，截图放 userData 目录
  const shotDir = path.join(app.getPath('userData'), 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  let n = 0;
  const snap = () => {
    if (!win || win.isDestroyed()) return;
    win.capturePage().then((img) => {
      const file = path.join(shotDir, `selfcheck-${Date.now()}.png`);
      fs.writeFileSync(file, img.toPNG());
      console.log(`[selfcheck] saved ${file}`);
      if (++n < 2) setTimeout(snap, 6000); // 拍两张：启动后 + 6 秒后
    }).catch((err) => console.error('[selfcheck] capture failed:', err));
  };
  setTimeout(snap, 4000);
}

// ---------- 启动 ----------
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.whenReady().then(() => {
  createWindow();
  startPty(null);
  sidebarTimer = setInterval(refreshSessions, SIDEBAR_POLL_MS);
  maybeSelfcheck();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  clearInterval(sidebarTimer);
  app.quit();
});
