// 榫卯 Tenon v2 · link HTTP 路由表：{method,path,handler(req,res,ctx)} 数组
// Lead 在 http.js 中匹配后调用 handler；ctx 约定：
//   { link, params?, query?, authorize?(req) } —— params/query 缺省时本模块会从 req.url 解析兜底。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonBody, readBody, sendJson, httpError, sanitizeName } from './util.js';
import { PAIR_ACTIONS, PAIR_CAPABILITIES } from './pairing.js';
import { matchRoutes } from './router.js';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.zip': 'application/zip',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

function serviceOf(ctx) {
  const link = ctx && (ctx.link || ctx.linkService || (ctx.services && ctx.services.link));
  if (!link) throw httpError(500, 'link 服务未挂载：ctx.link 缺失');
  return link;
}

function queryValue(ctx, req, name) {
  const q = ctx && ctx.query;
  if (q && typeof q.get === 'function') return q.get(name);
  if (q && typeof q === 'object') return q[name] != null ? q[name] : null;
  try {
    return new URL(req.url, 'http://placeholder').searchParams.get(name);
  } catch {
    return null;
  }
}

function paramsOf(ctx, req) {
  if (ctx && ctx.params && typeof ctx.params === 'object') return ctx.params;
  try {
    const url = new URL(req.url, 'http://placeholder');
    const matched = matchRoutes(routeDefs, req.method, url.pathname);
    return matched ? matched.params : {};
  } catch {
    return {};
  }
}

