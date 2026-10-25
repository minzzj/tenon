// 榫卯 Tenon v2 · 内置动作（物模型 → 现有能力的统一映射）
//
// 设计原则：
// 1) 每个动作 = 一个能力（capabilityId）+ 一套参数 schema + 风险级别 + 执行位置（node/hub）；
// 2) node 动作优先派发给拥有对应能力、且在线/授权有效的设备（node-agent 认领执行）；
//    设备不在线或能力未就绪时，按 fallback 降级为「中枢本机执行 / 模拟通道」，并在结果里写明降级原因，不假装成功；
// 3) hub 动作（备份、通知）在中枢进程内直接执行，同样写 task.* 事件，复用现有任务引擎的事件语义与时间线。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../ledger.js';
import { taskLink } from '../tasks.js';
import { httpError } from './errors.js';

export const ACTIONS_VERSION = '2.0.0';

// 中枢自己就能执行的能力（不需要 node-agent 认领）
export const HUB_CAPABILITIES = new Set(['asset.backup', 'channel.notify']);

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });

export function resolveFromRoot(root, value) {
  const raw = String(value || '').trim();
  if (!raw) throw httpError(400, '路径参数为空');
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
}

export function displayPath(root, value) {
  const abs = resolveFromRoot(root, value);
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

export function sha256File(abs) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(abs));
  return hash.digest('hex');
}

