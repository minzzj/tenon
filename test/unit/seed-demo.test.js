import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ledger, hashOf } from '../../server/lib/ledger.js';
import { replay, relations, impact } from '../../server/lib/state.js';
import { cleanupTempDirs, tempDir, withFrozenTime } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEED = path.join(ROOT, 'scripts', 'seed-demo.js');
const GENESIS = '0'.repeat(64);

function seedInto(dir, withFresh = true) {
  const args = [SEED, ...(withFresh ? ['--fresh'] : []), '--data-dir', dir];
  return execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
}

// 只跑一次种子（验收口径的主数据），各用例共用
const baseDir = tempDir('tenon-seed-');
seedInto(baseDir);
const baseLedger = new Ledger(baseDir);
const baseState = replay(baseLedger.events);
const summary = JSON.parse(fs.readFileSync(path.join(baseDir, 'seed-summary.json'), 'utf8'));
after(cleanupTempDirs);

const EXPECTED_TASKS = {
  seed_task_01: 'succeeded',
  seed_task_02: 'pending',
  seed_task_03: 'succeeded',
  seed_task_04: 'failed',
  seed_task_05: 'succeeded',
  seed_task_06: 'draft',
  seed_task_07: 'pending',
  seed_task_08: 'pending',
  seed_task_09: 'draft',
  seed_task_10: 'succeeded',
  seed_task_11: 'cancelled',
};

test('seed-demo：--fresh 成功，写出 events.jsonl 与 seed-summary.json', () => {
  assert.ok(fs.existsSync(path.join(baseDir, 'events.jsonl')));
  assert.ok(fs.existsSync(path.join(baseDir, 'seed-summary.json')));
  assert.ok(baseLedger.events.length >= 60);
  assert.equal(baseLedger.integrity().ok, true);
  assert.equal(baseLedger.integrity().gaps.length, 0);
  assert.equal(summary.events, baseLedger.events.length);
});

test('seed-demo：事件哈希链自洽（prev/hash 可复算、序号连续）', () => {
  // 注意：state.replay 目前会直接改写事件 data 里的 capabilities 引用（capability.* 事件就地标记），
  // 因此这里必须用「刚从磁盘重新加载、尚未 replay」的账本做 hashOf 复算。
  const raw = new Ledger(baseDir);
  let prev = GENESIS;
  for (const ev of raw.events) {
    assert.equal(ev.prev, prev);
    assert.equal(ev.hash, hashOf(ev));
    prev = ev.hash;
  }
  assert.deepEqual(baseLedger.events.map((e) => e.seq), baseLedger.events.map((_, i) => i + 1));
  assert.equal(baseLedger.integrity().lastSeq, baseLedger.events.length);
});

test('seed-demo：重放确定性（冻结时钟两次 replay 深比较一致）', () => {
  const a = withFrozenTime('2026-06-01T00:00:00.000Z', () => replay(baseLedger.events));
  const b = withFrozenTime('2026-06-01T00:00:00.000Z', () => replay(baseLedger.events));
  assert.deepEqual(a, b);
  assert.equal(a.seq, baseLedger.events.at(-1).seq);
});

test('seed-demo：11 条任务（含为影响预览补的 10/11）与状态全部正确', () => {
  const ids = Object.keys(baseState.tasks).sort();
  assert.deepEqual(ids, Object.keys(EXPECTED_TASKS).sort());
  for (const [id, status] of Object.entries(EXPECTED_TASKS)) {
    assert.equal(baseState.tasks[id].status, status, id);
  }
  assert.equal(summary.taskCount, 11);
});

test('seed-demo：打印服务器被 ②⑦⑧ 三条 pending 任务引用，影响预览 确定3/可能1/未知1', () => {
  const pendingRefs = relations(baseState)
    .filter((r) => r.nodeId === 'dev-printer' && r.task.status === 'pending')
    .map((r) => r.taskId)
    .sort();
  assert.deepEqual(pendingRefs, ['seed_task_02', 'seed_task_07', 'seed_task_08']);
  const im = impact(baseState, 'dev-printer');
  assert.deepEqual(im.counts, { certain: 3, possible: 1, unknown: 1 });
  assert.equal(im.sentence, '确定 3 条、可能 1 条、未知 1 条');
  assert.deepEqual(im.certain.sort(), ['seed_task_02', 'seed_task_07', 'seed_task_08']);
  assert.deepEqual(im.possible, ['seed_task_10']);
  assert.deepEqual(im.unknown, ['seed_task_11']);
});

