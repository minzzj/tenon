// 榫卯 Tenon v2 · 通知转发（Android 通知镜像 -> 电脑；事件 notification.relayed）
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, atomicWriteJson, nowIso, httpError } from './util.js';

export function createNotifier({ dataDir, appendEvent = () => {} } = {}) {
  const file = path.join(dataDir, 'link', 'notifications.json');
  const saved = readJson(file, null);
  let items = saved && Array.isArray(saved.items) ? saved.items : [];

  function persist() {
    atomicWriteJson(file, { version: 2, items: items.slice(0, 50), updatedAt: nowIso() });
  }

  /** 转发一条通知：from=设备（如手机 deviceId），text 只保留前 200 字，事件字段按契约用 preview */
  function relay({ from = 'unknown', app = '', title = '', text = '', to = null } = {}) {
    if (!app && !title) throw httpError(400, 'app / title 至少给一个');
    const preview = String(text || '').slice(0, 200);
    const item = {
      id: 'ntf_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
      at: nowIso(),
      from: String(from || 'unknown'),
      app: String(app || ''),
      title: String(title || ''),
      preview,
      to: to ? String(to) : null,
    };
    items.unshift(item);
    items = items.slice(0, 50);
    persist();
    appendEvent('notification.relayed', { from: item.from, app: item.app, title: item.title, preview: item.preview });
    return item;
  }

  function list(limit = 20) {
    return items.slice(0, Math.max(1, Number(limit) || 20));
  }

  return { relay, list, file, stats: () => ({ items: items.length }) };
}