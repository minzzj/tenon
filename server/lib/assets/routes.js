// 榫卯 v2 · 素材中心 · HTTP 路由（契约 §4；由 Lead 在 server/lib/http.js 统一挂载）
// 约定：routes = [{ method, path, auth, handler(req,res,ctx) }]
//   - path 支持 :param 占位（如 /api/v2/assets/:id）
//   - auth=true 表示写操作，挂载器需校验 x-tenon-token（或 v2 会话令牌）
//   - ctx 由挂载器提供，可选字段：query(URLSearchParams)、params、operatorToken、checkAuth(req)
// 另导出 createRouteDispatcher(routes)：零依赖的小分发器，便于 Lead 直接挂载或测试。

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
  }
  res.end(body);
}

export function sendError(res, err) {
  const statusCode = (err && err.statusCode) || 400;
  const code = (err && err.code) || 'BAD_REQUEST';
  const message = String((err && err.message) || err || '未知错误');
  if (res.headersSent) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  sendJson(res, statusCode, { ok: false, error: message, code });
}

export function sendBinary(res, buffer, { contentType = 'application/octet-stream', statusCode = 200, cacheMaxAge = 3600 } = {}) {
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      'Content-Type': contentType,
      'Content-Length': buffer.length,
      'Cache-Control': 'public, max-age=' + cacheMaxAge,
    });
  }
  res.end(buffer);
}

export function httpError(message, statusCode = 400, code = 'BAD_REQUEST') {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

export async function readRawBody(req, limitBytes = 256 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw httpError('请求体过大（上限 ' + Math.round(limitBytes / 1048576) + 'MB）', 413, 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req, limitBytes = 4 * 1024 * 1024) {
  const raw = await readRawBody(req, limitBytes);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw httpError('请求体不是合法 JSON', 400, 'INVALID_JSON');
  }
}

/** 极简 multipart/form-data 解析（零依赖；整体读入内存，P0 上传用）。 */
export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) throw httpError('缺少 multipart boundary', 400, 'INVALID_MULTIPART');
  const boundary = '--' + String(m[1] || m[2]).trim();
  const raw = buffer.toString('latin1');
  const parts = raw.split(boundary);
  const result = { fields: {}, files: [] };
  for (const part of parts) {
    if (!part || /^--\s*$/.test(part)) continue;
    const body = part.replace(/^\r\n/, '');
    const headerEnd = body.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headerText = body.slice(0, headerEnd);
    let content = body.slice(headerEnd + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    if (!nameMatch) continue;
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    if (fileMatch) {
      if (!fileMatch[1]) continue;
      const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
      result.files.push({
        field: nameMatch[1],
        filename: fileMatch[1],
        contentType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        data: Buffer.from(content, 'latin1'),
      });
    } else {
      result.fields[nameMatch[1]] = Buffer.from(content, 'latin1').toString('utf8');
    }
  }
  return result;
}

function queryOf(req, ctx) {
  if (ctx && ctx.query && typeof ctx.query.get === 'function') return ctx.query;
  return new URL(req.url || '/', 'http://127.0.0.1').searchParams;
}

function wrap(handler) {
  return async function wrapped(req, res, ctx) {
    try {
      await handler(req, res, ctx);
    } catch (err) {
      sendError(res, err);
    }
  };
}