test('seed-demo：仅手动能力（video.transcode manualOnly）登记在 NAS，任务 ⑥ 引用它', () => {
  const nas = baseState.nodes['dev-nas'];
  const cap = nas.capabilities.find((c) => c.id === 'video.transcode');
  assert.ok(cap, 'NAS 应登记 video.transcode');
  assert.equal(cap.manualOnly, true);
  assert.equal(baseState.tasks.seed_task_06.nodeId, 'dev-nas');
  assert.equal(baseState.tasks.seed_task_06.manualOnly, true);
  assert.equal(baseState.tasks.seed_task_06.status, 'draft');
  const local = impact(baseState, 'node-local');
  assert.equal(local.counts.possible, 1);
  assert.deepEqual(local.possible, ['seed_task_01']);
  const scanner = impact(baseState, 'node-scanner');
  assert.deepEqual(scanner.counts, { certain: 0, possible: 0, unknown: 1 });
  assert.match(scanner.unknown[0], /仅可人工确认/);
});

test('seed-demo：2 份体检（channels 无发现 / all 有发现），文案符合契约', () => {
  assert.equal(baseState.checkups.length, 2);
  const none = baseState.checkups.find((c) => c.verdict === 'none');
  const findings = baseState.checkups.find((c) => c.verdict === 'findings');
  assert.equal(none.scope, 'channels');
  assert.deepEqual(none.findings, []);
  assert.match(none.summary, /^未发现问题，已检查 \d+ 项$/);
  assert.equal(findings.scope, 'all');
  assert.ok(findings.findings.length >= 5);
  const titles = findings.findings.map((f) => f.title).join('|');
  assert.match(titles, /设备离线：打印服务器/);
  assert.match(titles, /版本不兼容：本地模型/);
  assert.match(titles, /授权已过期：群晖 NAS/);
  assert.match(titles, /授权将在 3 天后到期/);
});

test('seed-demo：channels 空结果体检发生在限流记录之前（真实 runCheckup 产物）', () => {
  const checkupIndex = baseLedger.events.findIndex((e) => e.type === 'checkup.ran' && e.data.scope === 'channels');
  const limitedIndex = baseLedger.events.findIndex((e) => e.type === 'task.deliveryAttempt' && e.data.status === 'limited');
  assert.ok(checkupIndex >= 0 && limitedIndex >= 0);
  assert.ok(checkupIndex < limitedIndex, '干净通道体检必须在限流事件之前');
});

test('seed-demo：2 条 inbox 消息、2 条审计导出、1 条 ai.called（rule provider）', () => {
  assert.equal(baseState.messages.length, 2);
  assert.deepEqual(baseState.messages.map((m) => m.taskId).sort(), ['seed_task_03', 'seed_task_05']);
  assert.deepEqual(baseState.messages.map((m) => m.channel).sort(), ['email-mock', 'wechat-mock']);
  assert.equal(baseState.audit.length, 2);
  assert.equal(baseState.aiUsage.calls, 1);
  const aiCall = baseLedger.events.find((e) => e.type === 'ai.called');
  assert.equal(aiCall.data.provider, 'rule');
});

test('seed-demo：设备证据/授权/版本三项事实正确', () => {
  assert.equal(baseState.nodes['node-local'].name, '工作台');
  assert.equal(baseState.nodes['hub'].name, '本机中枢');
  const printer = baseState.nodes['dev-printer'];
  assert.equal(printer.evidence, 'confirmed');
  assert.equal(printer.online, false);
  assert.ok(printer.capabilities.some((c) => c.id === 'printer.mock' && c.risk === 'irreversible'));
  const nas = baseState.nodes['dev-nas'];
  assert.equal(nas.evidence, 'declared');
  assert.equal(nas.domain, 'outside');
  assert.ok(nas.capabilities[0].authExpiresAt && Date.parse(nas.capabilities[0].authExpiresAt) < Date.now());
  const llm = baseState.nodes['dev-llm'];
  assert.equal(llm.evidence, 'declared');
  const llmCap = llm.capabilities.find((c) => c.id === 'llm.summarize');
  assert.equal(llmCap.compatible, false);
  assert.equal(llmCap.required, '2.3');
  assert.equal(llmCap.current, '2.1');
  assert.equal(baseState.nodes['node-scanner'].online, false);
});