function clientIp(req) {
  const forwarded = req.headers && req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  const raw = (req.socket && req.socket.remoteAddress) || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function authenticate(link, ctx, req) {
  const auth = ctx && typeof ctx.authorize === 'function' ? ctx.authorize(req) : link.authorize(req);
  if (!auth || !auth.ok) throw httpError((auth && auth.status) || 401, (auth && auth.error) || '需要登录令牌');
  return auth;
}

function requireOperator(link, ctx, req) {
  const auth = authenticate(link, ctx, req);
  if (!['operator', 'node'].includes(auth.role)) throw httpError(403, '需要操作员令牌');
  return auth;
}

function assertPeerMatchesTransfer(auth, transfer) {
  if (auth.role === 'peer' && transfer && String(transfer.peerId) !== String(auth.peerId)) {
    throw httpError(403, '无权访问其它设备的传输');
  }
}

function guessType(name) {
  return MIME[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream';
}

// HTTP 头必须是 latin1 字节：中文文件名不能直接放 filename="..."，只保留 ASCII 兜底 + RFC 5987 的 filename*
function contentDisposition(name) {
  const safe = sanitizeName(name, 'download');
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  return 'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe);
}

function wrap(fn) {
  return async function handler(req, res, ctx) {
    try {
      const link = ctx && (ctx.link || ctx.linkService || (ctx.services && ctx.services.link));
      // 只读第二实例：非 GET 一律 423（http.js 会先拦一次，这里再做模块级兜底）
      if (link && link.readOnly && String(req.method || '').toUpperCase() !== 'GET') {
        return sendJson(res, 423, { ok: false, error: '另一窗口为只读' });
      }
      await fn(req, res, ctx || {});
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
        return;
      }
      const code = Number(err && err.statusCode) || 500;
      sendJson(res, code, { ok: false, error: String((err && err.message) || err) });
    }
  };
}

function clipboardView(item) {
  if (!item) return null;
  return { at: item.at, from: item.from, kind: item.kind, preview: item.preview, text: item.text };
}

// 文件下载（三种别名共用）：/transfer/:id/file、/transfer/:id/download、GET /transfer/:id/chunk
const downloadFileHandler = wrap(async (req, res, ctx) => {
  const link = serviceOf(ctx);
  const auth = authenticate(link, ctx, req);
  const params = paramsOf(ctx, req);
  const index = Number(queryValue(ctx, req, 'index') || queryValue(ctx, req, 'file') || 0);
  const info = link.transfer.fileInfo(params.id, index);
  assertPeerMatchesTransfer(auth, info.transfer);
  res.writeHead(200, {
    'Content-Type': guessType(info.file.name),
    'Content-Length': info.size,
    'Content-Disposition': contentDisposition(info.file.name),
    'Cache-Control': 'no-store',
  });
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(info.path);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
});

// 通知镜像事件（/notification 与 Android 用的 /notify 两个别名共用）
const notificationHandler = wrap(async (req, res, ctx) => {
  const link = serviceOf(ctx);
  const auth = authenticate(link, ctx, req);
  const body = await readJsonBody(req);
  const from = body.from || (auth.role === 'peer' ? auth.peerId : 'operator');
  link.notifier.relay({ from, app: body.app || '', title: body.title || '', text: body.text || body.preview || '', to: body.to || null });
  sendJson(res, 200, { ok: true });
});

export const routeDefs = [
  // ---- 基础信息 / 发现 ----
  {
    method: 'GET',
    path: '/api/v2/link/info',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      sendJson(res, 200, { ok: true, ...link.info() });
    }),
  },
  {
    method: 'GET',
    path: '/api/v2/link/peers',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      sendJson(res, 200, { ok: true, ...link.peersInfo() });
    }),
  },
  // ---- Round2 P0-1：配对前置自检（六项 + 三步修复 + 诊断文本；手输码兜底不阻塞） ----
  {
    method: 'GET',
    path: '/api/v2/link/preflight',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      const headers = (req && req.headers) || {};
      const query = (ctx && ctx.query) || null;
      const queryClientIp = queryValue(ctx, req, 'clientIp') || queryValue(ctx, req, 'ip') || '';
      const forwarded = String(headers['x-forwarded-for'] || headers['x-real-ip'] || '').split(',')[0].trim();
      const socketIp = clientIp(req).replace(/^::ffff:/, '');
      const effectiveIp = String(queryClientIp || forwarded || socketIp || '');
      const queryVersion = queryValue(ctx, req, 'clientVersion') || queryValue(ctx, req, 'v') || '';
      const headerVersion = String(headers['x-tenon-client-version'] || headers['x-client-version'] || headers['x-tenon-version'] || '');
      const clientVersion = String(queryVersion || headerVersion || '');
      let result;
      try {
        result = await link.preflight.run({ clientIp: effectiveIp, clientVersion });
      } catch (err) {
        result = { ok: false, allPass: false, items: [], diagnostics: '自检异常：' + String((err && err.message) || err), at: new Date().toISOString() };
      }
      sendJson(res, 200, { ok: true, ...result });
    }),
  },
  // ---- Round2 P0-5：撤销前影响预览（确定/可能/未知，只读、可重复调用） ----
  {
    method: 'GET',
    path: '/api/v2/link/revoke/preview',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      requireOperator(link, ctx, req);
      const peerId = String(queryValue(ctx, req, 'peerId') || queryValue(ctx, req, 'deviceId') || '').trim();
      if (!peerId) throw httpError(400, '缺少 peerId');
      const devices = ctx.services && ctx.services.devices;
      if (devices && typeof devices.impact === 'function') {
        sendJson(res, 200, devices.impact(peerId, { linkService: link, things: ctx.services && ctx.services.things }));
        return;
      }
      // 兜底：无 devices 模块时给出最小影响预览
      const transfers = link.transfer && typeof link.transfer.listAll === 'function' ? link.transfer.listAll(100) : [];
      const active = transfers.filter((t) => String(t.peerId || '') === peerId && ['active', 'ready', 'uploading', 'receiving', 'pending', 'queued'].includes(String(t.status))).length;
      sendJson(res, 200, {
        ok: true,
        target: { id: peerId, name: peerId },
        counts: { certain: active, possible: 0, unknown: 1 },
        impact: { certain: active, possible: 0, unknown: 1 },
        items: { certain: [], possible: [], unknown: [{ type: 'relation', id: 'unknown-relations', title: '无记录的间接引用', detail: '无记录不等于无引用，仅可人工确认' }] },
        sentence: '确定影响 ' + active + ' 项 · 未知 1 项',
        cancelHint: '取消不产生任何变化',
        at: new Date().toISOString(),
      });
    }),
  },
  {
    method: 'GET',
    path: '/api/v2/link/revoke-preview',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      requireOperator(link, ctx, req);
      const peerId = String(queryValue(ctx, req, 'peerId') || queryValue(ctx, req, 'deviceId') || '').trim();
      if (!peerId) throw httpError(400, '缺少 peerId');
      const devices = ctx.services && ctx.services.devices;
      if (devices && typeof devices.impact === 'function') {
        sendJson(res, 200, devices.impact(peerId, { linkService: link, things: ctx.services && ctx.services.things }));
        return;
      }
      sendJson(res, 200, { ok: true, target: { id: peerId, name: peerId }, counts: { certain: 0, possible: 0, unknown: 1 }, impact: { certain: 0, possible: 0, unknown: 1 } });
    }),
  },
  // ---- 配对 ----
  {
    method: 'GET',
    path: '/api/v2/link/pair/qr',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      requireOperator(link, ctx, req);
      sendJson(res, 200, { ok: true, ...link.pairingInfo() });
    }),
  },
  // ---- Round2 P0-3：配对成功页动作三「把当前页面甩过去」 ----
  // 走 link 模块（http.js 对 link 放行 peerToken），内部转交 super.handoff，手机/桌面配对后无需 operator token。
  {
    method: 'POST',
    path: '/api/v2/link/handoff',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      const auth = authenticate(link, ctx, req);
      const body = await readJsonBody(req);
      const superSvc = ctx.services && ctx.services.super;
      if (!superSvc || typeof superSvc.handoff !== 'function') throw httpError(503, '流转服务未就绪');
      const payload = {
        ...body,
        fromDevice: body.fromDevice || auth.peerId || 'phone',
        by: body.by || (auth.role === 'peer' ? '手机' : '你'),
      };
      const result = superSvc.handoff(payload);
      sendJson(res, 200, { ok: !!result.ok, ...result, via: 'link' });
    }),
  },
  {
    method: 'POST',
    path: '/api/v2/link/pair/regenerate',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      requireOperator(link, ctx, req);
      sendJson(res, 200, { ok: true, ...link.pairing.regenerateCode() });
    }),
  },
  {
    method: 'POST',
    path: '/api/v2/link/pair',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      const body = await readJsonBody(req);
      // 入站配对的三种形态（码本身就是凭证，不需要 operator token）：
      // 1) {code, from:{deviceId,...}} 对端已带身份；2) Android 只带 {code}（自动生成设备身份）；3) 带 deviceId/name/platform 但无 from
      let from = null;
      if (body.from && body.from.deviceId) from = body.from;
      else if (body.code && !body.host && !body.peerHost) {
        from = {
          deviceId: body.deviceId || 'dev_pair_' + crypto.randomBytes(4).toString('hex'),
          name: body.name || 'Android 设备',
          platform: body.platform || 'android',
          fingerprint: body.fingerprint || '',
          port: Number(body.port || 0),
        };
      }
      if (from) {
        const result = link.pairing.acceptInbound({ code: body.code, from, ip: clientIp(req), by: body.by || 'code' });
        if (!result.ok) return sendJson(res, result.status || 403, { ok: false, error: result.error || '配对失败' });
        // 顶层字段供 Android App 直接使用：peerId = 本机（hub）deviceId，token = 后续请求的会话 token
        return sendJson(res, 200, {
          ok: true,
          paired: true,
          peerId: result.peerId,
          name: result.self.name,
          platform: result.self.platform,
          token: result.token || result.peerToken,
          peerToken: result.peerToken,
          peer: result.peer,
          self: result.self,
          // P0-3 配对成功页：能力清单 + 3 个一键动作
          actions: result.actions || [],
          nextActions: result.actions || [],
          capabilities: result.capabilities || [],
        });
      }
      // 出站配对：我们的 UI 输入对端码 + host/port，由本机主动调对端（需要 operator token）
      requireOperator(link, ctx, req);
      const host = body.host || body.peerHost || '';
      const port = Number(body.port || body.peerPort || 0);
      const result = await link.pairing.initiate({ code: body.code, host, port, by: body.by || 'code' });
      if (!result.ok) return sendJson(res, result.status || 502, { ok: false, error: result.error || '配对失败' });
      return sendJson(res, 200, {
        ok: true,
        peerId: result.peerId,
        name: (result.peer && result.peer.name) || '',
        platform: (result.peer && result.peer.platform) || '',
        peer: result.peer,
        actions: PAIR_ACTIONS,
        nextActions: PAIR_ACTIONS,
        capabilities: PAIR_CAPABILITIES,
      });
    }),
  },
  {
    method: 'POST',
    path: '/api/v2/link/revoke',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      const auth = authenticate(link, ctx, req);
      const body = await readJsonBody(req);
      if (auth.role === 'peer' && String(body.peerId) !== String(auth.peerId)) throw httpError(403, '只能撤销与本机配对的设备');
      const result = await link.pairing.revoke(body.peerId, body.reason || '用户撤销');
      if (!result.ok) return sendJson(res, result.status || 404, { ok: false, error: result.error });
      return sendJson(res, 200, { ok: true, peerId: result.peerId, reason: result.reason, remoteRevoked: !!result.remoteRevoked });
    }),
  },
  // ---- 传输（手机 -> 电脑 / 桌面 -> 手机 同一套状态机） ----
  {
    method: 'POST',
    path: '/api/v2/link/transfer/init',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      const auth = authenticate(link, ctx, req);
      const body = await readJsonBody(req);
      if (!body.peerId) throw httpError(400, '缺少 peerId');
      if (auth.role === 'peer' && String(body.peerId) !== String(auth.peerId)) throw httpError(403, 'peerId 与登录设备不一致');
      const peer = link.pairing.getPeer(body.peerId);
      const transfer = link.transfer.create({
        peerId: body.peerId,
        peerName: (peer && peer.name) || body.peerName || '',
        direction: body.direction,
        files: body.files,
      });
      sendJson(res, 200, { ok: true, ...transfer, chunkSize: link.transfer.chunkSize });
    }),
  },
  {
    method: 'PUT',
    path: '/api/v2/link/transfer/:id/chunk',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      const auth = authenticate(link, ctx, req);
      const params = paramsOf(ctx, req);
      const current = link.transfer.get(params.id);
      if (!current) throw httpError(404, '传输不存在：' + params.id);
      assertPeerMatchesTransfer(auth, current);
      const buffer = await readBody(req, 16 * 1024 * 1024);
      const result = link.transfer.putChunk(params.id, {
        offset: Number(queryValue(ctx, req, 'offset') || 0),
        file: Number(queryValue(ctx, req, 'file') || 0),
        buffer,
      });
      sendJson(res, 200, result);
    }),
  },
  {
    method: 'GET',
    path: '/api/v2/link/transfers',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      requireOperator(link, ctx, req);
      const nodeId = String(queryValue(ctx, req, 'nodeId') || '');
      const state = String(queryValue(ctx, req, 'state') || 'incoming');
      sendJson(res, 200, { ok: true, transfers: link.transfer.listIncoming({ nodeId, state }) });
    }),
  },
  {
    method: 'POST',
    path: '/api/v2/link/transfer/send',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      requireOperator(link, ctx, req);
      const body = await readJsonBody(req);
      const result = await link.transfer.sendToPeer({
        peerId: body.peerId, filePath: body.path || body.filePath, name: body.name,
        direction: body.direction, maxBytes: body.maxBytes, resumeTransferId: body.transferId, target: body.target,
      });
      sendJson(res, 200, { ok: true, ...result });
    }),
  },
  {
    method: 'POST',
    path: '/api/v2/link/transfer/resume',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      requireOperator(link, ctx, req);
      const body = await readJsonBody(req);
      const result = await link.transfer.resumeToPeer({
        peerId: body.peerId, transferId: body.transferId, filePath: body.path || body.filePath,
        name: body.name, direction: body.direction,
      });
      sendJson(res, 200, { ok: true, ...result });
    }),
  },
  {
    method: 'GET',
    path: '/api/v2/link/transfer/:id',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      const auth = authenticate(link, ctx, req);
      const params = paramsOf(ctx, req);
      const transfer = link.transfer.get(params.id);
      if (!transfer) throw httpError(404, '传输不存在：' + params.id);
      assertPeerMatchesTransfer(auth, transfer);
      sendJson(res, 200, { ok: true, transfer });
    }),
  },
  { method: 'GET', path: '/api/v2/link/transfer/:id/file', handler: downloadFileHandler },
  // Android 双兜底别名：/download 与 GET /chunk（返回完整文件二进制）
  { method: 'GET', path: '/api/v2/link/transfer/:id/download', handler: downloadFileHandler },
  { method: 'GET', path: '/api/v2/link/transfer/:id/chunk', handler: downloadFileHandler },
  {
    method: 'POST',
    path: '/api/v2/link/transfer/:id/finish',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      const auth = authenticate(link, ctx, req);
      const params = paramsOf(ctx, req);
      const current = link.transfer.get(params.id);
      if (!current) throw httpError(404, '传输不存在：' + params.id);
      assertPeerMatchesTransfer(auth, current);
      const body = await readJsonBody(req).catch(() => ({}));
      const result = await link.transfer.finish(params.id, { sha256: body.sha256 });
      const code = result.ok === false ? result.status || 422 : 200;
      sendJson(res, code, result);
    }),
  },
  {
    method: 'POST',
    path: '/api/v2/link/transfer/:id/ack',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      requireOperator(link, ctx, req);
      const params = paramsOf(ctx, req);
      const body = await readJsonBody(req);
      const result = link.transfer.ack(params.id, {
        nodeId: body.nodeId, saved: body.saved, ok: body.ok !== false,
      });
      sendJson(res, 200, { ok: true, ...result });
    }),
  },
  // ---- 剪贴板 ----
  {
    method: 'POST',
    path: '/api/v2/link/clipboard',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      const auth = authenticate(link, ctx, req);
      const body = await readJsonBody(req);
      const from = body.from || (auth.role === 'peer' ? auth.peerId : 'operator');
      const item = link.clipboard.share({
        from, kind: body.kind || 'text', text: body.text || '', to: body.to || null,
        files: body.files, transferId: body.transferId, preview: body.preview,
      });
      sendJson(res, 200, { ok: true, clipboard: clipboardView(item) });
    }),
  },
  {
    method: 'GET',
    path: '/api/v2/link/clipboard/latest',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      const auth = authenticate(link, ctx, req);
      const forDevice = String(queryValue(ctx, req, 'for') || queryValue(ctx, req, 'deviceId') || (auth.role === 'peer' ? auth.peerId : ''));
      const item = link.clipboard.latest({ forDevice: forDevice || null });
      sendJson(res, 200, { ok: true, clipboard: clipboardView(item) });
    }),
  },
  // ---- 通知镜像 ----
  { method: 'POST', path: '/api/v2/link/notification', handler: notificationHandler },
  { method: 'POST', path: '/api/v2/link/notify', handler: notificationHandler },
  {
    method: 'GET',
    path: '/api/v2/link/notifications',
    handler: wrap(async (req, res, ctx) => {
      const link = serviceOf(ctx);
      authenticate(link, ctx, req);
      const limit = Number(queryValue(ctx, req, 'limit') || 20);
      sendJson(res, 200, { ok: true, notifications: link.notifier.list(limit) });
    }),
  },
];

/** 绑定到具体 service 实例（Lead 也可直接用静态 routeDefs + ctx.link） */
export function createBoundRoutes(service) {
  return routeDefs.map((route) => ({
    method: route.method,
    path: route.path,
    handler: (req, res, extra = {}) => route.handler(req, res, { ...extra, link: service }),
  }));
}

/** 最终 routes 清单（报告/前端/Lead 集成核对用） */
export function getRouteList() {
  return routeDefs.map((route) => ({ method: route.method, path: route.path }));
}

export { routeDefs as routes };
export default routeDefs;