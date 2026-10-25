import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULES = [
  { dir: 'link', name: 'link', factory: 'createLinkService' },
  { dir: 'assets', name: 'assets', factory: 'createAssetService' },
  { dir: 'things', name: 'things', factory: 'createThingsService' },
  { dir: 'enterprise', name: 'enterprise', factory: 'createEnterpriseService' },
  { dir: 'super', name: 'super', factory: 'createSuperService' },
  { dir: 'devices', name: 'devices', factory: 'createDevicesService' },
];

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function matchRoute(route, method, rel) {
  if (route.method && route.method !== method) return null;
  let pattern = route.path || route.url;
  if (!pattern) return null;
  if (pattern.startsWith('/api/v2')) pattern = pattern.slice('/api/v2'.length) || '/';
  if (pattern === rel) return { params: {} };
  const pp = pattern.split('/').filter(Boolean);
  const rp = rel.split('/').filter(Boolean);
  if (pp.length !== rp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i += 1) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(rp[i]);
    else if (pp[i] !== rp[i]) return null;
  }
  return { params };
}

export async function createV2({ root, ledger, state, ai, secret, readOnly, dataDir, authed }) {
  const services = {};
  const routes = [];
  const mountErrors = [];
  for (const m of MODULES) {
    const file = path.join(root, 'server', 'lib', m.dir, 'index.js');
    if (!fs.existsSync(file)) { mountErrors.push(`${m.name}:not-implemented`); continue; }
    try {
      const mod = await import(pathToFileURL(file).href);
      const factory = mod[m.factory] || mod.createService || mod.default;
      if (typeof factory !== 'function') { mountErrors.push(`${m.name}:no-factory`); continue; }
      const svc = await factory({ root, ledger, state, ai, secret, dataDir, readOnly, authed });
      services[m.name] = svc;
      const rs = (svc && svc.routes) || mod.routes || [];
      for (const r of rs) routes.push({ ...r, module: m.name });
      console.log('[v2] mounted ' + m.name + ' routes=' + rs.length);
    } catch (e) {
      mountErrors.push(`${m.name}:${String(e.message || e).slice(0, 80)}`);
      console.warn('[v2] module failed ' + m.name + ': ' + String(e.message || e).slice(0, 160));
    }
  }

  const ctx = { root, ledger, state, ai, secret, readOnly, dataDir, services, authed };

  async function handle(req, res, u, pathname) {
    const rel = pathname.slice('/api/v2'.length) || '/';
    if (rel === '/health') {
      return json(res, 200, {
        ok: true,
        modules: Object.keys(services),
        pending: mountErrors,
        routes: routes.map((r) => (r.method || 'GET') + ' ' + (r.path || r.url)),
      });
    }
    for (const route of routes) {
      const match = matchRoute(route, req.method, rel);
      if (!match) continue;
      try {
        return await route.handler(req, res, { ...ctx, params: match.params, url: u, pathname });
      } catch (err) {
        if (!res.headersSent) json(res, 500, { error: String((err && err.message) || err) });
        else res.end();
        return undefined;
      }
    }
    return json(res, 404, { error: '未知 v2 接口：' + (req.method || 'GET') + ' ' + rel });
  }

  return { handle, services, mountErrors, routes };
}