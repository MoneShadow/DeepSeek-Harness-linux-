/**
 * DSH Desktop — 渲染层：顶栏 / 设置面板 / 更新管理 / Web UI iframe
 */
(function () {
  const api = window.dshDesktop;

  // ============ Web UI iframe ============
  const webFrame = document.getElementById('web-frame');
  const loadingStatus = document.getElementById('loading-status');
  const retryBtn = document.getElementById('btn-retry');

  api.onWebStatus((s) => {
    if (s.state === 'starting') {
      loadingStatus.textContent = '正在启动 DSH Web 服务…';
      retryBtn.hidden = true;
    } else if (s.state === 'ready' && s.url) {
      if (webFrame.src !== s.url) webFrame.src = s.url; // 首次或更新后换端口
      document.body.classList.add('web-ready');
    } else if (s.state === 'timeout') {
      loadingStatus.textContent = 'Web 服务启动超时';
      retryBtn.hidden = false;
    } else if (s.state === 'restarting') {
      loadingStatus.textContent = 'Web 服务异常退出，正在自动重启…';
      retryBtn.hidden = true;
    } else if (s.state === 'failed') {
      loadingStatus.textContent = 'Web 服务多次重启失败，请手动重试';
      retryBtn.hidden = false;
    } else if (s.state === 'stopped') {
      document.body.classList.remove('web-ready');
      loadingStatus.textContent = 'Web 服务已停止';
      retryBtn.hidden = false;
    }
  });
  // 防事件竞态：加载完成后主动拉取当前 Web 状态（若错过 ready 事件则补挂 iframe）
  api.getWebState().then((s) => {
    if (s.state === 'ready' && s.url) {
      if (webFrame.src !== s.url) webFrame.src = s.url;
      document.body.classList.add('web-ready');
    }
  });
  retryBtn.addEventListener('click', () => api.retry());

  // ============ 设置面板 ============
  const panel = document.getElementById('settings-panel');
  const banner = document.getElementById('update-banner');
  const bannerText = document.getElementById('banner-text');
  const $ = (id) => document.getElementById(id);

  const appVer = document.getElementById('app-ver');
  const aboutAppVer = document.getElementById('about-app-ver');
  api.getAppInfo().then((info) => {
    appVer.textContent = 'v' + info.version;
    aboutAppVer.textContent = 'v' + info.version;
    document.getElementById('about-dsh-path').textContent = info.dshPath;
  });

  let updateState = { state: 'idle', current: '', latest: '', message: '' };
  let shownSettingsOnce = false;

  function renderUpdate() {
    const s = updateState;
    $('upd-current').textContent = s.current || '—';
    $('upd-latest').textContent = s.latest || '—';
    const msgEl = $('upd-message');
    msgEl.textContent = s.message || '';
    msgEl.className = 'message ' + (s.state === 'done' ? 'done' : s.state === 'error' ? 'error' : s.state === 'checking' || s.state === 'installing' ? 'info' : '');
    $('btn-install-update').disabled = s.state !== 'update-available' || s.installing;
    $('btn-check-update').disabled = s.state === 'checking' || s.state === 'installing';
    // 设置值由主进程回传，勾选框如实反映（v0.4 修复：此前渲染层永远拿不到保存值）
    $('chk-auto-check').checked = s.autoCheck !== false;
    $('chk-auto-install').checked = !!s.autoInstall;
    $('sel-channel').value = s.channel === 'latest' ? 'latest' : 'next';

    // 横幅：有新版且面板未打开时提示
    if (s.state === 'update-available' && panel.hidden) {
      bannerText.textContent = `发现新版本 ${s.latest}（当前 ${s.current}）`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
    // 自动安装由主进程判定（update:check 完成后触发），渲染层不再决策
  }

  api.onUpdateStatus((s) => {
    updateState = { ...updateState, ...s };
    renderUpdate();
  });

  // ============ 引擎日志 ============
  const logBox = document.getElementById('web-log');
  let logTimer = null;
  function refreshLog() {
    api.getWebLog().then((r) => {
      logBox.textContent = (r.lines || []).join('\n');
      logBox.scrollTop = logBox.scrollHeight;
    });
  }

  function togglePanel(show) {
    panel.hidden = !show;
    if (show) {
      refreshLog();
      if (!logTimer) {
        logTimer = setInterval(() => { if (!panel.hidden) refreshLog(); }, 4000);
      }
      if (!shownSettingsOnce) {
        shownSettingsOnce = true;
        api.checkUpdate(true); // 打开时静默检查
      }
    } else if (logTimer) {
      clearInterval(logTimer);
      logTimer = null;
    }
  }

  $('btn-settings').addEventListener('click', () => togglePanel(panel.hidden));
  $('btn-close-settings').addEventListener('click', () => togglePanel(false));
  // ESC 关闭设置面板
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) togglePanel(false);
  });
  $('banner-open').addEventListener('click', () => { togglePanel(false); togglePanel(true); });
  $('btn-check-update').addEventListener('click', () => api.checkUpdate(false));
  $('btn-install-update').addEventListener('click', () => api.installUpdate());
  $('chk-auto-check').addEventListener('change', (e) => api.setAutoCheck(e.target.checked));
  $('chk-auto-install').addEventListener('change', (e) => api.setAutoInstall(e.target.checked));
  $('sel-channel').addEventListener('change', (e) => api.setChannel(e.target.value));
  $('btn-refresh-log').addEventListener('click', refreshLog);

  // ============ 窗口控制 ============
  $('btn-minimize').addEventListener('click', () => api.minimize());
  $('btn-maximize').addEventListener('click', () => api.toggleMaximize());
  $('btn-close').addEventListener('click', () => api.closeWindow());

  // ============ 视觉助手配置 ============
  const visionSaved = document.getElementById('vision-saved');
  let visionKeySet = false;
  function loadVisionConfig() {
    api.getVisionConfig().then((cfg) => {
      $('vision-enabled').checked = cfg.enabled !== false;
      $('vision-baseurl').value = cfg.baseURL || '';
      $('vision-model').value = cfg.model || '';
      $('vision-timeout').value = cfg.timeoutMs || 60000;
      visionKeySet = !!cfg.apiKey;
      $('vision-apikey').placeholder = visionKeySet ? '已设置（留空保持原值）' : 'sk-...';
      $('vision-apikey').value = '';
      visionSaved.hidden = true;
    });
  }
  $('btn-save-vision').addEventListener('click', () => {
    const patch = {
      enabled: $('vision-enabled').checked,
      baseURL: $('vision-baseurl').value.trim(),
      model: $('vision-model').value.trim(),
      timeoutMs: Number($('vision-timeout').value) || 60000,
    };
    const key = $('vision-apikey').value.trim();
    if (key) patch.apiKey = key; // 留空 = 保持原值
    $('btn-save-vision').disabled = true;
    api.setVisionConfig(patch).then(() => {
      visionSaved.hidden = false;
      $('vision-apikey').value = '';
      $('vision-apikey').placeholder = '已设置（留空保持原值）';
      setTimeout(() => { visionSaved.hidden = true; }, 3000);
    }).finally(() => { $('btn-save-vision').disabled = false; });
  });

  // ============ iframe 剪贴板兜底 ============
  // 官方 UI 复制在文档无焦点时失败，其补丁会 postMessage 到这里，走主进程 clipboard
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'dsh-clipboard-fallback' && typeof e.data.text === 'string') {
      api.writeClipboard(e.data.text);
    }
  });

  // ============ 初始化 ============
  api.getUpdateState().then((s) => {
    updateState = { ...updateState, ...s };
    renderUpdate();
  });
  loadVisionConfig();
})();
