import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  listCapabilities, devicesForDraft, classifyRisk, wouldCycle, taskLink,
  createDraft, confirmTask, rejectTask, cancelTask, retryTask, executeHubTask, deliverReceipt, downgradeTasks,
} from '../../server/lib/tasks.js';
import { createChannels } from '../../server/lib/channels.js';
import { newLedger, liveState, ruleAI, cleanupTempDirs, eventTypes } from './helpers.mjs';

after(cleanupTempDirs);

const CAP = (id, over = {}) => ({
  id, name: id, risk: 'reversible', manualOnly: false, version: '1.0.0', evidence: 'confirmed', ...over,
});

function setup() {
  const ledger = newLedger();
  ledger.append('node.registered', {
    nodeId: 'hub', name: '本机中枢', platform: 'windows', fingerprint: 'fp-hub', capabilities: [
      CAP('channel.notify', { risk: 'irreversible' }), CAP('llm.summarize'),
    ],
  });
  ledger.append('node.registered', {
    nodeId: 'node-local', name: '本机工作台', platform: 'windows', fingerprint: 'fp-local', capabilities: [
      CAP('image.crop'), CAP('file.delete', { risk: 'irreversible' }), CAP('printer.mock', { risk: 'irreversible' }),
      CAP('video.transcode', { manualOnly: true }),
    ],
  });
  ledger.append('device.imported', {
    nodeId: 'dev-printer', name: '打印服务器', platform: 'printer', fingerprint: 'fp-printer', online: false,
    capabilities: [CAP('printer.mock', { risk: 'irreversible' })],
  });
  ledger.append('device.imported', {
    nodeId: 'dev-nas', name: '群晖 NAS', platform: 'nas', fingerprint: 'fp-nas', domain: 'outside',
    capabilities: [CAP('nas.sync', { authExpiresAt: '2020-01-01T00:00:00.000Z' })],
  });
  const state = liveState(ledger);
  const ai = ruleAI();
  const channels = createChannels({ ledger, state });
  return { ledger, state, ai, channels };
}

/** 模拟 http.js 的编排：可逆动作草案生成后立即排队 */
function queueDraft(ledger, state, taskId) {
  const t = state.tasks[taskId];
  ledger.append('task.queued', {
    taskId, nodeId: t.draft && t.draft.targetDevice ? t.draft.targetDevice.id : null, note: '可逆动作免确认，直接派发',
  });
}

test('listCapabilities：摊平能力并带 nodeId/nodeName/online/evidence', () => {
  const { state } = setup();
  const caps = listCapabilities(state);
  const crop = caps.find((c) => c.id === 'image.crop');
  assert.equal(crop.nodeId, 'node-local');
  assert.equal(crop.nodeName, '本机工作台');
  assert.equal(crop.online, true);
  assert.equal(crop.evidence, 'confirmed');
  assert.ok(caps.some((c) => c.id === 'channel.notify' && c.nodeId === 'hub'));
});

test('listCapabilities：authExpiresAt 过期自动标 authExpired；compatible 归一为 true', () => {
  const { state } = setup();
  const nas = listCapabilities(state).find((c) => c.id === 'nas.sync');
  assert.equal(nas.authExpired, true);
  assert.equal(nas.compatible, true);
});

test('listCapabilities：版本不兼容（compatible=false）在能力视图标出，且不参与草案派发', () => {
  const { ledger, state, ai } = setup();
  ledger.append('capability.versionMismatch', { nodeId: 'hub', capabilityId: 'llm.summarize', required: '2.3', current: '2.1' });
  const llm = listCapabilities(state).find((c) => c.id === 'llm.summarize');
  assert.equal(llm.compatible, false);
  assert.equal(llm.required, '2.3');
  assert.equal(llm.current, '2.1');
  return createDraft({ ledger, ai, state, text: '总结本周周报' }).then((r) => {
    assert.deepEqual(r.draft.capabilities, []);
    assert.ok(r.draft.missing.some((m) => m.includes('能力未匹配')));
  });
});

