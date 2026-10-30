// 榫卯 V3 · 语音命令规划器（DeepSeek 优先 → 本地 Qwen → 规则引擎）
// 用户 22:41 修订：唤醒后立刻用 DeepSeek（deepseek-chat）规划；执行结果回传 DeepSeek 继续判断（最多 3 轮）；
// 失败降级本地 llm_worker（Qwen2.5-0.5B）→ 规则引擎，并在 provider 字段标注。
// 输出契约：{"say","actions":[{"action","params","deviceId?"}],"needConfirm", "ask"}；action 白名单校验。
import { mockPlanOf } from './workers.js';
import { PLANNER_PROMPT, resolvePrompts } from './prompts.js';

export const PLAN_VERSION = '3.1.0';

export const ACTION_WHITELIST = {
  'app.launch': { label: '打开程序', params: ['app', 'args'], risk: 'reversible' },
  'url.open': { label: '打开网页', params: ['url', 'fullscreen'], risk: 'reversible' },
  'system.volume': { label: '电脑音量', params: ['action', 'level', 'steps', 'mute'], risk: 'reversible' },
  'media.show': { label: '播放/展示素材', params: ['path', 'source', 'assetId'], risk: 'reversible' },
  'file.print': { label: '打印文件', params: ['file', 'copies'], risk: 'irreversible' },
  'handoff.show': { label: '甩到电脑大屏', params: ['kind', 'text', 'url', 'assetId', 'fromDevice'], risk: 'reversible' },
  'scene.run': { label: '一键场景', params: ['presetId', 'sceneId', 'id'], risk: 'reversible' },
  'device.control': { label: '控制设备', params: ['deviceId', 'app', 'command', 'action', 'value'], risk: 'reversible' },
  'agent.message': { label: '给设备/家人发消息', params: ['to', 'text'], risk: 'irreversible' },
  'voice.reply': { label: '口头回复', params: ['text'], risk: 'reversible' },
  'note.create': { label: '记笔记', params: ['text', 'title', 'tags'], risk: 'reversible' },
  'note.summarize': { label: '总结笔记', params: ['ids', 'date', 'text'], risk: 'reversible' },
  'reminder.create': { label: '创建提醒', params: ['text', 'at', 'recurrence', 'inMinutes'], risk: 'reversible' },
  'document.generate': { label: '生成文档', params: ['kind', 'date', 'ids', 'title'], risk: 'reversible' },
};

export const ACTION_ALIASES = {
  open_app: 'app.launch', launch: 'app.launch', app: 'app.launch', 'app.open': 'app.launch',
  open_url: 'url.open', url: 'url.open', browse: 'url.open',
  volume: 'system.volume', 'volume.set': 'system.volume', sound: 'system.volume', set_volume: 'system.volume',
  media: 'media.show', play: 'media.show', show_media: 'media.show',
  handoff: 'handoff.show', fly: 'handoff.show', 'screen.show': 'handoff.show',
  scene: 'scene.run', preset: 'scene.run', scene_run: 'scene.run',
  device: 'device.control', control: 'device.control', 'device.act': 'device.control',
  note: 'note.create', 'note.create': 'note.create', memo: 'note.create', remember: 'note.create',
  ask: 'voice.reply', chat: 'voice.reply', answer: 'voice.reply', reply: 'voice.reply',
  reminder: 'reminder.create', remind: 'reminder.create', alarm: 'reminder.create',
  message: 'agent.message', notify: 'agent.message', send_message: 'agent.message',
  summarize: 'note.summarize', summary: 'note.summarize',
  document: 'document.generate', doc: 'document.generate', export: 'document.generate',
};

const VAGUE_APP_RE = /^(打开程序|打开应用|随便|随便打开|打开它|打开)$/;
const IRREVERSIBLE_WORDS = /打印|删除|删掉|格式化|关机|重启电脑|付款|转账|批量/;

function asString(v) { return v == null ? '' : String(v); }

