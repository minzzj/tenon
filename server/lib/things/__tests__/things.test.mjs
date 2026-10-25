// 榫卯 Tenon v2 · 物模型与场景控制测试（node:test，零依赖）
// 运行：node --test server/lib/things/__tests__/things.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Ledger } from '../../ledger.js';
import { replay } from '../../state.js';
import { createThingsService, matchRoutes } from '../index.js';
import { executeCapability } from '../../../../node-agent/capabilities.js';

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '../../../..');
const DATA_ROOT = path.join(REPO_ROOT, '_internal', 'things-data');
fs.mkdirSync(DATA_ROOT, { recursive: true });

const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(DATA_ROOT, prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
  try { fs.rmdirSync(DATA_ROOT); } catch { /* 目录非空则保留 */ }
});

function cap(id, name, over = {}) {
  return { id, name, risk: 'reversible', manualOnly: false, version: '1.0.0', evidence: 'confirmed', ...over };
}

// 模拟真实中枢状态：hub + 在线工作台（含 printer.mock）+ 离线打印服务器 + 授权过期的 NAS
function makeWorld() {
  const ledger = new Ledger(tempDir('ledger-'));
  ledger.append('node.registered', {
    nodeId: 'hub', name: '本机中枢', platform: 'hub', fingerprint: 'local-hub',
    capabilities: [cap('channel.notify', '发送消息（摘要+链接）', { risk: 'irreversible', evidence: '通道回执与留痕' }), cap('llm.summarize', '模型摘要')],
  });
  ledger.append('node.registered', {
    nodeId: 'node-local', name: '工作台', platform: 'win32-x64', fingerprint: 'fp-local',
    capabilities: [cap('image.crop', '图片居中裁剪'), cap('file.hash', '文件 SHA-256 校验'), cap('file.delete', '删除文件', { risk: 'irreversible' }), cap('printer.mock', '模拟打印', { risk: 'irreversible' })],
  });
  ledger.append('device.imported', {
    nodeId: 'dev-printer', name: '打印服务器', platform: 'printer', fingerprint: 'fp-printer', online: false,
    capabilities: [cap('printer.mock', '模拟打印', { risk: 'irreversible' })],
  });
  ledger.append('device.imported', {
    nodeId: 'dev-nas', name: '群晖 NAS', platform: 'nas', fingerprint: 'fp-nas', domain: 'outside',
    capabilities: [cap('nas.sync', 'NAS 归档同步', { authExpiresAt: '2020-01-01T00:00:00.000Z' })],
  });
  return { ledger, state: replay(ledger.events) };
}

function makeService(world, extra = {}) {
  const dataDir = tempDir('data-');
  const service = createThingsService({ ledger: world.ledger, state: world.state, root: REPO_ROOT, dataDir, ...extra });
  return { service, dataDir };
}

// 本地节点执行器：直接复用 node-agent 的真实能力实现（printer.mock 会写真实 outbox 文件）
function makeNodeRunner(dataDir) {
  const calls = [];
  async function runner({ task, capabilityId }) {
    calls.push({ capabilityId, params: task.params });
    return executeCapability({ capabilityId, id: task.id, taskId: task.id, params: task.params, draft: task.draft }, { repoRoot: REPO_ROOT, dataDir, nodeName: '工作台' });
  }
  return { runner, calls };
}

