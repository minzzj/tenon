// 榫卯 Tenon v2.1 · 超级终端动作注册表
//
// 消费级动作 = 用户一句话里能做的事。每个动作声明：
//   id            动作 id（也是 DeepSeek/规则引擎输出的 capabilityId）
//   kind          'node'（派给电脑/设备执行）| 'hub'（中枢直接执行，如流转）| 'simulated'（模拟家庭设备）
//   capabilityChain  节点能力优先级链：优先用第一个已注册的能力，如 url.open 没有时退到 system.open
//   risk          'reversible' | 'irreversible'（不可逆动作必须先确认）
//   simulatedFallback 没有可用节点时是否降级为「模拟执行」（结果里明确 simulated:true，不假装真实执行）
//   params/describe  参数 schema 与人话描述
//
// 本文件只做"动作是什么"的声明与参数映射；"派给哪台设备/怎么执行"在 catalog.js / executor.js。
import { httpError } from './errors.js';

export const SUPER_ACTION_VERSION = '2.1.0';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });

export const SUPER_ACTIONS = [
  {
    id: 'app.launch',
    name: '打开电脑程序',
    description: '在电脑上启动一个程序（微信 / Chrome / 记事本 / 资源管理器 / 计算器 / 音乐 / 照片…）',
    kind: 'node',
    capabilityChain: ['app.launch'],
    risk: 'reversible',
    simulatedFallback: true,
    simulatedSummary: (params) => `（模拟）已让电脑打开「${params.app}」`,
    effects: ['电脑上弹出程序窗口'],
    params: {
      type: 'object',
      required: ['app'],
      properties: {
        app: str('程序名或可执行文件路径（如 微信 / chrome / notepad）'),
        args: { type: 'array', description: '启动参数（可选）', items: { type: 'string' } },
      },
    },
    describe: (p) => `在电脑上打开 ${p.app}`,
  },
  {
    id: 'url.open',
    name: '打开网址',
    description: '在电脑默认浏览器中打开一个网址（可全屏/Kiosk）',
    kind: 'node',
    capabilityChain: ['url.open', 'system.open'],
    risk: 'reversible',
    simulatedFallback: true,
    simulatedSummary: (params) => `（模拟）已记录打开网址 ${params.url}`,
    effects: ['浏览器打开页面'],
    params: {
      type: 'object',
      required: ['url'],
      properties: {
        url: str('要打开的网址（http/https）'),
        fullscreen: { type: 'boolean', description: '是否全屏（默认否）' },
      },
    },
    describe: (p) => `打开网址 ${p.url}`,
  },
  {
    id: 'media.show',
    name: '放音乐/视频/打开文件',
    description: '在电脑、电视或音箱上播放音乐/视频/打开图片',
    kind: 'node',
    capabilityChain: ['media.show', 'system.open'],
    risk: 'reversible',
    simulatedFallback: true,
    simulatedSummary: (params) => `（模拟）已让家庭设备播放 ${params.source || params.path || '内容'}`,
    effects: ['设备发声/出画面'],
    params: {
      type: 'object',
      required: [],
      properties: {
        source: str('播放内容来源：music | video | photo（或具体的文件标识）'),
        path: str('要打开/播放的本地文件路径（可选）'),
        deviceId: str('目标设备 id（可选，默认自动选音箱/电视/电脑）'),
      },
    },
    describe: (p) => `在${p.deviceName ? '「' + p.deviceName + '」上' : ''}播放 ${p.source || p.path || '内容'}`,
  },
  {
    id: 'handoff.show',
    name: '甩到电脑（流转）',
    description: '把手机上的页面/照片/文字流转到电脑大屏展示（学鸿蒙超级终端：手机一倾内容滑到电脑）',
    kind: 'hub',
    capabilityChain: ['handoff.show', 'system.open'],
    risk: 'reversible',
    simulatedFallback: false,
    effects: ['电脑大屏显示手机内容'],
    params: {
      type: 'object',
      required: [],
      properties: {
        kind: str('流转类型：page | photo | text'),
        url: str('页面地址（kind=page 时）'),
        assetId: str('素材 id（kind=photo 时）'),
        text: str('文字内容（kind=text 时）'),
        fromDevice: str('来源设备 id（可选）'),
      },
    },
    describe: (p) => `把${p.kind === 'photo' ? '照片' : p.kind === 'text' ? '文字' : '页面'}甩到电脑`,
  },
  {
    id: 'file.print',
    name: '打印文件',
    description: '把一份文件送到打印机（不可逆动作）',
    kind: 'node',
    capabilityChain: ['file.print', 'printer.mock'],
    risk: 'irreversible',
    simulatedFallback: false,
    effects: ['打印出纸', '消耗耗材'],
    params: {
      type: 'object',
      required: ['path'],
      properties: {
        path: str('要打印的文件路径（相对仓库根或绝对路径）'),
        copies: int('份数（1-99，默认 1）', { minimum: 1, maximum: 99, default: 1 }),
      },
    },
    describe: (p) => `打印 ${p.path}${Number(p.copies) > 1 ? ` × ${p.copies} 份` : ''}`,
  },
  {
    id: 'system.volume',
    name: '调节音量',
    description: '把电脑音量调大/调小/静音（P0 为按键级近似实现，绝对音量 P1）',
    kind: 'node',
    capabilityChain: ['system.volume'],
    risk: 'reversible',
    simulatedFallback: true,
    simulatedSummary: (params) => `（模拟）已执行音量动作：${params.action}`,
    effects: ['声音大小变化'],
    params: {
      type: 'object',
      required: ['action'],
      properties: {
        action: str('动作：up | down | mute'),
        steps: int('按键档数（默认 5）', { minimum: 1, maximum: 50, default: 5 }),
      },
    },
    describe: (p) => `音量${p.action === 'up' ? '调大' : p.action === 'down' ? '调小' : '静音'}${p.action === 'mute' ? '' : ` ${Number(p.steps) || 5} 档`}`,
  },
  {
    id: 'app.list',
    name: '读取电脑程序清单',
    description: '让电脑端返回当前可启动的程序清单（供目录/语音匹配）',
    kind: 'node',
    capabilityChain: ['app.list'],
    risk: 'reversible',
    simulatedFallback: false,
    internal: true,
    params: { type: 'object', required: [], properties: {} },
    describe: () => '读取电脑程序清单',
  },
  {
    id: 'tv.on',
    name: '打开电视',
    description: '打开客厅电视（P0 为模拟家庭设备）',
    kind: 'simulated',
    deviceKind: 'tv',
    risk: 'reversible',
    simulatedFallback: true,
    params: { type: 'object', required: [], properties: { deviceId: str('电视设备 id（可选）') } },
    describe: () => '打开客厅电视',
  },
  {
    id: 'tv.off',
    name: '关闭电视',
    description: '关闭客厅电视（P0 为模拟家庭设备）',
    kind: 'simulated',
    deviceKind: 'tv',
    risk: 'reversible',
    simulatedFallback: true,
    params: { type: 'object', required: [], properties: { deviceId: str('电视设备 id（可选）') } },
    describe: () => '关闭客厅电视',
  },
  {
    id: 'light.on',
    name: '开灯',
    description: '打开客厅灯（P0 为模拟家庭设备）',
    kind: 'simulated',
    deviceKind: 'light',
    risk: 'reversible',
    simulatedFallback: true,
    params: { type: 'object', required: [], properties: { room: str('房间（可选，默认客厅）'), deviceId: str('灯设备 id（可选）') } },
    describe: (p) => `打开${p.room || '客厅'}灯`,
  },
  {
    id: 'light.off',
    name: '关灯',
    description: '关闭客厅灯（P0 为模拟家庭设备）',
    kind: 'simulated',
    deviceKind: 'light',
    risk: 'reversible',
    simulatedFallback: true,
    params: { type: 'object', required: [], properties: { room: str('房间（可选，默认客厅）'), deviceId: str('灯设备 id（可选）') } },
    describe: (p) => `关闭${p.room || '客厅'}灯`,
  },
];

