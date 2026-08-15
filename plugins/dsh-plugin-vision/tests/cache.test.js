/**
 * dsh-plugin-vision — 缓存单元测试（node --test）
 * 覆盖：sha256、AnswerCache（TTL/LRU/非正 TTL/清空）、缓存键构造、
 * describeImageCached（命中/未命中/不同 prompt/错误不缓存/关闭缓存/过期/配置引导）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex, AnswerCache } from '../lib/cache.js';
import { cacheKeyFor, describeImageCached, loadImage, DEFAULT_PROMPT } from '../lib/describe.js';

const OPTS = {
  baseURL: 'https://vision.test/v1',
  apiKey: 'sk-test',
  model: 'vision-model',
  timeoutMs: 5000,
  cacheTtlMs: 60_000,
};

const PNG = '/home/mone/dsh-desktop/assets/icon.png';
const JPG = '/home/mone/dsh-desktop/assets/icon-source.jpg';

test('sha256Hex: 已知向量', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('sha256Hex: Buffer 与字符串一致', () => {
  assert.equal(sha256Hex(Buffer.from('abc')), sha256Hex('abc'));
});

test('AnswerCache: 未命中返回 undefined', () => {
  const c = new AnswerCache();
  assert.equal(c.get('nope'), undefined);
  assert.equal(c.size, 0);
});

test('AnswerCache: set/get 命中', () => {
  const c = new AnswerCache();
  c.set('k', 'v1');
  assert.equal(c.get('k'), 'v1');
  assert.equal(c.size, 1);
});

test('AnswerCache: TTL 过期后未命中并清除', async () => {
  const c = new AnswerCache();
  c.set('k', 'v1', 20);
  assert.equal(c.get('k'), 'v1');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(c.get('k'), undefined);
  assert.equal(c.size, 0);
});

test('AnswerCache: 非正 TTL 不缓存', () => {
  const c = new AnswerCache();
  c.set('k', 'v1', 0);
  c.set('k2', 'v2', -5);
  assert.equal(c.size, 0);
  assert.equal(c.get('k'), undefined);
});

test('AnswerCache: 超上限按 LRU 淘汰最旧', () => {
  const c = new AnswerCache({ maxEntries: 2 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3); // 淘汰 a
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
});

test('AnswerCache: get 刷新 LRU 顺序', () => {
  const c = new AnswerCache({ maxEntries: 2 });
  c.set('a', 1);
  c.set('b', 2);
  c.get('a'); // a 变最新
  c.set('c', 3); // 应淘汰 b（最旧），保留 a
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('c'), 3);
});

test('AnswerCache: 覆盖写入与 clear', () => {
  const c = new AnswerCache();
  c.set('k', 'v1');
  c.set('k', 'v2');
  assert.equal(c.get('k'), 'v2');
  assert.equal(c.size, 1);
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.get('k'), undefined);
});

test('cacheKeyFor: 同图同配置同 prompt → 同键', async () => {
  const a = await loadImage(PNG);
  const b = await loadImage(PNG);
  assert.equal(cacheKeyFor(a, 'https://x/v1', 'm1', '问'), cacheKeyFor(b, 'https://x/v1', 'm1', '问'));
});

test('cacheKeyFor: prompt / 模型 / 端点不同 → 键不同', async () => {
  const a = await loadImage(PNG);
  const base = cacheKeyFor(a, 'https://x/v1', 'm1', '问');
  assert.notEqual(cacheKeyFor(a, 'https://x/v1', 'm1', '另一个问题'), base);
  assert.notEqual(cacheKeyFor(a, 'https://x/v1', 'm2', '问'), base);
  assert.notEqual(cacheKeyFor(a, 'https://y/v1', 'm1', '问'), base);
});

test('describeImageCached: 空 prompt 与默认提问命中同一缓存', async () => {
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const cache = new AnswerCache();
  await describeImageCached(OPTS, { image: PNG, prompt: '' }, cache, { fetch: fakeFetch });
  await describeImageCached(OPTS, { image: PNG, prompt: DEFAULT_PROMPT }, cache, { fetch: fakeFetch });
  assert.equal(fetches, 1); // 两次请求键一致 → 第二次命中缓存
});

test('cacheKeyFor: 不同图片内容 → 键不同；远程 URL 用 URL 哈希', async () => {
  const png = await loadImage(PNG);
  const jpg = await loadImage(JPG);
  assert.notEqual(cacheKeyFor(png, 'u', 'm', 'q'), cacheKeyFor(jpg, 'u', 'm', 'q'));
  const remote = await loadImage('https://example.com/a.png');
  assert.equal(cacheKeyFor(remote, 'u', 'm', 'q'), cacheKeyFor(remote, 'u', 'm', 'q'));
  assert.notEqual(cacheKeyFor(remote, 'u', 'm', 'q'), cacheKeyFor(png, 'u', 'm', 'q'));
});

test('describeImageCached: 同图同 prompt 二次命中缓存（只请求一次）', async () => {
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '一只蓝色的鲸鱼' } }] }) };
  };
  const cache = new AnswerCache();
  const out1 = await describeImageCached(OPTS, { image: PNG }, cache, { fetch: fakeFetch });
  const out2 = await describeImageCached(OPTS, { image: PNG }, cache, { fetch: fakeFetch });
  assert.equal(out1, '一只蓝色的鲸鱼');
  assert.equal(out2, '一只蓝色的鲸鱼');
  assert.equal(fetches, 1);
});

test('describeImageCached: 不同 prompt 不命中缓存', async () => {
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: `答案${fetches}` } }] }) };
  };
  const cache = new AnswerCache();
  await describeImageCached(OPTS, { image: PNG, prompt: '问题A' }, cache, { fetch: fakeFetch });
  await describeImageCached(OPTS, { image: PNG, prompt: '问题B' }, cache, { fetch: fakeFetch });
  assert.equal(fetches, 2);
});

test('describeImageCached: 错误结果不缓存（HTTP 错误每次重试）', async () => {
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    return { ok: false, status: 401, text: async () => 'invalid api key' };
  };
  const cache = new AnswerCache();
  const out1 = await describeImageCached(OPTS, { image: PNG }, cache, { fetch: fakeFetch });
  const out2 = await describeImageCached(OPTS, { image: PNG }, cache, { fetch: fakeFetch });
  assert.match(out1, /HTTP 401/);
  assert.match(out2, /HTTP 401/);
  assert.equal(fetches, 2);
  assert.equal(cache.size, 0); // 错误文本未写入缓存
});

test('describeImageCached: cache=null 关闭缓存（每次请求）', async () => {
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  await describeImageCached(OPTS, { image: PNG }, null, { fetch: fakeFetch });
  await describeImageCached(OPTS, { image: PNG }, null, { fetch: fakeFetch });
  assert.equal(fetches, 2);
});

test('describeImageCached: TTL 过期后重新请求', async () => {
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const cache = new AnswerCache();
  await describeImageCached({ ...OPTS, cacheTtlMs: 20 }, { image: PNG }, cache, { fetch: fakeFetch });
  await new Promise((r) => setTimeout(r, 40));
  await describeImageCached({ ...OPTS, cacheTtlMs: 20 }, { image: PNG }, cache, { fetch: fakeFetch });
  assert.equal(fetches, 2);
});

test('describeImageCached: cacheTtlMs 缺省时用缓存实例默认 ttl', async () => {
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const cache = new AnswerCache({ ttlMs: 60_000 });
  await describeImageCached(OPTS, { image: PNG }, cache, { fetch: fakeFetch });
  await describeImageCached(OPTS, { image: PNG }, cache, { fetch: fakeFetch });
  assert.equal(fetches, 1);
});

test('describeImageCached: 图片读取失败返回错误文本且不请求', async () => {
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  const cache = new AnswerCache();
  const out = await describeImageCached(OPTS, { image: '/nonexistent/x.png' }, cache, { fetch: fakeFetch });
  assert.match(out, /读取图片失败/);
  assert.equal(fetches, 0);
});

test('describeImageCached: 配置缺失返回引导且不缓存', async () => {
  const cache = new AnswerCache();
  const out = await describeImageCached({ ...OPTS, apiKey: '' }, { image: PNG }, cache);
  assert.match(out, /apiKey/);
  assert.equal(cache.size, 0);
});

test('describeImageCached: 命中缓存时响应与首次完全一致（含多余空白修剪）', async () => {
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '  描述内容  \n' } }] }) };
  };
  const cache = new AnswerCache();
  const out1 = await describeImageCached(OPTS, { image: PNG }, cache, { fetch: fakeFetch });
  const out2 = await describeImageCached(OPTS, { image: PNG }, cache, { fetch: fakeFetch });
  assert.equal(out1, '描述内容');
  assert.equal(out2, out1);
  assert.equal(fetches, 1);
});
