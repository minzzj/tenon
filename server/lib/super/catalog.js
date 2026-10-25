// 榫卯 Tenon v2.1 · 设备 + 程序目录（消费者视角的"家里有什么、能做什么"）
//
// 合并三类来源：
//   1) state.nodes —— 真实注册的设备（电脑 / 手机 / 电视 / 音箱 / 打印机 / NAS…）
//   2) 内置程序清单 —— 微信 / Chrome / 记事本 / 资源管理器 / 计算器 / 音乐 / 照片 / 打印
//   3) 模拟家庭设备 —— 客厅电视 / 客厅音箱 / 客厅灯（P0 未接真机，明确标 simulated:true，不假装真实设备）
// 若电脑端注册了 app.list 能力，可把电脑上报的真实程序清单合并进 programs（见 appsByNode / appListNodes）。
import { SUPER_ACTIONS, getSuperAction, publicAction } from './actions.js';

export const DESKTOP_PROGRAMS = [
  { id: 'wechat', name: '微信', app: '微信', keywords: ['微信', 'wechat'], emoji: '💬', capabilityChain: ['app.launch'] },
  { id: 'chrome', name: 'Chrome', app: 'chrome', keywords: ['chrome', '谷歌浏览器', '浏览器'], emoji: '🌐', capabilityChain: ['app.launch'] },
  { id: 'notepad', name: '记事本', app: 'notepad', keywords: ['记事本', 'notepad', '文本编辑器'], emoji: '📝', capabilityChain: ['app.launch'] },
  { id: 'explorer', name: '资源管理器', app: 'explorer', keywords: ['资源管理器', '文件管理器', '我的电脑', 'explorer'], emoji: '📁', capabilityChain: ['app.launch'] },
  { id: 'calc', name: '计算器', app: 'calc', keywords: ['计算器', 'calc'], emoji: '🧮', capabilityChain: ['app.launch'] },
  { id: 'music', name: '音乐', app: '音乐', keywords: ['音乐', '播放器', '音乐播放器'], emoji: '🎵', capabilityChain: ['app.launch'] },
  { id: 'photos', name: '照片', app: '照片', keywords: ['照片', '图片查看器', '相册'], emoji: '🖼️', capabilityChain: ['app.launch'] },
  { id: 'paint', name: '画图', app: 'mspaint', keywords: ['画图', '画板'], emoji: '🎨', capabilityChain: ['app.launch'] },
  { id: 'terminal', name: '终端', app: 'powershell', keywords: ['终端', '命令行', 'powershell', 'cmd'], emoji: '⌨️', capabilityChain: ['app.launch'] },
  { id: 'print', name: '打印', app: null, keywords: ['打印'], emoji: '🖨️', capabilityChain: ['file.print', 'printer.mock'], mode: 'action', actionId: 'file.print' },
];

export const MOBILE_ACTIONS = [
  { id: 'handoff.page', name: '把手机页面甩到电脑', capabilityId: 'handoff.show', kind: 'page', emoji: '📲' },
  { id: 'handoff.photo', name: '把照片甩到电脑', capabilityId: 'handoff.show', kind: 'photo', emoji: '📷' },
  { id: 'handoff.text', name: '把文字甩到电脑', capabilityId: 'handoff.show', kind: 'text', emoji: '📝' },
];

// P0 模拟家庭设备：明确 simulated:true；能力有对应 node-agent 实现时优先用真设备（真实设备在 state.nodes 里）
export const SIMULATED_HOME_DEVICES = [
  { deviceId: 'tv-sim', name: '客厅电视', kind: 'tv', platform: 'tv', online: true, simulated: true, capabilities: ['media.show', 'tv.on', 'tv.off'], note: 'P0 模拟设备（未接真实电视）' },
  { deviceId: 'speaker-sim', name: '客厅音箱', kind: 'speaker', platform: 'speaker', online: true, simulated: true, capabilities: ['media.show', 'system.volume'], note: 'P0 模拟设备（未接真实音箱）' },
  { deviceId: 'light-sim', name: '客厅灯', kind: 'light', platform: 'light', online: true, simulated: true, capabilities: ['light.on', 'light.off'], note: 'P0 模拟设备（未接真实灯具）' },
];

const KIND_ONE_LINE = {
  hub: '本机中枢：调度、审计与素材索引',
  computer: '可打开程序、放音乐视频、接收手机流转',
  phone: '可以一句话指挥电脑，甩一甩把内容送到电脑',
  printer: '可以打印文件',
  nas: '家庭存储：备份与素材归档',
  tv: '可以投屏播放',
  speaker: '可以放音乐/调音量',
  light: '可以开关灯',
  other: '已注册设备',
};

function capabilityUsable(node, cap) {
  if (!cap) return false;
  if (cap.compatible === false) return false;
  if (cap.authExpired) return false;
  if (cap.authExpiresAt && new Date(cap.authExpiresAt) < new Date()) return false;
  return true;
}

