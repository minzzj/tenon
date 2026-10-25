// 榫卯 Tenon v2.1 · 超级终端服务测试（node:test，零依赖）
// 运行：node --test server/lib/super/__tests__/super.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Ledger } from '../../ledger.js';
import { replay } from '../../state.js';
import { createSuperService, matchRoutes } from '../index.js';
import { parseIntent, parseRuleIntent } from '../intent.js';
import { buildCatalog } from '../catalog.js';

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '../../../..');
const DATA_ROOT = path.join(REPO_ROOT, '_internal', 'super-data');
fs.mkdirSync(DATA_ROOT, { recursive: true });
const tempDirs = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(DATA_ROOT, prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmdirSync(DATA_ROOT); } catch { /* 非空则保留 */ }
});

function cap(id, name, over = {}) {
  return { id, name, risk: 'reversible', manualOnly: false, version: '1.0.0', evidence: 'confirmed', ...over };
}

// 模拟一个真实家庭：中枢 + 我的电脑（v2.1 动作能力）+ 打印服务器 + 手机 + NAS
function makeWorld({ withComputer = true, withPrinter = true } = {}) {
  const ledger = new Ledger(tempDir('ledger-'));
  ledger.append('node.registered', {
    nodeId: 'hub', name: '本机中枢', platform: 'hub', fingerprint: 'local-hub',
    capabilities: [cap('channel.notify', '发送消息', { risk: 'irreversible' }), cap('llm.summarize', '模型摘要')],
  });
  if (withComputer) {
    ledger.append('node.registered', {
      nodeId: 'node-local', name: '我的电脑', platform: 'win32-x64', fingerprint: 'fp-local',
      capabilities: [
        cap('app.launch', '打开电脑程序'), cap('url.open', '打开网址'), cap('media.show', '播放媒体'),
        cap('handoff.show', '流转到电脑大屏'), cap('system.volume', '系统音量'),
        cap('app.list', '读取程序清单'), cap('system.open', '打开文件/链接'), cap('image.crop', '图片裁剪'),
      ],
    });
  }
  if (withPrinter) {
    ledger.append('device.imported', {
      nodeId: 'dev-printer', name: '打印服务器', platform: 'printer', fingerprint: 'fp-printer', online: true,
      capabilities: [cap('printer.mock', '模拟打印', { risk: 'irreversible' })],
    });
  }
  ledger.append('device.imported', {
    nodeId: 'dev-phone', name: '我的手机', platform: 'android', fingerprint: 'fp-phone', online: true, capabilities: [],
  });
  ledger.append('device.imported', {
    nodeId: 'dev-nas', name: '家庭 NAS', platform: 'nas', fingerprint: 'fp-nas', online: true,
    capabilities: [cap('nas.sync', 'NAS 归档')],
  });
  return { ledger, state: replay(ledger.events) };
}

function makeService(world, extra = {}) {
  const dataDir = tempDir('data-');
  const service = createSuperService({ ledger: world.ledger, state: world.state, root: REPO_ROOT, dataDir, ...extra });
  return { service, dataDir };
}

function fakeAiOk(payload, extra = {}) {
  const fake = {
    available: true,
    model: 'deepseek-test',
    calls: 0,
    budgetLeft: () => true,
    async chat() {
      fake.calls += 1;
      return { text: JSON.stringify(payload), tokensIn: 11, tokensOut: 22, ...extra };
    },
  };
  return fake;
}

