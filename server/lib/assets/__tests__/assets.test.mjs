// 榫卯 v2 · 素材中心 · 单元 + 集成测试（node:test）
// 覆盖：流式哈希/去重、图片元数据+EXIF+320/640 webp、OCR 真实召回、搜索/过滤/分页、
//       谱系事件与引用、超级中转站、缩略图二进制、HTTP 路由（含 multipart 上传与鉴权）、500 张图性能。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Ledger } from '../../ledger.js';
import { createAssetService, createRouteDispatcher } from '../index.js';
import { sha256Stream, sha256Buffer, dedupeKey } from '../hashing.js';
import { parseExifBuffer, kindOf } from '../metadata.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const RUNDIR = path.join(ROOT, '_internal', 'assets-test-' + RUN_ID);
const FIX = path.join(RUNDIR, 'fixtures');
const DATA = path.join(RUNDIR, 'data');
const LEDGER_DIR = path.join(RUNDIR, 'ledger');
const OCR_CACHE = path.join(ROOT, '_internal', 'assets-ocr-cache');

const STATE = { tasks: {} };
let ledger = null;
let svc = null;
const ctx = {};

function fixture(name) {
  return path.join(FIX, name);
}

function fileHead(file, start, end) {
  return fs.readFileSync(file).subarray(start, end).toString('ascii');
}

before(async () => {
  fs.mkdirSync(FIX, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  // 真实含字图片（OCR 用）
  const svg = Buffer.from(
    '<svg width="800" height="260" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="100%" height="100%" fill="white"/>' +
      '<text x="40" y="170" font-size="104" font-family="Arial" fill="black">TENON ASSET 2026</text>' +
      '</svg>',
  );
  await sharp(svg).png().toFile(fixture('tenon-text.png'));
  fs.copyFileSync(fixture('tenon-text.png'), fixture('copy-of-text.png'));
  // 带 EXIF 的真实 JPEG
  await sharp(svg)
    .jpeg()
    .withMetadata({
      exif: {
        IFD0: { Make: 'TenonMake', Model: 'T1-Model', Orientation: '1' },
        IFD2: { DateTimeOriginal: '2026:10:25 21:30:00' },
      },
    })
    .toFile(fixture('photo.jpg'));
  fs.writeFileSync(fixture('note-a.txt'), 'hello tenon alpha', 'utf8');
  fs.writeFileSync(fixture('note-b.txt'), 'hello tenon beta', 'utf8');
  fs.writeFileSync(fixture('route-note.txt'), 'route ingest via http', 'utf8');
  fs.writeFileSync(fixture('lineage-note.txt'), 'lineage asset note', 'utf8');
  fs.writeFileSync(fixture('doc.pdf'), Buffer.from('%PDF-1.4 fake pdf content for metadata test', 'utf8'));
  fs.writeFileSync(fixture('clip.mp4'), Buffer.from('fake mp4 bytes', 'utf8'));

  ledger = new Ledger(LEDGER_DIR);
  svc = createAssetService({
    ledger,
    state: STATE,
    root: ROOT,
    dataDir: DATA,
    options: { ocrCacheDir: OCR_CACHE, ocrTimeoutMs: 240000 },
  });
  ctx.svc = svc;
  ctx.ledger = ledger;
});

after(async () => {
  try { if (svc) await svc.close(); } catch { /* ignore */ }
  try { fs.rmSync(RUNDIR, { recursive: true, force: true }); } catch { /* ignore */ }
  // 保留 OCR 语言包缓存（_internal/assets-ocr-cache）以便复跑
});

test('hashing：流式 SHA-256 与去重键', async () => {
  const file = fixture('hash-probe.bin');
  const buf = crypto.randomBytes(128 * 1024);
  fs.writeFileSync(file, buf);
  const streamed = await sha256Stream(file);
  assert.equal(streamed.sha256, crypto.createHash('sha256').update(buf).digest('hex'));
  assert.equal(streamed.size, buf.length);
  assert.equal(sha256Buffer(buf), streamed.sha256);
  assert.equal(dedupeKey(streamed.sha256), 'sha256:' + streamed.sha256);
  const empty = Buffer.alloc(0);
  assert.equal(sha256Buffer(empty), crypto.createHash('sha256').update(empty).digest('hex'));
});

test('metadata：后缀识别 + EXIF 解析器基础字段', () => {
  assert.equal(kindOf('a.PNG').kind, 'image');
  assert.equal(kindOf('b.mp4').kind, 'video');
  assert.equal(kindOf('c.pdf').kind, 'pdf');
  assert.equal(kindOf('d.docx').kind, 'doc');
  assert.equal(kindOf('noext').kind, 'other');
  const fake = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from('bad', 'utf8')]);
  assert.deepEqual(parseExifBuffer(fake), {});
  assert.deepEqual(parseExifBuffer(null), {});
});

