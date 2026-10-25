// 榫卯 v2.1 · 超级终端桌面动作单测（node:test）
// 覆盖：manifest / 程序目录解析与安全校验 / app.list / handoff URL 构造 / 真实 app.launch(notepad)
//       以及 agent 走 task pull 派发 app.list、app.launch 的能力执行链路
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStubHub } from './stub-hub.mjs';
import { appCapabilities, appsManifest, resolveApp, listApps, findOnPath, buildHandoffUrl, findAppCapability } from '../apps.js';
import { runPowerShell, wrapResultScript, makeTempDir, removeTempDir, readUtf8Json } from '../lib/ps.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-apps-test-'));
const AGENT_DATA = path.join(TMP, 'agent-data');
fs.mkdirSync(AGENT_DATA, { recursive: true });
fs.writeFileSync(path.join(AGENT_DATA, 'secrets.json'), JSON.stringify({ operatorToken: 'operator-token-test', nodeToken: 'node-token-test' }, null, 2));
process.env.TENON_DATA_DIR = AGENT_DATA;
process.env.TENON_HUB_URL = 'http://127.0.0.1:1';
const agentMod = await import('../agent.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let hub;

before(async () => {
  hub = await startStubHub();
});
after(async () => {
  if (hub) await hub.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function psJson(body) {
  const dir = makeTempDir('tenon-apps-ps-');
  try {
    const resultFile = `${dir}\\result.json`;
    const run = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(wrapResultScript(body, resultFile), 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const parsed = readUtf8Json(resultFile);
    if (!parsed) throw new Error(`PowerShell 未返回结果：${run.slice(0, 120)}`);
    return parsed;
  } finally {
    removeTempDir(dir);
  }
}
function killProcessByName(name) {
  try {
    psJson(`$result = @{ ok = $false }
Get-Process -Name ${JSON.stringify(name)} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$result.ok = $true`);
  } catch {
    /* ignore */
  }
}
async function waitFor(fn, label, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return true;
    await sleep(120);
  }
  throw new Error(`等待超时：${label}`);
}

// ---------- manifest ----------
test('apps：5 个超级终端动作 manifest 字段齐全、risk=reversible、manualOnly=false', () => {
  assert.equal(appCapabilities.length, 5);
  assert.equal(appsManifest.length, 5);
  const ids = appsManifest.map((item) => item.id).sort().join(',');
  assert.equal(ids, 'app.launch,app.list,handoff.show,media.show,url.open');
  for (const manifest of appsManifest) {
    for (const key of ['id', 'name', 'risk', 'manualOnly', 'version', 'evidence', 'inputs', 'outputs']) {
      assert.ok(key in manifest, `${manifest.id} 缺字段 ${key}`);
    }
    assert.equal(manifest.risk, 'reversible', `${manifest.id} risk 应为 reversible`);
    assert.equal(manifest.manualOnly, false, `${manifest.id} manualOnly 应为 false`);
  }
  assert.equal(findAppCapability('app.list').id, 'app.list');
  assert.equal(JSON.stringify(appsManifest).includes('run'), false);
});

// ---------- 解析与安全 ----------
test('apps：内置程序名/别名解析到真实路径或协议', () => {
  const notepad = resolveApp('notepad');
  assert.equal(notepad.kind, 'path');
  assert.ok(notepad.target.toLowerCase().endsWith('notepad.exe'));
  const alias = resolveApp('记事本');
  assert.equal(alias.kind, 'path');
  assert.equal(resolveApp('计算器').kind, 'path');
  const settings = resolveApp('设置');
  assert.equal(settings.kind, 'protocol');
  assert.equal(settings.target, 'ms-settings:');
  // Chrome 本机已安装（若未安装则允许报"未安装"错误）
  try {
    const chrome = resolveApp('chrome');
    assert.ok(chrome.target.toLowerCase().includes('chrome.exe'));
  } catch (err) {
    assert.ok(String(err.message).includes('未安装'));
  }
  // 完整路径
  const byPath = resolveApp(process.execPath);
  assert.equal(byPath.kind, 'path');
  // URL 直接用默认浏览器
  const url = resolveApp('https://github.com');
  assert.equal(url.kind, 'url');
});

test('apps：拒绝注入/非法输入（shell 元字符、引号、控制字符、不存在的路径、未知程序）', () => {
  for (const bad of ['notepad & calc', 'notepad;calc', 'notepad|calc', '"C:\\Windows\\notepad.exe"', 'calc\nshutdown', '不存在的程序xyz']) {
    assert.throws(() => resolveApp(bad), (err) => err instanceof Error && err.message.length > 0, `应拒绝：${JSON.stringify(bad)}`);
  }
  assert.throws(() => resolveApp(''), /缺少参数 app/);
  assert.throws(() => resolveApp('C:\\不存在的目录\\evil.exe'), /路径不存在/);
  // 未知程序错误里带可用列表
  try {
    resolveApp('不存在的程序xyz');
  } catch (err) {
    assert.ok(err.message.includes('可用'), '错误应包含可用列表');
  }
});

test('apps：findOnPath / listApps 返回真实本机清单', () => {
  assert.ok(String(findOnPath('notepad.exe') || '').toLowerCase().endsWith('notepad.exe'));
  assert.equal(findOnPath('definitely-not-a-command-xyz-123'), null);
  const apps = listApps();
  assert.equal(apps.length, 12);
  const byId = Object.fromEntries(apps.map((app) => [app.id, app]));
  assert.equal(byId.notepad.available, true);
  assert.equal(byId.explorer.available, true);
  assert.ok(byId.notepad.target.toLowerCase().endsWith('notepad.exe'));
  for (const app of apps) {
    assert.ok(['available', 'mode', 'target', 'name', 'id'].every((key) => key in app));
    assert.ok(typeof app.available === 'boolean');
  }
  assert.ok(apps.filter((app) => app.available).length >= 6, '本机应至少有 6 个内置程序可用');
});

test('apps：handoff URL 构造（编码/默认中枢/截断）', () => {
  const url = buildHandoffUrl({ kind: 'page', url: 'https://github.com/minzzj/tenon', text: '手机甩来的页面', hubUrl: 'http://127.0.0.1:7410/' });
  assert.ok(url.startsWith('http://127.0.0.1:7410/#/handoff?'));
  const parsed = new URL(url);
  assert.equal(parsed.hash.startsWith('#/handoff?'), true);
  const query = new URLSearchParams(parsed.hash.split('?')[1]);
  assert.equal(query.get('kind'), 'page');
  assert.equal(query.get('url'), 'https://github.com/minzzj/tenon');
  assert.equal(query.get('text'), '手机甩来的页面');
  const longText = buildHandoffUrl({ kind: 'text', text: 'x'.repeat(5000), hubUrl: 'http://h:1' });
  assert.ok(longText.length < 5000 + 200, '超长文本应截断到 2000 字');
});

// ---------- 参数校验（不真正启动） ----------
test('apps：各能力缺参/非法参报错清晰', async () => {
  const ctx = { repoRoot: path.resolve(HERE, '..'), dataDir: path.join(TMP, 'data'), hubUrl: 'http://127.0.0.1:7410' };
  await assert.rejects(() => findAppCapability('app.launch').run({ params: {} }, ctx), /缺少参数 app/);
  await assert.rejects(() => findAppCapability('url.open').run({ params: {} }, ctx), /缺少参数 url/);
  await assert.rejects(() => findAppCapability('url.open').run({ params: { url: 'javascript:alert(1)' } }, ctx), /URL 不合法/);
  await assert.rejects(() => findAppCapability('url.open').run({ params: { url: 'file:///C:/Windows' } }, ctx), /URL 不合法/);
  await assert.rejects(() => findAppCapability('media.show').run({ params: {} }, ctx), /缺少参数 path/);
  await assert.rejects(() => findAppCapability('media.show').run({ params: { path: '示例空间/不存在-xyz.png' } }, ctx), /文件不存在/);
  await assert.rejects(() => findAppCapability('handoff.show').run({ params: { kind: 'weird' } }, ctx), /不支持的 kind/);
  await assert.rejects(() => findAppCapability('handoff.show').run({ params: { kind: 'page' } }, ctx), /需要 url 或 text/);
  await assert.rejects(() => findAppCapability('handoff.show').run({ params: { kind: 'page', url: 'javascript:alert(1)' } }, ctx), /url 不合法/);
});

// ---------- 真实执行：app.launch(notepad) ----------
test('apps：真实 app.launch("notepad") 启动进程并可验证', { skip: !WIN }, async () => {
  killProcessByName('notepad');
  await sleep(400);
  const ctx = { repoRoot: path.resolve(HERE, '..'), dataDir: path.join(TMP, 'data'), hubUrl: 'http://127.0.0.1:7410' };
  const result = await findAppCapability('app.launch').run({ params: { app: 'notepad' } }, ctx);
  assert.equal(result.partial, false);
  assert.ok(result.summary.includes('记事本'), `summary=${result.summary}`);
  // 进程验证（最多等 5 秒）
  await waitFor(() => {
    try {
      const out = psJson(`$p = Get-Process -Name notepad -ErrorAction SilentlyContinue | Select-Object -First 1
$result = @{ ok = [bool]$p; pid = if ($p) { $p.Id } else { $null } }`);
      return out.ok === true;
    } catch {
      return false;
    }
  }, '记事本进程出现', 8000);
  killProcessByName('notepad');
});

// ---------- agent 走 task pull 派发 ----------
test('agent：task pull 派发 app.list 与 app.launch 均能执行并回报', { skip: !WIN }, async () => {
  const agent = new agentMod.NodeAgent({ hubUrl: hub.url, v2Enabled: true });
  agent.token = 'node-token-test';
  const before = hub.state.nodeEvents.length;
  await agent.handleTask({ id: 'task_super_applist', capabilityId: 'app.list', params: {} });
  const listed = hub.state.nodeEvents.slice(before).find((event) => event.type === 'task.succeeded' && event.data.taskId === 'task_super_applist');
  assert.ok(listed, 'app.list 应回报 task.succeeded');
  assert.ok(listed.data.result.summary.includes('可用程序'));
  assert.equal(listed.data.result.items.length, 12);
  // app.launch 通过任务执行（真实进程）
  killProcessByName('notepad');
  const before2 = hub.state.nodeEvents.length;
  await agent.handleTask({ id: 'task_super_applaunch', capabilityId: 'app.launch', params: { app: 'notepad' } });
  const launched = hub.state.nodeEvents.slice(before2).find((event) => event.type === 'task.succeeded' && event.data.taskId === 'task_super_applaunch');
  assert.ok(launched, 'app.launch 应回报 task.succeeded');
  assert.ok(launched.data.result.summary.includes('记事本'));
  await waitFor(() => {
    try {
      const out = psJson(`$p = Get-Process -Name notepad -ErrorAction SilentlyContinue | Select-Object -First 1
$result = @{ ok = [bool]$p }`);
      return out.ok === true;
    } catch {
      return false;
    }
  }, '任务派发后记事本进程出现', 8000);
  killProcessByName('notepad');
  // 非法参数 → task.failed（清晰错误）
  const before3 = hub.state.nodeEvents.length;
  await agent.handleTask({ id: 'task_super_badurl', capabilityId: 'url.open', params: { url: 'javascript:alert(1)' } });
  const failed = hub.state.nodeEvents.slice(before3).find((event) => event.type === 'task.failed' && event.data.taskId === 'task_super_badurl');
  assert.ok(failed && failed.data.error.includes('URL 不合法'), '非法 URL 应回报 task.failed');
});