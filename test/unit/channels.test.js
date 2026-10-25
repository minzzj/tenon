import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../../server/lib/channels.js';
import { newLedger, liveState, cleanupTempDirs } from './helpers.mjs';

after(cleanupTempDirs);

function setup() {
  const ledger = newLedger();
  ledger.append('task.drafted', {
    taskId: 'seed_task_05', text: '把交付链接发到工作群',
    draft: { summary: 's', capabilities: [], targetDevice: null, missing: [], risk: { level: 'reversible', reasons: [] }, params: {} },
    evidenceLevel: 'certain',
  });
  const state = liveState(ledger);
  const channels = createChannels({ ledger, state });
  return { ledger, state, channels };
}

const payload = (over = {}) => ({ summary: '任务完成', link: '/r/t1', sensitive: true, ...over });

test('deliver：正常送达微信模拟通道 → deliveryAttempt + message.inbox + task.delivered', async () => {
  const { ledger, state, channels } = setup();
  const r = await channels.deliver('seed_task_05', payload({ summary: '已归档 128 个文件' }));
  assert.equal(r.channel, 'wechat-mock');
  assert.equal(r.degraded, false);
  const types = ledger.events.map((e) => e.type);
  assert.ok(types.includes('task.deliveryAttempt'));
  assert.ok(types.includes('message.inbox'));
  assert.ok(types.includes('task.delivered'));
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].title, '任务回执');
  assert.equal(state.messages[0].channelLabel, '微信（模拟通道）');
  assert.equal(state.tasks.seed_task_05.delivery.status, 'delivered');
  assert.equal(state.tasks.seed_task_05.delivery.channel, 'wechat-mock');
});

test('deliver：forceLimit 触发限流 → 排队重试后降级邮件（degraded + 用户可见文案）', async () => {
  const { ledger, channels } = setup();
  channels.forceLimit(3);
  assert.equal(channels.recent(), 3);
  const r = await channels.deliver('seed_task_05', payload());
  assert.equal(r.channel, 'email-mock');
  assert.equal(r.degraded, true);
  assert.match(r.note, /微信限流，已改邮件，延迟约 10 分钟/);
  const attempts = ledger.events.filter((e) => e.type === 'task.deliveryAttempt').map((e) => e.data);
  assert.ok(attempts.some((a) => a.status === 'limited'));
  assert.ok(attempts.some((a) => a.status === 'fallback'));
  assert.ok(attempts.some((a) => a.channel === 'email-mock' && a.status === 'delivered'));
  assert.ok(ledger.events.some((e) => e.type === 'channel.retry'));
  const inbox = ledger.events.find((e) => e.type === 'message.inbox').data;
  assert.equal(inbox.title, '任务回执（已降级）');
  const delivered = ledger.events.find((e) => e.type === 'task.delivered').data;
  assert.equal(delivered.status, 'degraded');
  assert.match(delivered.note, /限流/);
});

test('deliver：连续 3 条微信后第 4 条自动限流并降级邮件', async () => {
  const { ledger, channels } = setup();
  const results = [];
  for (let i = 1; i <= 4; i += 1) {
    results.push(await channels.deliver('seed_task_05', payload({ summary: '第 ' + i + ' 条' })));
  }
  assert.deepEqual(results.slice(0, 3).map((r) => r.channel), ['wechat-mock', 'wechat-mock', 'wechat-mock']);
  assert.equal(results[3].channel, 'email-mock');
  assert.equal(results[3].degraded, true);
  assert.equal(channels.recent(), 3, '限流后不应把降级邮件计为微信发送');
  assert.equal(ledger.events.filter((e) => e.type === 'message.inbox').length, 4);
});

test('deliver：通道不可用 → 记 unavailable 并换下一通道', async () => {
  const { ledger, channels } = setup();
  channels.disable('wechat-mock', '账号异常');
  const r = await channels.deliver('seed_task_05', payload());
  assert.equal(r.channel, 'email-mock');
  assert.equal(r.degraded, true);
  assert.match(r.note, /通道不可用：账号异常/);
  const unavailable = ledger.events.filter((e) => e.type === 'task.deliveryAttempt' && e.data.status === 'unavailable');
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].data.channel, 'wechat-mock');
});

test('deliver：微信+邮件都不可用 → 降级站内', async () => {
  const { ledger, channels } = setup();
  channels.disable('wechat-mock', '账号异常');
  channels.disable('email-mock', 'SMTP 未配置');
  const r = await channels.deliver('seed_task_05', payload());
  assert.equal(r.channel, 'station');
  assert.equal(r.degraded, true);
  const inbox = ledger.events.find((e) => e.type === 'message.inbox').data;
  assert.equal(inbox.channel, 'station');
  assert.equal(inbox.channelLabel, '站内');
});

test('deliver：所有通道不可用 → 未送达留痕（task.undelivered）', async () => {
  const { ledger, channels } = setup();
  for (const ch of ['wechat-mock', 'email-mock', 'station']) channels.disable(ch, '不可用');
  const r = await channels.deliver('seed_task_05', payload());
  assert.equal(r, null);
  const undelivered = ledger.events.find((e) => e.type === 'task.undelivered');
  assert.ok(undelivered);
  assert.equal(undelivered.data.summary, '任务完成');
  assert.ok(ledger.events.some((e) => e.type === 'task.deliveryAttempt' && e.data.status === 'failed'));
  assert.ok(!ledger.events.some((e) => e.type === 'task.delivered'));
});

test('enable：停用后可恢复通道', async () => {
  const { channels } = setup();
  channels.disable('wechat-mock', '账号异常');
  channels.enable('wechat-mock');
  const r = await channels.deliver('seed_task_05', payload());
  assert.equal(r.channel, 'wechat-mock');
  assert.equal(r.degraded, false);
});

test('recent：初始 0，发送真实微信后 +1，forceLimit 可控', async () => {
  const { channels } = setup();
  assert.equal(channels.recent(), 0);
  await channels.deliver('seed_task_05', payload());
  assert.equal(channels.recent(), 1);
  channels.forceLimit(5);
  assert.equal(channels.recent(), 6);
});

test('labels：三通道中文标签齐备', () => {
  const { channels } = setup();
  assert.deepEqual(channels.labels, {
    'wechat-mock': '微信（模拟通道）', 'email-mock': '邮件（模拟通道）', station: '站内',
  });
});

test('deliver：摘要截断到 200 字，link 与 sensitive 原样保留', async () => {
  const { ledger, state, channels } = setup();
  const long = '很长的摘要内容'.repeat(60);
  await channels.deliver('seed_task_05', payload({ summary: long, link: '/r/seed_task_05' }));
  assert.ok(state.messages[0].summary.length <= 200);
  assert.equal(state.messages[0].link, '/r/seed_task_05');
  assert.equal(state.messages[0].sensitive, true);
  const delivered = ledger.events.find((e) => e.type === 'task.delivered').data;
  assert.ok(delivered.summary.length <= 200);
});