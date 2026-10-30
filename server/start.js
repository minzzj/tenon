import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from './lib/ledger.js';
import { replay } from './lib/state.js';
import { AI } from './lib/ai.js';
import { createHttpServer } from './lib/http.js';

const root = path.resolve(import.meta.dirname, '..');
const env = process.env;
const dataDir = path.resolve(root, env.TENON_DATA_DIR || 'data');
const port = Number(env.TENON_PORT || 7410);
const host = env.TENON_HOST || '127.0.0.1';
const mode = env.TENON_MODE || 'solo';
const version = '0.1.0';
const wantReadOnly = process.argv.includes('--read-only');

fs.mkdirSync(dataDir, { recursive: true });

const secretsFile = path.join(dataDir, 'secrets.json');
let secret;
if (fs.existsSync(secretsFile)) {
  secret = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
} else {
  secret = {
    operatorToken: 'tok_' + crypto.randomBytes(10).toString('hex'),
    nodeToken: 'node_' + crypto.randomBytes(10).toString('hex'),
  };
  fs.writeFileSync(secretsFile, JSON.stringify(secret, null, 2));
}

const ledger = new Ledger(dataDir);
let state = replay(ledger.events);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const lockFile = path.join(dataDir, 'hub.lock');
let readOnly = wantReadOnly;
if (!readOnly) {
  let locked = false;
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (pid && pid !== process.pid && pidAlive(pid)) locked = true;
    else {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* stale lock */
      }
    }
  }
  if (locked) readOnly = true;
  else fs.writeFileSync(lockFile, String(process.pid));
}

const lastBoot = state.boots.length ? state.boots[state.boots.length - 1] : null;
let recovered = false;
let gapMs = 0;
const stillRunning = Object.values(state.tasks).filter((t) => t.status === 'running').map((t) => t.id);

if (!readOnly) {
  if (lastBoot && !lastBoot.stoppedAt) {
    recovered = true;
    gapMs = Math.max(0, Date.now() - (state.dataAsOf ? new Date(state.dataAsOf).getTime() : Date.now()));
    ledger.append('system.crashRecovery', {
      gapMs,
      tasksResumed: stillRunning,
      note: '缺失约 ' + Math.max(1, Math.round(gapMs / 60000)) + ' 分钟事件，任务未重复；在途任务已降级为待确认',
    });
    // P1 修复：重启后仍在 running 的任务必须降级为「待确认」，否则会永久停在“执行中”。
    // state.js 的 task.needsConfirm 会把任务置为 pending 并标 needsReview（界面上可重新确认/取消）。
    for (const id of stillRunning) {
      ledger.append('task.needsConfirm', {
        taskId: id,
        reason: '进程重启，任务未重复执行，已降级为待确认',
      });
    }
  }

  state = replay(ledger.events);
  if (!state.nodes.hub) {
    ledger.append('node.registered', {
      nodeId: 'hub',
      name: '本机中枢',
      platform: 'hub',
      fingerprint: 'local-hub',
      capabilities: [
        { id: 'channel.notify', name: '发送消息（摘要+链接）', risk: 'irreversible', manualOnly: false, version: '1.0.0', evidence: '通道回执与留痕' },
        { id: 'llm.summarize', name: '模型摘要', risk: 'reversible', manualOnly: false, version: '1.0.0', evidence: '调用记录 + token 用量' },
      ],
    }, 'hub');
  }
  ledger.append('system.boot', { pid: process.pid, mode, recovered, version });
}

function lanUrls(p) {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push('http://' + ni.address + ':' + p);
    }
  }
  return out;
}

// DeepSeek 配置：环境变量优先，其次 data/secrets.json（local，不提交）
const deepseekKey = process.env.DEEPSEEK_API_KEY || secret.deepseekApiKey || '';
const deepseekModel = process.env.DEEPSEEK_MODEL || secret.deepseekModel || 'deepseek-chat';
const deepseekBase = process.env.DEEPSEEK_BASE_URL || secret.deepseekBaseUrl || 'https://api.deepseek.com';
const ai = new AI({ apiKey: deepseekKey, model: deepseekModel, baseUrl: deepseekBase });
const { httpServer, kick, v2 } = await createHttpServer({
  root, ledger, state: replay(ledger.events), ai, secret, mode, readOnly, version, dataDir,
  onShutdown: () => shutdown(),
});

let server;
let stopping = false;
function shutdown() {
  if (stopping) return; // 幂等：SIGINT 与 /api/shutdown 同时到达时只清理一次
  stopping = true;
  try {
    if (!readOnly) ledger.append('system.stopped', { pid: process.pid });
  } catch {
    /* ignore */
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }
  try {
    if (!readOnly) fs.unlinkSync(lockFile);
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 120);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server = httpServer.listen(port, host, () => {
  console.log('榫卯 Tenon v' + version + ' · 中枢已启动');
  console.log('模式: ' + mode + (readOnly ? ' · 只读实例' : '') + ' | 数据目录: ' + dataDir);
  console.log('桌面控制台: http://127.0.0.1:' + port);
  // P2 修复：只有绑定 0.0.0.0（或具体局域网 IP）时才打印手机可达地址；
  // 默认 127.0.0.1 时打印如何开启局域网，避免打印不可达的地址误导用户。
  if (host === '0.0.0.0' || host === '::') {
    for (const u of lanUrls(port)) console.log('手机端（局域网）: ' + u + '/m');
  } else if (host === '127.0.0.1' || host === 'localhost') {
    console.log('手机端：需设置 TENON_HOST=0.0.0.0 后重启，再用 http://<电脑IP>:' + port + '/m');
  } else {
    console.log('手机端（局域网）: http://' + host + ':' + port + '/m');
  }
  console.log('操作令牌: ' + secret.operatorToken);
  console.log('节点令牌文件: ' + secretsFile);
  const v2mods = v2 && v2.services ? Object.keys(v2.services) : [];
  console.log('v2 模块: ' + (v2mods.length ? v2mods.join(', ') : '（未实现，接口返回 503）') + (v2 && v2.mountErrors && v2.mountErrors.length ? ' | 待接入: ' + v2.mountErrors.join(', ') : ''));
  if (recovered) console.log('异常恢复: 缺失约 ' + Math.max(1, Math.round(gapMs / 60000)) + ' 分钟事件，任务未重复；在途任务已降级为待确认');
  kick();
});