// 榫卯 Tenon v2.1 · 一句话 → 计划（AI 语音意图）
//
// 两条通道：
//   1) DeepSeek（server/lib/ai.js 的 AI.chat，DEEPSEEK_API_KEY；预算内 + 缓存 + 失败降级）：
//      输出严格 JSON {say:"人话回复", plan:[{capabilityId,nodeId,params,label,risk}]}；
//   2) 规则引擎兜底（永远可用、零网络）：打开程序 / 打开网址 / 甩到电脑 / 打印 / 放音乐/视频 /
//      回家模式 / 音量 / 开关电视灯 / 你好 / 你能做什么 / 有哪些设备。
//
// 计划里的 capabilityId 只能是 actions.js 里注册的动作（不含 internal 的 app.list）；AI 编造的 id/参数会被丢弃并降级规则。
import { getSuperAction, describeSuperAction, validateSuperParams, PLAN_CAPABILITY_IDS } from './actions.js';
import { resolveProgramByText, DESKTOP_PROGRAMS } from './catalog.js';
import { httpError, clip } from './errors.js';

export const INTENT_EXAMPLES = [
  '打开微信',
  '打开 Chrome 浏览器',
  '打开 https://github.com',
  '把这张照片甩到电脑',
  '把当前页面流转到电脑',
  '放首歌',
  '播放视频',
  '回家模式',
  '音量调大一点',
  '静音',
  '开电视',
  '关灯',
  '打印这份文件',
  '你能做什么',
];

const CACHE_MAX = 64;

export function createIntentCache() {
  return new Map();
}

function cacheGet(cache, key) {
  if (!cache || !cache.has(key)) return null;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value); // LRU：命中后移到末尾
  return value;
}

function cacheSet(cache, key, value) {
  if (!cache) return;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

function makeStep(capabilityId, params = {}, label = '', extra = {}) {
  const action = getSuperAction(capabilityId);
  if (!action) throw httpError(500, `意图生成失败：未注册动作 ${capabilityId}`);
  return {
    capabilityId,
    nodeId: extra.nodeId || null,
    params,
    label: label || describeSuperAction(action, params),
    risk: action.risk,
    ...(extra.simulated ? { simulated: true } : {}),
  };
}

export function normalizeUrl(raw) {
  let url = String(raw || '').trim().replace(/[，。；、)）】]+$/, '');
  if (!url) return '';
  if (/^[a-z]+:\/\//i.test(url)) return url;
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(url)) return 'https://' + url;
  return '';
}

function detectHandoffKind(text, context = {}) {
  if (/照片|图片|相册|截图|图像/.test(text)) return 'photo';
  if (/页面|网页|链接|网址|网站|这篇|文章/.test(text)) return 'page';
  if (/文字|文本|这段话|这段内容/.test(text)) return 'text';
  if (context.url) return 'page';
  if (context.assetId) return 'photo';
  return 'text';
}

