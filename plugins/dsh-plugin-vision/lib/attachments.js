/**
 * dsh-plugin-vision — 附件上下文（纯函数 + fs 工具，可单测）
 *
 * 把会话消息里的图片附件（ImageAttachmentRef）转成模型可见的文本清单，
 * 并在附件存储里为每个附件建立带扩展名的可读链接（内容寻址存储的原始
 * 文件无扩展名）。注册为 systemPrompt 动态 context 后，主模型每次请求
 * 都会看到"会话有哪些图片 + 路径"，可据此调用 vision_describe。
 */
import { existsSync, mkdirSync, linkSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';

/** 附件存储根：DSH_HOME/attachments/v1（官方 attachment-local 的 versioned root）。 */
export function attachmentsRoot(dshHome = process.env.DSH_HOME || join(os.homedir(), '.dsh')) {
  return join(dshHome, 'attachments', 'v1');
}

/** 附件原始文件（内容寻址，无扩展名）。 */
export function objectPath(root, id) {
  return join(root, 'objects', String(id).slice(0, 2), String(id));
}

/** 可读链接目录（插件自有，不干扰官方 objects/tmp）。 */
export function visibleDir(root) {
  return join(root, 'visible');
}

const EXT_BY_MEDIA = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp',
};

/** 幂等建立可读链接（硬链接优先，跨设备回退软链）。返回链接路径。 */
export function ensureVisibleLink(root, id, mediaType) {
  const src = objectPath(root, id);
  if (!existsSync(src)) return null;
  const ext = EXT_BY_MEDIA[mediaType] || 'img';
  const dir = visibleDir(root);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${String(id)}.${ext}`);
  if (existsSync(target)) return target;
  try {
    linkSync(src, target);
  } catch {
    try { symlinkSync(src, target); } catch { return src; }
  }
  return target;
}

/**
 * 从消息列表收集图片附件引用（内容寻址，同图去重）。
 * @param {Array} messages - session.deriveMessages() 的结果（含 content 块）
 * @returns {Array<{id, mediaType, width, height, name}>}
 */
export function collectImageRefs(messages) {
  const refs = [];
  const seen = new Set();
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block && block.type === 'image' && block.attachment) {
        const a = block.attachment;
        const id = String(a.attachmentId);
        if (seen.has(id)) continue;
        seen.add(id);
        refs.push({
          id,
          mediaType: a.mediaType,
          width: a.width,
          height: a.height,
          name: a.name,
        });
      }
    }
  }
  return refs;
}

/**
 * 渲染模型可见的附件上下文文本（空则返回 ''，不污染提示词）。
 */
export function renderAttachmentContext(refs, root = attachmentsRoot()) {
  if (!refs || refs.length === 0) return '';
  const lines = [];
  const seen = new Set();
  let n = 0;
  for (const ref of refs) {
    if (seen.has(ref.id)) continue; // 同一附件只列一次（内容寻址，重复发送同图只存一份）
    seen.add(ref.id);
    const path = ensureVisibleLink(root, ref.id, ref.mediaType);
    const label = ref.name || `图片${++n}`;
    const meta = `${ref.mediaType || 'image'}${ref.width ? ` ${ref.width}x${ref.height}` : ''}`;
    lines.push(`- ${label}（${meta}）：${path || '(文件缺失)'}`);
  }
  if (lines.length === 0) return '';
  return `用户在本会话中发送了以下图片附件（查看图片内容时调用 vision_describe 工具并传入对应路径）：\n${lines.join('\n')}`;
}
