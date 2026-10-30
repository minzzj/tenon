// 榫卯 V4 · 自研执行器（OpenClaw 式）：DeepSeek 规划 → 动作白名单 → 执行 → 结果回传 ≤3 轮 → 审计
// 路由（相对 /api/v2）：POST /agent/execute；GET /agent/status；GET /agent/audit；POST /agent/confirm；
//   GET /agent/confirm/pending；GET /agent/actions
// 供 harness/外部 agent 调用（agentId 标识），也供桌面端「超级终端」直接调用。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { replay } from '../state.js';
import { nowIso } from '../link/util.js';
import { loadConfig } from '../voice/config.js';
import { createWorkers } from '../voice/workers.js';
import { AGENT_ACTIONS, planAgent, followUpAgent, buildCatalogText, sanitizeAgentPlan, rulePlanOf } from './planner.js';
import { resolveAgentPrompts } from './prompts.js';
import { createAgentExecutor } from './executor.js';
import { createOpenClawService, detectOpenClaw } from './openclaw.js';

export const AGENT_VERSION = '4.0.0';
const PENDING_TTL_MS = 10 * 60 * 1000;
const IRREVERSIBLE_WORDS = /打印|删除|格式化|关机|付款|转账|发到|发送到|对.*发送|shell|执行命令|运行命令/i;

function clampText(s, n = 300) { return String(s === undefined || s === null ? '' : s).slice(0, n); }
function asString(v) { return v == null ? '' : String(v); }

