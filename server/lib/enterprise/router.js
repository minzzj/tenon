// 企业控制面 · HTTP 路由（契约-v2-P0 §4，供 Lead 在 server/lib/v2/index.js 统一挂载）
//
// 路径约定：**route.path 相对 /api/v2**（与 server/lib/things/routes.js 一致；Lead 的 createV2
// 用 `pathname.slice('/api/v2'.length)` 匹配）。需要整路径时用 absoluteRoutes(routes)。
// 路由项：{ method, path, handler(req, res, ctx) }；ctx 由 Lead 传：
//   { root, ledger, state, ai, secret, readOnly, dataDir, services, authed, params, url, pathname }
//   额外可选：ctx.body（已解析请求体）、ctx.userId/ctx.actor（操作者）、ctx.authorized
// 鉴权：
//   - 写操作：挂载层（http.js）已在 /api/v2 分发前拦截 401/423；本模块再兜底（ctx.authed / ctx.secret → 自校验）。
//   - 企业管理读接口（成员/审批/动作审计）：挂载层若配置了 authed，则本模块要求令牌，避免匿名读企业成员。
//   - 审计导出（GET 但敏感）：始终要求令牌。
import { RETENTION_OPTIONS } from './policy.js';
import { AUDIT_FORMATS, exportAudit } from './audit.js';
import { ROLES, ROLE_LABELS } from './actions.js';
import { APPROVAL_STATUSES } from './approval.js';
import { IdentityNotConfiguredError, listIdentityTypes } from './identity.js';

const MAX_BODY = 1024 * 1024;
const API_PREFIX = '/api/v2';

export function json(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
  return undefined;
}

