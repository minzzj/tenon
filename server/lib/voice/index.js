// 榫卯 V3 · 语音管家服务（Round5 核心链路）
//   ASR worker（FunASR/SenseVoice）→ 唤醒词（文本别名 + 拼音模糊）→ 本地小模型规划（Qwen2.5）+ 规则回退
//   → 执行（super 任务队列/场景/甩屏）→ TTS 回复 → SSE 实时字幕 + 账本 voice.* + 本地转写 JSONL（隐私过滤）
// 契约：data/voice/config.json；data/voice/transcripts/YYYY-MM-DD.jsonl；账本 voice.transcript/wake/command/reply
// 路由（Lead 挂载 /api/v2/voice/*）：status/config/start/stop/command/transcript/transcribe/stream/transcripts/speak/mock
// 无 worker 时优雅降级：/status 返回未就绪原因；/command 文本入口仍可用（规则引擎），其它页面不受影响。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';
import { replay } from '../state.js';
import { nowIso } from '../link/util.js';
import { loadConfig, saveConfig, publicConfig, PATCHABLE_KEYS, VOICE_VERSION } from './config.js';
import { createTranscriptStore, createScreenStore, createEventHub, filterTranscript, dayKey } from './store.js';
import { createWorkers, mockPlanOf } from './workers.js';
import { planCommand, followUpPlan, buildCatalogText, sanitizePlan, extractJson, rulePlanOf } from './planner.js';
import { createExecutor } from './executor.js';
import { resolvePrompts } from './prompts.js';
import { createDiaryGenerator } from './diary.js';
import { isRealDay } from '../documents/safe-path.js';

export const VOICE_STATES = ['idle', 'starting', 'listening', 'wake', 'session', 'thinking', 'executing', 'reply', 'error'];
export const WAKE_ALIASES = ['榫卯', '小榫', '你好榫卯', '榫卯在吗', '小助手', '孙某', '孙卯'];
export const WAKE_PINYIN = ['sun mou', 'sun mao', 'sun mao zai', 'ni hao sun mao', 'sunmao', 'xiao sun', 'xiao shun', 'xiao sun zai', 'xiao zhushou'];