export function extractJson(text) {
  const raw = asString(text);
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== '{') continue;
    let depth = 0;
    for (let i = start; i < trimmed.length; i += 1) {
      if (trimmed[i] === '{') depth += 1;
      else if (trimmed[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { /* try next */ }
        }
      }
    }
  }
  return null;
}

export function normalizeAction(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '第 ' + (index + 1) + ' 个动作不是对象' };
  const name0 = asString(raw.action || raw.capabilityId || raw.id || raw.type).trim();
  const name = ACTION_ALIASES[name0] || name0;
  if (!ACTION_WHITELIST[name]) return { ok: false, error: '动作不在白名单：' + (name0 || '(空)') };
  const params = { ...(raw.params && typeof raw.params === 'object' ? raw.params : {}) };
  for (const key of ACTION_WHITELIST[name].params) {
    if (key === 'action') continue; // 顶层 action 是动作名，不能当参数平铺（volume 的 action 必须写在 params 内）
    if (raw[key] !== undefined && params[key] === undefined) params[key] = raw[key];
  }
  if (name === 'app.launch') {
    params.app = asString(params.app || params.name || params.program).trim();
    if (VAGUE_APP_RE.test(params.app)) return { ok: false, error: '不明确要打开哪个程序' };
    if (!params.app) return { ok: false, error: 'app.launch 缺少 app' };
  }
  if (name === 'url.open') {
    params.url = asString(params.url || params.target).trim();
    if (!params.url) return { ok: false, error: 'url.open 缺少 url' };
    if (!/^https?:\/\//i.test(params.url) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(params.url)) params.url = 'https://' + params.url;
  }
  if (name === 'system.volume') {
    if (params.mute === true) params.action = 'mute';
    const rawLevel = params.level !== undefined && params.level !== null ? params.level : (asString(params.value).match(/(\d{1,3})/) || [])[1];
    if (rawLevel !== undefined && rawLevel !== null && rawLevel !== '') {
      const level = Number(String(rawLevel).replace('%', ''));
      if (!Number.isFinite(level) || level < 0 || level > 100) return { ok: false, error: '音量必须是 0-100' };
      params.level = Math.round(level);
      if (!params.action) params.action = 'up';
    }
    if (!params.action) params.action = 'up';
    if (!['up', 'down', 'mute'].includes(String(params.action))) return { ok: false, error: '音量动作只能是 up/down/mute' };
    if (params.steps !== undefined) params.steps = Math.max(1, Math.min(50, Number(params.steps) || 5));
  }
  if (name === 'scene.run') {
    const id = asString(params.presetId || params.sceneId || params.id).toLowerCase();
    if (!['home', 'work', 'sleep'].includes(id)) return { ok: false, error: '场景只能是 home/work/sleep' };
    params.presetId = id;
  }
  if (name === 'handoff.show') {
    const kind = asString(params.kind || (params.url ? 'page' : 'text')).toLowerCase();
    if (!['text', 'page', 'photo'].includes(kind)) return { ok: false, error: 'handoff kind 只能是 text/page/photo' };
    params.kind = kind;
    if (kind === 'page' && !params.url) return { ok: false, error: 'handoff page 需要 url' };
    if (kind === 'photo' && !params.assetId) return { ok: false, error: 'handoff photo 需要 assetId' };
    if (kind === 'text') params.text = asString(params.text || '来自语音管家的内容');
  }
  if (name === 'file.print') {
    params.file = asString(params.file || params.path).trim();
    if (!params.file) return { ok: false, error: 'file.print 缺少 file' };
    params.copies = Math.max(1, Math.min(20, Number(params.copies) || 1));
  }
  if (name === 'agent.message') {
    params.to = asString(params.to || params.deviceId || 'desktop').trim();
    params.text = asString(params.text).trim();
    if (!params.text) return { ok: false, error: 'agent.message 缺少 text' };
  }
  if (name === 'device.control') {
    const app = asString(params.app || params.command || params.action).trim();
    if (!app) return { ok: false, error: 'device.control 缺少 command/app' };
    params.app = app;
  }
  if (name === 'note.create') {
    params.text = asString(params.text || params.content || params.note).trim();
    if (!params.text) return { ok: false, error: 'note.create 缺少 text' };
    params.title = asString(params.title || '').trim().slice(0, 80);
    if (params.tags !== undefined) params.tags = Array.isArray(params.tags) ? params.tags : String(params.tags).split(/[,，\s]+/).filter(Boolean);
  }
  if (name === 'reminder.create') {
    params.text = asString(params.text || params.content || params.raw).trim();
    if (!params.text) return { ok: false, error: 'reminder.create 缺少 text' };
    if (params.at !== undefined) params.at = asString(params.at).trim();
    if (params.recurrence !== undefined) params.recurrence = params.recurrence === 'daily' ? 'daily' : 'once';
    if (params.inMinutes !== undefined) params.inMinutes = Math.max(1, Math.min(60 * 24 * 30, Number(params.inMinutes) || 1));
  }
  if (name === 'note.summarize') {
    params.ids = Array.isArray(params.ids) ? params.ids.map((x) => asString(x)).filter(Boolean) : (params.ids ? [asString(params.ids)] : []);
    params.date = asString(params.date || '').trim();
  }
  if (name === 'document.generate') {
    const kind = asString(params.kind || 'note-summary').trim();
    if (!['note-summary', 'daily', 'note-set'].includes(kind)) return { ok: false, error: 'document.generate kind 只能是 note-summary/daily/note-set' };
    params.kind = kind;
    params.date = asString(params.date || '').trim();
    params.ids = Array.isArray(params.ids) ? params.ids.map((x) => asString(x)).filter(Boolean) : (params.ids ? [asString(params.ids)] : []);
  }
  if (name === 'voice.reply') {
    params.text = asString(params.text).trim();
    if (!params.text) return { ok: false, error: 'voice.reply 缺少 text' };
  }
  return { ok: true, action: { action: name, label: ACTION_WHITELIST[name].label, params, deviceId: raw.deviceId ? asString(raw.deviceId) : null, risk: ACTION_WHITELIST[name].risk } };
}

