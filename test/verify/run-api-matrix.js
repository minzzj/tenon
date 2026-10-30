#!/usr/bin/env node
/**
 * 榫卯 Tenon · 独立验收装置 · /api/v2/* 全量 API 矩阵
 *
 * 零依赖 Node ≥22。默认自启两个隔离实例：
 *   主实例 端口 7462（可写，临时数据目录）
 *   只读实例 端口 7463（同数据目录，自动 readOnly）
 * 遍历 /api/v2/health 暴露的全部路由，做四类矩阵：
 *   - 合法 GET 调用（路由存活、返回 JSON、无 5xx）
 *   - 写路由未登录 → 401
 *   - 写路由只读实例（带令牌）→ 423，且账本事件数不变
 *   - 未知路由 → 404
 * 另跑「核心业务 happy path + 错误路径 400」的声明式用例（资产/互联/场景/企业/超级终端/设备，路由不存在则 SKIP，兼容后续轮次新增模块）。
 *
 * 用法：
 *   node test/verify/run-api-matrix.js                # 自启隔离实例（7462/7463）
 *   node test/verify/run-api-matrix.js --keep         # 保留临时数据与日志
 *   node test/verify/run-api-matrix.js --base http://127.0.0.1:7462 --token tok_xxx   # 复用已运行实例（不启只读实例则跳过 RO 组）
 *
 * 输出：_internal/checker/api-matrix.json（PASS/FAIL 明细）+ 退出码 0/1
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT_DIR = path.join(ROOT, '_internal', 'checker');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const BASE_ARG = (argv.find((a) => a.startsWith('--base=')) || '').slice(7);
const TOKEN_ARG = (argv.find((a) => a.startsWith('--token=')) || '').slice(8);
const PORT = Number(process.env.TENON_VERIFY_PORT || 7462);
const RO_PORT = Number(process.env.TENON_VERIFY_RO_PORT || 7463);
const RUN_DIR = path.join(OUT_DIR, 'tmp', 'api-matrix-' + STAMP);
const DATA_DIR = path.join(RUN_DIR, 'data');
const SCENE_ROOT = path.join(RUN_DIR, 'scenes');
const LOG_DIR = path.join(OUT_DIR, 'api-matrix');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
function log(msg) {
  const line = '[' + new Date().toISOString().slice(11, 19) + '] ' + msg;
  logs.push(line);
  console.log(line);
}
function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

const cases = [];
function record(group, c) {
  cases.push({
    group,
    id: c.id,
    method: c.method || 'GET',
    path: c.path || '',
    expect: c.expect == null ? null : String(c.expect),
    actual: c.actual == null ? null : String(c.actual),
    pass: c.pass === true,
    skip: c.skip === true,
    detail: String(c.detail == null ? '' : c.detail).slice(0, 800),
  });
  const flag = c.skip ? 'SKIP' : c.pass ? 'PASS' : 'FAIL';
  log(flag + ' [' + group + '] ' + (c.method || 'GET') + ' ' + (c.path || c.id) + (c.detail ? ' :: ' + String(c.detail).slice(0, 160) : ''));
  return c.pass === true || c.skip === true;
}

function startHub({ port, dataDir, name }) {
  mkdirp(dataDir);
  const env = {
    ...process.env,
    TENON_PORT: String(port),
    TENON_HOST: '127.0.0.1',
    TENON_DATA_DIR: dataDir,
    TENON_DISCOVERY_PORT: String(port + 50),
    TENON_ASSETS_OCR: '0',
    TENON_MODE: 'solo',
  };
  const out = fs.openSync(path.join(LOG_DIR, 'hub-' + name + '.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'start.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', out, out],
    windowsHide: true,
    detached: false,
  });
  child.__name = name;
  child.__port = port;
  return child;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* ignore */ }
}

async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(250);
  }
  throw new Error('等待超时：' + label + (last ? '（' + last.message + '）' : ''));
}