test('listCapabilities：断开的设备不进入能力视图', () => {
  const { ledger, state } = setup();
  ledger.append('device.disconnected', { nodeId: 'dev-printer' });
  const caps = listCapabilities(state);
  assert.ok(!caps.some((c) => c.nodeId === 'dev-printer'));
});

test('devicesForDraft：过滤隐身与断开，保留离线设备', () => {
  const { ledger, state } = setup();
  assert.ok(devicesForDraft(state).some((n) => n.id === 'dev-printer'));
  ledger.append('device.hidden', { nodeId: 'dev-printer', hidden: true });
  ledger.append('device.disconnected', { nodeId: 'dev-nas' });
  const left = devicesForDraft(state).map((n) => n.id);
  assert.ok(!left.includes('dev-printer'));
  assert.ok(!left.includes('dev-nas'));
  assert.ok(left.includes('node-local'));
});

test('classifyRisk：不可逆能力 / 危险动词 / 纯可逆三种结果', () => {
  const { state } = setup();
  assert.equal(classifyRisk(state, 'printer.mock', '打印合同').level, 'irreversible');
  assert.equal(classifyRisk(state, 'image.crop', '裁图后发送到群里').level, 'irreversible');
  const rev = classifyRisk(state, 'image.crop', '把样品图裁成方图');
  assert.equal(rev.level, 'reversible');
  assert.deepEqual(rev.reasons, []);
  assert.ok(classifyRisk(state, 'printer.mock', '打印').reasons.length >= 1);
});

test('wouldCycle：检测 A→B→A 与 A→B→C→A，无环返回 false', () => {
  assert.equal(wouldCycle([['A', 'B']], 'B', 'A'), true);
  assert.equal(wouldCycle([['A', 'B'], ['B', 'C']], 'C', 'A'), true);
  assert.equal(wouldCycle([['A', 'B'], ['B', 'C']], 'A', 'C'), false);
  assert.equal(wouldCycle([], 'X', 'Y'), false);
  assert.equal(wouldCycle([['A', 'A']], 'A', 'A'), true);
});

test('taskLink：回执链接指向 /r/<taskId>', () => {
  assert.equal(taskLink('seed_task_01'), '/r/seed_task_01');
});

test('createDraft：可逆动作生成草案（不自动排队，由服务端编排），带 AI 记录', async () => {
  const { ledger, state, ai } = setup();
  const before = ledger.events.length;
  const r = await createDraft({ ledger, ai, state, text: '把样品图裁成方图 1024', source: 'desktop' });
  assert.equal(r.needsConfirm, false);
  assert.equal(r.blocked, false);
  assert.equal(r.manualOnly, false);
  const t = state.tasks[r.taskId];
  assert.equal(t.status, 'draft');
  assert.equal(t.nodeId, 'node-local');
  assert.equal(t.risk.level, 'reversible');
  assert.deepEqual(eventTypes(ledger).slice(before), ['task.drafted', 'ai.called']);
});

test('createDraft：不可逆动作停在 pending，等待逐次确认', async () => {
  const { ledger, state, ai } = setup();
  const r = await createDraft({ ledger, ai, state, text: '打印三份合同', source: 'phone' });
  assert.equal(r.needsConfirm, true);
  assert.equal(state.tasks[r.taskId].status, 'pending');
  const drafted = ledger.events.find((e) => e.type === 'task.drafted' && e.data.taskId === r.taskId);
  assert.equal(drafted.actor, 'phone');
  assert.equal(drafted.data.source, 'phone');
});

test('createDraft：缺参数 → blocked，保持草案状态', async () => {
  const { ledger, state, ai } = setup();
  const r = await createDraft({ ledger, ai, state, text: '裁图' });
  assert.equal(r.blocked, true);
  assert.ok(r.draft.missing.some((m) => m.includes('输出尺寸')));
  assert.equal(state.tasks[r.taskId].status, 'draft');
});

