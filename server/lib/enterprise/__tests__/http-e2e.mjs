// 企业控制面 v2-P0 · 真实 HTTP 端到端（隔离端口 7435，Lead 挂载前的最小 http 服务验证）
// 运行：node server/lib/enterprise/__tests__/http-e2e.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { Ledger } from '../../ledger.js';
import { createEnterpriseService } from '../index.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const DATA_BASE = path.join(ROOT, '_internal', 'enterprise-data');
const TOKEN = 'e2e-token-7435';
const PREFERRED_PORT = Number(process.env.TENON_ENT_PORT || 7435);

const results = [];
let failed = 0;
function check(name, cond, detail = '') {
  const pass = !!cond;
  results.push({ name, pass, detail: String(detail == null ? '' : detail).slice(0, 300) });
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`);
}

fs.mkdirSync(DATA_BASE, { recursive: true });
const runDir = fs.mkdtempSync(path.join(DATA_BASE, 'http-e2e-'));
const dataDir = path.join(runDir, 'data');
const ledger = new Ledger(path.join(runDir, 'ledger'));
const service = createEnterpriseService({
  ledger,
  root: ROOT,
  dataDir,
  operatorToken: TOKEN,
  identity: { mock: { expectedCode: 'MOCK-E2E' } },
});

const server = http.createServer(async (req, res) => {
  try {
    await service.handleRequest(req, res, {});
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, code: 'internal_error', error: String((e && e.message) || e) }));
  }
});

function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

let port = null;
for (const candidate of [PREFERRED_PORT, PREFERRED_PORT + 1, PREFERRED_PORT + 2]) {
  try {
    port = await listen(candidate);
    break;
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    console.log(`端口 ${candidate} 被占用，尝试下一个`);
  }
}
if (!port) {
  console.error('7435-7437 端口都被占用，无法启动隔离 HTTP 实例');
  process.exit(1);
}
const BASE = `http://127.0.0.1:${port}`;

async function api(method, pathname, { body, token = TOKEN, user = 'u_admin', headers = {} } = {}) {
  const h = { ...headers };
  if (token) h['x-tenon-token'] = token;
  if (user) h['x-tenon-user'] = user;
  let payload;
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + pathname, { method, headers: h, body: payload });
  const raw = await res.text();
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* 非 JSON（导出格式） */
  }
  return { status: res.status, raw, json, headers: res.headers };
}

function acceptInvite(userId, inviteCode) {
  return api('POST', '/api/v2/org/users', { body: { inviteCode, userId } });
}

