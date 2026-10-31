// 榫卯 V3 · 语音转写存储 + 事件广播（本地 data/voice/transcripts/YYYY-MM-DD.jsonl）
// 隐私：所有转写先过 R4 剪贴板隐私规则（server/lib/link/privacy.js），命中只存 redacted/类型，不存原文。
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from '../link/util.js';
import { detectSensitive } from '../link/privacy.js';
import { isRealDay, safeChild } from '../documents/safe-path.js';

export const TRANSCRIPT_LIMIT_PER_READ = 200;

export function dayKey(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function filterTranscript(text, privacy = {}) {
  const hit = detectSensitive(String(text || ''), privacy);
  if (hit.sensitive) {
    return { redacted: true, sensitiveType: hit.type, label: hit.label, length: hit.length, text: '', preview: hit.redactedPreview };
  }
  return { redacted: false, text: String(text || ''), preview: String(text || '').slice(0, 200), length: String(text || '').length };
}

export function createTranscriptStore({ dataDir, retentionDays = 30 } = {}) {
  const dir = path.join(dataDir, 'voice', 'transcripts');
  fs.mkdirSync(dir, { recursive: true });
  let count = 0;

  // P1 修复（S-04）：day 来自 ?date= 请求参数，必须 ^\d{4}-\d{2}-\d{2}$ 且为真实日期，
  // 解析后必须仍位于本目录之下；非法返回 null，由调用方拒绝（路由层 400），绝不落到 fs 调用。
  function fileOf(day) {
    const key = String(day == null ? '' : day);
    if (!isRealDay(key)) return null;
    return safeChild(dir, key + '.jsonl');
  }

  function append(record) {
    // record.at 可能来自客户端 ts；非法时间戳回落到今天，避免写 NaN-NaN-NaN.jsonl，也不因此 500。
    const rawDay = dayKey(record.at || new Date());
    const day = isRealDay(rawDay) ? rawDay : dayKey();
    const file = fileOf(day);
    if (!file) throw new Error('转写日期不合法');
    const row = { at: record.at || nowIso(), ...record };
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    count += 1;
    return row;
  }

  function list(day = dayKey(), limit = TRANSCRIPT_LIMIT_PER_READ) {
    const key = String(day == null ? '' : day);
    const file = fileOf(key);
    if (!file) return { date: key, items: [], total: 0, ok: false, code: 'BAD_DATE' };
    if (!fs.existsSync(file)) return { date: key, items: [], total: 0, ok: true };
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const items = lines.slice(-Math.max(1, Math.min(1000, Number(limit) || TRANSCRIPT_LIMIT_PER_READ))).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return { date: key, items, total: lines.length, ok: true };
  }

  function stats() {
    try {
      const files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
      return { days: files.length, files: files.slice(-7), dir: path.relative(dataDir, dir) };
    } catch {
      return { days: 0, files: [], dir: 'voice/transcripts' };
    }
  }

  function cleanup() {
    const days = Math.max(1, Number(retentionDays) || 30);
    const cutoff = Date.now() - days * 86400000;
    let removed = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const t = new Date(name.replace(/\.jsonl$/, '')).getTime();
        if (Number.isFinite(t) && t < cutoff) { fs.unlinkSync(path.join(dir, name)); removed += 1; }
      }
    } catch { /* 清理失败不影响主链路 */ }
    return { removed, retentionDays: days };
  }

  return { dir, append, list, stats, cleanup, count: () => count };
}

/** V4 · 屏幕 OCR 文本本地存储（data/voice/screen/YYYY-MM-DD.jsonl） */
export function createScreenStore({ dataDir } = {}) {
  const dir = path.join(dataDir, 'voice', 'screen');
  fs.mkdirSync(dir, { recursive: true });
  // P1 修复（S-04）：屏幕 OCR 按日期落盘，同样只接受白名单 + 真实日期 + 目录前缀校验。
  function fileOf(day) {
    const key = String(day == null ? '' : day);
    if (!isRealDay(key)) return null;
    return safeChild(dir, key + '.jsonl');
  }
  function append(record) {
    const rawDay = dayKey(record.at || new Date());
    const day = isRealDay(rawDay) ? rawDay : dayKey();
    const file = fileOf(day);
    if (!file) throw new Error('屏幕文本日期不合法');
    const row = { id: record.id || ('sc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)), at: record.at || nowIso(), app: String(record.app || '').slice(0, 80), title: String(record.title || '').slice(0, 200), text: String(record.text || '').slice(0, 4000), confidence: Number(record.confidence) || null, source: record.source || 'pc', region: record.region || null, image: record.image || null, ocrMs: Number(record.ocrMs) || null, engine: record.engine || null, ...(record.redacted ? { redacted: true } : {}) };
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
    return row;
  }
  function list(day = dayKey(), limit = 500) {
    const key = String(day == null ? '' : day);
    const file = fileOf(key);
    if (!file) return { date: key, items: [], total: 0, ok: false, code: 'BAD_DATE' };
    if (!fs.existsSync(file)) return { date: key, items: [], total: 0, ok: true };
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const items = lines.slice(-Math.max(1, Math.min(2000, Number(limit) || 500))).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return { date: key, items, total: lines.length, ok: true };
  }
  function stats() {
    try { const files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); return { days: files.length, files: files.slice(-7), dir: path.relative(dataDir, dir) }; } catch { return { days: 0, files: [], dir: 'voice/screen' }; }
  }
  return { dir, append, list, stats, fileOf };
}

/** SSE 订阅器：语音事件广播（partial/final/wake/command/thinking/reply/tts/status/error） */
export function createEventHub({ ringSize = 80 } = {}) {
  const clients = new Set();
  const ring = [];

  function recent(n = 20) {
    return ring.slice(-Math.max(1, Math.min(ringSize, Number(n) || 20)));
  }

  function broadcast(event) {
    const ev = { at: nowIso(), ...event };
    ring.push(ev);
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
    const payload = 'data: ' + JSON.stringify(ev) + '\n\n';
    for (const client of Array.from(clients)) {
      try { client.write(payload); } catch { clients.delete(client); }
    }
    return ev;
  }

  function subscribe(res, { heartbeatMs = 15000 } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const timer = setInterval(() => {
      try { res.write(': ping ' + Date.now() + '\n\n'); } catch { /* ignore */ }
    }, heartbeatMs);
    const cleanup = () => { clearInterval(timer); clients.delete(res); };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return { clients: clients.size, close: cleanup };
  }

  return { broadcast, subscribe, recent, ring, clients: () => clients.size };
}

export default { createTranscriptStore, createScreenStore, createEventHub, filterTranscript, dayKey };