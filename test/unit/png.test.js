import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanupTempDirs } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLE_DIR = path.join(ROOT, '示例空间', '样品图');
const SIZES = [
  ['样品01.png', 640, 480], ['样品02.png', 800, 600], ['样品03.png', 1024, 768],
  ['样品04.png', 500, 500], ['样品05.png', 1200, 900], ['样品06.png', 320, 240],
  ['样品07.png', 960, 540], ['样品08.png', 700, 500], ['样品09.png', 2000, 1200],
  ['样品10.png', 0, 0],
];
const samplePath = (name) => path.join(SAMPLE_DIR, name);
const readSample = (name) => fs.readFileSync(samplePath(name));

let png = null;
let pngLoadError = '';
try {
  png = await import(pathToFileURL(path.join(ROOT, 'node-agent', 'lib', 'png.js')).href);
} catch (err) {
  pngLoadError = String(err && err.message ? err.message : err);
}
const samplesReady = SIZES.slice(0, 9).every(([name]) => fs.existsSync(samplePath(name)));
const skip = png
  ? (samplesReady ? false : '示例空间/样品图 未生成：先运行 python scripts/gen-samples.py')
  : 'node-agent/lib/png.js 未就绪：' + pngLoadError;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pixelAt = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

after(cleanupTempDirs);

test('png 模块导出齐全（decode/encode/crop/pngSize/isPng/crc32/PngError）', { skip }, () => {
  for (const name of ['decodePng', 'encodePng', 'cropCenter', 'cropPng', 'crop', 'pngSize', 'isPng', 'crc32', 'PngError']) {
    assert.equal(typeof png[name], 'function', '缺少导出 ' + name);
  }
  assert.equal(typeof png.default, 'object');
});

test('pngSize：9 张样品尺寸与生成器约定一致', { skip }, () => {
  for (const [name, width, height] of SIZES.slice(0, 9)) {
    assert.deepEqual(png.pngSize(readSample(name)), { width, height }, name);
  }
});

test('decodePng：输出 RGBA 4 通道，data 长度 = w*h*4', { skip }, () => {
  const img = png.decodePng(readSample('样品01.png'));
  assert.equal(img.width, 640);
  assert.equal(img.height, 480);
  assert.equal(img.channels, 4);
  assert.equal(img.data.length, 640 * 480 * 4);
});

test('isPng / PNG 签名：正常图片为真，垃圾数据为假', { skip }, () => {
  const buf = readSample('样品01.png');
  assert.equal(png.isPng(buf), true);
  assert.equal(buf.subarray(0, 8).equals(PNG_MAGIC), true);
  assert.equal(png.isPng(Buffer.from('not a png')), false);
  assert.equal(png.isPng(Buffer.alloc(0)), false);
});

test('cropPng：中心裁剪 128 → 合法 PNG 且尺寸为 128×128', { skip }, () => {
  const out = png.cropPng(readSample('样品01.png'), 128);
  assert.ok(Buffer.isBuffer(out));
  assert.equal(png.isPng(out), true);
  const img = png.decodePng(out);
  assert.equal(img.width, 128);
  assert.equal(img.height, 128);
  assert.equal(img.channels, 4);
});

test('cropCenter：返回宽高为 size 的 RGBA 图像，数据长度正确', { skip }, () => {
  const img = png.decodePng(readSample('样品05.png'));
  const out = png.cropCenter(img, 256);
  assert.equal(out.width, 256);
  assert.equal(out.height, 256);
  assert.equal(out.channels, 4);
  assert.equal(out.data.length, 256 * 256 * 4);
});

test('cropCenter：确实是居中裁剪（裁剪中心像素 = 原图中心像素）', { skip }, () => {
  const img = png.decodePng(readSample('样品04.png'));
  const size = 200;
  const out = png.cropCenter(img, size);
  assert.deepEqual(pixelAt(out, size / 2, size / 2), pixelAt(img, img.width / 2, img.height / 2));
});

test('crop：目标尺寸大于原图时仍成功（居中补边，输出可以大于原图）', { skip }, () => {
  const src = png.decodePng(readSample('样品06.png'));
  assert.equal(src.width, 320);
  const out = png.cropCenter(src, 1024);
  assert.equal(out.width, 1024);
  assert.equal(out.height, 1024);
  assert.deepEqual(pixelAt(out, 512, 512), pixelAt(src, 160, 120));
});

test('cropPng：9 张样品全都能裁成 1024 方图（种子任务 ① 的平台能力前提）', { skip }, () => {
  for (const [name] of SIZES.slice(0, 9)) {
    const out = png.cropPng(readSample(name), 1024);
    const img = png.decodePng(out);
    assert.equal(img.width, 1024, name);
    assert.equal(img.height, 1024, name);
  }
});

test('损坏文件：0 字节样品10.png → PngError(code=CORRUPT)', { skip }, () => {
  const broken = readSample('样品10.png');
  assert.equal(broken.length, 0);
  assert.throws(() => png.decodePng(broken), (err) => err instanceof png.PngError && err.code === 'CORRUPT');
});

test('损坏文件：截断的 PNG → PngError(code=CORRUPT)', { skip }, () => {
  const truncated = readSample('样品01.png').subarray(0, 120);
  assert.throws(() => png.decodePng(truncated), (err) => err instanceof png.PngError && err.code === 'CORRUPT');
});

test('crc32：标准校验值 123456789 → 0xCBF43926', { skip }, () => {
  assert.equal(png.crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('encodePng：解码→编码→再解码，尺寸与像素保持一致', { skip }, () => {
  const original = png.decodePng(readSample('样品02.png'));
  const encoded = png.encodePng(original);
  assert.equal(png.isPng(encoded), true);
  const again = png.decodePng(encoded);
  assert.equal(again.width, original.width);
  assert.equal(again.height, original.height);
  assert.deepEqual(pixelAt(again, 10, 10), pixelAt(original, 10, 10));
  assert.deepEqual(pixelAt(again, again.width - 5, again.height - 5), pixelAt(original, original.width - 5, original.height - 5));
});

test('PngError：是 Error 子类并带 code', { skip }, () => {
  const err = new png.PngError('坏图', 'CORRUPT');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'PngError');
  assert.equal(err.code, 'CORRUPT');
});