export function text(res, code, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
  return undefined;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function requestToken(req) {
  const header = req && req.headers ? req.headers['x-tenon-token'] : '';
  if (header) return String(header);
  const cookie = parseCookies((req && req.headers && req.headers.cookie) || '');
  return cookie.tenon_token || '';
}

export function requestPath(req, ctx = {}) {
  if (ctx && ctx.pathname) return String(ctx.pathname);
  try {
    return new URL(String((req && req.url) || '/'), 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

export function readRequestBody(req, ctx = {}) {
  if (ctx && ctx.body !== undefined) return Promise.resolve(ctx.body && typeof ctx.body === 'object' ? ctx.body : {});
  if (req && req.body !== undefined) return Promise.resolve(req.body && typeof req.body === 'object' ? req.body : {});
  return new Promise((resolve) => {
    if (!req || typeof req.on !== 'function') return resolve({});
    if (req.readableEnded) return resolve({});
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) return finish({ __error: 'body_too_large' });
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return finish({});
      try {
        const parsed = JSON.parse(raw);
        return finish(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        return finish({ __error: 'invalid_json' });
      }
    });
    req.on('error', () => finish({ __error: 'read_error' }));
  });
}

/** 挂载层是否接线了鉴权（有 authed 函数或 operatorToken）。 */
export function authConfigured(service) {
  const opts = (service && service.opts) || {};
  return !!(opts.operatorToken || typeof opts.authed === 'function');
}

/** ctx.authorized 优先；其次 ctx.authed / service.opts.authed 函数；再次 operatorToken 校验；否则 fail-closed。 */
export function isAuthorized(req, ctx, service) {
  if (ctx && ctx.authorized !== undefined) return !!ctx.authorized;
  const authedFn = (ctx && typeof ctx.authed === 'function') ? ctx.authed : ((service.opts || {}).authed || null);
  if (typeof authedFn === 'function') {
    try {
      return !!authedFn(req);
    } catch {
      return false;
    }
  }
  const expected = (service.opts || {}).operatorToken;
  if (expected) return requestToken(req) === String(expected);
  return false;
}

export function actorIdOf(req, ctx = {}, service = {}) {
  if (ctx && ctx.userId) return String(ctx.userId);
  if (ctx && ctx.actor) return String(ctx.actor);
  const header = req && req.headers ? req.headers['x-tenon-user'] : '';
  if (header) return String(header);
  return String((service.opts && service.opts.defaultUserId) || 'u_admin');
}

function bodyError(res, body) {
  if (body && body.__error === 'body_too_large') {
    json(res, 413, { ok: false, code: 'body_too_large', error: `请求体超过 ${MAX_BODY} 字节` });
    return true;
  }
  if (body && body.__error) {
    json(res, 400, { ok: false, code: body.__error, error: '请求体必须是合法 JSON 对象' });
    return true;
  }
  return false;
}

function deny(res, service, { userId, action, role, reason, route, status = 403, code = 'forbidden' }) {
  const member = service.org.resolveActor(userId);
  service.org.appendDenied({
    userId: member ? member.userId : String(userId || 'unknown'),
    action,
    role: member ? member.role : String(role || 'unknown'),
    reason: reason || code,
    route: route || 'enterprise',
  });
  json(res, status, { ok: false, code, error: reason || '越权操作已被拒绝', action });
  return undefined;
}

function unauthorized(res) {
  json(res, 401, { ok: false, code: 'unauthorized', error: '需要登录令牌（x-tenon-token）' });
  return undefined;
}

function readOnlyBlocked(res, service) {
  if (!(service.opts && service.opts.readOnly)) return false;
  json(res, 423, { ok: false, code: 'read_only', error: '另一窗口为只读：企业写操作不可用' });
  return true;
}

function readGuard(req, res, ctx, service) {
  if (!authConfigured(service)) return true; // 未接线鉴权（本地嵌入/单测）时读接口开放
  if (isAuthorized(req, ctx, service)) return true;
  unauthorized(res);
  return false;
}

function writeGuard(req, res, ctx, service, { route }) {
  if (readOnlyBlocked(res, service)) return null;
  if (!isAuthorized(req, ctx, service)) {
    unauthorized(res);
    return null;
  }
  const actor = service.org.resolveActor(actorIdOf(req, ctx, service));
  if (!actor) {
    json(res, 403, { ok: false, code: 'unknown_user', error: '操作者不是企业成员（x-tenon-user 无法解析）' });
    return null;
  }
  if (actor.status !== 'active') {
    json(res, 403, { ok: false, code: 'inactive_user', error: `成员状态为 ${actor.status}，无操作权限` });
    return null;
  }
  return { actor, route };
}

function adminGuard(req, res, ctx, service, { route, action = 'org.manage' }) {
  const guard = writeGuard(req, res, ctx, service, { route });
  if (!guard) return null;
  if (guard.actor.role !== 'admin') {
    deny(res, service, { userId: guard.actor.userId, action, role: guard.actor.role, reason: `需要管理员权限（${route}）`, route });
    return null;
  }
  return guard.actor;
}

function approvalError(res, result) {
  const map = { not_found: 404, not_pending: 409, not_approved: 409, action_mismatch: 409, by_mismatch: 409, already_consumed: 409, expired: 409, self_approval: 403, forbidden: 403, unknown_user: 403, unknown_action: 400, inactive_user: 403, invalid_invite: 400, invalid: 400 };
  json(res, map[result.code] || 400, { ok: false, code: result.code || 'error', error: result.reason || '审批操作失败' });
  return undefined;
}

export function normalizeV2Path(pathname) {
  const p = String(pathname || '');
  if (p === API_PREFIX) return '/';
  if (p.startsWith(API_PREFIX + '/')) return p.slice(API_PREFIX.length);
  return p;
}

function compileRoute(route) {
  if (route._compiled) return route._compiled;
  const keys = [];
  const pattern = String(route.path)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  route._compiled = { re: new RegExp('^' + pattern + '$'), keys };
  return route._compiled;
}

/** method + pathname（相对或完整 /api/v2 均可）→ { route, params } | null */
export function matchRoute(routes, method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  const rel = normalizeV2Path(pathname);
  for (const route of routes || []) {
    if (String(route.method).toUpperCase() !== m) continue;
    const compiled = compileRoute(route);
    const found = rel.match(compiled.re);
    if (!found) continue;
    const params = {};
    compiled.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(found[i + 1]);
    });
    return { route, params };
  }
  return null;
}