export function parseRuleIntent(text, { catalog = null, context = {} } = {}) {
  const t = String(text || '').trim();
  const say = (s) => clip(s, 200);
  const devices = (catalog && catalog.devices) || [];
  const programs = (catalog && catalog.programs) || DESKTOP_PROGRAMS;

  // 0) 打招呼 / 感谢
  if (/^(你好|您好|嗨|hi|hello|哈喽|在吗)[!！。~～\s]*$/i.test(t)) {
    return { intent: 'greeting', say: '我在～ 你可以直接说：打开微信、放首歌、把照片甩到电脑，或者「回家模式」。', plan: [] };
  }
  if (/谢谢|感谢|辛苦/.test(t)) {
    return { intent: 'thanks', say: '不客气，需要我做什么直接说。', plan: [] };
  }

  // 1) 能力/设备介绍
  if (/你能做什么|你会什么|有什么用|怎么用|帮助|help|会哪些|能干嘛/i.test(t)) {
    const names = programs.slice(0, 6).map((p) => p.name).join('、');
    return {
      intent: 'help',
      say: `我可以一句话调动家里的设备和程序：打开程序（${names}…）、打开网址、把手机内容甩到电脑、打印、放音乐/视频、开电视/灯、调音量、回家模式。现在看到 ${devices.filter((d) => !d.simulated).length} 台真实设备 + ${devices.filter((d) => d.simulated).length} 台模拟设备。`,
      plan: [],
    };
  }
  if (/有哪些设备|设备列表|家里有什么|有什么设备|能看到哪些/.test(t)) {
    const real = devices.filter((d) => !d.simulated).map((d) => `${d.name}（${d.online ? '在线' : '离线'}）`);
    const sim = devices.filter((d) => d.simulated).map((d) => `${d.name}（模拟）`);
    return { intent: 'devices', say: `家里有：${real.join('、') || '暂无真实设备'}；模拟设备：${sim.join('、') || '无'}。`, plan: [] };
  }

  // 2) 甩到电脑（handoff）—— 放在"打开程序"之前，避免「把照片甩到电脑」被当成打开照片
  if (/(甩|扔|滑|传|投|推|发|流转|移|送).{0,4}(到|去|给|上)?(电脑|大屏|显示器|桌面)/.test(t) || /(电脑|大屏|桌面).{0,3}(看|显示|接收|接住)/.test(t)) {
    const kind = detectHandoffKind(t, context);
    const params = { kind, fromDevice: context.fromDevice || 'phone' };
    if (kind === 'page') params.url = context.url || normalizeUrl((t.match(/https?:\/\/[^\s，。]+/) || [])[0]) || '';
    if (kind === 'photo') {
      if (context.assetId) params.assetId = context.assetId;
      if (context.path) params.path = context.path;
    }
    if (kind === 'text') params.text = context.text || t;
    const kindLabel = { page: '页面', photo: '照片', text: '文字' }[kind];
    return {
      intent: 'handoff',
      say: `好的，把${kindLabel}甩到电脑上展示${kind === 'page' && !params.url ? '（没看到页面地址，请在手机页点「甩到电脑」）' : ''}。`,
      plan: [makeStep('handoff.show', params, `把${kindLabel}甩到电脑`)],
    };
  }

  // 3) 回家模式（组合动作）
  if (/回家模式|我回来了|到家了|回家场景|下班回家/.test(t)) {
    return {
      intent: 'home-mode',
      say: '收到，回家模式：开客厅灯 + 开电视 + 放音乐；模拟设备会在结果里标注「模拟」。',
      plan: [
        makeStep('light.on', { room: '客厅' }, '打开客厅灯', { simulated: true }),
        makeStep('tv.on', {}, '打开客厅电视', { simulated: true }),
        makeStep('media.show', { source: 'music' }, '音箱放点音乐', { simulated: true }),
      ],
    };
  }

  // 4) 电视 / 灯
  if (/关电视|关闭电视|电视关/.test(t)) return { intent: 'tv-off', say: '好，关电视。', plan: [makeStep('tv.off', {}, '关闭客厅电视', { simulated: true })] };
  if (/开电视|打开电视|看电视|电视打开/.test(t)) return { intent: 'tv-on', say: '好，开电视。', plan: [makeStep('tv.on', {}, '打开客厅电视', { simulated: true })] };
  if (/关灯|把灯关|关掉灯/.test(t)) return { intent: 'light-off', say: '好，关灯。', plan: [makeStep('light.off', { room: '客厅' }, '关闭客厅灯', { simulated: true })] };
  if (/开灯|把灯打开|打开灯|亮一点/.test(t)) return { intent: 'light-on', say: '好，开灯。', plan: [makeStep('light.on', { room: '客厅' }, '打开客厅灯', { simulated: true })] };

  // 5) 音量
  if (/音量|声音|喇叭|音响|静音|mute/i.test(t)) {
    const isVolume = /音量|声音|喇叭|音响|静音|mute/i.test(t);
    if (isVolume) {
      let action = null;
      if (/静音|mute|别出声/.test(t)) action = 'mute';
      else if (/大|高|响|调高|放大|上去/.test(t)) action = 'up';
      else if (/小|低|轻|调低|下来/.test(t)) action = 'down';
      const levelMatch = t.match(/(\d{1,3})\s*(%|档)?/);
      if (!action && levelMatch) {
        return { intent: 'volume-absolute', say: 'P0 只支持「音量调大/调小/静音」；绝对音量（调到多少）需要 P1 的 CoreAudio 实现。', plan: [] };
      }
      if (action) {
        const stepsMatch = t.match(/(\d{1,2})\s*档/);
        const steps = stepsMatch ? Math.max(1, Math.min(50, Number(stepsMatch[1]))) : 5;
        return { intent: 'volume', say: `好，音量${action === 'up' ? '调大' : action === 'down' ? '调小' : '静音'}。`, plan: [makeStep('system.volume', { action, steps }, undefined)] };
      }
    }
  }

  // 6) 打印（不可逆，executor 会要求确认）
  if (/打印|印一份|印一下|打出来|出纸/.test(t)) {
    const copiesMatch = t.match(/(\d{1,2})\s*份/);
    const copies = copiesMatch ? Math.max(1, Math.min(99, Number(copiesMatch[1]))) : 1;
    const path = context.path || '示例空间/样品图/样品01.png';
    return {
      intent: 'print',
      say: `要打印 ${path}${copies > 1 ? ` × ${copies} 份` : ''}；打印是不可逆动作，需要你确认后执行。`,
      plan: [makeStep('file.print', { path, copies }, undefined)],
    };
  }

  // 7) 放音乐 / 视频
  if (/放首?歌|放点音乐|听歌|播放音乐|放音乐|来点音乐|music/i.test(t)) {
    return { intent: 'media-music', say: '好，放点音乐。', plan: [makeStep('media.show', { source: 'music' }, '放音乐')] };
  }
  if (/放视频|播放视频|看电影|放电影|video/i.test(t)) {
    return { intent: 'media-video', say: '好，放视频。', plan: [makeStep('media.show', { source: 'video' }, '放视频')] };
  }
  if (/在电视上(放|播|看)/.test(t)) {
    return { intent: 'media-tv', say: '好，投到电视上播放。', plan: [makeStep('media.show', { source: 'video', deviceId: 'tv-sim' }, '在电视上播放')] };
  }

  // 8) 打开网址
  const urlInText = t.match(/(https?:\/\/[^\s，。；、)）]+)/i) || t.match(/((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[\w\-./?%&=#:+]*)?)/i);
  if (urlInText && /打开|访问|浏览|去|进|看看|网页|网站|链接/i.test(t)) {
    const url = normalizeUrl(urlInText[1] || urlInText[0]);
    if (url) {
      const fullscreen = /全屏|满屏|kiosk/i.test(t);
      return { intent: 'url-open', say: `好，在电脑浏览器打开 ${url}${fullscreen ? '（全屏）' : ''}。`, plan: [makeStep('url.open', { url, fullscreen }, `打开网址 ${url}`)] };
    }
  }

  // 9) 打开程序
  const program = resolveProgramByText(t);
  if (program && /打开|启动|开一下|帮我开|运行|launch/i.test(t)) {
    if (program.id === 'print') {
      // 「打开打印」不常见，转成打印意图交给上一条更合适；这里保持诚实
      return { intent: 'print', say: '要打印文件的话，说「打印这份文件」；需要的话我可以帮你打开打印设置。', plan: [] };
    }
    return {
      intent: 'app-launch',
      say: `好，在电脑上打开${program.name}。`,
      plan: [makeStep('app.launch', { app: program.app }, `打开${program.name}`)],
    };
  }
  // 9b) 打开某个没说全的程序（如「打开QQ」）：取「打开」后面的词作为程序名
  const genericOpen = t.match(/(?:打开|启动|运行)\s*([A-Za-z\u4e00-\u9fa5][\w\u4e00-\u9fa5 .-]{0,15})/);
  if (genericOpen) {
    const appName = genericOpen[1].trim();
    return { intent: 'app-launch', say: `好，试试在电脑上打开「${appName}」。`, plan: [makeStep('app.launch', { app: appName }, `打开${appName}`)] };
  }

  // 10) 兜底：诚实说明没听懂
  return {
    intent: 'unknown',
    say: '我还不太懂这句话。你可以说：「打开微信」「放首歌」「把照片甩到电脑」「回家模式」「打开 https://github.com」。',
    plan: [],
  };
}

const AI_SYSTEM_PROMPT = [
  '你是「榫卯 · 超级终端」的家庭语音助手，负责把用户一句话转成可控计划。',
  '只输出 JSON，不要 Markdown 代码块、不要解释。',
  '输出格式：{"say":"人话回复（20 字内）","plan":[{"capabilityId":"动作id","nodeId":"设备id或null","params":{},"label":"人话动作"}]}',
  'plan 最多 5 步；如果只是聊天/问答，plan 输出 []。',
  'capabilityId 只能从给定动作列表里选，不能编造；params 必须满足该动作的参数要求。',
].join('\n');

function buildAiUserPrompt({ text, catalog, context }) {
  const devices = (catalog && catalog.devices) || [];
  const programs = (catalog && catalog.programs) || [];
  const actions = (catalog && catalog.actions) || [];
  return [
    '【动作列表】',
    ...actions.map((a) => `- ${a.id}（${a.name}，risk=${a.risk}）参数:${JSON.stringify(a.params.required || [])} ${a.description}`),
    '【设备】',
    devices.map((d) => `- ${d.deviceId}（${d.name}，kind=${d.kind}，online=${d.online ? '是' : '否'}${d.simulated ? '，模拟设备' : ''}）能做的动作:${(d.actions || []).join(',') || '无'}`).join('\n'),
    '【电脑程序清单】',
    programs.map((p) => `- ${p.name}（打开时 app.launch 的 params.app="${p.app || p.name}"，可用=${p.available ? '是' : '否（将模拟）'}）`).join('\n'),
    '【上下文】',
    JSON.stringify(context || {}),
    `【用户说】${text}`,
    '请输出 JSON。注意：甩到电脑用 handoff.show（kind=page/photo/text）；打开程序用 app.launch；打开网址用 url.open；音乐视频用 media.show；打印用 file.print；音量用 system.volume。',
  ].join('\n');
}

function sanitizeAiResult(parsed, { catalog, context }) {
  const say = clip(String((parsed && parsed.say) || '').trim(), 160);
  const rawPlan = Array.isArray(parsed && parsed.plan) ? parsed.plan.slice(0, 5) : [];
  const plan = [];
  const errors = [];
  for (const raw of rawPlan) {
    const action = getSuperAction(raw && raw.capabilityId);
    if (!action || action.internal) {
      errors.push(`未知动作 ${raw && raw.capabilityId}`);
      continue;
    }
    let params = raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params) ? { ...raw.params } : {};
    if (action.id === 'handoff.show') {
      params = {
        kind: ['page', 'photo', 'text'].includes(params.kind) ? params.kind : detectHandoffKind('', context),
        url: params.url || (context && context.url) || undefined,
        assetId: params.assetId || (context && context.assetId) || undefined,
        text: params.text || (context && context.text) || undefined,
        fromDevice: params.fromDevice || (context && context.fromDevice) || undefined,
      };
      params = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''));
    }
    if (action.id === 'system.volume') {
      params.steps = Number(params.steps) || 5;
    }
    const paramErrors = validateSuperParams(action, params);
    if (paramErrors.length) {
      errors.push(`${action.id}: ${paramErrors.join('；')}`);
      continue;
    }
    plan.push({
      capabilityId: action.id,
      nodeId: raw.nodeId && raw.nodeId !== 'hub' ? String(raw.nodeId) : null,
      params,
      label: clip(String(raw.label || '').trim(), 60) || describeSuperAction(action, params),
      risk: action.risk,
    });
  }
  return { say, plan, errors };
}

