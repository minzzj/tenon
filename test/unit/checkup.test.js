import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../../server/lib/state.js';
import { runCheckup } from '../../server/lib/checkup.js';
import { newLedger, cleanupTempDirs } from './helpers.mjs';

after(cleanupTempDirs);

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);
const DAY = 86400000;
let seq = 0;
const iso = (ms) => new Date(ms).toISOString();
function ev(type, data, at = NOW - 60000) {
  seq += 1;
  return { seq, at: iso(at), type, actor: 'hub', data };
}
function runCheckupOn(events, opts = {}) {
  const ledger = newLedger();
  const state = replay(events);
  const result = runCheckup({
    ledger,
    state,
    scope: opts.scope || 'all',
    integrity: opts.integrity || { ok: true, gaps: [] },
    aiAvailable: opts.aiAvailable !== undefined ? opts.aiAvailable : true,
    mode: opts.mode || 'solo',
    now: opts.now || NOW,
  });
  return { result, ledger, state };
}
const findingsOf = (result) => result.findings.map((f) => f.title);
const hasFinding = (result, re) => result.findings.some((f) => re.test(f.title + ' ' + f.detail));

const cap = (id, over = {}) => ({ id, name: id, risk: 'reversible', manualOnly: false, version: '1.0.0', evidence: 'confirmed', ...over });
const nodeEv = (nodeId, caps, over = {}) => ev('node.registered', {
  nodeId, name: '设备-' + nodeId, platform: 'windows', fingerprint: 'fp-' + nodeId, capabilities: caps, ...over,
});
const onlineNode = (nodeId, caps, over = {}) => {
  const list = [nodeEv(nodeId, caps, over)];
  return list;
};

test('体检空状态（scope=all）：未发现问题并列出检查范围（7 项）', () => {
  const { result } = runCheckupOn([]);
  assert.equal(result.verdict, 'none');
  assert.deepEqual(result.findings, []);
  assert.equal(result.checked, 7);
  assert.match(result.summary, /^未发现问题，已检查 7 项$/);
  assert.equal(result.items.length, 7);
});

test('体检 scope=channels 干净通道：空结果文案「未发现问题，已检查 N 项」', () => {
  const { result } = runCheckupOn([], { scope: 'channels' });
  assert.equal(result.verdict, 'none');
  assert.equal(result.checked, 1);
  assert.deepEqual(result.items, ['通道可用']);
  assert.equal(result.summary, '未发现问题，已检查 1 项');
});

test('体检 scope=channels：限流记录 → 「微信通道因限流被降级到邮件」notice', () => {
  const events = [
    ev('task.drafted', { taskId: 't1', text: '发链接', draft: { summary: 's', capabilities: [], targetDevice: null, missing: [], risk: { level: 'reversible', reasons: [] }, params: {} } }),
    ev('task.deliveryAttempt', { taskId: 't1', channel: 'wechat-mock', status: 'limited', reason: '限流' }),
  ];
  const { result } = runCheckupOn(events, { scope: 'channels' });
  assert.equal(result.verdict, 'findings');
  assert.ok(hasFinding(result, /微信通道因限流被降级到邮件/));
  assert.equal(result.findings[0].level, 'notice');
});

test('体检 scope=channels：通道不可用记录 → 「通道不可用：账号异常」warning', () => {
  const events = [
    ev('task.drafted', { taskId: 't1', text: '发链接', draft: { summary: 's', capabilities: [], targetDevice: null, missing: [], risk: { level: 'reversible', reasons: [] }, params: {} } }),
    ev('task.deliveryAttempt', { taskId: 't1', channel: 'wechat-mock', status: 'unavailable', reason: '账号异常' }),
  ];
  const { result } = runCheckupOn(events, { scope: 'channels' });
  assert.ok(hasFinding(result, /通道不可用：账号异常/));
  assert.equal(result.findings[0].level, 'warning');
});

test('体检 scope=devices：离线设备 → warning「设备离线」', () => {
  const events = [...onlineNode('dev-printer', [cap('printer.mock')]), ev('node.offline', { nodeId: 'dev-printer' })];
  const { result } = runCheckupOn(events, { scope: 'devices' });
  assert.ok(hasFinding(result, /设备离线：设备-dev-printer/));
  assert.ok(hasFinding(result, /保留上次状态，任务排队，不解绑/));
});

test('体检 scope=auth 不检查设备，scope=devices 只检查设备（checked 各 1 项）', () => {
  const events = [...onlineNode('dev-printer', [cap('printer.mock')]), ev('node.offline', { nodeId: 'dev-printer' })];
  const auth = runCheckupOn(events, { scope: 'auth' }).result;
  assert.equal(auth.checked, 1);
  assert.deepEqual(auth.items, ['权限与角色']);
  assert.equal(auth.verdict, 'none');
  const devices = runCheckupOn(events, { scope: 'devices' }).result;
  assert.equal(devices.checked, 1);
  assert.deepEqual(devices.items, ['设备与模型']);
});

test('体检：版本不兼容 → warning「需要 2.3 以上，当前 2.1」', () => {
  const events = [
    ...onlineNode('dev-llm', [cap('llm.summarize', { version: '2.1' })]),
    ev('capability.versionMismatch', { nodeId: 'dev-llm', capabilityId: 'llm.summarize', required: '2.3', current: '2.1' }),
  ];
  const { result } = runCheckupOn(events, { scope: 'devices' });
  assert.ok(hasFinding(result, /版本不兼容：设备-dev-llm/));
  assert.ok(hasFinding(result, /需要 2.3 以上，当前 2.1/));
});