function sha256File(file) {
  // 与 actions.js 相同口径的独立实现，用于测试校验
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------- 1. 物模型映射 ----------
test('物模型：现有节点能力统一映射为 properties / actions / events', () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const model = service.model();
  assert.equal(model.schema, 'tenon-things');
  assert.equal(model.version, '2.0.0');
  const ids = model.devices.map((d) => d.deviceId);
  for (const id of ['hub', 'node-local', 'dev-printer', 'dev-nas']) assert.ok(ids.includes(id), `缺少设备 ${id}`);

  const local = model.devices.find((d) => d.deviceId === 'node-local');
  assert.equal(local.properties.online.type, 'boolean');
  assert.equal(local.properties.online.value, true);
  assert.equal(local.properties.capabilityCount.value, 4);
  assert.equal(local.properties.authorization.value, 'valid');
  const printCapAction = local.actions.find((a) => a.actionId === 'cap:printer.mock');
  assert.ok(printCapAction, '设备能力动作 cap:printer.mock 应存在');
  assert.equal(printCapAction.risk, 'irreversible');
  assert.equal(printCapAction.requiresConfirmation, true);
  assert.equal(printCapAction.params.type, 'object');

  // 授权过期的能力被标记（NAS 的 nas.sync）
  const nas = model.capabilityActions.find((a) => a.capabilityId === 'nas.sync');
  assert.equal(nas.authExpired, true);

  // 内置动作目录（5 个）
  const actions = service.listActions();
  const expected = ['asset.print', 'asset.showOnDesktop', 'asset.backup', 'system.open', 'channel.notify'];
  for (const id of expected) assert.ok(actions.some((a) => a.id === id), `缺少内置动作 ${id}`);
  const print = actions.find((a) => a.id === 'asset.print');
  assert.equal(print.mode, 'node');
  assert.equal(print.risk, 'irreversible');
  assert.equal(print.requiresConfirmation, true);
  assert.deepEqual(print.params.required, ['file']);
  assert.equal(print.params.properties.copies.maximum, 99);
  assert.ok(print.targetDevices.some((t) => t.deviceId === 'node-local' && t.online));
  assert.ok(print.targetDevices.some((t) => t.deviceId === 'dev-printer' && !t.online));
  assert.equal(actions.find((a) => a.id === 'asset.backup').availableAs, 'hub');
  assert.equal(actions.find((a) => a.id === 'asset.showOnDesktop').availableAs, 'hub-fallback');
  const notify = actions.find((a) => a.id === 'channel.notify');
  assert.equal(notify.mode, 'hub');
  assert.equal(notify.risk, 'irreversible');

  // 事件声明包含契约 §3 的 scene.* 与任务链事件
  const types = model.events.map((e) => e.type);
  for (const t of ['scene.defined', 'scene.ran', 'task.drafted', 'task.confirmed', 'task.queued', 'task.started', 'task.step', 'task.succeeded', 'task.failed']) {
    assert.ok(types.includes(t), `事件声明缺少 ${t}`);
  }
  assert.equal(world.ledger.integrity().ok, true);
});

// ---------- 2. 场景 CRUD ----------
test('场景 CRUD：data/things/scenes.json 原子写 + scene.defined 审计事件', () => {
  const world = makeWorld();
  const { service, dataDir } = makeService(world);
  const scene = service.createScene({
    name: '备份素材',
    description: '把选中的素材备份到 NAS',
    steps: [{ actionId: 'asset.backup', params: { src: 'demo.txt', dir: 'backup' } }],
  });
  assert.match(scene.id, /^scene_/);
  const file = path.join(dataDir, 'things', 'scenes.json');
  assert.ok(fs.existsSync(file), 'scenes.json 应已写入');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.scenes.length, 1);
  assert.equal(doc.scenes[0].name, '备份素材');
  assert.deepEqual(doc.scenes[0].steps[0].params, { src: 'demo.txt', dir: 'backup' });
  assert.deepEqual(Object.keys(doc.scenes[0].steps[0]).sort(), ['actionId', 'needsConfirm', 'params', 'targetDeviceId']);
  // 原子写不残留 .tmp
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'things')).filter((f) => f.endsWith('.tmp')), []);

  // 读 / 改 / 列表
  assert.equal(service.getScene(scene.id).name, '备份素材');
  const updated = service.updateScene(scene.id, { name: '备份素材（改）', steps: [{ actionId: 'asset.backup', params: { src: 'demo.txt', dir: 'backup2' } }] });
  assert.equal(updated.name, '备份素材（改）');
  assert.equal(service.listScenes().length, 1);

  // 校验：未知动作 / 缺参数 / 空步骤
  assert.throws(() => service.createScene({ name: '坏场景', steps: [{ actionId: 'nope.action', params: {} }] }), /未知动作/);
  assert.throws(() => service.createScene({ name: '缺参数', steps: [{ actionId: 'asset.print', params: {} }] }), /缺少参数 file/);
  assert.throws(() => service.createScene({ name: '空场景', steps: [] }), /至少需要 1 个步骤/);

  // 删除
  service.removeScene(scene.id);
  assert.equal(service.listScenes().length, 0);
  assert.equal(service.getScene(scene.id), null);

  const defined = world.ledger.events.filter((e) => e.type === 'scene.defined');
  assert.equal(defined.length, 3, 'create + update + delete 各留一条 scene.defined');
  for (const ev of defined) assert.deepEqual(Object.keys(ev.data).sort(), ['name', 'sceneId', 'steps']);
  assert.equal(world.ledger.integrity().ok, true);
});

