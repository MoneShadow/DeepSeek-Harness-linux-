/**
 * 设置面板截图工具（隔离验证用，不加载 dsh-desktop 主逻辑）
 * 用法：electron test-shot.js → 输出 /home/mone/dsh-desktop/.panel-shot.png
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 860, height: 1180, show: true,
    backgroundColor: '#111418',
    webPreferences: {
      contextIsolation: true, sandbox: true,
      preload: path.join(__dirname, 'panel-shot-preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      await win.webContents.executeJavaScript(`document.getElementById('btn-settings').click(); document.querySelector('.panel-body').scrollTop = 9999; true;`);
      setTimeout(async () => {
        const img = await win.capturePage();
        fs.writeFileSync('/home/mone/dsh-desktop//home/mone/dsh-desktop/.panel-shot.png', img.toPNG());
        console.log('shot saved');
        app.exit(0);
      }, 700);
    }, 900);
  });
});