export function createAgentService(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const dataDir = path.resolve(opts.dataDir || path.join(root, 'data'));
  const ledger = opts.ledger || null;
  const ai = opts.ai || null;
  const readOnly = !!opts.readOnly;
  const authed = typeof opts.authed === 'function' ? opts.authed : (() => false);
  const secret = opts.secret || {};
  let voiceConfig = {};
  try { voiceConfig = loadConfig(dataDir, process.env); } catch { voiceConfig = {}; }

  const agentDir = path.join(dataDir, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  const pendingFile = path.join(agentDir, 'pending-confirms.json');
  const pending = new Map();
  const recent = [];
  const status = { startedAt: nowIso(), lastExec: null, lastError: null, executions: 0, confirms: 0 };
  const openclaw = createOpenClawService({ root, log: (...a) => console.log('[agent:openclaw]', ...a) });
  let openclawLast = null;

  // 本地 Qwen 降级 worker（懒启动；DeepSeek 可用时不会启动）
  let workers = null;
  let workersStarting = false;
  function ensureWorkers() {
    if (workers) return workers;
    try {
      workers = createWorkers({
        root,
        dataDir,
        config: { ...voiceConfig, mock: { ...(voiceConfig.mock || {}), enabled: false }, tts: { ...(voiceConfig.tts || {}), enabled: false } },
        log: (...a) => console.log('[agent]', ...a),
      });
      if (!ai || !ai.available) {
        try { workers.startLlm(); } catch { /* 降级规则 */ }
      }
    } catch (err) {
      console.warn('[agent] 本地模型 worker 初始化失败（降级规则）：' + String((err && err.message) || err));
      workers = null;
    }
    return workers;
  }
  if (!ai || !ai.available) { try { ensureWorkers(); } catch { /* ignore */ } }

  const executor = createAgentExecutor({ root, ledger, dataDir, ai, getState: () => replay(ledger.events), config: voiceConfig });

  function append(type, data) {
    try { if (ledger && typeof ledger.append === 'function') ledger.append(type, data, 'agent'); } catch (err) { console.warn('[agent] 账本写入失败 ' + type); }
  }

  function currentState() {
    try { return replay(ledger.events); } catch { return opts.state || { nodes: {}, meta: {} }; }
  }

  function loadPending() {
    try {
      const raw = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      for (const item of (Array.isArray(raw.items) ? raw.items : [])) {
        if (item && item.id && (!item.expiresAt || new Date(item.expiresAt).getTime() > Date.now())) pending.set(item.id, item);
      }
    } catch { /* ignore */ }
  }
  function savePending() {
    try { fs.writeFileSync(pendingFile, JSON.stringify({ version: 1, items: Array.from(pending.values()).slice(-20), updatedAt: nowIso() }, null, 2), 'utf8'); } catch { /* ignore */ }
  }
  function rememberPending({ text, actions, provider, agentId, context }) {
    const id = 'ag_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    const item = { id, text: clampText(text, 300), actions: actions || [], provider, agentId, context: context || null, status: 'pending', createdAt: nowIso(), expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString() };
    pending.set(id, item);
    savePending();
    return item;
  }
  function pendingPublic(item) {
    return item ? { confirmId: item.id, status: item.status, text: item.text, actions: item.actions, provider: item.provider, agentId: item.agentId, createdAt: item.createdAt, expiresAt: item.expiresAt, result: item.result || null } : null;
  }
  loadPending();

  function recordEvent(ev) {
    recent.push(ev);
    if (recent.length > 50) recent.splice(0, recent.length - 50);
  }

  async function runPlan({ text, context = null, agentId = 'agent', confirmed = false, savePendingOnConfirm = true }) {
    const started = Date.now();
    const catalogText = buildCatalogText({ state: currentState() });
    const prompts = resolveAgentPrompts(voiceConfig);
    const history = [];
    let vc = voiceConfig;
    try { vc = loadConfig(dataDir, process.env); } catch (_) {}
    let plan = await planAgent({ ai, workers: ensureWorkers(), llmProvider: vc.llmProvider || 'auto', text, context, catalogText, history, round: 0, prompts });
    const ruleFallback = sanitizeAgentPlan(rulePlanOf(text));
    if ((!plan.actions || !plan.actions.length) && ruleFallback.actions.length) {
      plan = { ...plan, actions: ruleFallback.actions, say: plan.say || ruleFallback.say, needConfirm: !!plan.needConfirm || ruleFallback.needConfirm };
    }
    let providerUsed = plan.provider;
    let planRounds = 1;
    let steps = [];
    let taskIds = [];
    let needConfirm = plan.needConfirm;
    const ask = plan.ask || '';
    let finalSay = plan.say || '';
    let pendingInfo = null;
    // 强约束：涉及不可逆动作/危险词必须有确认
    if (!confirmed) {
      const riskyAction = (plan.actions || []).some((a) => ['file.print', 'agent.message', 'shell.exec'].includes(a.action));
      if (riskyAction || IRREVERSIBLE_WORDS.test(text)) needConfirm = true;
    } else {
      needConfirm = false;
    }
    let execRounds = 0;
    while (execRounds < 3) {
      if (needConfirm) break;
      if (!plan.actions || !plan.actions.length) break;
      execRounds += 1;
      const exec = await executor.executeActions(plan.actions, { text, agentId, confirmed: confirmed || !plan.needConfirm, by: '执行器' });
      steps = steps.concat(exec.steps || []);
      taskIds = taskIds.concat(exec.taskIds || []);
      const summary = (exec.steps || []).map((s) => s.label + '：' + s.status + (s.summary ? '（' + String(s.summary).slice(0, 120) + '）' : '')).join('；') || (exec.ok ? '执行成功' : '执行失败');
      history.push('第' + execRounds + '轮（' + providerUsed + '）：动作 ' + plan.actions.map((a) => a.action).join('、') + ' → ' + summary);
      if (plan.actions.some((a) => a.action === 'scene.run')) break;
      if (providerUsed !== 'deepseek' || !ai || !ai.available || planRounds >= 3) break;
      try {
        const fu = await followUpAgent({ ai, workers: ensureWorkers(), text, context, catalogText, history, round: planRounds, prompts });
        planRounds += 1;
        if (!fu) break;
        plan = { say: fu.say || plan.say, actions: fu.actions || [], needConfirm: !!fu.needConfirm, ask: fu.ask || '', provider: 'deepseek', rounds: planRounds };
        providerUsed = 'deepseek';
        if (fu.say) finalSay = fu.say;
        if (plan.needConfirm) { needConfirm = true; break; }
        if (!plan.actions.length) break;
      } catch (err) { break; }
    }
    const providerLabel = providerUsed + (planRounds > 1 ? '×' + planRounds : '');
    let replyText = finalSay;
    if (needConfirm) {
      replyText = (finalSay || '这个操作不可逆，需要你确认后我再执行。');
      if (savePendingOnConfirm) pendingInfo = rememberPending({ text, actions: plan.actions || [], provider: providerLabel, agentId, context });
    } else if (!replyText) {
      replyText = steps.length ? steps.map((s) => s.summary).filter(Boolean).slice(0, 2).join('；') : '我在，可以说：打开记事本、把音量调到 60、列一下窗口、截屏。';
    }
    if (!replyText) replyText = steps.length ? '已执行' : '完成';
    const ok = needConfirm ? false : (steps.length ? steps.every((s) => s.status === 'succeeded' || s.status === 'dispatched') : true);
    const result = {
      ok,
      say: clampText(replyText, 400),
      provider: providerLabel,
      rounds: planRounds,
      execRounds,
      steps,
      taskIds,
      needConfirm,
      confirmId: pendingInfo ? pendingInfo.id : null,
      pendingActions: pendingInfo ? pendingInfo.actions : null,
      confirmExpiresAt: pendingInfo ? pendingInfo.expiresAt : null,
      ask,
      agentId,
      latencyMs: Date.now() - started,
      ai: ai ? { available: !!ai.available, model: ai.model, usage: ai.usage || null } : null,
    };
    status.executions += 1;
    status.lastExec = { at: nowIso(), text: clampText(text, 160), provider: providerLabel, ok, needConfirm, rounds: planRounds, latencyMs: result.latencyMs, agentId };
    append('agent.executed', { agentId, text: clampText(text, 300), reply: result.say, provider: providerLabel, rounds: planRounds, ok, needConfirm, confirmId: result.confirmId, actions: (plan.actions || []).map((a) => a.action), steps: steps.slice(0, 8), taskIds, latencyMs: result.latencyMs, at: nowIso() });
    append('voice.command', { text: clampText(text, 300), reply: result.say, actions: (plan.actions || []).map((a) => a.action), ok, provider: providerLabel, source: 'agent', agentId, needConfirm, confirmId: result.confirmId, steps: steps.slice(0, 8), taskIds, latencyMs: result.latencyMs });
    recordEvent({ type: 'execute', at: nowIso(), text: clampText(text, 160), provider: providerLabel, ok, needConfirm, rounds: planRounds });
    return result;
  }

  async function confirmPending({ confirmId, yes = true, agentId = 'confirm' }) {
    const key = String(confirmId || '').trim();
    let item = pending.get(key);
    if (!item) {
      const list = Array.from(pending.values()).filter((x) => x.status === 'pending').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      item = list[0] || null;
    }
    if (!item) return { ok: false, notFound: true, error: '确认已过期或不存在，请重新发起（10 分钟有效）' };
    if (item.expiresAt && new Date(item.expiresAt).getTime() < Date.now() && item.status === 'pending') { item.status = 'expired'; savePending(); return { ok: false, expired: true, error: '确认已过期，请重新发起' }; }
    if (item.status !== 'pending') return { ok: true, already: true, confirmId: item.id, status: item.status, result: item.result || null, message: item.status === 'rejected' ? '已取消，无需再次确认' : '已确认/已执行，无需再次确认' };
    if (yes === false) {
      item.status = 'rejected'; item.decidedAt = nowIso(); savePending(); status.confirms += 1;
      append('agent.executed', { agentId: item.agentId, text: item.text, reply: '已取消', provider: item.provider, ok: false, confirmId: item.id, cancelled: true, steps: [], taskIds: [], at: nowIso() });
      return { ok: true, cancelled: true, confirmId: item.id, status: 'rejected', say: '好的，已取消。' };
    }
    item.status = 'executing'; savePending();
    const exec = await executor.executeActions(item.actions, { text: item.text, agentId: item.agentId || agentId, confirmed: true, by: '执行器确认' });
    const say = exec.steps.length ? exec.steps.map((s) => s.summary).filter(Boolean).slice(0, 2).join('；') : (exec.ok ? '已确认并执行完成' : '执行失败');
    item.status = exec.ok ? 'executed' : 'failed'; item.decidedAt = nowIso(); item.result = { ok: exec.ok, say, steps: exec.steps, taskIds: exec.taskIds }; savePending(); status.confirms += 1;
    append('agent.executed', { agentId: item.agentId, text: item.text, reply: say, provider: item.provider, ok: exec.ok, confirmId: item.id, confirmed: true, steps: exec.steps.slice(0, 8), taskIds: exec.taskIds, at: nowIso() });
    append('voice.command', { text: item.text, reply: say, actions: item.actions.map((a) => a.action), ok: exec.ok, provider: item.provider + '+confirmed', source: 'agent', agentId: item.agentId, confirmed: true, confirmId: item.id, steps: exec.steps.slice(0, 8), taskIds: exec.taskIds });
    recordEvent({ type: 'confirm', at: nowIso(), confirmId: item.id, ok: exec.ok, text: clampText(item.text, 120) });
    return { ok: exec.ok, already: false, confirmed: true, confirmId: item.id, status: item.status, say, result: item.result };
  }

  function getStatus() {
    const workersState = workers && workers.state ? { llm: { state: workers.state.llm.state, model: workers.state.llm.model || null, provider: workers.state.llm.provider } } : { llm: { state: 'not-started' } };
    let provider = 'rule';
    if (ai && ai.available) provider = 'deepseek';
    else if (workersState.llm.state === 'running') provider = 'local';
    return {
      ok: true,
      version: AGENT_VERSION,
      provider,
      model: ai && ai.available ? (ai.model || 'deepseek-chat') : (workersState.llm.model || 'local-qwen'),
      aiAvailable: !!(ai && ai.available),
      aiUsage: ai && ai.usage ? { calls: ai.usage.calls, tokensIn: ai.usage.tokensIn, tokensOut: ai.usage.tokensOut, budgetLeft: typeof ai.budgetLeft === 'function' ? ai.budgetLeft() : null } : null,
      workers: workersState,
      actions: Object.keys(AGENT_ACTIONS),
      irreversible: Object.entries(AGENT_ACTIONS).filter(([, a]) => a.risk === 'irreversible').map(([id]) => id),
      startedAt: status.startedAt,
      lastExec: status.lastExec,
      lastError: status.lastError,
      counters: { executions: status.executions, confirms: status.confirms },
      pending: Array.from(pending.values()).filter((x) => x.status === 'pending').map(pendingPublic),
      openclaw: Object.assign(detectOpenClaw(), { last: openclawLast }),
      recent,
      serverTime: nowIso(),
    };
  }

  function audit(limit = 50) {
    const events = (ledger && ledger.events) || [];
    const items = [];
    for (let i = events.length - 1; i >= 0 && items.length < Math.max(1, Math.min(200, Number(limit) || 50)); i -= 1) {
      const ev = events[i];
      if (ev && (ev.type === 'agent.executed' || ev.type === 'agent.shell')) items.push({ type: ev.type, at: ev.at, data: ev.data });
    }
    return { ok: true, count: items.length, items: items.reverse() };
  }

  function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  async function readBody(req, limit = 2 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('请求体过大'), { statusCode: 413 }); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function readJson(req) {
    const raw = await readBody(req);
    if (!raw.length) return {};
    try { return JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('JSON 解析失败'), { statusCode: 400 }); }
  }
  function requireWrite(req, ctx) {
    if (readOnly) throw Object.assign(new Error('另一窗口为只读'), { statusCode: 423 });
    const ok = (ctx && typeof ctx.authed === 'function' && ctx.authed(req)) || (typeof authed === 'function' && authed(req));
    if (!ok) throw Object.assign(new Error('需要登录令牌'), { statusCode: 401 });
  }

  const routes = [
    { method: 'GET', path: '/agent/status', handler: async (req, res) => sendJson(res, 200, getStatus()) },
    { method: 'GET', path: '/agent/actions', handler: async (req, res) => sendJson(res, 200, { ok: true, actions: AGENT_ACTIONS, version: AGENT_VERSION }) },
    { method: 'GET', path: '/agent/audit', handler: async (req, res, ctx) => {
      const u = ctx && ctx.url ? ctx.url : new URL(req.url, 'http://localhost');
      sendJson(res, 200, audit(Number(u.searchParams.get('limit') || 50)));
    } },
    { method: 'GET', path: '/agent/confirm/pending', handler: async (req, res) => sendJson(res, 200, { ok: true, items: Array.from(pending.values()).filter((x) => x.status === 'pending').map(pendingPublic), status: getStatus() }) },
    { method: 'POST', path: '/agent/execute', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      const text = asString(body.text || body.command || body.prompt).trim();
      if (!text) { sendJson(res, 400, { ok: false, error: '缺少 text（要执行的自然语言请求）', code: 'MISSING_TEXT' }); return; }
      const agentId = asString(body.agentId || body.agent || body.by || 'harness-agent').slice(0, 80);
      const wantProvider = asString(body.provider || body.agentProvider || '');
      try {
        if (wantProvider === 'openclaw') {
          const oc = await openclaw.execute({ text, context: body.context || null, timeoutMs: Number(body.timeoutMs) || 150000 });
          openclawLast = { at: nowIso(), text: clampText(text, 200), ok: !!oc.ok, say: clampText(oc.say || '', 400), durationMs: oc.durationMs || null, error: oc.error || null };
          append('agent.executed', { agentId, text: clampText(text, 300), reply: oc.say || '', provider: 'openclaw', ok: !!oc.ok, openclaw: true, durationMs: oc.durationMs || null, at: nowIso() });
          if (oc.ok) { sendJson(res, 200, { ok: true, say: oc.say, provider: 'openclaw', gateway: oc.gateway, model: oc.model, durationMs: oc.durationMs, steps: [], taskIds: [], needConfirm: false, agentId, status: getStatus() }); return; }
          console.warn('[agent] openclaw 失败，回退自研执行器：' + (oc.error || ''));
        }
        const result = await runPlan({ text, context: body.context || null, agentId, confirmed: body.confirmed === true || body.confirm === true });
        sendJson(res, 200, { ...result, status: getStatus() });
      } catch (err) {
        status.lastError = String((err && err.message) || err);
        sendJson(res, 500, { ok: false, error: status.lastError, code: 'AGENT_EXECUTE_FAILED', agentId });
      }
    } },
    { method: 'GET', path: '/agent/openclaw/status', handler: async (req, res) => sendJson(res, 200, Object.assign({ ok: true }, detectOpenClaw(), { last: openclawLast })) },
    { method: 'POST', path: '/agent/openclaw', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      const text = asString(body.text || body.command || body.prompt).trim();
      if (!text) { sendJson(res, 400, { ok: false, error: '缺少 text', code: 'MISSING_TEXT' }); return; }
      const timeoutMs = Number(body.timeoutMs) || 150000;
      try {
        const oc = await openclaw.execute({ text, context: body.context || null, timeoutMs });
        openclawLast = { at: nowIso(), text: clampText(text, 200), ok: !!oc.ok, say: clampText(oc.say || '', 400), durationMs: oc.durationMs || null, error: oc.error || null };
        append('agent.executed', { text: clampText(text, 300), reply: oc.say || '', provider: 'openclaw', ok: !!oc.ok, openclaw: true, durationMs: oc.durationMs || null, at: nowIso() });
        sendJson(res, 200, Object.assign({ ok: !!oc.ok, agentId: 'openclaw' }, oc, { status: getStatus() }));
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err), code: 'OPENCLAW_FAILED' });
      }
    } },
    { method: 'POST', path: '/agent/confirm', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      const yes = body.yes === false || body.cancel === true || body.confirm === false ? false : true;
      try {
        const result = await confirmPending({ confirmId: body.confirmId || body.id || 'last', yes, agentId: body.agentId || 'confirm' });
        sendJson(res, 200, { ...result, status: getStatus() });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
      }
    } },
  ];

  const service = {
    version: AGENT_VERSION,
    routes,
    getStatus,
    audit,
    runPlan,
    confirmPending,
    listPending: () => Array.from(pending.values()).filter((x) => x.status === 'pending').map(pendingPublic),
    actions: AGENT_ACTIONS,
    workers: () => workers,
    executor,
    dataDir,
  };
  process.once('exit', () => { try { if (workers) workers.stopAll(); } catch { /* ignore */ } });
  return service;
}

export default createAgentService;
