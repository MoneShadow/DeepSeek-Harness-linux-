/**
 * dsh-plugin-vision — 图片描述核心（纯函数，可单测）
 *
 * 职责：把图片源（本地路径 / file:// / http(s):// URL）转成 OpenAI 兼容
 * /chat/completions 的 image_url 内容块，调用视觉模型，返回文本描述。
 * 不在本文件引入 Cordis 依赖。
 *
 * 缓存：describeImageCached 按"图片内容哈希 + 端点 + prompt"查/写 AnswerCache，
 * 命中时返回与首次完全相同的文本（对主模型透明）。错误文本（vision_describe
 * 前缀）一律不缓存。
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { sha256Hex } from './cache.js';

/** 未传 prompt 时的默认提问（与 cacheKeyFor 共用，保证 key 一致）。 */
export const DEFAULT_PROMPT =
  '请详细描述这张图片的内容，包括主体、布局、颜色、文字（如有）与整体风格。';

/** 按文件头 magic bytes 嗅探 MIME（无扩展名文件兜底，如附件内容寻址存储）。 */
export function sniffImageMime(buf) {
  if (!buf || buf.length < 3) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 6) {
    const head = buf.toString('latin1', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
};

/**
 * 图片源 → { bytes, mime, url }。本地文件读入内存并转 data URL（bytes 供
 * 内容哈希缓存）；http(s) URL 直接透传（bytes=null，不下载——发给视觉 API
 * 服务端解析，缓存键退化为 URL 字符串）。
 * @throws 本地文件缺失 / 超限时抛错（由调用方转成用户可见错误文本）
 */
export async function loadImage(source, { maxBytes = 10 * 1024 * 1024 } = {}) {
  const s = String(source).trim();
  if (!s) throw new Error('image 为空');
  if (/^https?:\/\//i.test(s)) return { bytes: null, mime: null, url: s };
  const filePath = s.startsWith('file://') ? decodeURIComponent(new URL(s).pathname) : resolve(s);
  const bytes = await readFile(filePath);
  if (bytes.length > maxBytes) {
    throw new Error(`图片 ${filePath} 大小 ${bytes.length} 字节超过上限 ${maxBytes}`);
  }
  const ext = extname(filePath).toLowerCase().replace('.', '');
  // 扩展名映射优先，无扩展名/未知扩展名时按内容嗅探（内容寻址存储的附件无扩展名）
  const mime = EXT_MIME[ext] || sniffImageMime(bytes) || 'application/octet-stream';
  return { bytes, mime, url: `data:${mime};base64,${bytes.toString('base64')}` };
}

/** 图片源 → data URL 或直接返回 http(s) URL（loadImage 的字符串投影，兼容旧调用）。 */
export async function imageSourceToUrl(source, opts) {
  const { url } = await loadImage(source, opts);
  return url;
}

/**
 * 用已加载的图片调用 OpenAI 兼容视觉 API 描述图片（describeImage /
 * describeImageCached 共用的请求核心）。
 * @param {object} opts - { baseURL, apiKey, model, timeoutMs }（baseURL/apiKey/model 已校验非空）
 * @param {string} prompt - 已解析的提问（非空）
 * @param {object} loaded - loadImage 的返回 { bytes, mime, url }
 * @param {object} [runtime] - 注入 { fetch } 便于测试；默认全局 fetch
 * @returns {Promise<string>} 模型返回的文本；请求失败时返回带详情的错误文本（不 throw，
 *   让主模型能读到并据此向用户说明）
 */
export async function describeLoaded(opts, prompt, loaded, runtime = {}) {
  const fetchImpl = runtime.fetch || globalThis.fetch;
  const baseURL = String(opts.baseURL || '').replace(/\/+$/, '');
  const apiKey = String(opts.apiKey || '');
  const model = String(opts.model || '');
  const timeoutMs = Number(opts.timeoutMs) || 60000;

  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: loaded.url } },
      ],
    }],
    max_tokens: 1024,
  };

  const controller = new AbortController();
  const killer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    return `vision_describe 请求失败：${e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : e.message}`;
  } finally {
    clearTimeout(killer);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
    return `vision_describe API 错误：HTTP ${res.status}${detail ? ` — ${detail}` : ''}`;
  }

  try {
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      return 'vision_describe 返回内容为空（模型未输出描述）';
    }
    return text.trim();
  } catch (e) {
    return `vision_describe 响应解析失败：${e.message}`;
  }
}

