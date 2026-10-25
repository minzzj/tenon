// 榫卯 Tenon v2.1 · 超级终端 HTTP 路由
//
// 导出 `routes: [{method,path,handler(req,res,ctx)}]`，path 用**相对 /api/v2**（Lead 的 v2 网关兼容相对/整路径两种），
// 另导出 `routesAbsolute`（带 /api/v2 前缀副本）与 matchRoutes/matchPath 工具：
//   GET  /super/home       首页：设备 + 程序 + 最近流转 + 建议话术
//   GET  /super/programs   程序清单（probe=1 时尝试实时读取电脑 app.list）
//   POST /super/ask        一句话 → AI/规则意图 → 计划 → 执行（body: {text, confirmed?, context?}）
//   POST /super/handoff    手机 → 电脑流转（body: {kind, url|assetId|text, fromDevice?}）
//   GET  /super/state      最近 asks / handoffs（从账本 replay 投影；state.js 的 v2.super 亦可用）
// 鉴权：写操作要求 x-tenon-token（或登录 Cookie）；ctx.authed 优先；只读实例返回 423。
import { httpError } from './errors.js';

const MAX_BODY = 1048576;
const API_PREFIX = '/api/v2';

export function matchPath(pattern, pathname) {
  const p = String(pattern).split('/');
  const n = String(pathname).split('/');
  if (p.length !== n.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i += 1) {
    const seg = p[i];
    if (seg.startsWith(':')) {
      if (!n[i]) return null;
      params[seg.slice(1)] = decodeURIComponent(n[i]);
    } else if (seg !== n[i]) {
      return null;
    }
  }
  return params;
}

export function matchPathLoose(pattern, pathname) {
  const direct = matchPath(pattern, pathname);
  if (direct) return direct;
  const cleanPath = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) || '/' : pathname;
  const cleanPattern = pattern.startsWith(API_PREFIX) ? pattern.slice(API_PREFIX.length) || '/' : pattern;
  return matchPath(cleanPattern, cleanPath);
}

export function matchRoutes(routes, method, pathname) {
  for (const route of routes || []) {
    if (route.method && route.method !== method) continue;
    const params = matchPathLoose(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}

function sendJson(res, status, body, ctx) {
  if (ctx && typeof ctx.json === 'function') return ctx.json(res, status, body);
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
  return undefined;
}

function readJsonBody(req, ctx) {
  if (ctx && typeof ctx.readBody === 'function') return ctx.readBody(req);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError(413, '请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tokenOf(req) {
  const header = req.headers && req.headers['x-tenon-token'];
  if (header) return String(header);
  const cookie = (req.headers && req.headers.cookie) || '';
  for (const part of String(cookie).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'tenon_token') {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return '';
}

function writeAuthError(req, ctx) {
  if (!ctx) return null;
  if (ctx.readOnly) return { status: 423, body: { error: '另一窗口为只读' } };
  if (typeof ctx.authed === 'function') return ctx.authed(req) ? null : { status: 401, body: { error: '需要登录令牌' } };
  const secret = ctx.secret || ctx.tokens || null;
  const expected = (secret && (secret.operatorToken || secret.token)) || ctx.operatorToken || null;
  if (!expected) return null;
  return tokenOf(req) === expected ? null : { status: 401, body: { error: '需要登录令牌' } };
}

function route(method, path, handler) {
  return { method, path, handler };
}

function wrap(routePath, handler) {
  return async function wrappedHandler(req, res, ctx = {}) {
    try {
      const url = ctx.url || new URL(req.url || '/', 'http://127.0.0.1');
      const params = ctx.params || matchPathLoose(routePath, url.pathname) || {};
      const method = req.method || 'GET';
      const isWrite = method !== 'GET';
      if (isWrite) {
        const auth = writeAuthError(req, ctx);
        if (auth) return sendJson(res, auth.status, auth.body, ctx);
      }
      const body = isWrite ? await readJsonBody(req, ctx) : {};
      const out = await handler({ req, res, ctx, url, params, body });
      if (out === undefined) return undefined;
      return sendJson(res, out.status || 200, out.body, ctx);
    } catch (err) {
      const status = (err && err.status) || 500;
      const message = String((err && err.message) || err || '未知错误');
      if (!res.headersSent) return sendJson(res, status, { error: message }, ctx);
      try { res.end(); } catch { /* ignore */ }
      return undefined;
    }
  };
}

export function createRoutes(service) {
  return [
    // 首页：设备 + 程序 + 最近流转 + 建议话术（只读）
    route('GET', '/super/home', wrap('/super/home', async () => ({ body: service.home() }))),

    // 程序清单（probe=1 时尝试实时读电脑 app.list）
    route('GET', '/super/programs', wrap('/super/programs', async ({ url }) => {
      const probe = url.searchParams.get('probe') === '1';
      return { body: await service.programs({ probe }) };
    })),

    // 一句话 → AI/规则意图 → 计划 → 执行
    route('POST', '/super/ask', wrap('/super/ask', async ({ body }) => {
      const text = String((body && body.text) || '').trim();
      if (!text) throw httpError(400, '缺少 text（一句话）');
      const result = await service.ask(text, {
        confirmed: !!(body && body.confirmed),
        context: (body && body.context) || {},
        by: (body && body.by) || '你',
      });
      return { body: { ok: !!result.ok, ...result } };
    })),

    // 手机 → 电脑流转
    route('POST', '/super/handoff', wrap('/super/handoff', async ({ body }) => {
      const result = service.handoff(body || {});
      return { body: { ok: !!result.ok, ...result } };
    })),

    // 最近 asks / handoffs（只读）
    route('GET', '/super/state', wrap('/super/state', async () => ({ body: service.state() }))),
  ];
}

// 完整路径副本（给"不剥前缀"的挂载方式用）
export function absoluteRoutes(routes) {
  return (routes || []).map((r) => ({ ...r, path: API_PREFIX + r.path }));
}

export default createRoutes;