function outboxDir(dataDir) {
  const dir = path.join(dataDir, 'things', 'outbox');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEvidence(dataDir, name, payload) {
  const file = path.join(outboxDir(dataDir), name);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return file;
}

// ---------- 内置动作定义 ----------
// 字段：
//   id / name / description：动作标识与中文名
//   capabilityId：映射到的能力 id（v0.1 已存在：printer.mock / channel.notify；v2 新增：system.open / asset.backup）
//   mode：'node' 需节点执行；'hub' 中枢本机执行
//   risk：'reversible' | 'irreversible'（不可逆动作执行前必须确认）
//   fallback：node 动作没有可用设备时的降级方式：'hub'（本机执行）/ 'simulate'（模拟通道）
//   params：JSON-Schema 风格参数定义（required/properties/minimum/maximum/default）
//   describe(params)：生成人类可读的一行说明（写进任务时间线与界面）
//   hubRun(ctx)：中枢本机/模拟执行实现，返回 { summary, items, partial, simulated?, evidence? }
export const ACTIONS = [
  {
    id: 'asset.print',
    name: '打印素材',
    description: '把一张图片/文件送到打印机（v0.1 为 printer.mock 模拟打印单，写本地 outbox）',
    capabilityId: 'printer.mock',
    mode: 'node',
    risk: 'irreversible',
    fallback: 'simulate',
    effects: ['出纸', '消耗耗材'],
    params: {
      type: 'object',
      required: ['file'],
      properties: {
        file: str('要打印的文件标识（如 示例空间/样品图/01.png）'),
        copies: int('份数（1-99，默认 1）', { minimum: 1, maximum: 99, default: 1 }),
        targetDeviceId: str('指定打印机设备 id（可选，默认自动选在线打印机）'),
      },
    },
    describe: (params) => `打印 ${String((params && params.file) || '')} × ${Number((params && params.copies) || 1)} 份`,
    hubRun: (ctx) => {
      // 没有可用打印机时的模拟通道：写打印任务单 JSON，明确标注未连接真实打印机
      const copies = Number(ctx.params.copies || 1);
      const payload = {
        taskId: ctx.taskId,
        actionId: 'asset.print',
        file: ctx.params.file,
        copies,
        simulated: true,
        degradedReason: ctx.degradedReason || null,
        note: '没有可用打印机设备：已记录打印任务单（模拟通道，未连接真实打印机）',
        at: new Date().toISOString(),
      };
      const file = writeEvidence(ctx.dataDir, `print-${ctx.taskId}.json`, payload);
      return {
        summary: `已记录模拟打印：${ctx.params.file} × ${copies} 份（模拟通道，未连接真实打印机）`,
        items: [{ name: path.basename(file), ok: true, detail: path.relative(ctx.root, file) }],
        partial: false,
        simulated: true,
      };
    },
  },
  {
    id: 'asset.showOnDesktop',
    name: '投屏到电脑',
    description: '在电脑上打开一张图片/文件（优先走 node-agent system.open；未就绪时本机打开）',
    capabilityId: 'system.open',
    mode: 'node',
    risk: 'reversible',
    fallback: 'hub',
    effects: ['电脑上弹出窗口'],
    params: {
      type: 'object',
      required: ['path'],
      properties: {
        path: str('要在电脑上打开的文件路径（相对仓库根或绝对路径）'),
        targetDeviceId: str('指定电脑设备 id（可选，默认自动选在线电脑）'),
      },
    },
    describe: (params) => `在电脑打开 ${String((params && params.path) || '')}`,
    hubRun: async (ctx) => {
      const abs = resolveFromRoot(ctx.root, ctx.params.path);
      if (!fs.existsSync(abs)) throw httpError(400, `文件不存在：${displayPath(ctx.root, ctx.params.path)}`);
      if (fs.statSync(abs).isDirectory()) throw httpError(400, `暂不支持打开目录：${displayPath(ctx.root, ctx.params.path)}`);
      let opened = false;
      if (typeof ctx.opener === 'function') {
        await ctx.opener(abs);
        opened = true;
      }
      const file = writeEvidence(ctx.dataDir, `open-${ctx.taskId}.json`, {
        taskId: ctx.taskId,
        actionId: 'asset.showOnDesktop',
        path: displayPath(ctx.root, ctx.params.path),
        openedBy: opened ? 'opener' : 'record-only',
        degradedReason: ctx.degradedReason || null,
        at: new Date().toISOString(),
      });
      return {
        summary: opened
          ? `已在电脑打开：${displayPath(ctx.root, ctx.params.path)}`
          : `已记录打开请求：${displayPath(ctx.root, ctx.params.path)}（未注入 opener，仅留痕）`,
        items: [{ name: path.basename(abs), ok: true, detail: opened ? '已调用本机打开器' : '已留痕（open-outbox）' }],
        partial: false,
        evidence: { file: path.relative(ctx.root, file) },
      };
    },
  },
  {
    id: 'asset.backup',
    name: '备份到文件夹',
    description: '把素材真实复制到指定文件夹 / NAS 挂载路径，并校验 SHA-256 一致（中枢本机执行）',
    capabilityId: 'asset.backup',
    mode: 'hub',
    risk: 'reversible',
    fallback: null,
    effects: ['写入目标目录'],
    params: {
      type: 'object',
      required: ['src', 'dir'],
      properties: {
        src: str('要备份的源文件路径（相对仓库根或绝对路径）'),
        dir: str('目标目录（NAS 挂载路径 / 备份文件夹，不存在会自动创建）'),
        name: str('目标文件名（可选，默认沿用源文件名）'),
      },
    },
    describe: (params) => `备份 ${String((params && params.src) || '')} → ${String((params && params.dir) || '')}`,
    hubRun: (ctx) => {
      const srcAbs = resolveFromRoot(ctx.root, ctx.params.src);
      if (!fs.existsSync(srcAbs)) throw httpError(400, `源文件不存在：${displayPath(ctx.root, ctx.params.src)}`);
      if (!fs.statSync(srcAbs).isFile()) throw httpError(400, `源路径不是普通文件：${displayPath(ctx.root, ctx.params.src)}`);
      const dirAbs = resolveFromRoot(ctx.root, ctx.params.dir);
      const destName = String(ctx.params.name || path.basename(srcAbs));
      const destAbs = path.join(dirAbs, destName);
      if (path.resolve(destAbs) === path.resolve(srcAbs)) throw httpError(400, '目标路径与源文件相同，拒绝覆盖自身');
      fs.mkdirSync(dirAbs, { recursive: true });
      fs.copyFileSync(srcAbs, destAbs);
      const srcHash = sha256File(srcAbs);
      const destHash = sha256File(destAbs);
      if (srcHash !== destHash) throw httpError(500, '备份后校验失败：SHA-256 不一致');
      const srcRel = displayPath(ctx.root, ctx.params.src);
      const destRel = displayPath(ctx.root, ctx.params.dir);
      return {
        summary: `已备份 ${srcRel} → ${destRel}（SHA-256 一致）`,
        items: [
          { name: destName, ok: true, detail: `sha256=${destHash}` },
          { name: '来源', ok: true, detail: `src=${srcRel}` },
        ],
        partial: false,
        evidence: { srcSha256: srcHash, destSha256: destHash, dest: destAbs },
      };
    },
  },
  {
    id: 'system.open',
    name: '打开应用/文件',
    description: '在指定电脑上打开应用或文件（node-agent v2 动作；当前 node-agent 未就绪时降级为记录打开意图）',
    capabilityId: 'system.open',
    mode: 'node',
    risk: 'reversible',
    fallback: 'simulate',
    effects: ['启动应用', '弹出窗口'],
    params: {
      type: 'object',
      required: ['target'],
      properties: {
        target: str('要打开的应用名 / 文件路径 / URL'),
        args: { type: 'array', description: '附加参数（可选）', items: { type: 'string' } },
        targetDeviceId: str('指定执行设备 id（可选）'),
      },
    },
    describe: (params) => `打开 ${String((params && params.target) || '')}`,
    hubRun: (ctx) => {
      const file = writeEvidence(ctx.dataDir, `openapp-${ctx.taskId}.json`, {
        taskId: ctx.taskId,
        actionId: 'system.open',
        target: ctx.params.target,
        args: ctx.params.args || [],
        simulated: true,
        degradedReason: ctx.degradedReason || 'node-agent 的 system.open 能力尚未就绪（v2 P0 由 desktop-agent 任务交付）',
        at: new Date().toISOString(),
      });
      return {
        summary: `node-agent system.open 未就绪：已记录打开意图（${ctx.params.target}），未实际启动应用`,
        items: [{ name: path.basename(file), ok: true, detail: '模拟通道：打开意图已留痕' }],
        partial: false,
        simulated: true,
      };
    },
  },
  {
    id: 'channel.notify',
    name: '发送摘要通知',
    description: '把场景执行摘要发到消息通道（v0.1 为模拟通道，只发摘要+链接，正文不出内网）',
    capabilityId: 'channel.notify',
    mode: 'hub',
    risk: 'irreversible',
    fallback: null,
    effects: ['对外发送消息'],
    params: {
      type: 'object',
      required: ['group'],
      properties: {
        group: str('目标群/频道名（如 工作群）'),
        summary: str('摘要内容（可选，默认使用场景名与执行时间）'),
      },
    },
    describe: (params) => `发送摘要到 ${String((params && params.group) || '')}`,
    hubRun: (ctx) => {
      const group = String(ctx.params.group || '工作群');
      const summary = String(ctx.params.summary || `${ctx.scene.name}：${ctx.action.name}`).slice(0, 200);
      const messageId = newId('msg');
      ctx.ledger.append('message.inbox', {
        messageId,
        taskId: ctx.taskId,
        channel: 'wechat-mock',
        channelLabel: '微信（模拟通道）',
        title: `场景通知 · ${group}`,
        summary,
        link: taskLink(ctx.taskId),
        status: 'delivered',
        sensitive: true,
      }, 'hub');
      return {
        summary: `已发送场景摘要到 ${group}（模拟通道，只发摘要+链接）`,
        items: [{ name: group, ok: true, detail: `messageId=${messageId}` }],
        partial: false,
      };
    },
  },
];

const ACTION_MAP = new Map(ACTIONS.map((action) => [action.id, action]));

export function getActionDef(actionId) {
  return ACTION_MAP.get(String(actionId || '')) || null;
}

export function requireActionDef(actionId) {
  const action = getActionDef(actionId);
  if (!action) throw httpError(400, `未知动作：${actionId}`);
  return action;
}

// ---------- 能力 / 设备解析 ----------
function capabilityUsable(node, cap) {
  if (!cap) return false;
  if (cap.compatible === false) return false;
  if (cap.authExpired) return false;
  if (cap.authExpiresAt && new Date(cap.authExpiresAt) < new Date()) return false;
  return true;
}

export function candidateDevices(state, capabilityId) {
  const out = [];
  for (const node of Object.values((state && state.nodes) || {})) {
    if (!node || node.disconnected || node.hidden) continue;
    if (node.id === 'hub') continue;
    const cap = (node.capabilities || []).find((c) => c && c.id === capabilityId);
    if (!capabilityUsable(node, cap)) continue;
    out.push({ node, cap });
  }
  // 在线设备优先
  return out.sort((a, b) => Number(!!b.node.online) - Number(!!a.node.online));
}

function fallbackTarget(action, reason) {
  if (!action.fallback) return null;
  return {
    mode: 'hub',
    targetDeviceId: 'hub',
    targetDeviceName: action.fallback === 'simulate' ? '本机中枢（模拟通道）' : '本机中枢（降级）',
    capabilityId: action.capabilityId,
    degradedReason: reason,
    degraded: true,
  };
}

// 把场景步骤解析成「谁来执行」：node 设备 / 中枢本机（含降级）
export function resolveStepTarget(action, state, step = {}) {
  if (action.mode === 'hub') {
    return { mode: 'hub', targetDeviceId: 'hub', targetDeviceName: '本机中枢', capabilityId: action.capabilityId, degradedReason: null, degraded: false };
  }
  const candidates = candidateDevices(state, action.capabilityId);
  let pick = null;
  if (step.targetDeviceId) {
    pick = candidates.find((c) => c.node.id === step.targetDeviceId) || null;
    if (!pick) {
      const fallback = fallbackTarget(action, `设备 ${step.targetDeviceId} 没有可用的 ${action.capabilityId} 能力`);
      if (fallback) return fallback;
      throw httpError(400, `设备 ${step.targetDeviceId} 没有可用的 ${action.capabilityId} 能力`);
    }
  } else {
    pick = candidates.find((c) => c.node.online) || candidates[0] || null;
  }
  if (!pick) {
    const fallback = fallbackTarget(action, `没有可用的 ${action.capabilityId} 设备`);
    if (fallback) return fallback;
    throw httpError(503, `没有可用的 ${action.capabilityId} 设备，动作「${action.name}」无法执行`);
  }
  if (!pick.node.online) {
    const fallback = fallbackTarget(action, `${pick.node.name} 当前离线`);
    if (fallback) return fallback;
    throw httpError(503, `${pick.node.name} 当前离线，动作「${action.name}」无法执行`);
  }
  return { mode: 'node', targetDeviceId: pick.node.id, targetDeviceName: pick.node.name, capabilityId: action.capabilityId, degradedReason: null, degraded: false };
}

// ---------- 参数校验 ----------
export function validateActionParams(action, params) {
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
    if (rule.type === 'array' && !Array.isArray(v)) errors.push(`${key} 必须是数组`);
  }
  return errors;
}