export function sanitizePlan(parsed) {
  const out = { say: '', actions: [], dropped: [], needConfirm: false, ask: '' };
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: '模型输出不是 JSON 对象', ...out };
  out.say = asString(parsed.say || parsed.reply || parsed.text || '').trim().slice(0, 400);
  out.ask = asString(parsed.ask || '').trim().slice(0, 200);
  out.needConfirm = parsed.needConfirm === true || parsed.need_confirm === true;
  const list = Array.isArray(parsed.actions) ? parsed.actions : (Array.isArray(parsed.plan) ? parsed.plan : []);
  for (let i = 0; i < Math.min(list.length, 6); i += 1) {
    const norm = normalizeAction(list[i], i);
    if (norm.ok) out.actions.push(norm.action);
    else out.dropped.push(norm.error);
  }
  return { ok: true, ...out };
}

const RULE_FIRST_RE = /记一下|记下来|记录一下|记录：|帮我记|备忘[:：]?|做个笔记|笔记[:：]|提醒我|提醒一下|别忘了|闹钟|总结(一下)?(今天|今日|我的记录|这段|一下)|生成(今日|今天)?总结|导出(今日|今天)?总结|做成文档|生成文档|发到手机/;

function customRulePlan(text) {
  const t = String(text || '');
  // 语音笔记：「记一下：xxx」「记录一下 xxx」「帮我记 xxx」「备忘：xxx」
  if (/记一下|记下来|记录一下|记录：|帮我记|帮我记录|备忘[:：]?|做个笔记|笔记[:：]/.test(t) && !/记不记得/.test(t)) {
    let noteText = t
      .replace(/^.*?(?:帮我记|帮我记录|记一下|记录一下|记录|记下来|备忘|做个笔记|笔记)[:：,，\s]*/g, '')
      .replace(/^[我你]?记[一一下]*[:：,，\s]*/g, '')
      .trim();
    if (!noteText) noteText = t;
    return { say: '好，记下了：' + noteText.slice(0, 40), actions: [{ action: 'note.create', params: { text: noteText, source: 'voice' } }] };
  }
  // 提醒：「提醒我 21:30 开会」「每天 8 点提醒我吃药」「1 分钟后提醒我喝水」
  if (/提醒我|提醒一下|别忘了|闹钟/.test(t)) {
    return { say: '好，我来设置提醒。', actions: [{ action: 'reminder.create', params: { text: t, source: 'voice' } }] };
  }
  // 总结/生成文档
  if (/总结(一下)?(今天|今日|我的记录|这段|一下)|生成(今日|今天)?总结|导出(今日|今天)?总结|做成文档|生成文档|发到手机/.test(t)) {
    const kind = /这段|这个笔记|笔记总结/.test(t) ? 'note-summary' : 'daily';
    return { say: '好，我来生成结构化总结和文档。', actions: [{ action: 'document.generate', params: { kind } }] };
  }
  return null;
}

