// 企业控制面 v2-P0 · 单元/集成测试（node:test，零依赖）
// 运行：node --test server/lib/enterprise/__tests__/enterprise.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Ledger } from '../../ledger.js';
import { createEnterpriseService } from '../index.js';
import { createIdentityProvider, IdentityNotConfiguredError } from '../identity.js';
import { filterByRetention, exportAudit } from '../audit.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const DATA_BASE = path.join(ROOT, '_internal', 'enterprise-data');

function makeEnv(label) {
  fs.mkdirSync(DATA_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_BASE, label + '-'));
  const dataDir = path.join(dir, 'data');
  const ledger = new Ledger(path.join(dir, 'ledger'));
  const svc = createEnterpriseService({
    ledger,
    root: ROOT,
    dataDir,
    operatorToken: 'test-token',
    autoLoadThings: false, // 单测用内置清单，保证确定性
    identity: { mock: { expectedCode: 'MOCK-OK' } },
  });
  return { dir, dataDir, ledger, svc, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function addMember(env, { name, role, allowedActions = null }) {
  const created = env.svc.org.createMember({ name, role, allowedActions, createdBy: 'u_admin' });
  assert.equal(created.ok, true, JSON.stringify(created.errors || created));
  const joined = env.svc.org.acceptInvite(created.user.inviteCode);
  assert.equal(joined.ok, true, JSON.stringify(joined));
  return joined.user;
}

function types(ledger) {
  return ledger.events.map((e) => e.type);
}

test('默认种子：管理员存在、角色与动作目录就绪、账本未写企业事件', () => {
  const env = makeEnv('seed');
  try {
    const users = env.svc.org.listUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].role, 'admin');
    assert.equal(users[0].userId, 'u_admin');
    assert.deepEqual(env.svc.describe().roles, ['admin', 'member', 'guest']);
    assert.equal(env.svc.catalog.source, 'builtin');
    assert.ok(env.svc.catalog.list().length >= 10);
    assert.equal(types(env.ledger).length, 0);
  } finally {
    env.cleanup();
  }
});

test('成员创建返回邀请码；邀请码激活成功且再次使用被拒；role.changed 事件落账本', () => {
  const env = makeEnv('invite');
  try {
    const created = env.svc.org.createMember({ name: '张三', role: 'member', createdBy: 'u_admin' });
    assert.equal(created.ok, true);
    assert.match(created.user.inviteCode, /^INV-[0-9A-F]{6}$/);
    assert.equal(created.user.status, 'invited');
    const joined = env.svc.org.acceptInvite(created.user.inviteCode);
    assert.equal(joined.ok, true);
    assert.equal(joined.user.status, 'active');
    const again = env.svc.org.acceptInvite(created.user.inviteCode);
    assert.equal(again.ok, false);
    assert.equal(again.code, 'invalid_invite');
    const ev = env.ledger.events.find((e) => e.type === 'enterprise.role.changed');
    assert.ok(ev, '应有 enterprise.role.changed 事件');
    assert.equal(ev.data.userId, created.user.userId);
    assert.equal(ev.data.role, 'member');
  } finally {
    env.cleanup();
  }
});

test('角色白名单：成员可逆动作放行；越权动作被拒并留痕 enterprise.denied', () => {
  const env = makeEnv('rbac');
  try {
    const member = addMember(env, { name: '李四', role: 'member' });
    const okGate = env.svc.gate({ userId: member.userId, action: 'asset.backup' });
    assert.equal(okGate.ok, true);
    assert.equal(okGate.code, 'allowed');
    const denied = env.svc.gate({ userId: member.userId, action: 'org.manage' });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, 'forbidden');
    const deniedEvents = env.ledger.events.filter((e) => e.type === 'enterprise.denied');
    assert.equal(deniedEvents.length, 1);
    assert.equal(deniedEvents[0].data.userId, member.userId);
    assert.equal(deniedEvents[0].data.action, 'org.manage');
    assert.equal(deniedEvents[0].data.role, 'member');
    assert.ok(deniedEvents[0].data.reason);
  } finally {
    env.cleanup();
  }
});

