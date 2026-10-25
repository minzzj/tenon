// 榫卯 v2 · 素材中心 · 服务入口
// createAssetService({ledger,state,root,dataDir,options}) -> service（含 routes）
// 职责：入库/去重/缩略图/OCR/搜索/谱系/中转站/缩略图二进制路由。
import fs from 'node:fs';
import path from 'node:path';
import { hashFile, sha256Buffer } from './hashing.js';
import { depsStatus, kindOf, makeThumbnails, probeFile, resizeWebp } from './metadata.js';
import { OcrQueue, DEFAULT_OCR_LANGS } from './ocr.js';
import { AssetStore } from './store.js';
import { Basket } from './basket.js';
import { createLineage } from './lineage.js';
import { createAssetRoutes, createRouteDispatcher, httpError, sendError, sendJson } from './routes.js';
import { ensureDir, newId, nowIso, safeFileName, toPosix } from './util.js';

export { createAssetRoutes, createRouteDispatcher, httpError, sendError, sendJson };
export { AssetStore, OcrQueue };
export { createLineage };

const DEFAULT_LIMIT = 50;

function insideBase(abs, base) {
  const rel = path.relative(base, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeTags(tags) {
  const out = [];
  for (const tag of Array.isArray(tags) ? tags : [tags]) {
    const value = String(tag == null ? '' : tag).trim().slice(0, 64);
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

export function createAssetService({ ledger, state = { tasks: {} }, root = process.cwd(), dataDir, options = {} } = {}) {
  if (!ledger || typeof ledger.append !== 'function') throw new Error('createAssetService 需要 ledger（Ledger 实例）');
  if (!dataDir) throw new Error('createAssetService 需要 dataDir');

  const absRoot = path.resolve(root);
  const absData = path.resolve(dataDir);
  const assetsDir = path.join(absData, 'assets');
  const thumbsDir = path.join(assetsDir, 'thumbs');
  const uploadsDir = path.join(assetsDir, 'uploads');
  ensureDir(thumbsDir);
  ensureDir(uploadsDir);

  const allowOutsideRoot = !!options.allowOutsideRoot;
  const store = new AssetStore({ dataDir: absData });
  const basket = new Basket({ dataDir: absData });
  const ocr = new OcrQueue({
    langs: options.ocrLangs || process.env.TENON_ASSETS_OCR_LANGS || DEFAULT_OCR_LANGS,
    cacheDir: options.ocrCacheDir ? path.resolve(absRoot, options.ocrCacheDir) : path.join(assetsDir, 'ocr-cache'),
    langPathTemplate: options.tessdataTemplate || null,
    onDownloadProgress: options.onOcrDownloadProgress || null,
    logger: options.ocrLogger || null,
    enabled: options.ocrEnabled !== undefined ? options.ocrEnabled : process.env.TENON_ASSETS_OCR !== '0',
    timeoutMs: options.ocrTimeoutMs || 240000,
    maxText: options.ocrMaxText || 8000,
  });
  const stateRef = { current: state || { tasks: {} } };
  const lineage = createLineage({ ledger, getState: () => stateRef.current, actor: options.actor || 'hub' });
  let dedupeHits = 0;

  function relFromData(abs) {
    return toPosix(path.relative(absData, abs));
  }

  function resolveInput(p) {
    const raw = String(p == null ? '' : p);
    if (!raw) throw httpError('缺少文件路径', 400, 'MISSING_PATH');
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.normalize(path.join(absRoot, raw));
    if (allowOutsideRoot) return { abs, raw };
    if (insideBase(abs, absRoot) || insideBase(abs, absData)) return { abs, raw };
    throw httpError('路径越界：只允许仓库根或数据目录内的文件（' + raw + '）', 403, 'PATH_OUTSIDE_ROOT');
  }

  async function statPath(filePath) {
    const { abs } = resolveInput(filePath);
    try {
      return await fs.promises.stat(abs);
    } catch {
      throw httpError('文件不存在：' + filePath, 404, 'ASSET_SOURCE_NOT_FOUND');
    }
  }

  function serialize(rec, { trimOcr = false } = {}) {
    if (!rec) return null;
    const out = { ...rec };
    out.thumbUrls = rec.thumb
      ? {
          320: '/api/v2/assets/' + rec.id + '/thumb?w=320',
          640: '/api/v2/assets/' + rec.id + '/thumb?w=640',
        }
      : null;
    if (trimOcr && out.ocr) {
      out.ocr = { ...out.ocr, text: String(out.ocr.text || '').slice(0, 400) };
    }
    return out;
  }

  function queueOcr(record, abs) {
    if (!ocr.enabled || record.kind !== 'image') {
      record.ocr = { status: 'skipped', text: '', error: null, lang: null, confidence: null, at: null };
      return false;
    }
    record.ocr = { status: 'pending', text: '', error: null, lang: ocr.langs, confidence: null, at: null };
    ocr.run({
      assetId: record.id,
      filePath: abs,
      onResult: (result) => {
        store.update(record.id, {
          ocr: {
            status: result.status,
            text: result.text || '',
            error: result.error || null,
            lang: result.lang,
            confidence: result.confidence,
            at: result.at,
            ms: result.ms,
          },
        });
        store.flush();
      },
    });
    return true;
  }

  async function ingestResolved({ deviceId = 'hub', abs, raw, name, origin = 'ingest', knownSha256 = null, knownSize = null, storedPath = null }) {
    const stat = await fs.promises.stat(abs);
    if (stat.isDirectory()) throw httpError('目标是目录，请使用 ingestDirectory 或传入文件路径', 400, 'IS_DIRECTORY');
    const hashed = knownSha256
      ? { sha256: knownSha256, size: knownSize == null ? stat.size : knownSize }
      : await hashFile(abs);
    const sha256 = hashed.sha256;
    const size = knownSize == null ? hashed.size : knownSize;
    const existing = store.findBySha(sha256);
    if (existing && !existing.removed) {
      dedupeHits += 1;
      const at = nowIso();
      existing.occurrences = Array.isArray(existing.occurrences)
        ? existing.occurrences
        : [{ deviceId: (existing.source && existing.source.deviceId) || 'hub', path: (existing.source && existing.source.path) || '', at: existing.createdAt }];
      if (existing.occurrences.length < 20) existing.occurrences.push({ deviceId, path: raw, at, origin });
      existing.lastSeenAt = at;
      store.flush();
      let crossDeviceEvent = false;
      if (deviceId && existing.source && existing.source.deviceId && existing.source.deviceId !== deviceId) {
        lineage.recordIngest(
          { id: existing.id, sha256, kind: existing.kind, name: existing.name, size, source: { deviceId, path: raw }, createdAt: at },
          at,
        );
        crossDeviceEvent = true;
      }
      return { asset: existing, deduped: true, ocrQueued: false, crossDeviceEvent };
    }
    const displayName = name || path.basename(abs);
    const info = kindOf(displayName);
    const record = {
      id: newId('asset'),
      sha256,
      kind: info.kind,
      ext: info.ext,
      mime: info.mime,
      name: displayName,
      size,
      source: { deviceId, path: raw, origin, mtimeMs: stat.mtimeMs || null },
      storedPath: storedPath || null,
      thumb: null,
      thumbError: null,
      image: null,
      exif: null,
      imageError: null,
      ocr: { status: 'skipped', text: '', error: null, lang: null, confidence: null, at: null },
      tags: [],
      shares: [],
      removed: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastSeenAt: null,
      occurrences: [{ deviceId, path: raw, at: nowIso(), origin }],
    };
    if (info.kind === 'image') {
      const meta = await probeFile(abs, displayName);
      record.image = meta.image;
      record.exif = meta.exif;
      record.imageError = meta.imageError;
      try {
        const thumbs = await makeThumbnails(abs, { outDir: thumbsDir, key: sha256 });
        record.thumb = {};
        for (const [size, absThumb] of Object.entries(thumbs)) record.thumb[size] = relFromData(absThumb);
      } catch (err) {
        record.thumbError = String((err && err.message) || err);
      }
    }
    const queued = queueOcr(record, abs);
    store.add(record);
    store.flush();
    lineage.recordIngest(record);
    return { asset: record, deduped: false, ocrQueued: queued, crossDeviceEvent: false };
  }

  async function ingest({ deviceId = 'hub', filePath, name = null, origin = 'ingest' } = {}) {
    const { abs, raw } = resolveInput(filePath);
    return ingestResolved({ deviceId, abs, raw, name: name || path.basename(abs), origin });
  }

  async function ingestBuffer({ deviceId = 'upload', name = 'upload.bin', buffer, origin = 'upload' } = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw httpError('上传内容为空', 400, 'EMPTY_UPLOAD');
    const sha256 = sha256Buffer(buffer);
    const existing = store.findBySha(sha256);
    if (existing && !existing.removed) {
      const at = nowIso();
      dedupeHits += 1;
      existing.lastSeenAt = at;
      existing.occurrences = Array.isArray(existing.occurrences) ? existing.occurrences : [];
      if (existing.occurrences.length < 20) existing.occurrences.push({ deviceId, path: name, at, origin });
      store.flush();
      return { asset: existing, deduped: true, ocrQueued: false, crossDeviceEvent: false };
    }
    const safe = safeFileName(name || 'upload.bin');
    const dest = path.join(uploadsDir, sha256.slice(0, 2), sha256.slice(0, 16) + '-' + safe);
    ensureDir(path.dirname(dest));
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, buffer);
    const result = await ingestResolved({
      deviceId,
      abs: dest,
      raw: name,
      name: safe,
      origin,
      knownSha256: sha256,
      knownSize: buffer.length,
      storedPath: relFromData(dest),
    });
    result.asset.originalName = name;
    result.asset.source = { ...result.asset.source, originalName: name, path: relFromData(dest) };
    store.flush();
    return result;
  }

  function walkFiles(dir, { recursive = true, limit = 5000 } = {}) {
    const out = [];
    const stack = [dir];
    while (stack.length && out.length < limit) {
      const current = stack.shift();
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (out.length >= limit) break;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (recursive) stack.push(full);
          continue;
        }
        if (entry.isFile()) out.push(full);
      }
    }
    return out;
  }

  async function ingestDirectory({ deviceId = 'hub', dir, recursive = true, limit = 5000 } = {}) {
    const { abs, raw } = resolveInput(dir);
    let stat;
    try {
      stat = await fs.promises.stat(abs);
    } catch {
      throw httpError('目录不存在：' + dir, 404, 'ASSET_SOURCE_NOT_FOUND');
    }
    if (!stat.isDirectory()) throw httpError('不是目录：' + dir, 400, 'NOT_DIRECTORY');
    const files = walkFiles(abs, { recursive, limit: Math.max(1, Number(limit) || 5000) });
    const started = Date.now();
    const items = [];
    const errors = [];
    let deduped = 0;
    for (const file of files) {
      try {
        const result = await ingestResolved({
          deviceId,
          abs: file,
          raw: path.relative(absRoot, file),
          name: path.basename(file),
          origin: 'scan',
        });
        if (result.deduped) deduped += 1;
        items.push({ id: result.asset.id, name: result.asset.name, kind: result.asset.kind, deduped: result.deduped });
      } catch (err) {
        errors.push({ path: path.relative(absRoot, file), error: String((err && err.message) || err) });
      }
    }
    store.flush();
    return {
      directory: true,
      dir: raw,
      scanned: files.length,
      count: items.length,
      deduped,
      failed: errors.length,
      ms: Date.now() - started,
      errors: errors.slice(0, 20),
      items,
    };
  }

  function list(query = {}) {
    const result = store.list({
      q: query.q || '',
      kind: query.kind || '',
      device: query.device || '',
      from: query.from || '',
      to: query.to || '',
      limit: query.limit || DEFAULT_LIMIT,
      offset: query.offset || 0,
      includeRemoved: !!query.includeRemoved,
    });
    return { ...result, items: result.items.map((rec) => serialize(rec, { trimOcr: true })) };
  }

  function get(id, { lineage: withLineage = false } = {}) {
    const rec = store.get(id);
    if (!rec) {
      if (withLineage) throw httpError('素材不存在：' + id, 404, 'ASSET_NOT_FOUND');
      return null;
    }
    if (withLineage) return { asset: serialize(rec), lineage: buildLineage(rec) };
    return serialize(rec);
  }

  function tag(id, tags, by = 'user') {
    const rec = store.get(id);
    if (!rec) throw httpError('素材不存在：' + id, 404, 'ASSET_NOT_FOUND');
    const normalized = normalizeTags(tags);
    if (!normalized.length) throw httpError('缺少有效标签', 400, 'MISSING_TAGS');
    const before = new Set(rec.tags || []);
    rec.tags = [...new Set([...(rec.tags || []), ...normalized])];
    rec.updatedAt = nowIso();
    store.flush();
    const added = normalized.filter((t) => !before.has(t));
    if (added.length) lineage.recordTag(id, added, by === 'ai' ? 'ai' : 'user');
    return serialize(rec);
  }

  function share(id, to, kind = 'link') {
    const rec = store.get(id);
    if (!rec) throw httpError('素材不存在：' + id, 404, 'ASSET_NOT_FOUND');
    rec.shares = Array.isArray(rec.shares) ? rec.shares : [];
    rec.shares.push({ to: String(to == null ? '' : to), kind: String(kind || 'link'), at: nowIso() });
    rec.updatedAt = nowIso();
    store.flush();
    const ev = lineage.recordShare(id, to, kind);
    return { asset: serialize(rec), event: { seq: ev.seq, type: ev.type, at: ev.at, data: ev.data } };
  }

  function remove(id, reason = '') {
    const rec = store.get(id);
    if (!rec) throw httpError('素材不存在：' + id, 404, 'ASSET_NOT_FOUND');
    if (!rec.removed) {
      store.markRemoved(id, reason);
      store.flush();
      lineage.recordRemove(id, reason);
    }
    return serialize(rec);
  }

  function buildLineage(rec) {
    const refs = lineage.references(rec);
    const basketItems = basket
      .list({ includeTaken: true })
      .filter((it) => it.assetId === rec.id)
      .map((it) => ({ id: it.id, status: it.status, to: it.to, createdAt: it.createdAt, takenAt: it.takenAt }));
    return {
      assetId: rec.id,
      source: rec.source,
      occurrences: rec.occurrences || [],
      events: lineage.eventsFor(rec.id),
      refs: { tasks: refs.tasks, transfers: refs.transfers, baskets: basketItems },
      tags: rec.tags || [],
      shares: rec.shares || [],
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
  }

  function lineageOf(id) {
    const rec = store.get(id);
    if (!rec) throw httpError('素材不存在：' + id, 404, 'ASSET_NOT_FOUND');
    return buildLineage(rec);
  }

  async function thumb(id, width = 640) {
    const rec = store.get(id);
    if (!rec) throw httpError('素材不存在：' + id, 404, 'ASSET_NOT_FOUND');
    if (!rec.thumb || !rec.thumb['640'] && !rec.thumb['320']) throw httpError('该素材没有缩略图', 404, 'ASSET_NO_THUMB');
    const requested = Number(width) || 640;
    const baseSize = requested <= 320 ? 320 : 640;
    const relPath = rec.thumb[String(baseSize)] || rec.thumb['640'] || rec.thumb['320'];
    if (!relPath) throw httpError('该素材没有缩略图', 404, 'ASSET_NO_THUMB');
    const abs = path.join(absData, relPath);
    if (!fs.existsSync(abs)) throw httpError('缩略图文件缺失', 404, 'ASSET_THUMB_MISSING');
    let buffer = fs.readFileSync(abs);
    if (requested !== 320 && requested !== 640) {
      const clamped = Math.max(16, Math.min(2048, Math.round(requested)));
      buffer = await resizeWebp(buffer, clamped);
    }
    return { buffer, mime: 'image/webp', width: requested, path: relPath };
  }

  function basketEnrich(item) {
    const out = { ...item };
    if (item.assetId) {
      const rec = store.get(item.assetId);
      if (rec && !rec.removed) {
        out.asset = serialize(rec, { trimOcr: true });
        out.name = out.name || rec.name;
        out.kind = out.kind || rec.kind;
        out.size = out.size == null ? rec.size : out.size;
        out.sha256 = out.sha256 || rec.sha256;
      } else {
        out.assetMissing = true;
      }
    }
    return out;
  }

  function basketList({ to = null, status = null, includeTaken = true } = {}) {
    const items = basket.list({ to, status, includeTaken }).map(basketEnrich);
    return { items, stats: basket.stats() };
  }

  function basketAdd({ items = [], to = 'any', deviceId = 'hub' } = {}) {
    const entries = Array.isArray(items) ? items : [items];
    if (!entries.length) throw httpError('缺少 items', 400, 'MISSING_ITEMS');
    const normalized = [];
    for (const item of entries) {
      if (!item || typeof item !== 'object') continue;
      if (item.assetId) {
        const rec = store.get(item.assetId);
        if (!rec || rec.removed) throw httpError('assets 不存在或已移除：' + item.assetId, 404, 'ASSET_NOT_FOUND');
        normalized.push({
          assetId: rec.id,
          name: item.name || rec.name,
          kind: item.kind || rec.kind,
          size: item.size == null ? rec.size : item.size,
          sha256: rec.sha256,
          deviceId: item.deviceId || (rec.source && rec.source.deviceId) || deviceId,
          transferId: item.transferId || null,
          path: item.path || null,
          to: item.to || to,
        });
      } else {
        if (!item.name && !item.transferId && !item.path) continue;
        normalized.push({
          name: item.name || null,
          kind: item.kind || null,
          size: item.size == null ? null : item.size,
          sha256: item.sha256 || null,
          deviceId: item.deviceId || deviceId,
          transferId: item.transferId || null,
          path: item.path || null,
          to: item.to || to,
        });
      }
    }
    if (!normalized.length) throw httpError('items 中没有可用条目', 400, 'INVALID_ITEMS');
    const added = basket.addNormalized(normalized, { to, deviceId }).map(basketEnrich);
    return { added, count: added.length, basket: basketList({ includeTaken: false }) };
  }

  function basketTake({ ids = null, to = null, deviceId = 'hub' } = {}) {
    const taken = basket.take({ ids, to, deviceId }).map(basketEnrich);
    return { taken, count: taken.length, basket: basketList({ includeTaken: false }) };
  }

  function basketClear({ ids = null } = {}) {
    const removed = basket.clear({ ids });
    const items = basket.list({ includeTaken: true }).map(basketEnrich);
    lineage.recordBasketUpdated(items);
    return { removed, remaining: items.length, items, basket: { items, stats: basket.stats() } };
  }

  async function stats() {
    return {
      ...store.stats(),
      dedupeHits,
      ocr: ocr.status(),
      basket: basket.stats(),
      deps: await depsStatus(),
      dataDir: relFromData(absData) || '.',
      root: absRoot,
    };
  }

  async function waitForOcr({ timeoutMs = 240000 } = {}) {
    const started = Date.now();
    while (ocr.pending > 0) {
      if (Date.now() - started > timeoutMs) throw httpError('等待 OCR 完成超时（pending=' + ocr.pending + '）', 504, 'OCR_TIMEOUT');
      await new Promise((r) => setTimeout(r, 100));
    }
    await ocr.drain();
    return ocr.status();
  }

  async function close() {
    try {
      if (ocr.pending > 0) await waitForOcr({ timeoutMs: 60000 });
    } catch { /* ignore */ }
    store.flush();
    await ocr.close();
    return true;
  }

  const service = {
    kind: 'assets',
    dataDir: absData,
    root: absRoot,
    store,
    basket,
    ocr,
    lineage,
    routes: [],
    get state() {
      return stateRef.current;
    },
    setState(next) {
      stateRef.current = next || { tasks: {} };
      return stateRef.current;
    },
    ingest,
    ingestBuffer,
    ingestDirectory,
    statPath,
    list,
    get,
    serialize,
    tag,
    share,
    remove,
    lineage: lineageOf,
    thumb,
    basketList,
    basketAdd,
    basketTake,
    basketClear,
    stats,
    waitForOcr,
    ocrStatus: () => ocr.status(),
    close,
  };
  service.routes = createAssetRoutes(service);
  return service;
}

export default createAssetService;