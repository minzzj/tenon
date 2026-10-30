// 榫卯 V4 · node-agent 执行器能力单测（node:test）
// 覆盖：危险词拒绝 / 命令回显与退出码 / cwd / 超时杀进程树 / 本地审计 /
//       窗口枚举与聚焦 / 全屏与区域截屏（PNG 非空）/ manifest / agent 注册与 task 执行透传
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStubHub } from './stub-hub.mjs';
import {
  V4_VERSION,
  v4Capabilities,
  v4Manifest,
  findV4Capability,
  checkDangerousCommand,
  truncateOutput,
  execCommand,
  auditFileOf,
  listVisibleWindows,
  focusWindow,
  validateFocusParams,
  captureScreen,
  validateRegion,
} from '../v4.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-v4-test-'));
const DATA = path.join(TMP, 'data');
const AGENT_DATA = path.join(TMP, 'agent-data');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(AGENT_DATA, { recursive: true });
fs.writeFileSync(path.join(AGENT_DATA, 'secrets.json'), JSON.stringify({ operatorToken: 'op-token-v4', nodeToken: 'node-token-v4' }, null, 2));
process.env.TENON_DATA_DIR = AGENT_DATA;
process.env.TENON_HUB_URL = 'http://127.0.0.1:1';
const agentMod = await import('../agent.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ctx = { repoRoot: path.resolve(HERE, '..'), dataDir: DATA, nodeId: 'node-local', nodeName: 'V4 测试节点', taskId: 'task_v4_test' };
let hub;

before(async () => {
  hub = await startStubHub();
});
after(async () => {
  if (hub) await hub.close();
  killNotepad();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function ps(cmd, timeout = 20000) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout, windowsHide: true });
}
function killNotepad() {
  try {
    ps('Get-Process -Name notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; "ok"', 15000);
  } catch {
    /* ignore */
  }
}
function notepadRunning() {
  try {
    const out = ps('@(Get-Process -Name notepad -ErrorAction SilentlyContinue).Count', 15000).trim();
    return Number(out) > 0;
  } catch {
    return false;
  }
}
async function waitFor(fn, label, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return true;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
}

// ---------------------------------------------------------------- 危险词与工具
test('v4：manifest 4 个能力字段齐全，system.exec 标为不可逆', () => {
  assert.equal(V4_VERSION, '4.0.0');
  assert.equal(v4Capabilities.length, 4);
  assert.equal(v4Manifest.length, 4);
  const ids = v4Manifest.map((cap) => cap.id).sort().join(',');
  assert.equal(ids, 'screen.capture,system.exec,window.focus,window.list');
  for (const manifest of v4Manifest) {
    for (const key of ['id', 'name', 'risk', 'manualOnly', 'version', 'evidence', 'inputs', 'outputs']) {
      assert.ok(key in manifest, `${manifest.id} 缺字段 ${key}`);
    }
  }
  assert.equal(findV4Capability('system.exec').risk, 'irreversible');
  assert.equal(findV4Capability('system.exec').manualOnly, false);
  for (const id of ['window.list', 'window.focus', 'screen.capture']) {
    assert.equal(findV4Capability(id).risk, 'reversible');
  }
  assert.equal(JSON.stringify(v4Manifest).includes('run'), false);
});

test('v4：危险命令黑名单（格式化/关机/diskpart/reg delete/递归删除等）全部拒绝', () => {
  const dangerous = [
    'format c: /q',
    'shutdown /s /t 0',
    'diskpart',
    'reg delete HKLM\\Software\\Test /f',
    'del /s /q C:\\Windows\\Temp',
    'rm -rf /',
    'remove-item C:\\ -recurse',
    'vssadmin delete shadows /all',
    'bcdedit /set {default} safeboot minimal',
    'wmic process where name="x" delete',
    'powershell -enc ZQBjAGgAbwA=',
  ];
  for (const command of dangerous) {
    const hit = checkDangerousCommand(command);
    assert.ok(hit && hit.dangerous, `应拒绝：${command}`);
    assert.ok(hit.reason.length > 0);
  }
  const safe = ['dir', 'echo hello', 'git status', 'ipconfig /all', 'dir C:\\Users', 'node --version', 'ping -n 1 127.0.0.1'];
  for (const command of safe) {
    assert.equal(checkDangerousCommand(command), null, `不应拒绝：${command}`);
  }
});

test('v4：truncateOutput 截断 4000 字并标注原始长度', () => {
  const short = truncateOutput('hello');
  assert.equal(short.truncated, false);
  assert.equal(short.text, 'hello');
  const long = truncateOutput('x'.repeat(5000));
  assert.equal(long.truncated, true);
  assert.equal(long.originalLength, 5000);
  assert.ok(long.text.length < 5000 + 120);
  assert.ok(long.text.includes('已截断'));
});

