import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  replay, snapshot, relations, recentCalls, onlineNodes, impact, stable,
} from '../../server/lib/state.js';
import { cleanupTempDirs, withFrozenTime } from './helpers.mjs';

after(cleanupTempDirs);

// state.js 的 replay 不校验哈希链，这里直接构造事件对象，聚焦 apply() 语义
let seq = 0;
function ev(type, data, extra = {}) {
  seq += 1;
  return {
    seq,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seq * 60000).toISOString(),
    type,
    actor: 'hub',
    data,
    ...extra,
  };
}
function replayOf(events) {
  seq = 0;
  return replay(events.map((e) => (e.seqPrepared ? e : e)));
}
function freshReplay(list) {
  return replay(list);
}

function registeredNode(nodeId, caps = [], extra = {}) {
  return ev('node.registered', {
    nodeId, name: '设备-' + nodeId, platform: 'windows', fingerprint: 'fp-' + nodeId, capabilities: caps, ...extra,
  });
}
function draftedTask(taskId, over = {}) {
  const draft = {
    summary: '摘要',
    capabilities: [{ id: 'image.crop', name: '裁方图', manualOnly: false }],
    targetDevice: { id: 'n1', name: '设备-n1' },
    missing: [],
    risk: { level: 'reversible', reasons: [] },
    params: {},
    ...(over.draft || {}),
  };
  return ev('task.drafted', {
    taskId, text: over.text || '把图裁成方图', draft, evidenceLevel: over.evidenceLevel || 'possible', ai: over.ai || null,
  });
}
const CAP = (id, over = {}) => ({
  id, name: id, risk: 'reversible', manualOnly: false, version: '1.0.0', evidence: 'confirmed', ...over,
});

test('replay：空账本返回完整默认形状', () => {
  const s = replay([]);
  assert.deepEqual(s.nodes, {});
  assert.deepEqual(s.tasks, {});
  assert.deepEqual(s.messages, []);
  assert.deepEqual(s.checkups, []);
  assert.equal(s.seq, 0);
  assert.equal(s.dataAsOf, null);
  assert.equal(s.meta.mode, 'solo');
  assert.equal(s.meta.domainLabel, '工作室数据域');
  assert.deepEqual(s.aiUsage, { calls: 0, tokensIn: 0, tokensOut: 0, cached: 0, places: {} });
});

test('replay：两次重放结果完全一致（冻结时钟下的深比较）', () => {
  const list = [
    registeredNode('n1', [CAP('image.crop')]),
    draftedTask('t1'),
    ev('task.queued', { taskId: 't1', nodeId: 'n1' }),
    ev('task.started', { taskId: 't1', nodeId: 'n1', nodeName: '设备-n1' }),
    ev('task.step', { taskId: 't1', label: '裁剪', detail: '1024' }),
    ev('task.succeeded', { taskId: 't1', result: { summary: '完成', items: [], partial: false } }),
    ev('task.delivered', { taskId: 't1', channel: 'wechat-mock', summary: '完成', link: '/r/t1' }),
    ev('message.inbox', { messageId: 'm1', taskId: 't1', channel: 'wechat-mock', summary: '完成' }),
  ];
  const a = withFrozenTime('2026-06-01T00:00:00.000Z', () => replay(list));
  const b = withFrozenTime('2026-06-01T00:00:00.000Z', () => replay(list));
  assert.deepEqual(a, b);
  assert.equal(stable(a), stable(b));
});

test('replay：seq 与 dataAsOf 取最后一条事件', () => {
  const list = [registeredNode('n1', []), ev('node.heartbeat', { nodeId: 'n1' })];
  const s = replay(list);
  assert.equal(s.seq, list[list.length - 1].seq);
  assert.equal(s.dataAsOf, list[list.length - 1].at);
});

test('node.registered：confirmed/online/kind/lastSeen/domain 正确', () => {
  const s = replay([registeredNode('n1', [CAP('image.crop')], { domain: 'outside' })]);
  const n = s.nodes.n1;
  assert.equal(n.evidence, 'confirmed');
  assert.equal(n.online, true);
  assert.equal(n.kind, 'node');
  assert.equal(n.domain, 'outside');
  assert.equal(n.lastSeen, s.dataAsOf);
  assert.equal(n.capabilities[0].id, 'image.crop');
});

