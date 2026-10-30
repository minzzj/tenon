// 榫卯 v2-P0 桌面端 Agent 单测（node:test）
// 覆盖：hub 客户端 / 剪贴板真实 PowerShell 双向 / 文件扫描入库 / 受控动作（含禁用与演练）/
//       文件收发（分块出站、入站落盘 sha256 校验 ack、防重复）/ v2 agent 注册与派发 / SSE 通知镜像
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStubHub, sha256 } from './stub-hub.mjs';
import { HubClient, loadSecrets } from '../hub.js';
import { readClipboardText, writeClipboardText, classifyKind, createClipboardSync } from '../clipboard.js';
import { scanDirectory, ingestFiles, openPath, formatBytes } from '../files.js';
import { actionCapabilities, actionsManifest, findAction } from '../actions.js';
import { createLinkService } from '../link.js';
import { createNotifier, sendWindowsNotification } from '../notifier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(HERE, '..');
const WIN = process.platform === 'win32';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-agent-test-'));
const AGENT_DATA = path.join(TMP, 'agent-data');
fs.mkdirSync(AGENT_DATA, { recursive: true });
fs.writeFileSync(
  path.join(AGENT_DATA, 'secrets.json'),
  JSON.stringify({ operatorToken: 'operator-token-test', nodeToken: 'node-token-test' }, null, 2),
);
process.env.TENON_DATA_DIR = AGENT_DATA;
process.env.TENON_HUB_URL = 'http://127.0.0.1:1'; // 占位；测试里用 options.hubUrl 指向 stub
const agentMod = await import('../agent.js');

