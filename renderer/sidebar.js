/**
 * DSH Desktop — 侧栏：会话列表 / token 统计 / 上下文占用 / 一键续聊
 */
(function () {
  const api = window.dshDesktop;
  const listEl = document.getElementById('session-list');
  const dshPathEl = document.getElementById('dsh-path');

  const fmt = (n) => {
    if (n == null || n === 0) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'G';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  };
  const fmtTime = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  };

  function render(payload) {
    const sessions = payload?.sessions || [];
    dshPathEl.textContent = 'dsh: ' + (payload?.dsh || '?');
    if (!sessions.length) {
      listEl.innerHTML = '<div class="empty-hint">暂无会话记录<br/>开始新会话后这里会列出历史</div>';
      return;
    }
    listEl.innerHTML = '';
    for (const s of sessions) {
      const card = document.createElement('div');
      card.className = 'session-card' + (s.active ? ' active' : '');
      card.title = `${s.title}\n${s.cwd}\n${s.id}`;

      const pct = Math.round(s.context.occupancy * 100);
      const pctCls = pct >= 95 ? 'danger' : pct >= 80 ? 'warn' : '';

      const title = document.createElement('div');
      title.className = 's-title';
      title.textContent = s.title;

      const meta = document.createElement('div');
      meta.className = 's-meta';
      meta.textContent =
        (s.cwd || '') + `<span class="dot">·</span>` + fmtTime(s.createdAt);

      // 上下文占用条
      const bar = document.createElement('div');
      bar.className = 'ctx-bar';
      const fill = document.createElement('div');
      fill.className = 'fill' + (pctCls ? ' ' + pctCls : '');
      fill.style.width = Math.max(2, pct) + '%';
      bar.appendChild(fill);

      const stats = document.createElement('div');
      stats.className = 's-stats';
      const t = s.tokens || {};
      const ctxTxt = document.createElement('span');
      ctxTxt.className = 'ctx-pct' + (pctCls ? ' ' + pctCls : '');
      ctxTxt.textContent = s.context.window ? `ctx ${pct}%` : 'ctx —';
      const tokTxt = document.createElement('span');
      tokTxt.textContent = `↑${fmt(t.input)} ↓${fmt(t.output)} ⊕${fmt(t.cacheRead)}`;
      const turnTxt = document.createElement('span');
      turnTxt.textContent = `${s.stats.turns || 0} 轮 · ${s.stats.steps || 0} 步`;
      if (s.active) {
        const tag = document.createElement('span');
        tag.className = 'active-tag';
        tag.textContent = '● 当前';
        stats.appendChild(tag);
      }
      stats.appendChild(ctxTxt);
      stats.appendChild(tokTxt);
      stats.appendChild(turnTxt);

      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(bar);
      card.appendChild(stats);

      card.addEventListener('click', () => {
        if (s.active) return;
        api.resumeSession(s.id);
      });
      listEl.appendChild(card);
    }
  }

  document.getElementById('btn-new').addEventListener('click', () => api.newSession());
  document.getElementById('btn-collapse').addEventListener('click', () => {
    document.body.classList.toggle('sidebar-collapsed');
  });

  api.onSessions(render);
  render({ sessions: [] });
})();