const ACTION_MAP = new Map(SUPER_ACTIONS.map((action) => [action.id, action]));
export const PLAN_CAPABILITY_IDS = new Set(SUPER_ACTIONS.filter((a) => !a.internal).map((a) => a.id));

export function getSuperAction(actionId) {
  return ACTION_MAP.get(String(actionId || '')) || null;
}

export function requireSuperAction(actionId) {
  const action = getSuperAction(actionId);
  if (!action) throw httpError(400, `未知动作：${actionId}`);
  return action;
}

export function describeSuperAction(action, params = {}) {
  try {
    return action.describe(params || {}) || action.name;
  } catch {
    return action.name;
  }
}

export function isIrreversible(action) {
  return action.risk === 'irreversible';
}

// 参数校验（与 things 模块同一套轻量 JSON-Schema 口径；AI 输出也走这里兜底）
export function validateSuperParams(action, params) {
  const errors = [];
  if (params === undefined || params === null) return ['缺少参数对象 params'];
  if (typeof params !== 'object' || Array.isArray(params)) return ['params 必须是对象'];
  const schema = action.params || {};
  for (const key of schema.required || []) {
    const v = params[key];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) errors.push(`缺少参数 ${key}`);
  }
  for (const [key, rule] of Object.entries(schema.properties || {})) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    if (rule.type === 'string' && typeof v !== 'string') errors.push(`${key} 必须是字符串`);
    if (rule.type === 'integer') {
      const n = Number(v);
      if (!Number.isInteger(n)) errors.push(`${key} 必须是整数`);
      else {
        if (rule.minimum !== undefined && n < rule.minimum) errors.push(`${key} 不能小于 ${rule.minimum}`);
        if (rule.maximum !== undefined && n > rule.maximum) errors.push(`${key} 不能大于 ${rule.maximum}`);
      }
    }
    if (rule.type === 'boolean' && typeof v !== 'boolean') errors.push(`${key} 必须是布尔值`);
    if (rule.type === 'array' && !Array.isArray(v)) errors.push(`${key} 必须是数组`);
  }
  return errors;
}

