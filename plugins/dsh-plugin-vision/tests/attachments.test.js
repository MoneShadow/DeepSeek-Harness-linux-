/**
 * dsh-plugin-vision — 附件上下文单测
 * 覆盖：mime 嗅探（无扩展名）、附件引用收集/去重、可读链接幂等、上下文文本渲染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sniffImageMime, imageSourceToUrl } from '../lib/describe.js';
import {
  attachmentsRoot, objectPath, ensureVisibleLink,
  collectImageRefs, renderAttachmentContext,
} from '../lib/attachments.js';

test('sniffImageMime: PNG/JPEG/WebP/GIF/BMP magic bytes', () => {
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png');
  assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImageMime(Buffer.from('RIFF\x00\x00\x00\x00WEBP', 'latin1')), 'image/webp');
  assert.equal(sniffImageMime(Buffer.from('GIF89a\x00', 'latin1')), 'image/gif');
  assert.equal(sniffImageMime(Buffer.from([0x42, 0x4d, 0x00])), 'image/bmp');
  assert.equal(sniffImageMime(Buffer.from('plain text')), null);
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
});

test('imageSourceToUrl: 无扩展名文件按内容嗅探为 PNG', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-mime-'));
  const noext = path.join(dir, 'hashfile'); // 无扩展名（模拟内容寻址存储）
  fs.copyFileSync('/home/mone/dsh-desktop/assets/icon.png', noext);
  const url = await imageSourceToUrl(noext);
  assert.ok(url.startsWith('data:image/png;base64,'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('attachmentsRoot/objectPath: 目录推导', () => {
  const root = attachmentsRoot('/tmp/fake-dsh');
  assert.equal(root, '/tmp/fake-dsh/attachments/v1');
  assert.equal(objectPath(root, 'abc123'), '/tmp/fake-dsh/attachments/v1/objects/ab/abc123');
});

test('ensureVisibleLink: 幂等建链（两次调用同一路径）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-link-'));
  const root = path.join(dir, 'v1');
  fs.mkdirSync(path.dirname(objectPath(root, 'abcd1234')), { recursive: true });
  fs.writeFileSync(objectPath(root, 'abcd1234'), 'img-bytes');
  const p1 = ensureVisibleLink(root, 'abcd1234', 'image/png');
  const p2 = ensureVisibleLink(root, 'abcd1234', 'image/png');
  assert.equal(p1, p2);
  assert.ok(p1.endsWith('abcd1234.png'));
  assert.equal(fs.readFileSync(p1, 'utf8'), 'img-bytes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ensureVisibleLink: 源文件缺失返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-link-'));
  assert.equal(ensureVisibleLink(path.join(dir, 'v1'), 'nope', 'image/png'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('collectImageRefs: 提取 image 块并去重', () => {
  const messages = [
    { content: [{ type: 'text', text: 'hi' }] },
    { content: [{ type: 'image', attachment: { attachmentId: 'aaa', mediaType: 'image/png', width: 10, height: 20 } }] },
    { content: [{ type: 'image', attachment: { attachmentId: 'aaa', mediaType: 'image/png' } }, { type: 'image', attachment: { attachmentId: 'bbb', mediaType: 'image/jpeg' } }] },
  ];
  const refs = collectImageRefs(messages);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].id, 'aaa');
  assert.equal(refs[1].id, 'bbb');
});

test('renderAttachmentContext: 空附件返回空串（不污染提示词）', () => {
  assert.equal(renderAttachmentContext([]), '');
  assert.equal(renderAttachmentContext(null), '');
});

test('renderAttachmentContext: 渲染清单含路径（同一附件去重）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-ctx-'));
  const root = path.join(dir, 'v1');
  fs.mkdirSync(path.dirname(objectPath(root, 'aaaa1111')), { recursive: true });
  fs.writeFileSync(objectPath(root, 'aaaa1111'), 'x');
  const text = renderAttachmentContext([
    { id: 'aaaa1111', mediaType: 'image/png', width: 100, height: 50, name: '截图.png' },
    { id: 'aaaa1111', mediaType: 'image/png' }, // 重复，应去重
  ], root);
  assert.match(text, /截图\.png/);
  assert.match(text, /100x50/);
  assert.match(text, /aaaa1111\.png/);
  assert.equal((text.match(/aaaa1111\.png/g) || []).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
