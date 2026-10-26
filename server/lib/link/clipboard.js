// 榫卯 Tenon v2 · 剪贴板 / 链接 / 文件引用暂存（最新一条 + 目标设备投递 + Round4 隐私过滤）
// Round4 隐私契约：
//  - 敏感内容（密码/验证码/银行卡/身份证/长数字串/token/超长）一律不落盘、不进 latest、不同步；
//    事件只 append clipboard.shared { redacted:true, sensitiveType, length }，绝不包含原文。
//  - history 最多返回最近 5 条（仅 preview，不含全文）；单条删除/一键清空 append clipboard.deleted。
//  - 开关关闭后 share 直接拒绝，node-agent 轮询 settings 后 10 秒内停止采集。
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, atomicWriteJson, nowIso, httpError } from './util.js';
import { detectSensitive, DEFAULT_PRIVACY } from './privacy.js';

export const CLIPBOARD_KINDS = ['text', 'link', 'files'];
export const CLIPBOARD_HISTORY_LIMIT = 5;

export function createClipboardStore({ dataDir, appendEvent = () => {}, privacy = DEFAULT_PRIVACY } = {}) {
  const file = path.join(dataDir, 'link', 'clipboard.json');
  const settingsFile = path.join(dataDir, 'link', 'clipboard-settings.json');
  const saved = readJson(file, null);
  let items = saved && Array.isArray(saved.items) ? saved.items : [];
  const savedSettings = readJson(settingsFile, null);
  const options = { ...DEFAULT_PRIVACY, ...(privacy || {}), ...(savedSettings && savedSettings.privacy ? savedSettings.privacy : {}) };
  const state = {
    enabled: savedSettings && typeof savedSettings.enabled === 'boolean' ? savedSettings.enabled : true,
    privacy: options,
    updatedAt: (savedSettings && savedSettings.updatedAt) || null,
    redactedCount: Number((savedSettings && savedSettings.redactedCount) || 0) || 0,
  };

  function persist() {
    atomicWriteJson(file, { version: 2, items: items.slice(0, 50), updatedAt: nowIso() });
  }

  function persistSettings() {
    atomicWriteJson(settingsFile, {
      version: 1,
      enabled: state.enabled,
      privacy: state.privacy,
      redactedCount: state.redactedCount,
      updatedAt: state.updatedAt || nowIso(),
    });
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

  /** 写入一条剪贴板记录；敏感内容直接过滤（不落盘），只记 redacted 事件 */
  function share({ from = 'operator', kind = 'text', text = '', to = null, files = [], transferId = null, preview = '' } = {}) {
    if (!state.enabled) {
      throw httpError(409, '剪贴板同步已关闭：打开开关后才能同步（隐私设置）', 'CLIPBOARD_DISABLED');
    }
    const normalizedKind = String(kind || 'text').toLowerCase();
    if (!CLIPBOARD_KINDS.includes(normalizedKind)) throw httpError(400, 'kind 只能是 text / link / files');
    const raw = String(text || '');
    const hit = detectSensitive(raw, state.privacy);
    if (hit.sensitive) {
      state.redactedCount += 1;
      state.updatedAt = nowIso();
      persistSettings();
      appendEvent('clipboard.shared', {
        from: String(from || 'operator'),
        kind: 'redacted',
        redacted: true,
        sensitiveType: hit.type,
        length: hit.length,
        ...(to ? { to: String(to) } : {}),
      });
      return {
        redacted: true,
        sensitiveType: hit.type,
        label: hit.label,
        length: hit.length,
        preview: hit.redactedPreview,
        item: null,
        say: `已过滤敏感内容（${hit.label}），不会落盘也不会同步`,
      };
    }
    const item = {
      id: 'clip_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
      at: nowIso(),
      from: String(from || 'operator'),
      kind: normalizedKind,
      text: raw,
      preview: previewOf(normalizedKind, raw, { preview, files }),
      to: to ? String(to) : null,
      files: normalizedKind === 'files' ? (Array.isArray(files) ? files : []) : [],
      transferId: transferId ? String(transferId) : null,
      redacted: false,
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

  /** Round4：历史仅返回最近 5 条安全视图（只有 preview，不含全文） */
  function history(limit = CLIPBOARD_HISTORY_LIMIT) {
    const n = Math.max(1, Math.min(50, Number(limit) || CLIPBOARD_HISTORY_LIMIT));
    return items.slice(0, n).map((item) => ({
      id: item.id,
      at: item.at,
      from: item.from,
      kind: item.kind,
      preview: item.preview,
      to: item.to || null,
      chars: item.kind === 'files' ? 0 : String(item.text || '').length,
      redacted: false,
    }));
  }

  function deleteItem(id, by = 'operator') {
    const key = String(id || '');
    const idx = items.findIndex((item) => item.id === key);
    if (idx < 0) throw httpError(404, '剪贴板记录不存在', 'CLIPBOARD_NOT_FOUND');
    const [removed] = items.splice(idx, 1);
    persist();
    appendEvent('clipboard.deleted', { itemId: removed.id, by: String(by || 'operator'), count: 1 });
    return { removed: { id: removed.id, at: removed.at, kind: removed.kind }, remaining: items.length };
  }

  function clear(by = 'operator') {
    const count = items.length;
    items = [];
    persist();
    appendEvent('clipboard.deleted', { all: true, by: String(by || 'operator'), count });
    return { cleared: count };
  }

  function settings() {
    return {
      enabled: state.enabled,
      privacy: { ...state.privacy },
      redactedCount: state.redactedCount,
      historyLimit: CLIPBOARD_HISTORY_LIMIT,
      updatedAt: state.updatedAt,
    };
  }

  function setEnabled(enabled, by = 'operator') {
    state.enabled = !!enabled;
    state.updatedAt = nowIso();
    persistSettings();
    appendEvent('clipboard.privacy.changed', { enabled: state.enabled, by: String(by || 'operator') });
    return settings();
  }

  return {
    share,
    latest,
    list,
    history,
    deleteItem,
    clear,
    settings,
    setEnabled,
    state,
    file,
    stats: () => ({ items: items.length, enabled: state.enabled, redactedCount: state.redactedCount }),
  };
}

export default { createClipboardStore, CLIPBOARD_KINDS, CLIPBOARD_HISTORY_LIMIT };