try {
  // 1. 成员列表（默认管理员）
  let r = await api('GET', '/api/v2/org/users');
  check('GET /api/v2/org/users 200 且含默认管理员', r.status === 200 && Array.isArray(r.json.users) && r.json.users.some((u) => u.role === 'admin' && u.userId === 'u_admin'), `users=${r.json && r.json.users ? r.json.users.length : '-'}`);

  // 2. 管理员创建成员（返回邀请码）
  r = await api('POST', '/api/v2/org/users', { body: { name: 'E2E 成员', role: 'member', email: 'e2e@example.com' } });
  const memberId = r.json && r.json.user ? r.json.user.userId : '';
  const inviteCode = r.json && r.json.user ? r.json.user.inviteCode : '';
  check('POST /api/v2/org/users 创建成员 201 且返回邀请码', r.status === 201 && /^INV-[0-9A-F]{6}$/.test(inviteCode || ''), `userId=${memberId}`);

  // 3. 邀请码激活
  r = await acceptInvite(memberId, inviteCode);
  check('邀请码激活成员为 active', r.status === 200 && r.json.user.status === 'active');

  // 4. 创建访客
  r = await api('POST', '/api/v2/org/users', { body: { name: 'E2E 访客', role: 'guest' } });
  const guestId = r.json && r.json.user ? r.json.user.userId : '';
  await acceptInvite(guestId, r.json && r.json.user ? r.json.user.inviteCode : '');
  check('创建并激活访客', !!guestId);

  // 5. 无令牌写操作 401
  r = await api('POST', '/api/v2/org/users', { body: { name: '无令牌' }, token: null });
  check('写操作无令牌 401', r.status === 401 && r.json.code === 'unauthorized');

  // 6. 访客越权创建成员 403 + 留痕
  r = await api('POST', '/api/v2/org/users', { body: { name: '越权成员' }, user: guestId });
  const deniedEvent = ledger.events.filter((e) => e.type === 'enterprise.denied' && e.data.userId === guestId);
  check('访客越权创建成员 403 且 enterprise.denied 留痕', r.status === 403 && r.json.code === 'forbidden' && deniedEvent.length === 1, `denied=${deniedEvent.length}`);

  // 6b. PATCH /api/v2/org/users/:id：管理员改角色/白名单/状态；无令牌 401；非法角色 400；非管理员 403
  r = await api('POST', '/api/v2/org/users', { body: { name: 'E2E 待改成员', role: 'member' } });
  const patchId = r.json.user.userId;
  await acceptInvite(patchId, r.json.user.inviteCode);
  r = await api('PATCH', `/api/v2/org/users/${patchId}`, { body: { role: 'guest' } });
  check('PATCH 成员改角色（admin 200，member→guest）', r.status === 200 && r.json.ok === true && r.json.user.role === 'guest', `user=${JSON.stringify(r.json.user && { userId: r.json.user.userId, role: r.json.user.role })}`);
  r = await api('GET', '/api/v2/org/users');
  check('PATCH 后成员列表角色已生效', r.status === 200 && r.json.users.some((u) => u.userId === patchId && u.role === 'guest'));
  const roleEvent = ledger.events.filter((e) => e.type === 'enterprise.role.changed' && e.data.userId === patchId).at(-1);
  check('PATCH 改角色 append enterprise.role.changed（state 分支字段）', !!roleEvent && roleEvent.data.role === 'guest' && roleEvent.data.name === 'E2E 待改成员');
  r = await api('PATCH', `/api/v2/org/users/${patchId}`, { body: { role: 'guest' }, token: null });
  check('PATCH 成员无令牌 401', r.status === 401);
  r = await api('PATCH', `/api/v2/org/users/${patchId}`, { body: { role: 'owner' } });
  check('PATCH 非法角色 400', r.status === 400);
  r = await api('PATCH', `/api/v2/org/users/${patchId}`, { body: { role: 'member' }, user: guestId });
  check('PATCH 成员非管理员 403 且留痕', r.status === 403 && ledger.events.some((e) => e.type === 'enterprise.denied' && e.data.action === 'org.manage'));
  r = await api('PATCH', `/api/v2/org/users/${patchId}`, { body: { allowedActions: { allow: ['asset.backup'] }, status: 'active' } });
  check('PATCH 成员白名单/状态 200', r.status === 200 && r.json.user.status === 'active');
  r = await api('POST', '/api/v2/org/actions/check', { body: { userId: patchId, action: 'asset.backup' } });
  check('PATCH 白名单生效（越权补齐后可执行）', r.status === 200 && r.json.result.code === 'allowed');

  // 7. 不可逆动作需审批（执行前检查）
  r = await api('POST', '/api/v2/org/actions/check', { body: { userId: memberId, action: 'asset.print' } });
  const approvalId = r.json && r.json.result ? r.json.result.approvalId : '';
  check('成员执行不可逆动作 → approval_required(428)', r.status === 200 && r.json.result && r.json.result.code === 'approval_required' && r.json.result.status === 428, `approvalId=${approvalId}`);

  // 8. 审批列表可查到 pending
  r = await api('GET', '/api/v2/approvals?status=pending');
  check('GET /api/v2/approvals 含 pending 审批', r.status === 200 && r.json.approvals.some((a) => a.requestId === approvalId));

  // 9. 非管理员审批 403 + 留痕
  r = await api('POST', `/api/v2/approvals/${approvalId}/decide`, { body: { ok: true }, user: memberId });
  check('非管理员审批 403', r.status === 403 && r.json.code === 'forbidden');

  // 10. 管理员通过
  r = await api('POST', `/api/v2/approvals/${approvalId}/decide`, { body: { ok: true, reason: 'E2E 通过' } });
  check('管理员通过审批 200 approved', r.status === 200 && r.json.approval.status === 'approved');

  // 11. 审批通过后执行放行
  r = await api('POST', '/api/v2/org/actions/check', { body: { userId: memberId, action: 'asset.print', approvedRequestId: approvalId } });
  check('审批通过后执行放行（approved）', r.json.result && r.json.result.code === 'approved' && r.json.result.ok === true);

  // 12. 可逆动作直接放行
  r = await api('POST', '/api/v2/org/actions/check', { body: { userId: memberId, action: 'asset.backup' } });
  check('成员可逆动作直接放行（allowed）', r.json.result && r.json.result.code === 'allowed' && r.json.result.ok === true);

  // 13. 动作白名单（UI 用）
  r = await api('GET', `/api/v2/org/actions?userId=${memberId}`);
  check('动作清单带 allowed 标记且 org.manage 对成员不可用', r.status === 200 && r.json.actions.some((a) => a.id === 'asset.backup' && a.allowed === true) && r.json.actions.some((a) => a.id === 'org.manage' && a.allowed === false));

  // 14. 策略读取/修改/校验
  r = await api('GET', '/api/v2/org/policy');
  check('GET /api/v2/org/policy 200 且保留期合法', r.status === 200 && r.json.policy.auditRetentionDays === 7);
  r = await api('PATCH', '/api/v2/org/policy', { body: { auditRetentionDays: 30, dataDomain: 'E2E 数据域' } });
  check('PATCH /api/v2/org/policy 改为 30 天', r.status === 200 && r.json.policy.auditRetentionDays === 30);
  r = await api('PATCH', '/api/v2/org/policy', { body: { auditRetentionDays: 12 } });
  check('非法保留期 12 天被拒 400', r.status === 400 && r.json.code === 'invalid_policy');

  // 15. 审计导出三种格式
  r = await api('GET', '/api/v2/org/audit/export?format=json');
  const exportJson = (() => { try { return JSON.parse(r.raw); } catch { return null; } })();
  check('审计导出 JSON：200 + count 与账本一致 + 保留期头 30', r.status === 200 && exportJson && exportJson.count === ledger.events.length && r.headers.get('x-tenon-retention-days') === '30', `count=${exportJson && exportJson.count}`);
  check('审计导出 JSON 含越权事件 enterprise.denied', !!exportJson && exportJson.events.some((e) => e.type === 'enterprise.denied'));
  r = await api('GET', '/api/v2/org/audit/export?format=csv');
  check('审计导出 CSV：200 + 表头', r.status === 200 && r.raw.startsWith('seq,at,type,actor,data') && (r.headers.get('content-type') || '').includes('text/csv'));
  r = await api('GET', '/api/v2/org/audit/export?format=md');
  check('审计导出 MD：200 + 标题/表格', r.status === 200 && r.raw.startsWith('# 企业审计导出') && r.raw.includes('| seq | 时间 | 类型 | 执行者 | 数据摘要 |'));
  r = await api('GET', '/api/v2/org/audit/export?format=json', { token: null });
  check('审计导出无令牌 401', r.status === 401);
  r = await api('GET', '/api/v2/org/audit/export?format=xml');
  check('审计导出非法格式 400', r.status === 400);

  // 16. 身份适配器
  r = await api('GET', '/api/v2/org/identity/providers');
  check('身份适配器列表：mock 可用 / 企业微信待凭据', r.status === 200 && r.json.providers.find((p) => p.type === 'mock').configured === true && r.json.providers.find((p) => p.type === 'wecom').configured === false);
  r = await api('GET', '/api/v2/org/identity/mock/login-url?state=e2e');
  check('mock login-url 生成', r.status === 200 && String(r.json.url).includes('state=e2e'));
  r = await api('POST', '/api/v2/org/identity/mock/callback', { body: { code: 'MOCK-E2E', state: 'e2e' } });
  check('mock 身份回调返回用户', r.status === 200 && r.json.ok === true && !!r.json.user.name);
  r = await api('GET', '/api/v2/org/identity/wecom/login-url');
  check('企业微信未配置返回 409（不伪造成功）', r.status === 409 && r.json.code === 'identity_not_configured');

  // 17. 未知路由
  r = await api('GET', '/api/v2/org/nope');
  check('未知路由 404', r.status === 404 && r.json.code === 'not_found');

  // 18. 账本完整性 + 事件类型收敛
  const allowedTypes = new Set(['enterprise.role.changed', 'approval.requested', 'approval.decided', 'enterprise.denied']);
  const unexpected = ledger.events.filter((e) => !allowedTypes.has(e.type)).map((e) => e.type);
  check('账本仅含企业契约事件（+denied）', unexpected.length === 0, unexpected.join(','));
  check('账本哈希链完整 ok=true', ledger.integrity().ok === true, `events=${ledger.integrity().events}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  const summary = {
    at: new Date().toISOString(),
    port,
    total: results.length,
    passed: results.length - failed,
    failed,
    checks: results,
    ledger: { events: ledger.events.length, integrityOk: ledger.integrity().ok, types: ledger.events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {}) },
    dataFiles: fs.existsSync(service.dir) ? fs.readdirSync(service.dir) : [],
  };
  fs.writeFileSync(path.join(DATA_BASE, 'http-e2e-result.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  fs.rmSync(runDir, { recursive: true, force: true });
  console.log(`\n结果：${summary.passed}/${summary.total} 通过，${failed} 失败；端口 ${port}；账本 ${summary.ledger.events} 事件；evidence=_internal/enterprise-data/http-e2e-result.json`);
  if (failed > 0) process.exitCode = 1;
}