test('v4：参数校验（空命令/超长/换行、非法 region、focus 缺参）', async () => {
  await assert.rejects(() => execCommand({ command: '' }, ctx), /缺少参数 command/);
  await assert.rejects(() => execCommand({ command: 'a'.repeat(2001) }, ctx), /过长/);
  await assert.rejects(() => execCommand({ command: 'echo a\nb' }, ctx), /换行/);
  assert.throws(() => validateRegion({ x: 0, y: 0, width: 0, height: 10 }), /宽高/);
  assert.throws(() => validateRegion({ x: 'a', y: 0, width: 10, height: 10 }), /数字/);
  assert.throws(() => validateFocusParams({}), /至少给一个/);
});

// ---------------------------------------------------------------- system.exec 真实执行
test('v4：system.exec 回显正确（stdout/stderr/退出码/cwd）', { skip: !WIN }, async () => {
  const okResult = await execCommand({ command: 'echo TENON_V4_OK' }, ctx);
  assert.equal(okResult.ok, true);
  assert.equal(okResult.exitCode, 0);
  assert.ok(okResult.stdout.includes('TENON_V4_OK'), `stdout=${okResult.stdout}`);
  assert.equal(typeof okResult.durationMs, 'number');
  assert.ok(okResult.durationMs >= 0);
  const errResult = await execCommand({ command: 'echo ERR_LINE 1>&2' }, ctx);
  assert.ok(errResult.stderr.includes('ERR_LINE'), `stderr=${errResult.stderr}`);
  const failResult = await execCommand({ command: 'exit /b 7' }, ctx);
  assert.equal(failResult.ok, false);
  assert.equal(failResult.exitCode, 7);
  const zhResult = await execCommand({ command: 'echo 中文回显测试-榫卯', cwd: TMP }, ctx);
  assert.ok(zhResult.stdout.includes('中文回显测试-榫卯'), `中文 stdout 应正确（UTF-8）：${zhResult.stdout}`);
  const cwdResult = await execCommand({ command: 'cd', cwd: TMP }, ctx);
  assert.equal(fs.realpathSync(String(cwdResult.stdout).trim().toLowerCase()), fs.realpathSync(TMP.toLowerCase()), `cwd out=${cwdResult.stdout}`);
});

test('v4：system.exec 超时 kill 进程树（ping 8 次 + 1.2s 超时）', { skip: !WIN }, async () => {
  const started = Date.now();
  const result = await execCommand({ command: 'ping -n 8 127.0.0.1', timeoutMs: 1200 }, ctx);
  const elapsed = Date.now() - started;
  assert.equal(result.timeout, true);
  assert.equal(result.ok, false);
  assert.ok(elapsed < 12000, `耗时 ${elapsed}ms 应远小于 ping 8 次的 7s+`);
  assert.ok(result.durationMs < 12000);
});