test('createDraft：仅手动能力 → 不派发，追加「仅手动」步骤', async () => {
  const { ledger, state, ai } = setup();
  const r = await createDraft({ ledger, ai, state, text: '把演示视频转码成 1080p' });
  assert.equal(r.manualOnly, true);
  assert.equal(r.needsConfirm, false);
  assert.equal(state.tasks[r.taskId].status, 'draft');
  const t = state.tasks[r.taskId];
  assert.ok(t.steps.some((s) => s.label === '仅手动'));
  assert.equal(t.manualOnly, true);
});

test('confirmTask：pending → 已确认 + 排队；并保留 nodeId', async () => {
  const { ledger, state, ai } = setup();
  const r = await createDraft({ ledger, ai, state, text: '打印三份合同' });
  const t = confirmTask({ ledger, state, taskId: r.taskId, note: '确认执行不可逆动作' });
  assert.equal(t.status, 'queued');
  assert.ok(t.steps.some((s) => s.label === '已确认'));
  assert.ok(t.steps.some((s) => s.label === '已排队'));
  assert.equal(t.nodeId, 'node-local');
});

test('confirmTask：不存在的任务 / 状态不对 抛错', async () => {
  const { ledger, state, ai } = setup();
  assert.throws(() => confirmTask({ ledger, state, taskId: 'nope' }), /任务不存在/);
  const r = await createDraft({ ledger, ai, state, text: '打印三份合同' });
  confirmTask({ ledger, state, taskId: r.taskId });
  assert.equal(state.tasks[r.taskId].status, 'queued');
  assert.throws(() => confirmTask({ ledger, state, taskId: r.taskId }), /不在待确认状态/);
});

test('rejectTask：拒绝留痕，原因默认为「未填写」', async () => {
  const { ledger, state, ai } = setup();
  const r1 = await createDraft({ ledger, ai, state, text: '打印三份合同' });
  rejectTask({ ledger, taskId: r1.taskId });
  assert.equal(state.tasks[r1.taskId].status, 'cancelled');
  assert.equal(state.tasks[r1.taskId].rejectReason, '未填写');
  const r2 = await createDraft({ ledger, ai, state, text: '打印两份合同' });
  rejectTask({ ledger, taskId: r2.taskId, reason: '合同还没盖章' });
  assert.equal(state.tasks[r2.taskId].rejectReason, '合同还没盖章');
});

test('cancelTask：取消记录已完成步骤数', async () => {
  const { ledger, state, ai } = setup();
  const r = await createDraft({ ledger, ai, state, text: '把样品图裁成方图 1024' });
  cancelTask({ ledger, state, taskId: r.taskId });
  assert.equal(state.tasks[r.taskId].status, 'cancelled');
  assert.ok(state.tasks[r.taskId].steps.some((s) => s.label === '已取消'));
});

test('retryTask：失败任务重试 → queued 且 retries+1', async () => {
  const { ledger, state, ai } = setup();
  const r = await createDraft({ ledger, ai, state, text: '把样品图裁成方图 1024' });
  queueDraft(ledger, state, r.taskId);
  ledger.append('task.failed', { taskId: r.taskId, error: '文件损坏' });
  assert.equal(state.tasks[r.taskId].status, 'failed');
  retryTask({ ledger, state, taskId: r.taskId });
  assert.equal(state.tasks[r.taskId].status, 'queued');
  assert.equal(state.tasks[r.taskId].retries, 1);
});

test('downgradeTasks：只降级目标设备的在途任务为待确认，终态任务不受影响', async () => {
  const { ledger, state, ai } = setup();
  const r1 = await createDraft({ ledger, ai, state, text: '把样品图裁成方图 1024' });
  queueDraft(ledger, state, r1.taskId);
  const r2 = await createDraft({ ledger, ai, state, text: '把样品图裁成方图 512' });
  queueDraft(ledger, state, r2.taskId);
  ledger.append('task.succeeded', { taskId: r2.taskId, result: { summary: '完成', items: [], partial: false } });
  const affected = downgradeTasks({ ledger, state, deviceId: 'node-local', reason: '设备已断开' });
  assert.deepEqual(affected, [r1.taskId]);
  assert.equal(state.tasks[r1.taskId].status, 'pending');
  assert.equal(state.tasks[r1.taskId].needsReview, true);
  assert.ok(state.tasks[r1.taskId].steps.some((s) => s.label.startsWith('待确认')));
  assert.equal(state.tasks[r2.taskId].status, 'succeeded');
});