test('体检：授权已过期 5 天 → warning 并写明「5 天前」', () => {
  const events = onlineNode('dev-nas', [cap('nas.sync', { authExpiresAt: iso(NOW - 5 * DAY) })]);
  const { result } = runCheckupOn(events, { scope: 'devices' });
  assert.ok(hasFinding(result, /授权已过期：设备-dev-nas/));
  assert.ok(hasFinding(result, /5 天前到期/));
});

test('体检：授权 3 天后到期 → notice「授权将在 3 天后到期」', () => {
  const events = onlineNode('dev-printer', [cap('printer.mock', { authExpiresAt: iso(NOW + 3 * DAY) })]);
  const { result } = runCheckupOn(events, { scope: 'devices' });
  assert.ok(hasFinding(result, /授权将在 3 天后到期/));
  assert.equal(result.findings[0].level, 'notice');
});

test('体检：账本存在缺口 → blocked「事件账本存在缺口」', () => {
  const { result } = runCheckupOn([], { integrity: { ok: false, gaps: [{ seq: 3, reason: 'hash-mismatch' }] } });
  assert.ok(hasFinding(result, /事件账本存在缺口/));
  const blocked = result.findings.find((f) => f.title.includes('事件账本存在缺口'));
  assert.equal(blocked.level, 'blocked');
});

test('体检：任务成功但未回传 → notice「任务完成但未回传」', () => {
  const events = [
    ev('task.drafted', { taskId: 't1', text: '裁方图', draft: { summary: 's', capabilities: [], targetDevice: null, missing: [], risk: { level: 'reversible', reasons: [] }, params: {} } }),
    ev('task.succeeded', { taskId: 't1', result: { summary: '完成', items: [], partial: false } }),
  ];
  const { result } = runCheckupOn(events);
  assert.ok(hasFinding(result, /任务完成但未回传/));
});

test('体检：未配置 AI key → notice；solo 降级模式 → notice', () => {
  const events = [ev('system.degraded', { mode: 'readonly', reason: '双实例' })];
  const r1 = runCheckupOn(events, { aiAvailable: false }).result;
  assert.ok(hasFinding(r1, /未配置 AI API key/));
  assert.ok(hasFinding(r1, /降级模式：readonly/));
  const r2 = runCheckupOn([], { aiAvailable: true }).result;
  assert.ok(!hasFinding(r2, /未配置 AI API key/));
});

test('体检：磁盘满 → warning「空间不足」；上次异常退出 → notice', () => {
  const events = [ev('system.diskFull', { full: true }), ev('system.boot', { pid: 1, mode: 'solo' })];
  const { result } = runCheckupOn(events);
  assert.ok(hasFinding(result, /空间不足，摘要暂停/));
  assert.ok(hasFinding(result, /检测到上次异常退出/));
  const clean = runCheckupOn([ev('system.boot', { pid: 1, mode: 'solo' }), ev('system.stopped', {})]).result;
  assert.ok(!hasFinding(clean, /检测到上次异常退出/));
});

test('体检：待确认超过 1 天的不可逆任务 → warning；刚创建的 pending 不告警', () => {
  const oldAt = NOW - 2 * DAY;
  const oldDraft = ev('task.drafted', {
    taskId: 't-old', text: '打印旧合同', draft: { summary: 's', capabilities: [], targetDevice: null, missing: [], risk: { level: 'irreversible', reasons: [] }, params: {} },
  }, oldAt);
  const fresh = ev('task.drafted', {
    taskId: 't-new', text: '打印新合同', draft: { summary: 's', capabilities: [], targetDevice: null, missing: [], risk: { level: 'irreversible', reasons: [] }, params: {} },
  }, NOW - 60000);
  const { result } = runCheckupOn([oldDraft, fresh], { scope: 'auth' });
  assert.ok(hasFinding(result, /待确认超过/));
  const warned = result.findings.filter((f) => /待确认超过/.test(f.title));
  assert.equal(warned.length, 1);
  assert.match(warned[0].detail, /打印旧合同/);
});

test('体检：checkup.ran 写入账本，字段完整（items/checked/summary/scope）', () => {
  const { result, ledger } = runCheckupOn([], { scope: 'channels' });
  assert.match(result.checkupId, /^chk_/);
  const evs = ledger.events.filter((e) => e.type === 'checkup.ran');
  assert.equal(evs.length, 1);
  const data = evs[0].data;
  assert.equal(data.checkupId, result.checkupId);
  assert.equal(data.scope, 'channels');
  assert.deepEqual(data.findings, []);
  assert.equal(data.verdict, 'none');
  assert.equal(data.checked, 1);
  assert.equal(data.summary, '未发现问题，已检查 1 项');
  assert.deepEqual(data.items, ['通道可用']);
});

test('体检：有多条发现时 summary 给出数量与「按影响排序」', () => {
  const events = [
    ...onlineNode('dev-printer', [cap('printer.mock', { authExpiresAt: iso(NOW + 2 * DAY) })]),
    ev('node.offline', { nodeId: 'dev-printer' }),
    ev('system.diskFull', { full: true }),
  ];
  const { result } = runCheckupOn(events);
  assert.equal(result.verdict, 'findings');
  assert.ok(result.findings.length >= 3);
  assert.equal(result.summary, `发现 ${result.findings.length} 项，按影响排序如下`);
});