export function classifyNode(node) {
  const id = String(node.id || '');
  const name = String(node.name || '');
  const platform = String(node.platform || '');
  const caps = (node.capabilities || []).map((c) => (c && c.id) || '');
  if (id === 'hub' || platform === 'hub') return 'hub';
  // 先认「电脑」：能启动程序/打开网页/播放/接流转的节点就是电脑，避免被 printer.mock 等能力误判成打印机
  if (caps.some((c) => ['app.launch', 'url.open', 'media.show', 'handoff.show', 'system.open', 'system.volume'].includes(c))) return 'computer';
  if (/android|ios|phone|harmony/i.test(platform) || /手机|phone/i.test(name)) return 'phone';
  if (caps.some((c) => c === 'printer.mock' || c === 'file.print') || /打印|printer/i.test(name + platform)) return 'printer';
  if (caps.some((c) => /^nas\./.test(c)) || /nas|群晖|存储/i.test(name + platform)) return 'nas';
  if (/android|ios|phone|harmony/i.test(platform) || /手机|phone/i.test(name)) return 'phone';
  if (/电视|tv|screen/i.test(name + platform)) return 'tv';
  if (/音箱|speaker|音响/i.test(name + platform)) return 'speaker';
  if (/灯|light|bulb/i.test(name + platform)) return 'light';
  if (/win|mac|linux|desktop|pc/i.test(platform) || /电脑|工作台|desktop|workstation/i.test(name)) return 'computer';
  if (caps.some((c) => ['app.launch', 'url.open', 'media.show', 'handoff.show', 'system.open', 'system.volume'].includes(c))) return 'computer';
  return 'other';
}

// 在 state.nodes 里找拥有能力链中任一能力的设备（在线优先）
export function findNodesWithCapabilityChain(state, capabilityChain, { kinds, preferOnline = true } = {}) {
  const out = [];
  for (const node of Object.values((state && state.nodes) || {})) {
    if (!node || node.disconnected || node.hidden || node.id === 'hub') continue;
    const kind = classifyNode(node);
    if (Array.isArray(kinds) && kinds.length && !kinds.includes(kind)) continue;
    for (const capabilityId of capabilityChain || []) {
      const cap = (node.capabilities || []).find((c) => c && c.id === capabilityId);
      if (!capabilityUsable(node, cap)) continue;
      out.push({ node, kind, capabilityId });
      break;
    }
  }
  if (preferOnline) out.sort((a, b) => Number(!!b.node.online) - Number(!!a.node.online));
  return out;
}

// 为某个动作找设备：优先真实节点（按能力链），否则给模拟家庭设备（若动作支持模拟）
export function resolveActionDevice(state, action) {
  const preferredKinds = action.id === 'file.print' ? ['printer', 'computer'] : action.id === 'media.show' ? ['computer', 'speaker', 'tv'] : ['computer'];
  const candidates = findNodesWithCapabilityChain(state, action.capabilityChain || [], { kinds: preferredKinds });
  const onlineCandidate = candidates.find((c) => c.node.online) || candidates[0] || null;
  if (onlineCandidate && onlineCandidate.node.online) {
    return { mode: 'node', node: onlineCandidate.node, kind: onlineCandidate.kind, capabilityId: onlineCandidate.capabilityId, degradedReason: null };
  }
  if (action.kind === 'simulated' || action.simulatedFallback) {
    // 模拟家庭设备：优先与该动作最相关的家庭设备（电视/音箱/灯）
    const simulated = simulatedDeviceForAction(action);
    if (simulated) {
      return {
        mode: 'simulated',
        node: simulated,
        kind: simulated.kind,
        capabilityId: action.id,
        degradedReason: onlineCandidate ? `${onlineCandidate.node.name} 当前离线` : `没有可用的 ${action.capabilityChain && action.capabilityChain[0] ? action.capabilityChain[0] : action.id} 设备`,
      };
    }
  }
  return { mode: 'unavailable', node: onlineCandidate ? onlineCandidate.node : null, kind: null, capabilityId: null, degradedReason: `没有可用的「${action.name}」设备` };
}

export function simulatedDeviceForAction(action) {
  if (action.deviceKind) return SIMULATED_HOME_DEVICES.find((d) => d.kind === action.deviceKind) || null;
  if (action.id === 'media.show') return SIMULATED_HOME_DEVICES.find((d) => d.kind === 'speaker') || SIMULATED_HOME_DEVICES.find((d) => d.kind === 'tv') || null;
  if (action.id === 'system.volume') return SIMULATED_HOME_DEVICES.find((d) => d.kind === 'speaker') || null;
  return null;
}

// 找最适合当"电脑大屏"的节点（给流转/打开用）：优先 handoff.show，其次 system.open，且在线
export function findComputerNode(state) {
  const chain = ['handoff.show', 'system.open'];
  const candidates = findNodesWithCapabilityChain(state, chain, { kinds: ['computer'] });
  const online = candidates.find((c) => c.node.online) || candidates[0] || null;
  return online ? { node: online.node, capabilityId: online.capabilityId } : null;
}

export function resolveProgramByText(text) {
  const t = String(text || '').toLowerCase();
  let best = null;
  for (const program of DESKTOP_PROGRAMS) {
    for (const keyword of program.keywords) {
      if (!keyword) continue;
      if (t.includes(String(keyword).toLowerCase())) {
        if (!best || String(keyword).length > best.keyword.length) best = { program, keyword: String(keyword) };
      }
    }
  }
  return best ? best.program : null;
}