/** 规则引擎（确定性）：DeepSeek/本地模型都失败时的兜底，保证常见命令仍可真实执行 */
export function rulePlanOf(text) {
  const custom = customRulePlan(text);
  if (custom) return custom;
  return mockPlanOf(text);
}

export function buildCatalogText({ state = null, programs = [], extra = '' } = {}) {
  const lines = [];
  const nodes = Object.values((state && state.nodes) || {});
  if (nodes.length) {
    lines.push('设备：');
    for (const node of nodes.slice(0, 10)) {
      const caps = (node.capabilities || []).map((c) => c && c.id).filter(Boolean).slice(0, 10);
      lines.push('- ' + (node.name || node.id) + (node.online ? '（在线）' : '（离线）') + '：' + (caps.join('、') || '无能力记录'));
    }
  }
  if (programs.length) lines.push('常用程序：' + programs.slice(0, 12).join('、'));
  const recentScenes = Object.values((state && state.scenes && state.scenes.items) || {}).map((s) => s.name || s.sceneId).slice(0, 5);
  if (recentScenes.length) lines.push('可用场景：' + recentScenes.join('、'));
  return lines.join('\n') + (extra ? '\n' + extra : '');
}

function messagesForDeepSeek({ prompt, text, catalogText, stateSummary, history, round }) {
  const context = [
    '【当前环境】',
    '时间：' + new Date().toISOString(),
    catalogText || '（无设备目录）',
    stateSummary ? '【最近状态】\n' + stateSummary : '',
    history && history.length ? '【上一轮执行历史】\n' + history.map((h) => '- ' + h).join('\n') : '',
    '',
    '【用户语音命令】' + text,
    round > 0 ? '【系统提示】这是第 ' + (round + 1) + ' 轮：请根据上面的执行结果决定下一步（重试/换方案/只回复）。' : '',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: prompt },
    { role: 'user', content: context },
  ];
}

async function tryDeepSeek({ ai, prompt, text, catalogText, stateSummary, history, round, maxTokens = 420 }) {
  if (!ai || typeof ai.chat !== 'function' || !ai.available) return null;
  const messages = messagesForDeepSeek({ prompt, text, catalogText, stateSummary, history, round });
  const started = Date.now();
  const res = await ai.chat(messages, { maxTokens, temperature: 0.25, place: 'voice-plan' });
  const parsed = extractJson(res && res.text);
  if (!parsed) return { error: 'DeepSeek 未返回 JSON', raw: String((res && res.text) || '').slice(0, 400) };
  const clean = sanitizePlan(parsed);
  if (!clean.ok) return { error: clean.error };
  return { plan: clean, text: res.text, latencyMs: Date.now() - started, provider: 'deepseek', messages };
}