test('图片入库：元数据 + EXIF + 320/640 webp 缩略图', async () => {
  const result = await svc.ingest({ deviceId: 'node-local', filePath: fixture('photo.jpg') });
  const asset = result.asset;
  assert.equal(result.deduped, false);
  assert.equal(asset.kind, 'image');
  assert.equal(asset.mime, 'image/jpeg');
  assert.match(asset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(asset.size, fs.statSync(fixture('photo.jpg')).size);
  assert.ok(asset.image, '应解析图片尺寸');
  assert.equal(asset.image.width, 800);
  assert.equal(asset.image.height, 260);
  assert.equal(asset.exif.Make, 'TenonMake');
  assert.equal(asset.exif.Model, 'T1-Model');
  assert.ok(String(asset.exif.DateTimeOriginal || '').includes('2026'));
  assert.ok(asset.thumb && asset.thumb['320'] && asset.thumb['640'], '应有 320/640 缩略图');
  for (const size of ['320', '640']) {
    const file = path.join(DATA, asset.thumb[size]);
    assert.ok(fs.existsSync(file), '缩略图文件存在 ' + size);
    assert.equal(fileHead(file, 0, 4), 'RIFF');
    assert.equal(fileHead(file, 8, 12), 'WEBP');
  }
  assert.equal(asset.ocr.status, 'pending');
  const indexFile = path.join(DATA, 'assets', 'index.json');
  assert.ok(fs.existsSync(indexFile), '索引文件应落盘');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.equal(index.assets[asset.id].sha256, asset.sha256);
  ctx.photoAsset = asset;
});

test('非图片素材：只存元数据，不生成缩略图/不送 OCR', async () => {
  const pdf = await svc.ingest({ deviceId: 'node-local', filePath: fixture('doc.pdf') });
  assert.equal(pdf.asset.kind, 'pdf');
  assert.equal(pdf.asset.thumb, null);
  assert.equal(pdf.asset.ocr.status, 'skipped');
  const mp4 = await svc.ingest({ deviceId: 'node-local', filePath: fixture('clip.mp4') });
  assert.equal(mp4.asset.kind, 'video');
  assert.equal(mp4.asset.thumb, null);
  const txt = await svc.ingest({ deviceId: 'node-local', filePath: fixture('note-a.txt') });
  assert.equal(txt.asset.kind, 'text');
  assert.equal(txt.asset.ocr.status, 'skipped');
  ctx.textAsset = txt.asset;
});

test('OCR：chi_sim+eng 真实含字图片可召回（首次自动下载语言包）', { timeout: 300000 }, async () => {
  const result = await svc.ingest({ deviceId: 'node-local', filePath: fixture('tenon-text.png') });
  const assetId = result.asset.id;
  assert.equal(result.asset.ocr.status, 'pending');
  const status = await svc.waitForOcr({ timeoutMs: 280000 });
  assert.equal(status.failed, 0, 'OCR 队列失败：' + status.lastError);
  const asset = svc.get(assetId);
  assert.equal(asset.ocr.status, 'done', 'OCR 状态应为 done：' + JSON.stringify(asset.ocr.lastError || asset.ocr));
  assert.ok((asset.ocr.text || '').length > 0, 'OCR 文本为空');
  assert.match(asset.ocr.text.toUpperCase(), /TENON|ASSET/);
  assert.equal(typeof asset.ocr.confidence, 'number');
  const hit = svc.list({ q: 'TENON' });
  assert.ok(hit.items.some((item) => item.id === assetId), 'OCR 文本应可被搜索召回');
  const stats = await svc.stats();
  assert.ok(stats.ocr.processed >= 2, 'OCR 队列应处理过图片');
  ctx.ocrAsset = asset;
});

test('去重：同内容不同文件名只留一条记录；跨设备记 occurrences 并补账本事件', async () => {
  const before = svc.list({ limit: 1 }).total;
  const sameFile = await svc.ingest({ deviceId: 'node-local', filePath: fixture('copy-of-text.png') });
  assert.equal(sameFile.deduped, true);
  assert.equal(sameFile.asset.id, ctx.ocrAsset.id);
  const crossDevice = await svc.ingest({ deviceId: 'android-phone', filePath: fixture('tenon-text.png') });
  assert.equal(crossDevice.deduped, true);
  assert.equal(crossDevice.crossDeviceEvent, true, '跨设备重复入库应补 asset.ingested 事件');
  assert.equal(svc.list({ limit: 1 }).total, before, '去重后总记录数不增加');
  const refreshed = svc.get(ctx.ocrAsset.id);
  assert.ok(refreshed.occurrences.length >= 2, 'occurrences 应记录多次出现');
  const events = svc.lineage(ctx.ocrAsset.id).events.filter((e) => e.type === 'asset.ingested');
  assert.ok(events.length >= 2, '应有跨设备 asset.ingested 事件');
});

test('搜索/过滤/分页：q 命中 name/tags/ocrText；kind/device/时间过滤；limit/offset', async () => {
  svc.tag(ctx.photoAsset.id, ['合同', '样张'], 'user');
  assert.ok(svc.list({ q: 'photo' }).items.some((a) => a.id === ctx.photoAsset.id), 'q 命中文件名');
  assert.ok(svc.list({ q: '样张' }).items.some((a) => a.id === ctx.photoAsset.id), 'q 命中标签');
  assert.ok(svc.list({ q: 'TENON' }).items.some((a) => a.id === ctx.ocrAsset.id), 'q 命中 OCR 文本');
  const textOnly = svc.list({ kind: 'text' });
  assert.ok(textOnly.total >= 1, '至少应有 1 个文本素材');
  assert.ok(textOnly.items.every((a) => a.kind === 'text'));
  const byDevice = svc.list({ device: 'node-local' });
  assert.ok(byDevice.total >= 1);
  assert.ok(byDevice.items.every((a) => a.source.deviceId === 'node-local'));
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.equal(svc.list({ from: future }).total, 0, '未来时间过滤应为空');
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.ok(svc.list({ from: past }).total > 0);
  const page1 = svc.list({ limit: 2, offset: 0 });
  const page2 = svc.list({ limit: 2, offset: 2 });
  assert.equal(page1.items.length, 2);
  assert.equal(page2.items.length, 2);
  assert.notEqual(page1.items[0].id, page2.items[0].id);
  assert.equal(page1.total, page2.total);
  assert.ok(page1.limit === 2 && page1.offset === 0);
  const byTagSource = svc.list({ q: '合同' });
  assert.ok(byTagSource.items.some((a) => a.id === ctx.photoAsset.id));
});

test('谱系：ingest/tag/share/remove 事件 + state.tasks 引用查询 + 账本事件字段', async () => {
  const result = await svc.ingest({ deviceId: 'node-local', filePath: fixture('lineage-note.txt') });
  const id = result.asset.id;
  svc.tag(id, '归档', 'user');
  svc.share(id, 'dev-pc', 'basket');
  svc.tag(id, ['ai自动'], 'ai');
  svc.setState({
    tasks: {
      task_ref_1: {
        id: 'task_ref_1',
        status: 'queued',
        text: '把 lineage-note.txt 打印一份',
        draft: { params: { file: 'lineage-note.txt' } },
      },
    },
  });
  const lin = svc.lineage(id);
  const types = lin.events.map((e) => e.type);
  for (const expected of ['asset.ingested', 'asset.tagged', 'asset.shared']) {
    assert.ok(types.includes(expected), '缺少谱系事件 ' + expected);
  }
  assert.ok(lin.refs.tasks.some((t) => t.id === 'task_ref_1'), 'state.tasks 中的引用应被识别');
  assert.ok(lin.events.filter((e) => e.type === 'asset.tagged').some((e) => e.data.by === 'ai'));
  svc.remove(id, '用户移除测试');
  const afterRemove = svc.lineage(id);
  assert.ok(afterRemove.events.some((e) => e.type === 'asset.removed'));
  assert.equal(svc.list({ q: 'lineage-note' }).total, 0, '已移除素材不在默认列表');
  assert.ok(svc.list({ q: 'lineage-note', includeRemoved: true }).total >= 1);
  assert.equal(svc.get(id).removed, true);
  svc.setState(STATE);
  assert.equal(ledger.integrity().ok, true, JSON.stringify(ledger.integrity().gaps));
});

test('超级中转站：素材 + 外部文件 + link transfer 引用；按目标设备一次取用', async () => {
  const added = svc.basketAdd({
    items: [
      { assetId: ctx.photoAsset.id },
      { name: 'manual-note.txt', kind: 'text', size: 12 },
      { transferId: 'tr_test_123', name: 'big.bin', size: 1048576 },
    ],
    to: 'dev-pc',
    deviceId: 'android-phone',
  });
  assert.equal(added.count, 3);
  const staged = svc.basketList({ status: 'staged' });
  assert.equal(staged.items.length, 3);
  assert.ok(staged.items.some((it) => it.asset && it.asset.id === ctx.photoAsset.id), '素材条目应带缩略图 URL');
  assert.ok(staged.items.some((it) => it.ref && it.ref.type === 'link-transfer' && it.ref.transferId === 'tr_test_123'));
  const taken = svc.basketTake({ to: 'dev-pc', deviceId: 'dev-pc' });
  assert.equal(taken.count, 3);
  assert.ok(taken.taken.every((it) => it.status === 'taken' && it.takenAt));
  assert.equal(svc.basketList({ status: 'staged' }).items.length, 0);
  assert.equal(svc.basketList({ includeTaken: true }).items.length, 3);
  const basketFile = path.join(DATA, 'basket', 'basket.json');
  assert.ok(fs.existsSync(basketFile));
  const raw = JSON.parse(fs.readFileSync(basketFile, 'utf8'));
  assert.equal(raw.items.length, 3);
  ctx.basketIds = taken.taken.map((it) => it.id);
  const cleared = svc.basketClear({ ids: ctx.basketIds });
  assert.equal(cleared.removed, 3);
});

test('缩略图二进制 + HTTP 路由（list/detail/thumb/ingest/tags/basket/stats/lineage）', { timeout: 120000 }, async () => {
  const t320 = await svc.thumb(ctx.photoAsset.id, 320);
  assert.equal(t320.mime, 'image/webp');
  assert.equal(t320.buffer.subarray(0, 4).toString('ascii'), 'RIFF');
  const t160 = await svc.thumb(ctx.photoAsset.id, 160);
  const meta160 = await sharp(t160.buffer).metadata();
  assert.ok(meta160.width <= 160);
  await assert.rejects(
    () => svc.thumb('asset_not_exists', 320),
    (err) => err.statusCode === 404 && err.code === 'ASSET_NOT_FOUND',
  );

  const dispatch = createRouteDispatcher(svc.routes);
  const server = http.createServer(async (req, res) => {
    const handled = await dispatch(req, res, {
      checkAuth: (r) => r.headers['x-tenon-token'] === 'test-token',
    });
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"not found"}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const auth = { 'Content-Type': 'application/json', 'x-tenon-token': 'test-token' };
  try {
    let res = await fetch(base + '/api/v2/assets?q=TENON');
    let json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.ok(json.items.some((a) => a.id === ctx.ocrAsset.id), 'HTTP 列表应能按 OCR 文本搜索');

    res = await fetch(base + '/api/v2/assets/stats');
    json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.total >= 4);
    assert.equal(json.deps.sharp, true);

    res = await fetch(base + '/api/v2/assets/' + ctx.photoAsset.id);
    json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.asset.id, ctx.photoAsset.id);
    assert.ok(json.lineage && Array.isArray(json.lineage.events));

    res = await fetch(base + '/api/v2/assets/' + ctx.photoAsset.id + '/thumb?w=320');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
    const thumbBuf = Buffer.from(await res.arrayBuffer());
    assert.equal(thumbBuf.subarray(0, 4).toString('ascii'), 'RIFF');

    res = await fetch(base + '/api/v2/assets/' + ctx.photoAsset.id + '/lineage');
    json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.assetId, ctx.photoAsset.id);

    // 写操作鉴权：无令牌 401
    res = await fetch(base + '/api/v2/assets/' + ctx.photoAsset.id + '/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['无令牌'] }),
    });
    assert.equal(res.status, 401, '写操作必须要求令牌');
    res = await fetch(base + '/api/v2/assets/' + ctx.photoAsset.id + '/tags', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ tags: ['路由标签'] }),
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.ok(json.asset.tags.includes('路由标签'));

    // JSON 入库
    res = await fetch(base + '/api/v2/assets/ingest', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ deviceId: 'node-local', path: fixture('route-note.txt') }),
    });
    json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.count, 1);
    assert.equal(json.items[0].asset.kind, 'text');

    // multipart 上传入库
    const boundary = '----tenonTest' + Date.now();
    const pngBuf = await sharp({ create: { width: 640, height: 200, channels: 3, background: { r: 12, g: 200, b: 120 } } })
      .png()
      .toBuffer();
    const multipart = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="deviceId"\r\n\r\nandroid-phone\r\n'),
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="upload-unique.png"\r\nContent-Type: image/png\r\n\r\n'),
      pngBuf,
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    res = await fetch(base + '/api/v2/assets/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'x-tenon-token': 'test-token' },
      body: multipart,
    });
    json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.count, 1);
    assert.equal(json.items[0].deduped, false);
    const uploadedId = json.items[0].asset.id;
    const uploadedAbs = path.join(DATA, json.items[0].asset.storedPath || '');
    assert.ok(json.items[0].asset.storedPath, '上传文件应保存到数据目录');

    // 中转站 HTTP：加/列/取
    res = await fetch(base + '/api/v2/assets/basket', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ items: [{ assetId: uploadedId }], to: 'dev-pc' }),
    });
    json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.count, 1);
    res = await fetch(base + '/api/v2/assets/basket');
    json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(json.items.some((it) => it.assetId === uploadedId));
    res = await fetch(base + '/api/v2/assets/basket/take', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ to: 'dev-pc', deviceId: 'dev-pc' }),
    });
    json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.count, 1);
    assert.equal(json.taken[0].status, 'taken');
    // 中转站：DELETE 批量移除 / 清空（body 可带 ids 或空 = 清空全部）
    res = await fetch(base + '/api/v2/assets/basket', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        items: [
          { name: 'del-a.txt', kind: 'text', size: 3 },
          { name: 'del-b.txt', kind: 'text', size: 4 },
        ],
        to: 'dev-pc',
      }),
    });
    json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.count, 2);
    const addedItems = json.added;
    assert.ok(Array.isArray(addedItems) && addedItems.length === 2);

    // 无令牌 DELETE → 401
    res = await fetch(base + '/api/v2/assets/basket', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [addedItems[0].id] }),
    });
    assert.equal(res.status, 401, 'DELETE 必须要求令牌');

    // 带令牌 DELETE 指定 ids → removed=1，remaining 为剩余条目数
    res = await fetch(base + '/api/v2/assets/basket', {
      method: 'DELETE',
      headers: auth,
      body: JSON.stringify({ ids: [addedItems[0].id] }),
    });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.removed, 1);
    assert.equal(typeof json.remaining, 'number');
    assert.ok(Array.isArray(json.items));
    assert.ok(!json.items.some((it) => it.id === addedItems[0].id), '指定条目应被删除');
    assert.equal(json.remaining, json.items.length);

    // 空 body → 清空全部
    res = await fetch(base + '/api/v2/assets/basket', { method: 'DELETE', headers: auth, body: '' });
    json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.ok(json.removed >= 1);
    assert.equal(json.remaining, 0);
    assert.deepEqual(json.items, []);

    // 清空后 GET 仍返回 {ok, items:[]}（前端契约）
    res = await fetch(base + '/api/v2/assets/basket');
    json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.items));
    assert.equal(json.items.length, 0);

    // 账本应记录 basket.updated（供 state.js 分支与 SSE 实时刷新）
    const basketUpdatedEvents = ledger.events.filter((e) => e.type === 'basket.updated');
    assert.ok(basketUpdatedEvents.length >= 2, '应有 basket.updated 事件');
    assert.ok(Array.isArray(basketUpdatedEvents[basketUpdatedEvents.length - 1].data.items));

    // 未命中路由返回 false（由挂载器处理 404）
    res = await fetch(base + '/api/v2/not-exists');
    assert.equal(res.status, 404);
    void uploadedAbs;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('性能：500 张图片建索引 < 60s，二次扫描去重；搜索/分页/index.json 一致', { timeout: 180000 }, async () => {
  const perfRoot = path.join(RUNDIR, 'perf');
  const imagesDir = path.join(perfRoot, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  const perfLedger = new Ledger(path.join(perfRoot, 'ledger'));
  const perfService = createAssetService({
    ledger: perfLedger,
    state: { tasks: {} },
    root: ROOT,
    dataDir: path.join(perfRoot, 'data'),
    options: { ocrEnabled: false },
  });
  try {
    const genStart = Date.now();
    for (let i = 0; i < 500; i += 1) {
      const name = 'img-' + String(i).padStart(3, '0') + '.png';
      // 颜色周期 251 + 尺寸周期 37/23 → 500 张内容哈希互不相同（保证不去重）
      await sharp({
        create: {
          width: 40 + (i % 37),
          height: 30 + (i % 23),
          channels: 3,
          background: { r: i % 251, g: (i * 7) % 251, b: (i * 13) % 251 },
        },
      })
        .png()
        .toFile(path.join(imagesDir, name));
    }
    const genMs = Date.now() - genStart;
    const t0 = Date.now();
    const result = await perfService.ingestDirectory({ deviceId: 'import-pc', dir: imagesDir });
    const ingestMs = Date.now() - t0;
    assert.equal(result.directory, true);
    assert.equal(result.scanned, 500);
    assert.equal(result.count, 500);
    assert.equal(result.deduped, 0);
    assert.equal(result.failed, 0, JSON.stringify(result.errors));
    assert.ok(ingestMs < 60000, '500 张图建索引应 < 60s，实际 ' + ingestMs + 'ms');
    const stats = await perfService.stats();
    assert.equal(stats.total, 500);
    assert.equal(stats.byKind.image, 500);
    assert.equal(stats.ocr.pending, 0);
    const indexFile = path.join(perfRoot, 'data', 'assets', 'index.json');
    assert.ok(fs.existsSync(indexFile));
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    assert.equal(Object.keys(index.assets).length, 500);
    const page = perfService.list({ limit: 20, offset: 480 });
    assert.equal(page.items.length, 20);
    assert.equal(page.total, 500);
    assert.ok(page.items.every((a) => a.thumb && a.thumb['320'] && a.thumb['640']), '每张图都应有双尺寸缩略图');

    const t1 = Date.now();
    const again = await perfService.ingestDirectory({ deviceId: 'import-pc', dir: imagesDir });
    const rescanMs = Date.now() - t1;
    assert.equal(again.deduped, 500, '二次扫描应全部去重');
    assert.equal((await perfService.stats()).total, 500, '二次扫描不应新增记录');
    ctx.perf = { genMs, ingestMs, rescanMs, indexBytes: fs.statSync(indexFile).size };
    console.log(
      '[perf] 500 图：生成 ' + genMs + 'ms；建索引 ' + ingestMs + 'ms；二次扫描去重 ' + rescanMs + 'ms；index.json ' + fs.statSync(indexFile).size + 'B',
    );
  } finally {
    await perfService.close();
  }
});

test('账本：素材事件符合契约 §3 字段，哈希链完整；routes 鉴权标记齐全', async () => {
  const assetEvents = ledger.events.filter((e) => String(e.type).startsWith('asset.'));
  assert.ok(assetEvents.length >= 5, '至少应有入库/标签/分享/移除事件');
  const ingested = assetEvents.find((e) => e.type === 'asset.ingested');
  for (const key of ['assetId', 'sha256', 'kind', 'name', 'size', 'source', 'at']) {
    assert.ok(Object.prototype.hasOwnProperty.call(ingested.data, key), 'asset.ingested 缺少字段 ' + key);
  }
  assert.ok(ingested.data.source && 'deviceId' in ingested.data.source && 'path' in ingested.data.source);
  const tagged = assetEvents.find((e) => e.type === 'asset.tagged');
  assert.ok(['ai', 'user'].includes(tagged.data.by), 'asset.tagged.by 必须是 ai|user');
  assert.ok(Array.isArray(tagged.data.tags));
  const shared = assetEvents.find((e) => e.type === 'asset.shared');
  assert.ok('assetId' in shared.data && 'to' in shared.data && 'kind' in shared.data);
  const removed = assetEvents.find((e) => e.type === 'asset.removed');
  assert.ok('reason' in removed.data);
  assert.equal(ledger.integrity().ok, true, JSON.stringify(ledger.integrity().gaps));

  const routes = svc.routes;
  const writes = routes.filter((r) => r.method !== 'GET');
  assert.ok(writes.length >= 4);
  assert.ok(writes.every((r) => r.auth === true), '所有写路由都应带 auth 标记');
  assert.ok(routes.some((r) => r.method === 'GET' && r.path === '/api/v2/assets/:id/thumb'), '缩略图路由存在');
  assert.equal(typeof createRouteDispatcher(routes), 'function');
});
test('OCR 降级：语言包不可用时不拖垮模块（ocr.status=failed，入库/搜索/统计仍可用）', { timeout: 90000 }, async () => {
  const degRoot = path.join(RUNDIR, 'degrade');
  const degLedger = new Ledger(path.join(degRoot, 'ledger'));
  const degService = createAssetService({
    ledger: degLedger,
    state: { tasks: {} },
    root: ROOT,
    dataDir: path.join(degRoot, 'data'),
    options: {
      ocrCacheDir: path.join(degRoot, 'ocr-cache'),
      tessdataTemplate: 'http://127.0.0.1:1/{lang}.traineddata.gz',
      ocrTimeoutMs: 15000,
    },
  });
  try {
    const result = await degService.ingest({ deviceId: 'degrade-pc', filePath: fixture('tenon-text.png') });
    assert.equal(result.asset.kind, 'image');
    await degService.waitForOcr({ timeoutMs: 60000 });
    const asset = degService.get(result.asset.id);
    assert.equal(asset.ocr.status, 'failed', '语言包不可用时 OCR 应显式 failed 而不是让服务崩溃');
    assert.ok(asset.ocr.error, 'failed 应记录错误原因');
    assert.ok(fs.existsSync(path.join(degRoot, 'data', 'assets', 'index.json')));
    const stats = await degService.stats();
    assert.equal(stats.total, 1, '入库不受 OCR 失败影响');
    assert.equal(degService.list({ q: 'tenon-text' }).total, 1, '搜索不受 OCR 失败影响');
    assert.equal((await degService.stats()).ocr.failed, 1);
  } finally {
    await degService.close();
  }
});