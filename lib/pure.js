/**
 * DSH Desktop — 纯函数工具模块（无 Electron 依赖，可单元测试）
 *
 * 从 main.js 拆出，便于 node:test 直接验证版本语义与 URL 安全判定。
 */

/**
 * 版本比较："0.1.0-rc.6" vs "0.1.0-rc.7" / "0.1.0"（正式版高于同版本 rc）。
 * 无法解析时退回 localeCompare（保持行为可预测）。
 * @returns {number} >0 表示 a 更新，<0 表示 b 更新，0 相等
 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
  };
  const pa = parse(a), pb = parse(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * 去除 ANSI CSI 转义序列（npm 输出可能带颜色）。
 */
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
}

/**
 * 解析 URL 三元组（protocol/hostname/port），非法返回 null。
 */
function urlOrigin(u) {
  try {
    const p = new URL(u);
    return { protocol: p.protocol, hostname: p.hostname, port: p.port };
  } catch {
    return null;
  }
}

/**
 * 严格同源判定：仅当两侧都是 http://127.0.0.1 且端口一致。
 * 防 startsWith 前缀绕过（如 http://127.0.0.1:41341.evil.com）。
 */
function sameLoopbackOrigin(a, b) {
  const A = urlOrigin(a), B = urlOrigin(b);
  if (!A || !B) return false;
  return A.protocol === 'http:'
    && B.protocol === 'http:'
    && A.hostname === '127.0.0.1'
    && B.hostname === '127.0.0.1'
    && A.port === B.port;
}

module.exports = { compareVersions, stripAnsi, urlOrigin, sameLoopbackOrigin };