let hub;
let hubUrl;
let originalClipboard = null;
before(async () => {
  hub = await startStubHub();
  hubUrl = hub.url;
  if (WIN) {
    const current = await readClipboardText();
    if (current.ok) originalClipboard = current.text || '';
  }
});
after(async () => {
  if (WIN && originalClipboard !== null) {
    try {
      await writeClipboardText(originalClipboard);
    } catch {
      /* ignore */
    }
  }
  if (hub) await hub.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return true;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}`);
}
// Windows 剪贴板在并发占用时偶发 transient 失败（CLIPBRD_E_CANT_OPEN 等），测试层重试几次更稳
async function writeClipboardRetry(text, attempts = 5) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await writeClipboardText(text);
    if (last.ok) return last;
    await sleep(350);
  }
  return last;
}
async function readClipboardRetry(attempts = 5) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await readClipboardText();
    if (last.ok) return last;
    await sleep(250);
  }
  return last;
}
function makeHubClient(extra = {}) {
  return new HubClient({ baseUrl: hubUrl, nodeToken: 'node-token-test', operatorToken: 'operator-token-test', timeoutMs: 6000, ...extra });
}

// ---------- hub 客户端 ----------
test('loadSecrets：从 secrets.json 读双令牌，环境变量可覆盖', () => {
  const secrets = loadSecrets(path.join(AGENT_DATA, 'secrets.json'), {});
  assert.equal(secrets.nodeToken, 'node-token-test');
  assert.equal(secrets.operatorToken, 'operator-token-test');
  const overridden = loadSecrets(path.join(AGENT_DATA, 'secrets.json'), { TENON_OPERATOR_TOKEN: 'env-op' });
  assert.equal(overridden.operatorToken, 'env-op');
  const missing = loadSecrets(path.join(TMP, 'nope.json'), {});
  assert.equal(missing.nodeToken, '');
});

test('HubClient：v2 接口带 x-tenon-token，节点接口带 x-tenon-node', async () => {
  const client = makeHubClient();
  assert.equal(client.ready, true);
  const payload = await client.postJson('/api/v2/link/clipboard', { kind: 'text', text: 'hi', from: 'node-local' });
  assert.equal(payload.ok, true);
  const last = hub.state.requests[hub.state.requests.length - 1];
  assert.equal(last.token, 'operator-token-test');
  assert.equal(last.node, 'node-token-test');
  const nodePayload = await client.request('/api/node/heartbeat', { method: 'POST', body: { nodeId: 'node-local' }, auth: 'node' });
  assert.equal(nodePayload.ok, true);
  await assert.rejects(() => client.getJson('/api/v2/not-exists'), (err) => err.status === 404);
});

// ---------- 剪贴板 ----------
test('剪贴板：链接/文本分类', () => {
  assert.equal(classifyKind('https://example.com/a?b=1'), 'link');
  assert.equal(classifyKind('这是一段普通文本'), 'text');
  assert.equal(classifyKind('  https://tenon.local  '), 'link');
});

test('剪贴板：PowerShell 写→读真实回读（中文/emoji）', { skip: !WIN }, async () => {
  const marker = `榫卯剪贴板自测-中文-abc-${Date.now()} 🧩`;
  const wrote = await writeClipboardRetry(marker);
  assert.equal(wrote.ok, true, `写入失败：${wrote.error || ''}`);
  const read = await readClipboardText();
  assert.equal(read.ok, true, `读取失败：${read.error || ''}`);
  assert.equal(read.text, marker);
});

test('剪贴板：本机变化会上报中枢 v2（防重复上报）', { skip: !WIN }, async () => {
  const client = makeHubClient();
  const sync = createClipboardSync({ hub: client, deviceId: 'node-local', pollMs: 200, log: () => {} });
  const marker = `TENON-LOCAL-${Date.now().toString(36)}`;
  await writeClipboardRetry(marker);
  const before = hub.state.clipboardPosts.length;
  const first = await sync.syncOnce();
  assert.equal(first.ok, true);
  assert.equal(hub.state.clipboardPosts.length, before + 1);
  assert.equal(hub.state.clipboardPosts[hub.state.clipboardPosts.length - 1].text, marker);
  assert.equal(hub.state.clipboardPosts[hub.state.clipboardPosts.length - 1].kind, 'text');
  // 同一内容再同步一次不应重复上报
  await sync.syncOnce();
  assert.equal(hub.state.clipboardPosts.length, before + 1);
});

test('剪贴板：中枢最新（来自手机）→ 写回本机；写回后不回环上报', { skip: !WIN }, async () => {
  const client = makeHubClient();
  const sync = createClipboardSync({ hub: client, deviceId: 'node-local', pollMs: 200, log: () => {} });
  // 先把本机当前内容同步出去（真实时序：手机内容通常在本机上报之后到达）
  await sync.syncOnce();
  const remoteText = `来自手机的剪贴板-${Date.now().toString(36)}`;
  hub.state.clipboard = { at: new Date().toISOString(), from: 'phone-android', kind: 'text', text: remoteText };
  const postsBefore = hub.state.clipboardPosts.length;
  let applied = null;
  for (let i = 0; i < 4; i += 1) {
    applied = await sync.syncOnce();
    if (applied && applied.applied) break;
    await sleep(300);
  }
  assert.equal(applied && applied.applied, true);
  const read = await readClipboardRetry();
  assert.equal(read.text, remoteText);
  // 再同步：内容与中枢一致，不应再次写回，也不应把自己的回写上报出去
  const again = await sync.syncOnce();
  assert.equal(again.applied, false);
  assert.equal(hub.state.clipboardPosts.length, postsBefore);
  assert.equal(sync.status().applied, 1);
});

// ---------- 通知 ----------
test('通知：上报到 /api/v2/link/notification；事件镜像走本机通知（log 兜底）', async () => {
  process.env.TENON_NOTIFY_METHOD = 'log';
  try {
    const notifier = createNotifier({ hub: makeHubClient(), deviceId: 'node-local', log: () => {} });
    const report = await notifier.report({ app: 'com.tencent.mm', title: '微信', text: '你有一条新消息' });
    assert.equal(report.ok, true);
    const recorded = hub.state.notifications[hub.state.notifications.length - 1];
    assert.equal(recorded.from, 'node-local');
    assert.equal(recorded.app, 'com.tencent.mm');
    assert.equal(recorded.title, '微信');
    const mirrored = await notifier.mirrorEvent({ type: 'notification.relayed', data: { app: 'com.tencent.mm', title: '手机通知', preview: '预览内容' } });
    assert.equal(mirrored.ok, true);
    assert.equal(notifier.status.sent, 1);
    assert.equal(notifier.status.last.method, 'log');
    const local = await sendWindowsNotification({ title: '自测通知', body: '不弹窗，仅日志兜底' });
    assert.equal(local.ok, true);
    assert.equal(local.method, 'log');
  } finally {
    delete process.env.TENON_NOTIFY_METHOD;
  }
});

// ---------- 文件扫描 / 入库 ----------
test('files：递归扫描目录、识别类型、忽略隐藏文件', () => {
  const root = path.join(TMP, 'scan');
  fs.mkdirSync(path.join(root, '子目录'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.png'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(root, '子目录', 'b.pdf'), 'pdf');
  fs.writeFileSync(path.join(root, '子目录', 'c.mp4'), 'mp4');
  fs.writeFileSync(path.join(root, '.hidden.txt'), 'hidden');
  fs.writeFileSync(path.join(root, 'd'), 'no-ext');
  const scan = scanDirectory(root);
  assert.equal(scan.truncated, false);
  assert.equal(scan.files.length, 4);
  const byName = Object.fromEntries(scan.files.map((file) => [file.name, file]));
  assert.equal(byName['a.png'].kind, 'image');
  assert.equal(byName['b.pdf'].kind, 'document');
  assert.equal(byName['c.mp4'].kind, 'video');
  assert.equal(byName['d'].kind, 'other');
  assert.ok(byName['a.png'].relPath === 'a.png');
  assert.equal(formatBytes(1536), '1.5 KB');
  const imagesOnly = scanDirectory(root, { extensions: ['.png'] });
  assert.equal(imagesOnly.files.length, 1);
});

test('files：批量入库调用 POST /api/v2/assets/ingest；中枢未就绪时快速失败', async () => {
  const dir = path.join(TMP, 'ingest');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(dir, `f${i}.txt`), `内容 ${i}`);
  const scanned = scanDirectory(dir);
  const client = makeHubClient();
  const before = hub.state.ingests.length;
  const result = await ingestFiles({ hub: client, deviceId: 'node-local', files: scanned.files, log: () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.ingested, 3);
  assert.equal(result.failed, 0);
  assert.equal(hub.state.ingests.length, before + 3);
  assert.equal(hub.state.ingests[hub.state.ingests.length - 1].deviceId, 'node-local');
  assert.ok(path.isAbsolute(hub.state.ingests[hub.state.ingests.length - 1].path));
  // 中枢路由未就绪（stub 不认识的路径 → 404）时快速失败并给可读原因
  const offline = await ingestFiles({
    hub: new HubClient({ baseUrl: hubUrl, operatorToken: 'x' }),
    deviceId: 'node-local',
    files: [{ path: path.join(dir, 'f0.txt') }],
    log: () => {},
  });
  assert.equal(offline.ok, true); // stub 认识该路由，这里应成功
  // 直接用真实未监听端口模拟“中枢未启动”
  const dead = new HubClient({ baseUrl: 'http://127.0.0.1:1', operatorToken: 'x', timeoutMs: 800 });
  const failed = await ingestFiles({ hub: dead, deviceId: 'node-local', files: [{ path: path.join(dir, 'f0.txt') }], log: () => {} });
  assert.equal(failed.ok, false);
  assert.ok(failed.fatal && failed.fatal.reason.includes('不可用'));
});

// ---------- 受控动作 ----------
test('actions：4 个动作 manifest 字段齐全，system.power 默认禁用', () => {
  assert.equal(actionCapabilities.length, 4);
  assert.equal(actionsManifest.length, 4);
  const ids = actionsManifest.map((action) => action.id).sort().join(',');
  assert.equal(ids, 'file.print,system.open,system.power,system.volume');
  for (const action of actionsManifest) {
    for (const key of ['id', 'name', 'risk', 'manualOnly', 'version', 'evidence', 'inputs', 'outputs']) {
      assert.ok(key in action, `${action.id} 缺字段 ${key}`);
    }
  }
  assert.equal(findAction('system.power').risk, 'irreversible');
  assert.equal(findAction('system.power').manualOnly, true);
  assert.ok(findAction('system.power').name.includes('默认禁用'));
  assert.equal(findAction('file.print').risk, 'irreversible');
});

test('actions：system.power 默认禁用（双闸）；演练模式可验证下发链路', async () => {
  const ctx = { repoRoot: AGENT_DIR, dataDir: path.join(TMP, 'actions-data'), nodeId: 'node-local', nodeName: '自测节点' };
  const power = findAction('system.power');
  delete process.env.TENON_ALLOW_POWER;
  await assert.rejects(() => power.run({ params: { action: 'shutdown', confirm: true } }, ctx), /默认禁用/);
  process.env.TENON_ALLOW_POWER = '1';
  process.env.TENON_POWER_DRYRUN = '1';
  try {
    await assert.rejects(() => power.run({ params: { action: 'shutdown' } }, ctx), /二次确认/);
    const dry = await power.run({ params: { action: 'shutdown', confirm: true } }, ctx);
    assert.ok(dry.summary.includes('演练'));
    assert.equal(dry.partial, false);
  } finally {
    delete process.env.TENON_ALLOW_POWER;
    delete process.env.TENON_POWER_DRYRUN;
  }
});

test('actions：system.volume 参数校验 + 演练；file.print/system.open 缺参报错', async () => {
  const ctx = { repoRoot: AGENT_DIR, dataDir: path.join(TMP, 'actions-data'), nodeId: 'node-local', nodeName: '自测节点' };
  const volume = findAction('system.volume');
  await assert.rejects(() => volume.run({ params: {} }, ctx), /action/);
  // Round3 起 system.volume 已支持 level（CoreAudio）；这里只校验非法值，避免测试真的改用户音量
  await assert.rejects(() => volume.run({ params: { level: 150 } }, ctx), /level/);
  process.env.TENON_ACTION_DRYRUN = '1';
  try {
    const result = await volume.run({ params: { action: 'mute' } }, ctx);
    assert.ok(result.summary.includes('切换静音'));
    const up = await volume.run({ params: { action: 'up', steps: 3 } }, ctx);
    assert.ok(up.summary.includes('+3'));
  } finally {
    delete process.env.TENON_ACTION_DRYRUN;
  }
  await assert.rejects(() => findAction('system.open').run({ params: {} }, ctx), /target/);
  await assert.rejects(() => findAction('file.print').run({ params: {} }, ctx), /path/);
  const missing = await openPath(path.join(TMP, '不存在-xyz'));
  assert.equal(missing.ok, false);
});

// ---------- 文件收发 ----------
test('link：出站分块 PUT（1024B 分块）+ finish 带回 sha256', async () => {
  const dir = path.join(TMP, 'send');
  fs.mkdirSync(dir, { recursive: true });
  const buffer = Buffer.alloc(2500);
  for (let i = 0; i < buffer.length; i += 1) buffer[i] = i % 256;
  const filePath = path.join(dir, '发出去的文件.bin');
  fs.writeFileSync(filePath, buffer);
  const link = createLinkService({ hub: makeHubClient(), deviceId: 'node-local', log: () => {} });
  const progress = [];
  const result = await link.sendFiles({ peerId: 'phone-1', files: [filePath], onProgress: (p) => progress.push(p) });
  assert.equal(result.ok, true);
  assert.equal(result.transferId, 'transfer_test_1');
  assert.equal(result.bytes, 2500);
  assert.equal(result.files[0].sha256, sha256(buffer));
  assert.ok(result.speedBps > 0);
  assert.deepEqual(hub.state.chunks.map((chunk) => chunk.offset).sort((a, b) => a - b), [0, 1024, 2048]);
  assert.equal(hub.state.initBodies[hub.state.initBodies.length - 1].direction, 'from-desktop');
  assert.equal(hub.state.finishBodies[hub.state.finishBodies.length - 1].body.files[0].sha256, sha256(buffer));
  const assembled = hub.uploadedFile('transfer_test_1', 0);
  assert.equal(sha256(assembled), sha256(buffer), 'stub 拼接收到的分块应与原文件一致');
  assert.ok(progress.length >= 3);
});

test('link：入站下载→落盘接收目录→sha256 校验→ack；重复拉取不重复下载', async () => {
  const receiveDir = path.join(TMP, 'receive');
  const stateFile = path.join(TMP, 'link-state.json');
  const content = Buffer.from(`手机发来的照片内容-${Date.now()}`);
  hub.addInboundTransfer({
    transferId: 'transfer_in_1',
    files: [{ name: '手机照片 01.png', buffer: content }],
  });
  const link = createLinkService({ hub: makeHubClient(), deviceId: 'node-local', receiveDir, stateFile, log: () => {} });
  const first = await link.receiveOnce();
  assert.equal(first.ok, true);
  assert.equal(hub.state.acks.length, 1);
  const ack = hub.state.acks[0];
  assert.equal(ack.transferId, 'transfer_in_1');
  assert.equal(ack.body.nodeId, 'node-local');
  assert.equal(ack.body.ok, true);
  assert.equal(ack.body.saved[0].sha256, sha256(content));
  const savedPath = ack.body.saved[0].path;
  assert.ok(fs.existsSync(savedPath), '接收文件应落盘');
  assert.equal(path.basename(savedPath), '手机照片 01.png');
  assert.equal(sha256(fs.readFileSync(savedPath)), sha256(content));
  assert.ok(savedPath.startsWith(path.resolve(receiveDir)));
  // 中枢重复返回同一 transfer：状态文件记住已 ack，不再下载
  const downloadsBefore = hub.state.requests.filter((r) => r.pathname.endsWith('/file')).length;
  await link.receiveOnce();
  const downloadsAfter = hub.state.requests.filter((r) => r.pathname.endsWith('/file')).length;
  assert.equal(downloadsAfter, downloadsBefore);
  // 重启（新实例读同一个 stateFile）也不会重复下载
  const link2 = createLinkService({ hub: makeHubClient(), deviceId: 'node-local', receiveDir, stateFile, log: () => {} });
  await link2.receiveOnce();
  assert.equal(hub.state.requests.filter((r) => r.pathname.endsWith('/file')).length, downloadsBefore);
});

test('link：sha256 不匹配仍落盘但 ack ok=false 并留证据', async () => {
  const receiveDir = path.join(TMP, 'receive-bad');
  const stateFile = path.join(TMP, 'link-state-bad.json');
  const content = Buffer.from('内容有可能被篡改');
  hub.addInboundTransfer({
    transferId: 'transfer_in_bad',
    files: [{ name: '可疑文件.bin', buffer: content, sha256: 'deadbeef'.repeat(8) }],
  });
  const link = createLinkService({ hub: makeHubClient(), deviceId: 'node-local', receiveDir, stateFile, log: () => {} });
  await link.receiveOnce();
  const ack = hub.state.acks[hub.state.acks.length - 1];
  assert.equal(ack.transferId, 'transfer_in_bad');
  assert.equal(ack.body.ok, false);
  assert.equal(ack.body.saved[0].ok, false);
  assert.ok(fs.existsSync(ack.body.saved[0].path), '校验失败也保留文件供人工核对');
});

// ---------- agent 集成 ----------
test('agent：V2_ENABLED 由 env TENON_V2 决定（默认 v0.1）', () => {
  assert.equal(agentMod.V2_ENABLED, false);
  assert.equal(typeof agentMod.NodeAgent, 'function');
});

test('agent：v0.1 注册 4 能力；TENON_V2 模式注册 21 能力（4 基础 + 4 受控动作 + 5 超级终端动作 + 3 手机遥控 + 4 V4 执行器）', async () => {
  const v1 = new agentMod.NodeAgent({ hubUrl, v2Enabled: false });
  assert.equal(v1.activeManifest.length, 4);
  await v1.register();
  const v1Body = hub.state.registerBodies[hub.state.registerBodies.length - 1];
  assert.equal(v1Body.capabilities.length, 4);
  const v2 = new agentMod.NodeAgent({ hubUrl, v2Enabled: true });
  assert.equal(v2.activeManifest.length, 21);
  await v2.register();
  const v2Body = hub.state.registerBodies[hub.state.registerBodies.length - 1];
  assert.equal(v2Body.capabilities.length, 21);
  const ids = v2Body.capabilities.map((cap) => cap.id);
  for (const id of ['image.crop', 'file.hash', 'file.delete', 'printer.mock', 'system.open', 'system.volume', 'system.power', 'file.print', 'app.launch', 'url.open', 'media.show', 'handoff.show', 'app.list', 'input.mouse', 'input.key', 'input.media', 'system.exec', 'window.list', 'window.focus', 'screen.capture']) {
    assert.ok(ids.includes(id), `注册能力缺 ${id}`);
  }
  assert.ok(v2Body.capabilities.every((cap) => !('run' in cap)), '注册清单不能带函数');
});

test('agent：v2 动作任务由 handleTask 执行并回报 task.step → task.succeeded', async () => {
  process.env.TENON_ACTION_DRYRUN = '1';
  try {
    const agent = new agentMod.NodeAgent({ hubUrl, v2Enabled: true });
    agent.token = 'node-token-test';
    const before = hub.state.nodeEvents.length;
    await agent.handleTask({ id: 'task_v2_volume', capabilityId: 'system.volume', params: { action: 'mute' } });
    const events = hub.state.nodeEvents.slice(before);
    assert.ok(events.some((event) => event.type === 'task.step' && event.data.label === '开始执行'));
    const succeeded = events.find((event) => event.type === 'task.succeeded');
    assert.ok(succeeded, '应回报 task.succeeded');
    assert.ok(succeeded.data.result.summary.includes('切换静音'));
    assert.equal(succeeded.data.result.partial, false);
    const nodeState = JSON.parse(fs.readFileSync(path.join(AGENT_DATA, 'node-state.json'), 'utf8'));
    assert.equal(nodeState.done.task_v2_volume.status, 'succeeded');
    // 不支持的动作（电源未开闸）应回报 task.failed，而不是崩
    const before2 = hub.state.nodeEvents.length;
    await agent.handleTask({ id: 'task_v2_power_denied', capabilityId: 'system.power', params: { action: 'shutdown', confirm: true } });
    const failed = hub.state.nodeEvents.slice(before2).find((event) => event.type === 'task.failed');
    assert.ok(failed);
    assert.ok(failed.data.error.includes('默认禁用'));
  } finally {
    delete process.env.TENON_ACTION_DRYRUN;
  }
});

test('agent v2：startV2 启动文件收发/SSE 通知镜像，stop 时干净退出', async () => {
  process.env.TENON_CLIPBOARD = '0';
  process.env.TENON_NOTIFY_METHOD = 'log';
  process.env.TENON_RECEIVE_DIR = path.join(TMP, 'agent-receive');
  try {
    const agent = new agentMod.NodeAgent({ hubUrl, v2Enabled: true });
    agent.token = 'node-token-test';
    agent.operatorToken = 'operator-token-test';
    await agent.startV2();
    assert.equal(agent.v2.started, true);
    assert.ok(agent.v2.link, 'v2 link 模块应启动');
    assert.equal(agent.v2.clipboard, null, 'TENON_CLIPBOARD=0 时不应启动剪贴板');
    await waitFor(() => hub.state.sseClients.size > 0, 'SSE 订阅连接');
    const sentBefore = agent.v2.notifier.status.sent;
    hub.pushEvent({ type: 'notification.relayed', data: { app: 'com.tencent.mm', title: '手机消息', preview: '镜像给我的' } });
    await waitFor(() => agent.v2.notifier.status.sent > sentBefore, '手机通知镜像到本机');
    assert.ok(agent.v2.notifier.status.last.title.includes('手机消息') || agent.v2.notifier.status.last.title.includes('手机通知'));
    // 入站文件：停轮询后显式拉一次，验证落盘 + ack
    agent.v2.link.stop();
    hub.addInboundTransfer({ transferId: 'transfer_agent_auto', files: [{ name: '自动接收.bin', buffer: Buffer.from('auto-receive') }] });
    const received = await agent.v2.link.receiveOnce();
    assert.equal(received.ok, true);
    assert.equal(hub.state.acks[hub.state.acks.length - 1].transferId, 'transfer_agent_auto');
    // 事件处理不应崩（transfer.completed → 立即拉入站）
    hub.pushEvent({ type: 'transfer.completed', data: { transferId: 'transfer_agent_auto' } });
    await sleep(300);
    assert.ok(Array.isArray(agent.v2.errors));
    const before = hub.state.nodeEvents.length;
    await agent.stop('TEST-stop');
    assert.equal(agent.stopping, true);
    assert.equal(agent.v2.started, false);
    assert.equal(hub.state.nodeEvents.length, before, '停止时不应产生新事件');
  } finally {
    delete process.env.TENON_CLIPBOARD;
    delete process.env.TENON_NOTIFY_METHOD;
    delete process.env.TENON_RECEIVE_DIR;
  }
});