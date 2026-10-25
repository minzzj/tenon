#!/usr/bin/env node
// 榫卯 Tenon 节点 Agent
// 流程：读 data/secrets.json 的 nodeToken → 注册能力 → 每 2 秒心跳 → 每 1 秒拉任务
//       → 执行能力 → 回报 task.step / task.succeeded / task.failed（data 与 ledger.append 同构）
// 幂等：执行过的 taskId 记入 data/node-state.json；重启后再拉到同一任务只回报「已执行过」.
// 环境变量：TENON_HUB_URL（默认 http://127.0.0.1:7410）、TENON_NODE_NAME（默认 工作台）、
//           TENON_DATA_DIR（可选，默认 <仓库根>/data）、TENON_NODE_TOKEN（可选，覆盖 secrets.json）、
//           TENON_NODE_ID（可选，首次生成的节点 id，默认 node-local，与 seed-demo 的「本机工作台」对齐）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { capabilities, manifest } from './capabilities.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const AGENT_VERSION = '0.1.0';
const HUB_URL = String(process.env.TENON_HUB_URL || 'http://127.0.0.1:7410').replace(/\/+$/, '');
const NODE_NAME = String(process.env.TENON_NODE_NAME || '工作台');
const NODE_ID_DEFAULT = String(process.env.TENON_NODE_ID || 'node-local').trim() || 'node-local';
const DATA_DIR = process.env.TENON_DATA_DIR ? path.resolve(process.env.TENON_DATA_DIR) : path.join(REPO_ROOT, 'data');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
const IDENTITY_FILE = path.join(DATA_DIR, 'node-identity.json');
const STATE_FILE = path.join(DATA_DIR, 'node-state.json');
const HEARTBEAT_MS = 2000;
const PULL_MS = 1000;
const DONE_KEEP = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args) {
  const clock = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${clock}] ${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function platformLabel() {
  return `${process.platform}-${process.arch}`;
}

// 节点身份持久化：首次生成 node_xxx，之后一直复用（中枢据此认人）
export function loadOrCreateIdentity() {
  const fingerprint = crypto
    .createHash('sha256')
    .update([os.hostname(), process.platform, process.arch, REPO_ROOT].join('|'))
    .digest('hex')
    .slice(0, 16);
  const saved = readJson(IDENTITY_FILE, null);
  if (saved && typeof saved.id === 'string' && saved.id.trim()) {
    return {
      ...saved,
      name: saved.name || NODE_NAME,
      platform: saved.platform || platformLabel(),
      fingerprint: saved.fingerprint || fingerprint,
    };
  }
  const identity = {
    id: NODE_ID_DEFAULT,
    name: NODE_NAME,
    platform: platformLabel(),
    fingerprint,
    createdAt: new Date().toISOString(),
    note: '榫卯节点身份，请勿删除；删掉会被中枢当成新节点',
  };
  writeJson(IDENTITY_FILE, identity);
  log(`首次运行，已生成节点身份 ${identity.id}（保存在 ${IDENTITY_FILE}）`);
  return identity;
}

export function loadNodeToken() {
  const secrets = readJson(SECRETS_FILE, null);
  if (secrets && typeof secrets.nodeToken === 'string' && secrets.nodeToken.trim()) return secrets.nodeToken.trim();
  const envToken = String(process.env.TENON_NODE_TOKEN || '').trim();
  return envToken || null;
}

export function readNodeState() {
  const raw = readJson(STATE_FILE, null);
  if (raw && raw.done && typeof raw.done === 'object' && !Array.isArray(raw.done)) {
    return { done: raw.done, updatedAt: raw.updatedAt || null };
  }
  return { done: {}, updatedAt: null };
}

function pruneDone(done) {
  const keys = Object.keys(done);
  if (keys.length <= DONE_KEEP) return done;
  const sorted = keys.sort((a, b) => String(done[a].at || '').localeCompare(String(done[b].at || '')));
  const keep = new Set(sorted.slice(sorted.length - DONE_KEEP + 100));
  const out = {};
  for (const key of keys) if (keep.has(key)) out[key] = done[key];
  return out;
}

export class NodeAgent {
  constructor(options = {}) {
    this.identity = loadOrCreateIdentity();
    this.nodeId = this.identity.id;
    this.nodeName = NODE_NAME;
    this.platform = platformLabel();
    this.fingerprint = this.identity.fingerprint;
    this.hubUrl = HUB_URL;
    this.dataDir = DATA_DIR;
    this.token = loadNodeToken();
    this.registered = false;
    this.stopping = false;
    this.executing = false;
    this.currentTaskId = null;
    this.heartbeatTimer = null;
    this.pullTimer = null;
    this.heartbeatDown = false;
    this.pullDown = false;
    this.registerDown = false;
    this.skipReported = new Set();
    this.lastHeartbeatAt = null;
    const saved = readNodeState();
    this.done = saved.done;
    this.doneCount = Object.keys(this.done).length;
    if (options.hubUrl) this.hubUrl = String(options.hubUrl).replace(/\/+$/, '');
  }

  httpPath(pathname) {
    return this.hubUrl + pathname;
  }

  async http(pathname, { method = 'POST', body, timeoutMs = 5000 } = {}) {
    const headers = { 'content-type': 'application/json', 'x-tenon-node': this.token || '' };
    let res;
    try {
      res = await fetch(this.httpPath(pathname), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const cause = err && err.cause ? err.cause.code || err.cause.message || '' : '';
      const e = new Error(`无法连接中枢 ${this.hubUrl}：${cause || (err && err.message) || err}`);
      e.status = 0;
      throw e;
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${method} ${pathname}：${String(text).slice(0, 160)}`);
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  ensureToken() {
    if (!this.token) this.token = loadNodeToken();
    if (!this.token) {
      throw new Error(`缺少节点令牌：${SECRETS_FILE} 还没生成（先启动中枢），或设置 TENON_NODE_TOKEN`);
    }
    return this.token;
  }

  async register() {
    this.ensureToken();
    const payload = {
      nodeId: this.nodeId,
      name: this.nodeName,
      platform: this.platform,
      fingerprint: this.fingerprint,
      capabilities: manifest,
    };
    const data = await this.http('/api/node/register', { body: payload });
    const first = !this.registered;
    this.registered = true;
    if (this.registerDown) {
      log('已重新注册到中枢，节点恢复在线');
      this.registerDown = false;
    } else if (first) {
      log(`已注册到中枢 ${this.hubUrl}：${data.nodeId || this.nodeId}（能力 ${manifest.length} 项）`);
    }
    return true;
  }

  async tryRegister() {
    try {
      await this.register();
    } catch (err) {
      if (!this.registerDown) {
        log(`重新注册失败：${err.message}；继续重试`);
        this.registerDown = true;
      }
    }
  }

  async connect() {
    let attempt = 0;
    while (!this.stopping) {
      attempt += 1;
      try {
        await this.register();
        return true;
      } catch (err) {
        if (attempt === 1 || attempt % 5 === 0) {
          log(`注册失败（第 ${attempt} 次）：${err.message}；2 秒后重试`);
        }
        await sleep(2000);
      }
    }
    return false;
  }

  async heartbeatOnce() {
    try {
      await this.http('/api/node/heartbeat', {
        body: { nodeId: this.nodeId, at: new Date().toISOString(), name: this.nodeName },
      });
      this.lastHeartbeatAt = Date.now();
      if (this.heartbeatDown) {
        log('心跳恢复，节点重新在线');
        this.heartbeatDown = false;
      }
    } catch (err) {
      if (err.status === 404) {
        this.registered = false;
        log('中枢不认识该节点（可能账本被清空），准备重新注册');
        return;
      }
      if (!this.heartbeatDown) {
        log(`心跳失败：${err.message}（继续重试，中枢启动后会自动恢复）`);
        this.heartbeatDown = true;
      }
    }
  }

  startHeartbeatLoop() {
    const tick = async () => {
      if (this.stopping) return;
      if (!this.registered) await this.tryRegister();
      else await this.heartbeatOnce();
      if (!this.stopping) this.heartbeatTimer = setTimeout(tick, HEARTBEAT_MS);
    };
    this.heartbeatTimer = setTimeout(tick, 0);
  }

  startPullLoop() {
    const tick = async () => {
      if (this.stopping) return;
      if (this.registered && !this.executing) await this.pullOnce();
      if (!this.stopping) this.pullTimer = setTimeout(tick, PULL_MS);
    };
    this.pullTimer = setTimeout(tick, PULL_MS);
  }

  async pullOnce() {
    let data;
    try {
      data = await this.http(`/api/node/pull?nodeId=${encodeURIComponent(this.nodeId)}`, { method: 'GET' });
      if (this.pullDown) {
        log('拉取任务恢复');
        this.pullDown = false;
      }
    } catch (err) {
      if (err.status === 404) {
        this.registered = false;
        return;
      }
      if (!this.pullDown) {
        log(`拉取任务失败：${err.message}（继续重试）`);
        this.pullDown = true;
      }
      return;
    }
    const tasks = Array.isArray(data && data.tasks) ? data.tasks : data && data.task ? [data.task] : [];
    for (const task of tasks) {
      if (this.stopping) break;
      if (task && (task.id || task.taskId)) await this.handleTask(task);
    }
  }

  attemptOf(task) {
    const raw = task.retries !== undefined && task.retries !== null
      ? task.retries
      : task.attempt !== undefined && task.attempt !== null
        ? task.attempt
        : 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  capabilityIdOf(task) {
    if (!task) return null;
    if (task.capabilityId) return task.capabilityId;
    if (task.capability && typeof task.capability === 'string') return task.capability;
    if (task.cap && task.cap.id) return task.cap.id;
    const fromDraft = task.draft && task.draft.capabilities && task.draft.capabilities[0];
    return fromDraft ? fromDraft.id : null;
  }

  async report(type, data) {
    if (!this.token) this.token = loadNodeToken();
    if (!this.token) throw new Error('节点令牌缺失，无法上报');
    return this.http('/api/node/event', { body: { type, data } });
  }

  // 上报失败重试 3 次；仍失败只记日志，不重复执行任务（幂等记录已先落盘）
  async safeReport(type, data) {
    let lastError = null;
    for (let i = 0; i < 3 && !this.stopping; i += 1) {
      try {
        await this.report(type, data);
        return true;
      } catch (err) {
        lastError = err;
        if (err.status === 401) this.token = loadNodeToken();
        await sleep(300 * (i + 1));
      }
    }
    log(`上报 ${type} 失败：${lastError ? lastError.message : '未知错误'}`);
    return false;
  }

  recordDone(taskId, attempt, outcome) {
    const ok = outcome.status === 'succeeded';
    const result = outcome.result || null;
    this.done[taskId] = {
      at: new Date().toISOString(),
      status: outcome.status,
      attempt,
      partial: ok ? !!(result && result.partial) : false,
      summary: ok ? String((result && result.summary) || '') : String(outcome.error || ''),
    };
    this.done = pruneDone(this.done);
    this.doneCount = Object.keys(this.done).length;
    try {
      writeJson(STATE_FILE, { nodeId: this.nodeId, updatedAt: new Date().toISOString(), done: this.done });
    } catch (err) {
      log(`写幂等状态失败：${err.message}`);
    }
  }

  capabilityContext(taskId) {
    const agent = this;
    return {
      repoRoot: REPO_ROOT,
      dataDir: this.dataDir,
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      taskId,
      async step(label, detail) {
        await agent.safeReport('task.step', { taskId, label, detail });
      },
    };
  }

  async handleTask(task) {
    const taskId = String(task.id || task.taskId);
    const attempt = this.attemptOf(task);
    const key = `${taskId}#${attempt}`;
    const history = this.done[taskId];
    // 幂等：已执行过「本次或更新的一次尝试」都跳过；中枢重试（retries 增大）才允许再执行
    if (history && (Number(history.attempt) || 0) >= attempt) {
      if (!this.skipReported.has(key)) {
        this.skipReported.add(key);
        log(`任务 ${taskId} 本节点已执行过（幂等），只回报「已执行过」`);
        await this.safeReport('task.step', { taskId, label: '已执行过', detail: '本节点已执行过该任务，跳过重复执行' });
      }
      return;
    }
    const capabilityId = this.capabilityIdOf(task);
    const capability = capabilities.find((cap) => cap.id === capabilityId) || null;
    this.executing = true;
    this.currentTaskId = taskId;
    const startedAt = Date.now();
    await this.safeReport('task.step', {
      taskId,
      label: '开始执行',
      detail: `${this.nodeName} 接单 · 能力 ${capability ? capability.name : capabilityId || '未知'}`,
    });
    let outcome;
    try {
      if (!capability) throw new Error(`节点不支持该能力：${capabilityId || '未知'}`);
      const normalized = {
        ...task,
        id: taskId,
        capabilityId,
        params: (task.params && typeof task.params === 'object' ? task.params : task.draft && task.draft.params) || {},
      };
      const result = await capability.run(normalized, this.capabilityContext(taskId));
      if (!result || typeof result !== 'object' || typeof result.summary !== 'string') {
        throw new Error(`能力 ${capabilityId} 返回结果不合法（缺 summary）`);
      }
      outcome = {
        status: 'succeeded',
        result: { summary: result.summary, items: Array.isArray(result.items) ? result.items : [], partial: !!result.partial },
      };
    } catch (err) {
      outcome = { status: 'failed', error: String(err && err.message ? err.message : err).slice(0, 300) };
    }
    // 先写幂等记录再回报：file.delete 这类不可逆动作宁可少执行，也不能重复执行
    this.recordDone(taskId, attempt, outcome);
    const cost = Date.now() - startedAt;
    if (outcome.status === 'succeeded') {
      await this.safeReport('task.succeeded', { taskId, result: outcome.result });
      log(`任务 ${taskId} 成功（${cost}ms）：${outcome.result.summary}`);
    } else {
      await this.safeReport('task.failed', { taskId, error: outcome.error });
      log(`任务 ${taskId} 失败（${cost}ms）：${outcome.error}`);
    }
    this.executing = false;
    this.currentTaskId = null;
  }

  async stop(signal = 'SIGINT') {
    if (this.stopping) return;
    this.stopping = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.pullTimer) clearTimeout(this.pullTimer);
    log(`收到 ${signal}，准备优雅退出…`);
    const startedAt = Date.now();
    while (this.executing && Date.now() - startedAt < 5000) await sleep(100);
    if (this.executing) log('仍有任务在执行，等待超过 5 秒，直接退出（中枢会按心跳超时标记离线）');
    log(`节点已停止（已执行任务 ${this.doneCount} 个，幂等状态保存在 ${STATE_FILE}）`);
  }

  async shutdown(signal = 'SIGINT') {
    await this.stop(signal);
    process.exit(0);
  }

  async start() {
    log(`榫卯节点 Agent v${AGENT_VERSION} 启动`);
    log(`仓库根：${REPO_ROOT}`);
    log(`中枢：${this.hubUrl}`);
    log(`节点：${this.nodeName}（${this.nodeId}）`);
    log(`数据目录：${this.dataDir}｜已有幂等记录 ${this.doneCount} 条`);
    await this.connect();
    if (this.stopping) return;
    this.startHeartbeatLoop();
    this.startPullLoop();
    log(`已上线：心跳每 ${HEARTBEAT_MS / 1000} 秒，拉任务每 ${PULL_MS / 1000} 秒；Ctrl+C 优雅退出`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const agent = new NodeAgent();
  const stop = (signal) => {
    agent.shutdown(signal).catch((err) => {
      log(`优雅退出失败：${err && err.message ? err.message : err}`);
      process.exit(1);
    });
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  // 自测/容器场景：stdin 关闭即优雅退出（TENON_STDIN_STOP=1 时启用；Windows 下比程序化发 SIGINT 可靠）
  if (String(process.env.TENON_STDIN_STOP || '') === '1') {
    try {
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', () => {});
      process.stdin.on('end', () => stop('stdin'));
    } catch (err) {
      log(`启用 stdin 退出监听失败：${err && err.message ? err.message : err}`);
    }
  }
  agent.start().catch((err) => {
    log(`节点启动失败：${err && err.message ? err.message : err}`);
    process.exit(1);
  });
}

export { sleep, log, readJson, writeJson, HUB_URL, NODE_NAME, DATA_DIR, SECRETS_FILE, IDENTITY_FILE, STATE_FILE };
export default NodeAgent;