// ---------- 1. catalog 合并 ----------
test('catalog：真实设备 + 模拟家庭设备 + 程序清单 + app.list 节点合并', () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const cat = service.catalog();
  const ids = cat.devices.map((d) => d.deviceId);
  for (const id of ['hub', 'node-local', 'dev-printer', 'dev-phone', 'dev-nas']) assert.ok(ids.includes(id), `缺少设备 ${id}`);
  const kinds = Object.fromEntries(cat.devices.map((d) => [d.deviceId, d.kind]));
  assert.equal(kinds['node-local'], 'computer');
  assert.equal(kinds['dev-printer'], 'printer');
  assert.equal(kinds['dev-phone'], 'phone');
  assert.equal(kinds['dev-nas'], 'nas');
  assert.equal(kinds['hub'], 'hub');
  // 模拟家庭设备必须明确 simulated:true
  const sims = cat.devices.filter((d) => d.simulated);
  assert.equal(sims.length, 3);
  assert.deepEqual(sims.map((d) => d.deviceId).sort(), ['light-sim', 'speaker-sim', 'tv-sim']);
  for (const sim of sims) {
    assert.equal(sim.evidence, 'simulated');
    assert.match(sim.note, /模拟/);
    assert.ok(sim.actions.length > 0);
  }
  // 内置程序清单
  const names = cat.programs.map((p) => p.name);
  for (const name of ['微信', 'Chrome', '记事本', '资源管理器', '计算器', '音乐', '照片', '打印']) assert.ok(names.includes(name), `缺少程序 ${name}`);
  const wechat = cat.programs.find((p) => p.name === '微信');
  assert.equal(wechat.available, true);
  assert.ok(wechat.targetDevices.some((t) => t.deviceId === 'node-local'));
  const print = cat.programs.find((p) => p.name === '打印');
  assert.equal(print.actionId, 'file.print');
  assert.equal(print.available, true);
  assert.equal(cat.mobileActions.length, 3);
  assert.equal(cat.appListNodes.length, 1);
  assert.equal(cat.appListNodes[0].deviceId, 'node-local');
  assert.equal(cat.summary.simulatedDevices, 3);
  assert.equal(cat.summary.programs, cat.programs.length);
});

// ---------- 2. 规则意图（10+ 句） ----------
test('规则意图：15+ 句覆盖 打开程序/网址/甩到电脑/打印/音乐视频/回家模式/音量/电视灯/帮助', () => {
  const world = makeWorld();
  const cat = buildCatalog({ state: world.state });
  const context = { url: 'https://example.com/current', assetId: 'asset_demo_1', fromDevice: 'dev-phone' };
  const intent = (text) => parseRuleIntent(text, { catalog: cat, context });

  const cases = [
    { text: '打开微信', cap: 'app.launch', params: { app: '微信' } },
    { text: '帮我打开 Chrome 浏览器', cap: 'app.launch', params: { app: 'chrome' } },
    { text: '打开记事本', cap: 'app.launch', params: { app: 'notepad' } },
    { text: '打开计算器', cap: 'app.launch', params: { app: 'calc' } },
    { text: '打开 https://github.com', cap: 'url.open', params: { url: 'https://github.com' } },
    { text: '打开 github.com', cap: 'url.open', params: { url: 'https://github.com' } },
    { text: '把这张照片甩到电脑', cap: 'handoff.show', params: { kind: 'photo' } },
    { text: '把当前页面流转到电脑', cap: 'handoff.show', params: { kind: 'page', url: 'https://example.com/current' } },
    { text: '打印这份文件', cap: 'file.print', params: { path: '示例空间/样品图/样品01.png', copies: 1 } },
    { text: '放首歌', cap: 'media.show', params: { source: 'music' } },
    { text: '播放视频', cap: 'media.show', params: { source: 'video' } },
    { text: '音量调大一点', cap: 'system.volume', params: { action: 'up' } },
    { text: '静音', cap: 'system.volume', params: { action: 'mute' } },
    { text: '开电视', cap: 'tv.on', params: {} },
    { text: '关灯', cap: 'light.off', params: {} },
  ];
  assert.ok(cases.length >= 10);
  for (const item of cases) {
    const r = intent(item.text);
    assert.ok(Array.isArray(r.plan) && r.plan.length >= 1, `「${item.text}」应产生计划，实际：${JSON.stringify(r)}`);
    assert.equal(r.plan[0].capabilityId, item.cap, `「${item.text}」动作应为 ${item.cap}，实际 ${r.plan[0].capabilityId}`);
    for (const [key, value] of Object.entries(item.params)) {
      assert.deepEqual(r.plan[0].params[key], value, `「${item.text}」参数 ${key} 应为 ${JSON.stringify(value)}，实际 ${JSON.stringify(r.plan[0].params[key])}`);
    }
    assert.ok(r.plan[0].label && r.plan[0].label.length > 0);
  }
  // 回家模式：组合动作
  const home = intent('回家模式');
  assert.ok(home.plan.length >= 3);
  assert.equal(home.plan[0].capabilityId, 'light.on');
  assert.ok(home.plan.some((s) => s.capabilityId === 'media.show'));
  // 帮助/设备/问候/兜底：不给计划，只给回复
  const help = intent('你能做什么');
  assert.equal(help.plan.length, 0);
  assert.ok(help.say.includes('程序'));
  const devices = intent('家里有哪些设备');
  assert.equal(devices.plan.length, 0);
  assert.ok(devices.say.includes('我的电脑'));
  const hello = intent('你好');
  assert.equal(hello.plan.length, 0);
  assert.ok(hello.say.includes('我在'));
  const unknown = intent('今天天气怎么样');
  assert.equal(unknown.plan.length, 0);
  assert.match(unknown.say, /不太懂|不懂/);
});