test('访客默认只读；管理员可按成员单独授权动作', () => {
  const env = makeEnv('guest');
  try {
    const guest = addMember(env, { name: '访客甲', role: 'guest' });
    assert.equal(env.svc.gate({ userId: guest.userId, action: 'asset.showOnDesktop' }).code, 'forbidden');
    const patched = env.svc.org.updateMember({ userId: guest.userId, patch: { allowedActions: { allow: ['asset.showOnDesktop'] } }, by: 'u_admin' });
    assert.equal(patched.ok, true);
    const allowed = env.svc.gate({ userId: guest.userId, action: 'asset.showOnDesktop' });
    assert.equal(allowed.ok, true);
    assert.equal(env.svc.gate({ userId: guest.userId, action: 'asset.print' }).code, 'forbidden');
  } finally {
    env.cleanup();
  }
});

test('审批流：不可逆动作需审批→管理员通过→执行前检查放行且只消费一次', () => {
  const env = makeEnv('approval');
  try {
    const member = addMember(env, { name: '王五', role: 'member' });
    const need = env.svc.gate({ userId: member.userId, action: 'asset.print' });
    assert.equal(need.ok, false);
    assert.equal(need.code, 'approval_required');
    assert.equal(need.status, 428);
    assert.ok(need.approvalId);
    const requested = env.ledger.events.filter((e) => e.type === 'approval.requested');
    assert.equal(requested.length, 1);
    assert.deepEqual(Object.keys(requested[0].data).sort(), ['action', 'by', 'requestId']);

    const decided = env.svc.decideApproval({ requestId: need.approvalId, ok: true, by: 'u_admin', reason: '演示通过' });
    assert.equal(decided.ok, true);
    assert.equal(decided.request.status, 'approved');
    const decidedEvents = env.ledger.events.filter((e) => e.type === 'approval.decided');
    assert.equal(decidedEvents.length, 1);
    assert.deepEqual(Object.keys(decidedEvents[0].data).sort(), ['by', 'ok', 'requestId']);

    const pass = env.svc.gate({ userId: member.userId, action: 'asset.print', approvedRequestId: need.approvalId });
    assert.equal(pass.ok, true);
    assert.equal(pass.code, 'approved');
    const reuse = env.svc.gate({ userId: member.userId, action: 'asset.print', approvedRequestId: need.approvalId });
    assert.equal(reuse.ok, false);
    assert.equal(reuse.code, 'approval_invalid');
    assert.equal(reuse.detail, 'already_consumed');
  } finally {
    env.cleanup();
  }
});

test('审批拒绝后不可执行；非管理员审批被拒并留痕；不能自批', () => {
  const env = makeEnv('approval-deny');
  try {
    const member = addMember(env, { name: '赵六', role: 'member' });
    const need = env.svc.gate({ userId: member.userId, action: 'asset.print' });
    assert.equal(need.code, 'approval_required');
    const byMember = env.svc.decideApproval({ requestId: need.approvalId, ok: true, by: member.userId });
    assert.equal(byMember.ok, false);
    assert.equal(byMember.code, 'forbidden');
    assert.ok(env.ledger.events.some((e) => e.type === 'enterprise.denied' && e.data.action === 'approval.decide'));

    const rejected = env.svc.decideApproval({ requestId: need.approvalId, ok: false, by: 'u_admin', reason: '不允许' });
    assert.equal(rejected.ok, true);
    assert.equal(rejected.request.status, 'rejected');
    const afterReject = env.svc.gate({ userId: member.userId, action: 'asset.print', approvedRequestId: need.approvalId });
    assert.equal(afterReject.ok, false);
    assert.equal(afterReject.code, 'approval_invalid');

    const adminReq = env.svc.requestApproval({ by: 'u_admin', action: 'asset.print', context: { demo: true } });
    assert.equal(adminReq.ok, true);
    const self = env.svc.decideApproval({ requestId: adminReq.request.requestId, ok: true, by: 'u_admin' });
    assert.equal(self.ok, false);
    assert.equal(self.code, 'self_approval');
    assert.ok(env.ledger.events.filter((e) => e.type === 'enterprise.denied').length >= 2);
  } finally {
    env.cleanup();
  }
});