async function tryLocal({ workers, prompt, text, catalogText, stateSummary, history, maxTokens = 320 }) {
  if (!workers || typeof workers.chat !== 'function') return null;
  if (!workers.state || !['running', 'mock'].includes(workers.state.llm.state)) return null;
  const messages = [
    { role: 'system', content: prompt + '\n只输出 JSON：{"say":"...","actions":[],"needConfirm":false,"ask":""}。' },
    { role: 'user', content: '环境：\n' + catalogText + '\n命令：' + text + (history && history.length ? '\n上轮执行：' + history.join('；') : '') },
  ];
  const started = Date.now();
  const res = await workers.chat(messages, { maxTokens, timeoutMs: 60000 });
  const parsed = extractJson(res && res.text);
  if (!parsed) return { error: '本地模型未返回 JSON', raw: String((res && res.text) || '').slice(0, 300) };
  const clean = sanitizePlan(parsed);
  if (!clean.ok) return { error: clean.error };
  // 本地 0.5B 容易复述提示词/返回坏动作：只信任有合法动作或明确问答（say 不含 JSON 片段）
  const looksEcho = /动作白名单|输出一个 JSON|actions.*action/.test(clean.say) || clean.say.includes('"say"');
  if (looksEcho) return { error: '本地模型输出像是提示词回显，忽略' };
  if (!clean.actions.length && clean.dropped.length) return { error: '本地模型动作全部不合法：' + clean.dropped.join('；') };
  return { plan: clean, text: res.text, latencyMs: Date.now() - started, provider: 'local' };
}

/**
 * 规划（单轮）：DeepSeek 优先 → 本地 Qwen → 规则引擎。
 * @returns {{say,actions,provider,needConfirm,ask,latencyMs,fallback,error?,dropped?,raw?,aiMessages?}}
 */