test('seed-demo：任务 ⑨ 的 createdAt 早于 90 天（三个月未触发）', () => {
  const created = Date.parse(baseState.tasks.seed_task_09.createdAt);
  assert.ok(created < Date.now() - 90 * 86400000, '定时任务创建时间应早于 90 天');
});

test('seed-demo：任务 ③ 降级回传邮件、⑤ 微信回传、⑩ 未送达、⑪ 已取消', () => {
  const t3 = baseState.tasks.seed_task_03;
  assert.equal(t3.delivery.channel, 'email-mock');
  assert.equal(t3.delivery.status, 'degraded');
  assert.ok(t3.deliveryAttempts.some((a) => a.status === 'limited'));
  const t5 = baseState.tasks.seed_task_05;
  assert.equal(t5.delivery.channel, 'wechat-mock');
  assert.equal(t5.delivery.status, 'delivered');
  assert.equal(baseState.tasks.seed_task_10.delivery.status, 'undelivered');
  assert.equal(baseState.tasks.seed_task_11.status, 'cancelled');
});

test('seed-demo：任务 ① 事件顺序 草案→排队→执行→步骤→部分成功', () => {
  const types = baseLedger.events.filter((e) => e.data && e.data.taskId === 'seed_task_01').map((e) => e.type);
  const iDraft = types.indexOf('task.drafted');
  const iQueued = types.indexOf('task.queued');
  const iStarted = types.indexOf('task.started');
  const iStep = types.indexOf('task.step');
  const iDone = types.indexOf('task.succeeded');
  assert.ok(iDraft === 0 && iDraft < iQueued && iQueued < iStarted && iStarted < iStep && iStep < iDone, types.join(','));
  const result = baseState.tasks.seed_task_01.result;
  assert.equal(result.summary, '9 张成功，1 张失败：文件损坏');
  assert.equal(result.partial, true);
  assert.equal(result.items.filter((x) => x.ok).length, 9);
  assert.equal(result.items.filter((x) => !x.ok).length, 1);
});

test('seed-demo：--fresh 只清 data 目录内容，不碰同级文件', () => {
  const parent = tempDir('tenon-seed-parent-');
  const dataDir = path.join(parent, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'junk.txt'), 'old');
  const sibling = path.join(parent, 'keep.txt');
  fs.writeFileSync(sibling, 'keep');
  seedInto(dataDir);
  assert.ok(!fs.existsSync(path.join(dataDir, 'junk.txt')), 'data 内旧文件应被清空');
  assert.ok(fs.existsSync(sibling), 'data 同级文件不应被删除');
  assert.ok(fs.existsSync(path.join(dataDir, 'events.jsonl')));
  const again = new Ledger(dataDir);
  assert.equal(again.integrity().ok, true);
  assert.equal(again.events.length, baseLedger.events.length);
});

test('seed-demo：已有账本且未加 --fresh → 退出码 3 并拒绝覆盖', () => {
  let error = null;
  try {
    seedInto(baseDir, false);
  } catch (err) {
    error = err;
  }
  assert.ok(error, '应当以非零退出码失败');
  assert.equal(error.status, 3);
  assert.match(String(error.stderr || ''), /已存在事件账本/);
});

test('seed-demo：可重复生成，两次 --fresh 的事件类型序列一致（确定性）', () => {
  const dir2 = tempDir('tenon-seed-repeat-');
  seedInto(dir2);
  const ledger2 = new Ledger(dir2);
  assert.equal(ledger2.events.length, baseLedger.events.length);
  assert.deepEqual(ledger2.events.map((e) => e.type), baseLedger.events.map((e) => e.type));
  const state2 = replay(ledger2.events);
  assert.deepEqual(
    Object.fromEntries(Object.entries(state2.tasks).map(([id, t]) => [id, t.status])),
    Object.fromEntries(Object.entries(baseState.tasks).map(([id, t]) => [id, t.status])),
  );
});