/**
 * 一句话 → 计划。
 * @returns {{intent:string, say:string, plan:Array, source:'deepseek'|'cache'|'rule', ai:{provider:string,tokensIn?:number,tokensOut?:number,cached?:boolean,fallback?:boolean,reason?:string}}}
 */
export async function parseIntent({ text, ai = null, catalog = null, context = {}, cache = null }) {
  const input = String(text || '').trim();
  if (!input) throw httpError(400, '请先说一句话');
  if (input.length > 300) throw httpError(400, '一句话最多 300 字');

  const rule = parseRuleIntent(input, { catalog, context });
  const key = input + '|' + JSON.stringify(context || {});
  const cached = cacheGet(cache, key);
  if (cached) {
    return { ...cached, source: 'cache', ai: { provider: 'cache', cached: true } };
  }

  const canUseAi = !!(ai && ai.available && typeof ai.chat === 'function' && (!ai.budgetLeft || ai.budgetLeft()));
  if (!canUseAi) {
    return {
      ...rule,
      source: 'rule',
      ai: { provider: 'rule', fallback: true, reason: ai && ai.available ? 'token 预算已用尽' : '未配置 DEEPSEEK_API_KEY' },
    };
  }

  try {
    const r = await ai.chat(
      [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: buildAiUserPrompt({ text: input, catalog, context }) },
      ],
      { maxTokens: 500, temperature: 0.2, place: 'super-intent' },
    );
    const cleaned = String((r && r.text) || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const sanitized = sanitizeAiResult(parsed, { catalog, context });
    const hasUsablePlan = sanitized.plan.length > 0;
    const pureAnswer = sanitized.plan.length === 0 && rawPlanEmpty(parsed) && sanitized.say;
    if (!hasUsablePlan && !pureAnswer) {
      return {
        ...rule,
        source: 'rule',
        ai: { provider: 'rule', fallback: true, reason: 'AI 返回的计划不可用：' + (sanitized.errors.join('；') || '空计划').slice(0, 120) },
      };
    }
    const result = {
      intent: hasUsablePlan ? 'ai-plan' : 'ai-answer',
      say: sanitized.say || rule.say,
      plan: hasUsablePlan ? sanitized.plan : [],
      source: 'deepseek',
      ai: { provider: 'deepseek', model: ai.model || 'deepseek-chat', tokensIn: (r && r.tokensIn) || 0, tokensOut: (r && r.tokensOut) || 0, cached: false },
    };
    cacheSet(cache, key, result);
    return result;
  } catch (err) {
    return {
      ...rule,
      source: 'rule',
      ai: { provider: 'rule', fallback: true, reason: String((err && err.message) || err).slice(0, 120) },
    };
  }
}

function rawPlanEmpty(parsed) {
  return !parsed || !Array.isArray(parsed.plan) || parsed.plan.length === 0;
}

export default { INTENT_EXAMPLES, parseIntent, parseRuleIntent, normalizeUrl, createIntentCache };