/**
 * 调用 OpenAI 兼容视觉 API 描述图片（无缓存版，行为与旧版一致）。
 * @param {object} opts - { baseURL, apiKey, model, timeoutMs }
 * @param {object} args - { image, prompt }
 * @param {object} [runtime] - 注入 { fetch } 便于测试；默认全局 fetch
 * @returns {Promise<string>} 模型返回的文本；请求失败时返回带详情的错误文本（不 throw，
 *   让主模型能读到并据此向用户说明）
 */
export async function describeImage(opts, args, runtime = {}) {
  const baseURL = String(opts.baseURL || '').replace(/\/+$/, '');
  const apiKey = String(opts.apiKey || '');
  const model = String(opts.model || '');

  if (!baseURL) return 'vision_describe 未配置：缺少 baseURL（请在设置→插件配置中填写）';
  if (!apiKey) return 'vision_describe 未配置：缺少 apiKey（请在设置→插件配置中填写）';
  if (!model) return 'vision_describe 未配置：缺少 model（请在设置→插件配置中填写）';

  let loaded;
  try {
    loaded = await loadImage(args.image);
  } catch (e) {
    return `vision_describe 读取图片失败：${e.message}`;
  }
  const prompt = String(args.prompt || '').trim() || DEFAULT_PROMPT;
  return describeLoaded({ baseURL, apiKey, model, timeoutMs: opts.timeoutMs }, prompt, loaded, runtime);
}

/**
 * 缓存键：图片内容哈希（本地文件=字节哈希；远程 URL=URL 哈希）+ 端点 + 模型 + prompt。
 * 任一维度不同（不同图 / 不同服务 / 不同提问）都不会互相污染。
 */
export function cacheKeyFor(loaded, baseURL, model, prompt) {
  const id = loaded.bytes ? sha256Hex(loaded.bytes) : sha256Hex(String(loaded.url));
  return `${id}|${baseURL}|${model}|${prompt}`;
}

/** 只有真实描述结果可缓存；错误提示（vision_describe 前缀）一律不缓存。 */
export function isCacheable(text) {
  return typeof text === 'string' && !text.startsWith('vision_describe ');
}

/**
 * 带缓存的描述调用（工具 handler 使用）：配置校验 → 加载图片 → 查缓存 →
 * 未命中调用 API → 成功结果写入缓存。
 * @param {object} opts - { baseURL, apiKey, model, timeoutMs, cacheTtlMs }
 * @param {object} args - { image, prompt }
 * @param {AnswerCache|null} cache - 缓存实例；传 null 表示关闭缓存（直通）
 * @param {object} [runtime] - 注入 { fetch } 便于测试；默认全局 fetch
 * @returns {Promise<string>} 与 describeImage 相同语义的文本
 */
export async function describeImageCached(opts, args, cache, runtime = {}) {
  const baseURL = String(opts.baseURL || '').replace(/\/+$/, '');
  const apiKey = String(opts.apiKey || '');
  const model = String(opts.model || '');

  if (!baseURL) return 'vision_describe 未配置：缺少 baseURL（请在设置→插件配置中填写）';
  if (!apiKey) return 'vision_describe 未配置：缺少 apiKey（请在设置→插件配置中填写）';
  if (!model) return 'vision_describe 未配置：缺少 model（请在设置→插件配置中填写）';

  let loaded;
  try {
    loaded = await loadImage(args.image);
  } catch (e) {
    return `vision_describe 读取图片失败：${e.message}`;
  }
  const prompt = String(args.prompt || '').trim() || DEFAULT_PROMPT;

  if (!cache) {
    return describeLoaded({ baseURL, apiKey, model, timeoutMs: opts.timeoutMs }, prompt, loaded, runtime);
  }
  const key = cacheKeyFor(loaded, baseURL, model, prompt);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const text = await describeLoaded({ baseURL, apiKey, model, timeoutMs: opts.timeoutMs }, prompt, loaded, runtime);
  if (isCacheable(text)) {
    cache.set(key, text, opts.cacheTtlMs); // undefined → 使用实例默认 ttlMs
  }
  return text;
}
