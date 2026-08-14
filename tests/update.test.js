/**
 * DSH Desktop — 纯函数单元测试（node --test tests/）
 * 覆盖：版本语义（rc 线/正式版）、ANSI 清理、loopback 同源判定（安全回归）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, stripAnsi, sameLoopbackOrigin } = require('../lib/pure.js');

test('compareVersions: rc 线递增', () => {
  assert.ok(compareVersions('0.1.0-rc.6', '0.1.0-rc.7') < 0);
  assert.ok(compareVersions('0.1.0-rc.7', '0.1.0-rc.6') > 0);
  assert.ok(compareVersions('0.1.0-rc.9', '0.1.0-rc.10') < 0); // 数字比较，非字典序
  assert.equal(compareVersions('0.1.0-rc.6', '0.1.0-rc.6'), 0);
});

test('compareVersions: 正式版高于同版本 rc', () => {
  assert.ok(compareVersions('0.1.0', '0.1.0-rc.6') > 0);
  assert.ok(compareVersions('0.1.0-rc.6', '0.1.0') < 0);
});

test('compareVersions: 跨小版本', () => {
  assert.ok(compareVersions('0.2.0-rc.1', '0.1.0-rc.99') > 0);
  assert.ok(compareVersions('0.1.9', '0.2.0-rc.0') < 0);
});

test('compareVersions: 非法输入退化为 localeCompare，不抛异常', () => {
  const r = compareVersions('abc', '0.1.0');
  assert.equal(typeof r, 'number');
  assert.ok(compareVersions('', '0.1.0') < 0);
});

test('stripAnsi: 去掉 CSI 颜色码与回车', () => {
  assert.equal(stripAnsi('\x1b[32mok\x1b[0m'), 'ok');
  assert.equal(stripAnsi('a\r\nb'), 'a\nb');
  assert.equal(stripAnsi('plain text'), 'plain text');
});

test('sameLoopbackOrigin: 同端口放行', () => {
  assert.equal(sameLoopbackOrigin('http://127.0.0.1:41341/', 'http://127.0.0.1:41341/x'), true);
});

test('sameLoopbackOrigin: 端口不同拒绝', () => {
  assert.equal(sameLoopbackOrigin('http://127.0.0.1:41341/', 'http://127.0.0.1:9999/'), false);
});

test('sameLoopbackOrigin: 前缀伪装域名拒绝（startsWith 绕过回归）', () => {
  assert.equal(sameLoopbackOrigin('http://127.0.0.1:41341/', 'http://127.0.0.1:41341.evil.com/'), false);
  assert.equal(sameLoopbackOrigin('http://127.0.0.1:41341/', 'http://127.0.0.1:41341@evil.com/'), false);
});

test('sameLoopbackOrigin: 协议/主机名不符拒绝', () => {
  assert.equal(sameLoopbackOrigin('http://127.0.0.1:41341/', 'https://127.0.0.1:41341/'), false);
  assert.equal(sameLoopbackOrigin('http://127.0.0.1:41341/', 'http://localhost:41341/'), false);
  assert.equal(sameLoopbackOrigin('http://127.0.0.1:41341/', 'not-a-url'), false);
});