function programAvailability(program, state) {
  const chain = program.capabilityChain || [];
  const nodes = findNodesWithCapabilityChain(state, chain, { kinds: ['computer', 'printer'] });
  const online = nodes.filter((c) => c.node.online);
  return {
    available: online.length > 0,
    availableAs: online.length ? 'node' : 'simulated',
    targetDevices: nodes.slice(0, 5).map(({ node, capabilityId, kind }) => ({ deviceId: node.id, name: node.name, kind, online: !!node.online, capabilityId })),
    reason: online.length ? null : chain.length ? `${chain.join(' / ')} 未注册或设备不在线，将降级为模拟执行` : '不可用',
  };
}

function nodeActionIds(node) {
  const caps = (node.capabilities || []).map((c) => (c && c.id) || '');
  const ids = [];
  for (const action of SUPER_ACTIONS) {
    if (action.kind !== 'node' || action.internal) continue;
    if ((action.capabilityChain || []).some((cap) => caps.includes(cap))) ids.push(action.id);
  }
  return ids;
}

export function deviceView(node) {
  const kind = classifyNode(node);
  const caps = (node.capabilities || []).filter(Boolean).map((c) => c.id);
  return {
    deviceId: node.id,
    name: node.name || node.id,
    kind,
    platform: node.platform || 'unknown',
    online: !!node.online,
    evidence: node.evidence || 'declared',
    simulated: false,
    capabilities: caps,
    actions: nodeActionIds(node),
    oneLine: KIND_ONE_LINE[kind] || KIND_ONE_LINE.other,
  };
}

// appsByNode：{ nodeId: [{name}] }（由 app.list 探测/缓存注入，可选）
export function buildCatalog({ state, appsByNode = null } = {}) {
  const realNodes = Object.values((state && state.nodes) || {}).filter((n) => n && !n.hidden);
  const devices = realNodes.map(deviceView).concat(SIMULATED_HOME_DEVICES.map((d) => ({
    deviceId: d.deviceId,
    name: d.name,
    kind: d.kind,
    platform: d.platform,
    online: !!d.online,
    evidence: 'simulated',
    simulated: true,
    capabilities: d.capabilities.slice(),
    actions: SUPER_ACTIONS.filter((a) => (a.deviceKind && a.deviceKind === d.kind) || (a.capabilityChain || []).some((cap) => d.capabilities.includes(cap))).map((a) => a.id),
    oneLine: KIND_ONE_LINE[d.kind] || KIND_ONE_LINE.other,
    note: d.note,
  })));
  const appListNodes = [];
  for (const node of realNodes) {
    const has = (node.capabilities || []).some((c) => c && c.id === 'app.list');
    if (has) appListNodes.push({ deviceId: node.id, name: node.name, online: !!node.online });
  }
  const programs = DESKTOP_PROGRAMS.map((program) => {
    const avail = programAvailability(program, state);
    return {
      id: program.id,
      name: program.name,
      emoji: program.emoji,
      app: program.app,
      mode: program.mode || 'program',
      actionId: program.actionId || 'app.launch',
      keywords: program.keywords,
      ...avail,
    };
  });
  // 合并电脑端 app.list 上报的真实程序（若已探测）
  if (appsByNode && typeof appsByNode === 'object') {
    for (const [nodeId, apps] of Object.entries(appsByNode)) {
      for (const app of apps || []) {
        const name = String(app.name || app).trim();
        if (!name) continue;
        if (programs.some((p) => p.name === name && p.sourceNodeId === nodeId)) continue;
        if (programs.some((p) => p.name === name && !p.sourceNodeId)) continue;
        programs.push({
          id: 'node-app:' + nodeId + ':' + name,
          name,
          emoji: '🖥️',
          app: name,
          mode: 'program',
          actionId: 'app.launch',
          keywords: [name],
          available: true,
          availableAs: 'node',
          targetDevices: [{ deviceId: nodeId, name: nodeId, online: true, capabilityId: 'app.launch' }],
          sourceNodeId: nodeId,
          reason: null,
        });
      }
    }
  }
  const actions = SUPER_ACTIONS.filter((a) => !a.internal).map(publicAction);
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      devices: devices.length,
      onlineDevices: devices.filter((d) => d.online).length,
      simulatedDevices: devices.filter((d) => d.simulated).length,
      programs: programs.length,
      programsAvailable: programs.filter((p) => p.available).length,
      mobileActions: MOBILE_ACTIONS.length,
      appListNodes: appListNodes.length,
    },
    mode: (state && state.meta && state.meta.mode) || 'solo',
    devices,
    programs,
    mobileActions: MOBILE_ACTIONS.slice(),
    actions,
    appListNodes,
  };
}

export default { DESKTOP_PROGRAMS, MOBILE_ACTIONS, SIMULATED_HOME_DEVICES, buildCatalog, classifyNode, findNodesWithCapabilityChain, findComputerNode, resolveActionDevice, simulatedDeviceForAction, resolveProgramByText, deviceView };