// 榫卯 Tenon v2.3 · 手机遥控服务（Round3 A）
//
// POST /api/v2/remote/:deviceId/input {type,payload}
//   type: mouse | key | media | app（也接受 input.mouse / input.key / input.media / app.launch）
//   - 校验：已绑定电脑（未绑定 403）、设备不存在 404、未知 type 400、离线 409、能力缺失 409
//   - move 类同一设备 50ms 内合并（coalesced），其它动作即时报文
//   - 派发走现有任务队列：append task.drafted + task.queued，node-agent 秒级认领真实执行
// GET  /api/v2/remote/devices            可遥控设备清单（手机页选择目标）
// GET  /api/v2/remote/:deviceId/status   设备在线/绑定/队列/延迟 + 可启动程序
//
// 只 append 现有 task.* 事件（不改 state.js / http.js）；挂载点由 Lead 的 v2/index.js 提供。
import fs from 'node:fs';
import path from 'node:path';
import { replay } from '../state.js';
import { newId } from '../ledger.js';

export const REMOTE_VERSION = '3.0.0';
const MOVE_THROTTLE_MS = 50;
const NODE_ONLINE_MS = 120000;

const TYPE_MAP = {
  mouse: 'input.mouse',
  'input.mouse': 'input.mouse',
  key: 'input.key',
  keyboard: 'input.key',
  'input.key': 'input.key',
  media: 'input.media',
  'input.media': 'input.media',
  app: 'app.launch',
  launch: 'app.launch',
  'app.launch': 'app.launch',
};

const CAP_NAME = {
  'input.mouse': '手机触控板',
  'input.key': '手机键盘',
  'input.media': '媒体/音量键',
  'app.launch': '远程启动程序',
};

const MOUSE_ACTIONS = ['move', 'click', 'down', 'up', 'wheel'];
const MEDIA_ACTIONS = ['play-pause', 'next', 'prev', 'mute', 'vol-up', 'vol-down'];
const KEY_COMBOS = new Set([
  'enter', 'esc', 'escape', 'tab', 'space', 'backspace', 'delete', 'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown', 'ctrl+a', 'ctrl+c', 'ctrl+v', 'ctrl+x', 'ctrl+z', 'ctrl+s',
  'ctrl+w', 'ctrl+shift+esc', 'alt+tab', 'alt+f4', 'win+d', 'win+e', 'win+r',
]);

const RECOMMENDED_APPS = [
  { id: 'wechat', name: '微信', app: '微信' },
  { id: 'chrome', name: 'Chrome', app: 'chrome' },
  { id: 'notepad', name: '记事本', app: 'notepad' },
  { id: 'explorer', name: '资源管理器', app: 'explorer' },
  { id: 'calc', name: '计算器', app: 'calc' },
  { id: 'terminal', name: '终端', app: 'terminal' },
];

