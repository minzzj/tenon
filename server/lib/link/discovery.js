// 榫卯 Tenon v2 · UDP 局域网发现（零依赖 node:dgram，默认端口 7413）
import dgram from 'node:dgram';
import os from 'node:os';

export const DISCOVERY_PORT = 7413;
export const HELLO_TYPE = 'tenon-hello';

/**
 * 周期广播本机 hello，同时监听同端口 hello 维护 peers 表。
 * - 默认广播 255.255.255.255 + 各网卡子网广播地址；同机联调可用 unicastTargets 指定 ip:port。
 * - peers 超过 timeoutMs 未收到 hello 即移除；onPeer(peer, {isNew, gone}) 只在「新出现/离开」时回调。
 */
export function createDiscovery({
  identity,
  httpPort = 7410,
  discoveryPort = DISCOVERY_PORT,
  intervalMs = 3000,
  timeoutMs = 10000,
  unicastTargets = [],
  enabled = true,
  log = () => {},
  onPeer = () => {},
} = {}) {
  const peers = new Map();
  let sock = null;
  let helloTimer = null;
  let sweepTimer = null;
  let running = false;
  let disabledReason = '';
  let startedAt = 0;
  let sendCount = 0;
  let helloCount = 0;
  let lastHelloAt = '';
  let lastHelloFrom = '';

  function parseUnicastTargets() {
    const out = [];
    for (const raw of unicastTargets || []) {
      if (raw == null) continue;
      if (typeof raw === 'number') {
        out.push({ host: '127.0.0.1', port: raw });
        continue;
      }
      const text = String(raw).trim();
      const m = text.match(/^(.+):(\d+)$/);
      if (m) out.push({ host: m[1], port: Number(m[2]) });
      else out.push({ host: text || '127.0.0.1', port: discoveryPort });
    }
    return out;
  }

  function broadcastTargets() {
    const taken = new Set();
    const out = [];
    const push = (host, port) => {
      const key = host + '|' + port;
      if (taken.has(key)) return;
      taken.add(key);
      out.push({ host, port });
    };
    for (const item of parseUnicastTargets()) push(item.host, item.port);
    push('255.255.255.255', discoveryPort);
    try {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) {
          if (ni.family !== 'IPv4' || ni.internal || !ni.netmask) continue;
          const addr = ni.address.split('.').map(Number);
          const mask = ni.netmask.split('.').map(Number);
          const broadcast = addr.map((v, i) => (v | (~mask[i] & 255)) & 255).join('.');
          push(broadcast, discoveryPort);
        }
      }
    } catch {
      /* 网卡枚举失败时只发 255.255.255.255 */
    }
    return out;
  }

  function helloMessage() {
    return {
      t: HELLO_TYPE,
      deviceId: identity.deviceId,
      name: identity.name,
      platform: identity.platform,
      port: httpPort,
      fp: identity.fingerprint,
      v: 2,
      at: new Date().toISOString(),
    };
  }

  function sendHello() {
    if (!sock || !running) return;
    let buf;
    try {
      buf = Buffer.from(JSON.stringify(helloMessage()));
    } catch {
      return;
    }
    let sent = 0;
    for (const target of broadcastTargets()) {
      try {
        sock.send(buf, 0, buf.length, target.port, target.host, () => {});
        sent += 1;
      } catch {
        /* 单个地址不可达不影响其它地址 */
      }
    }
    if (sent > 0) sendCount += 1;
  }

  function handleMessage(buf, rinfo) {
    let msg;
    try {
      msg = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!msg || msg.t !== HELLO_TYPE || !msg.deviceId) return;
    if (msg.deviceId === identity.deviceId) return;
    let ip = rinfo && rinfo.address ? String(rinfo.address) : '';
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    const prev = peers.get(msg.deviceId);
    const peer = {
      deviceId: msg.deviceId,
      name: msg.name || msg.deviceId,
      platform: msg.platform || 'unknown',
      ip,
      port: Number(msg.port) || 0,
      fingerprint: msg.fp || '',
      version: Number(msg.v) || 1,
      lastSeen: Date.now(),
      firstSeen: prev && prev.firstSeen ? prev.firstSeen : Date.now(),
      helloCount: prev && prev.helloCount ? prev.helloCount + 1 : 1,
    };
    peers.set(peer.deviceId, peer);
    helloCount += 1;
    lastHelloAt = new Date().toISOString();
    lastHelloFrom = peer.ip + ':' + peer.port;
    if (!prev) {
      try {
        onPeer(peer, { isNew: true, gone: false });
      } catch (err) {
        log('onPeer(new) 回调失败：' + err.message);
      }
    }
  }

  function prune() {
    const now = Date.now();
    for (const [deviceId, peer] of peers) {
      if (now - peer.lastSeen > timeoutMs) {
        peers.delete(deviceId);
        try {
          onPeer(peer, { isNew: false, gone: true });
        } catch (err) {
          log('onPeer(gone) 回调失败：' + err.message);
        }
      }
    }
  }

  function start() {
    if (!enabled) {
      disabledReason = '已通过配置禁用';
      return { enabled: false, reason: disabledReason };
    }
    if (running) return { enabled: true, port: discoveryPort };
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      disabledReason = '创建 UDP socket 失败：' + err.message;
      log(disabledReason);
      return { enabled: false, reason: disabledReason };
    }
    sock.on('error', (err) => {
      log('UDP 发现 socket 错误（已降级为不使用发现）：' + err.message);
      disabledReason = err.message;
      running = false;
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      sock = null;
    });
    sock.on('message', handleMessage);
    try {
      sock.bind(discoveryPort, () => {
        running = true;
        startedAt = Date.now();
        try {
          sock.setBroadcast(true);
        } catch {
          /* 某些环境不允许广播，仍可收/发单播 */
        }
        sendHello();
        helloTimer = setInterval(sendHello, Math.max(500, intervalMs));
        sweepTimer = setInterval(prune, Math.max(1000, Math.round(timeoutMs / 2)));
        if (helloTimer.unref) helloTimer.unref();
        if (sweepTimer.unref) sweepTimer.unref();
        log('UDP 发现已启动：端口 ' + discoveryPort + '，本机 HTTP 端口 ' + httpPort);
      });
    } catch (err) {
      disabledReason = '绑定 UDP 端口失败：' + err.message;
      log(disabledReason);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      sock = null;
      return { enabled: false, reason: disabledReason };
    }
    return { enabled: true, port: discoveryPort };
  }

  function list() {
    prune();
    return [...peers.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .map((p) => ({
        deviceId: p.deviceId,
        name: p.name,
        platform: p.platform,
        ip: p.ip,
        port: p.port,
        fingerprint: p.fingerprint,
        version: p.version,
        lastSeen: new Date(p.lastSeen).toISOString(),
        lastSeenMs: p.lastSeen,
      }));
  }

  function close() {
    running = false;
    if (helloTimer) clearInterval(helloTimer);
    if (sweepTimer) clearInterval(sweepTimer);
    helloTimer = null;
    sweepTimer = null;
    if (sock) {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      sock = null;
    }
    peers.clear();
  }

  function stats() {
    return {
      enabled: !!enabled,
      running: !!running,
      port: discoveryPort,
      httpPort,
      disabledReason: disabledReason || '',
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      sendCount,
      helloCount,
      peers: peers.size,
      lastHelloAt,
      lastHelloFrom,
      broadcastTargets: running ? broadcastTargets().length : 0,
    };
  }

  return {
    start,
    close,
    list,
    sendHello,
    stats,
    getPort: () => discoveryPort,
    getHttpPort: () => httpPort,
    isRunning: () => running,
    getDisabledReason: () => disabledReason,
  };
}