test('device.imported：evidence=declared，online 可指定，domain 默认 studio', () => {
  const s = replay([
    ev('device.imported', { nodeId: 'd1', name: 'NAS', fingerprint: 'fp', online: false, capabilities: [CAP('nas.sync')] }),
  ]);
  const n = s.nodes.d1;
  assert.equal(n.evidence, 'declared');
  assert.equal(n.online, false);
  assert.equal(n.kind, 'imported');
  assert.equal(n.domain, 'studio');
  assert.equal(n.hidden, false);
});

test('node.heartbeat / node.offline：在线状态与 lastSeen 变化', () => {
  const list = [registeredNode('n1', []), ev('node.offline', { nodeId: 'n1', since: '2026-01-02T00:00:00.000Z' }), ev('node.heartbeat', { nodeId: 'n1' })];
  const s = replay(list);
  assert.equal(s.nodes.n1.online, true);
  assert.equal(s.nodes.n1.lastSeen, list[2].at);
  const s2 = replay([registeredNode('n1', []), ev('node.offline', { nodeId: 'n1', since: '2026-01-02T00:00:00.000Z' })]);
  assert.equal(s2.nodes.n1.online, false);
  assert.equal(s2.nodes.n1.offlineSince, '2026-01-02T00:00:00.000Z');
});

test('device.hidden / device.disconnected：隐身与墓碑', () => {
  const list = [registeredNode('n1', []), ev('device.hidden', { nodeId: 'n1', hidden: true }), ev('device.disconnected', { nodeId: 'n1' })];
  const s = replay(list);
  assert.equal(s.nodes.n1.hidden, true);
  assert.equal(s.nodes.n1.disconnected, true);
  assert.equal(s.nodes.n1.online, false);
  assert.ok(s.nodes.n1.tombstoneAt);
});

test('device.movedOutOfDomain / device.renamed：域外只读与别名', () => {
  const s = replay([
    registeredNode('n1', []),
    ev('device.movedOutOfDomain', { nodeId: 'n1' }),
    ev('device.renamed', { nodeId: 'n1', from: '旧名', to: '新名' }),
  ]);
  assert.equal(s.nodes.n1.domain, 'outside');
  assert.equal(s.nodes.n1.readOnly, true);
  assert.equal(s.nodes.n1.name, '新名');
  assert.deepEqual(s.nodes.n1.aliases, ['旧名']);
});

test('capability.authExpired / versionMismatch：能力标记', () => {
  const s = replay([
    registeredNode('n1', [CAP('printer.mock'), CAP('llm.summarize', { version: '2.1' })]),
    ev('capability.authExpired', { nodeId: 'n1', capabilityId: 'printer.mock' }),
    ev('capability.versionMismatch', { nodeId: 'n1', capabilityId: 'llm.summarize', required: '2.3', current: '2.1' }),
  ]);
  const printer = s.nodes.n1.capabilities.find((c) => c.id === 'printer.mock');
  const llm = s.nodes.n1.capabilities.find((c) => c.id === 'llm.summarize');
  assert.equal(printer.authExpired, true);
  assert.equal(llm.compatible, false);
  assert.equal(llm.required, '2.3');
  assert.equal(llm.current, '2.1');
});

test('task.drafted：可逆 → draft，不可逆 → pending，首步骤为「草案已生成」', () => {
  const s = replay([
    registeredNode('n1', [CAP('image.crop'), CAP('printer.mock', { risk: 'irreversible' })]),
    draftedTask('t1'),
    draftedTask('t2', { text: '打印合同', draft: { capabilities: [{ id: 'printer.mock', name: '打印' }], risk: { level: 'irreversible', reasons: ['不可逆'] } } }),
  ]);
  assert.equal(s.tasks.t1.status, 'draft');
  assert.equal(s.tasks.t2.status, 'pending');
  assert.equal(s.tasks.t1.steps[0].label, '草案已生成');
  assert.equal(s.tasks.t2.nodeId, 'n1');
  assert.equal(s.tasks.t2.capabilityId, 'printer.mock');
  assert.equal(s.tasks.t2.evidenceLevel, 'possible');
});

