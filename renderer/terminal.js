/**
 * DSH Desktop — 终端面板：xterm.js 挂到 PTY 桥，自适应尺寸
 */
(function () {
  const api = window.dshDesktop;
  const el = document.getElementById('terminal');

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Mono", Menlo, monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 10000,
    theme: {
      background: '#111418',
      foreground: '#d7dce2',
      cursor: '#8ab4ff',
      selectionBackground: '#2b3a52',
    },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();

  // PTY 输出 → 终端
  api.onPtyData((data) => term.write(data));

  // 退出提示
  api.onPtyExit((code) => {
    term.write(`\r\n\x1b[90m[dsh 进程已退出 (${code}) — 点击左侧会话或「新会话」重新启动]\x1b[0m\r\n`);
  });

  // 键盘输入 → PTY
  term.onData((data) => api.write(data));

  // 尺寸变化 → PTY resize
  const ro = new ResizeObserver(() => {
    fit.fit();
    api.resize(term.cols, term.rows);
  });
  ro.observe(el);

  // 快捷键：Ctrl+Shift+C/V 复制粘贴、Ctrl+B 折叠侧栏
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      const sel = term.getSelection();
      if (sel) navigator.clipboard.writeText(sel).catch(() => {});
      return false;
    }
    if (mod && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
      api.paste();
      return false;
    }
    if (mod && (e.key === 'b' || e.key === 'B')) {
      document.body.classList.toggle('sidebar-collapsed');
      setTimeout(() => { fit.fit(); api.resize(term.cols, term.rows); }, 180);
      return false;
    }
    return true;
  });

  window.__dsTerm = term; // 供 sidebar.js 复用尺寸
  window.addEventListener('resize', () => {
    fit.fit();
    api.resize(term.cols, term.rows);
  });
})();
