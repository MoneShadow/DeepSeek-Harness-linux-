/**
 * DSH Desktop — 视觉助手配置读写（纯 Node，可单测）
 *
 * 配置存 `~/.dsh/settings.yaml` 的 `vision:` 段。引擎（dsh）的 settings-file
 * 服务用 chokidar 监视该文件，外部编辑热发布 → vision_describe 工具即时生效。
 *
 * 零依赖设计：只做**行级手术**——只认 `vision:` 及其缩进子行，其他 section
 * 原样保留（不解析、不重写），避免引入 YAML 依赖与破坏引擎其他配置。
 */
const fs = require('node:fs');
const path = require('node:path');

const VISION_DEFAULTS = {
  enabled: true,
  autoPath: true,            // 粘贴图片自动转真实路径（桌面端注入功能）
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  timeoutMs: 60000,
  cache: true,               // 按图片内容哈希缓存描述结果（插件侧实现）
  cacheTtlSeconds: 3600,     // 缓存有效期（秒）
  cacheMaxEntries: 200,      // 缓存条目上限（LRU 淘汰）
};

/** 解析 YAML 标量（字符串引号/数字/布尔/null），失败回退为原始文本。 */
function parseYamlScalar(raw) {
  const v = String(raw).trim();
  if (v === '' || v === 'null' || v === '~') return null;
  if (/^(true|false)$/.test(v)) return v === 'true';
  if (/^-?\d+$/.test(v) || /^-?\d*\.\d+$/.test(v)) return Number(v);
  const m = v.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
  const m2 = v.match(/^'((?:[^'\\]|\\.)*)'$/);
  if (m2) return m2[1].replace(/\\'/g, "'");
  return v;
}

/** 从 settings.yaml 文本读 vision 段（返回原始对象，不脱敏）。 */
function parseVisionSection(text) {
  const lines = String(text).split('\n');
  const out = {};
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^vision:\s*$/.test(line)) { inSection = true; continue; }
    if (!inSection) continue;
    const child = line.match(/^\s{2}(\S+):\s*(.*)$/);
    if (child) out[child[1]] = parseYamlScalar(child[2]);
    else if (/^\S/.test(line) && line.trim() !== '') break; // 下一 section
  }
  return { ...VISION_DEFAULTS, ...out };
}

/** 把 vision 段写进 settings.yaml 文本（其他内容原样保留）。 */
function renderVisionSection(text, next) {
  const lines = String(text).split('\n');
  const yamlVal = (v) => typeof v === 'string' ? JSON.stringify(v) : String(v);
  const block = [
    'vision:',
    `  enabled: ${!!next.enabled}`,
    `  autoPath: ${!!next.autoPath}`,
    `  baseURL: ${yamlVal(String(next.baseURL ?? ''))}`,
    `  apiKey: ${yamlVal(String(next.apiKey ?? ''))}`,
    `  model: ${yamlVal(String(next.model ?? ''))}`,
    `  timeoutMs: ${Number(next.timeoutMs) || 60000}`,
    `  cache: ${next.cache !== false}`,
    `  cacheTtlSeconds: ${Number(next.cacheTtlSeconds) > 0 ? Number(next.cacheTtlSeconds) : 3600}`,
    `  cacheMaxEntries: ${Number(next.cacheMaxEntries) > 0 ? Number(next.cacheMaxEntries) : 200}`,
  ].join('\n');

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^vision:\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) {
    const head = String(text).trimEnd();
    return head.length > 0 ? head + '\n' + block + '\n' : block + '\n';
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].trim() !== '') { end = i; break; }
  }
  let out = [...lines.slice(0, start), block, ...lines.slice(end)].join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

/** 规范化配置（类型兜底）。 */
function normalizeVisionConfig(patch) {
  const next = { ...VISION_DEFAULTS, ...patch };
  next.enabled = !!next.enabled;
  next.autoPath = next.autoPath !== false;
  next.timeoutMs = Number.isFinite(Number(next.timeoutMs)) && Number(next.timeoutMs) > 0
    ? Number(next.timeoutMs) : VISION_DEFAULTS.timeoutMs;
  next.cache = next.cache !== false;
  next.cacheTtlSeconds = Number.isFinite(Number(next.cacheTtlSeconds)) && Number(next.cacheTtlSeconds) > 0
    ? Number(next.cacheTtlSeconds) : VISION_DEFAULTS.cacheTtlSeconds;
  next.cacheMaxEntries = Number.isFinite(Number(next.cacheMaxEntries)) && Number(next.cacheMaxEntries) > 0
    ? Number(next.cacheMaxEntries) : VISION_DEFAULTS.cacheMaxEntries;
  next.baseURL = String(next.baseURL ?? '').trim();
  next.apiKey = String(next.apiKey ?? '');
  next.model = String(next.model ?? '').trim();
  return next;
}

/** 从磁盘读配置（文件不存在 → 默认值）。 */
function readVisionSettings(file = path.join(require('node:os').homedir(), '.dsh', 'settings.yaml')) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { ...VISION_DEFAULTS }; }
  return parseVisionSection(text);
}

/** 原子写配置（0600，临时文件 + rename）。返回脱敏后的配置（apiKey 只报是否已设置）。 */
function writeVisionSettings(patch, file = path.join(require('node:os').homedir(), '.dsh', 'settings.yaml')) {
  const next = normalizeVisionConfig(patch);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 不存在则新建 */ }
  const out = renderVisionSection(text, next);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { ...next, apiKey: next.apiKey ? '(已设置)' : '' };
}

module.exports = {
  VISION_DEFAULTS, parseYamlScalar, parseVisionSection, renderVisionSection,
  normalizeVisionConfig, readVisionSettings, writeVisionSettings,
};
