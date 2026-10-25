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
      note: '缺失约 ' + Math.max(1, Math.round(gapMs / 60000)) + ' 分钟事件，任务未重复',
    });
    for (const id of stillRunning) {
      ledger.append('task.step', { taskId: id, label: '重启核对', detail: '任务未重复执行，现场已保留' });
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

const ai = new AI();
const { httpServer, kick } = createHttpServer({ root, ledger, state: replay(ledger.events), ai, secret, mode, readOnly, version });

let server;
function shutdown() {
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
  const urls = lanUrls(port);
  console.log('榫卯 Tenon v' + version + ' · 中枢已启动');
  console.log('模式: ' + mode + (readOnly ? ' · 只读实例' : '') + ' | 数据目录: ' + dataDir);
  console.log('桌面控制台: http://127.0.0.1:' + port);
  for (const u of urls) console.log('手机端（局域网）: ' + u + '/m');
  console.log('操作令牌: ' + secret.operatorToken);
  console.log('节点令牌文件: ' + secretsFile);
  if (recovered) console.log('异常恢复: 缺失约 ' + Math.max(1, Math.round(gapMs / 60000)) + ' 分钟事件，任务未重复执行');
  kick();
});