/** 构造素材中心路由表（依赖 service 实例）。 */
export function createAssetRoutes(service) {
  if (!service) throw new Error('createAssetRoutes 需要 service');

  const routes = [];
  const add = (method, path, handler, extra = {}) => {
    routes.push({ method, path, auth: method !== 'GET', handler: wrap(handler), ...extra });
  };

  // ---- 列表 / 搜索 / 过滤 / 分页：GET /api/v2/assets?q=&kind=&device=&from=&to=&limit=&offset= ----
  add('GET', '/api/v2/assets', async (req, res, ctx) => {
    const q = queryOf(req, ctx);
    const result = service.list({
      q: q.get('q') || '',
      kind: q.get('kind') || '',
      device: q.get('device') || '',
      from: q.get('from') || '',
      to: q.get('to') || '',
      limit: q.get('limit') || undefined,
      offset: q.get('offset') || undefined,
      includeRemoved: q.get('includeRemoved') === '1' || q.get('includeRemoved') === 'true',
    });
    sendJson(res, 200, { ok: true, ...result });
  });

  // ---- 统计：GET /api/v2/assets/stats ----
  add('GET', '/api/v2/assets/stats', async (req, res) => {
    sendJson(res, 200, { ok: true, ...(await service.stats()) });
  });

  // ---- 中转站（契约要求 POST；另外补 GET 列表 / POST take 供 UI 取用） ----
  add('GET', '/api/v2/assets/basket', async (req, res, ctx) => {
    const q = queryOf(req, ctx);
    sendJson(res, 200, { ok: true, ...service.basketList({ to: q.get('to') || null, status: q.get('status') || null }) });
  });

  add('POST', '/api/v2/assets/basket/take', async (req, res, ctx) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, ...service.basketTake(body) });
  });

  add('POST', '/api/v2/assets/basket', async (req, res) => {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, ...service.basketAdd(body) });
  });
  add('DELETE', '/api/v2/assets/basket', async (req, res) => {
    // body 可为空（= 清空全部）或 {ids:[...]}（= 批量移除）；非法 JSON 交给 readJsonBody 回 400，避免误清空
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) && body.ids.length ? body.ids.map(String) : null;
    const result = service.basketClear({ ids });
    sendJson(res, 200, { ok: true, removed: result.removed, remaining: result.remaining, items: result.items });
  });


  // ---- 入库：POST /api/v2/assets/ingest {deviceId,path} 或 multipart 上传 ----
  add('POST', '/api/v2/assets/ingest', async (req, res) => {
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.toLowerCase().includes('multipart/form-data')) {
      const raw = await readRawBody(req);
      const parsed = parseMultipart(raw, contentType);
      if (!parsed.files.length) throw httpError('multipart 请求中没有文件', 400, 'NO_FILES');
      const deviceId = parsed.fields.deviceId || 'upload';
      const results = [];
      for (const file of parsed.files) {
        results.push(await service.ingestBuffer({ deviceId, name: file.filename, buffer: file.data }));
      }
      sendJson(res, 200, {
        ok: true,
        count: results.length,
        items: results.map((r) => ({ asset: service.serialize(r.asset), deduped: r.deduped, ocrQueued: r.ocrQueued })),
      });
      return;
    }
    const body = await readJsonBody(req);
    if (Array.isArray(body.items)) {
      const out = [];
      for (const item of body.items) {
        out.push(await service.ingest({ deviceId: item.deviceId || body.deviceId || 'hub', filePath: item.path, name: item.name }));
      }
      sendJson(res, 200, { ok: true, count: out.length, items: out.map((r) => ({ asset: service.serialize(r.asset), deduped: r.deduped, ocrQueued: r.ocrQueued })) });
      return;
    }
    if (!body.path) throw httpError('缺少 path（电脑路径）或 multipart 文件', 400, 'MISSING_PATH');
    const filePath = String(body.path);
    const stat = await service.statPath(filePath);
    if (stat.isDirectory()) {
      const result = await service.ingestDirectory({ deviceId: body.deviceId || 'hub', dir: filePath });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    const result = await service.ingest({ deviceId: body.deviceId || 'hub', filePath, name: body.name });
    sendJson(res, 200, { ok: true, count: 1, items: [{ asset: service.serialize(result.asset), deduped: result.deduped, ocrQueued: result.ocrQueued }] });
  });

  // ---- 缩略图二进制：GET /api/v2/assets/:id/thumb?w=320|640 ----
  add('GET', '/api/v2/assets/:id/thumb', async (req, res, ctx) => {
    const id = (ctx && ctx.params && ctx.params.id) || '';
    const w = Number(queryOf(req, ctx).get('w')) || 640;
    const thumb = await service.thumb(id, w);
    sendBinary(res, thumb.buffer, { contentType: thumb.mime, cacheMaxAge: 86400 });
  });

  // ---- 谱系 / 来源 / 引用：GET /api/v2/assets/:id/lineage ----
  add('GET', '/api/v2/assets/:id/lineage', async (req, res, ctx) => {
    const id = (ctx && ctx.params && ctx.params.id) || '';
    sendJson(res, 200, { ok: true, ...service.lineage(id) });
  });

  // ---- 打标签：POST /api/v2/assets/:id/tags {tags:[...]} ----
  add('POST', '/api/v2/assets/:id/tags', async (req, res, ctx) => {
    const id = (ctx && ctx.params && ctx.params.id) || '';
    const body = await readJsonBody(req);
    const tags = Array.isArray(body.tags) ? body.tags : (body.tag ? [body.tag] : []);
    if (!tags.length) throw httpError('缺少 tags', 400, 'MISSING_TAGS');
    const asset = service.tag(id, tags, body.by === 'ai' ? 'ai' : 'user');
    sendJson(res, 200, { ok: true, asset: service.serialize(asset) });
  });

  // ---- 详情：GET /api/v2/assets/:id ----
  add('GET', '/api/v2/assets/:id', async (req, res, ctx) => {
    const id = (ctx && ctx.params && ctx.params.id) || '';
    const detail = service.get(id, { lineage: true });
    sendJson(res, 200, { ok: true, ...detail });
  });

  return routes;
}

/** 模板路径匹配：支持 :param，返回 params 或 null。 */
export function matchPath(template, pathname) {
  const t = String(template).split('/');
  const p = String(pathname).split('/');
  if (t.length !== p.length) return null;
  const params = {};
  for (let i = 0; i < t.length; i += 1) {
    if (t[i].startsWith(':')) {
      params[t[i].slice(1)] = decodeURIComponent(p[i]);
    } else if (t[i] !== p[i]) {
      return null;
    }
  }
  return params;
}

export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}

/**
 * 零依赖小分发器：const dispatch = createRouteDispatcher(service.routes);
 * httpServer 里 await dispatch(req,res,ctx)（返回 false 表示未命中）。
 * ctx 可传 { checkAuth: async (req) => bool }；命中 auth=true 的路由且 ctx.checkAuth 返回 false 时回 401。
 */
export function createRouteDispatcher(routes, { basePath = '' } = {}) {
  return async function dispatch(req, res, ctx = {}) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    let pathname = url.pathname;
    if (basePath && pathname.startsWith(basePath)) pathname = pathname.slice(basePath.length) || '/';
    const found = matchRoute(routes, req.method, pathname);
    if (!found) return false;
    if (found.route.auth && typeof ctx.checkAuth === 'function') {
      const allowed = await ctx.checkAuth(req);
      if (!allowed) {
        sendJson(res, 401, { ok: false, error: '需要登录令牌', code: 'UNAUTHORIZED' });
        return true;
      }
    }
    const params = { ...found.params, ...(ctx.params || {}) };
    await found.route.handler(req, res, { ...ctx, url, query: url.searchParams, params });
    return true;
  };
}