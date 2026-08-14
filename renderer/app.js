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
    $('chk-auto-check').checked = s.autoCheck !== false;
    $('chk-auto-install').checked = !!s.autoInstall;

    // 横幅：有新版且面板未打开时提示
    if (s.state === 'update-available' && panel.hidden) {
      bannerText.textContent = `发现新版本 ${s.latest}（当前 ${s.current}）`;
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }

    // 自动安装
    if (s.autoInstall && s.state === 'update-available' && !s.installing) {
      api.installUpdate();
    }
  }

  api.onUpdateStatus((s) => {
    updateState = { ...updateState, ...s };
    renderUpdate();
  });

  function togglePanel(show) {
    panel.hidden = !show;
    if (show && !shownSettingsOnce) {
      shownSettingsOnce = true;
      api.checkUpdate(true); // 打开时静默检查
    }
  }

  $('btn-settings').addEventListener('click', () => togglePanel(panel.hidden));
  $('btn-close-settings').addEventListener('click', () => togglePanel(false));
  $('banner-open').addEventListener('click', () => { togglePanel(false); togglePanel(true); });
  $('btn-check-update').addEventListener('click', () => api.checkUpdate(false));
  $('btn-install-update').addEventListener('click', () => api.installUpdate());
  $('chk-auto-check').addEventListener('change', (e) => api.setAutoCheck(e.target.checked));
  $('chk-auto-install').addEventListener('change', (e) => api.setAutoInstall(e.target.checked));

  // ============ 初始化 ============
  api.getUpdateState().then((s) => {
    updateState = { ...updateState, ...s };
    renderUpdate();
  });
})();
