// 企业控制面 v2-P0 · 与 Lead 的 server/lib/v2/index.js 真实挂载集成测试（隔离端口 7436）
// 运行：node server/lib/enterprise/__tests__/integration-v2.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { Ledger } from '../../ledger.js';
import { replay } from '../../state.js';
import { createV2 } from '../../v2/index.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const DATA_BASE = path.join(ROOT, '_internal', 'enterprise-data');
const TOKEN = 'integration-token-7436';
const PREFERRED_PORT = Number(process.env.TENON_ENT_INT_PORT || 7436);

const results = [];
let failed = 0;
// 防挂起看门狗：集成测试依赖 Lead 正在演进的 v2 模块，任何一步卡住都强制退出并给出进度
const WATCHDOG_MS = Number(process.env.TENON_ENT_INT_WATCHDOG || 60000);
const watchdog = setTimeout(() => {
  console.error(`WATCHDOG ${WATCHDOG_MS}ms 超时：强制退出（最后进度见上）`);
  process.exit(2);
}, WATCHDOG_MS);
watchdog.unref();
function progress(msg) { console.log('[progress] ' + msg); }
function check(name, cond, detail = '') {
  const pass = !!cond;
  results.push({ name, pass, detail: String(detail == null ? '' : detail).slice(0, 300) });
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`);
}

fs.mkdirSync(DATA_BASE, { recursive: true });
const runDir = fs.mkdtempSync(path.join(DATA_BASE, 'integration-v2-'));
const dataDir = path.join(runDir, 'data');
const ledger = new Ledger(path.join(runDir, 'ledger'));
const secret = { operatorToken: TOKEN, nodeToken: 'node-token' };
const authed = (req) => {
  const header = req.headers['x-tenon-token'] || '';
  return String(header) === TOKEN;
};

let server = null;
let port = null;
try {
  progress('calling createV2');
  const v2 = await createV2({
    root: ROOT,
    ledger,
    state: replay(ledger.events),
    ai: { available: false, model: 'rule' },
    secret,
    readOnly: false,
    dataDir,
    authed,
  });

  progress('createV2 done, modules=' + Object.keys(v2.services).join(',') + ' errors=' + JSON.stringify(v2.mountErrors));
  server = http.createServer(async (req, res) => {
    try {
      const u = new URL(String(req.url || '/'), 'http://localhost');
      const pathname = u.pathname;
      if (!pathname.startsWith('/api/v2/')) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
        return;
      }
      // 与 Lead 的 http.js 门禁一致：写操作需令牌（只读实例 423 未在此模拟）
      if (req.method !== 'GET' && !authed(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '需要登录令牌' }));
        return;
      }
      await v2.handle(req, res, u, pathname);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
  });

  for (const candidate of [PREFERRED_PORT, PREFERRED_PORT + 1, PREFERRED_PORT + 2]) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (e) => {
          server.removeListener('listening', onListening);
          reject(e);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          port = candidate;
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidate, '127.0.0.1');
      });
      break;
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      console.log(`端口 ${candidate} 被占用，尝试下一个`);
    }
  }
  if (!port) throw new Error('7436-7438 端口都被占用');

  progress('listening on ' + port);
  const BASE = `http://127.0.0.1:${port}`;
  async function api(method, pathname, { body, token = TOKEN, user = '' } = {}) {
    const headers = {};
    if (token) headers['x-tenon-token'] = token;
    if (user) headers['x-tenon-user'] = user;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + pathname, { method, headers, body: payload });
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* 导出格式 */
    }
    return { status: res.status, raw, json };
  }

  // 1. createV2 已挂载 enterprise，且 route 路径为相对 /api/v2
  check('createV2 挂载 enterprise（mountErrors 不含 enterprise）', !v2.mountErrors.some((e) => e.startsWith('enterprise')), JSON.stringify(v2.mountErrors));
  check('enterprise routes 已进入 Lead 路由表', v2.routes.some((r) => r.module === 'enterprise' && r.path === '/org/users'));

  // 2. 健康检查
  let r = await api('GET', '/api/v2/health');
  check('GET /api/v2/health 200 且列出 enterprise', r.status === 200 && r.json.modules.includes('enterprise'), JSON.stringify(r.json && r.json.pending));

  // 3. 写操作无令牌 401（Lead 门禁）
  r = await api('POST', '/api/v2/org/users', { body: { name: 'x' }, token: null });
  check('写操作无令牌 401', r.status === 401);

  // 4. 创建成员 + 激活
  r = await api('POST', '/api/v2/org/users', { body: { name: '集成成员', role: 'member' } });
  const member = r.json && r.json.user ? r.json.user : null;
  check('经 Lead 路由创建成员 201', r.status === 201 && member && /^INV-/.test(member.inviteCode || ''));
  r = await api('POST', '/api/v2/org/users', { body: { inviteCode: member.inviteCode } });
  check('邀请码激活 200', r.status === 200 && r.json.user.status === 'active');

  // 5. 读取成员（有令牌，本模块 readGuard 许可）
  r = await api('GET', '/api/v2/org/users');
  check('GET /api/v2/org/users 200 且含成员', r.status === 200 && r.json.users.some((u) => u.userId === member.userId));
  r = await api('GET', '/api/v2/org/users', { token: null });
  check('企业成员读接口无令牌 401（鉴权接线后 fail-closed）', r.status === 401);

  // 6. 审批流走 Lead 路由
  r = await api('POST', '/api/v2/org/actions/check', { body: { userId: member.userId, action: 'asset.print' } });
  const approvalId = r.json && r.json.result ? r.json.result.approvalId : '';
  check('动作检查要求审批', r.status === 200 && r.json.result.code === 'approval_required', `approvalId=${approvalId}`);
  r = await api('POST', `/api/v2/approvals/${approvalId}/decide`, { body: { ok: true, reason: '集成测试' } });
  check('管理员审批通过', r.status === 200 && r.json.approval.status === 'approved');

  // 6b. PATCH /api/v2/org/users/:id（经 Lead createV2 路由）：管理员 200 改角色生效 / 无令牌 401
  r = await api('POST', '/api/v2/org/users', { body: { name: '集成访客', role: 'guest' } });
  const guestId = r.json.user.userId;
  await api('POST', '/api/v2/org/users', { body: { inviteCode: r.json.user.inviteCode } });
  r = await api('POST', '/api/v2/org/users', { body: { name: '集成待改成员', role: 'member' } });
  const patchId = r.json.user.userId;
  await api('POST', '/api/v2/org/users', { body: { inviteCode: r.json.user.inviteCode } });
  r = await api('PATCH', `/api/v2/org/users/${patchId}`, { body: { role: 'guest' } });
  check('经 Lead 路由 PATCH 成员改角色 200 且生效', r.status === 200 && r.json.ok === true && r.json.user.role === 'guest');
  r = await api('GET', '/api/v2/org/users');
  check('经 Lead 路由 GET 成员列表角色已更新', r.status === 200 && r.json.users.some((u) => u.userId === patchId && u.role === 'guest'));
  const roleEvent = ledger.events.filter((e) => e.type === 'enterprise.role.changed' && e.data.userId === patchId).at(-1);
  check('role.changed 事件字段 {userId, role, name}', !!roleEvent && roleEvent.data.role === 'guest' && roleEvent.data.name === '集成待改成员');
  r = await api('PATCH', `/api/v2/org/users/${patchId}`, { body: { role: 'guest' }, token: null });
  check('经 Lead 路由 PATCH 无令牌 401', r.status === 401);
  r = await api('PATCH', `/api/v2/org/users/${patchId}`, { body: { role: 'member' }, user: guestId });
  check('经 Lead 路由 PATCH 非管理员 403', r.status === 403);

  // 7. 审计导出（挂载后仍要求令牌）
  r = await api('GET', '/api/v2/org/audit/export?format=md');
  check('经 Lead 路由审计导出 MD 200', r.status === 200 && r.raw.startsWith('# 企业审计导出'));
  r = await api('GET', '/api/v2/org/audit/export?format=json', { token: null });
  check('审计导出无令牌 401', r.status === 401);

  // 7b. 策略 PATCH（也验证策略持久化落盘）
  r = await api('PATCH', '/api/v2/org/policy', { body: { auditRetentionDays: 30, dataDomain: '集成测试域' } });
  check('经 Lead 路由 PATCH 策略 200', r.status === 200 && r.json.policy.auditRetentionDays === 30);

  // 8. 账本与数据文件
  const types = ledger.events.map((e) => e.type);
  check('账本事件走契约类型', types.every((t) => ['enterprise.role.changed', 'approval.requested', 'approval.decided', 'enterprise.denied'].includes(t)), types.join(','));
  check('账本哈希链完整', ledger.integrity().ok === true, `events=${ledger.events.length}`);
  const entDir = path.join(dataDir, 'enterprise');
  const dataFiles = fs.existsSync(entDir) ? fs.readdirSync(entDir) : [];
  check('企业数据文件已落盘（org/approvals/policy.json）', ['org.json', 'approvals.json', 'policy.json'].every((f) => dataFiles.includes(f)), `files=${dataFiles.join(',')}`);

  const summary = {
    at: new Date().toISOString(),
    port,
    v2MountErrors: v2.mountErrors,
    mountedModules: Object.keys(v2.services),
    total: results.length,
    passed: results.length - failed,
    failed,
    checks: results,
    ledger: { events: ledger.events.length, integrityOk: ledger.integrity().ok, types: types.reduce((acc, t) => { acc[t] = (acc[t] || 0) + 1; return acc; }, {}) },
  };
  fs.writeFileSync(path.join(DATA_BASE, 'integration-v2-result.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log(`\n结果：${summary.passed}/${summary.total} 通过，${failed} 失败；端口 ${port}；v2 模块=${summary.mountedModules.join(',')}`);
  console.log(`evidence=_internal/enterprise-data/integration-v2-result.json`);
  if (failed > 0) process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (server) {
    try { server.closeAllConnections && server.closeAllConnections(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      server.close(() => { clearTimeout(timer); resolve(); });
    });
  }
  fs.rmSync(runDir, { recursive: true, force: true });
  // Lead 其它 v2 模块可能带常驻定时器/连接，集成测试跑完强制退出，避免进程挂起
  process.exit(failed > 0 ? 1 : 0);
}
