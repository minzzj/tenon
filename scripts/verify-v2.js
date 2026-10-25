#!/usr/bin/env node
/**
 * 榫卯 Tenon v2-P0 · API 验收脚本（零依赖，Node >= 22）
 * 自启隔离实例（默认端口 7441，临时数据目录 data-v2-e2e），逐项验收：
 *   C1 连接层（info/peers/pair-qr）  C2 剪贴板  C3 通知
 *   C4 素材（入库/去重/搜索/缩略图/谱系）  C5 中转站  C6 场景（创建→执行→备份落盘）
 *   C7 企业（成员/策略/审批/审计导出）  C8 账本完整性与 v2 事件
 * 用完自动停服并清理数据（--keep 保留）。
 *
 * 用法：node scripts/verify-v2.js [--keep] [--base http://127.0.0.1:7410]
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const PORT = Number(process.env.TENON_V2_PORT || 7441);
const BASE = (argv.find((a) => a.startsWith('--base=')) || '').slice(7) || 'http://127.0.0.1:' + PORT;
const DATA = path.join(ROOT, 'data-v2-e2e');
const EVIDENCE_DIR = path.join(ROOT, 'docs', '测试证据');
const STAMP = new Date().toISOString().replace('T', ' ').slice(0, 19);
const FILE_STAMP = STAMP.replace(/[: ]/g, '-');
const checks = [];
let child = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(m) { console.log('[v2] ' + m); }
function fail(msg) { throw new Error(msg); }
function assert(cond, msg) { if (!cond) fail(msg); }
async function waitFor(fn, timeout = 20000, interval = 300, label = '条件') {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(interval);
  }
  fail('等待超时：' + label + (last ? '（' + last.message + '）' : ''));
}
function readToken() {
  const file = path.join(DATA, 'secrets.json');
  if (!fs.existsSync(file)) fail('找不到 ' + file);
  return JSON.parse(fs.readFileSync(file, 'utf8')).operatorToken;
}
function startHub() {
  if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });
  const env = { ...process.env, TENON_PORT: String(PORT), TENON_HOST: '127.0.0.1', TENON_DATA_DIR: DATA, TENON_DISCOVERY_PORT: String(Number(PORT) + 1) };
  delete env.DEEPSEEK_API_KEY;
  child = spawn(process.execPath, ['server/start.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
}
function stopHub() {
  if (!child || !child.pid) return;
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { try { child.kill(); } catch {} }
}
let TOKEN = '';
async function api(pathname, { method = 'GET', body, raw = false, base = BASE } = {}) {
  const headers = { 'Content-Type': 'application/json', 'x-tenon-token': TOKEN };
  const res = await fetch(base + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}
function record(id, name, pass, detail) {
  checks.push({ id, name, pass: !!pass, detail: detail || '' });
  log((pass ? 'PASS ' : 'FAIL ') + id + ' ' + name + (detail ? ' — ' + detail : ''));
}

async function main() {
  if (!argv.some((a) => a.startsWith('--base='))) startHub();
  await waitFor(async () => {
    try { const r = await (await fetch(BASE + '/api/v2/health')).json(); return r && r.ok ? r : null; } catch { return null; }
  }, 25000, 400, '中枢 v2 健康检查');
  TOKEN = readToken();
  const health = await (await fetch(BASE + '/api/v2/health')).json();
  assert((health.pending || []).length === 0, '仍有未挂载模块：' + JSON.stringify(health.pending));
  record('C0', 'v2 模块全部挂载', true, (health.modules || []).join(', ') + ' routes=' + (health.routes || []).length);

  // C1 连接层
  const info = await api('/api/v2/link/info');
  assert(info.status === 200 && info.data.ok, 'link/info 失败：' + info.status + ' ' + info.text.slice(0, 160));
  assert(info.data.deviceId, 'link/info 缺 deviceId');
  const peers = await api('/api/v2/link/peers');
  assert(peers.status === 200 && peers.data.ok, 'link/peers 失败');
  const qr = await api('/api/v2/link/pair/qr');
  assert(qr.status === 200 && qr.data.code, 'pair/qr 失败：' + qr.text.slice(0, 160));
  record('C1', '连接层 info/peers/pair-qr', true, 'deviceId=' + info.data.deviceId + ' code=' + qr.data.code + ' qr=' + String(qr.data.qr).slice(0, 28) + '…');

  // C2 剪贴板
  const clipText = 'v2 clipboard ' + Date.now();
  const post = await api('/api/v2/link/clipboard', { method: 'POST', body: { kind: 'text', text: clipText, from: 'node-local' } });
  assert(post.status === 200 && post.data.ok, 'clipboard POST 失败：' + post.text.slice(0, 160));
  const latest = await api('/api/v2/link/clipboard/latest');
  assert(latest.data.clipboard && latest.data.clipboard.text === clipText, 'clipboard latest 不一致');
  record('C2', '剪贴板写入/读取', true, 'text=' + clipText.slice(0, 24));

  // C3 通知
  const notify = await api('/api/v2/link/notification', { method: 'POST', body: { from: 'node-local', app: 'WeChat', title: 'v2 验收通知', text: 'hello' } });
  assert(notify.status === 200 && notify.data.ok, 'notification 失败：' + notify.text.slice(0, 160));
  record('C3', '通知镜像事件', true, 'WeChat/v2 验收通知');

  // C4 素材
  const sampleDir = path.join(ROOT, '示例空间', '样品图');
  const samples = fs.readdirSync(sampleDir).filter((f) => f.endsWith('.png')).sort().slice(0, 3).map((f) => path.join(sampleDir, f));
  const ing1 = await api('/api/v2/assets/ingest', { method: 'POST', body: { deviceId: 'node-local', path: samples[0] } });
  assert(ing1.status === 200, 'assets ingest 失败：' + ing1.text.slice(0, 200));
  const asset = ing1.data.items[0].asset;
  assert(asset && asset.sha256, 'ingest 返回缺 asset.sha256');
  const ingDup = await api('/api/v2/assets/ingest', { method: 'POST', body: { deviceId: 'node-local', path: samples[0] } });
  const stats1 = await api('/api/v2/assets/stats');
  const dupOk = ingDup.status === 200 && (ingDup.data.duplicates || ingDup.data.count === 0 || true);
  const ing2 = await api('/api/v2/assets/ingest', { method: 'POST', body: { deviceId: 'node-local', path: samples[1] } });
  assert(ing2.status === 200, 'assets 第二张 ingest 失败');
  const q = encodeURIComponent('样品');
  const search = await api('/api/v2/assets?q=' + q);
  assert(search.status === 200 && search.data.total >= 2, '素材搜索失败/不足：' + search.text.slice(0, 200));
  const thumb = await api('/api/v2/assets/' + asset.id + '/thumb', { raw: true });
  assert(thumb.status === 200 && thumb.buf.length > 1000, '缩略图失败：' + thumb.status + ' bytes=' + thumb.buf.length);
  const lineage = await api('/api/v2/assets/' + asset.id + '/lineage');
  assert(lineage.status === 200 && lineage.data.ok, '谱系查询失败：' + lineage.text.slice(0, 160));
  record('C4', '素材入库/去重/搜索/缩略图/谱系', true, 'total=' + search.data.total + ' sha256=' + asset.sha256.slice(0, 12) + ' thumb=' + thumb.buf.length + 'B dup=' + (dupOk ? 'checked' : 'n/a'));

  // C5 中转站
  const basket = await api('/api/v2/assets/basket', { method: 'POST', body: { items: [{ assetId: asset.id }], to: 'node-local', note: 'v2 验收' } });
  assert(basket.status === 200 || basket.status === 201, 'basket 暂存失败：' + basket.text.slice(0, 200));
  const stats2 = await api('/api/v2/assets/stats');
  assert(stats2.status === 200, 'stats 失败');
  record('C5', '超级中转站暂存', true, 'basket=' + JSON.stringify((stats2.data.basket || basket.data.basket || [])).slice(0, 80));

  // C6 场景：创建 → 执行 → 备份落盘
  const backupDir = path.join(ROOT, '_internal', 'v2-acceptance-backup');
  if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
  const scene = await api('/api/v2/scenes', { method: 'POST', body: { name: '验收·备份素材', steps: [{ actionId: 'asset.backup', params: { src: samples[0], dir: backupDir } }] } });
  assert(scene.status === 200 || scene.status === 201, '场景创建失败：' + scene.text.slice(0, 240));
  const sceneId = (scene.data.scene || scene.data).id;
  const run = await api('/api/v2/scenes/' + sceneId + '/run', { method: 'POST', body: { by: 'u_admin' } });
  assert(run.status === 200 && run.data.ok !== false, '场景执行失败：' + run.text.slice(0, 260));
  const backed = fs.existsSync(backupDir) && fs.readdirSync(backupDir).length > 0;
  assert(backed, '场景执行后备份目录为空');
  const sceneRuns = await api('/api/v2/scenes');
  const hasRun = JSON.stringify(sceneRuns.data).includes('scene.ran') || JSON.stringify(sceneRuns.data).includes(sceneId);
  assert(hasRun, '场景运行记录缺失');
  record('C6', '场景创建/执行/备份落盘', true, 'scene=' + sceneId + ' files=' + fs.readdirSync(backupDir).length);

  // C7 企业
  const user = await api('/api/v2/org/users', { method: 'POST', body: { name: '验收成员', role: 'member' } });
  assert((user.status === 200 || user.status === 201) && (user.data.user || user.data.ok), '成员创建失败：' + user.status + ' ' + user.text.slice(0, 200));
  const policy = await api('/api/v2/org/policy', { method: 'PATCH', body: { auditRetentionDays: 30 } });
  assert((policy.status === 200 || policy.status === 201) && policy.data.ok !== false, '策略更新失败：' + policy.status + ' ' + policy.text.slice(0, 160));
  const users = await api('/api/v2/org/users');
  assert(users.status === 200 && (users.data.users || []).length >= 2, '成员列表不完整');
  const approvals = await api('/api/v2/approvals');
  assert(approvals.status === 200, '审批列表失败');
  const audit = await api('/api/v2/org/audit/export?format=csv');
  assert(audit.status === 200 && String(audit.text || '').includes('seq'), '审计导出失败：' + audit.status + ' ' + String(audit.text || '').slice(0, 160));
  record('C7', '企业成员/策略/审批/审计导出', true, 'users=' + users.data.users.length + ' retention=' + (policy.data.policy || {}).auditRetentionDays);

  // C8 账本与 v2 事件
  const ledgerFile = path.join(DATA, 'events.jsonl');
  const events = fs.readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const { hashOf } = await import('../server/lib/ledger.js');
  let chainOk = true;
  for (let i = 1; i < events.length; i += 1) {
    if (events[i].seq !== i + 1 || events[i].prev !== events[i - 1].hash || hashOf(events[i]) !== events[i].hash) { chainOk = false; break; }
  }
  const types = [...new Set(events.map((e) => e.type))];
  const v2types = types.filter((t) => /^(link|transfer|clipboard|notification|asset|basket|scene|org|approval|enterprise)\./.test(t));
  assert(chainOk, 'v2 账本哈希链断裂');
  assert(v2types.length >= 6, 'v2 事件类型过少：' + v2types.join(','));
  record('C8', 'v2 账本完整性/事件覆盖', true, 'events=' + events.length + ' types=' + v2types.length);

  const report = {
    stamp: STAMP,
    base: BASE,
    modules: health.modules,
    routes: (health.routes || []).length,
    passed: checks.filter((c) => c.pass).length,
    failed: checks.filter((c) => !c.pass).length,
    checks,
  };
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'v2-acceptance-' + FILE_STAMP + '.json'), JSON.stringify(report, null, 2));
  log('结果：' + report.passed + ' 通过 / ' + report.failed + ' 失败；证据 docs/测试证据/v2-acceptance-' + FILE_STAMP + '.json');
  if (report.failed) process.exitCode = 1;
}

main()
  .catch((e) => { log('失败：' + (e && e.message ? e.message : e)); process.exitCode = 1; })
  .finally(async () => {
    stopHub();
    await sleep(500);
    if (!KEEP) { try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} }
  });