function httpError(statusCode, message, code) {
  const err = new Error(message || 'HTTP ' + statusCode);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        return resolve(JSON.parse(raw));
      } catch {
        return reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function onlineOf(node) {
  if (!node) return false;
  const last = node.lastSeen ? new Date(node.lastSeen).getTime() : 0;
  return !!node.online || (last > 0 && Date.now() - last < NODE_ONLINE_MS);
}

export function createRemoteService(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : path.join(root, 'data');
  const bindingsFile = path.join(dataDir, 'devices', 'bindings.json');
  const ledger = opts.ledger || null;
  const seedState = opts.state || null;
  const readOnly = !!opts.readOnly;
  const recent = [];
  const moveState = new Map();

  function currentState() {
    try {
      if (ledger && Array.isArray(ledger.events)) return replay(ledger.events);
    } catch {
      /* replay 失败时退回创建时快照 */
    }
    return seedState || { nodes: {}, tasks: {} };
  }

  function readBindings() {
    const store = readJson(bindingsFile, null);
    return store && store.devices && typeof store.devices === 'object' ? store : { devices: {} };
  }

  function nodeOf(state, deviceId) {
    return (state.nodes && state.nodes[deviceId]) || null;
  }

  function nodeCapabilities(node) {
    return (node && Array.isArray(node.capabilities) ? node.capabilities : []).map((c) => c && c.id).filter(Boolean);
  }

  function resolveTarget(deviceId) {
    const state = currentState();
    const node = nodeOf(state, deviceId);
    if (!node || node.kind === 'hub') throw httpError(404, '设备不存在：' + deviceId, 'DEVICE_NOT_FOUND');
    if (node.disconnected || node.hidden) throw httpError(404, '设备不存在：' + deviceId, 'DEVICE_NOT_FOUND');
    const bindings = readBindings();
    if (!bindings.devices[deviceId]) throw httpError(403, '该设备尚未绑定，请先在「我的设备」一键绑定', 'DEVICE_NOT_BOUND');
    if (!onlineOf(node)) throw httpError(409, '设备离线：' + (node.name || deviceId) + '，请确认 node-agent 在线', 'DEVICE_OFFLINE');
    const caps = nodeCapabilities(node);
    return { state, node, caps, binding: bindings.devices[deviceId] };
  }

  function normalizePayload(capabilityId, payload = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    if (capabilityId === 'input.mouse') {
      const action = String(p.action || 'move').toLowerCase();
      if (!MOUSE_ACTIONS.includes(action)) throw httpError(400, '未知鼠标动作：' + action, 'UNKNOWN_MOUSE_ACTION');
      const out = { action, button: ['left', 'right', 'middle'].includes(String(p.button || 'left')) ? String(p.button || 'left') : 'left' };
      if (action === 'move') {
        const abs = p.x !== undefined || p.y !== undefined;
        if (abs) {
          out.x = clampInt(p.x, 0, 100000);
          out.y = clampInt(p.y, 0, 100000);
          if (out.x == null || out.y == null) throw httpError(400, '绝对移动需要合法 x/y', 'INVALID_MOUSE_POS');
        } else {
          out.dx = clampInt(p.dx, -4000, 4000) || 0;
          out.dy = clampInt(p.dy, -4000, 4000) || 0;
          if (!out.dx && !out.dy) throw httpError(400, 'move 需要 dx/dy 或 x/y', 'INVALID_MOUSE_DELTA');
        }
      } else if (action === 'wheel') {
        out.delta = clampInt(p.delta, -6000, 6000) || 120;
      }
      return out;
    }
    if (capabilityId === 'input.key') {
      const text = p.text !== undefined ? String(p.text) : '';
      const combo = String(p.combo || p.keys || '').toLowerCase().trim();
      if (text && combo) throw httpError(400, 'text 与 combo 只能二选一', 'INVALID_KEY_PAYLOAD');
      if (text) {
        if (text.length > 500) throw httpError(400, 'text 最长 500 字符', 'INVALID_KEY_TEXT');
        return { text };
      }
      if (!combo) throw httpError(400, 'key 需要 text 或 combo', 'INVALID_KEY_PAYLOAD');
      if (!KEY_COMBOS.has(combo)) throw httpError(400, '不支持的组合键：' + combo, 'UNKNOWN_COMBO');
      return { combo };
    }
    if (capabilityId === 'input.media') {
      const action = String(p.action || '').toLowerCase();
      if (!MEDIA_ACTIONS.includes(action)) throw httpError(400, '未知媒体动作：' + (action || '（空）'), 'UNKNOWN_MEDIA_ACTION');
      const out = { action };
      const steps = clampInt(p.steps, 1, 20);
      if (steps) out.steps = steps;
      return out;
    }
    if (capabilityId === 'app.launch') {
      const app = String(p.app || p.name || '').trim();
      if (!app) throw httpError(400, '缺少 app（如 微信 / chrome / notepad）', 'INVALID_APP');
      if (app.length > 80) throw httpError(400, 'app 名称过长', 'INVALID_APP');
      if (!/^[\w\u4e00-\u9fa5 .:\/\\-]+$/.test(app)) throw httpError(400, 'app 名称包含非法字符', 'INVALID_APP');
      const out = { app };
      if (Array.isArray(p.args) && p.args.length) out.args = p.args.slice(0, 5).map((a) => String(a).slice(0, 200));
      return out;
    }
    throw httpError(400, '未知 type', 'UNKNOWN_TYPE');
  }

  function summaryOf(capabilityId, payload) {
    if (capabilityId === 'input.mouse') {
      if (payload.action === 'move') return payload.x != null ? `手机触控板：移动到 ${payload.x},${payload.y}` : `手机触控板：相对移动 ${payload.dx},${payload.dy}`;
      if (payload.action === 'wheel') return `手机触控板：滚轮 ${payload.delta}`;
      return `手机触控板：${payload.action}（${payload.button || 'left'}）`;
    }
    if (capabilityId === 'input.key') return payload.text ? `手机键盘：输入 ${String(payload.text).slice(0, 30)}` : `手机键盘：组合键 ${payload.combo}`;
    if (capabilityId === 'input.media') return '手机遥控：媒体键 ' + payload.action;
    return '手机遥控：打开程序 ' + (payload.app || '');
  }

  function dispatch(deviceId, capabilityId, payload, { by = '手机', coalesced = false, moveAt = null } = {}) {
    const taskId = newId('task');
    const label = summaryOf(capabilityId, payload);
    const draft = {
      summary: label,
      capabilities: [{ id: capabilityId, name: CAP_NAME[capabilityId] || capabilityId, risk: 'reversible', manualOnly: false, version: REMOTE_VERSION, evidence: 'confirmed' }],
      targetDevice: { id: deviceId, name: (currentState().nodes[deviceId] || {}).name || deviceId },
      params: payload,
      risk: { level: 'reversible', reasons: [] },
      missing: [],
    };
    const at = new Date().toISOString();
    if (ledger && typeof ledger.append === 'function') {
      ledger.append('task.drafted', {
        taskId,
        text: '手机遥控：' + label,
        draft,
        requester: by,
        source: 'remote',
        evidenceLevel: 'certain',
        ai: { provider: 'rule', fallback: true },
      }, 'remote');
      ledger.append('task.queued', { taskId, nodeId: deviceId, note: '手机遥控即时派发，等待电脑接单' }, 'remote');
    }
    const entry = { taskId, deviceId, capabilityId, payload, at, coalesced, moveAt };
    recent.unshift(entry);
    if (recent.length > 40) recent.length = 40;
    return { ok: true, queued: true, taskId, deviceId, type: capabilityId, summary: label, at, coalesced };
  }

  function flushMove(deviceId) {
    const st = moveState.get(deviceId);
    if (!st || !st.pending) return;
    const pending = st.pending;
    st.pending = null;
    st.timer = null;
    st.lastAt = Date.now();
    try {
      const payload = pending.abs
        ? { action: 'move', x: pending.x, y: pending.y }
        : { action: 'move', dx: pending.dx, dy: pending.dy };
      if (!pending.abs && !payload.dx && !payload.dy) return;
      dispatch(deviceId, 'input.mouse', payload, { coalesced: true, moveAt: pending.firstAt });
    } catch (err) {
      // 合帧失败不抛给调用方；下一次 move 会重新累积
      st.pending = null;
    }
  }

  function dispatchInput(deviceId, type, payload) {
    if (readOnly) throw httpError(423, '另一窗口为只读，遥控已暂停', 'READ_ONLY');
    const capabilityId = TYPE_MAP[String(type || '').toLowerCase()];
    if (!capabilityId) throw httpError(400, '未知遥控类型：' + type + '（支持 mouse/key/media/app）', 'UNKNOWN_TYPE');
    const target = resolveTarget(deviceId);
    if (!target.caps.includes(capabilityId)) {
      throw httpError(409, '目标电脑还没有「' + (CAP_NAME[capabilityId] || capabilityId) + '」能力：请升级/重启电脑端 node-agent', 'CAPABILITY_MISSING');
    }
    const normalized = normalizePayload(capabilityId, payload || {});
    // move 50ms 合并：同一设备窗口内的移动累积，定时器到点统一派发一次
    if (capabilityId === 'input.mouse' && normalized.action === 'move') {
      const now = Date.now();
      let st = moveState.get(deviceId);
      if (!st) {
        st = { lastAt: 0, pending: null, timer: null };
        moveState.set(deviceId, st);
      }
      const elapsed = now - st.lastAt;
      if (st.pending || elapsed < MOVE_THROTTLE_MS) {
        const abs = normalized.x !== undefined;
        if (!st.pending) st.pending = { abs, dx: 0, dy: 0, x: normalized.x, y: normalized.y, firstAt: now };
        if (abs) {
          st.pending.abs = true;
          st.pending.x = normalized.x;
          st.pending.y = normalized.y;
        } else {
          st.pending.dx += normalized.dx || 0;
          st.pending.dy += normalized.dy || 0;
        }
        if (!st.timer) st.timer = setTimeout(() => flushMove(deviceId), Math.max(10, MOVE_THROTTLE_MS - elapsed));
        if (st.timer.unref) st.timer.unref();
        return { ok: true, queued: true, coalesced: true, deviceId, type: capabilityId, summary: '触控板移动已合并（50ms 节流）', at: new Date().toISOString() };
      }
      st.lastAt = now;
      return dispatch(deviceId, capabilityId, normalized, { moveAt: now });
    }
    return dispatch(deviceId, capabilityId, normalized);
  }

  function listDevices() {
    const state = currentState();
    const bindings = readBindings();
    const out = [];
    for (const node of Object.values(state.nodes || {})) {
      if (!node || node.kind === 'hub' || node.disconnected || node.hidden) continue;
      const caps = nodeCapabilities(node);
      if (!caps.includes('input.mouse') && !caps.includes('input.key') && !caps.includes('app.launch')) continue;
      out.push({
        id: node.id,
        name: node.name || node.id,
        platform: node.platform || 'unknown',
        online: onlineOf(node),
        bound: !!bindings.devices[node.id],
        capabilities: caps.filter((id) => TYPE_MAP[id] || id === 'app.launch'),
        programs: caps.includes('app.launch') ? RECOMMENDED_APPS : [],
      });
    }
    return { ok: true, devices: out, recommendedApps: RECOMMENDED_APPS, version: REMOTE_VERSION };
  }

  function status(deviceId) {
    const state = currentState();
    const node = nodeOf(state, deviceId);
    if (!node) throw httpError(404, '设备不存在：' + deviceId, 'DEVICE_NOT_FOUND');
    const bindings = readBindings();
    const caps = nodeCapabilities(node);
    const tasks = Object.values(state.tasks || {});
    const remoteTasks = tasks
      .filter((t) => String(t.nodeId || '') === String(deviceId) && /^input\./.test(String(t.capabilityId || (t.draft && t.draft.capabilities && t.draft.capabilities[0] && t.draft.capabilities[0].id) || '')))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
      .slice(0, 6)
      .map((t) => ({
        taskId: t.id,
        capabilityId: t.capabilityId || (t.draft && t.draft.capabilities && t.draft.capabilities[0] && t.draft.capabilities[0].id),
        status: t.status,
        updatedAt: t.updatedAt,
        startedAt: t.startedAt || null,
        summary: (t.result && t.result.summary) || (t.draft && t.draft.summary) || '',
      }));
    const lastLocal = recent.find((r) => String(r.deviceId) === String(deviceId));
    const lastTask = remoteTasks.find((t) => t.taskId === (lastLocal && lastLocal.taskId)) || remoteTasks[0] || null;
    let latencyMs = null;
    if (lastLocal && lastTask && lastTask.startedAt) latencyMs = Math.max(0, new Date(lastTask.startedAt).getTime() - new Date(lastLocal.at).getTime());
    return {
      ok: true,
      version: REMOTE_VERSION,
      device: {
        id: node.id,
        name: node.name || node.id,
        platform: node.platform || 'unknown',
        online: onlineOf(node),
        bound: !!bindings.devices[node.id],
        capabilities: caps.filter((id) => TYPE_MAP[id] || id === 'app.launch'),
        programs: caps.includes('app.launch') ? RECOMMENDED_APPS : [],
      },
      latencyMs,
      queue: remoteTasks,
      lastDispatch: lastLocal || null,
      throttled: { moveWindowMs: MOVE_THROTTLE_MS },
      at: new Date().toISOString(),
    };
  }

  const service = {
    root,
    dataDir,
    readOnly,
    version: REMOTE_VERSION,
    dispatchInput,
    listDevices,
    status,
    recent: () => recent.slice(0, 20),
    RECOMMENDED_APPS,
    routes: [],
  };
  service.routes = createRemoteRoutes(service);
  return service;
}

function wrap(fn) {
  return async function handler(req, res, ctx) {
    try {
      await fn(req, res, ctx || {});
    } catch (err) {
      const code = Number(err && err.statusCode) || 500;
      if (!res.headersSent) sendJson(res, code, { ok: false, error: String((err && err.message) || err), code: err && err.code });
      else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  };
}

function paramsOf(ctx, req) {
  if (ctx && ctx.params && typeof ctx.params === 'object') return ctx.params;
  try {
    const url = new URL(req.url, 'http://placeholder');
    const m = url.pathname.match(/^\/api\/v2\/remote\/([^/]+)(?:\/(input|command|status))?$/);
    return m ? { deviceId: decodeURIComponent(m[1]), action: m[2] } : {};
  } catch {
    return {};
  }
}

function requireAuth(service, req, ctx) {
  if (service.readOnly) throw httpError(423, '另一窗口为只读，遥控已暂停', 'READ_ONLY');
  const ok = (ctx && typeof ctx.authed === 'function' && ctx.authed(req))
    || (service.tokens && req.headers && service.tokens.operatorToken && String(req.headers['x-tenon-token'] || '') === String(service.tokens.operatorToken));
  if (!ok) throw httpError(401, '遥控需要操作令牌', 'NEED_OPERATOR_TOKEN');
}

export function createRemoteRoutes(service) {
  return [
    {
      method: 'GET',
      path: '/api/v2/remote/devices',
      handler: wrap(async (req, res) => {
        sendJson(res, 200, service.listDevices());
      }),
    },
    {
      method: 'GET',
      path: '/api/v2/remote/:deviceId/status',
      handler: wrap(async (req, res, ctx) => {
        const params = paramsOf(ctx, req);
        sendJson(res, 200, service.status(params.deviceId));
      }),
    },
    {
      method: 'POST',
      path: '/api/v2/remote/:deviceId/input',
      handler: wrap(async (req, res, ctx) => {
        requireAuth(service, req, ctx);
        const params = paramsOf(ctx, req);
        const body = await readBody(req);
        sendJson(res, 200, service.dispatchInput(params.deviceId, body.type, body.payload || body.params || {}));
      }),
    },
    {
      method: 'POST',
      path: '/api/v2/remote/:deviceId/command',
      handler: wrap(async (req, res, ctx) => {
        requireAuth(service, req, ctx);
        const params = paramsOf(ctx, req);
        const body = await readBody(req);
        const type = body.action === 'launch' || body.app ? 'app' : body.type;
        sendJson(res, 200, service.dispatchInput(params.deviceId, type, body.payload || body || {}));
      }),
    },
  ];
}

export const ROUTES = [
  { method: 'GET', path: '/api/v2/remote/devices' },
  { method: 'GET', path: '/api/v2/remote/:deviceId/status' },
  { method: 'POST', path: '/api/v2/remote/:deviceId/input' },
  { method: 'POST', path: '/api/v2/remote/:deviceId/command' },
];

export default createRemoteService;