test('成员更新（PATCH 语义）：角色/状态/成员级白名单生效，role.changed 携带 name', () => {
  const env = makeEnv('patch-user');
  try {
    const member = addMember(env, { name: '吴十', role: 'member' });
    // 改角色：member -> guest
    const changed = env.svc.org.updateMember({ userId: member.userId, patch: { role: 'guest' }, by: 'u_admin' });
    assert.equal(changed.ok, true);
    assert.equal(changed.user.role, 'guest');
    assert.equal(env.svc.gate({ userId: member.userId, action: 'asset.backup' }).code, 'forbidden');
    const events = env.ledger.events.filter((e) => e.type === 'enterprise.role.changed' && e.data.userId === member.userId);
    assert.equal(events.at(-1).data.role, 'guest');
    assert.equal(events.at(-1).data.name, '吴十');
    // 成员级白名单：guest 单独授权 asset.backup
    const whitelist = env.svc.org.updateMember({ userId: member.userId, patch: { allowedActions: { allow: ['asset.backup'] } }, by: 'u_admin' });
    assert.equal(whitelist.ok, true);
    assert.equal(env.svc.gate({ userId: member.userId, action: 'asset.backup' }).ok, true);
    // 状态：disabled 后不可执行
    const disabled = env.svc.org.updateMember({ userId: member.userId, patch: { status: 'disabled' }, by: 'u_admin' });
    assert.equal(disabled.ok, true);
    const blocked = env.svc.gate({ userId: member.userId, action: 'asset.backup' });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'inactive_user');
    // 非法角色/状态被拒
    assert.equal(env.svc.org.updateMember({ userId: member.userId, patch: { role: 'owner' }, by: 'u_admin' }).ok, false);
    assert.equal(env.svc.org.updateMember({ userId: member.userId, patch: { status: 'banned' }, by: 'u_admin' }).ok, false);
    // 非管理员不能改成员
    const byMember = env.svc.org.updateMember({ userId: member.userId, patch: { role: 'member' }, by: member.userId });
    assert.equal(byMember.ok, false);
    assert.equal(byMember.code, 'forbidden');
  } finally {
    env.cleanup();
  }
});

test('策略：7/30/180 保留期可配、非法值被拒、不可逆审批开关生效', () => {
  const env = makeEnv('policy');
  try {
    assert.deepEqual(env.svc.policy.get().retentionOptions, [7, 30, 180]);
    assert.equal(env.svc.policy.update({ auditRetentionDays: 30 }).ok, true);
    assert.equal(env.svc.policy.get().auditRetentionDays, 30);
    assert.equal(env.svc.policy.update({ auditRetentionDays: 10 }).ok, false);
    assert.equal(env.svc.policy.update({ dataDomain: 'x'.repeat(41) }).ok, false);
    assert.equal(env.svc.policy.update({ approvalRequiredForIrreversible: false }).ok, true);
    const member = addMember(env, { name: '钱七', role: 'member' });
    const printNow = env.svc.gate({ userId: member.userId, action: 'asset.print' });
    assert.equal(printNow.ok, true);
    assert.equal(printNow.code, 'allowed');
  } finally {
    env.cleanup();
  }
});

test('保留期过滤：7/30/180 天边界正确，导出 JSON 计数一致', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');
  const mk = (daysAgo, seq) => ({ seq, at: new Date(now.getTime() - daysAgo * 86400000).toISOString(), type: 'task.succeeded', actor: '你', data: { seq } });
  const events = [mk(0, 1), mk(3, 2), mk(8, 3), mk(40, 4), mk(200, 5)];
  assert.deepEqual(filterByRetention(events, { retentionDays: 7, now }).map((e) => e.seq), [1, 2]);
  assert.deepEqual(filterByRetention(events, { retentionDays: 30, now }).map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(filterByRetention(events, { retentionDays: 180, now }).map((e) => e.seq), [1, 2, 3, 4]);
  const out = exportAudit({ events, format: 'json', retentionDays: 30, dataDomain: '企业数据域', now });
  assert.equal(out.ok, true);
  assert.equal(out.count, 3);
  const parsed = JSON.parse(out.body);
  assert.equal(parsed.count, 3);
  assert.equal(parsed.retentionDays, 30);
  assert.equal(parsed.dataDomain, '企业数据域');
});

