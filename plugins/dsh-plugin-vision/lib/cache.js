/**
 * dsh-plugin-vision — 视觉答案缓存（纯内存，可单测）
 *
 * 按"图片内容哈希 + 端点 + prompt"缓存描述结果，TTL 过期 + LRU 上限淘汰，
 * 引擎进程生命周期内有效，不落盘（避免脏数据与文件 IO）。命中时返回与
 * 首次调用完全相同的文本——对主模型透明，省去重复的视觉 API 调用。
 */
import { createHash } from 'node:crypto';

/** sha256 hex（接受 string 或 Buffer）。 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 简单的 TTL + LRU 上限缓存。
 * - get() 命中时刷新 LRU 顺序（重新插入到队尾）；
 * - set() 超限时淘汰最久未使用的条目（Map 迭代序 = 插入序 = LRU 序）；
 * - ttlMs / maxEntries 可在运行时直接改字段，下一次 set 生效（配置热更新友好）。
 */
export class AnswerCache {
  constructor({ ttlMs = 3600_000, maxEntries = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this._map = new Map();
  }

  get size() {
    return this._map.size;
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this._map.delete(key); // 惰性过期：读时发现即清除
      return undefined;
    }
    this._map.delete(key); // 刷新 LRU 顺序
    this._map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (ttlMs <= 0) return; // 非正 TTL = 不缓存
    this._map.delete(key);
    this._map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this._map.size > this.maxEntries) {
      const oldest = this._map.keys().next().value;
      if (oldest === undefined) break;
      this._map.delete(oldest);
    }
  }

  clear() {
    this._map.clear();
  }
}
