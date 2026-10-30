// 榫卯 V4 · 执行器规划器：DeepSeek 优先 → 本地 Qwen → 规则；执行结果回传最多 3 轮。
import { resolveAgentPrompts } from './prompts.js';

export const AGENT_ACTIONS = {
  'app.launch': { label: '打开程序', risk: 'reversible', params: ['app'] },
  'url.open': { label: '打开网页', risk: 'reversible', params: ['url', 'fullscreen'] },
  'system.volume': { label: '本机音量', risk: 'reversible', params: ['action', 'level', 'steps', 'mute'] },
  'media.show': { label: '播放/展示素材', risk: 'reversible', params: ['path', 'source', 'assetId'] },
  'handoff.show': { label: '甩到电脑大屏', risk: 'reversible', params: ['kind', 'text', 'url', 'assetId', 'fromDevice'] },
  'file.print': { label: '打印文件', risk: 'irreversible', params: ['file', 'path', 'copies'] },
  'scene.run': { label: '一键场景', risk: 'reversible', params: ['presetId', 'sceneId', 'id'] },
  'device.control': { label: '控制设备', risk: 'reversible', params: ['deviceId', 'app', 'command', 'action', 'value'] },
  'agent.message': { label: '发消息', risk: 'irreversible', params: ['to', 'text'] },
  'shell.exec': { label: '执行命令', risk: 'irreversible', params: ['command', 'cwd', 'timeoutMs'] },
  'window.list': { label: '列出窗口', risk: 'reversible', params: [] },
  'window.focus': { label: '激活窗口', risk: 'reversible', params: ['title', 'process'] },
  'screen.capture': { label: '截屏', risk: 'reversible', params: ['region', 'fullscreen'] },
  'input.mouse': { label: '鼠标控制', risk: 'reversible', params: ['action', 'x', 'y', 'dx', 'dy', 'button', 'amount'] },
  'input.key': { label: '键盘输入', risk: 'reversible', params: ['text', 'combo'] },
  'input.media': { label: '媒体键', risk: 'reversible', params: ['action'] },
  'note.create': { label: '记笔记', risk: 'reversible', params: ['text', 'title', 'tags'] },
  'note.summarize': { label: '总结笔记', risk: 'reversible', params: ['ids', 'date', 'text'] },
  'reminder.create': { label: '创建提醒', risk: 'reversible', params: ['text', 'at', 'recurrence', 'inMinutes'] },
  'document.generate': { label: '生成文档', risk: 'reversible', params: ['kind', 'date', 'ids', 'title'] },
};

const AGENT_RULE_FIRST_RE = /记一下|记下来|记录一下|记录：|帮我记|备忘[:：]?|做个笔记|笔记[:：]|提醒我|提醒一下|别忘了|闹钟|总结(一下)?(今天|今日|我的记录|这段|一下)|生成(今日|今天)?总结|导出(今日|今天)?总结|做成文档|生成文档|发到手机/;

const IRREVERSIBLE = new Set(['file.print', 'agent.message', 'shell.exec']);
const DANGEROUS_SHELL = /(format|diskpart|del\s+\/|rmdir\s+\/s|shutdown|reg\s+delete|mkfs|dd\s+if=|net\s+user\s+.*\s+add|bcdedit|vssadmin|takeown|icacls\s+.*\/reset)/i;

function asString(v) { return v == null ? '' : String(v); }
function escapeReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function extractJson(text) {
  const raw = asString(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{') continue;
    let depth = 0;
    for (let i = start; i < raw.length; i += 1) {
      if (raw[i] === '{') depth += 1;
      else if (raw[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(raw.slice(start, i + 1)); } catch { /* next */ }
        }
      }
    }
  }
  return null;
}