test('审计导出三种格式：csv 表头/行数、json 事件数、md 表格；非法格式被拒', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');
  const events = [
    { seq: 1, at: now.toISOString(), type: 'approval.requested', actor: 'user:u_1', data: { requestId: 'apr_1', action: 'asset.print', by: 'u_1' } },
    { seq: 2, at: now.toISOString(), type: 'enterprise.denied', actor: 'user:u_2', data: { userId: 'u_2', action: 'org.manage', role: 'guest', reason: '越权' } },
  ];
  const csv = exportAudit({ events, format: 'csv', retentionDays: 7, now });
  assert.equal(csv.contentType.startsWith('text/csv'), true);
  const csvLines = csv.body.trim().split('\n');
  assert.equal(csvLines[0], 'seq,at,type,actor,data');
  assert.equal(csvLines.length, 3);
  assert.equal(csvLines[2].includes('enterprise.denied'), true);

  const json = exportAudit({ events, format: 'json', retentionDays: 7, now });
  assert.equal(JSON.parse(json.body).events.length, 2);

  const md = exportAudit({ events, format: 'md', retentionDays: 7, now });
  assert.equal(md.body.startsWith('# 企业审计导出'), true);
  assert.equal(md.body.includes('| seq | 时间 | 类型 | 执行者 | 数据摘要 |'), true);
  assert.equal(md.body.includes('enterprise.denied'), true);

  const bad = exportAudit({ events, format: 'xml', retentionDays: 7, now });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'invalid_format');
});

test('服务级审计导出：按策略保留期过滤（账本事件均近期，三种格式可导出）', () => {
  const env = makeEnv('export-svc');
  try {
    addMember(env, { name: '孙八', role: 'member' });
    env.svc.policy.update({ auditRetentionDays: 30 });
    for (const format of ['csv', 'json', 'md']) {
      const out = env.svc.exportAudit({ format });
      assert.equal(out.ok, true, `${format} 应导出成功`);
      assert.equal(out.retentionDays, 30);
      assert.equal(out.count, env.ledger.events.length);
      assert.ok(out.body.length > 10);
      assert.ok(out.filename.endsWith('.' + (format === 'md' ? 'md' : format)));
    }
  } finally {
    env.cleanup();
  }
});

