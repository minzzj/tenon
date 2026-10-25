// 榫卯 v2-P0 桌面端 Agent · 真实中枢联调脚本（不是 stub）
// 用途：在隔离端口（默认 7439）+ 临时数据目录起一个真实中枢（含 link/assets/things/enterprise），
//       跑真实 v2 API 全链路：注册 8 能力 / 心跳 / 剪贴板双向 / 素材真实入库 / 入站接收文件 ack /
//       出站真实分块传输 / 通知镜像 / 优雅退出。
// 运行：node node-agent/__tests__/run-real-integration.mjs
// 退出码：0 全部通过；1 有失败；2 被中枢侧集成问题阻塞（会把证据写清楚）。
// 约束：不占 7410/7411，不写 data/，结束后清理 _internal/v2-desktop-data。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HubClient } from '../hub.js';
import { createLinkService } from '../link.js';
import { readClipboardText, writeClipboardText } from '../clipboard.js';
import { ingestFiles, scanDirectory } from '../files.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(AGENT_DIR, '..');
const DATA = path.join(REPO, '_internal', 'v2-desktop-data');
const EVID = path.join(HERE, 'evidence');
const PORT = Number(process.env.TENON_IT_PORT || 7439);
const DISCOVERY_PORT = Number(process.env.TENON_IT_DISCOVERY_PORT || 7414);
const HUB = `http://127.0.0.1:${PORT}`;
const STARTED_AT = new Date();
const evidence = { kind: 'real-integration', startedAt: STARTED_AT.toISOString(), hubUrl: HUB, platform: process.platform, node: process.version, checks: [], blocked: null, sections: {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
let hubProcess = null;
let agentProcess = null;
let operatorToken = '';
let nodeToken = '';
let originalClipboard = null;

function check(id, title, ok, detail, extra) {
  const item = { id, title, ok: !!ok, detail: detail === undefined ? '' : String(detail), extra: extra || null, at: new Date().toISOString() };
  evidence.checks.push(item);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}${detail ? ' · ' + detail : ''}`);
  return item;
}
async function waitFor(fn, label, timeout = 20000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch {
      /* 继续等 */
    }
    await sleep(120);
  }
  throw new Error(`等待超时：${label}`);
}
async function api(pathname, { method = 'GET', body, token = operatorToken, raw = false } = {}) {
  const headers = {};
  if (token) headers['x-tenon-token'] = token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(HUB + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (raw) {
    if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
    return Buffer.from(await res.arrayBuffer());
  }
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
function readHubLog() {
  try {
    return fs.readFileSync(path.join(EVID, 'hub.log'), 'utf8');
  } catch {
    return '';
  }
}
function readAgentLog() {
  try {
    return fs.readFileSync(path.join(EVID, 'agent-real.log'), 'utf8');
  } catch {
    return '';
  }
}
function readLedgerEvents() {
  try {
    return fs.readFileSync(path.join(DATA, 'hub', 'events.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function listFiles(dir, depth = 0) {
  try {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) out.push(...listFiles(full, depth + 1).map((item) => entry.name + '/' + item));
      else if (entry.isFile()) out.push(entry.name);
    }
    return out;
  } catch {
    return [];
  }
}
function findFileBySha(dir, digest, depth = 0) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        const hit = findFileBySha(full, digest, depth + 1);
        if (hit) return hit;
      } else if (entry.isFile()) {
        try {
          if (sha256(fs.readFileSync(full)) === digest) return full;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function startHub() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'hub'), { recursive: true });
  fs.mkdirSync(EVID, { recursive: true });
  const logFd = fs.openSync(path.join(EVID, 'hub.log'), 'w');
  const env = {
    ...process.env,
    TENON_PORT: String(PORT),
    TENON_HOST: '127.0.0.1',
    TENON_DATA_DIR: path.join(DATA, 'hub'),
    TENON_DISCOVERY_PORT: String(DISCOVERY_PORT),
    TENON_MODE: 'solo',
  };
  hubProcess = spawn(process.execPath, ['server/start.js'], { cwd: REPO, env, stdio: ['ignore', logFd, logFd] });
  hubProcess.on('exit', () => {});
  await waitFor(async () => {
    try {
      await api('/api/v2/health', { token: '' });
      return true;
    } catch {
      return false;
    }
  }, '真实中枢启动（/api/v2/health）', 60000);
  const secrets = JSON.parse(fs.readFileSync(path.join(DATA, 'hub', 'secrets.json'), 'utf8'));
  operatorToken = secrets.operatorToken;
  nodeToken = secrets.nodeToken;
  evidence.sections.hub = { url: HUB, secrets: { nodeToken: secrets.nodeToken.slice(0, 8) + '…', operatorToken: secrets.operatorToken.slice(0, 8) + '…' }, logTail: readHubLog().split(/\r?\n/).filter(Boolean).slice(-15) };
}

async function stopHub() {
  if (!hubProcess) return null;
  try {
    await api('/api/shutdown', { method: 'POST', body: {} });
  } catch {
    /* 可能已退出 */
  }
  await Promise.race([
    new Promise((resolve) => hubProcess.once('exit', resolve)),
    sleep(8000),
  ]);
  if (hubProcess.exitCode === null) {
    try {
      hubProcess.kill();
    } catch {
      /* ignore */
    }
  }
  return hubProcess.exitCode;
}

async function writeEvidence(mode) {
  evidence.finishedAt = new Date().toISOString();
  evidence.durationMs = Date.now() - STARTED_AT.getTime();
  evidence.failures = failures;
  evidence.verdict = evidence.blocked ? '被阻塞' : failures === 0 ? '通过' : '有失败项';
  const jsonFile = path.join(EVID, 'real-integration.json');
  fs.writeFileSync(jsonFile, JSON.stringify(evidence, null, 2), 'utf8');
  const lines = [
    '# 榫卯 v2-P0 桌面端 Agent · 真实中枢联调证据',
    '',
    `- 时间：${evidence.startedAt} → ${evidence.finishedAt}（耗时 ${(evidence.durationMs / 1000).toFixed(1)}s）`,
    `- 中枢：${HUB}（真实 server/start.js + link/assets/things/enterprise 模块，隔离端口）`,
    `- 环境：${evidence.platform} / Node ${evidence.node}`,
    `- 结论：**${evidence.verdict}**（${evidence.checks.filter((item) => item.ok).length}/${evidence.checks.length} 项通过）`,
  ];
  if (evidence.blocked) {
    lines.push('', '## 阻塞原因', '', '```', evidence.blocked, '```');
    lines.push('', '> 这是中枢侧集成问题，桌面端模块已按 contract 对接；修复后重跑本脚本即可。');
  }
  lines.push('', '| # | 检查项 | 结果 | 说明 |', '|---|---|---|---|');
  evidence.checks.forEach((item, index) => {
    lines.push(`| ${index + 1} | ${item.title} | ${item.ok ? '✅ 通过' : '❌ 失败'} | ${String(item.detail || '').replace(/\|/g, '\\|')} |`);
  });
  lines.push('', '## 原始数据', '', '```json', JSON.stringify(evidence.sections, null, 2), '```', '', '中枢日志：`node-agent/__tests__/evidence/hub.log`；节点日志：`node-agent/__tests__/evidence/agent-real.log`');
  const mdFile = path.join(EVID, 'real-integration.md');
  fs.writeFileSync(mdFile, lines.join('\n'), 'utf8');
  return { jsonFile, mdFile };
}

await (async () => {
  const clip = await readClipboardText();
  if (clip.ok) originalClipboard = clip.text || '';
  await startHub();

  // 0) 挂载自检：/api/v2/link/info 是模块路由（不是 health 特例），404 说明中枢 v2 路由未正确挂载
  try {
    const info = await api('/api/v2/link/info');
    evidence.sections.linkInfo = info;
    check('hub-v2-routes', '真实中枢 v2 模块路由可用（GET /api/v2/link/info）', info && info.ok !== false, JSON.stringify(info).slice(0, 160));
  } catch (err) {
    evidence.blocked = `GET /api/v2/link/info → ${err.message}\n\n原因定位：server/lib/v2/index.js 把 pathname 去掉 /api/v2 前缀后再与模块全路径路由匹配，导致除 /api/v2/health 外全部 404。建议 matchRoute(route, req.method, pathname)。`;
    check('hub-v2-routes', '真实中枢 v2 模块路由可用（GET /api/v2/link/info）', false, evidence.blocked.split('\n')[0]);
    return;
  }

  // 1) 启动真实 v2 桌面 agent
  const agentData = path.join(DATA, 'agent');
  const receiveDir = path.join(DATA, 'receive');
  fs.mkdirSync(agentData, { recursive: true });
  fs.writeFileSync(path.join(agentData, 'secrets.json'), JSON.stringify({ operatorToken, nodeToken }, null, 2));
  const agentLogFd = fs.openSync(path.join(EVID, 'agent-real.log'), 'w');
  const env = {
    ...process.env,
    TENON_V2: '1',
    TENON_HUB_URL: HUB,
    TENON_DATA_DIR: agentData,
    TENON_NODE_NAME: '真实联调工作台',
    TENON_NODE_ID: 'node-local',
    TENON_RECEIVE_DIR: receiveDir,
    TENON_CLIPBOARD_MS: '400',
    TENON_TRANSFER_POLL_MS: '500',
    TENON_NOTIFY_METHOD: 'log',
    TENON_ACTION_DRYRUN: '1',
    TENON_STDIN_STOP: '1',
  };
  delete env.TENON_NODE_TOKEN;
  delete env.TENON_OPERATOR_TOKEN;
  agentProcess = spawn(process.execPath, ['agent.js'], { cwd: AGENT_DIR, env, stdio: ['pipe', agentLogFd, agentLogFd] });
  let agentExit = null;
  agentProcess.on('exit', (code, signal) => { agentExit = { code, signal }; });
  try {
    await waitFor(async () => {
      const state = await api('/api/state', { token: '' });
      const node = (state.nodes || []).find((item) => item.id === 'node-local' && item.name === '真实联调工作台');
      return node && node.capabilities && node.capabilities.length === 13 ? node : null;
    }, '真实注册 13 能力', 30000);
    const state = await api('/api/state', { token: '' });
    const node = state.nodes.find((item) => item.id === 'node-local');
    evidence.sections.register = { nodeId: node.id, name: node.name, online: node.online, capabilities: node.capabilities.map((cap) => cap.id) };
    check('real-register', '真实注册 13 项能力并通过 /api/state 可见', node.capabilities.length === 13, node.capabilities.map((cap) => cap.id).join(','));
    // 心跳：中枢把 node.heartbeat 落账本做了 60 秒节流（server/lib/http.js persistedBeat），
    // 在线状态走 liveSeen 8 秒窗口。注册后等 9.5 秒仍 online=true，即可证明 2 秒心跳持续生效。
    const onlineAfterWait = await waitFor(async () => {
      await sleep(9500);
      const snapshot = await api('/api/state', { token: '' });
      const currentNode = (snapshot.nodes || []).find((item) => item.id === 'node-local');
      return currentNode && currentNode.online === true ? currentNode : null;
    }, '注册 9.5 秒后节点仍在线（心跳持续）', 20000);
    evidence.sections.heartbeat = {
      onlineAfterWait: true,
      lastSeen: onlineAfterWait.lastSeen,
      waitMs: 9500,
      note: 'node.heartbeat 落账本按 60s 节流（Lead 侧优化），在线判定用 liveSeen(8s) 窗口',
      ledgerHeartbeats: readLedgerEvents().filter((event) => event.type === 'node.heartbeat').length,
    };
    check('real-heartbeat', '2 秒心跳持续生效（注册 9.5 秒后 /api/state 仍 online=true）', true, `lastSeen=${onlineAfterWait.lastSeen}`);

    // 2) 剪贴板：本机 → 中枢（真实 link-core 存储 + clipboard.shared 事件）
    const localMarker = `真实联调-电脑剪贴板-${Date.now()}-中文`;
    await writeClipboardText(localMarker);
    const posted = await waitFor(async () => {
      const latest = await api('/api/v2/link/clipboard/latest');
      return latest.clipboard && latest.clipboard.text === localMarker ? latest.clipboard : null;
    }, 'agent 上报剪贴板到真实中枢', 20000);
    evidence.sections.clipboardLocalToHub = { text: localMarker, from: posted.from, kind: posted.kind };
    check('real-clip-local-to-hub', '真实中枢收到 agent 上报的剪贴板', posted.text === localMarker, `from=${posted.from} kind=${posted.kind}`);
    const clipEvent = readLedgerEvents().filter((event) => event.type === 'clipboard.shared').slice(-1)[0];
    evidence.sections.clipboardEvent = clipEvent;
    check('real-clip-event', '真实账本写入 clipboard.shared 事件', !!clipEvent, clipEvent ? JSON.stringify(clipEvent.data).slice(0, 120) : '');
    // 3) 剪贴板：中枢 → 本机（模拟手机发来，agent 写回，PowerShell 回读）
    const remoteMarker = `真实联调-手机剪贴板-${Date.now()}`;
    await api('/api/v2/link/clipboard', { method: 'POST', body: { kind: 'text', text: remoteMarker, from: 'phone-android' } });
    await waitFor(async () => {
      const read = await readClipboardText();
      return read.ok && read.text === remoteMarker;
    }, 'agent 把真实中枢剪贴板写回本机', 20000);
    evidence.sections.clipboardHubToLocal = { text: remoteMarker, readBackMatched: true };
    check('real-clip-hub-to-local', '手机剪贴板经真实中枢 → 本机剪贴板（PowerShell 回读一致）', true, remoteMarker);

    // 4) 素材：真实 assets-core 入库 + 搜索 + 缩略图（先看 health 模块挂载，未挂载只记一条失败不中断）
    const hubClient = new HubClient({ baseUrl: HUB, operatorToken, nodeToken, timeoutMs: 30000, log: () => {} });
    const health = await api('/api/v2/health', { token: '' });
    evidence.sections.v2Health = { modules: health.modules, pending: health.pending };
    if (!(health.modules || []).includes('assets')) {
      evidence.sections.assetsError = { reason: 'assets 模块未挂载', pending: health.pending, hubLogTail: readHubLog().split(/\r?\n/).filter((line) => line.includes('[v2]') || line.includes('assets')).slice(-5) };
      check('real-assets', '真实 assets-core 模块挂载', false, `assets 未挂载：${(health.pending || []).join('；')}`);
    } else {
      try {
        const scan = scanDirectory(path.join(REPO, '示例空间', '样品图'));
        const ingest = await ingestFiles({ hub: hubClient, deviceId: 'node-local', files: scan.files.slice(0, 3), log: () => {} });
        evidence.sections.assetsIngest = { ok: ingest.ok, ingested: ingest.ingested, failed: ingest.failed, items: ingest.items };
        const listed = await api('/api/v2/assets?q=' + encodeURIComponent('样品01') + '&limit=5');
        const total = listed.total || (listed.items || listed.assets || []).length;
        evidence.sections.assetsSearch = { total, first: (listed.items || listed.assets || [])[0] };
        const assetId = ingest.items.find((item) => item.ok && item.assetId);
        let thumbOk = false;
        if (assetId) {
          const thumb = await api(`/api/v2/assets/${encodeURIComponent(assetId.assetId)}/thumb?w=320`, { raw: true }).catch(() => null);
          evidence.sections.assetsThumb = { assetId: assetId.assetId, bytes: thumb ? thumb.length : 0, magic: thumb ? thumb.slice(0, 4).toString('hex') : null };
          thumbOk = !!thumb && thumb.length > 100;
        }
        check('real-assets', '真实 assets-core 入库 + 搜索 + 缩略图', ingest.ingested >= 3 && ingest.failed === 0 && total >= 1 && thumbOk, `入库 ${ingest.ingested} 个 / 搜索 total=${total} / 缩略图 ${thumbOk ? 'OK' : '未验证'}`);
      } catch (err) {
        evidence.sections.assetsError = { message: String(err && err.message ? err.message : err) };
        check('real-assets', '真实 assets-core 入库 + 搜索 + 缩略图', false, String(err && err.message ? err.message : err));
      }
    }
    // 5) 入站传输：模拟手机上传到真实 link-core（to-desktop）→ agent 自动落盘 + ack
    const inboundBuffer = Buffer.from(`真实联调-手机推文件-${Date.now()}-中文内容`);
    const init = await api('/api/v2/link/transfer/init', { method: 'POST', body: { peerId: 'phone-evidence', peerName: '真实联调手机', direction: 'to-desktop', files: [{ name: '真实联调手机截图.png', size: inboundBuffer.length }] } });
    const transferId = init.transferId || (init.transfer && init.transfer.transferId);
    const chunkSize = Number(init.chunkSize) || 1024 * 1024;
    for (let offset = 0; offset < inboundBuffer.length; offset += chunkSize) {
      const chunk = inboundBuffer.subarray(offset, offset + chunkSize);
      const res = await fetch(`${HUB}/api/v2/link/transfer/${encodeURIComponent(transferId)}/chunk?offset=${offset}&file=0`, { method: 'PUT', headers: { 'x-tenon-token': operatorToken, 'content-type': 'application/octet-stream' }, body: chunk });
      if (!res.ok) throw new Error(`上传分块失败 ${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
    const finished = await api(`/api/v2/link/transfer/${encodeURIComponent(transferId)}/finish`, { method: 'POST', body: { sha256: sha256(inboundBuffer) } });
    evidence.sections.inboundInit = { transferId, chunkSize, finish: { ok: finished.ok, verified: finished.verified, awaitingAck: finished.awaitingAck } };
    check('real-inbound-setup', '真实 link-core 接收手机上传并校验 sha256（to-desktop 等待桌面 ack）', finished.ok === true && finished.verified === true, `transferId=${transferId}`);
    const completed = await waitFor(async () => {
      const transfer = await api(`/api/v2/link/transfer/${encodeURIComponent(transferId)}`);
      return transfer.transfer && transfer.transfer.status === 'completed' ? transfer.transfer : null;
    }, 'agent 拉取入站传输并 ack（真实中枢状态 completed）', 40000);
    const inboundEvent = readLedgerEvents().filter((event) => event.type === 'transfer.completed' && event.data.transferId === transferId).slice(-1)[0];
    const eventFile = inboundEvent && Array.isArray(inboundEvent.data.files) ? inboundEvent.data.files[0] : null;
    const savedOnDisk = findFileBySha(receiveDir, sha256(inboundBuffer));
    const agentLog = readAgentLog();
    const ackLogged = agentLog.includes('真实联调手机截图.png') && agentLog.includes('已接收');
    evidence.sections.inboundTransfer = {
      transferId,
      status: completed.status,
      transferEventFile: eventFile,
      savedOnDisk,
      receiveDirFiles: listFiles(receiveDir),
      ackLogged,
      note: 'link-core 的 transfer view 不返回路径，落盘位置用「接收目录内按 sha256 找文件 + agent 日志」验证',
    };
    check('real-inbound-transfer', '入站文件真实落盘接收目录 + sha256 一致 + ack 后 status=completed', !!savedOnDisk && !!eventFile && eventFile.ok === true && eventFile.sha256 === sha256(inboundBuffer) && ackLogged, `${savedOnDisk || '未找到'}；event.file=${eventFile ? eventFile.sha256.slice(0, 12) + '…' : '无'}`);
    check('real-inbound-event', '真实账本写入 transfer.completed（ack 产生）', !!inboundEvent, inboundEvent ? `direction=${inboundEvent.data.direction} bytes=${inboundEvent.data.bytes}` : '');

    // 6) 出站传输：桌面 agent 的 link 模块对真实中枢的分块 PUT + finish
    const outboundFile = path.join(DATA, 'outbound-证据文件.bin');
    fs.writeFileSync(outboundFile, Buffer.from(`真实联调-桌面发手机-${Date.now()}-` + 'x'.repeat(2600)));
    const linkService = createLinkService({ hub: hubClient, deviceId: 'node-local', nodeName: '真实联调工作台', receiveDir, log: () => {} });
    const sent = await linkService.sendFiles({ peerId: 'phone-evidence', files: [outboundFile] });
    const sentTransfer = await api(`/api/v2/link/transfer/${encodeURIComponent(sent.transferId)}`);
    evidence.sections.outboundTransfer = { transferId: sent.transferId, bytes: sent.bytes, ms: sent.ms, sha256: sent.files[0].sha256, hubStatus: sentTransfer.transfer.status, hubSpeedBps: sentTransfer.transfer.speedBps };
    check('real-outbound-transfer', '真实出站分块传输（init → PUT chunk?file= → finish{sha256}）完成', sent.ok && sentTransfer.transfer.status === 'completed' && sentTransfer.transfer.files[0].sha256 === sent.files[0].sha256, `${sent.bytes} 字节 / ${sent.ms}ms / ${sentTransfer.transfer.speedBps || sent.speedBps} B/s`);

    // 7) 通知镜像：真实 POST /api/v2/link/notification → 账本 notification.relayed → agent SSE → 本机通知（log 兜底）
    const notifyTitle = `真实通知镜像-${Date.now()}`;
    await api('/api/v2/link/notification', { method: 'POST', body: { from: 'phone-android', app: 'com.tencent.mm', title: notifyTitle, text: '来自真实中枢的通知' } });
    await waitFor(() => readAgentLog().includes(notifyTitle), 'agent SSE 收到真实通知并镜像', 25000);
    const relayedEvent = readLedgerEvents().filter((event) => event.type === 'notification.relayed').slice(-1)[0];
    evidence.sections.notificationMirror = { title: notifyTitle, ledgerEvent: relayedEvent && relayedEvent.data, seenInAgentLog: true };
    check('real-notify-mirror', '真实通知 relayed → 账本事件 + agent SSE 镜像', !!relayedEvent && readAgentLog().includes(notifyTitle), notifyTitle);
  } finally {
    // 8) 优雅退出
    if (agentProcess && agentProcess.stdin) {
      try {
        agentProcess.stdin.end();
      } catch {
        /* ignore */
      }
    }
    await Promise.race([new Promise((resolve) => agentProcess ? agentProcess.once('exit', resolve) : resolve()), sleep(10000)]);
    const logText = readAgentLog();
    evidence.sections.agentLogTail = logText.split(/\r?\n/).filter(Boolean).slice(-20);
    check('real-agent-exit', '关闭 stdin 后真实 agent 优雅退出（exit code 0）', agentExit && agentExit.code === 0, agentExit ? `code=${agentExit.code}` : '10 秒内未退出');
    if (agentProcess && agentProcess.exitCode === null) {
      try {
        agentProcess.kill();
      } catch {
        /* ignore */
      }
    }
    const hubExit = await stopHub();
    const events = readLedgerEvents();
    evidence.sections.hubStop = { exitCode: hubExit, systemStopped: events.some((event) => event.type === 'system.stopped'), eventCount: events.length };
    check('real-hub-graceful-stop', '真实中枢优雅停止并写 system.stopped', events.some((event) => event.type === 'system.stopped'), `events=${events.length}`);
  }
})()
  .catch((err) => {
    failures += 1;
    check('fatal', '真实联调执行', false, String(err && err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : err));
  })
  .finally(async () => {
    if (agentProcess && agentProcess.exitCode === null) {
      try {
        agentProcess.kill();
      } catch {
        /* ignore */
      }
    }
    if (hubProcess && hubProcess.exitCode === null) {
      try {
        hubProcess.kill();
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
    const files = await writeEvidence();
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(`\n证据：${files.mdFile}`);
    console.log(`结论：${evidence.verdict}（${evidence.checks.filter((item) => item.ok).length}/${evidence.checks.length}）`);
    if (evidence.blocked) {
      console.log('阻塞：' + evidence.blocked.split('\n')[0]);
      process.exit(2);
    }
    process.exit(failures === 0 ? 0 : 1);
  });