test('executeHubTask：llm.summarize 在中枢执行成功；重复调用不重复执行（幂等）', async () => {
  const { ledger, state, ai, channels } = setup();
  const r = await createDraft({ ledger, ai, state, text: '总结本周周报' });
  queueDraft(ledger, state, r.taskId);
  assert.equal(state.tasks[r.taskId].status, 'queued');
  const ok = await executeHubTask({ ledger, state, ai, channels, taskId: r.taskId });
  assert.equal(ok, true);
  const t = state.tasks[r.taskId];
  assert.equal(t.status, 'succeeded');
  assert.match(t.result.summary, /离线摘要/);
  assert.ok(t.steps.some((s) => s.label === '调用模型'));
  const afterFirst = ledger.events.length;
  const okAgain = await executeHubTask({ ledger, state, ai, channels, taskId: r.taskId });
  assert.equal(okAgain, false);
  assert.equal(ledger.events.length, afterFirst, '重复拉取不得追加事件');
});

test('executeHubTask：channel.notify 成功后写入 message.inbox', async () => {
  const { ledger, state, ai, channels } = setup();
  const r = await createDraft({ ledger, ai, state, text: '把交付链接发到工作群' });
  confirmTask({ ledger, state, taskId: r.taskId });
  const ok = await executeHubTask({ ledger, state, ai, channels, taskId: r.taskId });
  assert.equal(ok, true);
  const t = state.tasks[r.taskId];
  assert.equal(t.status, 'succeeded');
  assert.equal(t.result.items.length, 3);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].channel, 'wechat-mock');
  assert.equal(state.messages[0].sensitive, true);
});

test('executeHubTask：非中枢能力返回 false，不改状态', async () => {
  const { ledger, state, ai, channels } = setup();
  const r = await createDraft({ ledger, ai, state, text: '把样品图裁成方图 1024' });
  queueDraft(ledger, state, r.taskId);
  const ok = await executeHubTask({ ledger, state, ai, channels, taskId: r.taskId });
  assert.equal(ok, false);
  assert.equal(state.tasks[r.taskId].status, 'queued');
});

test('deliverReceipt：终态任务回传一次并写 inbox，重复调用不重复回传', async () => {
  const { ledger, state, ai, channels } = setup();
  const r = await createDraft({ ledger, ai, state, text: '把样品图裁成方图 1024' });
  queueDraft(ledger, state, r.taskId);
  ledger.append('task.succeeded', { taskId: r.taskId, result: { summary: '9 张成功，1 张失败：文件损坏', items: [], partial: true } });
  const messagesBefore = state.messages.length;
  await deliverReceipt({ ledger, state, channels, taskId: r.taskId });
  assert.equal(state.messages.length, messagesBefore + 1);
  assert.ok(state.tasks[r.taskId].delivery);
  const eventCount = ledger.events.length;
  await deliverReceipt({ ledger, state, channels, taskId: r.taskId });
  assert.equal(ledger.events.length, eventCount, '已有回执时不得重复回传');
});

test('deliverReceipt：非终态任务不回传', async () => {
  const { ledger, state, ai, channels } = setup();
  const r = await createDraft({ ledger, ai, state, text: '把样品图裁成方图 1024' });
  const messagesBefore = state.messages.length;
  await deliverReceipt({ ledger, state, channels, taskId: r.taskId });
  assert.equal(state.messages.length, messagesBefore);
  assert.equal(state.tasks[r.taskId].delivery, null);
});