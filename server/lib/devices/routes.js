// 榫卯 v2.2 · 设备绑定路由：{method,path,handler(req,res,ctx)}
// 与其它 v2 模块一致：service.routes 交给 Lead 的 server/lib/v2/index.js 统一挂载。
// ctx 约定：{ services, secret, ledger, params?, query?, url?, authed? }
import { readJsonBody, sendJson, sendText, jsonError, getHeader, operatorTokenOf, isOperator } from './util.js';

function serviceOf(ctx) {
  const svc = ctx && ((ctx.services && ctx.services.devices) || ctx.devices || ctx.deviceService);
  if (!svc) throw new Error('devices 服务未挂载：ctx.services.devices 缺失');
  return svc;
}

function paramsOf(ctx, req) {
  if (ctx && ctx.params && typeof ctx.params === 'object') return ctx.params;
  try {
    const url = new URL(req.url, 'http://placeholder');
    const m = url.pathname.match(/^\/api\/v2\/devices\/([^/]+)(?:\/(bind|unbind|action|rename|impact|revoke-preview|unbind-preview))?$/);
    return m ? { id: decodeURIComponent(m[1]), action: m[2] } : {};
  } catch {
    return {};
  }
}

function guardWrite(svc, req, ctx) {
  if (svc.readOnly) {
    const err = new Error('另一窗口为只读');
    err.statusCode = 423;
    throw err;
  }
  const allowed = (ctx && typeof ctx.authed === 'function' && ctx.authed(req)) || isOperator(svc, operatorTokenOf(req, getHeader));
  if (!allowed) {
    const err = new Error('需要登录令牌');
    err.statusCode = 401;
    throw err;
  }
}

function wrap(fn) {
  return async function handler(req, res, ctx) {
    try {
      await fn(req, res, ctx || {});
    } catch (err) {
      const code = Number(err && err.statusCode) || 500;
      const extra = err && err.payload && typeof err.payload === 'object' ? err.payload : {};
      if (!res.headersSent) sendJson(res, code, { ok: false, error: String((err && err.message) || err), ...extra });
      else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  };
}

export function createDeviceRoutes(service) {
  return [
    {
      method: 'GET',
      path: '/api/v2/devices',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        sendJson(res, 200, svc.listDevices({ linkService: ctx.services && ctx.services.link }));
      }),
    },
    {
      method: 'GET',
      path: '/api/v2/devices/install',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        sendJson(res, 200, { ok: true, install: svc.installInfo() });
      }),
    },
    // Round4 · 设备槽位设置：个人 3 / 家庭 8（可配置）+ 到上限的最久未活跃 3 台建议
    {
      method: 'GET',
      path: '/api/v2/devices/settings',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        sendJson(res, 200, { ok: true, settings: svc.settingsInfo(ctx.services && ctx.services.link) });
      }),
    },
    {
      method: 'PATCH',
      path: '/api/v2/devices/settings',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        guardWrite(svc, req, ctx);
        const body = await readJsonBody(req).catch(() => ({}));
        const result = svc.updateSettings(body, { by: body.by || '你', linkService: ctx.services && ctx.services.link });
        sendJson(res, 200, result);
      }),
    },
    {
      method: 'POST',
      path: '/api/v2/devices/settings',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        guardWrite(svc, req, ctx);
        const body = await readJsonBody(req).catch(() => ({}));
        const result = svc.updateSettings(body, { by: body.by || '你', linkService: ctx.services && ctx.services.link });
        sendJson(res, 200, result);
      }),
    },
    {
      method: 'GET',
      path: '/api/v2/devices/:id/impact',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        const params = paramsOf(ctx, req);
        sendJson(res, 200, svc.impact(params.id, { linkService: ctx.services && ctx.services.link, things: ctx.services && ctx.services.things }));
      }),
    },
    {
      method: 'GET',
      path: '/api/v2/devices/:id/revoke-preview',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        const params = paramsOf(ctx, req);
        sendJson(res, 200, svc.impact(params.id, { linkService: ctx.services && ctx.services.link, things: ctx.services && ctx.services.things }));
      }),
    },
    {
      method: 'GET',
      path: '/api/v2/devices/:id/unbind-preview',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        const params = paramsOf(ctx, req);
        sendJson(res, 200, svc.impact(params.id, { linkService: ctx.services && ctx.services.link, things: ctx.services && ctx.services.things }));
      }),
    },
    {
      method: 'POST',
      path: '/api/v2/devices/:id/rename',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        guardWrite(svc, req, ctx);
        const params = paramsOf(ctx, req);
        const body = await readJsonBody(req).catch(() => ({}));
        const result = svc.rename(params.id, body.name, { by: body.by || '你', linkService: ctx.services && ctx.services.link });
        sendJson(res, 200, result);
      }),
    },
    {
      method: 'POST',
      path: '/api/v2/devices/:id/bind',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        guardWrite(svc, req, ctx);
        const params = paramsOf(ctx, req);
        const body = await readJsonBody(req).catch(() => ({}));
        const result = svc.bind(params.id, { by: body.by || '你', linkService: ctx.services && ctx.services.link });
        sendJson(res, result.already ? 200 : 200, result);
      }),
    },
    {
      method: 'POST',
      path: '/api/v2/devices/:id/unbind',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        guardWrite(svc, req, ctx);
        const params = paramsOf(ctx, req);
        const body = await readJsonBody(req).catch(() => ({}));
        const result = svc.unbind(params.id, { reason: body.reason || '用户解绑' });
        sendJson(res, 200, result);
      }),
    },
    {
      method: 'POST',
      path: '/api/v2/devices/:id/action',
      handler: wrap(async (req, res, ctx) => {
        const svc = serviceOf(ctx);
        guardWrite(svc, req, ctx);
        const params = paramsOf(ctx, req);
        const body = await readJsonBody(req).catch(() => ({}));
        const result = svc.action(params.id, body.action, { linkService: ctx.services && ctx.services.link });
        sendJson(res, 200, result);
      }),
    },
  ];
}

export const ROUTES = [
  { method: 'GET', path: '/api/v2/devices' },
  { method: 'GET', path: '/api/v2/devices/install' },
  { method: 'GET', path: '/api/v2/devices/settings' },
  { method: 'PATCH', path: '/api/v2/devices/settings' },
  { method: 'POST', path: '/api/v2/devices/settings' },
  { method: 'GET', path: '/api/v2/devices/:id/impact' },
  { method: 'GET', path: '/api/v2/devices/:id/revoke-preview' },
  { method: 'GET', path: '/api/v2/devices/:id/unbind-preview' },
  { method: 'POST', path: '/api/v2/devices/:id/rename' },
  { method: 'POST', path: '/api/v2/devices/:id/bind' },
  { method: 'POST', path: '/api/v2/devices/:id/unbind' },
  { method: 'POST', path: '/api/v2/devices/:id/action' },
];

export default createDeviceRoutes;