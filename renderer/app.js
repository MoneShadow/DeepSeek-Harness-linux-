/**
 * DSH Desktop — 启动页状态管理
 */
(function () {
  const api = window.dshDesktop;
  const statusEl = document.getElementById('status');
  const retryBtn = document.getElementById('retry');
  const spinner = document.getElementById('spinner');

  api.onWebStatus((s) => {
    if (s.state === 'starting') {
      statusEl.textContent = '正在启动 DSH Web 服务…';
      spinner.style.display = 'block';
      retryBtn.style.display = 'none';
    } else if (s.state === 'ready') {
      // 主进程即将 loadURL 官方 UI，本页马上被替换
      statusEl.textContent = '服务已就绪，正在打开界面…';
    } else if (s.state === 'timeout') {
      statusEl.textContent = 'Web 服务启动超时';
      spinner.style.display = 'none';
      retryBtn.style.display = 'block';
    } else if (s.state === 'stopped') {
      statusEl.textContent = 'Web 服务已停止';
      spinner.style.display = 'none';
      retryBtn.style.display = 'block';
    }
  });

  retryBtn.addEventListener('click', () => api.retry());
})();