export function normalizeAgentAction(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '第 ' + (index + 1) + ' 个动作不是对象' };
  const name = asString(raw.action || raw.capabilityId || raw.id || raw.type).trim();
  if (!AGENT_ACTIONS[name]) return { ok: false, error: '动作不在白名单：' + (name || '(空)') };
  const params = { ...(raw.params && typeof raw.params === 'object' ? raw.params : {}) };
  for (const key of AGENT_ACTIONS[name].params) {
    if (key !== 'action' && raw[key] !== undefined && params[key] === undefined) params[key] = raw[key];
  }
  if (name === 'app.launch') { params.app = asString(params.app || params.name || params.program).trim(); if (!params.app) return { ok: false, error: 'app.launch 缺少 app' }; }
  if (name === 'url.open') { params.url = asString(params.url || params.target).trim(); if (!/^https?:\/\//i.test(params.url)) { if (/^[\w.-]+\.[a-z]{2,}/i.test(params.url)) params.url = 'https://' + params.url; else return { ok: false, error: 'url.open 缺少合法 url' }; } }
  if (name === 'system.volume') {
    if (params.mute === true) params.action = 'mute';
    if (params.level !== undefined && params.level !== null) {
      const level = Number(String(params.level).replace('%', ''));
      if (!Number.isFinite(level) || level < 0 || level > 100) return { ok: false, error: '音量必须是 0-100' };
      params.level = Math.round(level);
    }
    if (!params.action) params.action = 'up';
    if (!['up', 'down', 'mute'].includes(String(params.action))) return { ok: false, error: '音量动作只能是 up/down/mute' };
  }
  if (name === 'scene.run') { const id = asString(params.presetId || params.sceneId || params.id).toLowerCase(); if (!['home', 'work', 'sleep'].includes(id)) return { ok: false, error: '场景只能是 home/work/sleep' }; params.presetId = id; }
  if (name === 'handoff.show') { params.kind = asString(params.kind || (params.url ? 'page' : 'text')).toLowerCase(); if (!['text', 'page', 'photo'].includes(params.kind)) return { ok: false, error: 'handoff kind 非法' }; if (params.kind === 'text') params.text = asString(params.text || '来自执行器的内容'); }
  if (name === 'file.print') { params.file = asString(params.file || params.path).trim(); if (!params.file) params.file = '示例空间/样品图/样品01.png'; params.copies = Math.max(1, Math.min(20, Number(params.copies) || 1)); params.path = params.path || params.file; }
  if (name === 'agent.message') { params.to = asString(params.to || 'desktop').trim(); params.text = asString(params.text).trim(); if (!params.text) return { ok: false, error: 'agent.message 缺少 text' }; }
  if (name === 'shell.exec') {
    params.command = asString(params.command || params.cmd || params.script).trim();
    if (!params.command) return { ok: false, error: 'shell.exec 缺少 command' };
    if (DANGEROUS_SHELL.test(params.command)) return { ok: false, error: '危险命令已被拦截（格式化/删除系统/关机/注册表等）' };
    params.timeoutMs = Math.max(1000, Math.min(120000, Number(params.timeoutMs) || 15000));
  }
  if (name === 'device.control') { const app = asString(params.app || params.command || params.action).trim(); if (!app) return { ok: false, error: 'device.control 缺少 command/app' }; params.app = app; }
  if (name === 'window.focus') { params.title = asString(params.title || params.window).trim(); params.process = asString(params.process || params.exe).trim(); if (!params.title && !params.process) return { ok: false, error: 'window.focus 需要 title 或 process' }; }
  if (name === 'input.mouse') { params.action = asString(params.action || 'move'); if (!['move', 'click', 'down', 'up', 'wheel'].includes(params.action)) return { ok: false, error: 'input.mouse action 非法' }; }
  if (name === 'input.key') { if (!params.text && !params.combo) return { ok: false, error: 'input.key 需要 text 或 combo' }; }
  if (name === 'input.media') { params.action = asString(params.action || 'play-pause'); }
  if (name === 'note.create') { params.text = asString(params.text || params.content || params.note).trim(); if (!params.text) return { ok: false, error: 'note.create 缺少 text' }; }
  if (name === 'reminder.create') { params.text = asString(params.text || params.content || params.raw).trim(); if (!params.text) return { ok: false, error: 'reminder.create 缺少 text' }; if (params.recurrence !== undefined) params.recurrence = params.recurrence === 'daily' ? 'daily' : 'once'; }
  if (name === 'note.summarize') { params.ids = Array.isArray(params.ids) ? params.ids.map((x) => asString(x)).filter(Boolean) : (params.ids ? [asString(params.ids)] : []); }
  if (name === 'document.generate') { const kind = asString(params.kind || 'note-summary'); if (!['note-summary', 'daily', 'note-set'].includes(kind)) return { ok: false, error: 'document.generate kind 非法' }; params.kind = kind; params.ids = Array.isArray(params.ids) ? params.ids.map((x) => asString(x)).filter(Boolean) : (params.ids ? [asString(params.ids)] : []); }
  return { ok: true, action: { action: name, label: AGENT_ACTIONS[name].label, risk: AGENT_ACTIONS[name].risk, params, deviceId: raw.deviceId ? asString(raw.deviceId) : null } };
}

export function sanitizeAgentPlan(parsed) {
  const out = { say: '', actions: [], needConfirm: false, ask: '', dropped: [] };
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: '模型输出不是 JSON 对象', ...out };
  out.say = asString(parsed.say || parsed.reply || parsed.text || '').trim().slice(0, 400);
  out.ask = asString(parsed.ask || '').trim().slice(0, 200);
  out.needConfirm = parsed.needConfirm === true || parsed.need_confirm === true;
  const list = Array.isArray(parsed.actions) ? parsed.actions : (Array.isArray(parsed.plan) ? parsed.plan : []);
  for (let i = 0; i < Math.min(list.length, 4); i += 1) {
    const norm = normalizeAgentAction(list[i], i);
    if (norm.ok) out.actions.push(norm.action);
    else out.dropped.push(norm.error);
  }
  const hasRisky = out.actions.some((a) => IRREVERSIBLE.has(a.action));
  if (hasRisky) out.needConfirm = true;
  return { ok: true, ...out };
}

