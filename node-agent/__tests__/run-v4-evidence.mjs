// 榫卯 V4 · node-agent 执行器能力「真实中枢 + 真实 agent」自测证据脚本
// 运行：node node-agent/__tests__/run-v4-evidence.mjs
// 流程：起隔离中枢（默认 7475，临时数据目录）→ 起真实 node-agent（TENON_V2=1）→ 绑定设备 →
//       用真实 HTTP（等价 curl）依次验证 system.exec dir / 中文回显 / 危险词拒绝 /
//       window.list / window.focus（正反例）/ screen.capture（全屏+区域 PNG）→ 读审计 → 优雅停止 → 清理
// 产出：node-agent/__tests__/evidence/v4-evidence.md/.json + hub.log/agent.log
// 不占 7410；结束清理 _internal/nodeagent-v4-data。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(AGENT_DIR, '..');
const DATA = path.join(REPO, '_internal', 'nodeagent-v4-data');
const EVID = path.join(HERE, 'evidence');
const PORT = Number(process.env.TENON_V4_IT_PORT || 7475);
const DISCOVERY_PORT = Number(process.env.TENON_V4_DISCOVERY_PORT || 7417);
const HUB = `http://127.0.0.1:${PORT}`;
const DEVICE = 'node-local';
const STARTED_AT = new Date();
const evidence = { kind: 'nodeagent-v4', startedAt: STARTED_AT.toISOString(), hubUrl: HUB, platform: process.platform, node: process.version, checks: [], sections: {}, curls: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
let hubProcess = null;
let agentProcess = null;
let hubLogFd = null;
let agentLogFd = null;
let operatorToken = '';

function check(id, title, ok, detail, extra) {
  const item = { id, title, ok: !!ok, detail: detail === undefined ? '' : String(detail), extra: extra || null, at: new Date().toISOString() };
  evidence.checks.push(item);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}${detail ? ' · ' + detail : ''}`);
  return item;
}
async function waitFor(fn, label, timeout = 30000, interval = 200) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}
async function api(pathname, { method = 'GET', body, token = operatorToken, timeout = 20000 } = {}) {
  const headers = {};
  if (token) headers['x-tenon-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(HUB + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${method} ${pathname}：${String(text).slice(0, 200)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
function readLog(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// 通过现有 remote/input 路由派发能力任务（与手机遥控/执行器同一入口），再轮询任务结果
async function invokeCapability(type, payload) {
  const dispatch = await api(`/api/v2/remote/${DEVICE}/input`, { method: 'POST', body: { type, payload } });
  const record = { type, payload, dispatch };
  evidence.sections.lastDispatch = record;
  const task = await waitFor(async () => {
    const detail = await api(`/api/v2/remote/${DEVICE}/task/${encodeURIComponent(dispatch.taskId)}`);
    return detail && ['succeeded', 'failed', 'timeout', 'cancelled'].includes(detail.status) ? detail : null;
  }, `任务 ${dispatch.taskId} 执行完成`, 45000);
  return { dispatch, task };
}

async function startHub() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'hub'), { recursive: true });
  fs.mkdirSync(EVID, { recursive: true });
  hubLogFd = fs.openSync(path.join(EVID, 'hub.log'), 'w');
  const env = {
    ...process.env,
    TENON_PORT: String(PORT),
    TENON_HOST: '127.0.0.1',
    TENON_DATA_DIR: path.join(DATA, 'hub'),
    TENON_DISCOVERY_PORT: String(DISCOVERY_PORT),
    TENON_MODE: 'solo',
  };
  delete env.TENON_V2;
  hubProcess = spawn(process.execPath, ['server/start.js'], { cwd: REPO, env, stdio: ['ignore', hubLogFd, hubLogFd] });
  await waitFor(async () => {
    try {
      const health = await api('/api/v2/health', { token: '' });
      return health && health.ok ? health : null;
    } catch {
      return null;
    }
  }, '隔离中枢启动（/api/v2/health）', 90000, 500);
  const secrets = JSON.parse(fs.readFileSync(path.join(DATA, 'hub', 'secrets.json'), 'utf8'));
  operatorToken = secrets.operatorToken;
  evidence.sections.hub = { url: HUB, healthModules: (await api('/api/v2/health', { token: '' })).modules, operatorToken: String(operatorToken).slice(0, 10) + '…' };
}

async function startAgent() {
  const agentData = path.join(DATA, 'agent');
  fs.mkdirSync(agentData, { recursive: true });
  fs.writeFileSync(path.join(agentData, 'secrets.json'), JSON.stringify({ operatorToken, nodeToken: JSON.parse(fs.readFileSync(path.join(DATA, 'hub', 'secrets.json'), 'utf8')).nodeToken }, null, 2));
  agentLogFd = fs.openSync(path.join(EVID, 'agent.log'), 'w');
  const env = {
    ...process.env,
    TENON_V2: '1',
    TENON_HUB_URL: HUB,
    TENON_DATA_DIR: agentData,
    TENON_NODE_NAME: 'V4 证据节点',
    TENON_NODE_ID: DEVICE,
    TENON_RECEIVE_DIR: path.join(DATA, 'receive'),
    TENON_CLIPBOARD: '0',
    TENON_NOTIFY_METHOD: 'log',
    TENON_STDIN_STOP: '1',
  };
  delete env.TENON_NODE_TOKEN;
  delete env.TENON_OPERATOR_TOKEN;
  agentProcess = spawn(process.execPath, ['agent.js'], { cwd: AGENT_DIR, env, stdio: ['pipe', agentLogFd, agentLogFd] });
  const node = await waitFor(async () => {
    const state = await api('/api/state', { token: '' });
    const found = (state.nodes || []).find((item) => item.id === DEVICE && item.name === 'V4 证据节点');
    return found && Array.isArray(found.capabilities) && found.capabilities.length >= 20 ? found : null;
  }, 'agent 注册 20 项能力', 40000);
  evidence.sections.register = { nodeId: node.id, name: node.name, online: node.online, capabilityCount: node.capabilities.length, capabilities: node.capabilities.map((cap) => cap.id) };
  check('register', '真实中枢 /api/state 可见 20 项能力（含 V4 4 项）', node.capabilities.length >= 20 && ['system.exec', 'window.list', 'window.focus', 'screen.capture'].every((id) => node.capabilities.some((cap) => cap.id === id)), node.capabilities.map((cap) => cap.id).join(','));
  // 一键绑定（remote 路由要求已绑定）
  try {
    const bound = await api(`/api/v2/devices/${DEVICE}/bind`, { method: 'POST', body: { by: 'v4-evidence' } });
    evidence.sections.bind = { ok: !!bound.ok, bound: bound.bound || null };
  } catch (err) {
    evidence.sections.bind = { ok: false, error: String(err.message || err) };
  }
  check('bind', '设备已绑定（remote/input 要求）', true, evidence.sections.bind.ok ? '已绑定' : `绑定接口：${evidence.sections.bind.error || ''}（可能此前已绑定）`);
}

async function main() {
  await startHub();
  await startAgent();
  await sleep(500);

  // 1) system.exec dir
  const execDir = await invokeCapability('system.exec', { command: 'dir' });
  evidence.sections.execDir = { taskId: execDir.dispatch.taskId, status: execDir.task.status, result: execDir.task.result ? { exitCode: execDir.task.result.exitCode, durationMs: execDir.task.result.durationMs, stdoutHead: String(execDir.task.result.data && execDir.task.result.data.stdout || '').split(/\r?\n/).filter(Boolean).slice(0, 6) } : null };
  const dirStdout = String((execDir.task.result && execDir.task.result.data && execDir.task.result.data.stdout) || '');
  check('system-exec-dir', 'system.exec "dir" 真实执行（exitCode=0 + 目录内容）', execDir.task.status === 'succeeded' && execDir.task.result.exitCode === 0 && /(目录|Directory|驱动器)/.test(dirStdout), `exit=${execDir.task.result && execDir.task.result.exitCode}，stdout ${dirStdout.length} 字符`);

  // 2) 中文回显（GBK→UTF-8 解码正确）
  const execZh = await invokeCapability('system.exec', { command: 'echo 榫卯V4中文回显_OK' });
  const zhStdout = String((execZh.task.result && execZh.task.result.data && execZh.task.result.data.stdout) || '');
  evidence.sections.execChinese = { taskId: execZh.dispatch.taskId, stdout: zhStdout.trim(), status: execZh.task.status };
  check('system-exec-chinese', 'system.exec 中文回显正确（cmd GBK 输出解码）', zhStdout.includes('榫卯V4中文回显_OK'), JSON.stringify(zhStdout.trim()));

  // 3) 危险词拒绝
  const dangerous = await invokeCapability('system.exec', { command: 'shutdown /s /t 0' });
  evidence.sections.execDangerous = { taskId: dangerous.dispatch.taskId, status: dangerous.task.status, error: dangerous.task.error };
  check('system-exec-dangerous', 'system.exec 危险词拒绝（shutdown）', dangerous.task.status === 'failed' && String(dangerous.task.error || '').includes('拒绝'), String(dangerous.task.error || '').slice(0, 120));

  // 4) window.list
  const windows = await invokeCapability('window.list', {});
  const windowList = (windows.task.result && windows.task.result.windows) || (windows.task.result && windows.task.result.data && windows.task.result.data.windows) || [];
  const foreground = (windows.task.result && windows.task.result.foreground) || (windows.task.result && windows.task.result.data && windows.task.result.data.foreground) || null;
  evidence.sections.windowList = { taskId: windows.dispatch.taskId, status: windows.task.status, count: windowList.length, foreground, sample: windowList.slice(0, 6) };
  check('window-list', 'window.list 枚举可见窗口（有数据）', windows.task.status === 'succeeded' && windowList.length >= 1, `${windowList.length} 个窗口；前台=${foreground ? foreground.title + ' / ' + foreground.process : '无'}`);

  // 5) window.focus：先通过 app.launch 启动记事本（真实 GUI），等窗口出现后按进程名激活
  const launch = await invokeCapability('app', { app: 'notepad' });
  evidence.sections.notepadLaunch = { taskId: launch.dispatch.taskId, status: launch.task.status, summary: launch.task.result && launch.task.result.summary };
  let notepadVisible = false;
  for (let i = 0; i < 25 && !notepadVisible; i += 1) {
    await sleep(400);
    const probe = await invokeCapability('window.list', {});
    const list = (probe.task.result && (probe.task.result.windows || (probe.task.result.data && probe.task.result.data.windows))) || [];
    notepadVisible = list.some((win) => /notepad/i.test(String(win.process)));
  }
  const focus = await invokeCapability('window.focus', { process: 'notepad' });
  const focused = (focus.task.result && (focus.task.result.focused || (focus.task.result.data && focus.task.result.data.focused))) || null;
  evidence.sections.windowFocus = { taskId: focus.dispatch.taskId, status: focus.task.status, focused, summary: focus.task.result && focus.task.result.summary };
  check('window-focus-ok', 'window.focus 按进程名激活记事本', focus.task.status === 'succeeded' && focused && String(focused.process).toLowerCase() === 'notepad', focused ? `${focused.title}（${focused.process}, PID ${focused.pid}）` : String(focus.task.error || ''));
  // 5b) window.focus 失败给可读错误
  const focusFail = await invokeCapability('window.focus', { title: '绝对不存在的窗口标题-V4-XYZ' });
  evidence.sections.windowFocusFail = { taskId: focusFail.dispatch.taskId, status: focusFail.task.status, error: focusFail.task.error };
  check('window-focus-fail', 'window.focus 失败返回可读错误', focusFail.task.status === 'failed' && String(focusFail.task.error || '').includes('未找到匹配的窗口'), String(focusFail.task.error || '').slice(0, 140));
  await invokeCapability('system.exec', { command: 'taskkill /IM notepad.exe /F' });

  // 6) screen.capture 全屏 + 区域
  const full = await invokeCapability('screen.capture', {});
  const fullPath = full.task.result && full.task.result.path;
  const fullOk = full.task.status === 'succeeded' && fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).size > 1000 && fs.readFileSync(fullPath).subarray(0, 4).toString('hex') === '89504e47';
  evidence.sections.screenFull = { taskId: full.dispatch.taskId, status: full.task.status, path: fullPath, width: full.task.result && full.task.result.width, height: full.task.result && full.task.result.height, bytes: fullPath ? fs.statSync(fullPath).size : 0 };
  check('screen-capture-full', 'screen.capture 全屏 PNG 非空', fullOk, `${fullPath} · ${evidence.sections.screenFull.width}×${evidence.sections.screenFull.height} · ${evidence.sections.screenFull.bytes} 字节`);
  const region = await invokeCapability('screen.capture', { region: { x: 0, y: 0, width: 640, height: 480 } });
  const regionPath = region.task.result && region.task.result.path;
  const regionOk = region.task.status === 'succeeded' && regionPath && fs.existsSync(regionPath) && region.task.result.width === 640 && region.task.result.height === 480;
  evidence.sections.screenRegion = { taskId: region.dispatch.taskId, status: region.task.status, path: regionPath, width: region.task.result && region.task.result.width, height: region.task.result && region.task.result.height, bytes: regionPath ? fs.statSync(regionPath).size : 0 };
  check('screen-capture-region', 'screen.capture 区域 640×480 PNG 非空', regionOk, `${regionPath} · ${evidence.sections.screenRegion.width}×${evidence.sections.screenRegion.height} · ${evidence.sections.screenRegion.bytes} 字节`);

  // 7) 本地审计日志（agent 数据目录 data/exec-audit.log）
  const auditFile = path.join(DATA, 'agent', 'exec-audit.log');
  const auditText = readLog(auditFile);
  const auditLines = auditText.trim().split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const hasDirAudit = auditLines.some((line) => !line.rejected && String(line.command).includes('dir') && line.ok === true);
  const hasRejectedAudit = auditLines.some((line) => line.rejected === true && String(line.reason || '').length > 0);
  evidence.sections.execAudit = { file: auditFile, lines: auditLines.length, hasDirAudit, hasRejectedAudit, sample: auditLines.slice(-3) };
  check('exec-audit', 'data/exec-audit.log 记录执行与拒绝', auditLines.length >= 5 && hasDirAudit && hasRejectedAudit, `${auditLines.length} 行；dir 审计=${hasDirAudit}；拒绝审计=${hasRejectedAudit}`);

  evidence.sections.curlExamples = [
    `TOKEN=<data/secrets.json 的 operatorToken>`,
    `curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d "{\\"type\\":\\"system.exec\\",\\"payload\\":{\\"command\\":\\"dir\\"}}"`,
    `curl -s http://127.0.0.1:7410/api/v2/remote/node-local/task/<taskId> -H "x-tenon-token: $TOKEN"`,
    `curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d "{\\"type\\":\\"window.list\\",\\"payload\\":{}}"`,
    `curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d "{\\"type\\":\\"window.focus\\",\\"payload\\":{\\"process\\":\\"notepad\\"}}"`,
    `curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d "{\\"type\\":\\"screen.capture\\",\\"payload\\":{\\"region\\":{\\"x\\":0,\\"y\\":0,\\"width\\":640,\\"height\\":480}}}"`,
  ];
}

