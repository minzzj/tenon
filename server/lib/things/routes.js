// 榫卯 Tenon v2 · 场景 / 物模型 HTTP 路由
//
// 导出 `routes: [{ method, path, handler(req,res,ctx) }]` 供 Lead 在 `server/lib/v2/index.js` 里统一挂载。
// 约定：**path 相对 /api/v2**（Lead 的 createV2 用 `pathname.slice('/api/v2'.length)` 匹配），例如
//   GET  /things/model
//   GET  /scenes ; POST /scenes
//   GET  /scenes/:id ; PUT /scenes/:id ; DELETE /scenes/:id
//   POST /scenes/:id/preview ; POST /scenes/:id/run
// 同时导出 `routesAbsolute`（带 /api/v2 前缀的副本），若挂载方采用「整路径匹配」可直接用。
//
// 鉴权：Lead 的 http.js 已在 v2 分发前做 `method !== 'GET' && !authed(req)` 拦截；
// 本模块再兜底一次（ctx.authed / ctx.secret.operatorToken 任一可用时校验，只读实例写操作 423）。
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

// 兼容「相对路径 / 完整 /api/v2 路径」两种写法
export function matchPathLoose(pattern, pathname) {
  const direct = matchPath(pattern, pathname);
  if (direct) return direct;
  const cleanPath = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) || '/' : pathname;
  const cleanPattern = pattern.startsWith(API_PREFIX) ? pattern.slice(API_PREFIX.length) || '/' : pattern;
  return matchPath(cleanPattern, cleanPath);
}

// 供挂载方（Lead）或测试用：在 routes 表里匹配 method + pathname（完整路径或相对路径都可以）
export function matchRoutes(routes, method, pathname) {
  for (const route of routes || []) {
    if (route.method !== method) continue;
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
  const h = req.headers && req.headers['x-tenon-token'];
  if (h) return String(h);
  // 与 http.js 一致：也接受登录 Cookie
  const cookie = (req.headers && req.headers.cookie) || '';
  for (const part of String(cookie).split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === 'tenon_token') return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

// 写操作鉴权兜底：ctx.authed 优先（Lead 传入）；否则用 ctx.secret.operatorToken 校验 header/cookie
function writeAuthError(req, ctx) {
  if (!ctx) return null;
  if (ctx.readOnly) return { status: 423, body: { error: '另一窗口为只读' } };
  if (typeof ctx.authed === 'function') return ctx.authed(req) ? null : { status: 401, body: { error: '需要登录令牌' } };
  const secret = ctx.secret || ctx.tokens || null;
  const expected = (secret && (secret.operatorToken || secret.token)) || ctx.operatorToken || null;
  if (!expected) return null; // 挂载方未提供鉴权上下文（例如单测直调）：视为已由外层统一鉴权
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
      if (out === undefined) return undefined; // handler 已自行响应
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
    // 物模型：设备属性/动作/事件（只读）
    route('GET', '/things/model', wrap('/things/model', async () => ({ body: { ok: true, ...service.model() } }))),

    // 场景列表
    route('GET', '/scenes', wrap('/scenes', async () => ({ body: { ok: true, scenes: service.listScenes() } }))),

    // 新建场景
    route('POST', '/scenes', wrap('/scenes', async ({ body }) => {
      const scene = service.createScene(body || {});
      return { status: 201, body: { ok: true, scene } };
    })),

    // 单个场景详情
    route('GET', '/scenes/:id', wrap('/scenes/:id', async ({ params }) => {
      const scene = service.getScene(params.id);
      if (!scene) throw httpError(404, `场景不存在：${params.id}`);
      return { body: { ok: true, scene } };
    })),

    // 更新场景（名称 / 描述 / 步骤）
    route('PUT', '/scenes/:id', wrap('/scenes/:id', async ({ params, body }) => {
      const scene = service.updateScene(params.id, body || {});
      return { body: { ok: true, scene } };
    })),

    // 删除场景
    route('DELETE', '/scenes/:id', wrap('/scenes/:id', async ({ params }) => {
      service.removeScene(params.id);
      return { body: { ok: true, removed: true, sceneId: params.id } };
    })),

    // 场景预览（不执行，返回目标设备与是否需要确认）
    route('POST', '/scenes/:id/preview', wrap('/scenes/:id/preview', async ({ params }) => ({ body: { ok: true, ...service.previewScene(params.id) } }))),

    // 执行场景：body { confirmed?: boolean, by?: string }
    route('POST', '/scenes/:id/run', wrap('/scenes/:id/run', async ({ params, body }) => {
      const result = await service.runScene(params.id, {
        confirmed: !!(body && body.confirmed),
        by: (body && body.by) || '你',
      });
      return { body: { ok: !!result.ok, ...result } };
    })),
  ];
}

// 完整路径副本（给「不剥前缀」的挂载方式用；与 routes 逻辑完全一致）
export function absoluteRoutes(routes) {
  return (routes || []).map((r) => ({ ...r, path: API_PREFIX + r.path }));
}

export default createRoutes;