async function req(base, method, pathname, { token = null, body = undefined, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (body !== undefined && body !== null && !raw) h['Content-Type'] = 'application/json';
  if (token) h['x-tenon-token'] = token;
  const opts = { method, headers: h, signal: AbortSignal.timeout(20000) };
  if (body !== undefined && body !== null) opts.body = raw ? body : JSON.stringify(body);
  const res = await fetch(base + pathname, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, headers: res.headers, text, json };
}

function normRoute(input) {
  const s = String(input || '').trim();
  const m = /^(GET|POST|PUT|DELETE|PATCH)\s+(.+)$/.exec(s);
  const raw = m ? { method: m[1], path: m[2] } : { method: 'GET', path: s };
  if (raw.path && !raw.path.startsWith('/api/')) raw.path = '/api/v2' + (raw.path.startsWith('/') ? raw.path : '/' + raw.path);
  return raw;
}
function templateToRegex(tpl) {
  const parts = tpl.split('/').map((seg) => (seg.startsWith(':') ? '([^/]+)' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp('^' + parts.join('/') + '$');
}
function concretePath(tpl) {
  return tpl.split('/').map((seg) => (seg.startsWith(':') ? 'not-exist-id' : seg)).join('/');
}
function routeExists(inventory, method, pathname) {
  const pathOnly = String(pathname).split('?')[0];
  return inventory.some((r) => r.method === method && templateToRegex(r.path).test(pathOnly));
}
function routeMatches(inventory, method, template) {
  return inventory.some((r) => r.method === method && r.path === template);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function eventCount(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch { return 0; }
}

// ---------------- 声明式核心用例 ----------------
function buildCurated(ctx) {
  const A = (id, method, pathname, opts = {}) => ({ id, method, pathname, opts });
  const steps = [];
  const add = (s) => steps.push(s);

  // 基础
  add(A('state 可达', 'GET', '/api/state', { check: (r) => { assert(r.status === 200, 'status=' + r.status); assert(r.json && typeof r.json.seq === 'number', '缺少 seq'); } }));
  add(A('v2 health 模块', 'GET', '/api/v2/health', { noInventoryCheck: true, check: (r) => { assert(r.status === 200, 'status=' + r.status); assert(Array.isArray(r.json.modules), '缺少 modules'); assert(Array.isArray(r.json.routes), '缺少 routes'); } }));
  add(A('未知 v2 路由 404', 'GET', '/api/v2/__no_such_route__', { noInventoryCheck: true, check: (r) => assert(r.status === 404, '应 404，实际 ' + r.status) }));

  // 超级终端
  add(A('super home', 'GET', '/api/v2/super/home'));
  add(A('super programs', 'GET', '/api/v2/super/programs'));
  add(A('super state', 'GET', '/api/v2/super/state'));
  add(A('super handoff page', 'POST', '/api/v2/super/handoff', { token: true, body: { kind: 'page', url: 'https://example.com/verify-matrix', fromDevice: 'phone' }, check: (r) => assert([200, 201].includes(r.status), 'status=' + r.status) }));
  add(A('super handoff 缺 url → 400', 'POST', '/api/v2/super/handoff', { token: true, body: { kind: 'page' }, expectStatus: 400 }));
  add(A('super ask 缺 text → 400', 'POST', '/api/v2/super/ask', { token: true, body: {}, expectStatus: 400 }));

  // 互联
  add(A('link info', 'GET', '/api/v2/link/info'));
  add(A('link peers', 'GET', '/api/v2/link/peers'));
  add(A('link pair qr（需令牌）', 'GET', '/api/v2/link/pair/qr', { token: true, check: (r) => assert(r.status === 200, 'status=' + r.status) }));
  add(A('link pair regenerate', 'POST', '/api/v2/link/pair/regenerate', { token: true, body: {} }));
  add(A('link notifications（需令牌）', 'GET', '/api/v2/link/notifications', { token: true, check: (r) => assert(r.status === 200, 'status=' + r.status) }));
  add(A('link clipboard latest（需令牌）', 'GET', '/api/v2/link/clipboard/latest', { token: true, check: (r) => assert(r.status === 200, 'status=' + r.status) }));
  add(A('link clipboard 发送', 'POST', '/api/v2/link/clipboard', { token: true, body: { kind: 'text', text: 'verify-matrix-clip' }, check: (r) => assert([200, 201].includes(r.status), 'status=' + r.status) }));
  add(A('link clipboard 落库', 'GET', '/api/v2/link/clipboard/latest', { token: true, check: (r) => { const s = JSON.stringify(r.json || {}); assert(s.includes('verify-matrix-clip'), '最新剪贴板未包含发送内容'); } }));
  add(A('link pair 错误码 → 4xx', 'POST', '/api/v2/link/pair', { token: true, body: { code: '000000' }, expectStatus: [400, 403, 404] }));

  // 素材
  add(A('assets ingest 示例图', 'POST', '/api/v2/assets/ingest', { token: true, body: { deviceId: 'verify-node', path: '示例空间/样品图/样品01.png' }, check: (r, c) => { assert(r.status === 200, 'status=' + r.status); const a = r.json.items && r.json.items[0] && r.json.items[0].asset; assert(a && a.kind === 'image', '未返回 image 素材'); c.assetId = a.id; } }));
  add(A('assets 重复入库去重', 'POST', '/api/v2/assets/ingest', { token: true, body: { deviceId: 'verify-node', path: '示例空间/样品图/样品01.png' }, check: (r) => { assert(r.status === 200, 'status=' + r.status); assert(r.json.items[0].deduped === true, '第二次入库应 deduped=true'); } }));
  add(A('assets 列表', 'GET', '/api/v2/assets', { check: (r) => { assert(r.status === 200 && Array.isArray(r.json.items), '返回结构异常'); assert(r.json.total >= 1, 'total 应 ≥1'); } }));
  add(A('assets 搜索', 'GET', '/api/v2/assets?q=' + encodeURIComponent('样品'), { check: (r) => assert(r.status === 200 && r.json.total >= 1, '搜索无结果') }));
  add(A('assets 统计', 'GET', '/api/v2/assets/stats', { check: (r) => { assert(r.status === 200, 'status=' + r.status); assert(typeof r.json.total === 'number', '缺少 total'); } }));
  add(A('assets 详情', 'GET', () => '/api/v2/assets/' + ctx.assetId, { check: (r) => assert(r.status === 200 && r.json.asset && r.json.asset.id === ctx.assetId, '详情异常') }));
  add(A('assets 缩略图', 'GET', () => '/api/v2/assets/' + ctx.assetId + '/thumb?w=320', { raw: true, check: (r) => { assert(r.status === 200, 'status=' + r.status); assert(String(r.headers.get('content-type')).includes('image/webp'), 'content-type=' + r.headers.get('content-type')); assert(r.text.startsWith('RIFF'), '不是 webp 二进制'); } }));
  add(A('assets 谱系', 'GET', () => '/api/v2/assets/' + ctx.assetId + '/lineage', { check: (r) => assert(r.status === 200 && Array.isArray(r.json.events), '谱系异常') }));
  add(A('assets 打标签', 'POST', () => '/api/v2/assets/' + ctx.assetId + '/tags', { token: true, body: { tags: ['verify-tag'] }, check: (r) => { assert(r.status === 200, 'status=' + r.status); assert((r.json.asset.tags || []).includes('verify-tag'), '标签未生效'); } }));
  add(A('assets ingest 缺 path → 400', 'POST', '/api/v2/assets/ingest', { token: true, body: {}, expectStatus: 400 }));
  add(A('assets tags 缺 tags → 400', 'POST', () => '/api/v2/assets/' + ctx.assetId + '/tags', { token: true, body: {}, expectStatus: 400 }));
  add(A('assets 未知素材 → 404', 'GET', '/api/v2/assets/asset_not_exist', { expectStatus: 404 }));
  add(A('basket 暂存', 'POST', '/api/v2/assets/basket', { token: true, body: () => ({ items: [{ assetId: ctx.assetId }], to: 'verify-pc' }), check: (r, c) => { assert(r.status === 200, 'status=' + r.status); assert(Array.isArray(r.json.added) && r.json.added.length === 1, '未暂存'); c.basketId = r.json.added[0].id; } }));
  add(A('basket 列表', 'GET', '/api/v2/assets/basket', { check: (r) => { assert(r.status === 200 && Array.isArray(r.json.items), '结构异常'); assert(r.json.items.length >= 1, '中转站为空'); } }));
  add(A('basket 取用', 'POST', '/api/v2/assets/basket/take', { token: true, body: { to: 'verify-pc', deviceId: 'verify-pc' }, check: (r) => assert(r.status === 200, 'status=' + r.status) }));
  add(A('basket 清空', 'DELETE', '/api/v2/assets/basket', { token: true, body: '', raw: true, check: (r) => { assert(r.status === 200, 'status=' + r.status); assert(r.json.remaining === 0, 'remaining 应为 0'); } }));

  // 场景 / 物模型（真实备份到临时目录）
  add(A('things 物模型', 'GET', '/api/v2/things/model', { check: (r) => assert(r.status === 200, 'status=' + r.status) }));
  add(A('scenes 列表', 'GET', '/api/v2/scenes'));
  add(A('scenes 创建真实备份场景', 'POST', '/api/v2/scenes', { token: true, body: () => ({ name: 'verify-backup-' + STAMP, steps: [{ actionId: 'asset.backup', params: { src: path.join(SCENE_ROOT, 'src.txt'), dir: path.join(SCENE_ROOT, 'out') } }] }), check: (r, c) => { assert([200, 201].includes(r.status), 'status=' + r.status); const s = (r.json.scene || r.json); assert(s.id, '未返回场景 id'); c.sceneId = s.id; } }));
  add(A('scenes 执行', 'POST', () => '/api/v2/scenes/' + ctx.sceneId + '/run', { token: true, body: { confirmed: true }, check: (r) => { assert([200, 201].includes(r.status), 'status=' + r.status); assert(fs.existsSync(path.join(SCENE_ROOT, 'out', 'src.txt')), '备份动作未真实落盘'); } }));
  add(A('scenes 创建空 body → 400', 'POST', '/api/v2/scenes', { token: true, body: {}, expectStatus: [400, 422] }));

  // 企业
  add(A('org users（需令牌）', 'GET', '/api/v2/org/users', { token: true, check: (r) => assert(r.status === 200, 'status=' + r.status) }));
  add(A('org policy', 'GET', '/api/v2/org/policy'));
  add(A('approvals 列表（需令牌）', 'GET', '/api/v2/approvals', { token: true, check: (r) => assert(r.status === 200, 'status=' + r.status) }));
  add(A('identity providers', 'GET', '/api/v2/org/identity/providers'));
  add(A('org actions（需令牌）', 'GET', '/api/v2/org/actions', { token: true, check: (r) => assert(r.status === 200, 'status=' + r.status) }));
  add(A('v2 审计导出 json（需令牌）', 'GET', '/api/v2/org/audit/export?format=json', { token: true, raw: true, check: (r) => assert(r.status === 200, 'status=' + r.status) }));
  add(A('org 新增成员', 'POST', '/api/v2/org/users', { token: true, body: { name: 'verify-member-' + STAMP, role: 'member' }, check: (r) => assert([200, 201].includes(r.status), 'status=' + r.status) }));

  // 设备（R1 之后存在，不存在自动 SKIP）
  add(A('devices 列表', 'GET', '/api/v2/devices', { check: (r, c) => { assert(r.status === 200, 'status=' + r.status); const arr = r.json.items || r.json.devices || []; assert(Array.isArray(arr), '结构异常'); c.deviceList = arr; if (arr[0]) c.deviceId = arr.find((d) => d && d.bound === false)?.id || arr[0].id; } }));
  add(A('devices 未知设备 bind → 404', 'POST', '/api/v2/devices/not-exist/bind', { token: true, body: {} , expectStatus: 404, optional: true }));
  add(A('devices 绑定', 'POST', () => '/api/v2/devices/' + ctx.deviceId + '/bind', { token: true, body: {}, optional: true, skipIf: () => !ctx.deviceId, check: (r) => assert([200, 201].includes(r.status), 'status=' + r.status) }));
  add(A('devices 重复绑定幂等', 'POST', () => '/api/v2/devices/' + ctx.deviceId + '/bind', { token: true, body: {}, optional: true, skipIf: () => !ctx.deviceId, check: (r) => assert(r.status === 200, 'status=' + r.status) }));
  add(A('devices 动作 hello', 'POST', () => '/api/v2/devices/' + ctx.deviceId + '/action', { token: true, body: { action: 'hello' }, optional: true, skipIf: () => !ctx.deviceId, check: (r) => assert([200, 201].includes(r.status), 'status=' + r.status) }));
  add(A('devices 未知动作 → 400', 'POST', () => '/api/v2/devices/' + ctx.deviceId + '/action', { token: true, body: { action: 'no-such-action' }, optional: true, skipIf: () => !ctx.deviceId, expectStatus: 400 }));
  add(A('devices 解绑', 'POST', () => '/api/v2/devices/' + ctx.deviceId + '/unbind', { token: true, body: { reason: 'verify' }, optional: true, skipIf: () => !ctx.deviceId, check: (r) => assert([200, 201].includes(r.status), 'status=' + r.status) }));

  return steps;
}

// ---------------- 主流程 ----------------
async function main() {
  mkdirp(LOG_DIR);
  mkdirp(RUN_DIR);
  mkdirp(SCENE_ROOT);
  fs.writeFileSync(path.join(SCENE_ROOT, 'src.txt'), 'verify backup ' + STAMP + '\n', 'utf8');
  const report = {
    stamp: new Date().toISOString(),
    kind: 'api-matrix',
    base: null,
    ports: { main: PORT, readOnly: RO_PORT },
    dataDir: null,
    summary: { total: 0, pass: 0, fail: 0, skip: 0 },
    cases: [],
  };
  let hub = null;
  let roHub = null;
  let token = TOKEN_ARG || null;
  let base = BASE_ARG || null;
  try {
    if (!base) {
      log('种子数据 → ' + DATA_DIR);
      const seed = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo.js'), '--fresh', '--data-dir', DATA_DIR], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
      if (seed.status !== 0) throw new Error('seed 失败：' + (seed.stderr || seed.stdout || '').slice(0, 500));

      log('启动主实例 :' + PORT);
      hub = startHub({ port: PORT, dataDir: DATA_DIR, name: 'main' });
      base = 'http://127.0.0.1:' + PORT;
      await waitFor(async () => (await req(base, 'GET', '/api/state')).status === 200, 30000, '主实例启动');
      token = readJson(path.join(DATA_DIR, 'secrets.json'), {}).operatorToken;
      if (!token) throw new Error('未找到 operatorToken');

      log('启动只读第二实例 :' + RO_PORT);
      roHub = startHub({ port: RO_PORT, dataDir: DATA_DIR, name: 'readonly' });
      await waitFor(async () => (await req('http://127.0.0.1:' + RO_PORT, 'GET', '/api/state')).status === 200, 30000, '只读实例启动');
      const roState = await req('http://127.0.0.1:' + RO_PORT, 'GET', '/api/state');
      if (!roState.json || roState.json.readOnly !== true) throw new Error('第二实例未进入只读模式');
    } else {
      base = base.replace(/\/+$/, '');
      const st = await req(base, 'GET', '/api/state');
      if (!st.json) throw new Error('目标实例不可用：' + base);
      if (!token) throw new Error('使用 --base 时必须提供 --token');
    }
    report.base = base;
    report.dataDir = DATA_DIR;
    const roBase = BASE_ARG ? null : 'http://127.0.0.1:' + RO_PORT;

    // ---- 路由库存 ----
    const health = await req(base, 'GET', '/api/v2/health');
    assert(health.status === 200 && health.json, '/api/v2/health 不可用');
    const inventory = (health.json.routes || []).map((r) => (typeof r === 'string' ? normRoute(r) : { method: r.method || 'GET', path: r.path })).filter((r) => r.path);
    record('discovery', { id: 'v2 路由清单', method: 'GET', path: '/api/v2/health', pass: inventory.length > 0, actual: inventory.length + ' 条', detail: JSON.stringify(health.json.modules || []) + ' routes=' + inventory.length });

    // ---- 矩阵 1：写路由未登录 401；GET 路由存活 ----
    for (const r of inventory) {
      const concrete = concretePath(r.path);
      if (r.method === 'GET') {
        if (String(r.path).includes('stream')) {
          record('get-alive', { id: 'GET ' + r.path, method: 'GET', path: concrete, expect: 'SSE', actual: 200, skip: true, detail: 'SSE 长连接，fetch 存活探针不适用（跳过）' });
          continue;
        }
        let res = await req(base, 'GET', concrete).catch((e) => ({ status: 0, text: String(e) }));
        let retried = false;
        if (res.status === 401 && token) {
          res = await req(base, 'GET', concrete, { token }).catch((e) => ({ status: 0, text: String(e) }));
          retried = true;
        }
        const ok = res.status >= 200 && res.status < 500 && !String(res.text || '').startsWith('<!doctype');
        record('get-alive', { id: 'GET ' + r.path, method: 'GET', path: concrete, expect: '2xx/4xx', actual: res.status, pass: ok, detail: 'status=' + res.status + (retried ? '（401 后带令牌重试）' : '') });
      } else {
        const res = await req(base, r.method, concrete, { body: {} }).catch((e) => ({ status: 0, text: String(e) }));
        record('unauth-401', { id: r.method + ' ' + r.path, method: r.method, path: concrete, expect: 401, actual: res.status, pass: res.status === 401, detail: res.text.slice(0, 160) });
      }
    }

    // ---- 矩阵 2：只读实例写 423 + 账本不变 ----
    if (roBase) {
      const before = eventCount(DATA_DIR);
      for (const r of inventory) {
        if (String(r.path).includes('stream')) {
          record('readonly-get', { id: 'GET ' + r.path, path: concretePath(r.path), expect: 'SSE', actual: 200, skip: true, detail: 'SSE 长连接，只读探针跳过' });
          continue;
        }
        if (r.method === 'GET') {
          const res = await req(roBase, 'GET', concretePath(r.path)).catch((e) => ({ status: 0, text: String(e) }));
          record('readonly-get', { id: 'GET ' + r.path, path: concretePath(r.path), expect: '!=423', actual: res.status, pass: res.status !== 423 && res.status < 500, detail: 'status=' + res.status });
        } else {
          const res = await req(roBase, r.method, concretePath(r.path), { token, body: {} }).catch((e) => ({ status: 0, text: String(e) }));
          record('readonly-423', { id: r.method + ' ' + r.path, method: r.method, path: concretePath(r.path), expect: 423, actual: res.status, pass: res.status === 423, detail: res.text.slice(0, 160) });
        }
      }
      await sleep(400);
      const after = eventCount(DATA_DIR);
      record('readonly-ledger', { id: '只读实例未写账本', path: 'events.jsonl', expect: before, actual: after, pass: before === after, detail: 'before=' + before + ' after=' + after });
    }

    // ---- 矩阵 3：核心业务 happy path / 错误路径 ----
    const ctx = {};
    const curated = buildCurated(ctx);
    for (const step of curated) {
      const pathname = typeof step.pathname === 'function' ? step.pathname() : step.pathname;
      const isV2Path = pathname.startsWith('/api/v2');
      if (isV2Path && !step.opts.noInventoryCheck && !routeExists(inventory, step.method, pathname)) {
        record('curated', { id: step.id, method: step.method, path: pathname, skip: true, detail: '路由未挂载（后续轮次新增）' });
        continue;
      }
      if (step.opts.skipIf && step.opts.skipIf()) {
        record('curated', { id: step.id, method: step.method, path: pathname, skip: true, detail: '依赖上下文缺失' });
        continue;
      }
      let body = step.opts.body;
      if (typeof body === 'function') body = body();
      const res = await req(base, step.method, pathname, { token: step.opts.token ? token : null, body, raw: !!step.opts.raw }).catch((e) => ({ status: 0, text: String(e), headers: new Headers() }));
      let pass = false;
      let detail = 'status=' + res.status;
      try {
        if (Array.isArray(step.opts.expectStatus)) assert(step.opts.expectStatus.includes(res.status), '期望 ' + step.opts.expectStatus.join('/') + '，实际 ' + res.status);
        else if (typeof step.opts.expectStatus === 'number') assert(res.status === step.opts.expectStatus, '期望 ' + step.opts.expectStatus + '，实际 ' + res.status);
        else if (step.opts.check) step.opts.check(res, ctx);
        else pass = [200, 201].includes(res.status);
        if (step.opts.expectStatus != null || step.opts.check) pass = true;
      } catch (e) {
        pass = false;
        detail = 'status=' + res.status + ' :: ' + String(e.message).slice(0, 300);
      }
      record('curated', { id: step.id, method: step.method, path: pathname, expect: step.opts.expectStatus || 'ok', actual: res.status, pass, detail });
    }

    // ---- 汇总 ----
    const sum = { total: cases.length, pass: 0, fail: 0, skip: 0 };
    for (const c of cases) {
      if (c.skip) sum.skip += 1;
      else if (c.pass) sum.pass += 1;
      else sum.fail += 1;
    }
    report.summary = sum;
    report.cases = cases;
    report.modules = health.json.modules || [];
    report.routes = inventory;
    report.inventoryCount = inventory.length;
    report.logs = logs;
    report.finishedAt = new Date().toISOString();
    mkdirp(OUT_DIR);
    const outFile = path.join(OUT_DIR, 'api-matrix.json');
    const runFile = path.join(OUT_DIR, 'api-matrix', 'run-' + STAMP + '.json');
    mkdirp(path.dirname(runFile));
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(runFile, JSON.stringify(report, null, 2), 'utf8');
    log('结果：' + sum.pass + ' PASS / ' + sum.fail + ' FAIL / ' + sum.skip + ' SKIP（共 ' + sum.total + '，v2 路由 ' + inventory.length + ' 条）');
    log('明细：' + path.relative(ROOT, outFile));
    if (sum.fail > 0) {
      log('FAIL 用例：');
      for (const c of cases.filter((x) => !x.pass && !x.skip)) log('  ✗ [' + c.group + '] ' + c.method + ' ' + c.path + ' :: ' + c.detail);
      process.exitCode = 1;
    }
  } catch (err) {
    record('fatal', { id: '执行异常', pass: false, detail: String((err && err.message) || err) });
    const sum = { total: cases.length, pass: cases.filter((c) => c.pass).length, fail: cases.filter((c) => !c.pass && !c.skip).length, skip: cases.filter((c) => c.skip).length };
    report.summary = sum;
    report.cases = cases;
    report.error = String((err && err.stack) || err);
    report.finishedAt = new Date().toISOString();
    mkdirp(OUT_DIR);
    fs.writeFileSync(path.join(OUT_DIR, 'api-matrix.json'), JSON.stringify(report, null, 2), 'utf8');
    log('执行失败：' + String((err && err.message) || err));
    process.exitCode = 1;
  } finally {
    killTree(roHub);
    killTree(hub);
    await sleep(500);
    if (!KEEP && !BASE_ARG) {
      try { rmrf(RUN_DIR); } catch { /* ignore */ }
    } else if (KEEP) {
      log('保留运行目录：' + RUN_DIR);
    }
  }
}

main();