export async function planCommand({ ai = null, text, workers = null, llmProvider = 'auto', catalogText = '', stateSummary = '', history = [], round = 0, prompts = null, superFallback = null } = {}) {
  const command = String(text || '').trim();
  const started = Date.now();
  const P = prompts || resolvePrompts({});
  const providerCfg = String(llmProvider || 'auto');
  const errors = [];
  // V5：明确意图（记笔记/提醒/总结）规则优先，不消耗 DeepSeek 额度，且避免模型误判成 handoff
  if (providerCfg !== 'mock' && RULE_FIRST_RE.test(command)) {
    const quick = sanitizePlan(customRulePlan(command));
    if (quick.actions.length) {
      return { say: quick.say, actions: quick.actions, needConfirm: quick.needConfirm, ask: quick.ask, dropped: quick.dropped, provider: 'rule', latencyMs: Date.now() - started, fallback: true, errors, ruleFirst: true };
    }
  }
  // 1) DeepSeek（云端理解；仅唤醒命令文本出本机）
  if (providerCfg !== 'rule' && providerCfg !== 'mock' && ai && ai.available) {
    try {
      const r = await tryDeepSeek({ ai, prompt: P.planner, text: command, catalogText, stateSummary, history, round });
      if (r && r.plan) {
        let actions = r.plan.actions;
        let say = r.plan.say;
        if (!actions.length && !r.plan.needConfirm) {
          const ruleAug = sanitizePlan(rulePlanOf(command));
          if (ruleAug.actions.length) { actions = ruleAug.actions; if (!say) say = ruleAug.say; }
        }
        return { say, actions, needConfirm: r.plan.needConfirm, ask: r.plan.ask, dropped: r.plan.dropped, provider: 'deepseek', latencyMs: Date.now() - started, fallback: false, aiMessages: r.messages, ruleAugmented: !r.plan.actions.length && actions.length > 0 };
      }
      if (r && r.error) errors.push('deepseek: ' + r.error);
    } catch (err) {
      errors.push('deepseek: ' + String((err && err.message) || err));
    }
  }
  // 2) 本地 Qwen（降级）
  if (providerCfg !== 'rule' && providerCfg !== 'mock') {
    try {
      const r = await tryLocal({ workers, prompt: P.planner, text: command, catalogText, stateSummary, history, round });
      if (r && r.plan) {
        let actions = r.plan.actions;
        let say = r.plan.say;
        if (!actions.length && !r.plan.needConfirm) {
          const ruleAug = sanitizePlan(rulePlanOf(command));
          if (ruleAug.actions.length) { actions = ruleAug.actions; if (!say) say = ruleAug.say; }
        }
        return { say, actions, needConfirm: r.plan.needConfirm, ask: r.plan.ask, dropped: r.plan.dropped, provider: 'local', latencyMs: Date.now() - started, fallback: true, errors, ruleAugmented: !r.plan.actions.length && actions.length > 0 };
      }
      if (r && r.error) errors.push('local: ' + r.error);
    } catch (err) {
      errors.push('local: ' + String((err && err.message) || err));
    }
  }
  if (providerCfg === 'mock') {
    const clean = sanitizePlan(rulePlanOf(command));
    return { say: clean.say, actions: clean.actions, needConfirm: clean.needConfirm, ask: clean.ask, dropped: clean.dropped, provider: 'mock', latencyMs: Date.now() - started, fallback: false, errors };
  }
  // 3) 规则引擎（确定性动作）
  const rule = sanitizePlan(rulePlanOf(command));
  if (rule.actions.length || rule.say) {
    return { say: rule.say, actions: rule.actions, needConfirm: rule.needConfirm || IRREVERSIBLE_WORDS.test(command), ask: rule.ask, dropped: rule.dropped, provider: 'rule', latencyMs: Date.now() - started, fallback: true, errors };
  }
  // 4) 交给超级终端规则引擎（会自带 AI 回退）
  if (typeof superFallback === 'function') {
    try {
      const res = await superFallback(command);
      return { say: (res && res.say) || '', actions: [], superResult: res || null, provider: 'rule', latencyMs: Date.now() - started, fallback: true, errors };
    } catch (err) {
      errors.push('super: ' + String((err && err.message) || err));
    }
  }
  return { say: '', actions: [], needConfirm: false, ask: '', provider: 'rule', latencyMs: Date.now() - started, fallback: true, errors };
}

/** 执行结果回传 DeepSeek 继续判断（Open-Interpreter 式，最多 3 轮，由调用方控制轮数） */
export async function followUpPlan({ ai, prompt, text, catalogText, stateSummary, history = [], round = 1, maxTokens = 400 }) {
  if (!ai || typeof ai.chat !== 'function' || !ai.available) return null;
  const messages = messagesForDeepSeek({ prompt, text, catalogText, stateSummary, history, round });
  messages.push({ role: 'user', content: '【上一轮执行结果】\n' + history.slice(-1)[0] + '\n请决定下一步：需要重试/补充动作就再给 actions；不需要就把 actions 置空并给出最终回复。' });
  const started = Date.now();
  try {
    const res = await ai.chat(messages, { maxTokens, temperature: 0.2, place: 'voice-followup' });
    const parsed = extractJson(res && res.text);
    if (!parsed) return { error: 'DeepSeek 后续轮未返回 JSON', provider: 'deepseek' };
    const clean = sanitizePlan(parsed);
    if (!clean.ok) return { error: clean.error, provider: 'deepseek' };
    return { plan: clean, provider: 'deepseek', latencyMs: Date.now() - started, messages };
  } catch (err) {
    return { error: String((err && err.message) || err), provider: 'deepseek' };
  }
}

export default { PLAN_VERSION, ACTION_WHITELIST, ACTION_ALIASES, sanitizePlan, normalizeAction, planCommand, followUpPlan, rulePlanOf, buildCatalogText, extractJson };