// 同一个动作在不同能力上的参数名适配（如 url.open → system.open 用 target 字段）
export function mapParamsForCapability(action, params = {}, capabilityId) {
  const p = { ...(params || {}) };
  if (capabilityId === 'system.open') {
    if (action.id === 'url.open') return { target: p.url, ...(p.fullscreen ? { fullscreen: true } : {}) };
    if (action.id === 'media.show') {
      const target = p.path || p.source;
      return { target: target || '示例空间/样品图/样品01.png' };
    }
    if (action.id === 'app.launch') return { target: p.app, app: p.app };
  }
  if (capabilityId === 'printer.mock') {
    return { file: p.path || p.file, copies: Number(p.copies) || 1 };
  }
  if (capabilityId === 'file.print') {
    return { path: p.path || p.file, copies: Number(p.copies) || 1 };
  }
  if (capabilityId === 'system.volume') {
    return { action: p.action, steps: Number(p.steps) || 5 };
  }
  return p;
}

export function publicAction(action) {
  return {
    id: action.id,
    name: action.name,
    description: action.description,
    kind: action.kind,
    risk: action.risk,
    requiresConfirmation: action.risk === 'irreversible',
    capabilityChain: action.capabilityChain,
    simulatedFallback: !!action.simulatedFallback,
    params: action.params,
  };
}

export default { SUPER_ACTIONS, PLAN_CAPABILITY_IDS, getSuperAction, requireSuperAction, describeSuperAction, validateSuperParams, mapParamsForCapability, isIrreversible, publicAction, SUPER_ACTION_VERSION };