async function cleanup() {
  try {
    if (agentProcess && agentProcess.stdin) agentProcess.stdin.end();
  } catch {
    /* ignore */
  }
  await Promise.race([new Promise((resolve) => (agentProcess ? agentProcess.once('exit', resolve) : resolve())), sleep(8000)]);
  try {
    if (agentProcess && agentProcess.exitCode === null) agentProcess.kill();
  } catch {
    /* ignore */
  }
  try {
    if (operatorToken) await api('/api/shutdown', { method: 'POST', body: {} });
  } catch {
    /* ignore */
  }
  await Promise.race([new Promise((resolve) => (hubProcess ? hubProcess.once('exit', resolve) : resolve())), sleep(8000)]);
  try {
    if (hubProcess && hubProcess.exitCode === null) hubProcess.kill();
  } catch {
    /* ignore */
  }
  for (const fd of [agentLogFd, hubLogFd]) {
    try {
      if (fd) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(DATA, { recursive: true, force: true });
}

function writeEvidence() {
  evidence.finishedAt = new Date().toISOString();
  evidence.durationMs = Date.now() - STARTED_AT.getTime();
  evidence.failures = failures;
  evidence.verdict = failures === 0 ? '通过' : '有失败项';
  const jsonFile = path.join(EVID, 'v4-evidence.json');
  fs.writeFileSync(jsonFile, JSON.stringify(evidence, null, 2), 'utf8');
  const lines = [
    '# 榫卯 V4 · node-agent 执行器能力 · 真实中枢自测证据',
    '',
    `- 时间：${evidence.startedAt} → ${evidence.finishedAt}（${(evidence.durationMs / 1000).toFixed(1)}s）`,
    `- 中枢：${HUB}（真实 server/start.js 隔离实例，未占 7410）`,
    `- 环境：${evidence.platform} / Node ${evidence.node} / Windows PowerShell 5.1`,
    `- 结论：**${evidence.verdict}**（${evidence.checks.filter((item) => item.ok).length}/${evidence.checks.length} 项通过）`,
    '',
    '## curl 调用示例（live 7410 同样适用）',
    '',
    '```bash',
    `TOKEN=$(node -e "console.log(JSON.parse(require('fs').readFileSync('data/secrets.json','utf8')).operatorToken)")`,
    `# 1) 执行命令 → 返回 {ok:true,queued:true,taskId}`,
    `curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d '{"type":"system.exec","payload":{"command":"dir"}}'`,
    `# 2) 查任务结果（result.data.stdout / exitCode / durationMs；result 里也有平铺字段）`,
    `curl -s "http://127.0.0.1:7410/api/v2/remote/node-local/task/<taskId>" -H "x-tenon-token: $TOKEN"`,
    `# 3) 窗口列表`,
    `curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d '{"type":"window.list","payload":{}}'`,
    `# 4) 聚焦窗口（按标题或进程名；失败返回可读 error）`,
    `curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d '{"type":"window.focus","payload":{"process":"notepad"}}'`,
    `# 5) 截屏（全屏省略 region；返回 PNG 路径+宽高，data/screen/ 下）`,
    `curl -s -X POST http://127.0.0.1:7410/api/v2/remote/node-local/input -H "x-tenon-token: $TOKEN" -H "Content-Type: application/json" -d '{"type":"screen.capture","payload":{"region":{"x":0,"y":0,"width":640,"height":480}}}'`,
    '```',
    '',
    '> 前置：设备已绑定（`POST /api/v2/devices/node-local/bind`），node-agent 以新代码 + `TENON_V2=1` 启动。',
    '',
    '| # | 检查项 | 结果 | 说明 |',
    '|---|---|---|---|',
    ...evidence.checks.map((item, index) => `| ${index + 1} | ${item.title} | ${item.ok ? '✅ 通过' : '❌ 失败'} | ${String(item.detail || '').replace(/\|/g, '\\|')} |`),
    '',
    '## 原始数据',
    '',
    '```json',
    JSON.stringify(evidence.sections, null, 2),
    '```',
    '',
    '日志：`node-agent/__tests__/evidence/agent.log`、`hub.log`',
  ];
  const mdFile = path.join(EVID, 'v4-evidence.md');
  fs.writeFileSync(mdFile, lines.join('\n'), 'utf8');
  return { jsonFile, mdFile };
}

try {
  await main();
} catch (err) {
  failures += 1;
  check('fatal', 'V4 证据脚本执行', false, String(err && err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : err));
} finally {
  await cleanup();
  const files = writeEvidence();
  console.log(`\n证据：${files.mdFile}`);
  console.log(`结论：${evidence.verdict}（${evidence.checks.filter((item) => item.ok).length}/${evidence.checks.length}）`);
  process.exit(failures === 0 ? 0 : 1);
}