test('task.drafted：manualOnly 由首能力推出，缺项与 AI 信息保留', () => {
  const s = replay([draftedTask('t1', {
    draft: { capabilities: [{ id: 'video.transcode', name: '转码', manualOnly: true }], missing: ['输出尺寸'] },
    ai: { provider: 'rule', fallback: true },
  })]);
  assert.equal(s.tasks.t1.manualOnly, true);
  assert.deepEqual(s.tasks.t1.missing, ['输出尺寸']);
  assert.equal(s.tasks.t1.ai.provider, 'rule');
});
test('任务状态机：草案→确认→排队→执行中→步骤→成功（partial 标「部分成功」）', () => {
  const list = [
    registeredNode('n1', [CAP('image.crop')]),
    draftedTask('t1'),
    ev('task.confirmed', { taskId: 't1', note: '确认执行' }),
    ev('task.queued', { taskId: 't1', nodeId: 'n1' }),
    ev('task.started', { taskId: 't1', nodeId: 'n1', nodeName: '设备-n1' }),
    ev('task.step', { taskId: 't1', label: '逐张裁剪', detail: '1024' }),
    ev('task.succeeded', { taskId: 't1', result: { summary: '9 张成功，1 张失败：文件损坏', items: [], partial: true } }),
  ];
  const s = replay(list);
  const t = s.tasks.t1;
  assert.equal(t.status, 'succeeded');
  assert.ok(t.confirmedAt);
  assert.equal(t.result.summary, '9 张成功，1 张失败：文件损坏');
  assert.equal(t.result.partial, true);
  const labels = t.steps.map((x) => x.label);
  assert.deepEqual(labels, ['草案已生成', '已确认', '已排队', '开始执行', '逐张裁剪', '部分成功']);
  assert.equal(t.updatedAt, list[list.length - 1].at);
});

test('任务状态机：失败 / 超时 写入 error 与步骤', () => {
  const s = replay([
    draftedTask('t1'), ev('task.failed', { taskId: 't1', error: '版本不兼容：需要 2.3 以上，当前 2.1' }),
    draftedTask('t2'), ev('task.timeout', { taskId: 't2', durationMs: 300000 }),
  ]);
  assert.equal(s.tasks.t1.status, 'failed');
  assert.equal(s.tasks.t1.error, '版本不兼容：需要 2.3 以上，当前 2.1');
  assert.equal(s.tasks.t1.steps.at(-1).label, '执行失败');
  assert.equal(s.tasks.t2.status, 'timeout');
  assert.match(s.tasks.t2.steps.at(-1).detail, /300 秒/);
});

test('任务状态机：取消（已完成步骤不回滚）/ 拒绝（原因留痕）/ 重试计数', () => {
  const s = replay([
    draftedTask('t1'), ev('task.cancelled', { taskId: 't1', completedSteps: 2 }),
    draftedTask('t2'), ev('task.rejected', { taskId: 't2' }),
    draftedTask('t3'), ev('task.retry', { taskId: 't3' }), ev('task.retry', { taskId: 't3' }),
  ]);
  assert.equal(s.tasks.t1.status, 'cancelled');
  assert.match(s.tasks.t1.steps.at(-1).detail, /前 2 步已完成/);
  assert.equal(s.tasks.t2.status, 'cancelled');
  assert.equal(s.tasks.t2.rejectReason, '未填写');
  assert.equal(s.tasks.t3.status, 'queued');
  assert.equal(s.tasks.t3.retries, 2);
  assert.equal(s.tasks.t3.steps.at(-1).label, '重试');
});

test('回传：deliveryAttempt / delivered 组装 delivery，undelivered 标未送达', () => {
  const s = replay([
    draftedTask('t1'),
    ev('task.deliveryAttempt', { taskId: 't1', channel: 'wechat-mock', status: 'limited', reason: '限流' }),
    ev('task.delivered', { taskId: 't1', channel: 'email-mock', messageId: 'm1', summary: '完成', link: '/r/t1', status: 'degraded' }),
    draftedTask('t2'),
    ev('task.delivered', { taskId: 't2', channel: 'wechat-mock', messageId: 'm2', summary: '完成', link: '/r/t2' }),
    draftedTask('t3'),
    ev('task.undelivered', { taskId: 't3', channel: 'wechat-mock', summary: '未送达' }),
  ]);
  assert.equal(s.tasks.t1.deliveryAttempts.length, 1);
  assert.equal(s.tasks.t1.deliveryAttempts[0].status, 'limited');
  assert.equal(s.tasks.t1.delivery.channel, 'email-mock');
  assert.equal(s.tasks.t1.delivery.status, 'degraded');
  assert.equal(s.tasks.t2.delivery.status, 'delivered');
  assert.equal(s.tasks.t3.delivery.status, 'undelivered');
});