// ---------- 3. DeepSeek 意图 + 降级 + 缓存 ----------
test('DeepSeek 意图：成功解析 JSON 计划（丢弃编造动作）、失败/超预算/无 key 降级规则、重复请求走缓存', async () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const cat = service.catalog();

  // 3.1 成功：AI 返回一个合法动作 + 一个编造动作 → 只保留合法动作
  const okAi = fakeAiOk({ say: '好的', plan: [{ capabilityId: 'app.launch', nodeId: 'node-local', params: { app: '微信' }, label: '打开微信' }, { capabilityId: 'made.up', params: {} }] });
  const r1 = await parseIntent({ text: '把微信打开一下', ai: okAi, catalog: cat, cache: service.intentCache });
  assert.equal(r1.source, 'deepseek');
  assert.equal(r1.plan.length, 1);
  assert.equal(r1.plan[0].capabilityId, 'app.launch');
  assert.equal(r1.plan[0].params.app, '微信');
  assert.equal(r1.ai.provider, 'deepseek');
  assert.equal(r1.ai.tokensIn, 11);

  // 3.2 缓存：同文本第二次不再调用 AI
  const before = okAi.calls;
  const r2 = await parseIntent({ text: '把微信打开一下', ai: okAi, catalog: cat, cache: service.intentCache });
  assert.equal(r2.source, 'cache');
  assert.equal(okAi.calls, before, '同文本应命中缓存，不再调用 DeepSeek');

  // 3.3 AI 抛错 → 规则兜底
  const failAi = { available: true, budgetLeft: () => true, async chat() { throw new Error('AI HTTP 500'); } };
  const rf = await parseIntent({ text: '打开微信', ai: failAi, catalog: cat });
  assert.equal(rf.source, 'rule');
  assert.equal(rf.ai.fallback, true);
  assert.match(rf.ai.reason, /500/);
  assert.equal(rf.plan[0].capabilityId, 'app.launch');

  // 3.4 预算用尽 → 不调用 AI
  const budgetAi = { available: true, budgetLeft: () => false, async chat() { throw new Error('不应被调用'); } };
  const rb = await parseIntent({ text: '放首歌', ai: budgetAi, catalog: cat });
  assert.equal(rb.source, 'rule');
  assert.match(rb.ai.reason, /预算/);

  // 3.5 未配置 key → 规则
  const rn = await parseIntent({ text: '开电视', ai: null, catalog: cat });
  assert.equal(rn.source, 'rule');
  assert.match(rn.ai.reason, /DEEPSEEK/);

  // 3.6 返回非法 JSON → 规则兜底
  const badJsonAi = { available: true, budgetLeft: () => true, async chat() { return { text: '我觉得可以打开微信' }; } };
  const rj = await parseIntent({ text: '打开微信', ai: badJsonAi, catalog: cat });
  assert.equal(rj.source, 'rule');

  // 3.7 AI 纯问答（plan 为空）→ 采用 AI 回复
  const qaAi = fakeAiOk({ say: '今天天气不错，适合出门。', plan: [] });
  const qa = await parseIntent({ text: '今天天气怎么样', ai: qaAi, catalog: cat });
  assert.equal(qa.source, 'deepseek');
  assert.equal(qa.plan.length, 0);
  assert.match(qa.say, /天气不错/);
});

