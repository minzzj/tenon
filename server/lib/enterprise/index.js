// 企业控制面（v2-P0）· 服务入口
// 职责：成员/角色白名单（org）、策略（policy）、审批流（approval）、身份适配器（identity）、审计导出（audit）。
//
// 集成方式（Lead，server/lib/v2/index.js 通过 MODULES.factory 调用）：
//   const svc = await createEnterpriseService({ root, ledger, state, ai, secret, readOnly, dataDir, authed });
//   const rs = svc.routes;                 // 路径相对 /api/v2（与 things 模块一致）
//   // 若挂载方不剥 /api/v2 前缀：用 absoluteRoutes(svc.routes)
//
// 账本事件：契约 §3 的 enterprise.role.changed / approval.requested / approval.decided；
// 越权留痕额外 append enterprise.denied（任务卡要求；Lead 需在 state.js 注册该分支，未知事件当前被忽略）。
import path from 'node:path';
import { ensureDir } from './storage.js';
import { createActionCatalog, ROLES, ROLE_LABELS, BUILTIN_ACTIONS } from './actions.js';
import { PolicyStore, RETENTION_OPTIONS, DEFAULT_POLICY } from './policy.js';
import { OrgStore } from './org.js';
import { ApprovalStore, APPROVAL_STATUSES } from './approval.js';
import { IdentityRegistry, createIdentityProvider, listIdentityTypes, IdentityNotConfiguredError } from './identity.js';
import { collectAuditEvents, filterByRetention, exportAudit, AUDIT_FORMATS, DENIED_EVENT } from './audit.js';
import { createEnterpriseRoutes, matchRoute, dispatch, absoluteRoutes, authConfigured } from './router.js';

function gateFor(service, opts = {}) {
  const userId = opts.userId;
  const action = opts.action;
  const route = opts.route || 'internal';
  const check = service.org.checkAction(userId, action);
  if (!check.ok) {
    const member = check.member;
    if (member) {
      service.org.appendDenied({
        userId: member.userId,
        action: String(action || ''),
        role: member.role,
        reason: check.reason || check.code,
        route,
      });
    }
    return {
      ok: false,
      code: check.code || 'forbidden',
      status: 403,
      userId: member ? member.userId : (userId == null ? null : String(userId)),
      role: member ? member.role : null,
      action: String(action || ''),
      reason: check.reason,
    };
  }
  const member = check.member;
  const found = check.action;
  const policy = service.policy.get();
  const requiresApproval = !!(policy.approvalRequiredForIrreversible && found.risk === 'irreversible' && member.role !== 'admin');
  if (!requiresApproval) {
    return { ok: true, code: 'allowed', status: 200, userId: member.userId, role: member.role, action: found.id, risk: found.risk, requiresApproval: false, reason: '' };
  }
  if (opts.approvedRequestId) {
    const usable = service.approvals.findUsable({ requestId: opts.approvedRequestId, action: found.id, by: member.userId });
    if (usable.ok) {
      return { ok: true, code: 'approved', status: 200, userId: member.userId, role: member.role, action: found.id, risk: found.risk, requiresApproval: true, approvalId: usable.request.requestId, reason: '审批通过且已消费' };
    }
    return {
      ok: false,
      code: 'approval_invalid',
      status: 428,
      detail: usable.code,
      userId: member.userId,
      role: member.role,
      action: found.id,
      risk: found.risk,
      requiresApproval: true,
      approvalId: opts.approvedRequestId,
      reason: usable.reason || '审批不可用',
    };
  }
  const requested = service.approvals.create({ action: found.id, by: member.userId, context: opts.context || {} });
  if (!requested.ok) {
    return { ok: false, code: requested.code || 'approval_failed', status: 422, userId: member.userId, role: member.role, action: found.id, risk: found.risk, requiresApproval: true, reason: requested.reason || '审批请求创建失败' };
  }
  return {
    ok: false,
    code: 'approval_required',
    status: 428,
    userId: member.userId,
    role: member.role,
    action: found.id,
    risk: found.risk,
    requiresApproval: true,
    approvalId: requested.request.requestId,
    reason: '不可逆动作需管理员审批后执行',
  };
}