test('message.inbox：字段齐全，默认值正确，sensitive 透传', () => {
  const s = replay([
    ev('message.inbox', { messageId: 'm1', taskId: 't1', channel: 'wechat-mock', summary: '摘要', link: '/r/t1', sensitive: true }),
    ev('message.inbox', { messageId: 'm2', taskId: 't2', channel: 'station' }),
  ]);
  assert.equal(s.messages.length, 2);
  const m = s.messages[0];
  assert.equal(m.title, '任务回执');
  assert.equal(m.status, 'delivered');
  assert.equal(m.sensitive, true);
  assert.equal(m.channelLabel, 'wechat-mock');
  assert.equal(s.messages[1].sensitive, false);
});

test('checkup.ran：体检结果进入 checkups', () => {
  const findings = [{ level: 'warning', title: '设备离线：打印服务器', detail: '', evidence: '' }];
  const s = replay([ev('checkup.ran', {
    checkupId: 'chk_1', scope: 'all', findings, verdict: 'findings', checked: 7, summary: '发现 1 项，按影响排序如下',
  })]);
  assert.equal(s.checkups.length, 1);
  assert.deepEqual(s.checkups[0], {
    id: 'chk_1', at: s.dataAsOf, scope: 'all', findings, verdict: 'findings', checked: 7, summary: '发现 1 项，按影响排序如下',
  });
});

test('ai.called：调用数/token/缓存/地点用量/最后一次记录聚合', () => {
  const s = replay([
    ev('ai.called', { place: 'draft', provider: 'rule', model: 'rule', tokensIn: 10, tokensOut: 5, cached: false }),
    ev('ai.called', { place: 'summarize', provider: 'deepseek', model: 'deepseek-chat', tokensIn: 20, tokensOut: 7, cached: true }),
  ]);
  assert.equal(s.aiUsage.calls, 2);
  assert.equal(s.aiUsage.tokensIn, 30);
  assert.equal(s.aiUsage.tokensOut, 12);
  assert.equal(s.aiUsage.cached, 1);
  assert.equal(s.aiUsage.places.draft, 15);
  assert.equal(s.aiUsage.places.summarize, 27);
  assert.equal(s.aiUsage.last.place, 'summarize');
  assert.equal(s.aiUsage.last.provider, 'deepseek');
  assert.equal(s.aiUsage.last.tokens, 27);
});

test('system.*：启动/停止/模式/降级/磁盘/差分恢复', () => {
  const list = [
    ev('system.boot', { pid: 1234, mode: 'solo' }),
    ev('system.modeChanged', { mode: 'team', domainLabel: '工作室局域网' }),
    ev('system.stopped', {}),
    ev('system.degraded', { mode: 'readonly', reason: '双实例' }),
    ev('system.diskFull', { full: true }),
    ev('system.crashRecovery', { gapMs: 120000, tasksResumed: ['t1'], note: '缺口已标记' }),
  ];
  const s = replay(list);
  assert.equal(s.boots.length, 1);
  assert.equal(s.boots[0].pid, 1234);
  assert.ok(s.boots[0].stoppedAt);
  assert.equal(s.startedAt, list[0].at);
  assert.equal(s.meta.mode, 'team');
  assert.equal(s.meta.domainLabel, '工作室局域网');
  assert.equal(s.meta.degraded.mode, 'readonly');
  assert.equal(s.meta.diskFull, true);
  assert.equal(s.recovery.length, 1);
  assert.equal(s.recovery[0].gapMs, 120000);
});

test('loop.blocked / drill.ran / audit.exported / role.insufficient 进入快照数据', () => {
  const s = replay([
    ev('loop.blocked', { chain: ['a', 'b', 'a'], message: 'A→B→A，已阻止' }),
    ev('drill.ran', { kind: 'offline', detail: '断网演练开' }),
    ev('audit.exported', { format: 'csv', count: 10, by: '你' }),
    ev('role.insufficient', { need: 'admin', message: '只读：需要管理员角色' }),
  ]);
  assert.equal(s.loops.length, 1);
  assert.deepEqual(s.loops[0].chain, ['a', 'b', 'a']);
  assert.equal(s.drills[0].kind, 'offline');
  assert.equal(s.audit[0].format, 'csv');
  assert.equal(s.audit[0].count, 10);
  assert.equal(s.meta.lastRoleError.need, 'admin');
});