// ---------- 4. executor：计划 → 任务事件 ----------
test('executor：计划 → task.drafted/queued/started/succeeded + super.asked（节点执行器真跑）', async () => {
  const world = makeWorld();
  const dataDir = tempDir('data-');
  const calls = [];
  const nodeRunner = async ({ task, capabilityId }) => {
    calls.push({ capabilityId, params: task.params });
    return { summary: `已打开 ${task.params.app}`, items: [{ name: task.params.app, ok: true, detail: 'opened' }] };
  };
  const service = createSuperService({ ledger: world.ledger, root: REPO_ROOT, dataDir, nodeRunner });
  const result = await service.ask('打开微信', { by: '手机' });
  assert.equal(result.ok, true);
  assert.equal(result.needsConfirm, false);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].capabilityId, 'app.launch');
  assert.equal(result.steps[0].status, 'succeeded');
  assert.equal(result.steps[0].deviceName, '我的电脑');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capabilityId, 'app.launch');
  assert.equal(calls[0].params.app, '微信');

  const types = world.ledger.events.map((e) => e.type);
  for (const t of ['task.drafted', 'task.queued', 'task.started', 'task.succeeded', 'super.asked']) assert.ok(types.includes(t), `账本缺少 ${t}`);
  const asked = world.ledger.events.find((e) => e.type === 'super.asked');
  assert.deepEqual(Object.keys(asked.data).sort(), ['needsConfirm', 'plan', 'reply', 'result', 'text']);
  assert.equal(asked.data.text, '打开微信');
  assert.equal(asked.data.needsConfirm, false);
  assert.equal(asked.data.result.ok, true);
  assert.equal(asked.data.result.steps[0].status, 'succeeded');
  assert.ok(asked.data.reply.includes('微信') || asked.data.reply.includes('打开'));

  // state.js 的 super 分支（Lead 已加）能重放出记录
  const st = replay(world.ledger.events);
  assert.equal(st.super.asks.length, 1);
  assert.equal(st.super.asks[0].text, '打开微信');
  assert.equal(st.super.asks[0].needsConfirm, false);
});

test('executor：未注入 nodeRunner 时 node 任务只排队（dispatched/queued），不假装完成', async () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const result = await service.ask('打开微信');
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].status, 'dispatched');
  const st = replay(world.ledger.events);
  const task = st.tasks[result.taskIds[0]];
  assert.equal(task.status, 'queued');
  assert.equal(task.source, 'super');
  assert.equal(task.capabilityId, 'app.launch');
});

// ---------- 5. 不可逆动作确认门 ----------
test('不可逆动作（打印）：未确认不执行且无 task 事件；确认后 task.confirmed + 派发', async () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const before = world.ledger.events.length;
  const gate = await service.ask('打印这份文件', {});
  assert.equal(gate.ok, false);
  assert.equal(gate.needsConfirm, true);
  assert.equal(gate.steps.length, 1);
  assert.equal(gate.steps[0].status, 'pending');
  assert.match(gate.say, /确认/);
  const newEvents = world.ledger.events.slice(before);
  assert.equal(newEvents.filter((e) => e.type.startsWith('task.')).length, 0, '未确认不得写任务事件');
  const asked = newEvents.filter((e) => e.type === 'super.asked');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].data.needsConfirm, true);
  assert.equal(asked[0].data.result.needsConfirm, true);

  const confirmed = await service.ask('打印这份文件', { confirmed: true });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.needsConfirm, false);
  assert.equal(confirmed.steps[0].planCapabilityId, 'file.print');
  assert.equal(confirmed.steps[0].capabilityId, 'printer.mock', '应自动退到现有的 printer.mock 能力');
  assert.equal(confirmed.steps[0].status, 'dispatched');
  const types = world.ledger.events.map((e) => e.type);
  assert.ok(types.includes('task.confirmed'));
  assert.ok(world.ledger.events.some((e) => e.type === 'task.queued' && e.data.nodeId === 'dev-printer'));
});

// ---------- 6. handoff 事件 + 派发 ----------
test('handoff：super.handoff 事件字段 + 给电脑派 handoff.show 任务；无电脑时不派发；非法输入 400', () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const r = service.handoff({ kind: 'page', url: 'https://example.com/a', fromDevice: 'dev-phone' });
  assert.equal(r.ok, true);
  assert.match(r.handoffId, /^handoff_/);
  assert.equal(r.dispatched, true);
  assert.equal(r.toDevice, 'node-local');
  const ev = world.ledger.events.find((e) => e.type === 'super.handoff');
  assert.deepEqual(Object.keys(ev.data).sort(), ['assetId', 'dispatched', 'fromDevice', 'handoffId', 'kind', 'payload', 'text', 'toDevice', 'url']);
  assert.equal(ev.data.kind, 'page');
  assert.equal(ev.data.url, 'https://example.com/a');
  assert.equal(ev.data.dispatched, true);
  assert.equal(ev.data.payload.kind, 'page');
  const task = world.ledger.events.find((e) => e.type === 'task.drafted');
  assert.equal(task.data.draft.capabilities[0].id, 'handoff.show');
  assert.equal(task.data.source, 'super');
  assert.ok(world.ledger.events.some((e) => e.type === 'task.queued' && e.data.nodeId === 'node-local'));
  // state 分支
  const st = replay(world.ledger.events);
  assert.equal(st.super.handoffs.length, 1);
  assert.equal(st.super.handoffs[0].dispatched, true);
  assert.equal(st.super.handoffs[0].kind, 'page');
  // 非法输入
  assert.throws(() => service.handoff({ kind: 'page' }), /必须提供 url/);
  assert.throws(() => service.handoff({ kind: 'video' }), /kind/);
  assert.throws(() => service.handoff({ kind: 'text', text: '' }), /必须提供 text/);
  // 没有电脑设备：记录但不派发
  const world2 = makeWorld({ withComputer: false });
  const { service: svc2 } = makeService(world2);
  const r2 = svc2.handoff({ kind: 'text', text: '你好' });
  assert.equal(r2.dispatched, false);
  assert.equal(r2.toDevice, 'desktop');
});