export function rulePlanOf(text) {
  const t = String(text || '');
  // V5：语音笔记 / 提醒 / 结构化总结（规则兜底）
  if (/记一下|记下来|记录一下|记录：|帮我记|备忘[:：]?|做个笔记|笔记[:：]/.test(t) && !/记不记得/.test(t)) {
    const noteText = t.replace(/^.*?(?:帮我记|帮我记录|记一下|记录一下|记录|记下来|备忘|做个笔记|笔记)[:：,，\s]*/g, '').trim() || t;
    return { say: '好，记下了：' + noteText.slice(0, 40), actions: [{ action: 'note.create', params: { text: noteText, source: 'voice' } }], needConfirm: false };
  }
  if (/提醒我|提醒一下|别忘了|闹钟/.test(t)) return { say: '好，我来设置提醒。', actions: [{ action: 'reminder.create', params: { text: t, source: 'voice' } }], needConfirm: false };
  if (/总结(一下)?(今天|今日|我的记录|这段|一下)|生成(今日|今天)?总结|导出(今日|今天)?总结|做成文档|生成文档|发到手机/.test(t)) {
    const kind = /这段|这个笔记|笔记总结/.test(t) ? 'note-summary' : 'daily';
    return { say: '好，我来生成结构化总结和文档。', actions: [{ action: 'document.generate', params: { kind } }], needConfirm: false };
  }
  if (/音量|声音|静音/.test(t)) {
    const m = t.match(/(\d{1,3})/);
    if (m) { const level = Math.max(0, Math.min(100, Number(m[1]))); return { say: '把音量调到 ' + level + '%', actions: [{ action: 'system.volume', params: { level, action: 'up' } }], needConfirm: false }; }
    if (/静音/.test(t)) return { say: '静音', actions: [{ action: 'system.volume', params: { action: 'mute' } }], needConfirm: false };
    return { say: '调音量', actions: [{ action: 'system.volume', params: { action: /小/.test(t) ? 'down' : 'up' } }], needConfirm: false };
  }
  if (/列.*窗口|窗口.*列表|看看窗口|有哪些窗口/.test(t)) return { say: '列出窗口', actions: [{ action: 'window.list', params: {} }], needConfirm: false };
  if (/截(个|一下|一张|取|图)?屏|截图|屏幕截图/.test(t)) return { say: '截屏', actions: [{ action: 'screen.capture', params: {} }], needConfirm: false };
  if (/打开.*(记事本|notepad)|记事本/.test(t)) return { say: '打开记事本', actions: [{ action: 'app.launch', params: { app: 'notepad' } }], needConfirm: false };
  if (/打开.*(chrome|浏览器)/i.test(t)) return { say: '打开 Chrome', actions: [{ action: 'app.launch', params: { app: 'chrome' } }], needConfirm: false };
  if (/回家/.test(t)) return { say: '回家模式', actions: [{ action: 'scene.run', params: { presetId: 'home' } }], needConfirm: false };
  if (/工作模式/.test(t)) return { say: '工作模式', actions: [{ action: 'scene.run', params: { presetId: 'work' } }], needConfirm: false };
  if (/晚安|睡前/.test(t)) return { say: '睡前模式', actions: [{ action: 'scene.run', params: { presetId: 'sleep' } }], needConfirm: false };
  if (/打印/.test(t)) return { say: '打印需要确认', actions: [{ action: 'file.print', params: { file: '示例空间/样品图/样品01.png', copies: 1 } }], needConfirm: true };
  if (/执行命令|运行命令|shell|cmd/i.test(t)) {
    const m = t.match(/[`"“']([^`"”']+)[`"”']/);
    const cmd = m ? m[1] : t.replace(/^.*?(执行|运行|命令)/, '').trim();
    if (cmd) return { say: '执行命令需要确认', actions: [{ action: 'shell.exec', params: { command: cmd } }], needConfirm: true };
  }
  return { say: '', actions: [], needConfirm: false };
}

export function buildCatalogText({ state = null } = {}) {
  const lines = [];
  const nodes = Object.values((state && state.nodes) || {});
  for (const node of nodes.slice(0, 12)) {
    const caps = (node.capabilities || []).map((c) => c && c.id).filter(Boolean).slice(0, 12);
    if (caps.length) lines.push('- ' + (node.name || node.id) + (node.online ? '（在线）' : '（离线）') + '：' + caps.join('、'));
  }
  return lines.join('\n') || '（暂无已注册设备；可用本机中枢默认能力）';
}

function messagesOf(prompts, { text, context, catalogText, history, round }) {
  const ctx = [
    '时间：' + new Date().toISOString(),
    '【设备能力】\n' + catalogText,
    context ? '【上下文】\n' + (typeof context === 'string' ? context : JSON.stringify(context).slice(0, 1500)) : '',
    history && history.length ? '【历史执行结果】\n' + history.join('\n') : '',
    '【用户请求】' + text,
    round > 0 ? '【第 ' + (round + 1) + ' 轮】根据上面的执行结果决定下一步（重试/换方案/只回复）。' : '',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: prompts.planner },
    { role: 'user', content: ctx },
  ];
}

export async function planAgent({ ai = null, workers = null, llmProvider = 'auto', text, context = null, catalogText = '', history = [], round = 0, prompts = null } = {}) {
  const P = prompts || resolveAgentPrompts({});
  const started = Date.now();
  // V5：明确意图（记笔记/提醒/总结）规则优先，不消耗 DeepSeek 额度
  if (AGENT_RULE_FIRST_RE.test(String(text || ''))) {
    const quick = sanitizeAgentPlan(rulePlanOf(text));
    if (quick.actions.length) {
      return { say: quick.say, actions: quick.actions, needConfirm: quick.needConfirm, ask: quick.ask, provider: 'rule', rounds: round + 1, latencyMs: Date.now() - started, dropped: quick.dropped, ruleFirst: true };
    }
  }
  if (ai && ai.available && llmProvider !== 'rule') {
    try {
      const messages = messagesOf(P, { text, context, catalogText, history, round });
      const res = await ai.chat(messages, { maxTokens: 420, temperature: 0.2, place: 'agent-plan' });
      const parsed = extractJson(res && res.text);
      if (parsed) {
        const clean = sanitizeAgentPlan(parsed);
        if (clean.ok) return { say: clean.say, actions: clean.actions, needConfirm: clean.needConfirm, ask: clean.ask, provider: 'deepseek', rounds: round + 1, latencyMs: Date.now() - started, dropped: clean.dropped, messages };
      }
    } catch (err) { /* 降级 */ }
  }
  if (workers && workers.state && workers.state.llm && ['running', 'mock'].includes(workers.state.llm.state) && llmProvider !== 'rule') {
    try {
      const messages = messagesOf(P, { text, context, catalogText, history, round });
      const res = await workers.chat(messages, { maxTokens: 320, timeoutMs: 60000 });
      const parsed = extractJson(res && res.text);
      if (parsed) {
        const clean = sanitizeAgentPlan(parsed);
        if (clean.ok) return { say: clean.say, actions: clean.actions, needConfirm: clean.needConfirm, ask: clean.ask, provider: 'local', rounds: round + 1, latencyMs: Date.now() - started, dropped: clean.dropped };
      }
    } catch (err) { /* 降级规则 */ }
  }
  const rule = sanitizeAgentPlan(rulePlanOf(text));
  return { say: rule.say, actions: rule.actions, needConfirm: rule.needConfirm, ask: '', provider: 'rule', rounds: round + 1, latencyMs: Date.now() - started, dropped: rule.dropped };
}

export async function followUpAgent({ ai = null, workers = null, text, context = null, catalogText = '', history = [], round = 0, prompts = null } = {}) {
  const P = prompts || resolveAgentPrompts({});
  const historyText = (history || []).slice(-4).join('\n');
  if (ai && ai.available) {
    const messages = messagesOf(P, { text, context, catalogText, history, round });
    messages.push({ role: 'user', content: P.resultInstruction + '\n【执行结果】\n' + (historyText || '（无）') });
    try {
      const res = await ai.chat(messages, { maxTokens: 420, temperature: 0.2, place: 'agent-followup' });
      const parsed = extractJson(res && res.text);
      if (parsed) { const clean = sanitizeAgentPlan(parsed); if (clean.ok) return { say: clean.say, actions: clean.actions, needConfirm: clean.needConfirm, ask: clean.ask, provider: 'deepseek', rounds: round + 1 }; }
    } catch (err) { /* fallthrough */ }
  }
  if (workers && workers.state && workers.state.llm && ['running', 'mock'].includes(workers.state.llm.state)) {
    try {
      const messages = messagesOf(P, { text, context, catalogText, history, round });
      messages.push({ role: 'user', content: P.resultInstruction + '\n【执行结果】\n' + (historyText || '（无）') });
      const res = await workers.chat(messages, { maxTokens: 320, timeoutMs: 60000 });
      const parsed = extractJson(res && res.text);
      if (parsed) { const clean = sanitizeAgentPlan(parsed); if (clean.ok) return { say: clean.say, actions: clean.actions, needConfirm: clean.needConfirm, ask: clean.ask, provider: 'local', rounds: round + 1 }; }
    } catch (err) { /* ignore */ }
  }
  return null;
}

export default { AGENT_ACTIONS, normalizeAgentAction, sanitizeAgentPlan, planAgent, followUpAgent, buildCatalogText, rulePlanOf, extractJson };