// V5 · 文档中心服务：结构化总结文档（md/docx/pdf）
// 挂载：server/lib/v2/index.js 追加 { dir:'documents', name:'documents', factory:'createDocumentsService' }
import fs from 'node:fs';
import path from 'node:path';
import { createDocumentsStore } from './store.js';
import { generateDocument, collectSources, DOCUMENT_KINDS } from './generate.js';

function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
async function readBody(req, limit = 2 * 1024 * 1024) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) { const e = new Error('请求体过大'); e.statusCode = 413; throw e; } chunks.push(chunk); } return Buffer.concat(chunks); }
async function readJson(req) { const raw = await readBody(req); if (!raw.length) return {}; try { return JSON.parse(raw.toString('utf8')); } catch { const e = new Error('JSON 解析失败'); e.statusCode = 400; throw e; } }
function httpError(status, msg) { const e = new Error(msg); e.statusCode = status; return e; }
function nowIso() { return new Date().toISOString(); }

export async function createDocumentsService({ root, ledger, ai = null, dataDir, readOnly = false, authed = () => false, state = null, onEvent = null } = {}) {
  const store = createDocumentsStore({ dataDir, ledger });
  const clients = new Set();
  const status = { startedAt: nowIso(), generated: 0, lastError: null, lastDoc: null };

  function broadcast(ev) {
    const line = 'data: ' + JSON.stringify(ev) + '\n\n';
    for (const res of Array.from(clients)) { try { res.write(line); } catch { clients.delete(res); } }
    try { if (typeof onEvent === 'function') onEvent(ev); } catch { /* ignore */ }
  }
  function requireWrite(req, ctx) {
    if (readOnly) throw httpError(423, '另一窗口为只读');
    const ok = (ctx && typeof ctx.authed === 'function' && ctx.authed(req)) || (typeof authed === 'function' && authed(req));
    if (!ok) throw httpError(401, '需要登录令牌');
  }

  const routes = [
    { method: 'GET', path: '/documents', handler: async (req, res, ctx) => {
      const u = ctx.url;
      const out = store.list({ since: u.searchParams.get('since') || '', limit: u.searchParams.get('limit') || 100 });
      sendJson(res, 200, { ok: true, ...out, kinds: DOCUMENT_KINDS, latestAt: out.items[0] ? out.items[0].createdAt : null });
    } },
    { method: 'GET', path: '/documents/stream', handler: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ type: 'hello', service: 'documents', now: nowIso() }) + '\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping ' + Date.now() + '\n\n'); } catch { /* ignore */ } }, 15000);
      if (ping.unref) ping.unref();
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
    } },
    { method: 'POST', path: '/documents/generate', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      const kind = String(body.kind || 'note-summary');
      if (!DOCUMENT_KINDS[kind]) { sendJson(res, 400, { ok: false, error: 'kind 只能是 note-summary|daily|note-set', code: 'BAD_KIND' }); return; }
      const doc = await generateDocument({ ai, dataDir, ledger, kind, date: body.date || '', ids: Array.isArray(body.ids) ? body.ids : null, title: body.title || '' });
      status.generated += 1;
      status.lastDoc = { at: nowIso(), id: doc.id, kind: doc.kind, provider: doc.provider, degraded: !!doc.degraded };
      broadcast({ type: 'document', id: doc.id, title: doc.title, kind: doc.kind, kindLabel: doc.kindLabel, provider: doc.provider, degraded: !!doc.degraded, download: '/api/v2/documents/' + doc.id + '/download?format=docx', files: Object.keys(doc.files || {}), createdAt: doc.createdAt, ts: Date.now() });
      sendJson(res, 201, { ok: true, document: doc, id: doc.id, structured: doc.structured, downloads: doc.downloads || { md: '/api/v2/documents/' + doc.id + '/download?format=md', docx: '/api/v2/documents/' + doc.id + '/download?format=docx', pdf: '/api/v2/documents/' + doc.id + '/download?format=pdf' }, provider: doc.provider, degraded: !!doc.degraded });
    } },
    { method: 'GET', path: '/documents/:id', handler: async (req, res, ctx) => {
      const doc = store.get(ctx.params.id);
      if (!doc) { sendJson(res, 404, { ok: false, error: '文档不存在', code: 'DOCUMENT_NOT_FOUND' }); return; }
      let markdown = '';
      try { markdown = fs.readFileSync(store.pathOf(doc.id, 'md'), 'utf8'); } catch { /* ignore */ }
      sendJson(res, 200, { ok: true, document: doc, markdown });
    } },
    { method: 'GET', path: '/documents/:id/download', handler: async (req, res, ctx) => {
      const u = ctx.url;
      const format = String(u.searchParams.get('format') || 'md').toLowerCase();
      if (!['md', 'docx', 'pdf'].includes(format)) { sendJson(res, 400, { ok: false, error: 'format 只能是 md|docx|pdf' }); return; }
      const file = store.pathOf(ctx.params.id, format);
      if (!file) { sendJson(res, 404, { ok: false, error: '该格式文件不存在', code: 'FILE_NOT_FOUND' }); return; }
      const types = { md: 'text/markdown; charset=utf-8', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf' };
      const meta = store.get(ctx.params.id);
      const base = String((meta && meta.title) || ctx.params.id).replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 60);
      const asciiName = 'tenon-summary-' + ctx.params.id + '.' + format;
      res.writeHead(200, { 'Content-Type': types[format], 'Content-Disposition': "attachment; filename=\"" + asciiName + "\"; filename*=UTF-8''" + encodeURIComponent(base + '.' + format), 'Cache-Control': 'private, max-age=300', 'Content-Length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    } },
    { method: 'DELETE', path: '/documents/:id', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const ok = store.remove(ctx.params.id);
      if (!ok) { sendJson(res, 404, { ok: false, error: '文档不存在' }); return; }
      broadcast({ type: 'document_deleted', id: ctx.params.id, ts: Date.now() });
      sendJson(res, 200, { ok: true, id: ctx.params.id, deleted: true });
    } },
  ];

  const service = {
    name: 'documents',
    version: '5.0.0',
    routes,
    store,
    status,
    generate: (opts = {}) => generateDocument({ ai, dataDir, ledger, ...opts }),
    collectSources: (opts = {}) => collectSources({ dataDir, ledger, ...opts }),
    list: store.list,
    get: store.get,
    stats: () => ({ total: store.list({ limit: 200 }).total, generated: status.generated, lastDoc: status.lastDoc, lastError: status.lastError }),
  };
  return service;
}

export default createDocumentsService;