// ---------- 7. ask 触发流转（手机一倾） ----------
test('ask「把这张照片甩到电脑」：计划 → hub 执行流转 → super.handoff + 派发', async () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const r = await service.ask('把这张照片甩到电脑', { context: { assetId: 'asset_demo_1', fromDevice: 'dev-phone' } });
  assert.equal(r.ok, true);
  assert.equal(r.needsConfirm, false);
  assert.equal(r.plan[0].capabilityId, 'handoff.show');
  assert.ok(r.steps[0].handoffId, '步骤结果应带 handoffId');
  const h = world.ledger.events.find((e) => e.type === 'super.handoff');
  assert.equal(h.data.kind, 'photo');
  assert.equal(h.data.assetId, 'asset_demo_1');
  assert.equal(h.data.dispatched, true);
  const asked = world.ledger.events.find((e) => e.type === 'super.asked');
  assert.equal(asked.data.result.ok, true);
});

// ---------- 8. 模拟家庭设备 ----------
test('模拟家庭设备：没有真实能力时明确 simulated:true，不假装真实执行', async () => {
  const world = makeWorld({ withComputer: false });
  const { service } = makeService(world);
  const r = await service.ask('放首歌');
  assert.equal(r.ok, true);
  assert.equal(r.steps[0].simulated, true);
  assert.equal(r.steps[0].status, 'succeeded');
  assert.match(r.steps[0].summary, /模拟/);
  const success = world.ledger.events.filter((e) => e.type === 'task.succeeded').pop();
  assert.equal(success.data.result.simulated, true);

  const home = await service.ask('回家模式');
  assert.equal(home.steps.length, 3);
  assert.ok(home.steps.every((s) => s.simulated === true), '回家模式在无真实设备时应全部标注模拟');
  assert.equal(home.ok, true);
});

// ---------- 9. 纯问答 ----------
test('纯问答 / 帮助：不产生任务，只记录 super.asked，state 可查', async () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const before = world.ledger.events.length;
  const r = await service.ask('你能做什么');
  assert.equal(r.ok, true);
  assert.equal(r.plan.length, 0);
  assert.equal(r.steps.length, 0);
  assert.ok(r.say.includes('程序'));
  const newEvents = world.ledger.events.slice(before);
  assert.equal(newEvents.filter((e) => e.type.startsWith('task.')).length, 0);
  assert.equal(newEvents.filter((e) => e.type === 'super.asked').length, 1);
  const s = service.state();
  assert.equal(s.asks.length, 1);
  assert.equal(s.handoffs.length, 0);
  assert.ok(s.asks[0].at);
});

// ---------- 10. app.list 探测合并 ----------
test('程序目录合并电脑 app.list 上报（probe=1）', async () => {
  const world = makeWorld();
  const dataDir = tempDir('data-');
  const nodeRunner = async ({ capabilityId }) => {
    assert.equal(capabilityId, 'app.list');
    return { summary: '2 个程序', items: [{ name: '微信', ok: true }, { name: '公司 OA', ok: true }] };
  };
  const service = createSuperService({ ledger: world.ledger, root: REPO_ROOT, dataDir, nodeRunner });
  const r = await service.programs({ probe: true });
  assert.equal(r.ok, true);
  assert.equal(r.probe.probes.length, 1);
  assert.equal(r.probe.probes[0].count, 2);
  const names = r.programs.map((p) => p.name);
  assert.ok(names.includes('公司 OA'), '应合并电脑上报的程序');
  assert.ok(r.programs.some((p) => p.name === '公司 OA' && p.sourceNodeId === 'node-local'));
});

