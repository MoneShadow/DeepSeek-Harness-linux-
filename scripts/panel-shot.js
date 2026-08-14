/**
 * 设置面板验证工具（隔离 electron 实例，不加载 dsh-desktop 主逻辑、不碰引擎）
 *
 * 模式（环境变量）：
 *   PANEL_MODE=closed   默认：不开面板截图（验证启动默认隐藏）
 *   PANEL_MODE=open     打开面板截图（验证渲染）
 *   PANEL_MODE=esc      打开面板 → 模拟 ESC → 断言 panel.hidden === true
 * 输出：/home/mone/dsh-desktop/.panel-shot.png + 控制台结果
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const MODE = process.env.PANEL_MODE || 'closed';
const OUT = '/home/mone/dsh-desktop/.panel-shot.png';
const ROOT = path.join(__dirname, '..');

app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 860, height: 1180, show: true, frame: false,
    backgroundColor: '#111418',
    webPreferences: {
      contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, 'panel-shot-preload.js'),
    },
  });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      if (MODE === 'open' || MODE === 'esc') {
        await win.webContents.executeJavaScript(`document.getElementById('btn-settings').click(); true;`);
      }
      if (MODE === 'closed') {
        const state = await win.webContents.executeJavaScript(`
          (() => {
            const p = document.getElementById('settings-panel');
            return { hidden: p.hidden, visible: p.offsetParent !== null };
          })()
        `);
        console.log(`[closed] ${JSON.stringify(state)} → ${state.hidden && !state.visible ? 'PASS' : 'FAIL'}`);
        app.exit(state.hidden && !state.visible ? 0 : 1);
        return;
      }
      if (MODE === 'esc') {
        // 打开状态下模拟 ESC
        await win.webContents.executeJavaScript(`
          document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          true;
        `);
        await new Promise((r) => setTimeout(r, 300));
        const hidden = await win.webContents.executeJavaScript(`document.getElementById('settings-panel').hidden`);
        console.log(`[esc] panel.hidden = ${hidden} → ${hidden ? 'PASS' : 'FAIL'}`);
        app.exit(hidden ? 0 : 1);
        return;
      }
      setTimeout(async () => {
        const img = await win.capturePage();
        fs.writeFileSync(OUT, img.toPNG());
        console.log('shot saved ->', OUT);
        app.exit(0);
      }, 700);
    }, 900);
  });
});