// ---------- 3. 真实场景 1/3：备份到真实临时目录 ----------
test('真实场景 1/3：备份到真实临时目录（真拷贝 + SHA-256 一致 + 任务事件留痕）', async () => {
  const world = makeWorld();
  const { service, dataDir } = makeService(world);
  const srcDir = tempDir('src-');
  const srcFile = path.join(srcDir, '样品-01.txt');
  fs.writeFileSync(srcFile, '榫卯真实备份测试内容\n', 'utf8');
  const destDir = path.join(dataDir, '备份输出');
  const scene = service.createScene({
    name: '备份素材到文件夹',
    steps: [{ actionId: 'asset.backup', params: { src: srcFile, dir: destDir } }],
  });

  const preview = service.previewScene(scene.id);
  assert.equal(preview.needsConfirm, false, '备份是可逆动作，不需要确认');
  assert.equal(preview.steps[0].mode, 'hub');

  const result = await service.runScene(scene.id, { by: '你' });
  assert.equal(result.ok, true);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].status, 'succeeded');
  assert.equal(result.taskIds.length, 1);

  const destFile = path.join(destDir, '样品-01.txt');
  assert.ok(fs.existsSync(destFile), '备份目标文件应真实存在');
  assert.equal(fs.readFileSync(destFile, 'utf8'), '榫卯真实备份测试内容\n');
  assert.equal(sha256File(srcFile), sha256File(destFile), '备份前后 SHA-256 应一致');

  const types = world.ledger.events.map((e) => e.type);
  for (const t of ['scene.defined', 'task.drafted', 'task.started', 'task.step', 'task.succeeded', 'scene.ran']) assert.ok(types.includes(t), `账本缺少 ${t}`);
  const ran = world.ledger.events.filter((e) => e.type === 'scene.ran');
  assert.equal(ran.length, 1);
  assert.deepEqual(Object.keys(ran[0].data).sort(), ['by', 'ok', 'result', 'sceneId']);
  assert.equal(ran[0].data.result.ok, true);
  assert.equal(ran[0].data.ok, true);
  // 任务在状态里可查（复用现有任务引擎的时间线）
  const st = replay(world.ledger.events);
  const task = st.tasks[result.taskIds[0]];
  assert.equal(task.status, 'succeeded');
  assert.equal(task.source, 'scene');
  assert.equal(task.capabilityId, 'asset.backup');
  assert.ok(task.steps.some((s) => s.label === '执行完成'));
  assert.equal(world.ledger.integrity().ok, true);
});

