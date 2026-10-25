// 榫卯 Tenon v2 · 剪贴板 / 链接 / 文件引用暂存（最新一条 + 目标设备投递）
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, atomicWriteJson, nowIso, httpError } from './util.js';

export const CLIPBOARD_KINDS = ['text', 'link', 'files'];

export function createClipboardStore({ dataDir, appendEvent = () => {} } = {}) {
  const file = path.join(dataDir, 'link', 'clipboard.json');
  const saved = readJson(file, null);
  let items = saved && Array.isArray(saved.items) ? saved.items : [];

  function persist() {
    atomicWriteJson(file, { version: 2, items: items.slice(0, 50), updatedAt: nowIso() });
  }

  function previewOf(kind, text, extra = {}) {
    if (extra.preview) return String(extra.preview).slice(0, 200);
    if (kind === 'files') {
      const list = Array.isArray(extra.files) ? extra.files : [];
      const names = list.map((f) => (f && f.name) || f).filter(Boolean).slice(0, 3);
      return names.length ? names.join('、') : '文件引用';
    }
    return String(text || '').slice(0, 200);
  }

  /** 写入一条剪贴板记录并 append clipboard.shared */
  function share({ from = 'operator', kind = 'text', text = '', to = null, files = [], transferId = null, preview = '' } = {}) {
    const normalizedKind = String(kind || 'text').toLowerCase();
    if (!CLIPBOARD_KINDS.includes(normalizedKind)) throw httpError(400, 'kind 只能是 text / link / files');
    const item = {
      id: 'clip_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
      at: nowIso(),
      from: String(from || 'operator'),
      kind: normalizedKind,
      text: String(text || ''),
      preview: previewOf(normalizedKind, text, { preview, files }),
      to: to ? String(to) : null,
      files: normalizedKind === 'files' ? (Array.isArray(files) ? files : []) : [],
      transferId: transferId ? String(transferId) : null,
    };
    items.unshift(item);
    items = items.slice(0, 50);
    persist();
    const event = { from: item.from, kind: item.kind, preview: item.preview };
    if (item.to) event.to = item.to;
    appendEvent('clipboard.shared', event);
    return item;
  }

  /** 最新一条；给了 forDevice 时优先返回发给该设备的（目标匹配或广播） */
  function latest({ forDevice = null } = {}) {
    if (!forDevice) return items[0] || null;
    const id = String(forDevice);
    return items.find((item) => !item.to || item.to === id) || null;
  }

  function list(limit = 20) {
    return items.slice(0, Math.max(1, Number(limit) || 20));
  }

  return { share, latest, list, file, stats: () => ({ items: items.length }) };
}