test('v4：所有执行（含被拒绝的）写 data/exec-audit.log', { skip: !WIN }, async () => {
  const audit = auditFileOf(ctx);
  try { fs.rmSync(audit, { force: true }); } catch { /* ignore */ }
  await execCommand({ command: 'echo AUDIT_ONE' }, ctx);
  try {
    await execCommand({ command: 'format d: /q' }, ctx);
    assert.fail('危险命令应被拒绝');
  } catch (err) {
    assert.ok(String(err.message).includes('拒绝'));
  }
  assert.ok(fs.existsSync(audit), '审计文件应存在');
  const lines = fs.readFileSync(audit, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(lines.length >= 2, `审计行数 ${lines.length}`);
  assert.ok(lines.some((line) => line.rejected === true && String(line.reason).includes('格式化')));
  assert.ok(lines.some((line) => !line.rejected && String(line.command).includes('AUDIT_ONE') && line.ok === true));
});

// ---------------------------------------------------------------- window
test('v4：window.list 枚举真实可见窗口（非空、字段完整、≤50）', { skip: !WIN }, async () => {
  const result = await listVisibleWindows({ ctx });
  assert.ok(result.count >= 1, '应至少枚举到 1 个可见窗口');
  assert.ok(result.count <= 50);
  assert.ok(Array.isArray(result.windows));
  const first = result.windows[0];
  for (const key of ['handle', 'title', 'pid', 'process', 'foreground', 'minimized']) {
    assert.ok(key in first, `窗口字段缺 ${key}`);
  }
  assert.equal(typeof first.title, 'string');
  assert.ok(first.title.length > 0);
});

test('v4：window.focus 按进程名激活记事本窗口，失败给可读错误', { skip: !WIN }, async () => {
  killNotepad();
  await sleep(300);
  await ps('Start-Process notepad.exe', 15000);
  await waitFor(() => notepadRunning(), '记事本进程出现', 12000);
  await sleep(800);
  const focused = await focusWindow({ process: 'notepad' });
  assert.ok(String(focused.title).length > 0);
  assert.equal(String(focused.process).toLowerCase(), 'notepad');
  await assert.rejects(() => focusWindow({ title: '绝对不存在的窗口标题-XYZ-123' }), /未找到匹配的窗口/);
  killNotepad();
});

// ---------------------------------------------------------------- screen.capture
test('v4：screen.capture 全屏/区域 PNG 非空且尺寸正确；base64 可选', { skip: !WIN }, async () => {
  const full = await captureScreen({}, ctx);
  assert.ok(fs.existsSync(full.path), '截图文件应存在');
  assert.ok(full.bytes > 1000, `截图字节 ${full.bytes}`);
  assert.ok(full.width > 0 && full.height > 0);
  const head = fs.readFileSync(full.path).subarray(0, 4);
  assert.equal(head.toString('hex'), '89504e47', 'PNG 签名');
  const region = await captureScreen({ region: { x: 0, y: 0, width: 320, height: 240 } }, ctx);
  assert.equal(region.width, 320);
  assert.equal(region.height, 240);
  assert.ok(region.bytes > 100);
  assert.ok(region.path.startsWith(path.join(DATA, 'screen')), `截图应落在 data/screen：${region.path}`);
  const withBase64 = await captureScreen({ region: { x: 0, y: 0, width: 200, height: 120 }, base64: true }, ctx);
  assert.equal(typeof withBase64.base64, 'string');
  assert.ok(withBase64.base64.startsWith('iVBOR'), 'base64 应为 PNG');
  const buffer = Buffer.from(withBase64.base64, 'base64');
  assert.equal(buffer.subarray(0, 4).toString('hex'), '89504e47');
});

// ---------------------------------------------------------------- agent 集成
test('agent：TENON_V2 注册 20 项能力（含 4 个 V4 执行器能力）', async () => {
  const agent = new agentMod.NodeAgent({ hubUrl: hub.url, v2Enabled: true });
  assert.equal(agent.activeManifest.length, 20);
  await agent.register();
  const body = hub.state.registerBodies[hub.state.registerBodies.length - 1];
  assert.equal(body.capabilities.length, 20);
  const ids = body.capabilities.map((cap) => cap.id);
  for (const id of ['system.exec', 'window.list', 'window.focus', 'screen.capture']) {
    assert.ok(ids.includes(id), `注册能力缺 ${id}`);
  }
});

test('agent：task 执行 system.exec / window.list / screen.capture 并透传结构化结果', { skip: !WIN }, async () => {
  const agent = new agentMod.NodeAgent({ hubUrl: hub.url, v2Enabled: true });
  agent.token = 'node-token-v4';
  // system.exec
  let before = hub.state.nodeEvents.length;
  await agent.handleTask({ id: 'task_v4_exec', capabilityId: 'system.exec', params: { command: 'echo AGENT_V4_EXEC' } });
  let succeeded = hub.state.nodeEvents.slice(before).find((event) => event.type === 'task.succeeded' && event.data.taskId === 'task_v4_exec');
  assert.ok(succeeded, 'system.exec 应 task.succeeded');
  assert.equal(succeeded.data.result.exitCode, 0);
  assert.ok(String(succeeded.data.result.stdout).includes('AGENT_V4_EXEC'));
  assert.ok(succeeded.data.result.data && succeeded.data.result.data.stdout.includes('AGENT_V4_EXEC'));
  // window.list
  before = hub.state.nodeEvents.length;
  await agent.handleTask({ id: 'task_v4_windows', capabilityId: 'window.list', params: {} });
  succeeded = hub.state.nodeEvents.slice(before).find((event) => event.type === 'task.succeeded' && event.data.taskId === 'task_v4_windows');
  assert.ok(succeeded, 'window.list 应 task.succeeded');
  assert.ok(Array.isArray(succeeded.data.result.windows) && succeeded.data.result.windows.length >= 1);
  // screen.capture
  before = hub.state.nodeEvents.length;
  await agent.handleTask({ id: 'task_v4_screen', capabilityId: 'screen.capture', params: { region: { x: 0, y: 0, width: 160, height: 120 } } });
  succeeded = hub.state.nodeEvents.slice(before).find((event) => event.type === 'task.succeeded' && event.data.taskId === 'task_v4_screen');
  assert.ok(succeeded, 'screen.capture 应 task.succeeded');
  assert.ok(fs.existsSync(succeeded.data.result.path), '截图路径应存在');
  assert.equal(succeeded.data.result.width, 160);
  // 危险命令 → task.failed（可读错误）
  before = hub.state.nodeEvents.length;
  await agent.handleTask({ id: 'task_v4_danger', capabilityId: 'system.exec', params: { command: 'shutdown /s /t 0' } });
  const failed = hub.state.nodeEvents.slice(before).find((event) => event.type === 'task.failed' && event.data.taskId === 'task_v4_danger');
  assert.ok(failed && String(failed.data.error).includes('拒绝'), '危险命令应 task.failed');
});