// ---------- 4. 真实场景 2/3：打印（不可逆，需确认）----------
test('真实场景 2/3：打印不可逆必须确认；确认后本地执行器真跑 printer.mock', async () => {
  const world = makeWorld();
  const dataDir = tempDir('data-');
  const { runner, calls } = makeNodeRunner(dataDir);
  const service = createThingsService({ ledger: world.ledger, root: REPO_ROOT, dataDir, nodeRunner: runner });
  const scene = service.createScene({
    name: '打印样品图',
    steps: [{ actionId: 'asset.print', params: { file: '示例空间/样品图/01.png', copies: 2 }, targetDeviceId: 'node-local' }],
  });

  const preview = service.previewScene(scene.id);
  assert.equal(preview.needsConfirm, true);
  assert.equal(preview.steps[0].risk, 'irreversible');
  assert.equal(preview.steps[0].targetDeviceId, 'node-local');

  // 未确认：不执行、不写账本、不产生 outbox 证据
  const before = world.ledger.events.length;
  const gate = await service.runScene(scene.id, {});
  assert.equal(gate.ok, false);
  assert.equal(gate.needsConfirm, true);
  assert.equal(world.ledger.events.length, before, '未确认时不得写任何账本事件');
  const outboxBefore = fs.existsSync(path.join(dataDir, 'outbox')) ? fs.readdirSync(path.join(dataDir, 'outbox')) : [];
  assert.equal(outboxBefore.length, 0);

  // 确认后执行
  const result = await service.runScene(scene.id, { confirmed: true, by: '你' });
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].status, 'succeeded');
  assert.equal(calls.length, 1, '应调用一次本地节点执行器');
  assert.equal(calls[0].capabilityId, 'printer.mock');
  assert.equal(calls[0].params.copies, 2);
  const outbox = fs.readdirSync(path.join(dataDir, 'outbox'));
  assert.ok(outbox.some((f) => f.startsWith('打印-')), `outbox 应有真实打印单：${JSON.stringify(outbox)}`);
  const printFile = outbox.find((f) => f.startsWith('打印-'));
  const content = fs.readFileSync(path.join(dataDir, 'outbox', printFile), 'utf8');
  assert.match(content, /模拟打印单/);
  assert.match(content, /份数：2/);

  const types = world.ledger.events.map((e) => e.type);
  for (const t of ['task.drafted', 'task.confirmed', 'task.queued', 'task.started', 'task.succeeded', 'scene.ran']) assert.ok(types.includes(t), `账本缺少 ${t}`);
  const drafted = world.ledger.events.find((e) => e.type === 'task.drafted');
  assert.equal(drafted.data.draft.risk.level, 'irreversible');
  assert.equal(drafted.data.draft.targetDevice.id, 'node-local');
  const succeeded = world.ledger.events.filter((e) => e.type === 'task.succeeded').pop();
  assert.equal(succeeded.data.result.items.length, 2, '2 份打印应留下 2 条结果明细');
  assert.equal(world.ledger.integrity().ok, true);
});

// ---------- 5. 真实场景 3/3：投屏（mock 打开器 / 未注入时留痕）----------
test('真实场景 3/3：投屏到电脑（mock 打开器被调用；未注入时写 open-outbox 证据）', async () => {
  const world = makeWorld();
  const dataDir = tempDir('data-');
  const opened = [];
  const service = createThingsService({ ledger: world.ledger, root: REPO_ROOT, dataDir, opener: async (abs) => { opened.push(abs); } });
  const imgDir = tempDir('img-');
  const img = path.join(imgDir, '照片-01.png');
  fs.writeFileSync(img, 'fake-png-bytes-for-open-test', 'utf8');

  const scene = service.createScene({ name: '把照片投到电脑', steps: [{ actionId: 'asset.showOnDesktop', params: { path: img } }] });
  const preview = service.previewScene(scene.id);
  assert.equal(preview.needsConfirm, false);
  assert.equal(preview.steps[0].mode, 'hub', '没有 system.open 设备时应降级为本机执行');
  assert.match(preview.steps[0].degradedReason || '', /system\.open/);

  const result = await service.runScene(scene.id, {});
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].status, 'succeeded');
  assert.deepEqual(opened, [path.resolve(img)], 'opener 应收到被打开的绝对路径');
  assert.match(result.steps[0].summary, /已在电脑打开/);

  // 未注入 opener：只留痕（open-outbox 证据文件），结果里说明「仅留痕」
  const service2 = createThingsService({ ledger: world.ledger, root: REPO_ROOT, dataDir });
  const scene2 = service2.createScene({ name: '投屏（只留痕）', steps: [{ actionId: 'asset.showOnDesktop', params: { path: img } }] });
  const r2 = await service2.runScene(scene2.id, {});
  assert.equal(r2.ok, true);
  assert.match(r2.steps[0].summary, /已记录打开请求/);
  const outbox = fs.readdirSync(path.join(dataDir, 'things', 'outbox'));
  assert.ok(outbox.some((f) => f.startsWith('open-')), `应有 open-outbox 证据：${JSON.stringify(outbox)}`);
  assert.equal(world.ledger.integrity().ok, true);
});