test('mock 身份适配器：loginUrl/handleCallback/sendMessage 全链路；真实类型未配置抛错', () => {
  const mock = createIdentityProvider({ type: 'mock', config: { expectedCode: 'MOCK-OK', user: { providerId: 'p-1', name: '测试员工', email: 'staff@example.com', role: 'member' } } });
  assert.equal(mock.isConfigured(), true);
  assert.match(mock.loginUrl('state-1'), /state=state-1/);
  assert.equal(mock.handleCallback({ code: 'WRONG' }).code, 'invalid_code');
  assert.equal(mock.handleCallback({}).code, 'missing_code');
  const ok = mock.handleCallback({ code: 'MOCK-OK', state: 'state-1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.user.name, '测试员工');
  assert.equal(ok.user.role, 'member');
  const msg = mock.sendMessage('u_1', '审批提醒：有一条不可逆动作待审批');
  assert.equal(msg.ok, true);
  assert.ok(msg.messageId.startsWith('idm_'));
  assert.equal(mock.messages.length, 1);

  const wecom = createIdentityProvider({ type: 'wecom', config: {} });
  assert.equal(wecom.isConfigured(), false);
  assert.throws(() => wecom.loginUrl('s'), (e) => e instanceof IdentityNotConfiguredError && e.code === 'identity_not_configured');
  assert.throws(() => wecom.handleCallback({ code: 'x' }), (e) => e instanceof IdentityNotConfiguredError);

  const withMockBridge = createIdentityProvider({ type: 'dingtalk', config: { mock: true, expectedCode: 'X' } });
  assert.match(withMockBridge.loginUrl('s'), /mock/);
  assert.equal(withMockBridge.handleCallback({ code: 'X' }).ok, true);

  const ldap = createIdentityProvider({ type: 'ldap', config: {} });
  assert.equal(ldap.describe().status, 'reserved');
  assert.throws(() => ldap.loginUrl('s'), (e) => e instanceof IdentityNotConfiguredError);
});

test('身份注册表：mock 可用、其余待凭据；未知类型报错', () => {
  const env = makeEnv('identity');
  try {
    const list = env.svc.identities.describe();
    const mock = list.find((p) => p.type === 'mock');
    assert.equal(mock.configured, true);
    const wecom = list.find((p) => p.type === 'wecom');
    assert.equal(wecom.configured, false);
    assert.equal(wecom.status, 'needs_credentials');
    assert.deepEqual(wecom.missingFields, ['corpId', 'agentId', 'secret']);
    const msg = env.svc.identities.sendMessage('mock', 'u_admin', 'hello');
    assert.equal(msg.ok, true);
    assert.throws(() => env.svc.identities.get('nope'), (e) => e && e.code === 'unknown_identity_type');
  } finally {
    env.cleanup();
  }
});

test('动作目录可注入 things 模块 listActions；不可用时回落内置清单', () => {
  fs.mkdirSync(DATA_BASE, { recursive: true });
  const dirA = fs.mkdtempSync(path.join(DATA_BASE, 'catalog-a-'));
  const dirB = fs.mkdtempSync(path.join(DATA_BASE, 'catalog-b-'));
  try {
    const ledgerA = new Ledger(path.join(dirA, 'ledger'));
    const svcThings = createEnterpriseService({
      ledger: ledgerA,
      root: ROOT,
      dataDir: path.join(dirA, 'data'),
      listActions: () => [{ id: 'x.custom', name: '自定义动作', risk: 'irreversible' }],
    });
    assert.equal(svcThings.catalog.source, 'things');
    assert.equal(svcThings.catalog.list().length, 1);
    assert.equal(svcThings.catalog.get('x.custom').risk, 'irreversible');

    const ledgerB = new Ledger(path.join(dirB, 'ledger'));
    const svcBuiltin = createEnterpriseService({ ledger: ledgerB, root: ROOT, dataDir: path.join(dirB, 'data'), listActions: null });
    assert.equal(svcBuiltin.catalog.source, 'builtin');
    assert.ok(svcBuiltin.catalog.list().length >= 10);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('持久化：重启（新 service 实例）后成员/策略/审批仍在，账本哈希链完整', () => {
  const env = makeEnv('persist');
  try {
    const member = addMember(env, { name: '周九', role: 'member' });
    env.svc.policy.update({ auditRetentionDays: 180, dataDomain: '研发数据域' });
    const need = env.svc.gate({ userId: member.userId, action: 'asset.print' });
    assert.equal(need.code, 'approval_required');
    env.svc.decideApproval({ requestId: need.approvalId, ok: true, by: 'u_admin' });

    const reopened = createEnterpriseService({ ledger: env.ledger, root: ROOT, dataDir: env.dataDir });
    assert.ok(reopened.org.listUsers().some((u) => u.userId === member.userId && u.status === 'active'));
    assert.equal(reopened.policy.get().auditRetentionDays, 180);
    assert.equal(reopened.policy.get().dataDomain, '研发数据域');
    const approvals = reopened.approvals.list({ status: 'approved' });
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].requestId, need.approvalId);
    assert.equal(env.ledger.integrity().ok, true);
    const allowedTypes = new Set(['enterprise.role.changed', 'approval.requested', 'approval.decided', 'enterprise.denied']);
    for (const type of types(env.ledger)) assert.ok(allowedTypes.has(type), `非预期事件类型：${type}`);
  } finally {
    env.cleanup();
  }
});


test('路由约定：path 相对 /api/v2（Lead createV2 约定），absoluteRoutes 提供整路径副本', () => {
  const env = makeEnv('routes');
  try {
    assert.ok(env.svc.routes.length >= 10);
    for (const route of env.svc.routes) {
      assert.ok(route.path.startsWith('/'), `path 应以 / 开头：${route.path}`);
      assert.ok(!route.path.startsWith('/api/v2'), `Lead createV2 要求相对路径：${route.path}`);
      assert.equal(typeof route.handler, 'function');
    }
    const abs = env.svc.absoluteRoutes;
    assert.equal(abs.length, env.svc.routes.length);
    assert.ok(abs[0].path.startsWith('/api/v2/'));
    assert.ok(env.svc.describe().routes.some((r) => r.includes('/api/v2/org/users')));
  } finally {
    env.cleanup();
  }
});

test('运行时自动接入 things 动作清单（存在则合并，不存在则回落内置）', async () => {
  const thingsFile = path.resolve(ROOT, 'server', 'lib', 'things', 'actions.js');
  if (!fs.existsSync(thingsFile)) {
    assert.ok(true, 'things 模块不存在，跳过（内置清单已覆盖）');
    return;
  }
  fs.mkdirSync(DATA_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(DATA_BASE, 'autoload-'));
  try {
    const ledger = new Ledger(path.join(dir, 'ledger'));
    const svc = createEnterpriseService({ ledger, root: ROOT, dataDir: path.join(dir, 'data') });
    assert.equal(svc.catalog.source, 'builtin');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.match(svc.catalog.source, /things/);
    assert.equal(svc.catalogLoaded, 'things+builtin');
    // things 动作 + 内置补齐动作都在
    assert.ok(svc.catalog.has('asset.print'));
    assert.ok(svc.catalog.has('org.manage'));
    assert.equal(svc.catalog.get('asset.print').risk, 'irreversible');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
