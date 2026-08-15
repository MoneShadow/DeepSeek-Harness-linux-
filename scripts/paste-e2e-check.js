/**
 * 粘贴图片自动转路径 —— 端到端测试
 *
 * 模拟：父页面 + iframe（官方 UI 形态），iframe 内注入 PASTE_PATCH_SRC 补丁，
 * 触发 paste 事件（带 PNG File）→ 验证：
 *   1. 补丁拦截（preventDefault）
 *   2. 图片 base64 到达父页面 → 主进程存盘（真实文件）
 *   3. 路径回传 iframe → 自动插入输入框（contenteditable）
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const TEST_DIR = '/home/mone/dsh-desktop/.paste-test';
const SAVE_DIR = '/home/mone/dsh-desktop/.paste-test/saved';

const PASTE_PATCH_SRC = `(() => {
  if (window.__dshPastePatched) return;
  const PENDING = new Map();
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
    } catch { }
  };
  const findComposer = () => {
    const el = document.activeElement;
    if (el && (el.isContentEditable || el.tagName === 'TEXTAREA')) return el;
    const editable = document.querySelector('[contenteditable="true"]');
    if (editable) return editable;
    return document.querySelector('textarea');
  };
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.type !== 'dsh-paste-image-result') return;
    const pending = PENDING.get(d.requestId);
    if (!pending) return;
    PENDING.delete(d.requestId);
    if (!d.ok) return;
    insertText(pending.target, '[图片] ' + d.path + '\\n');
  });
  document.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((f) => f.type && f.type.startsWith('image/'));
    if (images.length === 0) return;
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
          window.parent.postMessage({ type: 'dsh-paste-image', requestId, data: reader.result, name: img.name || 'image', mime: img.type }, '*');
        } catch { }
      };
      reader.readAsDataURL(img);
    }
  }, true);
  window.__dshPastePatched = true;
})();`;

fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });
fs.mkdirSync(SAVE_DIR, { recursive: true });
// 测试用 PNG（1x1 红点）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
fs.writeFileSync(path.join(TEST_DIR, 'frame.html'), `<!DOCTYPE html><html><body>
  <div contenteditable="true" id="composer"></div>
  <script>
    // 模拟官方 UI：composer 目标上的粘贴监听（图片会被官方插入/上传）
    document.getElementById('composer').addEventListener('paste', (e) => {
      window.__officialHandled = true;  // 官方处理器执行标记
    });
    ${PASTE_PATCH_SRC}
  </script>
</body></html>`);
fs.writeFileSync(path.join(TEST_DIR, 'parent.html'), `<!DOCTYPE html><html><body>
  <iframe id="f" src="./frame.html"></iframe>
  <script>
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.type === 'dsh-paste-image') {
        window.__pasteHandler && window.__pasteHandler(d, e.source);
      }
    });
  </script>
</body></html>`);

app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 600, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(TEST_DIR, 'parent.html'));
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      // 在父页面注册存盘 handler（模拟 IPC：保存到 SAVE_DIR 并回传路径）
      await win.webContents.executeJavaScript(`
        window.__pasteHandler = async (d, source) => {
          const m = d.data.match(/^data:(image\\/[a-z+.-]+);base64,(.+)$/);
          if (!m) { source.postMessage({ type: 'dsh-paste-image-result', requestId: d.requestId, ok: false }, '*'); return; }
          const ext = ({'image/png':'png'})[d.mime || m[1]] || 'img';
          const file = '${SAVE_DIR}/' + Date.now() + '-test.' + ext;
          window.__savedFile = file;
          source.postMessage({ type: 'dsh-paste-image-result', requestId: d.requestId, ok: true, path: file }, '*');
        };
        true;
      `);
      // iframe 里触发真实 paste 事件（带图片 File）
      const frame = win.webContents.mainFrame.frames.find((f) => f.url.includes('frame.html'));
      const result = await frame.executeJavaScript(`
        (async () => {
          const b64 = '${PNG_B64}';
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const file = new File([bytes], 'paste-test.png', { type: 'image/png' });
          const dt = new DataTransfer();
          dt.items.add(file);
          const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
          document.getElementById('composer').dispatchEvent(ev);
          return { defaultPrevented: ev.defaultPrevented };
        })()
      `);
      await new Promise((r) => setTimeout(r, 800));
      const composerText = await frame.executeJavaScript('document.getElementById("composer").textContent');
      console.log('PASTE prevented:', result.defaultPrevented);
      console.log('COMPOSER:', JSON.stringify(composerText));
      const officialHandled = await frame.executeJavaScript('window.__officialHandled === true');
      console.log('OFFICIAL handled:', officialHandled);
      const pass = result.defaultPrevented === true
        && composerText.includes('[图片]') && composerText.includes('.png')
        && officialHandled === false;
      console.log(pass ? 'PASS' : 'FAIL');
      app.exit(pass ? 0 : 1);
    }, 1000);
  });
});
