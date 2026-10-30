// V5 · 语音笔记本地存储：data/notes/YYYY-MM-DD.jsonl（事件式）+ data/notes/md/*.md（YAML front matter）
import fs from 'node:fs';
import path from 'node:path';

function pad(n) { return String(n).padStart(2, '0'); }
export function nowIso() { return new Date().toISOString(); }
export function localDay(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function timeOf(iso) { const d = new Date(iso || Date.now()); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'note'; }
function deriveTitle(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  const first = t.split(/[。！？!?\n]/)[0] || t;
  return first.slice(0, 30) || '未命名笔记';
}

export function createNotesStore({ dataDir, ledger = null } = {}) {
  const dir = path.join(dataDir, 'notes');
  const mdDir = path.join(dir, 'md');
  fs.mkdirSync(mdDir, { recursive: true });
  const fileOf = (day) => path.join(dir, day + '.jsonl');

  function append(day, row) {
    fs.appendFileSync(fileOf(day), JSON.stringify(row) + '\n', 'utf8');
  }
  function readDay(day) {
    const file = fileOf(day);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  function allDays() {
    try { return fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort(); } catch { return []; }
  }
  function buildIndex(days = null) {
    const map = new Map();
    const list = days || allDays();
    for (const day of list) {
      for (const row of readDay(day)) {
        if (!row || !row.note || !row.note.id) continue;
        if (row.type === 'create' || row.type === 'update') map.set(row.note.id, { ...row.note });
        else if (row.type === 'delete') map.delete(row.note.id);
      }
    }
    return map;
  }
  function markdownOf(note) {
    const front = ['---', 'id: ' + note.id, 'title: ' + note.title, 'date: ' + note.date, 'time: ' + (note.time || ''), 'source: ' + (note.source || 'text'), 'tags: [' + (note.tags || []).join(', ') + ']', 'createdAt: ' + note.createdAt, 'updatedAt: ' + (note.updatedAt || note.createdAt), '---', '', '# ' + note.title, '', note.text, ''].join('\n');
    return front;
  }
  function mdPathOf(note) { return path.join(mdDir, (note.date || localDay(note.createdAt)) + '-' + String(note.time || '00:00').replace(':', '') + '-' + safeName(note.id) + '.md'); }
  function writeMd(note) {
    const file = mdPathOf(note);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, markdownOf(note), 'utf8');
    return path.relative(dataDir, file).split(path.sep).join('/');
  }
  function ledgerAppend(type, data) { try { if (ledger && typeof ledger.append === 'function') ledger.append(type, data, 'notes'); } catch { /* ignore */ } }

  function create({ text, title = '', tags = [], source = 'text', sessionId = null } = {}) {
    const clean = String(text || '').trim();
    if (!clean) { const e = new Error('笔记内容不能为空'); e.statusCode = 400; throw e; }
    const createdAt = nowIso();
    const date = localDay(createdAt);
    const id = 'note_' + date.replace(/-/g, '') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const note = {
      id,
      text: clean.slice(0, 20000),
      title: String(title || '').trim().slice(0, 80) || deriveTitle(clean),
      tags: (Array.isArray(tags) ? tags : String(tags || '').split(/[,，\s]+/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 10),
      source: source === 'voice' ? 'voice' : 'text',
      sessionId: sessionId || null,
      date,
      time: timeOf(createdAt),
      createdAt,
      updatedAt: createdAt,
    };
    note.md = writeMd(note);
    append(date, { type: 'create', note });
    ledgerAppend('note.created', { id: note.id, title: note.title, text: note.text.slice(0, 300), source: note.source, date: note.date, md: note.md });
    return note;
  }

  function get(id) {
    if (!id) return null;
    const map = buildIndex();
    return map.get(String(id)) || null;
  }

  function list({ date = '', q = '', tag = '', limit = 50, offset = 0 } = {}) {
    const days = date ? [String(date)] : allDays().slice(-14);
    const map = buildIndex(days);
    let arr = Array.from(map.values());
    if (q) {
      const qq = String(q).toLowerCase();
      arr = arr.filter((n) => (n.title + '\n' + n.text + '\n' + (n.tags || []).join(',')).toLowerCase().includes(qq));
    }
    if (tag) arr = arr.filter((n) => (n.tags || []).includes(String(tag)));
    arr.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const total = arr.length;
    const lim = Math.max(1, Math.min(200, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    return { items: arr.slice(off, off + lim).map((n) => ({ ...n, excerpt: String(n.text || '').slice(0, 120) })), total, date: date || null, limit: lim, offset: off };
  }

  function update(id, patch = {}) {
    const current = get(id);
    if (!current) { const e = new Error('笔记不存在'); e.statusCode = 404; throw e; }
    const next = { ...current };
    if (patch.text !== undefined) next.text = String(patch.text).slice(0, 20000);
    if (patch.title !== undefined) next.title = String(patch.title).slice(0, 80) || deriveTitle(next.text);
    if (patch.tags !== undefined) next.tags = (Array.isArray(patch.tags) ? patch.tags : String(patch.tags || '').split(/[,，\s]+/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
    next.updatedAt = nowIso();
    next.md = writeMd(next);
    append(next.date, { type: 'update', note: next });
    ledgerAppend('note.updated', { id: next.id, title: next.title, text: next.text.slice(0, 300), date: next.date });
    return next;
  }

  function remove(id) {
    const current = get(id);
    if (!current) { const e = new Error('笔记不存在'); e.statusCode = 404; throw e; }
    try { const f = path.join(dir, 'md', path.basename(current.md || '')); if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
    append(current.date, { type: 'delete', note: { id: current.id, date: current.date } });
    ledgerAppend('note.deleted', { id: current.id, title: current.title, date: current.date });
    return { ok: true, id: current.id, deleted: true };
  }

  function exportOf(date = '', format = 'md') {
    const days = date ? [String(date)] : allDays().slice(-1);
    const map = buildIndex(days);
    const items = Array.from(map.values()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (format === 'json') return { format: 'json', date: date || days[days.length - 1] || localDay(), items, total: items.length };
    const md = items.map((n) => '# ' + n.title + '\n\n> ' + n.date + ' ' + (n.time || '') + ' · ' + (n.source === 'voice' ? '语音' : '文字') + '\n\n' + n.text + '\n').join('\n---\n\n');
    return { format: 'md', date: date || days[days.length - 1] || localDay(), markdown: md, total: items.length };
  }

  function stats() {
    const days = allDays();
    let total = 0;
    try { total = buildIndex(days.slice(-60)).size; } catch { total = 0; }
    return { total, days: days.length, mdFiles: (() => { try { return fs.readdirSync(mdDir).filter((n) => n.endsWith('.md')).length; } catch { return 0; } })(), dir: 'notes' };
  }

  return { dir, mdDir, create, get, list, update, remove, exportOf, stats, allDays, readDay };
}

export default createNotesStore;