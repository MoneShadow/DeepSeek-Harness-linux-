/**
 * dsh-plugin-vision — 单元测试（node --test）
 * 覆盖：图片源转换（本地路径/file:///URL）、请求体构造、响应解析、
 * 错误与超时、配置缺失提示。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSourceToUrl, describeImage } from '../lib/describe.js';

const OPTS = {
  baseURL: 'https://vision.test/v1',
  apiKey: 'sk-test',
  model: 'vision-model',
  timeoutMs: 5000,
};

test('imageSourceToUrl: 本地 PNG 转 data URL', async () => {
  const url = await imageSourceToUrl('/home/mone/dsh-desktop/assets/icon.png');
  assert.ok(url.startsWith('data:image/png;base64,'));
  assert.ok(url.length > 100);
});

test('imageSourceToUrl: file:// 前缀与 JPEG 扩展名', async () => {
  const url = await imageSourceToUrl('file:///home/mone/dsh-desktop/assets/icon-source.jpg');
  assert.ok(url.startsWith('data:image/jpeg;base64,'));
});

test('imageSourceToUrl: http URL 透传', async () => {
  assert.equal(
    await imageSourceToUrl('https://example.com/a.png'),
    'https://example.com/a.png'
  );
});

test('imageSourceToUrl: 不存在的文件报错', async () => {
  await assert.rejects(() => imageSourceToUrl('/nonexistent/x.png'), /读取|ENOENT/);
});

test('describeImage: 请求体构造正确（image_url 为 data URL）', async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '一只蓝色的鲸鱼' } }] }),
    };
  };
  const out = await describeImage(OPTS, { image: '/home/mone/dsh-desktop/assets/icon.png' }, { fetch: fakeFetch });
  assert.equal(out, '一只蓝色的鲸鱼');
  assert.equal(captured.url, 'https://vision.test/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test');
  const content = JSON.parse(captured.init.body).messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].type, 'image_url');
  assert.ok(content[1].image_url.url.startsWith('data:image/png;base64,'));
});

test('describeImage: 自定义 prompt 生效', async () => {
  let body = null;
  const fakeFetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  await describeImage(OPTS, { image: '/home/mone/dsh-desktop/assets/icon.png', prompt: '图里有什么文字？' }, { fetch: fakeFetch });
  assert.equal(body.messages[0].content[0].text, '图里有什么文字？');
});

test('describeImage: HTTP 错误返回详情文本', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'invalid api key' });
  const out = await describeImage(OPTS, { image: '/home/mone/dsh-desktop/assets/icon.png' }, { fetch: fakeFetch });
  assert.match(out, /HTTP 401/);
  assert.match(out, /invalid api key/);
});

test('describeImage: 网络错误返回提示而非 throw', async () => {
  const fakeFetch = async () => { throw new Error('ECONNREFUSED'); };
  const out = await describeImage(OPTS, { image: '/home/mone/dsh-desktop/assets/icon.png' }, { fetch: fakeFetch });
  assert.match(out, /请求失败：ECONNREFUSED/);
});

test('describeImage: 超时中止', async () => {
  const fakeFetch = async (url, init) => {
    await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  const out = await describeImage({ ...OPTS, timeoutMs: 50 }, { image: '/home/mone/dsh-desktop/assets/icon.png' }, { fetch: fakeFetch });
  assert.match(out, /超时|aborted/);
});

test('describeImage: 未配置 apiKey 返回引导', async () => {
  const out = await describeImage({ ...OPTS, apiKey: '' }, { image: '/home/mone/dsh-desktop/assets/icon.png' });
  assert.match(out, /apiKey/);
});

test('describeImage: 空响应提示', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) });
  const out = await describeImage(OPTS, { image: '/home/mone/dsh-desktop/assets/icon.png' }, { fetch: fakeFetch });
  assert.match(out, /返回内容为空/);
});