export function createEnterpriseService(opts = {}) {
  const {
    ledger,
    state = null,
    root = process.cwd(),
    dataDir = null,
    now = () => new Date(),
    operatorToken = null,
    defaultUserId = 'u_admin',
    listActions = null,
    identity = null,
    secret = null,
    authed = null,
    readOnly = false,
    ai = null,
    autoLoadThings = true,
  } = opts;
  if (!ledger || typeof ledger.append !== 'function') {
    throw new Error('createEnterpriseService({ ledger, ... }) 需要真实 Ledger 实例（含 append 方法）');
  }
  const resolvedDataDir = dataDir ? path.resolve(String(dataDir)) : path.join(root, 'data');
  const dir = path.join(resolvedDataDir, 'enterprise');
  ensureDir(dir);

  const token = operatorToken || (secret && secret.operatorToken) || null;
  const catalog = createActionCatalog({ listActions, state });
  const policy = new PolicyStore(dir);
  const org = new OrgStore({ dir, ledger, policy, catalog, now, defaultUserId });
  const approvals = new ApprovalStore({ dir, ledger, org, policy, now });
  const identities = new IdentityRegistry(identity || {});
  const authedFn = typeof authed === 'function' ? authed : null;

  const service = {
    module: 'enterprise',
    dir,
    dataDir: resolvedDataDir,
    root,
    ledger,
    state,
    ai,
    catalog,
    policy,
    org,
    approvals,
    identities,
    catalogLoaded: 'builtin',
    routes: [],
    handleRequest: null,
    opts: { operatorToken: token, authed: authedFn, readOnly: !!readOnly, defaultUserId, now },
  };

  service.authConfigured = () => authConfigured(service);
  service.listActions = (userId) => {
    const member = userId ? service.org.resolveActor(userId) : null;
    const pol = service.policy.get();
    return service.catalog.list().map((action) => {
      const allowed = member ? service.org.isAllowed(member, action.id) : false;
      return {
        ...action,
        allowed,
        requiresApproval: !!(allowed && pol.approvalRequiredForIrreversible && action.risk === 'irreversible' && member && member.role !== 'admin'),
      };
    });
  };
  service.checkAction = (userId, action) => service.org.checkAction(userId, action);
  service.gate = (gateOpts = {}) => gateFor(service, gateOpts);

  service.requestApproval = ({ by, action, context = {} } = {}) => {
    const result = service.approvals.create({ action, by, context });
    if (!result.ok) {
      const member = service.org.resolveActor(by);
      if (member) {
        service.org.appendDenied({ userId: member.userId, action: String(action || ''), role: member.role, reason: result.reason || result.code, route: 'requestApproval' });
      }
    }
    return result;
  };

  service.decideApproval = ({ requestId, ok, by, reason = '' } = {}) => {
    const result = service.approvals.decide({ requestId, ok: ok === true, by, reason });
    if (!result.ok && ['forbidden', 'self_approval', 'unknown_user'].includes(result.code)) {
      const actor = service.org.resolveActor(by);
      service.org.appendDenied({ userId: actor ? actor.userId : String(by || 'unknown'), action: 'approval.decide', role: actor ? actor.role : 'unknown', reason: result.reason || result.code, route: 'decideApproval' });
    }
    return result;
  };

  service.listAuditEvents = (auditOpts = {}) => collectAuditEvents(ledger, {
    retentionDays: auditOpts.retentionDays == null ? policy.get().auditRetentionDays : auditOpts.retentionDays,
    now: auditOpts.now || now(),
  });

  service.exportAudit = (auditOpts = {}) => exportAudit({
    events: ledger.events,
    format: auditOpts.format || 'json',
    retentionDays: auditOpts.retentionDays == null ? policy.get().auditRetentionDays : auditOpts.retentionDays,
    dataDomain: auditOpts.dataDomain == null ? policy.get().dataDomain : auditOpts.dataDomain,
    now: auditOpts.now || now(),
  });

  // 尽力接入 things 模块的动作清单（异步，不阻塞创建；不可用时保持内置清单）。
  if (!listActions && autoLoadThings) {
    Promise.resolve().then(async () => {
      try {
        const mod = await import('../things/actions.js');
        if (mod && typeof mod.listActions === 'function') {
          const list = mod.listActions(state || {});
          if (service.catalog.replaceWith(list, { mergeBuiltin: true, newSource: 'things' })) {
            service.catalogLoaded = 'things+builtin';
            return;
          }
        }
        service.catalogLoaded = 'builtin(fallback)';
      } catch {
        service.catalogLoaded = 'builtin(fallback)';
      }
    });
  } else {
    service.catalogLoaded = listActions ? 'injected' : 'builtin';
  }

  service.describe = () => ({
    module: 'enterprise',
    dataDir: dir,
    actionSource: service.catalog.source,
    actionCount: service.catalog.list().length,
    roles: ROLES.slice(),
    policy: service.policy.get(),
    users: service.org.listUsers().length,
    pendingApprovals: service.approvals.list({ status: 'pending', limit: 200 }).length,
    identityProviders: service.identities.describe().map((p) => ({ type: p.type, status: p.status, configured: p.configured })),
    events: ['enterprise.role.changed', 'approval.requested', 'approval.decided', DENIED_EVENT],
    routes: service.routes.map((r) => `${r.method} /api/v2${r.path}`),
  });

  service.routes = createEnterpriseRoutes(service);
  service.absoluteRoutes = absoluteRoutes(service.routes);
  service.handleRequest = (req, res, ctx = {}) => dispatch(service, req, res, ctx);

  return service;
}

export {
  ROLES,
  ROLE_LABELS,
  BUILTIN_ACTIONS,
  PolicyStore,
  RETENTION_OPTIONS,
  DEFAULT_POLICY,
  OrgStore,
  ApprovalStore,
  APPROVAL_STATUSES,
  IdentityRegistry,
  createIdentityProvider,
  listIdentityTypes,
  IdentityNotConfiguredError,
  collectAuditEvents,
  filterByRetention,
  exportAudit,
  AUDIT_FORMATS,
  DENIED_EVENT,
  createEnterpriseRoutes,
  matchRoute,
  dispatch,
  absoluteRoutes,
  authConfigured,
};