export function describeAction(action, params) {
  try {
    return action.describe(params || {});
  } catch {
    return action.name;
  }
}

// ---------- 动作目录（给物模型 / 场景 UI 用） ----------
export function listActions(state) {
  const devices = Object.values((state && state.nodes) || {}).filter((n) => n && !n.hidden && n.id !== 'hub');
  return ACTIONS.map((action) => {
    const targets = action.mode === 'hub'
      ? [{ deviceId: 'hub', name: '本机中枢', online: true, evidence: 'confirmed', available: true }]
      : candidateDevices(state, action.capabilityId).map(({ node }) => ({
          deviceId: node.id,
          name: node.name,
          online: !!node.online,
          evidence: node.evidence || 'declared',
          available: !!node.online,
        }));
    const onlineTargets = targets.filter((t) => t.online);
    let availableAs = 'none';
    if (action.mode === 'hub') availableAs = 'hub';
    else if (onlineTargets.length) availableAs = 'node';
    else if (action.fallback === 'hub') availableAs = 'hub-fallback';
    else if (action.fallback === 'simulate') availableAs = 'simulate';
    return {
      id: action.id,
      name: action.name,
      description: action.description,
      capabilityId: action.capabilityId,
      mode: action.mode,
      risk: action.risk,
      requiresConfirmation: action.risk === 'irreversible',
      fallback: action.fallback || null,
      available: availableAs !== 'none',
      availableAs,
      params: action.params,
      effects: action.effects || [],
      targetDevices: targets,
      deviceCount: devices.length,
    };
  });
}

export default { ACTIONS, getActionDef, requireActionDef, listActions, resolveStepTarget, validateActionParams, describeAction, HUB_CAPABILITIES };