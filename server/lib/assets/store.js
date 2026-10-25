// 榫卯 v2 · 素材中心 · 素材索引（data/assets/index.json，原子写 + 内存索引 + 搜索/过滤/分页）
import path from 'node:path';
import { ensureDir, fileSize, nowIso, readJson, writeJsonAtomic } from './util.js';

export const INDEX_VERSION = 1;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

function lower(v) {
  return String(v == null ? '' : v).toLowerCase();
}

function withinRange(iso, from, to) {
  if (!iso) return !from && !to;
  if (from) {
    const fromIso = new Date(from).toISOString();
    if (iso < fromIso) return false;
  }
  if (to) {
    // to 若只给日期（YYYY-MM-DD）则包含当天
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(to)) ? new Date(String(to) + 'T23:59:59.999Z') : new Date(to);
    if (iso > toDate.toISOString()) return false;
  }
  return true;
}

function matchQuery(rec, q) {
  if (!q) return true;
  const needle = lower(q);
  const haystack = [
    rec.name,
    rec.sha256,
    rec.kind,
    (rec.tags || []).join(' '),
    rec.ocr && rec.ocr.text,
    rec.source && rec.source.path,
    rec.source && rec.source.deviceId,
  ]
    .filter(Boolean)
    .map(lower);
  return haystack.some((h) => h.includes(needle));
}

function matchKind(rec, kind) {
  if (!kind) return true;
  const kinds = String(kind).split(',').map((k) => k.trim()).filter(Boolean);
  return kinds.length === 0 || kinds.includes(rec.kind);
}

function matchDevice(rec, device) {
  if (!device) return true;
  return rec.source && rec.source.deviceId === device;
}

/** 过滤 + 排序 + 分页（纯内存，500~5000 条量级；导出供测试直接调用）。 */
export function filterAssets(records, opts = {}) {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(opts.limit) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const includeRemoved = !!opts.includeRemoved;
  const filtered = [];
  for (const rec of records) {
    if (!rec) continue;
    if (rec.removed && !includeRemoved) continue;
    if (!matchQuery(rec, opts.q)) continue;
    if (!matchKind(rec, opts.kind)) continue;
    if (!matchDevice(rec, opts.device)) continue;
    if (!withinRange(rec.createdAt, opts.from, opts.to)) continue;
    filtered.push(rec);
  }
  filtered.sort((a, b) => {
    const c = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    return c !== 0 ? c : String(b.id || '').localeCompare(String(a.id || ''));
  });
  return { total: filtered.length, limit, offset, items: filtered.slice(offset, offset + limit) };
}

export class AssetStore {
  constructor({ dataDir, now = Date.now } = {}) {
    if (!dataDir) throw new Error('AssetStore 需要 dataDir');
    this.dataDir = String(dataDir);
    this.dir = path.join(this.dataDir, 'assets');
    this.file = path.join(this.dir, 'index.json');
    this.now = now;
    this.assets = new Map();
    this.bySha = new Map();
    this.updatedAt = null;
    this.load();
  }

  load() {
    ensureDir(this.dir);
    const data = readJson(this.file, null);
    if (data && data.version === INDEX_VERSION && data.assets && typeof data.assets === 'object') {
      for (const [id, rec] of Object.entries(data.assets)) {
        if (!rec || typeof rec !== 'object') continue;
        this.assets.set(id, rec);
        if (rec.sha256) this.bySha.set(rec.sha256, id);
      }
      this.updatedAt = data.updatedAt || null;
    }
    return this;
  }

  flush() {
    const assets = {};
    for (const [id, rec] of this.assets) assets[id] = rec;
    this.updatedAt = nowIso(this.now());
    writeJsonAtomic(this.file, {
      version: INDEX_VERSION,
      updatedAt: this.updatedAt,
      count: this.assets.size,
      assets,
    });
    return this.updatedAt;
  }

  add(record) {
    if (!record || !record.id) throw new Error('素材记录缺少 id');
    this.assets.set(record.id, record);
    if (record.sha256) this.bySha.set(record.sha256, record.id);
    return record;
  }

  get(id) {
    return this.assets.get(id) || null;
  }

  findBySha(sha256) {
    const id = this.bySha.get(sha256);
    return id ? this.assets.get(id) || null : null;
  }

  update(id, patch) {
    const rec = this.get(id);
    if (!rec) return null;
    Object.assign(rec, patch, { updatedAt: nowIso(this.now()) });
    return rec;
  }

  markRemoved(id, reason = '') {
    const rec = this.get(id);
    if (!rec) return null;
    rec.removed = true;
    rec.removedAt = nowIso(this.now());
    rec.removeReason = String(reason || '');
    rec.updatedAt = rec.removedAt;
    return rec;
  }

  list(opts = {}) {
    return filterAssets(this.assets.values(), opts);
  }

  get size() {
    return this.assets.size;
  }

  stats() {
    const records = [...this.assets.values()];
    const byKind = {};
    const byDevice = {};
    let totalBytes = 0;
    let removed = 0;
    const tags = new Set();
    const ocr = { pending: 0, done: 0, failed: 0, skipped: 0 };
    for (const rec of records) {
      if (rec.removed) {
        removed += 1;
        continue;
      }
      byKind[rec.kind || 'other'] = (byKind[rec.kind || 'other'] || 0) + 1;
      const device = (rec.source && rec.source.deviceId) || 'unknown';
      byDevice[device] = (byDevice[device] || 0) + 1;
      totalBytes += Number(rec.size) || 0;
      for (const tag of rec.tags || []) tags.add(tag);
      const status = (rec.ocr && rec.ocr.status) || (rec.kind === 'image' ? 'pending' : 'skipped');
      if (ocr[status] === undefined) ocr[status] = 0;
      ocr[status] += 1;
    }
    const active = records.filter((r) => !r.removed);
    return {
      total: active.length,
      removed,
      totalBytes,
      byKind,
      byDevice,
      tags: tags.size,
      ocr,
      duplicatesSaved: 0,
      indexFile: this.file,
      indexBytes: fileSize(this.file),
      updatedAt: this.updatedAt,
    };
  }
}