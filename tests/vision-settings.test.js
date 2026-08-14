/**
 * DSH Desktop — 视觉助手配置读写单测（node --test）
 * 覆盖：行级解析/渲染（保留其他 section）、标量解析、规范化、磁盘读写。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseYamlScalar, parseVisionSection, renderVisionSection,
  normalizeVisionConfig, readVisionSettings, writeVisionSettings,
} = require('../lib/vision-settings.js');

const SAMPLE = [
  'ui-onboarding:',
  '  welcomeNoticeVersion: 2026-08-13.1',
  'ui-theme:',
  '  preference: system',
  'agent-default-model:',
  '  provider: deepseek-official',
  '  model: deepseek-v4-flash',
  '',
].join('\n');

test('parseYamlScalar: 引号/数字/布尔', () => {
  assert.equal(parseYamlScalar('"a b"'), 'a b');
  assert.equal(parseYamlScalar("'x y'"), 'x y');
  assert.equal(parseYamlScalar('123'), 123);
  assert.equal(parseYamlScalar('true'), true);
  assert.equal(parseYamlScalar('null'), null);
  assert.equal(parseYamlScalar('plain-text'), 'plain-text');
  assert.equal(parseYamlScalar('"含\\"转义\\""'), '含"转义"');
});

test('parseVisionSection: 无 vision 段返回默认值', () => {
  const cfg = parseVisionSection(SAMPLE);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.baseURL, 'https://api.openai.com/v1');
});

test('parseVisionSection: 解析已有 vision 段', () => {
  const text = SAMPLE + 'vision:\n  enabled: false\n  model: "qwen-vl-max"\n  timeoutMs: 30000\n';
  const cfg = parseVisionSection(text);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.model, 'qwen-vl-max');
  assert.equal(cfg.timeoutMs, 30000);
  // 其他字段回落默认
  assert.equal(cfg.apiKey, '');
});

test('renderVisionSection: 无 vision 段时追加且保留原内容', () => {
  const out = renderVisionSection(SAMPLE, normalizeVisionConfig({ model: 'glm-4v' }));
  assert.ok(out.includes('ui-theme:'));
  assert.ok(out.includes('preference: system'));
  assert.ok(out.includes('vision:'));
  assert.ok(out.includes('  model: "glm-4v"'));
});

test('renderVisionSection: 替换已有 vision 段，其他 section 原样', () => {
  const text = SAMPLE + 'vision:\n  enabled: false\n  model: "old-model"\n';
  const out = renderVisionSection(text, normalizeVisionConfig({ enabled: true, model: 'new-model' }));
  assert.equal(out.match(/vision:/g).length, 1);
  assert.ok(out.includes('  enabled: true'));
  assert.ok(out.includes('  model: "new-model"'));
  assert.ok(!out.includes('old-model'));
  assert.ok(out.includes('agent-default-model:'));
  assert.ok(out.includes('  provider: deepseek-official'));
});

test('normalizeVisionConfig: 类型兜底', () => {
  const cfg = normalizeVisionConfig({ timeoutMs: 'abc', enabled: 0, baseURL: '  x  ' });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.timeoutMs, 60000);
  assert.equal(cfg.baseURL, 'x');
});

test('磁盘读写: 原子写 + 读回 + 保留其他 section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-settings-'));
  const file = path.join(dir, 'settings.yaml');
  fs.writeFileSync(file, SAMPLE);
  const saved = writeVisionSettings({ enabled: false, apiKey: 'sk-secret' }, file);
  assert.equal(saved.apiKey, '(已设置)');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('ui-theme:'));
  assert.ok(text.includes('  apiKey: "sk-secret"'));
  const cfg = readVisionSettings(file);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.apiKey, 'sk-secret');
  // 权限 0600
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('磁盘读写: 文件不存在时新建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-settings-'));
  const file = path.join(dir, 'settings.yaml');
  const saved = writeVisionSettings({ model: 'qwen-vl-max' }, file);
  assert.equal(saved.model, 'qwen-vl-max');
  const cfg = readVisionSettings(file);
  assert.equal(cfg.model, 'qwen-vl-max');
  fs.rmSync(dir, { recursive: true, force: true });
});