test('未知事件类型被忽略，不影响既有状态', () => {
  const s = replay([registeredNode('n1', []), ev('mystery.event', { x: 1 }), ev('node.heartbeat', { nodeId: 'n1' })]);
  assert.equal(Object.keys(s.nodes).length, 1);
  assert.equal(s.nodes.n1.online, true);
});
function nodeOf(id, over = {}) {
  return {
    id, name: '设备-' + id, platform: 'windows', fingerprint: 'fp-' + id, capabilities: [], online: true,
    lastSeen: null, evidence: 'confirmed', hidden: false, disconnected: false, domain: 'studio', kind: 'node', ...over,
  };
}
function taskOf(id, over = {}) {
  return {
    id, text: '任务 ' + id, status: 'pending', capabilityId: 'printer.mock', nodeId: 'n1',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', steps: [], evidenceLevel: 'certain',
    draft: { capabilities: [] }, result: null, delivery: null, ...over,
  };
}
function fakeState(over = {}) {
  return {
    nodes: {}, tasks: {}, messages: [], checkups: [], impacts: [], audit: [], recovery: [], boots: [],
    aiUsage: { calls: 0, tokensIn: 0, tokensOut: 0, cached: 0, places: {} },
    meta: { mode: 'solo', domainLabel: '工作室数据域' }, loops: [], drills: [], seq: 0, dataAsOf: null, startedAt: null,
    ...over,
  };
}

test('relations：只收录有能力的任务，给出能力/节点/证据档位', () => {
  const st = fakeState({
    nodes: { n1: nodeOf('n1', { capabilities: [{ id: 'printer.mock', name: '打印' }] }) },
    tasks: {
      t1: taskOf('t1'),
      t2: taskOf('t2', { capabilityId: null, nodeId: null }),
    },
  });
  const rels = relations(st);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].taskId, 't1');
  assert.equal(rels[0].nodeName, '设备-n1');
  assert.equal(rels[0].capability.id, 'printer.mock');
  assert.equal(rels[0].evidenceLevel, 'certain');
  assert.ok(Array.isArray(rels[0].evidence) && rels[0].evidence.length >= 1);
});

test('relations：缺失节点的关系显示「未知设备」，按设备声明档位降级', () => {
  const st = fakeState({
    nodes: { n2: nodeOf('n2', { evidence: 'declared', capabilities: [] }) },
    tasks: {
      t1: taskOf('t1', { nodeId: 'n2', capabilityId: 'printer.mock' }),
      t2: taskOf('t2', { nodeId: 'ghost', capabilityId: 'printer.mock', evidenceLevel: undefined }),
    },
  });
  const rels = relations(st);
  const t1 = rels.find((r) => r.taskId === 't1');
  const t2 = rels.find((r) => r.taskId === 't2');
  assert.equal(t1.nodeName, '设备-n2');
  assert.equal(t2.nodeName, '未知设备');
  assert.equal(t2.evidenceLevel, 'possible');
});

test('recentCalls：只取终态任务，按 updatedAt 倒序并限量', () => {
  const st = fakeState({
    tasks: {
      t1: taskOf('t1', { status: 'succeeded', capabilityId: 'image.crop', updatedAt: '2026-01-03T00:00:00.000Z' }),
      t2: taskOf('t2', { status: 'failed', capabilityId: 'image.crop', updatedAt: '2026-01-02T00:00:00.000Z' }),
      t3: taskOf('t3', { status: 'running', capabilityId: 'image.crop', updatedAt: '2026-01-04T00:00:00.000Z' }),
      t4: taskOf('t4', { status: 'timeout', capabilityId: 'image.crop', updatedAt: '2026-01-01T00:00:00.000Z' }),
      t5: taskOf('t5', { status: 'succeeded', capabilityId: 'other.cap', updatedAt: '2026-01-05T00:00:00.000Z' }),
    },
  });
  const calls = recentCalls(st, 'image.crop', 3);
  assert.deepEqual(calls.map((t) => t.id), ['t1', 't2', 't4']);
  assert.equal(recentCalls(st, 'image.crop', 10).length, 3);
});

test('onlineNodes：过滤离线/隐身/已断开节点', () => {
  const st = fakeState({
    nodes: {
      n1: nodeOf('n1'),
      n2: nodeOf('n2', { hidden: true }),
      n3: nodeOf('n3', { disconnected: true }),
      n4: nodeOf('n4', { online: false }),
    },
  });
  assert.deepEqual(onlineNodes(st).map((n) => n.id), ['n1']);
});

