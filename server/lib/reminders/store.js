// V5 · 提醒存储：data/reminders/reminders.json（原子写）
import fs from 'node:fs';
import path from 'node:path';

function nowIso() { return new Date().toISOString(); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function createRemindersStore({ dataDir, ledger = null } = {}) {
  const dir = path.join(dataDir, 'reminders');
  const file = path.join(dir, 'reminders.json');
  fs.mkdirSync(dir, { recursive: true });
  let cache = readJson(file, null);
  function reload() { cache = readJson(file, null) || cache; return cache; }
  function data() { if (!cache || !Array.isArray(cache.items)) reload(); if (!cache || !Array.isArray(cache.items)) cache = { version: 1, items: [], updatedAt: nowIso() }; return cache; }
  function save() { data().updatedAt = nowIso(); atomicWriteJson(file, cache); }
  function ledgerAppend(type, payload) { try { if (ledger && typeof ledger.append === 'function') ledger.append(type, payload, 'reminders'); } catch { /* ignore */ } }

  function list({ status = '' } = {}) {
    reload();
    let items = data().items.slice();
    if (status === 'pending') items = items.filter((x) => !x.done && x.enabled !== false);
    else if (status === 'done') items = items.filter((x) => x.done);
    else if (status === 'overdue') items = items.filter((x) => !x.done && x.enabled !== false && new Date(x.at).getTime() <= Date.now());
    items.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return items;
  }
  function get(id) { reload(); return (data().items || []).find((x) => x.id === String(id)) || null; }
  function create(fields = {}) {
    const item = {
      id: 'rmd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      text: String(fields.text || '').slice(0, 500),
      at: fields.at,
      recurrence: fields.recurrence === 'daily' ? 'daily' : 'once',
      enabled: fields.enabled !== false,
      done: false,
      firedAt: null,
      lastFiredDay: null,
      source: fields.source || 'text',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    data().items.push(item);
    save();
    ledgerAppend('reminder.created', { id: item.id, text: item.text, at: item.at, recurrence: item.recurrence, source: item.source });
    return item;
  }
  function update(id, patch = {}) {
    const item = get(id);
    if (!item) return null;
    for (const k of ['text', 'at', 'recurrence', 'enabled', 'done']) if (patch[k] !== undefined) item[k] = patch[k];
    if (patch.recurrence === 'daily') item.recurrence = 'daily';
    if (patch.recurrence === 'once') item.recurrence = 'once';
    item.updatedAt = nowIso();
    save();
    ledgerAppend('reminder.updated', { id: item.id, text: item.text, at: item.at, recurrence: item.recurrence, enabled: item.enabled, done: item.done });
    return item;
  }
  function remove(id) {
    const before = data().items.length;
    data().items = data().items.filter((x) => x.id !== String(id));
    if (data().items.length === before) return false;
    save();
    ledgerAppend('reminder.deleted', { id: String(id) });
    return true;
  }
  function markDone(id) {
    const item = get(id);
    if (!item) return null;
    item.done = true; item.enabled = false; item.updatedAt = nowIso();
    save();
    ledgerAppend('reminder.done', { id: item.id, text: item.text });
    return item;
  }
  function saveItem(item) { const arr = data().items; const i = arr.findIndex((x) => x.id === item.id); if (i >= 0) arr[i] = item; else arr.push(item); save(); return item; }

  return { dir, file, load: reload, data, list, get, create, update, remove, markDone, saveItem, save };
}

export default createRemindersStore;