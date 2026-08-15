/**
 * dsh-plugin-vision — 图片描述核心（纯函数，可单测）
 *
 * 职责：把图片源（本地路径 / file:// / http(s):// URL）转成 OpenAI 兼容
 * /chat/completions 的 image_url 内容块，调用视觉模型，返回文本描述。
 * 不在本文件引入 Cordis 依赖。
 */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

/** 图片源 → data URL 或直接返回 http(s) URL。 */
export async function imageSourceToUrl(source, { maxBytes = 10 * 1024 * 1024 } = {}) {
  const s = String(source).trim();
  if (!s) throw new Error('image 为空');
  if (/^https?:\/\//i.test(s)) return s; // 远程 URL 直接透传（注意：会发给视觉 API 服务端）
  // 本地路径（含 file:// 前缀）
  const filePath = s.startsWith('file://') ? decodeURIComponent(new URL(s).pathname) : resolve(s);
  const buf = await readFile(filePath);
  if (buf.length > maxBytes) {
    throw new Error(`图片 ${filePath} 大小 ${buf.length} 字节超过上限 ${maxBytes}`);
  }
  const ext = extname(filePath).toLowerCase().replace('.', '');
  // 扩展名映射优先，无扩展名/未知扩展名时按内容嗅探（内容寻址存储的附件无扩展名）
  const mime = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  }[ext] || sniffImageMime(buf) || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * 调用 OpenAI 兼容视觉 API 描述图片。
 * @param {object} opts - { baseURL, apiKey, model, timeoutMs }
 * @param {object} args - { image, prompt }
 * @param {object} [runtime] - 注入 { fetch } 便于测试；默认全局 fetch
 * @returns {Promise<string>} 模型返回的文本；请求失败时返回带详情的错误文本（不 throw，
 *   让主模型能读到并据此向用户说明）
 */
export async function describeImage(opts, args, runtime = {}) {
  const fetchImpl = runtime.fetch || globalThis.fetch;
  const baseURL = String(opts.baseURL || '').replace(/\/+$/, '');
  const apiKey = String(opts.apiKey || '');
  const model = String(opts.model || '');
  const timeoutMs = Number(opts.timeoutMs) || 60000;

  if (!baseURL) return 'vision_describe 未配置：缺少 baseURL（请在设置→插件配置中填写）';
  if (!apiKey) return 'vision_describe 未配置：缺少 apiKey（请在设置→插件配置中填写）';
  if (!model) return 'vision_describe 未配置：缺少 model（请在设置→插件配置中填写）';

  let imageUrl;
  try {
    imageUrl = await imageSourceToUrl(args.image);
  } catch (e) {
    return `vision_describe 读取图片失败：${e.message}`;
  }

  const prompt = String(args.prompt || '').trim() ||
    '请详细描述这张图片的内容，包括主体、布局、颜色、文字（如有）与整体风格。';

  const body = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageUrl } },
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
