// V5 · 语音笔记服务：/api/v2/notes（CRUD/搜索/导出）；账本 note.created/updated/deleted
// 挂载：server/lib/v2/index.js 追加 { dir:'notes', name:'notes', factory:'createNotesService' }
import fs from 'node:fs';
import { createNotesStore } from './store.js';

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) { const e = new Error('请求体过大'); e.statusCode = 413; throw e; } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readJson(req) { const raw = await readBody(req); if (!raw.length) return {}; try { return JSON.parse(raw.toString('utf8')); } catch { const e = new Error('JSON 解析失败'); e.statusCode = 400; throw e; } }
function httpError(status, msg) { const e = new Error(msg); e.statusCode = status; return e; }

export async function createNotesService({ root, ledger, ai = null, dataDir, readOnly = false, authed = () => false } = {}) {
  const store = createNotesStore({ dataDir, ledger });

  function requireWrite(req, ctx) {
    if (readOnly) throw httpError(423, '另一窗口为只读');
    const ok = (ctx && typeof ctx.authed === 'function' && ctx.authed(req)) || (typeof authed === 'function' && authed(req));
    if (!ok) throw httpError(401, '需要登录令牌');
  }

  const routes = [
    { method: 'GET', path: '/notes', handler: async (req, res, ctx) => {
      const u = ctx.url;
      sendJson(res, 200, { ok: true, ...store.list({ date: u.searchParams.get('date') || '', q: u.searchParams.get('q') || '', tag: u.searchParams.get('tag') || '', limit: u.searchParams.get('limit') || 50, offset: u.searchParams.get('offset') || 0 }), stats: store.stats() });
    } },
    { method: 'GET', path: '/notes/export', handler: async (req, res, ctx) => {
      const u = ctx.url;
      const format = String(u.searchParams.get('format') || 'md').toLowerCase();
      const date = u.searchParams.get('date') || '';
      const out = store.exportOf(date, format === 'json' ? 'json' : 'md');
      if (format === 'md') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'inline; filename="notes-' + (out.date || 'today') + '.md"' });
        res.end(out.markdown || '');
        return;
      }
      sendJson(res, 200, { ok: true, ...out });
    } },
    { method: 'GET', path: '/notes/search', handler: async (req, res, ctx) => {
      const u = ctx.url;
      sendJson(res, 200, { ok: true, ...store.list({ date: u.searchParams.get('date') || '', q: u.searchParams.get('q') || '', tag: u.searchParams.get('tag') || '', limit: u.searchParams.get('limit') || 50, offset: u.searchParams.get('offset') || 0 }) });
    } },
    { method: 'POST', path: '/notes', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      const note = store.create({ text: body.text, title: body.title, tags: body.tags, source: body.source || 'text', sessionId: body.sessionId || null });
      sendJson(res, 201, { ok: true, note, id: note.id, md: note.md, stored: true });
    } },
    { method: 'GET', path: '/notes/:id', handler: async (req, res, ctx) => {
      const note = store.get(ctx.params.id);
      if (!note) { sendJson(res, 404, { ok: false, error: '笔记不存在', code: 'NOTE_NOT_FOUND' }); return; }
      sendJson(res, 200, { ok: true, note });
    } },
    { method: 'PATCH', path: '/notes/:id', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      const note = store.update(ctx.params.id, body);
      sendJson(res, 200, { ok: true, note, id: note.id, md: note.md });
    } },
    { method: 'DELETE', path: '/notes/:id', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      sendJson(res, 200, store.remove(ctx.params.id));
    } },
  ];

  const service = {
    name: 'notes',
    version: '5.0.0',
    routes,
    store,
    list: store.list,
    get: store.get,
    create: store.create,
    update: store.update,
    remove: store.remove,
    stats: store.stats,
  };
  return service;
}

export default createNotesService;