test('impact：确定/可能/未知三级都有数据，句子与 note 正确', () => {
  const st = fakeState({
    nodes: { n1: nodeOf('n1', { capabilities: [{ id: 'printer.mock', name: '打印' }] }) },
    tasks: {
      t1: taskOf('t1', { status: 'pending', evidenceLevel: 'certain' }),
      t2: taskOf('t2', { status: 'succeeded', evidenceLevel: 'certain' }),
      t3: taskOf('t3', { status: 'cancelled', evidenceLevel: 'certain' }),
    },
  });
  const im = impact(st, 'n1');
  assert.deepEqual(im.counts, { certain: 1, possible: 1, unknown: 1 });
  assert.deepEqual(im.certain, ['t1']);
  assert.deepEqual(im.possible, ['t2']);
  assert.deepEqual(im.unknown, ['t3']);
  assert.equal(im.sentence, '确定 1 条、可能 1 条、未知 1 条');
  assert.match(im.note, /没有记录不等于没有引用/);
  assert.equal(im.deviceName, '设备-n1');
});

test('impact：声明式设备（declared）即使证据档位 certain 也只进「可能」', () => {
  const st = fakeState({
    nodes: { d1: nodeOf('d1', { evidence: 'declared' }) },
    tasks: { t1: taskOf('t1', { status: 'pending', nodeId: 'd1', evidenceLevel: 'certain' }) },
  });
  const im = impact(st, 'd1');
  assert.deepEqual(im.counts, { certain: 0, possible: 1, unknown: 0 });
  assert.deepEqual(im.possible, ['t1']);
});

test('impact：没有任何引用的设备 → 未知 1 条（仅可人工确认）', () => {
  const st = fakeState({ nodes: { n9: nodeOf('n9') } });
  const im = impact(st, 'n9');
  assert.deepEqual(im.counts, { certain: 0, possible: 0, unknown: 1 });
  assert.match(im.unknown[0], /仅可人工确认/);
  assert.equal(im.sentence, '确定 0 条、可能 0 条、未知 1 条');
});

test('snapshot：任务按 createdAt 倒序、消息/体检倒序、impacts 取最近 5 条、extra 透传', () => {
  const st = fakeState({
    seq: 42,
    dataAsOf: '2026-01-05T00:00:00.000Z',
    tasks: {
      t1: taskOf('t1', { createdAt: '2026-01-01T00:00:00.000Z' }),
      t2: taskOf('t2', { createdAt: '2026-01-03T00:00:00.000Z' }),
      t3: taskOf('t3', { createdAt: '2026-01-02T00:00:00.000Z' }),
    },
    messages: [{ id: 'm1' }, { id: 'm2' }],
    checkups: [{ id: 'c1' }, { id: 'c2' }],
    impacts: [1, 2, 3, 4, 5, 6].map((n) => ({ n })),
    audit: [{ format: 'csv' }],
    aiUsage: { calls: 1, tokensIn: 2, tokensOut: 3, cached: 0, places: {} },
    meta: { mode: 'solo', domainLabel: '工作室数据域' },
  });
  const snap = snapshot(st, { readOnly: true, version: '0.1.0' });
  assert.deepEqual(snap.tasks.map((t) => t.id), ['t2', 't3', 't1']);
  assert.deepEqual(snap.messages.map((m) => m.id), ['m2', 'm1']);
  assert.deepEqual(snap.checkups.map((c) => c.id), ['c2', 'c1']);
  assert.deepEqual(snap.impacts.map((i) => i.n), [6, 5, 4, 3, 2]);
  assert.equal(snap.seq, 42);
  assert.equal(snap.dataAsOf, '2026-01-05T00:00:00.000Z');
  assert.equal(snap.readOnly, true);
  assert.equal(snap.version, '0.1.0');
  assert.equal(snap.mode, 'solo');
});

test('replay 可重建种子同构状态：节点/任务/消息/体检齐备', () => {
  const list = [
    registeredNode('n1', [CAP('image.crop')]),
    draftedTask('t1'),
    ev('task.queued', { taskId: 't1', nodeId: 'n1' }),
    ev('task.succeeded', { taskId: 't1', result: { summary: '完成', items: [], partial: false } }),
    ev('message.inbox', { messageId: 'm1', taskId: 't1', channel: 'wechat-mock', summary: '完成' }),
    ev('checkup.ran', { checkupId: 'c1', scope: 'all', findings: [], verdict: 'none', checked: 7, summary: '未发现问题，已检查 7 项' }),
  ];
  const s = replay(list);
  assert.equal(Object.keys(s.nodes).length, 1);
  assert.equal(Object.keys(s.tasks).length, 1);
  assert.equal(s.messages.length, 1);
  assert.equal(s.checkups.length, 1);
});