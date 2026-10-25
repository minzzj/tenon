// 榫卯 Tenon v2 · 连接层服务入口
// 导出：createLinkService({ledger,state,root,dataDir}) + routes（{method,path,handler(req,res,ctx)} 数组）
// 只 append 契约 §3 的 link.* / transfer.* / clipboard.shared / notification.relayed 事件；不改 state.js。
import path from 'node:path';
import { loadOrCreateIdentity } from './identity.js';
import { createDiscovery, DISCOVERY_PORT } from './discovery.js';
import { createPairing } from './pairing.js';
import { createTransferManager, DEFAULT_CHUNK_SIZE } from './transfer.js';
import { createClipboardStore } from './clipboard.js';
import { createNotifier } from './notify.js';
import { readJson, localIPv4, nowIso } from './util.js';
import { routeDefs, createBoundRoutes, getRouteList, routes } from './routes.js';
import { matchRoutes, matchPath } from './router.js';

function parseCookie(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      try {
        out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
      }
    }
  }
  return out;
}

/**
 * 创建连接层服务。
 * @param {object} opts
 * @param {object} [opts.ledger]   Ledger 实例（append 事件用；不传则不写账本，仅内存/DOM 演示）
 * @param {object} [opts.state]    replay 后的状态（保留参数，本层只依赖 ledger 与自身持久化）
 * @param {string} [opts.root]     仓库根（dataDir 缺省 root/data）
 * @param {string} [opts.dataDir]  数据目录（link/、transfers/ 都放这里）
 * @param {number} [opts.port]     HTTP 端口（用于 QR/发现广播，默认 TENON_PORT 或 7410）
 * @param {string} [opts.host]     绑定地址（默认 TENON_HOST 或 127.0.0.1；0.0.0.0 时 QR 用局域网 IP）
 * @param {object} [opts.tokens]   {operatorToken,nodeToken}（缺省读 data/secrets.json）
 * @param {boolean} [opts.discovery] 是否启用 UDP 发现（默认 true）
 * @param {number} [opts.discoveryPort] UDP 端口（默认 7413）
 * @param {Array} [opts.unicastTargets] 额外单播发现目标（同机联调用 '127.0.0.1:7434' 或 7434）
 * @param {function} [opts.log]    日志函数
 */
