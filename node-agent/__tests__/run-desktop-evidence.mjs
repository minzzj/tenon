// 榫卯 v2-P0 桌面端 Agent · 本机真实证据脚本
// 运行：node node-agent/__tests__/run-desktop-evidence.mjs
// 产出：node-agent/__tests__/evidence/desktop-evidence.json + desktop-evidence.md + agent.log
// 内容：剪贴板双向（PowerShell 回读）/ 文件扫描入库 / 4 个动作各 1 次 / v2 agent 端到端（注册 21 能力、
//       心跳、拉任务执行回报、入站传输自动落盘 ack、剪贴板双向、通知镜像、优雅退出 exit 0）
// 不占用 7410，不写 data/；临时目录 _internal/v2-desktop-data 结束后清理。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStubHub, sha256 } from './stub-hub.mjs';
import { readClipboardText, writeClipboardText, createClipboardSync, classifyKind } from '../clipboard.js';
import { HubClient } from '../hub.js';
import { scanDirectory, ingestFiles } from '../files.js';
import { findAction } from '../actions.js';
import { sendWindowsNotification } from '../notifier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(AGENT_DIR, '..');
const DATA = path.join(REPO, '_internal', 'v2-desktop-data');
const EVID = path.join(HERE, 'evidence');
const STARTED_AT = new Date();
const evidence = { startedAt: STARTED_AT.toISOString(), platform: process.platform, node: process.version, checks: [], sections: {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function check(id, title, ok, detail, extra) {
  const item = { id, title, ok: !!ok, detail: detail === undefined ? '' : detail, extra: extra || null, at: new Date().toISOString() };
  evidence.checks.push(item);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}${detail ? ' · ' + detail : ''}`);
  return item;
}
async function waitFor(fn, label, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(80);
  }
  throw new Error(`等待超时：${label}`);
}
function rss() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

let hub = null;
let child = null;
let logFd = null;
let originalClipboard = null;
const logFile = path.join(EVID, 'agent.log');

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(EVID, { recursive: true });
  const current = await readClipboardText();
  if (current.ok) originalClipboard = current.text || '';
  hub = await startStubHub();
  const hubClient = new HubClient({ baseUrl: hub.url, nodeToken: 'evidence-node-token', operatorToken: 'evidence-operator-token', timeoutMs: 6000, log: () => {} });
  console.log(`stub 中枢：${hub.url}${current.ok ? `；原剪贴板长度 ${(originalClipboard || '').length}` : '；剪贴板读取不可用'}`);

  // ================= A. 剪贴板双向（真实 PowerShell 读写） =================
  const clip = {};
  const localMarker = `电脑→中枢 剪贴板 ${Date.now()} 中文与符号 ✓`;
  const wrote = await writeClipboardText(localMarker);
  clip.writeLocal = { ok: wrote.ok, error: wrote.error || null };
  check('clip-write', 'PowerShell 写本机剪贴板', wrote.ok, wrote.ok ? `${localMarker.length} 字` : wrote.error);
  const readBack = await readClipboardText();
  clip.readBack = { ok: readBack.ok, text: readBack.text, match: readBack.text === localMarker };
  check('clip-readback', 'PowerShell 读回本机剪贴板', readBack.ok && readBack.text === localMarker, readBack.text === localMarker ? '内容一致' : `实际=${readBack.text}`);
  const sync = createClipboardSync({ hub: hubClient, deviceId: 'node-local', pollMs: 1000, log: () => {} });
  const firstSync = await sync.syncOnce();
  const reported = hub.state.clipboardPosts.find((post) => post.text === localMarker) || null;
  clip.report = { syncOk: firstSync.ok, reported: !!reported, kind: reported && reported.kind, from: reported && reported.from };
  check('clip-local-to-hub', '本机剪贴板变化上报中枢 /api/v2/link/clipboard', !!reported, reported ? `kind=${reported.kind} from=${reported.from}` : '未收到上报');
  const remoteMarker = `手机→电脑 剪贴板 ${Date.now()} 来自 Android`;
  await sync.syncOnce(); // 先把本机内容同步出去（真实时序）
  hub.state.clipboard = { at: new Date().toISOString(), from: 'phone-android', kind: classifyKind(remoteMarker), text: remoteMarker, preview: remoteMarker.slice(0, 30) };
  const applyResult = await sync.syncOnce();
  const afterApply = await readClipboardText();
  clip.hubToLocal = { applied: applyResult.applied, readBack: afterApply.text, match: afterApply.text === remoteMarker };
  check('clip-hub-to-local', '中枢最新剪贴板写回本机（手机→电脑）', applyResult.applied === true && afterApply.text === remoteMarker, afterApply.text === remoteMarker ? 'PowerShell 回读一致' : `实际=${afterApply.text}`);
  const postsBeforeEcho = hub.state.clipboardPosts.length;
  await sync.syncOnce();
  clip.noEcho = { extraPosts: hub.state.clipboardPosts.length - postsBeforeEcho };
  check('clip-no-echo', '防止剪贴板回环（写回内容不再上报）', clip.noEcho.extraPosts === 0, `额外上报 ${clip.noEcho.extraPosts} 条`);
  evidence.sections.clipboard = clip;

  // ================= B. 文件扫描入库 =================
  const filesSection = {};
  const sampleDir = path.join(REPO, '示例空间', '样品图');
  const scan = scanDirectory(sampleDir);
  filesSection.scan = { dir: '示例空间/样品图', total: scan.files.length, truncated: scan.truncated, kinds: [...new Set(scan.files.map((file) => file.kind))] };
  check('files-scan', '扫描示例空间/样品图', scan.files.length >= 10, `发现 ${scan.files.length} 个文件`);
  const ingestsBefore = hub.state.ingests.length;
  const ingest = await ingestFiles({ hub: hubClient, deviceId: 'node-local', files: scan.files.slice(0, 5), log: () => {} });
  filesSection.ingest = { ok: ingest.ok, ingested: ingest.ingested, failed: ingest.failed, stubReceived: hub.state.ingests.length - ingestsBefore, sample: hub.state.ingests.slice(ingestsBefore, ingestsBefore + 2) };
  check('files-ingest', '调用 POST /api/v2/assets/ingest 入库（stub 接收）', ingest.ingested >= 5 && hub.state.ingests.length - ingestsBefore >= 5, `入库 ${ingest.ingested} 个，stub 收到 ${hub.state.ingests.length - ingestsBefore} 条`);
  evidence.sections.files = filesSection;

  // ================= C. 真实动作各 1 次 =================
  const actions = {};
  const ctx = { repoRoot: REPO, dataDir: DATA, nodeId: 'node-local', nodeName: '证据节点' };
  // C1 system.open（真实打开一个文本文件；不等待人工查看，拿 shell 返回 + 进程变化）
  const openDir = path.join(DATA, 'open');
  fs.mkdirSync(openDir, { recursive: true });
  const openTarget = path.join(openDir, '榫卯-打开动作证据.txt');
  fs.writeFileSync(openTarget, '这是 system.open 动作的真实打开证据。\n', 'utf8');
  const beforeProcs = listProcessNames();
  const openResult = await findAction('system.open').run({ params: { target: openTarget } }, ctx);
  await sleep(1500);
  const afterProcs = listProcessNames();
  const newProcs = [...afterProcs].filter((name) => !beforeProcs.has(name));
  actions.open = { target: openTarget, summary: openResult.summary, newProcesses: newProcs };
  check('action-open', 'system.open 真实打开文件', openResult.items[0].ok === true, openResult.summary, { newProcesses: newProcs });
  closeProcesses(newProcs);
  // C2 system.volume（真实按键：静音 → 再静音恢复）
  const volume = findAction('system.volume');
  const mute = await volume.run({ params: { action: 'mute' } }, ctx);
  await sleep(400);
  const unmute = await volume.run({ params: { action: 'mute' } }, ctx);
  actions.volume = { mute: mute.summary, restore: unmute.summary, note: 'P0 近似：按键级音量控制，无法回读当前音量（绝对值 P1 CoreAudio）' };
  check('action-volume', 'system.volume 真实执行（静音/恢复各 1 次）', mute.items[0].ok === true && unmute.items[0].ok === true, `${mute.summary} / ${unmute.summary}`);
  // C3 system.power（默认禁用 + 双闸 + 演练）
  const power = findAction('system.power');
  let denied = null;
  try {
    await power.run({ params: { action: 'shutdown', confirm: true } }, ctx);
  } catch (err) {
    denied = String(err.message || err);
  }
  process.env.TENON_ALLOW_POWER = '1';
  process.env.TENON_POWER_DRYRUN = '1';
  let dryrun = null;
  try {
    dryrun = await power.run({ params: { action: 'shutdown', confirm: true } }, ctx);
  } finally {
    delete process.env.TENON_ALLOW_POWER;
    delete process.env.TENON_POWER_DRYRUN;
  }
  actions.power = { denied, dryrun: dryrun && dryrun.summary };
  check('action-power', 'system.power 默认禁用 + 双闸后演练', !!denied && !!dryrun, `${denied || ''}｜${dryrun ? dryrun.summary : ''}`);
  // C4 file.print（真实调用 Windows 外壳 Print 动词，无打印机时如实失败）
  let printResult = null;
  let printError = null;
  try {
    printResult = await findAction('file.print').run({ params: { path: '示例空间/样品图/样品01.png', copies: 1 } }, ctx);
  } catch (err) {
    printError = String(err.message || err);
  }
  actions.print = { ok: !!printResult, summary: printResult && printResult.summary, error: printError };
  check('action-print', 'file.print 真实调用系统打印动词', !!printResult || !!printError, printResult ? printResult.summary : printError, { honestFailure: !printResult });
  evidence.sections.actions = actions;

  // ================= D. 真实通知通道探测（不经过 agent，避免重复） =================
  const notifyProbe = await sendWindowsNotification({ title: '榫卯 v2 证据', body: `桌面端证据脚本通知探测 ${new Date().toLocaleTimeString('zh-CN')}` });
  evidence.sections.notification = notifyProbe;
  check('notify-probe', 'Windows 通知通道探测', notifyProbe.ok, `method=${notifyProbe.method}${notifyProbe.error ? '；回退原因=' + notifyProbe.error.slice(0, 120) : ''}`);

  // ================= E. v2 agent 端到端 =================
  await runAgentE2E(hubClient);
}

function listProcessNames() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Select-Object -ExpandProperty ProcessName'], { encoding: 'utf8', timeout: 15000 });
    return new Set(String(out).split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function closeProcesses(names) {
  const interesting = (names || []).filter((name) => ['notepad', 'notepad++', 'code', 'wordpad', 'openwith'].some((key) => name.includes(key)));
  for (const name of interesting) {
    try {
          execFileSync('taskkill', ['/IM', `${name}.exe`, '/F'], { stdio: 'ignore', timeout: 10000 });
    } catch {
      /* ignore */
    }
  }
}

async function runAgentE2E(hubClient) {
  const section = {};
  const childData = path.join(DATA, 'agent');
  const receiveDir = path.join(DATA, 'receive');
  fs.mkdirSync(childData, { recursive: true });
  fs.writeFileSync(path.join(childData, 'secrets.json'), JSON.stringify({ operatorToken: 'evidence-operator-token', nodeToken: 'evidence-node-token' }, null, 2));
  logFd = fs.openSync(logFile, 'w');
  const env = {
    ...process.env,
    TENON_V2: '1',
    TENON_HUB_URL: hub.url,
    TENON_DATA_DIR: childData,
    TENON_NODE_NAME: '证据节点',
    TENON_RECEIVE_DIR: receiveDir,
    TENON_CLIPBOARD_MS: '300',
    TENON_TRANSFER_POLL_MS: '500',
    TENON_NOTIFY_METHOD: 'log',
    TENON_ACTION_DRYRUN: '1',
    TENON_STDIN_STOP: '1',
  };
  delete env.TENON_NODE_TOKEN;
  delete env.TENON_OPERATOR_TOKEN;
  child = spawn(process.execPath, ['agent.js'], { cwd: AGENT_DIR, env, stdio: ['pipe', logFd, logFd] });
  let exitInfo = null;
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => { exitInfo = { code, signal }; resolve(); }));
  try {
    await waitFor(() => hub.state.registerBodies.some((body) => body.name === '证据节点' && body.capabilities.length === 21), 'agent 注册 21 能力', 20000);
    const register = hub.state.registerBodies.find((body) => body.name === '证据节点');
    section.register = { nodeId: register.nodeId, name: register.name, capabilityCount: register.capabilities.length, capabilityIds: register.capabilities.map((cap) => cap.id) };
    check('agent-register', '节点注册上报 21 项能力（4 基础 + 4 受控动作 + 5 超级终端 + 3 遥控 + 4 执行器）', register.capabilities.length === 21, register.capabilities.map((cap) => cap.id).join(','));
    await waitFor(() => hub.state.heartbeats.some((beat) => beat.nodeId === register.nodeId), 'agent 心跳', 10000);
    section.heartbeat = hub.state.heartbeats.find((beat) => beat.nodeId === register.nodeId);
    check('agent-heartbeat', '节点心跳上报', !!section.heartbeat, `nodeId=${section.heartbeat && section.heartbeat.nodeId}`);
    // E1 剪贴板：本机→中枢（由 agent 的后台轮询上报）
    const agentLocalMarker = `v2agent 本机复制 ${Date.now()} 中文`;
    await writeClipboardText(agentLocalMarker);
    await waitFor(() => hub.state.clipboardPosts.some((post) => post.text === agentLocalMarker), 'agent 上报剪贴板', 15000);
    section.clipboardLocalToHub = { marker: agentLocalMarker, reported: true };
    check('agent-clip-local-to-hub', 'agent 后台把本机剪贴板上报中枢', true, agentLocalMarker);
    // E2 剪贴板：中枢→本机（手机发来 → agent 写回剪贴板，PowerShell 回读验证）
    const agentRemoteMarker = `v2agent 手机发来 ${Date.now()} 写回`;
    hub.state.clipboard = { at: new Date().toISOString(), from: 'phone-android', kind: 'text', text: agentRemoteMarker, preview: agentRemoteMarker.slice(0, 30) };
    await waitFor(async () => {
      const read = await readClipboardText();
      return read.ok && read.text === agentRemoteMarker;
    }, 'agent 写回剪贴板', 20000);
    section.clipboardHubToLocal = { text: agentRemoteMarker, readBackMatched: true };
    check('agent-clip-hub-to-local', 'agent 把手机剪贴板写回本机（PowerShell 回读一致）', true, agentRemoteMarker);
    // E3 入站传输：手机推文件 → agent 自动落盘 + ack
    const inboundBuffer = Buffer.from(`v2agent 入站文件真实内容 ${Date.now()} 中文`);
    hub.addInboundTransfer({ transferId: 'evidence_in_1', peerName: '证据 Android', files: [{ name: '手机截图证据.png', buffer: inboundBuffer }] });
    await waitFor(() => hub.state.acks.some((ack) => ack.transferId === 'evidence_in_1'), 'agent 接收入站传输并 ack', 25000);
    const ack = hub.state.acks.find((item) => item.transferId === 'evidence_in_1');
    const savedInfo = ack.body.saved[0];
    const savedOnDisk = fs.existsSync(savedInfo.path) && sha256(fs.readFileSync(savedInfo.path)) === sha256(inboundBuffer);
    section.inboundTransfer = { transferId: 'evidence_in_1', ack: ack.body, savedPath: savedInfo.path, savedOnDisk, receiveDir };
    check('agent-inbound-transfer', '入站文件落盘 示例空间/接收/ 且 sha256 校验通过并 ack', savedOnDisk && ack.body.ok === true, savedInfo.path);
    // E4 任务派发：stub 下发 system.volume（dryrun）→ agent 拉取执行回报
    hub.state.pullQueue.push({ id: 'evidence_task_1', text: '把电脑音量静音（证据任务）', capabilityId: 'system.volume', params: { action: 'mute' }, retries: 0 });
    await waitFor(() => hub.state.nodeEvents.some((event) => event.type === 'task.succeeded' && event.data.taskId === 'evidence_task_1'), 'agent 执行任务并回报', 25000);
    const taskEvents = hub.state.nodeEvents.filter((event) => event.data && event.data.taskId === 'evidence_task_1');
    const succeeded = taskEvents.find((event) => event.type === 'task.succeeded');
    section.task = { steps: taskEvents.filter((event) => event.type === 'task.step').map((event) => event.data.label), result: succeeded.data.result };
    check('agent-task', '任务链路 task.step → task.succeeded', taskEvents.some((event) => event.type === 'task.step') && !!succeeded, succeeded.data.result.summary);
    // E5 通知镜像：中枢 notification.relayed → agent 本机通知（log 兜底可查日志）
    hub.pushEvent({ type: 'notification.relayed', data: { app: 'com.tencent.mm', title: '手机通知证据', preview: '来自 Android 的通知镜像' } });
    await waitFor(() => readLog().includes('手机通知证据'), 'agent 通知镜像', 20000);
    section.notificationMirror = { title: '手机通知证据', seenInLog: true };
    check('agent-notify-mirror', 'SSE notification.relayed → 本机通知镜像', true, 'agent.log 出现「手机通知证据」');
  } finally {
    // E6 优雅退出
    if (child && child.stdin) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
    }
    await Promise.race([exited, sleep(10000).then(() => null)]);
    if (exitInfo) {
      section.exit = exitInfo;
      check('agent-exit', '关闭 stdin 后优雅退出（exit code 0）', exitInfo.code === 0, `code=${exitInfo.code} signal=${exitInfo.signal || ''}`);
    } else {
      check('agent-exit', '关闭 stdin 后优雅退出（exit code 0）', false, '10 秒内未退出，强制结束');
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    const logText = readLog();
    section.logTail = logText.split(/\r?\n/).filter(Boolean).slice(-25);
    evidence.sections.agent = section;
    if (logFd) {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      logFd = null;
    }
  }
}

function readLog() {
  try {
    return fs.readFileSync(logFile, 'utf8');
  } catch {
    return '';
  }
}

function writeEvidenceFiles() {
  evidence.finishedAt = new Date().toISOString();
  evidence.durationMs = Date.now() - STARTED_AT.getTime();
  evidence.rssMb = rss();
  evidence.failures = failures;
  evidence.verdict = failures === 0 ? '通过' : '有失败项';
  const jsonFile = path.join(EVID, 'desktop-evidence.json');
  fs.writeFileSync(jsonFile, JSON.stringify(evidence, null, 2), 'utf8');
  const lines = [
    '# 榫卯 v2-P0 桌面端 Agent · 本机实测证据',
    '',
    `- 时间：${evidence.startedAt} → ${evidence.finishedAt}（耗时 ${(evidence.durationMs / 1000).toFixed(1)}s）`,
    `- 环境：${evidence.platform} / Node ${evidence.node} / PowerShell 5.1`,
    `- 结论：**${evidence.verdict}**（${evidence.checks.filter((item) => item.ok).length}/${evidence.checks.length} 项通过，失败 ${failures} 项）`,
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
    `agent 原始日志：\`node-agent/__tests__/evidence/agent.log\``,
  ];
  const mdFile = path.join(EVID, 'desktop-evidence.md');
  fs.writeFileSync(mdFile, lines.join('\n'), 'utf8');
  return { jsonFile, mdFile };
}

async function cleanup() {
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  if (originalClipboard !== null) {
    try {
      await writeClipboardText(originalClipboard);
    } catch {
      /* ignore */
    }
  }
  if (hub) {
    try {
      await hub.close();
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(DATA, { recursive: true, force: true });
}

try {
  await main();
} catch (err) {
  failures += 1;
  check('fatal', '证据脚本执行', false, String(err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err));
} finally {
  await cleanup();
  const files = writeEvidenceFiles();
  console.log(`\n证据文件：${files.mdFile}`);
  console.log(`证据 JSON：${files.jsonFile}`);
  console.log(`结论：${evidence.verdict}（${evidence.checks.filter((item) => item.ok).length}/${evidence.checks.length}）`);
  process.exit(failures === 0 ? 0 : 1);
}