// ---------- 6. 中枢不可逆动作 channel.notify ----------
test('中枢不可逆动作 channel.notify：需确认；确认后写收件箱（模拟通道，仅摘要+链接）', async () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const scene = service.createScene({ name: '执行完通知我', steps: [{ actionId: 'channel.notify', params: { group: '工作群', summary: '备份完成' } }] });

  const gate = await service.runScene(scene.id, {});
  assert.equal(gate.needsConfirm, true);
  assert.equal(world.ledger.events.filter((e) => e.type === 'scene.ran').length, 0, '未确认不得留下 scene.ran');

  const result = await service.runScene(scene.id, { confirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].status, 'succeeded');
  const st = replay(world.ledger.events);
  assert.ok(st.messages.some((m) => m.title === '场景通知 · 工作群' && m.summary === '备份完成'), '收件箱应有场景通知');
  const inbox = world.ledger.events.find((e) => e.type === 'message.inbox');
  assert.equal(inbox.data.channel, 'wechat-mock');
  assert.ok(inbox.data.link.startsWith('/r/'), '回执链接应可登录查看正文');
  assert.equal(world.ledger.integrity().ok, true);
});

// ---------- 7. node 动作未注入执行器：只排队，不假装已执行 ----------
test('node 动作未注入执行器：只排队等 node-agent 认领（status=dispatched，任务 queued）', async () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const scene = service.createScene({ name: '打印（等节点）', steps: [{ actionId: 'asset.print', params: { file: '示例空间/样品图/01.png' }, targetDeviceId: 'node-local' }] });
  const result = await service.runScene(scene.id, { confirmed: true });
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].status, 'dispatched');
  const st = replay(world.ledger.events);
  const task = st.tasks[result.steps[0].taskId];
  assert.equal(task.status, 'queued', '未认领的任务应保持 queued');
  assert.ok(world.ledger.events.some((e) => e.type === 'task.queued' && e.data.nodeId === 'node-local'));
});