function httpError(statusCode, message) { const err = new Error(message || ('HTTP ' + statusCode)); err.statusCode = statusCode; return err; }
function escapeReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function normalizeVoiceText(s) { return String(s || '').replace(/[\s,，。.!！?？、;；:：·\-—~"'“”‘’()（）\[\]【】]/g, ''); }

/** 唤醒词匹配：文本别名 OR 拼音模糊（覆盖「孙某/小孙」等同音误识别） */
export function detectWake(text, pinyin = '', wakeWords = []) {
  const flatText = normalizeVoiceText(text);
  const py = String(pinyin || '').toLowerCase().replace(/\s+/g, ' ');
  const words = Array.from(new Set([...(Array.isArray(wakeWords) ? wakeWords : []), ...WAKE_ALIASES].map((w) => normalizeVoiceText(w)).filter(Boolean)));
  let word = null;
  let via = null;
  for (const w of words) {
    if (flatText.indexOf(w) >= 0) { word = w; via = 'text'; break; }
  }
  if (!word && py) {
    for (const p of WAKE_PINYIN) {
      if (py.indexOf(p) >= 0) { word = p; via = 'pinyin'; break; }
    }
  }
  if (!word) return { wake: false, word: null, via: null, rest: String(text || '') };
  let rest = String(text || '');
  for (const w of words) rest = rest.replace(new RegExp(escapeReg(w), 'g'), ' ');
  rest = rest.replace(new RegExp(escapeReg(word), 'g'), ' ');
  rest = rest.replace(/^[\s,，。.!！?？、;；:：·\-—~]+/, '').replace(/\s+/g, ' ').trim();
  return { wake: true, word, via, rest };
}

function newSessionId() { return 'vs_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'); }
function clampText(s, n = 300) { return String(s === undefined || s === null ? '' : s).slice(0, n); }
function audioFileNameOf(file) { return file ? path.basename(String(file)) : null; }
function audioUrlOf(file) { const name = audioFileNameOf(file); return name ? '/api/v2/voice/reply-audio?id=' + encodeURIComponent(name) : null; }
function audioInfoOf(ttsInfo) {
  if (!ttsInfo || !ttsInfo.ok || !ttsInfo.file || !fs.existsSync(ttsInfo.file)) return null;
  const name = audioFileNameOf(ttsInfo.file);
  return { url: audioUrlOf(ttsInfo.file), id: name, file: name, bytes: ttsInfo.bytes || 0, durationMs: ttsInfo.durationMs || 0, provider: ttsInfo.provider || 'sapi', sampleRate: ttsInfo.sampleRate || 16000 };
}

export function createVoiceService(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const dataDir = path.resolve(opts.dataDir || path.join(root, 'data'));
  const ledger = opts.ledger || null;
  const ai = opts.ai || null;
  const readOnly = !!opts.readOnly;
  const authed = typeof opts.authed === 'function' ? opts.authed : ((req) => false);
  const secret = opts.secret || {};
  let config = loadConfig(dataDir, process.env);

  const hub = createEventHub({ ringSize: 120 });
  const store = createTranscriptStore({ dataDir, retentionDays: config.retentionDays });
  const screenStore = createScreenStore({ dataDir });
  const workers = createWorkers({ root, dataDir, config, log: (...a) => console.log('[voice]', ...a), onAsrEvent: (ev) => handleAsrEvent(ev) });
  const executor = createExecutor({ root, ledger, dataDir, ai, getState: currentState, config });
  const diary = createDiaryGenerator({
    root,
    dataDir,
    ledger,
    getState: currentState,
    workers,
    ai,
    getConfig: () => config,
    appendEvent: append,
    log: (...a) => console.log('[voice]', ...a),
  });
  let diaryTimer = null;
  let diaryCatchUpTimer = null;
  function diaryBroadcast(result) {
    status.lastDiary = result;
    hub.broadcast({ type: 'diary', date: result.date, provider: result.provider, path: result.path, chars: result.chars || 0, summary: result.summary || '', ts: Date.now() });
  }
  function diaryMaybeRun(reason) {
    if (!config.diary || config.diary.enabled === false) return;
    try {
      if (!diary.shouldGenerateToday()) return;
      const date = dayKey();
      hub.broadcast({ type: 'diary_thinking', date, reason, ts: Date.now() });
      diary.generate({ date, by: reason }).then((r) => { diaryBroadcast(r); }).catch((err) => { console.warn('[voice] 日报生成失败：' + String(err && err.message)); hub.broadcast({ type: 'error', text: '日报生成失败：' + String(err && err.message), code: 'DIARY_FAILED' }); });
    } catch (err) {
      console.warn('[voice] diaryMaybeRun 失败：' + String(err && err.message));
    }
  }
  function startDiaryScheduler() {
    if (diaryTimer) return;
    diaryTimer = setInterval(() => diaryMaybeRun('scheduler'), 60000);
    if (diaryTimer.unref) diaryTimer.unref();
    diaryCatchUpTimer = setTimeout(() => diaryMaybeRun('startup-catchup'), 5000);
    if (diaryCatchUpTimer.unref) diaryCatchUpTimer.unref();
  }

  const status = {
    ok: true,
    version: VOICE_VERSION,
    state: 'idle',
    enabled: !!config.enabled,
    sessionId: null,
    startedAt: null,
    lastError: null,
    lastTranscript: null,
    lastCommand: null,
    lastReply: null,
    lastDiary: null,
    lastWake: null,
    lastTts: null,
    busy: false,
    counters: { transcripts: 0, wakes: 0, ambient: 0, commands: 0, replies: 0, ttsFiles: 0, redacted: 0, failures: 0 },
    session: null,
    updatedAt: nowIso(),
  };
  let sessionTimer = null;
  let busy = false;
  let voiceStopping = false;
  let autoStartTimer = null;

  function currentState() {
    try {
      if (ledger && Array.isArray(ledger.events)) return replay(ledger.events);
    } catch { /* ignore */ }
    return opts.state || { nodes: {}, meta: {} };
  }

  function append(type, data) {
    if (!ledger || typeof ledger.append !== 'function') return;
    try { ledger.append(type, data, 'voice'); } catch (err) { console.warn('[voice] 账本写入失败 ' + type + '：' + String(err && err.message)); }
  }

  function setState(stateName, extra = {}) {
    if (!VOICE_STATES.includes(stateName)) stateName = 'idle';
    status.state = stateName;
    status.updatedAt = nowIso();
    Object.assign(status, extra);
    hub.broadcast({ type: 'status', state: stateName, enabled: status.enabled, sessionId: status.sessionId, busy, lastError: status.lastError || null, ts: Date.now() });
  }

  function setError(message) {
    status.lastError = String(message || '').slice(0, 300);
    status.counters.failures += 1;
    setState('error');
    hub.broadcast({ type: 'error', text: status.lastError, code: 'VOICE_ERROR' });
  }

  // ---------------- 会话 ----------------
  function startSession(reason = 'wake') {
    endSession('restart');
    const id = newSessionId();
    status.sessionId = id;
    status.session = { id, startedAt: nowIso(), expiresAt: new Date(Date.now() + config.silenceTimeoutMs).toISOString(), reason };
    setState('session');
    touchSession();
    return status.session;
  }

  function sessionWindowMs() {
    const asrCfg = config.asr || {};
    const wanted = Number(asrCfg.sessionTimeoutMs || 0) + 2000;
    return Math.max(8000, Math.min(30000, wanted || 8000));
  }

  function touchSession() {
    if (sessionTimer) clearTimeout(sessionTimer);
    if (!status.session) return;
    const win = sessionWindowMs();
    status.session.expiresAt = new Date(Date.now() + win).toISOString();
    sessionTimer = setTimeout(() => endSession('silence-timeout'), win);
  }

  function endSession(reason = 'timeout') {
    if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
    if (status.session) hub.broadcast({ type: 'session_end', sessionId: status.session.id, reason });
    status.session = null;
    status.sessionId = null;
    if (status.enabled && ['session', 'wake', 'reply'].includes(status.state)) setState('listening');
  }

  // ---------------- 转写处理 ----------------
  async function handleWakeEvent(ev) {
    const raw = clampText(ev.text || '', 120);
    const word = String(ev.word || '榫卯');
    status.counters.wakes += 1;
    status.lastWake = { at: nowIso(), word, via: ev.via || 'text', text: raw };
    append('voice.wake', { word, via: ev.via || 'text', text: raw, pinyin: clampText(ev.pinyin || '', 160), source: 'mic' });
    hub.broadcast({ type: 'wake', word, via: ev.via || 'text', text: raw, pinyin: ev.pinyin || '', ts: Date.now() });
    startSession('wake');
    const rest = String(ev.rest || '').replace(/^[\s,，。.!！?？]+/, '');
    if (rest && rest.replace(/[\s,，。.!！?？]/g, '').length >= 1) {
      await processCommand(rest, { source: 'wake', sessionId: status.sessionId });
    }
    return { ok: true, wake: true, word, rest };
  }

  function handleAsrEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'wake') { handleWakeEvent(ev).catch((err) => setError('唤醒处理失败：' + String(err && err.message))); return; }
    if (ev.type === 'ambient') { handleAmbient(ev.text, ev); return; }
    if (ev.type === 'session_start') { if (!status.session) startSession('dual'); hub.broadcast({ type: 'session_start', ts: Date.now() }); return; }
    if (ev.type === 'session_end') { endSession(ev.reason || 'asr-session-end'); return; }
    if (ev.type === 'partial') {
      hub.broadcast({ type: 'partial', text: clampText(ev.text, 400), provider: ev.provider || null, source: ev.source || 'mic' });
      return;
    }
    if (ev.type === 'final') {
      handleFinal(ev.text, { pinyin: ev.pinyin || '', source: ev.source || 'mic', provider: ev.provider || null, ms: ev.ms || null });
      return;
    }
    if (ev.type === 'speech_start') {
      hub.broadcast({ type: 'speech_start', ts: Date.now() });
      if (status.session) touchSession();
      else if (status.enabled && status.state === 'listening') setState('listening');
      return;
    }
    if (ev.type === 'speech_end') {
      hub.broadcast({ type: 'speech_end', ts: Date.now() });
      if (status.session) touchSession();
      return;
    }
    if (ev.type === 'ready') { setState(status.enabled ? 'listening' : 'idle'); hub.broadcast({ type: 'ready', provider: ev.provider || 'funasr', ts: Date.now() }); return; }
    if (ev.type === 'heartbeat' || ev.type === 'level') { hub.broadcast({ type: 'level', level: Number(ev.level) || 0, ts: Date.now() }); return; }
    if (ev.type === 'error') { setError(ev.text || 'ASR 错误'); return; }
  }

  function recordTranscript(text, { source = 'mic', wake = false, pinyin = '', sessionId = null, provider = null, device = null } = {}) {
    // 设备标记：手机来源（android/phone）与显式 device=phone 归入手机，其余为电脑；用于多设备分节总结
    const deviceLabel = device || (source === 'android' || source === 'phone' ? 'phone' : 'pc');
    const priv = filterTranscript(text, config);
    const at = nowIso();
    const sensitive = !!priv.redacted;
    const safeText = sensitive ? '' : String(text || '');
    store.append({
      at, text: safeText, source, wake: !!wake, sessionId, provider, device: deviceLabel,
      ...(sensitive ? { redacted: true, sensitiveType: priv.sensitiveType, length: priv.length } : {}),
    });
    append('voice.transcript', {
      text: safeText,
      source,
      device: deviceLabel,
      wake: !!wake,
      sessionId,
      provider,
      sensitive,
      ...(sensitive ? { sensitiveType: priv.sensitiveType, length: priv.length } : {}),
    });
    status.counters.transcripts += 1;
    if (sensitive) status.counters.redacted += 1;
    status.lastTranscript = { at, text: sensitive ? priv.preview : safeText, source, device: deviceLabel, wake: !!wake, sensitive, sensitiveType: priv.sensitiveType || null };
    const payload = { type: 'transcript', text: sensitive ? priv.preview : safeText, source, device: deviceLabel, wake: !!wake, sensitive, sensitiveType: priv.sensitiveType || null, sessionId, provider, at };
    hub.broadcast(payload);
    return { sensitive, safeText, preview: priv.preview, priv };
  }

  // 24 小时录音：未被唤醒的说话持续转写留痕（只记录，不执行）
  function handleAmbient(text, ev = {}) {
    if (!config.ambient || config.ambient.enabled === false) return { ok: true, skipped: true };
    const raw = String(text || '').trim();
    if (!raw) return { ok: false, error: '空转写' };
    const rec = recordTranscript(raw, { source: 'ambient', wake: false, pinyin: ev.pinyin || '', sessionId: null, provider: ev.provider || null });
    status.counters.ambient = (status.counters.ambient || 0) + 1;
    status.lastAmbient = { at: nowIso(), text: rec.sensitive ? rec.preview : raw, provider: ev.provider || null };
    return { ok: true, ambient: true, redacted: !!rec.sensitive };
  }

  async function handleFinal(text, { pinyin = '', source = 'mic', provider = null, ms = null } = {}) {
    const raw = String(text || '').trim();
    if (!raw) return { ok: false, error: '空转写' };
    status.lastError = null;
    const dev = (source === 'android' || source === 'phone') ? 'phone' : 'pc';
    const rec = recordTranscript(raw, { source, wake: false, pinyin, sessionId: status.sessionId, provider, device: dev });
    if (rec.sensitive) {
      return { ok: true, redacted: true, sensitiveType: rec.priv.type };
    }
    const wake = detectWake(raw, pinyin, config.wakeWords);
    if (wake.wake) {
      status.counters.wakes += 1;
      status.lastWake = { at: nowIso(), word: wake.word, via: wake.via, text: clampText(raw, 120) };
      append('voice.wake', { word: wake.word, via: wake.via, text: clampText(raw, 120), pinyin: clampText(pinyin, 160), source });
      hub.broadcast({ type: 'wake', word: wake.word, via: wake.via, text: clampText(raw, 120), pinyin, ts: Date.now() });
      startSession('wake');
      if (wake.rest && wake.rest.replace(/[\s,，。.!！?？]/g, '').length >= 1) {
        await processCommand(wake.rest, { source: 'wake', sessionId: status.sessionId });
      }
      return { ok: true, wake: true, word: wake.word, rest: wake.rest };
    }
    if (status.session && status.sessionId) {
      touchSession();
      const r = await processCommand(raw, { source: 'session', sessionId: status.sessionId });
      touchSession();
      return { ok: true, wake: false, wakeSession: true, command: r };
      return { ok: true, wake: false, wakeSession: true };
    }
    if (status.enabled) setState('listening');
    return { ok: true, wake: false };
  }

  function buildReply({ plan, exec, text }) {
    const parts = [];
    if (plan && plan.say) parts.push(String(plan.say).trim());
    if (exec && Array.isArray(exec.steps) && exec.steps.length) {
      const done = exec.steps.filter((s) => s.status === 'succeeded');
      const failed = exec.steps.filter((s) => s.status !== 'succeeded');
      if (failed.length) {
        parts.push(failed.slice(0, 2).map((s) => s.summary || s.label).join('；'));
      } else if (!plan || !plan.say) {
        parts.push(done.slice(0, 2).map((s) => s.summary || s.label).join('；') || '已执行');
      }
    }
    if (!parts.length) {
      if (plan && plan.error) parts.push('本地模型暂时不可用（' + plan.error + '），已尝试规则执行。');
      else parts.push('我在，可以说：打开记事本、把音量调到 40、回家模式。');
    }
    return clampText(parts.join(' ').replace(/\s+/g, ' '), 220);
  }

  async function ensureLlmReady() {
    const st = workers.state.llm.state;
    if (['running', 'mock'].includes(st)) return true;
    if (st === 'stopped' || st === 'unavailable' || st === 'error') {
      if (config.llmProvider === 'rule') return false;
      try { workers.startLlm(); } catch (err) { console.warn('[voice] LLM 启动失败：' + String((err && err.message) || err)); }
    }
    const started = Date.now();
    while (Date.now() - started < 4000) {
      if (['running', 'mock'].includes(workers.state.llm.state)) return true;
      if (['unavailable', 'error'].includes(workers.state.llm.state)) return false;
      await new Promise((r) => setTimeout(r, 150));
    }
    return ['running', 'mock', 'starting'].includes(workers.state.llm.state);
  }

  function buildStateSummary(st) {
    const parts = [];
    const nodes = Object.values((st && st.nodes) || {});
    const online = nodes.filter((n) => n.online && !n.disconnected && !n.hidden);
    const bindings = (st && st.devices && st.devices.bindings) || {};
    parts.push('设备：共 ' + nodes.length + ' 台，在线 ' + online.length + ' 台，已绑定 ' + Object.keys(bindings).length + ' 台');
    if (online.length) parts.push('在线设备：' + online.slice(0, 6).map((n) => n.name || n.id).join('、'));
    const tasks = Object.values((st && st.tasks) || {}).slice(-6).map((t) => (t.capabilityId || '') + ':' + (t.status || ''));
    if (tasks.length) parts.push('最近任务：' + tasks.join('、'));
    const superState = (st && st.super) || {};
    if (Array.isArray(superState.handoffs) && superState.handoffs.length) parts.push('最近流转：' + superState.handoffs.slice(-2).map((hh) => hh.kind || 'text').join('、'));
    return parts.join('\n').slice(0, 1500);
  }

  async function processCommand(text, { source = 'text', sessionId = status.sessionId, forceConfirm = false, playTts } = {}) {
    const command = String(text || '').trim();
    if (!command) return { ok: false, error: '命令为空' };
    if (busy) {
      hub.broadcast({ type: 'error', text: '上一条命令还在执行，请稍候再说', code: 'VOICE_BUSY' });
      return { ok: false, error: '语音管家正在处理上一条命令' };
    }
    busy = true;
    status.busy = true;
    const started = Date.now();
    status.lastError = null;
    try {
      setState('thinking');
      hub.broadcast({ type: 'thinking', text: clampText(command, 200), ts: Date.now() });
      const prompts = resolvePrompts(config);
      const superFallback = async (t) => {
        const res = await executor.fallbackAsk(t, { by: '语音' });
        return { ok: res.ok, say: res.say, steps: res.steps, taskIds: res.taskIds, provider: 'rule' };
      };
      // 本地 Qwen 仅降级：DeepSeek 可用时后台预热，不阻塞本轮
      if (ai && ai.available) { try { workers.startLlm(); } catch { /* ignore */ } } else { await ensureLlmReady(); }
      const st = currentState();
      const catalogText = buildCatalogText({ state: st, programs: ['notepad', 'chrome', 'wechat', 'explorer', 'calc', 'terminal', 'wmplayer'] });
      const stateSummary = buildStateSummary(st);
      const history = [];
      let plan = await planCommand({ ai, text: command, workers, llmProvider: config.llmProvider, catalogText, stateSummary, history, round: 0, prompts, superFallback });
      if (!forceConfirm) {
        const riskyAction = (plan.actions || []).some((a) => ['file.print', 'agent.message'].includes(a.action) || a.risk === 'irreversible');
        if (riskyAction || /打印|删除|发送|关机|付款|转账|格式化/.test(command)) plan.needConfirm = true;
      }
      let providerUsed = plan.provider || 'rule';
      let rounds = 0;
      let planRounds = 1;
      let steps = [];
      let taskIds = [];
      let lastExec = null;
      let needConfirm = !!plan.needConfirm;
      let pendingInfo = null;
      if (forceConfirm) needConfirm = false;
      const ask = plan.ask || '';
      let finalSay = plan.say || '';
      while (rounds < 3) {
        if (needConfirm) break;
        if (!plan || !Array.isArray(plan.actions) || !plan.actions.length) break;
        rounds += 1;
        setState('executing');
        hub.broadcast({ type: 'executing', actions: plan.actions.map((a) => a.action), round: rounds, provider: providerUsed, ts: Date.now() });
        lastExec = await executor.executeActions(plan.actions, { text: command, by: '语音' });
        steps = steps.concat(lastExec.steps || []);
        taskIds = taskIds.concat(lastExec.taskIds || []);
        const summary = (lastExec.steps || []).map((s) => s.label + ':' + s.status + (s.summary ? '（' + String(s.summary).slice(0, 100) + '）' : '')).join('；') || (lastExec.ok ? '执行成功' : '执行失败');
        history.push('第' + rounds + '轮（' + providerUsed + '）：动作 ' + plan.actions.map((a) => a.action).join('、') + ' → ' + summary + '（ok=' + (lastExec.ok !== false) + '）');
        if (plan.superResult) break;
        if (providerUsed !== 'deepseek' || !ai || !ai.available) break;
        if (rounds >= 3) break;
        setState('thinking');
        hub.broadcast({ type: 'thinking', text: '正在根据执行结果继续判断…', round: rounds + 1, ts: Date.now() });
        const fu = await followUpPlan({ ai, prompt: prompts.planner, text: command, catalogText, stateSummary, history, round: rounds });
        planRounds += 1;
        if (!fu || !fu.plan) break;
        plan = { say: fu.plan.say || plan.say, actions: fu.plan.actions || [], needConfirm: !!fu.plan.needConfirm, ask: fu.plan.ask || '', provider: 'deepseek', latencyMs: (plan.latencyMs || 0) + (fu.latencyMs || 0) };
        providerUsed = 'deepseek';
        if (fu.plan.say) finalSay = fu.plan.say;
        if (plan.needConfirm) { needConfirm = true; finalSay = plan.say || finalSay; break; }
        if (!plan.actions.length) break;
      }
      const providerLabel = providerUsed + (planRounds > 1 ? '×' + planRounds : '');
      if (needConfirm) {
        pendingInfo = rememberPending({ text: command, actions: plan.actions || [], provider: providerLabel, sessionId });
        hub.broadcast({ type: 'need_confirm', confirmId: pendingInfo.id, pendingActions: pendingInfo.actions, text: pendingInfo.text, provider: providerLabel, expiresAt: pendingInfo.expiresAt, ts: Date.now() });
        for (const step of (plan.steps || [])) hub.broadcast({ type: 'need_confirm_step', label: step.label, status: step.status, summary: step.summary || '' });
      }
      let replyText;
      if (needConfirm) {
        replyText = (finalSay || '这个操作不可逆，需要你确认后我再执行。');
      } else if (ask && !steps.length) {
        replyText = finalSay || ask;
      } else {
        replyText = buildReply({ plan: { say: finalSay, actions: plan.actions, needConfirm, ask, error: (plan.errors || []).slice(0, 2).join('；') }, exec: lastExec ? { ok: steps.every((s) => s.status === 'succeeded' || s.status === 'dispatched'), steps } : null, text: command });
      }
      if (!replyText) replyText = '我在，可以说：打开记事本、把音量调到 40、回家模式。';
      let ttsInfo = null;
      let audio = null;
      // 手机来源（source=android/phone）：默认不在电脑播报/生成音频，由手机本地 TTS 播报回复，避免"手机数据传到电脑再播报一遍"
      const phoneSource = source === 'android' || source === 'phone';
      const shouldPlayTts = playTts !== undefined ? !!playTts : (phoneSource ? !!(config.tts && config.tts.playOnPhone === true) : !!config.tts.play);
      if (config.tts.enabled && shouldPlayTts) {
        hub.broadcast({ type: 'tts_thinking', text: replyText, ts: Date.now() });
        ttsInfo = await workers.speak(replyText, { play: !!config.tts.play });
        if (ttsInfo && ttsInfo.ok) {
          status.counters.ttsFiles += 1;
          audio = audioInfoOf(ttsInfo);
          status.lastTts = { at: nowIso(), file: ttsInfo.file || null, bytes: ttsInfo.bytes || 0, voice: ttsInfo.voice || config.tts.voice, ms: ttsInfo.ms || 0, durationMs: ttsInfo.durationMs || 0, provider: ttsInfo.provider || 'sapi', audio };
          hub.broadcast({ type: 'tts', text: replyText, file: ttsInfo.file || null, bytes: ttsInfo.bytes || 0, durationMs: ttsInfo.durationMs || 0, provider: ttsInfo.provider || 'sapi', audio, voice: ttsInfo.voice || null, ms: ttsInfo.ms || 0, at: nowIso() });
        } else if (ttsInfo && !ttsInfo.skipped) {
          hub.broadcast({ type: 'error', text: ttsInfo.error || 'TTS 失败（不影响执行结果）', code: 'TTS_ERROR' });
        }
      }
      const latencyMs = Date.now() - started;
      const ok = needConfirm ? false : steps.length ? steps.every((s) => s.status === 'succeeded' || s.status === 'dispatched') : (lastExec ? lastExec.ok !== false : true);
      status.counters.commands += 1;
      status.counters.replies += 1;
      status.lastCommand = { at: nowIso(), text: clampText(command, 160), reply: replyText, provider: providerLabel, latencyMs, rounds: planRounds, execRounds: rounds, ok };
      status.lastReply = { at: nowIso(), text: replyText, provider: providerLabel, latencyMs, ok, tts: !!(ttsInfo && ttsInfo.ok), needConfirm, ask, rounds: planRounds, execRounds: rounds };
      const aiUsage = ai && ai.usage ? { calls: ai.usage.calls, tokensIn: ai.usage.tokensIn, tokensOut: ai.usage.tokensOut, available: !!ai.available, model: ai.model || null } : null;
      append('voice.command', {
        needConfirm, confirmId: pendingInfo ? pendingInfo.id : null, pendingActions: pendingInfo ? pendingInfo.actions : null,
        text: clampText(command, 300), reply: replyText,
        actions: (steps.length ? [] : []).concat((lastExec && lastExec.steps ? steps : [])).length ? [] : [],
        ok, provider: providerLabel, sessionId, source, latencyMs, rounds: planRounds, execRounds: rounds,
        steps: steps.slice(0, 8).map((s) => ({ label: s.label, status: s.status, summary: s.summary, taskId: s.taskId || null })),
        taskIds, needConfirm, ask, ai: aiUsage,
      });
      append('voice.reply', { text: replyText, tts: !!(ttsInfo && ttsInfo.ok), audio: audio || null, provider: providerLabel, latencyMs, sessionId, rounds: planRounds, needConfirm });
      hub.broadcast({
        type: 'reply', text: replyText, provider: providerLabel, latencyMs, ok, rounds: planRounds, execRounds: rounds, needConfirm, ask, needConfirm, confirmId: pendingInfo ? pendingInfo.id : null, pendingActions: pendingInfo ? pendingInfo.actions : null, confirmExpiresAt: pendingInfo ? pendingInfo.expiresAt : null,
        steps: steps.slice(0, 8), taskIds, sessionId, at: nowIso(),
        tts: ttsInfo ? { ok: !!ttsInfo.ok, file: ttsInfo.file || null, bytes: ttsInfo.bytes || 0, durationMs: ttsInfo.durationMs || 0, provider: ttsInfo.provider || null, audio, voice: ttsInfo.voice || null, error: ttsInfo.error || null } : null,
      });
      setState('reply');
      setTimeout(() => { if (status.enabled && !busy) setState('listening'); }, 900);
      return { ok, say: replyText, command, provider: providerLabel, rounds: planRounds, execRounds: rounds, needConfirm, ask, actions: (lastExec ? lastExec.steps || [] : []).map((s) => ({ label: s.label, status: s.status })), steps, taskIds, latencyMs, ai: aiUsage, tts: ttsInfo ? { ok: !!ttsInfo.ok, file: ttsInfo.file || null, bytes: ttsInfo.bytes || 0, durationMs: ttsInfo.durationMs || 0, provider: ttsInfo.provider || null } : null, audio, sessionId, needConfirm, confirmId: pendingInfo ? pendingInfo.id : null, pendingActions: pendingInfo ? pendingInfo.actions : null, confirmExpiresAt: pendingInfo ? pendingInfo.expiresAt : null };
    } catch (err) {
      status.counters.failures += 1;
      const message = String((err && err.message) || err);
      append('voice.command', { text: clampText(command, 300), reply: '执行失败：' + message, actions: [], ok: false, provider: 'error', sessionId, source, latencyMs: Date.now() - started });
      hub.broadcast({ type: 'error', text: '语音命令失败：' + message, code: 'VOICE_COMMAND_FAILED' });
      setError(message);
      return { ok: false, error: message };
    } finally {
      busy = false;
      status.busy = false;
    }
  }

  // ---------------- 生命周期 ----------------
  function start({ by = 'user' } = {}) {
    // 启动时清掉历史截图（用户要求识别完成后自动删除截图）
    try { cleanupScreenTmp(0); } catch { /* ignore */ }

    if (readOnly) throw httpError(423, '只读实例不能开启语音服务');
    const curAsr = workers.state && workers.state.asr ? workers.state.asr.state : 'stopped';
    if (status.enabled && (curAsr === 'running' || curAsr === 'starting')) {
      // 已在监听：不重复拉起 worker（避免两个 ASR 进程抢麦克风）
      return getStatus();
    }
    status.enabled = true;
    config = saveConfig(dataDir, { ...config, enabled: true });
    hub.broadcast({ type: 'start', by, ts: Date.now() });
    setState('starting');
    let asrOk = false;
    try { asrOk = workers.startAsr(); } catch (err) { status.lastError = 'ASR 启动失败：' + String((err && err.message) || err); }
    try { workers.startLlm(); } catch (err) { console.warn('[voice] LLM 启动失败（降级规则）：' + String((err && err.message) || err)); }
    voiceStopping = false;
    try { startOcrWorker(); } catch (err) { console.warn('[voice] 常驻 OCR 启动失败：' + String((err && err.message) || err)); }
    if (!asrOk) {
      status.lastError = workers.state.asr.lastError || 'ASR 未就绪（可用文本命令）';
      if (!config.mock.enabled) setState('error');
    }
    status.startedAt = nowIso();
    return getStatus();
  }

  function stop({ by = 'user' } = {}) {
    endSession('stopped');
    workers.stopAll();
    status.enabled = false;
    config = saveConfig(dataDir, { ...config, enabled: false });
    setState('idle');
    hub.broadcast({ type: 'stop', by, ts: Date.now() });
    return getStatus();
  }

  function updateConfig(patch = {}) {
    const next = { ...config };
    for (const key of PATCHABLE_KEYS) {
      if (patch[key] === undefined) continue;
      if (key === 'tts' && patch.tts && typeof patch.tts === 'object') next.tts = { ...next.tts, ...patch.tts };
      else next[key] = patch[key];
    }
    const ambientChanged = patch.ambient !== undefined;
    config = saveConfig(dataDir, next);
    workers.updateConfig ? workers.updateConfig(config) : null;
    if (ambientChanged && status.enabled) {
      try { workers.stopAsr(); } catch (err) { /* ignore */ }
      setTimeout(() => { try { workers.startAsr(); } catch (err) { /* ignore */ } }, 400);
    }
    if (patch.enabled === true && !status.enabled) start({ by: 'config' });
    if (patch.enabled === false && status.enabled) stop({ by: 'config' });
    hub.broadcast({ type: 'config', config: publicConfig(config), ts: Date.now() });
    return { ok: true, config: publicConfig(config) };
  }

  let lastLazyAsrAt = 0;
  function maybeLazyStartAsr() {
    try {
      if (!status.enabled || readOnly) return;
      const st = workers.state && workers.state.asr ? workers.state.asr.state : 'stopped';
      if (st === 'running' || st === 'starting') return;
      const now = Date.now();
      if (now - lastLazyAsrAt < 20000) return;
      lastLazyAsrAt = now;
      console.log('[voice] 检测到语音监听已开启但 ASR 未运行，自动拉起');
      workers.startAsr();
    } catch (err) { /* ignore */ }
  }

  function getStatus() {
    maybeLazyStartAsr();
    const workerStatus = workers.getStatus();
    const providers = { ...(workerStatus.providerPlan || {}) };
    if (ai && ai.available) providers.llm = 'deepseek';
    if (!status.lastDiary) {
      try {
        const today = diary.read(dayKey());
        if (today && today.exists) {
          const pm = String(today.markdown || '').match(/provider=([A-Za-z0-9_-]+)/);
          status.lastDiary = { date: today.date, provider: pm ? pm[1] : 'unknown', path: today.path, chars: String(today.markdown || '').length, exists: true };
        }
      } catch (err) { /* 状态回填失败不影响 /status */ }
    }
    return {
      ok: true,
      version: VOICE_VERSION,
      state: status.state,
      enabled: status.enabled,
      ambient: { enabled: !(config.ambient && config.ambient.enabled === false), last: status.lastAmbient || null },
      aiAvailable: !!(ai && ai.available),
      sessionId: status.sessionId,
      session: status.session,
      startedAt: status.startedAt,
      busy: status.busy,
      lastError: status.lastError,
      wakeWords: config.wakeWords.slice(),
      wakeAliases: WAKE_ALIASES.slice(),
      language: config.language,
      providers,
      workers: { asr: workerStatus.asr, llm: workerStatus.llm, tts: workerStatus.tts, scripts: workerStatus.scripts },
      tts: { ...config.tts },
      executor: { mode: config.executor.mode },
      counters: { ...status.counters },
      lastTranscript: status.lastTranscript,
      lastCommand: status.lastCommand,
      lastReply: status.lastReply,
      lastWake: status.lastWake,
      lastTts: status.lastTts,
      mock: { enabled: !!config.mock.enabled },
      transcriptStore: store.stats(),
      screenStore: screenStore.stats(),
      ai: ai && typeof ai.usage === 'object' ? { available: !!ai.available, model: ai.model || null, usage: { calls: ai.usage.calls, tokensIn: ai.usage.tokensIn, tokensOut: ai.usage.tokensOut }, budget: typeof ai.budgetLeft === 'function' ? ai.budgetLeft() : null } : { available: false, model: null },
      diary: { enabled: !!(config.diary && config.diary.enabled), time: (config.diary && config.diary.time) || '23:00', last: status.lastDiary || null, dir: 'data/voice/diary' },
      recentEvents: hub.recent(25),
      lastDiary: status.lastDiary || null,
      dataDir: path.relative(root, dataDir) || '.',
      serverTime: nowIso(),
    };
  }

  // ---------------- HTTP 路由 ----------------
  function requireWrite(req, ctx) {
    if (readOnly) { const e = new Error('另一窗口为只读'); e.statusCode = 423; throw e; }
    const ok = (ctx && typeof ctx.authed === 'function' && ctx.authed(req)) || (typeof authed === 'function' && authed(req));
    if (!ok) { const e = new Error('需要登录令牌'); e.statusCode = 401; throw e; }
  }

  function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  async function readBody(req, limit = 25 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async function readJson(req) {
    const raw = await readBody(req, 2 * 1024 * 1024);
    if (!raw.length) return {};
    try { return JSON.parse(raw.toString('utf8')); } catch { throw Object.assign(new Error('JSON 解析失败'), { statusCode: 400 }); }
  }

  function parseMultipart(buffer, contentType) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
    if (!m) return { files: [], fields: {} };
    const boundary = '--' + (m[1] || m[2]).trim();
    const parts = buffer.toString('latin1').split(boundary).slice(1, -1);
    const files = [];
    const fields = {};
    for (const part of parts) {
      const idx = part.indexOf('\r\n\r\n');
      if (idx < 0) continue;
      const head = part.slice(0, idx);
      let body = part.slice(idx + 4);
      if (body.endsWith('\r\n')) body = body.slice(0, -2);
      const nameM = /name="([^"]+)"/i.exec(head);
      const fileM = /filename="([^"]*)"/i.exec(head);
      const name = nameM ? nameM[1] : '';
      const partType = ((/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || '').trim();
      if (fileM) files.push({ field: name, filename: fileM[1] || 'upload.wav', contentType: partType, data: Buffer.from(body, 'latin1') });
      else if (name) fields[name] = Buffer.from(body, 'latin1').toString('utf8');
    }
    return { files, fields };
  }

  function tempUploadPath(filename = 'upload.wav') {
    const dir = path.join(dataDir, 'voice', 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(filename || 'upload.wav').replace(/[^\w.\-]/g, '_');
    return path.join(dir, Date.now().toString(36) + '-' + safe);
  }

  const FFMPEG_DEFAULT = 'C:\\Users\\Administrator\\AppData\\Local\\ffmpeg-full\\ffmpeg.exe';

  function ffmpegBin() {
    const envPath = String(process.env.TENON_FFMPEG || '').trim();
    if (envPath) return envPath;
    try { if (fs.existsSync(FFMPEG_DEFAULT)) return FFMPEG_DEFAULT; } catch { /* ignore */ }
    return 'ffmpeg';
  }

  function audioFormatOf(filename, contentType) {
    const ct = String(contentType || '').toLowerCase();
    const name = String(filename || '').toLowerCase();
    if (ct.includes('wav') || /\.wav$/.test(name)) return 'wav';
    if (ct.includes('webm') || /\.webm$/.test(name)) return 'webm';
    if (ct.includes('ogg') || /\.ogg$/.test(name)) return 'ogg';
    if (ct.includes('mp4') || ct.includes('m4a') || ct.includes('aac') || /\.(mp4|m4a|aac)$/.test(name)) return 'm4a';
    if (ct.includes('mpeg') || ct.includes('mp3') || /\.(mp3|mpeg)$/.test(name)) return 'mp3';
    if (ct.includes('amr') || /\.amr$/.test(name)) return 'amr';
    if (/\.(wav|webm|ogg|mp4|m4a|aac|mp3|amr|flac)$/.test(name)) return name.slice(name.lastIndexOf('.') + 1);
    return 'raw';
  }

  function runFfmpeg(args, timeoutMs = 90000) {
    return new Promise((resolve, reject) => {
      execFile(ffmpegBin(), args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error('ffmpeg 转换失败：' + String((stderr || err.message) || err).slice(-300)));
        else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
  }

  function spawnPython(args = []) {
    return spawn(config.workers.python || 'python', args, {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
  }

  function runPythonJson(args = [], timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const bin = String(process.env.TENON_PYTHON || 'python');
      execFile(bin, args, { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } }, (err, stdout, stderr) => {
        if (err && !stdout) { reject(new Error('python 执行失败：' + String((stderr || err.message) || err).slice(-300))); return; }
        const lines = String(stdout || '').trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          try { const obj = JSON.parse(lines[i]); resolve(obj); return; } catch { /* next */ }
        }
        reject(new Error('python 输出不是 JSON：' + String(stdout || stderr || '').slice(-240)));
      });
    });
  }

  // 常驻 OCR 进程（每 5 秒截图如果都 spawn python+winrt 会很耗 CPU/内存）
  const ocrWorker = { child: null, rl: null, seq: 0, ready: false, waiters: new Map(), stopRequested: false };
  const lastScreenImages = new Map();
  function startOcrWorker() {
    if (ocrWorker.child) return true;
    const script = path.join(root, 'scripts', 'screen', 'ocr_worker.py');
    if (!fs.existsSync(script)) return false;
    try {
      ocrWorker.stopRequested = false;
      const child = spawnPython([script]);
      ocrWorker.child = child;
      ocrWorker.rl = readline.createInterface({ input: child.stdout });
      ocrWorker.rl.on('line', (line) => {
        const text = String(line || '').trim();
        if (!text) return;
        let obj = null;
        try { obj = JSON.parse(text); } catch { return; }
        if (obj.type === 'ready') { ocrWorker.ready = true; console.warn('[voice] 常驻 OCR 进程就绪'); return; }
        if (obj.type === 'error') { console.warn('[voice] 常驻 OCR 错误：' + String(obj.error || '')); return; }
        const w = ocrWorker.waiters.get(obj.id);
        if (!w) return;
        ocrWorker.waiters.delete(obj.id);
        clearTimeout(w.timer);
        if (obj.ok === false) w.reject(new Error(String(obj.error || 'OCR 失败')));
        else w.resolve({ text: String(obj.text || ''), lines: Array.isArray(obj.lines) ? obj.lines : [], engine: obj.engine || 'windows-ocr', ocrMs: obj.ocrMs || null });
      });
      child.stderr.on('data', (buf) => { const t = String(buf || '').trim(); if (t) console.warn('[voice-ocr] ' + t.slice(0, 300)); });
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});
      child.on('error', () => {});
      if (child.stdin) child.stdin.on('error', () => {});
      child.on('exit', (code) => {
        ocrWorker.child = null; ocrWorker.ready = false;
        for (const [, w] of ocrWorker.waiters) { clearTimeout(w.timer); w.reject(new Error('OCR 进程已退出（code=' + code + '）')); }
        ocrWorker.waiters.clear();
        if (!ocrWorker.stopRequested && !voiceStopping) setTimeout(() => { try { startOcrWorker(); } catch { /* ignore */ } }, 1500);
      });
      console.warn('[voice] 常驻 OCR 进程启动 pid=' + child.pid);
      return true;
    } catch (err) {
      console.warn('[voice] 常驻 OCR 启动失败：' + String((err && err.message) || err));
      return false;
    }
  }
  function stopOcrWorker() {
    ocrWorker.stopRequested = true;
    try { if (ocrWorker.rl) ocrWorker.rl.close(); } catch { /* ignore */ }
    try { if (ocrWorker.child) ocrWorker.child.kill(); } catch { /* ignore */ }
    ocrWorker.child = null; ocrWorker.ready = false;
  }
  function ocrViaWorker(file, { timeoutMs = 25000 } = {}) {
    if (!ocrWorker.child) return Promise.reject(new Error('常驻 OCR 未启动'));
    const id = ++ocrWorker.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ocrWorker.waiters.delete(id); reject(new Error('OCR 超时')); }, timeoutMs);
      ocrWorker.waiters.set(id, { resolve, reject, timer });
      try { ocrWorker.child.stdin.write(JSON.stringify({ id, file }) + '\n'); }
      catch (err) { clearTimeout(timer); ocrWorker.waiters.delete(id); reject(err); }
    });
  }

  function ocrScriptPath() {
    const envPath = String(process.env.TENON_OCR_SCRIPT || '').trim();
    if (envPath) return path.resolve(root, envPath);
    return path.join(root, 'scripts', 'screen', 'win_ocr.py');
  }

  function screenTmpDir() {
    const dir = path.join(dataDir, 'voice', 'screen', 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // 截图临时文件自动清理：OCR 完成后立即删除；启动时清掉历史残留；定时兜底清 >1 小时
  let lastScreenTmpClean = 0;
  function cleanupScreenTmp(maxAgeMs = 3600 * 1000) {
    const dir = path.join(dataDir, 'voice', 'screen', 'tmp');
    try {
      if (!fs.existsSync(dir)) return 0;
      let removed = 0;
      const now = Date.now();
      for (const name of fs.readdirSync(dir)) {
        const fp = path.join(dir, name);
        try {
          const st = fs.statSync(fp);
          if (!st.isFile()) continue;
          if (maxAgeMs <= 0 || now - st.mtimeMs >= maxAgeMs) { fs.rmSync(fp, { force: true }); removed++; }
        } catch { /* ignore */ }
      }
      return removed;
    } catch { return 0; }
  }

  async function ocrImage(base64, { source = 'phone' } = {}) {
    const raw = String(base64 || '').replace(/^data:image\/[a-z0-9.+;-]+;base64,/i, '').trim();
    if (!raw) throw new Error('imageBase64 为空');
    let buf = null;
    try { buf = Buffer.from(raw, 'base64'); } catch { throw new Error('imageBase64 解码失败'); }
    if (!buf || buf.length < 200) throw new Error('图片过小或 base64 不合法');
    if (buf.length > 12 * 1024 * 1024) throw new Error('图片超过 12MB 限制');
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
    const ext = isPng ? 'png' : 'jpg';
    const file = path.join(screenTmpDir(), 'phone-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex') + '.' + ext);
    fs.writeFileSync(file, buf);
    // 优先常驻 OCR（避免每 5 秒 spawn python+winrt）
    if (ocrWorker.child) {
      try {
        const r = await ocrViaWorker(file);
        return { text: String(r.text || '').trim(), lines: r.lines || [], engine: r.engine || 'windows-ocr', ocrMs: r.ocrMs, file, bytes: buf.length, ext };
      } catch (err) {
        console.warn('[voice] 常驻 OCR 失败，回退单次脚本：' + String((err && err.message) || err));
      }
    }
    const cleanupOnError = () => { try { fs.unlinkSync(file); } catch { /* ignore */ } };
    const script = ocrScriptPath();
    if (!fs.existsSync(script)) { cleanupOnError(); throw new Error('未找到字库 OCR 脚本：' + script); }
    let out = null;
    try {
      out = await runPythonJson([script, '--image', file], 45000);
    } catch (err) {
      cleanupOnError();
      throw err;
    }
    if (!out || out.ok === false) { cleanupOnError(); throw new Error('OCR 失败：' + String((out && out.error) || '未知错误')); }
    const text = String(out.text || (Array.isArray(out.lines) ? out.lines.join('\n') : '')).trim();
    return { text, lines: Array.isArray(out.lines) ? out.lines : [], engine: out.engine || 'windows-ocr', ocrMs: out.elapsedMs || out.ocrMs || null, file, bytes: buf.length, ext };
  }

  async function ensureWav(inputPath, { filename = '', contentType = '' } = {}) {
    const fmt = audioFormatOf(filename || inputPath, contentType);
    if (fmt === 'wav') return { wavPath: inputPath, converted: false, from: 'wav' };
    const wavPath = tempUploadPath('converted-16k.wav');
    await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]);
    if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 1000) throw new Error('ffmpeg 未生成有效 WAV（来源格式 ' + fmt + '）');
    return { wavPath, converted: true, from: fmt };
  }
  async function transcribe(filePath) {
    const res = await workers.transcribeFile(filePath, { timeoutMs: 120000 });
    const wake = detectWake(res.text || '', res.pinyin || '', config.wakeWords);
    const rec = recordTranscript(res.text || '', { source: 'file', wake: wake.wake, pinyin: res.pinyin || '', provider: res.provider });
    return { ...res, wake: wake.wake, wakeWord: wake.word, sensitive: rec.sensitive, redacted: rec.sensitive, preview: rec.preview };
  }

  async function speakText(text, { play = config.tts.play } = {}) {
    const r = await workers.speak(text, { play });
    if (r.ok) { status.counters.ttsFiles += 1; status.lastTts = { at: nowIso(), file: r.file || null, bytes: r.bytes || 0, voice: r.voice || null, ms: r.ms || 0 }; }
    return r;
  }

  // ---------- 手机端 needConfirm 确认闭环（pending plan，无需先建任务）----------
  const pendingFile = path.join(dataDir, 'voice', 'pending-confirms.json');
  const pendingConfirms = new Map();
  const PENDING_TTL_MS = 10 * 60 * 1000;
  function loadPendingConfirms() {
    try {
      const raw = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      const list = Array.isArray(raw.items) ? raw.items : [];
      for (const item of list) {
        if (!item || !item.id) continue;
        if (item.expiresAt && new Date(item.expiresAt).getTime() < Date.now()) continue;
        pendingConfirms.set(item.id, item);
      }
    } catch { /* 无待确认记录 */ }
  }
  function savePendingConfirms() {
    try {
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
      const items = Array.from(pendingConfirms.values()).slice(-20);
      fs.writeFileSync(pendingFile, JSON.stringify({ version: 1, items, updatedAt: nowIso() }, null, 2), 'utf8');
    } catch (err) { console.warn('[voice] 待确认记录写入失败：' + String(err && err.message)); }
  }
  function rememberPending({ text, actions, provider, sessionId }) {
    const id = 'vc_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    const item = {
      id,
      text: clampText(text, 300),
      actions: (actions || []).map((a) => ({ action: a.action, label: a.label, params: a.params || {}, deviceId: a.deviceId || null, risk: a.risk || 'irreversible' })),
      provider,
      sessionId: sessionId || null,
      status: 'pending',
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
    };
    pendingConfirms.set(id, item);
    savePendingConfirms();
    return item;
  }
  function pendingPublic(item) {
    if (!item) return null;
    return { confirmId: item.id, status: item.status, text: item.text, actions: item.actions, provider: item.provider, createdAt: item.createdAt, expiresAt: item.expiresAt, result: item.result || null };
  }
  async function confirmPending({ confirmId, yes = true, by = '手机确认' }) {
    const key = String(confirmId || '').trim();
    let item = pendingConfirms.get(key);
    if (!item && (!key || key === 'last')) {
      const list = Array.from(pendingConfirms.values()).filter((x) => x.status === 'pending').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      item = list[0] || null;
    }
    if (!item) return { ok: false, notFound: true, error: '确认已过期或不存在，请重新说一次命令（有效期 10 分钟）', status: getStatus() };
    if (item.expiresAt && new Date(item.expiresAt).getTime() < Date.now() && item.status === 'pending') {
      item.status = 'expired';
      savePendingConfirms();
      return { ok: false, expired: true, error: '确认已过期，请重新说一次命令', status: getStatus() };
    }
    if (item.status !== 'pending') {
      return { ok: true, already: true, confirmId: item.id, status: item.status, result: item.result || null, message: item.status === 'rejected' ? '已取消，无需再次确认' : '已确认/已执行，无需再次确认', statusInfo: getStatus() };
    }
    if (yes === false) {
      item.status = 'rejected';
      item.decidedAt = nowIso();
      savePendingConfirms();
      append('voice.command', { text: item.text, reply: '好的，已取消：' + (item.actions.map((a) => a.label || a.action).join('、') || '该操作'), actions: [], ok: false, provider: item.provider, sessionId: item.sessionId, needConfirm: false, confirmId: item.id, confirmed: false });
      hub.broadcast({ type: 'reply', text: '好的，已取消。', provider: item.provider, confirmId: item.id, cancelled: true, ts: Date.now() });
      return { ok: true, cancelled: true, confirmId: item.id, status: 'rejected', say: '好的，已取消。', statusInfo: getStatus() };
    }
    item.status = 'executing';
    savePendingConfirms();
    hub.broadcast({ type: 'executing', actions: item.actions.map((a) => a.action), confirmed: true, confirmId: item.id, ts: Date.now() });
    let exec = null;
    let ttsInfo = null;
    let audio = null;
    try {
      exec = await executor.executeActions(item.actions, { text: item.text, by });
      const say = exec.say || (exec.ok === false ? '执行时有问题：' + (exec.steps || []).map((s) => s.summary).filter(Boolean).slice(0, 2).join('；') : '已确认并执行完成');
      if (config.tts.enabled) {
        ttsInfo = await workers.speak(say, { play: !!config.tts.play });
        if (ttsInfo && ttsInfo.ok) audio = audioInfoOf(ttsInfo);
      }
      item.status = 'executed';
      item.decidedAt = nowIso();
      item.result = { ok: exec.ok !== false, say, steps: (exec.steps || []).slice(0, 8), taskIds: exec.taskIds || [], provider: 'deepseek', latencyMs: 0 };
      savePendingConfirms();
      append('voice.command', { text: item.text, reply: say, actions: item.actions.map((a) => a.action), ok: exec.ok !== false, provider: item.provider + '+confirmed', sessionId: item.sessionId, needConfirm: true, confirmId: item.id, confirmed: true, steps: item.result.steps, taskIds: item.result.taskIds });
      append('voice.reply', { text: say, tts: !!(ttsInfo && ttsInfo.ok), audio, provider: item.provider + '+confirmed', sessionId: item.sessionId, confirmId: item.id });
      hub.broadcast({ type: 'reply', text: say, provider: item.provider + '+confirmed', confirmed: true, confirmId: item.id, steps: item.result.steps, taskIds: item.result.taskIds, tts: ttsInfo ? { ok: !!ttsInfo.ok, audio } : null, ts: Date.now() });
      return { ok: exec.ok !== false, already: false, confirmed: true, confirmId: item.id, status: 'executed', say, result: item.result, audio, statusInfo: getStatus() };
    } catch (err) {
      item.status = 'failed';
      item.error = String((err && err.message) || err);
      savePendingConfirms();
      hub.broadcast({ type: 'error', text: '确认后执行失败：' + item.error, code: 'CONFIRM_EXEC_FAILED', ts: Date.now() });
      return { ok: false, confirmId: item.id, status: 'failed', error: item.error, statusInfo: getStatus() };
    }
  }
  function listPending() {
    return Array.from(pendingConfirms.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(pendingPublic);
  }
  loadPendingConfirms();

  // ---- 桌面悬浮快捷录音球（轻量 Python/Tkinter 实现，随中枢启动；TENON_QUICK_BALL=0 可关闭） ----
  let quickBallChild = null;
  function startQuickBall() {
    try {
      if (readOnly) return;
      if (process.env.TENON_QUICK_BALL === '0') return;
      if (quickBallChild && !quickBallChild.killed) return;
      const script = path.join(root, 'scripts', 'quick', 'quick_ball.py');
      if (!fs.existsSync(script)) { console.warn('[voice] 悬浮球脚本不存在：' + script); return; }
      quickBallChild = spawn(config.workers.python || 'python', [script], {
        cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
        env: {
          ...process.env, PYTHONIOENCODING: 'utf-8',
          TENON_HUB_URL: 'http://127.0.0.1:' + (process.env.TENON_PORT || 7410),
          TENON_TOKEN: (secret && secret.operatorToken) || '',
          TENON_DATA_DIR: dataDir,
        },
      });
      quickBallChild.on('error', (e) => console.warn('[voice] 悬浮球启动失败：' + String(e && e.message)));
      quickBallChild.unref();
      console.log('[voice] 桌面悬浮快捷录音球已启动（点一下直接录音→执行）');
    } catch (err) { console.warn('[voice] 悬浮球异常：' + String((err && err.message) || err)); }
  }
  startQuickBall();

  const routes = [
    { method: 'GET', path: '/voice/status', handler: async (req, res) => sendJson(res, 200, getStatus()) },
    { method: 'GET', path: '/voice/config', handler: async (req, res) => sendJson(res, 200, { ok: true, config: publicConfig(config), versions: { voice: VOICE_VERSION } }) },
    { method: 'PATCH', path: '/voice/config', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      sendJson(res, 200, updateConfig(body));
    } },
    { method: 'POST', path: '/voice/start', handler: async (req, res, ctx) => { requireWrite(req, ctx); sendJson(res, 200, { ok: true, status: start({ by: 'user' }) }); } },
    { method: 'POST', path: '/voice/stop', handler: async (req, res, ctx) => { requireWrite(req, ctx); sendJson(res, 200, { ok: true, status: stop({ by: 'user' }) }); } },
    { method: 'POST', path: '/voice/quick/start', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      if (!status.enabled) start({ by: 'quick' });
      // 等待 ASR worker 就绪（模型首次加载可能 20-40s；mock 模式直接可用）
      const isMock = !!(config.mock && config.mock.enabled);
      let ready = isMock;
      for (let i = 0; i < 60 && !ready; i += 1) {
        const st = workers.state && workers.state.asr ? workers.state.asr.state : 'stopped';
        if (st === 'running') { ready = true; break; }
        if (st === 'unavailable') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const sent = ready && (isMock || typeof workers.startQuickRecord !== 'function' ? true : workers.startQuickRecord());
      if (!sent) { sendJson(res, 200, { ok: false, error: '语音引擎未就绪，请稍等几秒再试', status: getStatus() }); return; }
      startSession('quick');
      setState('session');
      hub.broadcast({ type: 'quick_start', ts: Date.now() });
      sendJson(res, 200, { ok: true, quick: true, status: getStatus() });
    } },
    { method: 'POST', path: '/voice/quick/stop', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      try { if (typeof workers.stopQuickRecord === 'function') workers.stopQuickRecord(); } catch (err) { /* ignore */ }
      endSession('quick-stop');
      sendJson(res, 200, { ok: true, status: getStatus() });
    } },
    { method: 'POST', path: '/voice/command', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      if (body.transcript === true) {
        const r = await handleFinal(String(body.text || ''), { pinyin: body.pinyin || '', source: body.source || 'text' });
        sendJson(res, 200, { ok: r.ok !== false, ...r, status: getStatus() });
        return;
      }
      const commandText = String(body.text || '');
      recordTranscript(commandText, { source: body.source || 'text', wake: false, sessionId: null });
      const result = await processCommand(commandText, { source: body.source || 'text', forceConfirm: body.confirmed === true || body.confirm === true });
      sendJson(res, 200, { ok: result.ok !== false, ...result, status: getStatus() });
    } },
    { method: 'POST', path: '/voice/transcript', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      const r = await handleFinal(String(body.text || ''), { pinyin: body.pinyin || '', source: body.source || 'text' });
      sendJson(res, 200, { ok: r.ok !== false, ...r, status: getStatus() });
    } },
    { method: 'POST', path: '/voice/transcribe', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const ct = String(req.headers['content-type'] || '');
      let rawPath = '';
      let cleanupRaw = false;
      let fileInfo = { filename: '', contentType: '' };
      if (ct.includes('multipart/form-data')) {
        const raw = await readBody(req);
        const parsed = parseMultipart(raw, ct);
        if (!parsed.files.length) { sendJson(res, 400, { ok: false, error: 'multipart 中没有音频文件（字段名可用 file/audio/wav）' }); return; }
        const pick = parsed.files.find((f) => ['file', 'audio', 'wav', 'recording', 'voice'].includes(String(f.field || '').toLowerCase())) || parsed.files[0];
        fileInfo = { filename: pick.filename || 'upload.webm', contentType: pick.contentType || '' };
        const ext = audioFormatOf(fileInfo.filename, fileInfo.contentType);
        rawPath = tempUploadPath('upload.' + (ext === 'raw' ? 'bin' : ext));
        fs.writeFileSync(rawPath, pick.data);
        cleanupRaw = true;
      } else {
        const body = await readJson(req);
        if (body.path) { rawPath = path.resolve(String(body.path)); fileInfo = { filename: rawPath, contentType: '' }; }
        else if (body.audioBase64 || body.wavBase64) {
          const base64 = String(body.audioBase64 || body.wavBase64);
          fileInfo = { filename: String(body.filename || body.format || 'upload.webm'), contentType: String(body.contentType || '') };
          const ext = audioFormatOf(fileInfo.filename, fileInfo.contentType);
          rawPath = tempUploadPath('upload.' + (ext === 'raw' ? 'bin' : ext));
          fs.writeFileSync(rawPath, Buffer.from(base64, 'base64'));
          cleanupRaw = true;
        } else { sendJson(res, 400, { ok: false, error: '需要 multipart 音频（file/audio/wav），或 JSON {path|audioBase64|wavBase64}' }); return; }
      }
      let convertedPath = '';
      try {
        const conv = await ensureWav(rawPath, fileInfo);
        if (conv.converted) convertedPath = conv.wavPath;
        const r = await transcribe(conv.wavPath);
        sendJson(res, 200, { ok: true, ...r, convertedFrom: conv.converted ? conv.from : 'wav', status: getStatus() });
      } catch (err) {
        const msg = String((err && err.message) || err);
        const code = /ASR 未就绪|asr_worker/.test(msg) ? 'ASR_NOT_READY' : 'TRANSCRIBE_FAILED';
        sendJson(res, 503, { ok: false, error: msg, code, status: getStatus() });
      } finally {
        if (cleanupRaw) { try { fs.unlinkSync(rawPath); } catch { /* ignore */ } }
        if (convertedPath) { try { fs.unlinkSync(convertedPath); } catch { /* ignore */ } }
      }
    } },
    { method: 'POST', path: '/voice/ambient-upload', handler: async (req, res, ctx) => {
      // 手机端 24 小时录制分片上传：本地转写 + 全天记录留痕（不执行命令、不播报）
      requireWrite(req, ctx);
      if (!config.ambient || config.ambient.enabled === false) { sendJson(res, 200, { ok: false, skipped: true, reason: 'ambient-disabled' }); return; }
      const ct = String(req.headers['content-type'] || '');
      if (!ct.includes('multipart/form-data')) { sendJson(res, 400, { ok: false, error: '需要 multipart/form-data（字段 file/audio/wav）' }); return; }
      let rawPath = '';
      let convertedPath = '';
      let fileInfo = { filename: 'ambient.wav', contentType: '' };
      try {
        const raw = await readBody(req);
        const parsed = parseMultipart(raw, ct);
        if (!parsed.files.length) { sendJson(res, 400, { ok: false, error: 'multipart 中没有音频文件（字段名可用 file/audio/wav）' }); return; }
        const pick = parsed.files.find((f) => ['file', 'audio', 'wav', 'recording', 'voice'].includes(String(f.field || '').toLowerCase())) || parsed.files[0];
        fileInfo = { filename: pick.filename || 'ambient.wav', contentType: pick.contentType || '' };
        const ext = audioFormatOf(fileInfo.filename, fileInfo.contentType);
        rawPath = tempUploadPath('ambient.' + (ext === 'raw' ? 'bin' : ext));
        fs.writeFileSync(rawPath, pick.data);
        const conv = await ensureWav(rawPath, fileInfo);
        if (conv.converted) convertedPath = conv.wavPath;
        const r = await transcribe(conv.wavPath);
        const text = String((r && r.text) || '').trim();
        if (text.length >= 2) {
          const rec = recordTranscript(text, { source: 'ambient', wake: false, sessionId: null, provider: (r && r.provider) || 'paraformer', device: 'phone' });
          status.counters.ambient = (status.counters.ambient || 0) + 1;
          status.lastAmbient = { at: nowIso(), text: rec.sensitive ? rec.preview : text, provider: (r && r.provider) || null, device: 'phone' };
          sendJson(res, 200, { ok: true, text: rec.sensitive ? rec.preview : text, redacted: !!rec.sensitive, provider: (r && r.provider) || 'paraformer', ms: (r && r.ms) || null });
        } else {
          sendJson(res, 200, { ok: true, text: '', empty: true });
        }
      } catch (err) {
        const msg = String((err && err.message) || err);
        sendJson(res, 503, { ok: false, error: msg, code: /ASR|transcribe|转写/.test(msg) ? 'ASR_NOT_READY' : 'AMBIENT_UPLOAD_FAILED' });
      } finally {
        try { if (rawPath) fs.unlinkSync(rawPath); } catch { /* ignore */ }
        try { if (convertedPath) fs.unlinkSync(convertedPath); } catch { /* ignore */ }
      }
    } },
    { method: 'GET', path: '/voice/stream', handler: async (req, res) => {
      const sub = hub.subscribe(res);
      try { res.write('data: ' + JSON.stringify({ type: 'status_snapshot', ...getStatus(), ts: Date.now() }) + '\n\n'); } catch { /* ignore */ }
      req.on('close', () => sub.close());
    } },
    { method: 'GET', path: '/voice/transcripts', handler: async (req, res, ctx) => {
      const u = ctx && ctx.url ? ctx.url : new URL(req.url, 'http://localhost');
      const date = String(u.searchParams.get('date') || dayKey());
      if (!isRealDay(date)) { sendJson(res, 400, { ok: false, error: 'date 必须是 YYYY-MM-DD 且为真实日期', code: 'BAD_DATE' }); return; }
      const limit = Number(u.searchParams.get('limit') || 100);
      sendJson(res, 200, { ok: true, ...store.list(date, limit) });
    } },
    { method: 'POST', path: '/voice/speak', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      const r = await speakText(String(body.text || ''), { play: body.play === undefined ? config.tts.play : !!body.play });
      const audio = audioInfoOf(r);
      sendJson(res, r.ok ? 200 : 503, { ok: !!r.ok, ...r, audio });
    } },
    { method: 'POST', path: '/voice/mock', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      workers.startMockSequence({ wakeText: body.wakeText || config.mock.wakeText, commandText: body.commandText || config.mock.commandText });
      sendJson(res, 200, { ok: true, mock: true, status: getStatus() });
    } },
    { method: 'GET', path: '/voice/reply-audio', handler: async (req, res, ctx) => {
      const u = ctx && ctx.url ? ctx.url : new URL(req.url, 'http://localhost');
      const id = String(u.searchParams.get('id') || u.searchParams.get('path') || u.searchParams.get('file') || '').trim();
      const headerTok = String((req.headers && (req.headers['x-tenon-token'] || req.headers['authorization'])) || '').replace(/^Bearer\s+/i, '');
      const queryTok = String(u.searchParams.get('token') || '');
      const tok = headerTok || queryTok;
      const allowed = (ctx && typeof ctx.authed === 'function' && ctx.authed(req)) || (secret && tok && tok === secret.operatorToken);
      if (!allowed) { res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '需要操作令牌', code: 'TOKEN_INVALID' })); return; }
      if (!/^[A-Za-z0-9._-]+\.wav$/.test(id)) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '文件名不合法', code: 'BAD_AUDIO_ID' })); return; }
      const dir = path.join(dataDir, 'voice', 'tts');
      const file = path.join(dir, id);
      if (!file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '回复音频不存在', code: 'AUDIO_NOT_FOUND' })); return; }
      const stat = fs.statSync(file);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': stat.size, 'Cache-Control': 'private, max-age=3600', 'Content-Disposition': 'inline; filename="' + id + '"' });
      fs.createReadStream(file).pipe(res);
    } },
    { method: 'GET', path: '/voice/reply-audio/latest', handler: async (req, res) => {
      const dir = path.join(dataDir, 'voice', 'tts');
      let latest = null;
      try {
        const files = fs.readdirSync(dir).filter((n) => /\.wav$/i.test(n)).map((n) => ({ n, st: fs.statSync(path.join(dir, n)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
        latest = files[0] || null;
      } catch { latest = null; }
      if (!latest) { sendJson(res, 404, { ok: false, error: '还没有回复音频' }); return; }
      sendJson(res, 200, { ok: true, id: latest.n, url: audioUrlOf(path.join(dir, latest.n)), bytes: latest.st.size, createdAt: latest.st.mtime.toISOString(), lastTts: status.lastTts || null });
    } },
    { method: 'GET', path: '/voice/confirm/pending', handler: async (req, res) => sendJson(res, 200, { ok: true, items: listPending(), status: getStatus() }) },
    { method: 'POST', path: '/voice/confirm', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req).catch(() => ({}));
      const yes = body.yes === false || body.confirm === false || body.cancel === true ? false : true;
      const result = await confirmPending({ confirmId: body.confirmId || body.id || body.taskId || 'last', yes, by: body.by || '手机确认' });
      sendJson(res, 200, { ...result, status: getStatus() });
    } },
    {
      method: 'POST', path: '/voice/screen', handler: async (req, res, ctx) => {
        requireWrite(req, ctx);
        const body = await readJson(req);
        let screenTmpFileForCleanup = null; // finally 可访问（try 内 let 在 finally 中不可见）
        try {
        const source = body.source === 'phone' ? 'phone' : 'pc';
        // 同一设备 60 秒内上传完全相同图片 → 跳过 OCR（静止画面不重复识别，省 CPU/内存）
        if (body.imageBase64) {
          try {
            const rawB64 = String(body.imageBase64).replace(/^data:image\/[a-z0-9.+;-]+;base64,/i, '');
            const imgHash = crypto.createHash('sha256').update(rawB64).digest('hex');
            const prev = lastScreenImages.get(source);
            if (prev && prev.hash === imgHash && Date.now() - prev.at < 60000) {
              sendJson(res, 200, { ok: true, skipped: true, reason: 'same-screen', message: '画面未变化，已跳过重复识别' });
              return;
            }
            lastScreenImages.set(source, { hash: imgHash, at: Date.now() });
          } catch { /* ignore */ }
        }
        let raw = String(body.text || '').trim();
        let ocr = null;
        let imageInfo = null;
        let imageTmpPath = null;
        let ocrMs = Number(body.ocrMs) || null;
        let engine = body.engine || null;
        if (body.imageBase64) {
          try {
            ocr = await ocrImage(body.imageBase64, { source });
            raw = String(ocr.text || '').trim();
            ocrMs = ocr.ocrMs || ocrMs;
            engine = ocr.engine || engine;
            imageTmpPath = ocr.file;
            screenTmpFileForCleanup = ocr.file;
            imageInfo = { bytes: ocr.bytes, engine: ocr.engine };
          } catch (err) {
            try { if (ocr && ocr.file) fs.unlinkSync(ocr.file); } catch { /* ignore */ }
            sendJson(res, 502, { ok: false, stored: false, error: String((err && err.message) || err), code: 'OCR_FAILED' });
            return;
          }
        }
        if (!raw) {
          if (imageInfo) {
            sendJson(res, 200, { ok: true, stored: false, id: null, text: '', ocrMs, engine, image: imageInfo, message: '图片中未识别到文字' });
          } else {
            sendJson(res, 400, { ok: false, error: '缺少 text 或 imageBase64（屏幕 OCR 文本/手机截图）', code: 'MISSING_TEXT' });
          }
          return;
        }
        const priv = filterTranscript(raw, config);
        const at = body.ts || nowIso();
        const sensitive = !!priv.redacted;
        if (sensitive && imageInfo) {
          // 敏感屏幕内容不保留任何截图（图片统一在 finally 删除，只留「已过滤」标记）
          imageInfo = null;
        }
        const safeText = sensitive ? '' : raw;
        const id = 'sc_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        let record = null;
        try {
          // 用户要求：识别完成后自动删除截图 → 记录里不保存图片路径（只保留 OCR 文本/统计）
          record = screenStore.append({ id, at, app: body.app, title: body.title, text: safeText, confidence: body.confidence, source, region: body.region, image: null, ocrMs, engine, redacted: sensitive });
        } catch (err) {
          sendJson(res, 500, { ok: false, stored: false, error: '屏幕文本落盘失败：' + String((err && err.message) || err) });
          return;
        }
        append('voice.screen', { kind: 'screen', id: record.id, app: record.app, title: record.title, text: safeText, confidence: record.confidence, source, image: null, ocrMs, engine, sensitive, ...(sensitive ? { sensitiveType: priv.sensitiveType, length: priv.length } : {}) });
        status.counters.screenTexts = (status.counters.screenTexts || 0) + 1;
        hub.broadcast({ type: 'screen', id: record.id, at, app: record.app, title: record.title, text: sensitive ? priv.redactedPreview : safeText.slice(0, 300), confidence: record.confidence, source, sensitive, ts: Date.now() });
        sendJson(res, 200, {
          ok: true,
          stored: true,
          id: record.id,
          at,
          app: record.app,
          title: record.title,
          text: sensitive ? '' : safeText.slice(0, 600),
          ocrMs,
          engine,
          confidence: record.confidence,
          image: null,
          sensitive,
          sensitiveType: priv.sensitiveType || null,
          preview: sensitive ? priv.redactedPreview : safeText.slice(0, 200),
        });
        } finally {
          // 自动删除截图：OCR 完成后不保留图片文件（用户要求省空间/隐私，总结只用文本）
          if (screenTmpFileForCleanup) {
            const tmpFile = screenTmpFileForCleanup;
            screenTmpFileForCleanup = null;
            const tryDel = (attempt) => {
              try { fs.unlinkSync(tmpFile); }
              catch { if (attempt < 5) setTimeout(() => tryDel(attempt + 1), 250 * (attempt + 1)); }
            };
            tryDel(0);
            // 兜底：2 秒后再扫一遍 tmp，避免 Windows 文件句柄释放延迟
            setTimeout(() => { try { tryDel(0); cleanupScreenTmp(60 * 1000); } catch { /* ignore */ } }, 2000);
          }
          if (Date.now() - lastScreenTmpClean > 10 * 60 * 1000) {
            lastScreenTmpClean = Date.now();
            try { cleanupScreenTmp(); } catch { /* ignore */ }
          }
        }
      },
    },
    {
      method: 'GET', path: '/voice/screen', handler: async (req, res, ctx) => {
        const u = ctx && ctx.url ? ctx.url : new URL(req.url, 'http://localhost');
        const date = String(u.searchParams.get('date') || dayKey());
        if (!isRealDay(date)) { sendJson(res, 400, { ok: false, error: 'date 必须是 YYYY-MM-DD 且为真实日期', code: 'BAD_DATE' }); return; }
        const limit = Number(u.searchParams.get('limit') || 200);
        sendJson(res, 200, { ok: true, ...screenStore.list(date, limit), stats: screenStore.stats() });
      },
    },    { method: 'POST', path: '/voice/diary/generate', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req).catch(() => ({}));
      const targetDate = String(body.date || dayKey());
      if (!isRealDay(targetDate)) { sendJson(res, 400, { ok: false, error: 'date 必须是 YYYY-MM-DD 且为真实日期', code: 'BAD_DATE' }); return; }
      const result = await diary.generate({ date: targetDate, by: body.by || 'manual', force: body.force === true });
      if (result && result.ok === false) { sendJson(res, 400, result); return; }
      diaryBroadcast(result);
      sendJson(res, 200, result);
    } },
    { method: 'GET', path: '/voice/diary', handler: async (req, res, ctx) => {
      const u = ctx && ctx.url ? ctx.url : new URL(req.url, 'http://localhost');
      const date = String(u.searchParams.get('date') || dayKey());
      if (!isRealDay(date)) { sendJson(res, 400, { ok: false, error: 'date 必须是 YYYY-MM-DD 且为真实日期', code: 'BAD_DATE' }); return; }
      const diaryOfDate = diary.read(date);
      sendJson(res, diaryOfDate && diaryOfDate.ok === false ? 400 : 200, diaryOfDate);
    } },
    { method: 'GET', path: '/voice/diary/list', handler: async (req, res) => {
      sendJson(res, 200, { ok: true, items: diary.list(30), diary: { enabled: !!(config.diary && config.diary.enabled), time: (config.diary && config.diary.time) || '23:00' }, lastDiary: status.lastDiary || null });
    } },
  ];

  const service = {
    version: VOICE_VERSION,
    routes,
    getStatus,
    status,
    config: () => publicConfig(config),
    start,
    stop,
    updateConfig,
    processCommand,
    handleFinal,
    detectWake: (text, pinyin) => detectWake(text, pinyin, config.wakeWords),
    transcribe,
    speak: speakText,
    store,
    hub,
    workers,
    executor,
    diary,
    dataDir,
    root,
    async handle(req, res, u, pathname) {
      const rel = pathname.startsWith('/api/v2') ? pathname.slice('/api/v2'.length) || '/' : pathname;
      for (const route of routes) {
        if (route.method !== req.method) continue;
        if (route.path === rel) return route.handler(req, res, { url: u, params: {} });
      }
      return false;
    },
    _wakeAliases: WAKE_ALIASES.slice(),
  };
  if (config.enabled && !readOnly) {
    autoStartTimer = setTimeout(() => { try { start({ by: 'auto' }); } catch (err) { console.warn('[voice] 自动启动失败：' + String(err && err.message)); } }, 800);
    autoStartTimer.unref && autoStartTimer.unref();
  }
  if (!globalThis.__tenonVoiceRejectionGuard) {
    globalThis.__tenonVoiceRejectionGuard = true;
    process.on('unhandledRejection', (reason) => {
      console.error('[voice] unhandledRejection（仅记录，不退出）：' + String((reason && reason.stack) || reason).slice(0, 500));
    });
  }
  process.once('exit', () => { try { workers.stopAll(); } catch { /* ignore */ } });
  if (!readOnly) { try { startDiaryScheduler(); } catch (err) { console.warn('[voice] 日报调度器启动失败：' + String(err && err.message)); } }
  return service;
}

export default createVoiceService;
