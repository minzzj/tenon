// 榫卯 Tenon v2 · 物模型（Thing Model）
//
// 把 v0.1 起就在 state.nodes 里的「节点 + 能力 manifest」统一映射成三段式物模型：
//   properties 属性：在线、平台、证据等级、授权状态、能力列表……
//   actions    动作：内置动作（asset.print / asset.showOnDesktop / asset.backup / system.open / channel.notify）
//                     + 设备能力动作（cap:<capabilityId>，按节点能力清单自动生成，含 risk 与参数 schema）
//   events     事件：动作执行 / 设备离线 / 授权过期 / 场景定义与执行等，均来自账本事件（可审计）
// 输出是纯只读快照，不写账本、不碰文件。
import { listActions } from './actions.js';

export const THINGS_MODEL_VERSION = '2.0.0';

// 物模型对外声明的事件类型（新事件只登记，不在这里 append；写入由各模块负责）
export const THING_EVENTS = [
  { type: 'scene.defined', since: 'v2', description: '场景已定义/更新：sceneId,name,steps' },
  { type: 'scene.ran', since: 'v2', description: '场景已执行：sceneId,by,result（含每个步骤的任务 id 与摘要）' },
  { type: 'task.drafted', since: 'v1', description: '动作已生成任务草案（含风险级别与目标设备）' },
  { type: 'task.confirmed', since: 'v1', description: '不可逆动作被人工确认' },
  { type: 'task.queued', since: 'v1', description: '任务已派发到目标设备，等待认领' },
  { type: 'task.started', since: 'v1', description: '目标设备接单开始执行' },
  { type: 'task.step', since: 'v1', description: '执行过程步骤（每一步都有证据）' },
  { type: 'task.succeeded', since: 'v1', description: '动作执行成功（含结果与证据）' },
  { type: 'task.failed', since: 'v1', description: '动作执行失败（保留现场与原因）' },
  { type: 'task.needsConfirm', since: 'v1', description: '任务降级为待确认（设备断开等）' },
  { type: 'message.inbox', since: 'v1', description: '摘要通知已投递到站内收件箱（模拟通道）' },
  { type: 'node.registered', since: 'v1', description: '节点注册，上报能力 manifest' },
  { type: 'node.heartbeat', since: 'v1', description: '节点心跳（在线判定）' },
  { type: 'node.offline', since: 'v1', description: '节点离线' },
  { type: 'device.disconnected', since: 'v1', description: '设备被断开（引用任务降级待确认）' },
  { type: 'capability.authExpired', since: 'v1', description: '能力授权过期（相关任务暂停）' },
  { type: 'capability.versionMismatch', since: 'v1', description: '能力版本不兼容' },
  { type: 'audit.exported', since: 'v1', description: '审计导出（审计本身也留痕）' },
];

function property(type, value, description, extra = {}) {
  return { type, value, description, ...extra };
}

function parseInputLabel(input) {
  const raw = String(input || '').trim();
  const match = raw.match(/^([A-Za-z][\w.]*)[（(](.*)[）)]$/);
  if (match) return { name: match[1], description: match[2] };
  return { name: raw, description: raw };
}

// 把节点能力清单里的 inputs 描述转换成参数 schema（能力自带的是人读描述，不是严格 JSON Schema）
export function paramsSchemaFromInputs(inputs) {
  const properties = {};
  const required = [];
  for (const input of inputs || []) {
    const { name, description } = parseInputLabel(input);
    properties[name] = { type: 'string', description, source: 'capability-manifest' };
    required.push(name);
  }
  return { type: 'object', required, properties };
}

export function capabilityAction(node, cap) {
  const risk = cap.risk === 'irreversible' ? 'irreversible' : 'reversible';
  const authExpired = !!cap.authExpired || (cap.authExpiresAt ? new Date(cap.authExpiresAt) < new Date() : false);
  return {
    actionId: `cap:${cap.id}`,
    capabilityId: cap.id,
    source: 'capability',
    name: cap.name || cap.id,
    description: cap.evidence ? `设备能力（证据：${cap.evidence}）` : '设备能力',
    mode: 'node',
    risk,
    requiresConfirmation: risk === 'irreversible',
    manualOnly: !!cap.manualOnly,
    version: cap.version || null,
    authExpired,
    compatible: cap.compatible !== false,
    targetDevice: { deviceId: node.id, name: node.name, online: !!node.online },
    params: paramsSchemaFromInputs(cap.inputs),
  };
}

export function deviceModel(node) {
  const capabilities = node.capabilities || [];
  const authExpiredCaps = capabilities.filter((c) => c && (c.authExpired || (c.authExpiresAt && new Date(c.authExpiresAt) < new Date()))).map((c) => c.id);
  return {
    deviceId: node.id,
    name: node.name || node.id,
    platform: node.platform || 'unknown',
    kind: node.kind || 'node',
    online: !!node.online,
    evidence: node.evidence || 'declared',
    domain: node.domain || null,
    disconnected: !!node.disconnected,
    hidden: !!node.hidden,
    properties: {
      online: property('boolean', !!node.online, '是否在线（心跳判定）'),
      platform: property('string', node.platform || 'unknown', '平台 / 形态'),
      evidence: property('string', node.evidence || 'declared', '证据等级：confirmed / declared / none'),
      authorization: property('string', authExpiredCaps.length ? 'expired' : 'valid', '能力授权状态（是否有过期能力）'),
      capabilityCount: property('integer', capabilities.filter((c) => !c.authExpired).length, '可用能力数量'),
      capabilities: property('array', capabilities.map((c) => c.id), '能力 manifest（节点上报）'),
      lastSeen: property('string', node.lastSeen || null, '最近心跳时间'),
      registeredAt: property('string', node.registeredAt || null, '注册时间'),
    },
    actions: capabilities.filter(Boolean).map((cap) => capabilityAction(node, cap)),
    events: ['task.started', 'task.step', 'task.succeeded', 'task.failed', 'device.disconnected', 'capability.authExpired', 'capability.versionMismatch'],
  };
}

export function buildThingModel(state, options = {}) {
  const nodes = Object.values((state && state.nodes) || {}).filter((n) => n && !n.hidden);
  const devices = nodes.map(deviceModel);
  const online = devices.filter((d) => d.online);
  // 能力级动作（跨设备平铺，便于「这件事哪台设备能做」检索）
  const capabilityActions = devices.flatMap((d) => d.actions.map((a) => ({ ...a, deviceId: d.deviceId, deviceName: d.name, deviceOnline: d.online })));
  return {
    schema: 'tenon-things',
    version: THINGS_MODEL_VERSION,
    generatedAt: new Date().toISOString(),
    hub: {
      mode: (state && state.meta && state.meta.mode) || 'solo',
      domain: (state && state.meta && state.meta.domain) || null,
      domainLabel: (state && state.meta && state.meta.domainLabel) || null,
      dataAsOf: (state && state.dataAsOf) || null,
    },
    counts: {
      devices: devices.length,
      onlineDevices: online.length,
      capabilities: capabilityActions.length,
      builtinActions: listActions(state).length,
    },
    // 动作目录：内置动作（含 risk / 参数 schema / 目标设备 / 可用性）+ 设备能力动作
    actions: listActions(state),
    capabilityActions,
    devices,
    events: THING_EVENTS,
  };
}

export default { THINGS_MODEL_VERSION, THING_EVENTS, buildThingModel, deviceModel, capabilityAction, paramsSchemaFromInputs };