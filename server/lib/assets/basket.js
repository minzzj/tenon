// 榫卯 v2 · 素材中心 · 超级中转站（data/basket/basket.json，原子写）
// 支持：素材引用（assetId）、外部文件（path）、link transfer 引用（transferId）；
// 按目标设备取用（status staged -> taken），一次取用返回完整清单。
import path from 'node:path';
import { ensureDir, newId, nowIso, readJson, writeJsonAtomic } from './util.js';

const BASKET_VERSION = 1;

export class Basket {
  constructor({ dataDir, now = Date.now } = {}) {
    if (!dataDir) throw new Error('Basket 需要 dataDir');
    this.dataDir = String(dataDir);
    this.dir = path.join(this.dataDir, 'basket');
    this.file = path.join(this.dir, 'basket.json');
    this.now = now;
    this.items = [];
    this.load();
  }

  load() {
    ensureDir(this.dir);
    const data = readJson(this.file, null);
    if (data && data.version === BASKET_VERSION && Array.isArray(data.items)) {
      this.items = data.items.filter((it) => it && it.id);
    }
    return this;
  }

  flush() {
    writeJsonAtomic(this.file, {
      version: BASKET_VERSION,
      updatedAt: nowIso(this.now()),
      count: this.items.length,
      items: this.items,
    });
    return this.items.length;
  }

  /** 暂存一个条目（已由 service 归一化）。 */
  addNormalized(entries = [], { to = 'any', deviceId = 'hub' } = {}) {
    const added = [];
    for (const entry of entries) {
      if (!entry || (!entry.assetId && !entry.name && !entry.path && !entry.transferId)) continue;
      const item = {
        id: newId('basket', this.now()),
        assetId: entry.assetId || null,
        name: entry.name || null,
        kind: entry.kind || null,
        size: entry.size == null ? null : Number(entry.size),
        sha256: entry.sha256 || null,
        ref: entry.transferId
          ? { type: 'link-transfer', transferId: String(entry.transferId) }
          : entry.path
            ? { type: 'file', path: String(entry.path) }
            : null,
        source: { deviceId: entry.deviceId || deviceId },
        to: entry.to || to,
        status: 'staged',
        createdAt: nowIso(this.now()),
        takenAt: null,
        takenBy: null,
      };
      this.items.push(item);
      added.push(item);
    }
    if (added.length) this.flush();
    return added;
  }

  list({ to = null, status = null, includeTaken = true } = {}) {
    let out = this.items.slice();
    if (to) out = out.filter((it) => !it.to || it.to === 'any' || it.to === to);
    if (status) out = out.filter((it) => it.status === status);
    else if (!includeTaken) out = out.filter((it) => it.status !== 'taken');
    return out;
  }

  /** 取用：按 ids 或按目标设备取走 staged 项；返回被取走的条目。 */
  take({ ids = null, to = null, deviceId = 'hub' } = {}) {
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
    const taken = [];
    for (const item of this.items) {
      if (item.status !== 'staged') continue;
      if (wanted) {
        if (!wanted.has(item.id)) continue;
      } else if (to && item.to && item.to !== 'any' && item.to !== to) {
        continue;
      }
      item.status = 'taken';
      item.takenAt = nowIso(this.now());
      item.takenBy = String(deviceId || to || 'hub');
      taken.push(item);
    }
    if (taken.length) this.flush();
    return taken;
  }

  clear({ ids = null } = {}) {
    const before = this.items.length;
    if (Array.isArray(ids) && ids.length) {
      const wanted = new Set(ids.map(String));
      this.items = this.items.filter((it) => !wanted.has(it.id));
    } else {
      this.items = [];
    }
    const removed = before - this.items.length;
    if (removed > 0) this.flush();
    return removed;
  }

  stats() {
    const staged = this.items.filter((it) => it.status === 'staged').length;
    return {
      total: this.items.length,
      staged,
      taken: this.items.length - staged,
      file: this.file,
    };
  }
}