/** 整路径副本（若挂载方不剥 /api/v2 前缀，可改用这个数组）。 */
export function absoluteRoutes(routes) {
  return (routes || []).map((r) => ({ ...r, path: API_PREFIX + r.path }));
}

/** 整表分发（本模块自测 / 最小 http 服务用）。 */
export async function dispatch(service, req, res, ctx = {}) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  const pathname = requestPath(req, ctx);
  const matched = matchRoute(service.routes, method, pathname);
  if (!matched) {
    json(res, 404, { ok: false, code: 'not_found', error: `未知接口：${method} ${pathname}` });
    return undefined;
  }
  return matched.route.handler(req, res, { ...ctx, params: matched.params, pathname });
}

export function createEnterpriseRoutes(service) {
  const routes = [];
  const add = (method, path, handler) => routes.push({ method, path, handler });

  // ---------- 成员与角色 ----------
  add('GET', '/org/users', async (req, res, ctx = {}) => {
    if (!readGuard(req, res, ctx, service)) return;
    const actor = service.org.resolveActor(actorIdOf(req, ctx, service));
    const users = service.org.listUsers().map((u) => service.org.sanitizeUser(u));
    json(res, 200, {
      ok: true,
      users,
      roles: ROLES.map((role) => ({ role, label: ROLE_LABELS[role], defaultActions: service.org.effectiveAllowed({ role, status: 'active' }) })),
      actionSource: service.catalog.source,
      actor: actor ? { userId: actor.userId, role: actor.role } : null,
    });
  });

  add('POST', '/org/users', async (req, res, ctx = {}) => {
    const body = await readRequestBody(req, ctx);
    if (bodyError(res, body)) return;
    if (readOnlyBlocked(res, service)) return;
    if (!isAuthorized(req, ctx, service)) return unauthorized(res);
    // 邀请码加入（成员自助激活；仍需令牌 → 由企业身份适配器/管理员发放）
    if (body.inviteCode) {
      const joined = service.org.acceptInvite(body.inviteCode, { name: body.name, userId: body.userId });
      if (!joined.ok) return json(res, 400, { ok: false, code: joined.code, error: joined.reason });
      const actor = service.org.resolveActor(actorIdOf(req, ctx, service));
      return json(res, 200, {
        ok: true,
        joined: true,
        user: service.org.sanitizeUser(joined.user, { withInvite: true }),
        actor: actor ? { userId: actor.userId, role: actor.role } : null,
      });
    }
    const guard = writeGuard(req, res, ctx, service, { route: 'POST /org/users' });
    if (!guard) return;
    if (guard.actor.role !== 'admin') {
      return deny(res, service, { userId: guard.actor.userId, action: 'org.manage', role: guard.actor.role, reason: '只有管理员可以创建成员', route: 'POST /org/users' });
    }
    const created = service.org.createMember({
      name: body.name,
      role: body.role || 'member',
      email: body.email || '',
      allowedActions: body.allowedActions || null,
      createdBy: guard.actor.userId,
    });
    if (!created.ok) return json(res, 400, { ok: false, code: created.code, errors: created.errors });
    return json(res, 201, { ok: true, user: service.org.sanitizeUser(created.user, { withInvite: true }) });
  });

  add('PATCH', '/org/users/:id', async (req, res, ctx = {}) => {
    const body = await readRequestBody(req, ctx);
    if (bodyError(res, body)) return;
    const guard = adminGuard(req, res, ctx, service, { route: 'PATCH /org/users/:id', action: 'org.manage' });
    if (!guard) return;
    const updated = service.org.updateMember({ userId: ctx.params ? ctx.params.id : '', patch: body || {}, by: guard.userId });
    if (!updated.ok) {
      if (updated.code === 'forbidden') return deny(res, service, { userId: guard.userId, action: 'org.manage', role: guard.role, reason: updated.reason, route: 'PATCH /org/users/:id' });
      return json(res, updated.code === 'not_found' ? 404 : 400, { ok: false, code: updated.code, errors: updated.errors, error: updated.reason });
    }
    return json(res, 200, { ok: true, user: service.org.sanitizeUser(updated.user, { withInvite: true }) });
  });

  // ---------- 策略 ----------
  add('GET', '/org/policy', async (req, res) => {
    json(res, 200, { ok: true, policy: service.policy.get(), retentionOptions: RETENTION_OPTIONS.slice() });
  });

  add('PATCH', '/org/policy', async (req, res, ctx = {}) => {
    const body = await readRequestBody(req, ctx);
    if (bodyError(res, body)) return;
    const actor = adminGuard(req, res, ctx, service, { route: 'PATCH /org/policy', action: 'org.manage' });
    if (!actor) return;
    const updated = service.policy.update(body || {});
    if (!updated.ok) return json(res, 400, { ok: false, code: 'invalid_policy', errors: updated.errors });
    return json(res, 200, { ok: true, policy: updated.policy, by: actor.userId });
  });

  // ---------- 审批 ----------
  add('GET', '/approvals', async (req, res, ctx = {}) => {
    if (!readGuard(req, res, ctx, service)) return;
    const url = new URL(String((req && req.url) || '/'), 'http://localhost');
    const approvals = service.approvals.list({
      status: url.searchParams.get('status') || 'all',
      by: url.searchParams.get('by') || '',
      limit: url.searchParams.get('limit') || 50,
    });
    json(res, 200, { ok: true, approvals, statuses: APPROVAL_STATUSES.slice() });
  });

  add('POST', '/approvals', async (req, res, ctx = {}) => {
    const body = await readRequestBody(req, ctx);
    if (bodyError(res, body)) return;
    const guard = writeGuard(req, res, ctx, service, { route: 'POST /approvals' });
    if (!guard) return;
    const result = service.requestApproval({ by: guard.actor.userId, action: body.action, context: body.context || {} });
    if (!result.ok) {
      const status = result.code === 'forbidden' || result.code === 'inactive_user' || result.code === 'unknown_user' ? 403 : 400;
      return json(res, status, { ok: false, code: result.code || 'error', error: result.reason || '审批请求失败' });
    }
    return json(res, 201, { ok: true, approval: result.request });
  });

  add('POST', '/approvals/:id/decide', async (req, res, ctx = {}) => {
    const body = await readRequestBody(req, ctx);
    if (bodyError(res, body)) return;
    const guard = writeGuard(req, res, ctx, service, { route: 'POST /approvals/:id/decide' });
    if (!guard) return;
    if (!body || typeof body.ok !== 'boolean') return json(res, 400, { ok: false, code: 'invalid', error: 'body.ok 必须是布尔值（true 通过 / false 拒绝）' });
    const result = service.decideApproval({
      requestId: ctx.params ? ctx.params.id : '',
      ok: body.ok === true,
      by: guard.actor.userId,
      reason: body.reason || '',
    });
    if (!result.ok) return approvalError(res, result);
    return json(res, 200, { ok: true, approval: result.request });
  });

  // ---------- 审计导出（GET 但敏感：始终要求令牌） ----------
  add('GET', '/org/audit/export', async (req, res, ctx = {}) => {
    if (!isAuthorized(req, ctx, service)) return unauthorized(res);
    const url = new URL(String((req && req.url) || '/'), 'http://localhost');
    const format = String(url.searchParams.get('format') || 'json').toLowerCase();
    let retentionDays = service.policy.get().auditRetentionDays;
    const daysParam = url.searchParams.get('days');
    if (daysParam != null && daysParam !== '') {
      const n = Number(daysParam);
      if (!RETENTION_OPTIONS.includes(n)) {
        return json(res, 400, { ok: false, code: 'invalid_days', error: `days 只能是 ${RETENTION_OPTIONS.join('/')} 之一` });
      }
      retentionDays = n;
    }
    const result = exportAudit({
      events: service.ledger.events,
      format,
      retentionDays,
      dataDomain: service.policy.get().dataDomain,
      now: service.opts.now(),
    });
    if (!result.ok) return json(res, 400, { ok: false, code: result.code, errors: result.errors });
    const headers = {
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'X-Tenon-Retention-Days': String(result.retentionDays),
      'X-Tenon-Event-Count': String(result.count),
    };
    return text(res, 200, result.body, result.contentType, headers);
  });

  // ---------- 身份适配器 ----------
  add('GET', '/org/identity/providers', async (req, res) => {
    json(res, 200, { ok: true, providers: service.identities.describe(), types: listIdentityTypes() });
  });

  add('GET', '/org/identity/:type/login-url', async (req, res, ctx = {}) => {
    const url = new URL(String((req && req.url) || '/'), 'http://localhost');
    try {
      const provider = service.identities.get(ctx.params ? ctx.params.type : '');
      const loginUrl = provider.loginUrl(url.searchParams.get('state') || '');
      return json(res, 200, { ok: true, type: provider.type, url: loginUrl });
    } catch (e) {
      if (e instanceof IdentityNotConfiguredError) return json(res, 409, { ok: false, code: e.code, type: e.type, error: e.message });
      if (e && e.code === 'unknown_identity_type') return json(res, 400, { ok: false, code: e.code, error: e.message });
      return json(res, 500, { ok: false, code: 'identity_error', error: String((e && e.message) || e) });
    }
  });

  add('POST', '/org/identity/:type/callback', async (req, res, ctx = {}) => {
    const body = await readRequestBody(req, ctx);
    if (bodyError(res, body)) return;
    try {
      const provider = service.identities.get(ctx.params ? ctx.params.type : '');
      const result = provider.handleCallback(body);
      if (!result.ok) return json(res, 400, { ok: false, ...result });
      return json(res, 200, { ok: true, ...result });
    } catch (e) {
      if (e instanceof IdentityNotConfiguredError) return json(res, 409, { ok: false, code: e.code, type: e.type, error: e.message });
      if (e && e.code === 'unknown_identity_type') return json(res, 400, { ok: false, code: e.code, error: e.message });
      return json(res, 500, { ok: false, code: 'identity_error', error: String((e && e.message) || e) });
    }
  });

  // ---------- 动作白名单（企业控制台 UI / 任务与场景执行前检查复用） ----------
  add('GET', '/org/actions', async (req, res, ctx = {}) => {
    if (!readGuard(req, res, ctx, service)) return;
    const url = new URL(String((req && req.url) || '/'), 'http://localhost');
    const userId = url.searchParams.get('userId') || actorIdOf(req, ctx, service);
    const member = service.org.resolveActor(userId);
    json(res, 200, {
      ok: true,
      userId: member ? member.userId : null,
      role: member ? member.role : null,
      source: service.catalog.source,
      policy: service.policy.get(),
      actions: service.listActions(member ? member.userId : null),
    });
  });

  add('POST', '/org/actions/check', async (req, res, ctx = {}) => {
    const body = await readRequestBody(req, ctx);
    if (bodyError(res, body)) return;
    const userId = body.userId || actorIdOf(req, ctx, service);
    const result = service.gate({ userId, action: body.action, approvedRequestId: body.approvedRequestId || null, route: 'POST /org/actions/check', context: body.context || {} });
    json(res, 200, { ok: result.ok, result });
  });

  return routes;
}