// ---------- 11. 真实 HTTP 隔离实例（端口 7451） ----------
test('真实 HTTP 隔离实例（7451）：routes 挂载 + ask / handoff / state + 写操作令牌', async () => {
  const world = makeWorld();
  const { service } = makeService(world);
  const TOKEN = 'tok_super_test';
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
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(7451, '127.0.0.1', resolve);
  });
  const base = 'http://127.0.0.1:7451';
  const headers = { 'Content-Type': 'application/json', 'x-tenon-token': TOKEN };
  try {
    // home（只读，不需要令牌）
    const home = await (await fetch(`${base}/api/v2/super/home`)).json();
    assert.equal(home.ok, true);
    assert.ok(home.catalog.programs.length >= 8);
    assert.ok(home.suggestions.length > 0);
    assert.ok(home.catalog.devices.some((d) => d.simulated));

    // programs
    const programs = await (await fetch(`${base}/api/v2/super/programs`)).json();
    assert.equal(programs.ok, true);
    assert.ok(programs.programs.some((p) => p.name === '微信'));

    // ask 无令牌 → 401
    const denied = await fetch(`${base}/api/v2/super/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '打开微信' }) });
    assert.equal(denied.status, 401);

    // ask 有令牌 → 200（无 nodeRunner → dispatched）
    const askRes = await fetch(`${base}/api/v2/super/ask`, { method: 'POST', headers, body: JSON.stringify({ text: '打开微信' }) });
    assert.equal(askRes.status, 200);
    const ask = await askRes.json();
    assert.equal(ask.ok, true);
    assert.equal(ask.plan[0].capabilityId, 'app.launch');
    assert.equal(ask.steps[0].status, 'dispatched');
    assert.equal(ask.taskIds.length, 1);

    // 不可逆 ask 未确认 → needsConfirm
    const printGate = await (await fetch(`${base}/api/v2/super/ask`, { method: 'POST', headers, body: JSON.stringify({ text: '打印这份文件' }) })).json();
    assert.equal(printGate.needsConfirm, true);
    assert.equal(printGate.ok, false);

    // handoff
    const handoff = await (await fetch(`${base}/api/v2/super/handoff`, { method: 'POST', headers, body: JSON.stringify({ kind: 'page', url: 'https://example.com/demo', fromDevice: 'phone' }) })).json();
    assert.equal(handoff.ok, true);
    assert.equal(handoff.dispatched, true);
    assert.ok(handoff.handoffId);

    // state 汇总
    const stateJson = await (await fetch(`${base}/api/v2/super/state`)).json();
    assert.equal(stateJson.ok, true);
    assert.equal(stateJson.asks.length, 2);
    assert.equal(stateJson.handoffs.length, 1);
    assert.equal(stateJson.handoffs[0].kind, 'page');

    // 非法 handoff → 400
    const bad = await fetch(`${base}/api/v2/super/handoff`, { method: 'POST', headers, body: JSON.stringify({ kind: 'page' }) });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
      setTimeout(resolve, 1500);
    });
  }
});

// ---------- 12. 事件白名单 / 账本完整性 ----------
test('账本：新增事件只有 super.asked / super.handoff（其余复用现有 task.*），哈希链完整', async () => {
  const world = makeWorld();
  const { service } = makeService(world);
  await service.ask('打开微信');
  await service.ask('把这张照片甩到电脑', { context: { assetId: 'a1' } });
  service.handoff({ kind: 'text', text: '你好' });
  const ALLOWED = new Set([
    'node.registered', 'device.imported', 'task.drafted', 'task.confirmed', 'task.queued', 'task.started', 'task.step', 'task.succeeded', 'task.failed', 'task.needsConfirm',
    'super.asked', 'super.handoff',
  ]);
  const unknown = world.ledger.events.map((e) => e.type).filter((t) => !ALLOWED.has(t));
  assert.deepEqual(unknown, [], '出现了未在契约内的事件类型');
  // 2 次 ask（打开微信 + 甩照片：都写 super.asked）+ 1 次直接 handoff → 2 条 super.asked + 2 条 super.handoff
  assert.equal(world.ledger.events.filter((e) => e.type === 'super.asked').length, 2);
  assert.equal(world.ledger.events.filter((e) => e.type === 'super.handoff').length, 2);
  assert.equal(world.ledger.integrity().ok, true);
});