export function createLinkService(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : path.join(root, 'data');
  const identity = loadOrCreateIdentity(dataDir, { name: opts.name, platform: opts.platform });
  // Lead 的 v2 挂载会传 { secret }（data/secrets.json 内容）；单测可直接传 tokens
  const tokens = opts.tokens || opts.secret || readJson(path.join(dataDir, 'secrets.json'), null) || {};
  const httpPort = Number(opts.port || process.env.TENON_PORT || 7410);
  const bindHost = String(opts.host || process.env.TENON_HOST || '127.0.0.1');
  const advertiseHost = bindHost === '0.0.0.0' || bindHost === '::' ? localIPv4() : bindHost;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  function appendEvent(type, data) {
    try {
      if (opts.ledger && typeof opts.ledger.append === 'function') opts.ledger.append(type, data, 'link');
    } catch (err) {
      log('append 账本事件失败（' + type + '）：' + err.message);
    }
  }

  const pairing = createPairing({
    dataDir,
    identity,
    getHttpPort: () => httpPort,
    host: advertiseHost,
    codeTtlMs: opts.codeTtlMs,
    appendEvent,
    log,
  });

  const discovery = createDiscovery({
    identity,
    httpPort,
    discoveryPort: Number(opts.discoveryPort || (process.env.TENON_DISCOVERY_PORT ? Number(process.env.TENON_DISCOVERY_PORT) : DISCOVERY_PORT)),
    intervalMs: opts.intervalMs,
    timeoutMs: opts.timeoutMs,
    unicastTargets: opts.unicastTargets || [],
    enabled: opts.discovery !== false,
    log,
    onPeer: (peer, info) => {
      if (info && info.isNew) {
        appendEvent('link.peer.seen', {
          deviceId: peer.deviceId,
          name: peer.name,
          platform: peer.platform,
          ip: peer.ip,
          port: peer.port,
          at: nowIso(),
        });
      }
      if (pairing.isTrusted(peer.deviceId)) {
        pairing.touchPeer(peer.deviceId, { ip: peer.ip, port: peer.port, name: peer.name });
      }
    },
  });

  const transfer = createTransferManager({
    dataDir,
    identity,
    pairing,
    appendEvent,
    chunkSize: Number(opts.chunkSize) || DEFAULT_CHUNK_SIZE,
    log,
  });

  const clipboard = createClipboardStore({ dataDir, appendEvent });
  const notifier = createNotifier({ dataDir, appendEvent });

  function tokenOf(req) {
    const header = req && req.headers ? req.headers['x-tenon-token'] : '';
    if (header) return String(header);
    const cookie = req && req.headers ? parseCookie(req.headers.cookie || '').tenon_token : '';
    return cookie || '';
  }

  /** 鉴权：operatorToken（UI/桌面端）、nodeToken（节点）、或者配对后对端持有的 peerToken */
  function authorize(req) {
    const token = tokenOf(req);
    if (!token) return { ok: false, status: 401, error: '需要登录令牌' };
    if (tokens.operatorToken && token === String(tokens.operatorToken)) return { ok: true, role: 'operator' };
    if (tokens.nodeToken && token === String(tokens.nodeToken)) return { ok: true, role: 'node' };
    const peer = pairing.authPeerToken(token);
    if (peer) return { ok: true, role: 'peer', peerId: peer.peerId };
    return { ok: false, status: 401, error: '令牌无效' };
  }

  function info() {
    const pairStats = pairing.stats();
    return {
      deviceId: identity.deviceId,
      name: identity.name,
      platform: identity.platform,
      fingerprint: identity.fingerprint,
      port: httpPort,
      host: advertiseHost,
      version: 2,
      discovery: {
        enabled: discovery.isRunning(),
        port: discovery.getPort(),
        reason: discovery.getDisabledReason() || '',
      },
      pairing: { trusted: pairStats.trusted, codeExpiresAt: pairStats.codeExpiresAt },
    };
  }

  /** 发现的在线设备 + 已信任设备（离线也列出）合并视图 */
  function peersInfo() {
    const trusted = new Map(pairing.listTrusted().map((peer) => [peer.peerId, peer]));
    const merged = new Map();
    for (const peer of discovery.list()) {
      const record = trusted.get(peer.deviceId);
      merged.set(peer.deviceId, {
        ...peer,
        name: (record && record.name) || peer.name,
        paired: !!record,
        trusted: !!record,
        online: true,
      });
    }
    for (const record of trusted.values()) {
      if (merged.has(record.peerId)) continue;
      merged.set(record.peerId, {
        deviceId: record.peerId,
        name: record.name,
        platform: record.platform,
        ip: record.ip || '',
        port: record.port || 0,
        fingerprint: record.fingerprint,
        paired: true,
        trusted: true,
        online: false,
        lastSeen: record.lastSeen,
      });
    }
    const peers = [...merged.values()].sort((a, b) => {
      if (!!b.online !== !!a.online) return b.online ? 1 : -1;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });
    return {
      self: info(),
      peers,
      discovery: { enabled: discovery.isRunning(), port: discovery.getPort() },
    };
  }

  const service = {
    identity,
    root,
    dataDir,
    port: httpPort,
    host: advertiseHost,
    readOnly: !!opts.readOnly,
    tokens,
    pairing,
    discovery,
    transfer,
    clipboard,
    notifier,
    appendEvent,
    authorize,
    tokenOf,
    info,
    peersInfo,
    pairingInfo: () => pairing.pairingInfo(),
    matchRoutes: (method, pathname) => matchRoutes(routeDefs, method, pathname),
    start: () => discovery.start(),
    close: () => discovery.close(),
  };
  service.routes = createBoundRoutes(service);
  service.start();
  return service;
}

export { routeDefs as routes, createBoundRoutes, getRouteList, matchRoutes, matchPath, routes as staticRoutes };
export { LINK_EVENT_TYPES } from './events.js';
export default createLinkService;

export const ROUTES = getRouteList();