// ---------- 8. HTTP 路由（真实 HTTP + 写操作令牌校验） ----------
test('HTTP 路由：GET model / 场景 CRUD / run（真实 HTTP，写操作需 x-tenon-token）', async () => {
  const world = makeWorld();
  const dataDir = tempDir('data-');
  const service = createThingsService({ ledger: world.ledger, root: REPO_ROOT, dataDir });
  const srcDir = tempDir('http-src-');
  const srcFile = path.join(srcDir, 'http-素材.txt');
  fs.writeFileSync(srcFile, 'http-backup', 'utf8');
  const destDir = path.join(dataDir, 'http-备份');
  const TOKEN = 'tok_things_test';
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const hit = matchRoutes(service.routes, req.method, u.pathname);
    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    await hit.route.handler(req, res, { url: u, params: hit.params, secret: { operatorToken: TOKEN } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 只读接口不需要令牌
    const modelRes = await fetch(`${base}/api/v2/things/model`);
    assert.equal(modelRes.status, 200);
    const modelJson = await modelRes.json();
    assert.equal(modelJson.schema, 'tenon-things');
    assert.ok(modelJson.actions.some((a) => a.id === 'asset.print'));

    // 无令牌写 → 401
    const denied = await fetch(`${base}/api/v2/scenes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', steps: [] }) });
    assert.equal(denied.status, 401);

    // 有令牌创建 → 201
    const headers = { 'Content-Type': 'application/json', 'x-tenon-token': TOKEN };
    const created = await fetch(`${base}/api/v2/scenes`, { method: 'POST', headers, body: JSON.stringify({ name: 'HTTP 备份', steps: [{ actionId: 'asset.backup', params: { src: srcFile, dir: destDir } }] }) });
    assert.equal(created.status, 201);
    const createdJson = await created.json();
    assert.ok(createdJson.scene.id);

    // 列表
    const listJson = await (await fetch(`${base}/api/v2/scenes`)).json();
    assert.equal(listJson.scenes.length, 1);
    assert.equal(listJson.scenes[0].name, 'HTTP 备份');

    // 执行（可逆动作无需 confirmed）
    const runRes = await fetch(`${base}/api/v2/scenes/${createdJson.scene.id}/run`, { method: 'POST', headers, body: JSON.stringify({ confirmed: true }) });
    assert.equal(runRes.status, 200);
    const runJson = await runRes.json();
    assert.equal(runJson.ok, true);
    assert.ok(fs.existsSync(path.join(destDir, 'http-素材.txt')), 'HTTP 触发的备份应真实落盘');

    // 不存在的场景 → 404
    const missing = await fetch(`${base}/api/v2/scenes/scene_nope/run`, { method: 'POST', headers, body: '{}' });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------- 9. 三个场景串行执行后整体审计完整 ----------
test('审计：三个真实场景串行执行后账本哈希链完整、scene.ran 数量正确', async () => {
  const world = makeWorld();
  const dataDir = tempDir('data-');
  const { runner } = makeNodeRunner(dataDir);
  const service = createThingsService({ ledger: world.ledger, root: REPO_ROOT, dataDir, nodeRunner: runner, opener: async () => {} });
  const srcDir = tempDir('audit-');
  const srcFile = path.join(srcDir, '审计-素材.txt');
  fs.writeFileSync(srcFile, 'audit', 'utf8');
  const imgFile = path.join(srcDir, '审计-照片.png');
  fs.writeFileSync(imgFile, 'png', 'utf8');

  const s1 = service.createScene({ name: '审计-备份', steps: [{ actionId: 'asset.backup', params: { src: srcFile, dir: path.join(dataDir, '审计-备份') } }] });
  const s2 = service.createScene({ name: '审计-打印', steps: [{ actionId: 'asset.print', params: { file: '示例空间/样品图/01.png' }, targetDeviceId: 'node-local' }] });
  const s3 = service.createScene({ name: '审计-投屏', steps: [{ actionId: 'asset.showOnDesktop', params: { path: imgFile } }] });

  assert.equal((await service.runScene(s1.id, {})).ok, true);
  assert.equal((await service.runScene(s2.id, { confirmed: true })).ok, true);
  assert.equal((await service.runScene(s3.id, { confirmed: true })).ok, true);
  assert.equal(world.ledger.events.filter((e) => e.type === 'scene.ran').length, 3);
  assert.equal(world.ledger.events.filter((e) => e.type === 'scene.defined').length, 3);
  assert.equal(world.ledger.integrity().ok, true);
  const ran = world.ledger.events.filter((e) => e.type === 'scene.ran');
  for (const ev of ran) {
    assert.deepEqual(Object.keys(ev.data).sort(), ['by', 'ok', 'result', 'sceneId']);
    assert.equal(ev.data.result.ok, true);
    assert.equal(ev.data.ok, true);
  }
});