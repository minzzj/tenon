// 榫卯 V5 · SSDP / UPnP 局域网发现（真实 M-SEARCH）
// 作用：向 239.255.255.250:1900 发 M-SEARCH（ssdp:all / MediaRenderer / MediaServer / basic:1），
//       收集 5 秒窗口内的响应，解析 LOCATION/USN/ST/SERVER，并尝试抓取 LOCATION 的 UPnP 描述拿 friendlyName。
import dgram from 'node:dgram';
import { nowIso } from './util.js';

export const SSDP_VERSION = '5.0.0';
export const SSDP_ADDRESS = '239.255.255.250';
export const SSDP_PORT = 1900;

export function buildSearchMessage(st = 'ssdp:all', { mx = 3 } = {}) {
  return [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:all"',
    `MX: ${Math.max(1, Math.min(5, mx))}`,
    `ST: ${st}`,
    'USER-AGENT: Tenon/5.0 UPnP/1.1',
    '',
    '',
  ].join('\r\n');
}

// 解析一条 SSDP 响应；非法/非 200 返回 null
export function parseSsdpResponse(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!/^HTTP\/1\.1\s+200/i.test(lines[0] || '')) return null;
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  if (!headers.usn && !headers.location) return null;
  return {
    st: headers.st || '',
    usn: headers.usn || '',
    location: headers.location || '',
    server: headers.server || '',
    cacheControl: headers['cache-control'] || '',
    date: headers.date || '',
    ext: headers.ext || '',
  };
}

export function typeLabel(st, server) {
  const s = String(st || '').toLowerCase();
  const srv = String(server || '').toLowerCase();
  if (s.includes('mediarenderer') || srv.includes('mediarenderer')) return '媒体渲染器/电视/音箱';
  if (s.includes('mediaserver') || srv.includes('mediaserver')) return '媒体服务器/NAS';
  if (s.includes('internetgatewaydevice')) return '路由器/网关';
  if (s.includes('printer')) return '打印机';
  if (s.includes('basic:1')) return 'UPnP 设备';
  return st || '未知设备';
}

async function fetchDeviceDescription(location, fetchImpl, timeoutMs = 2000) {
  if (!location || typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl(location, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const xml = await res.text();
    const pick = (tag) => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
      return m ? m[1].trim() : null;
    };
    return {
      friendlyName: pick('friendlyName'),
      deviceType: pick('deviceType'),
      modelName: pick('modelName'),
      manufacturer: pick('manufacturer'),
    };
  } catch {
    return null;
  }
}

export async function ssdpDiscover({
  st = 'ssdp:all',
  timeoutMs = 5000,
  address = SSDP_ADDRESS,
  port = SSDP_PORT,
  fetchImpl = globalThis.fetch,
  fetchDescriptions = true,
  log = () => {},
} = {}) {
  const started = Date.now();
  const found = new Map();
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const errors = [];
  const onMessage = (msg) => {
    const parsed = parseSsdpResponse(msg);
    if (!parsed) return;
    const key = parsed.usn || parsed.location;
    if (!key || found.has(key)) return;
    found.set(key, parsed);
  };
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, () => {
        socket.off('error', reject);
        socket.on('error', (err) => errors.push(String(err && err.message ? err.message : err)));
        socket.on('message', onMessage);
        try {
          socket.setMulticastTTL(2);
          socket.setBroadcast(true);
        } catch {
          /* 某些网卡不支持，继续 */
        }
        resolve();
      });
    });
    const message = buildSearchMessage(st, { mx: Math.max(1, Math.min(5, Math.ceil(timeoutMs / 1000))) });
    await new Promise((resolve) => {
      socket.send(message, 0, Buffer.byteLength(message), port, address, (err) => {
        if (err) errors.push(String(err.message || err));
        resolve();
      });
    });
    await new Promise((resolve) => setTimeout(resolve, Math.max(300, Math.min(timeoutMs, 10000))));
  } catch (err) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    return { ok: false, count: 0, devices: [], ms: Date.now() - started, error: String(err && err.message ? err.message : err), st, address, port };
  }
  try {
    socket.close();
  } catch {
    /* ignore */
  }
  const devices = [...found.values()];
  if (fetchDescriptions && devices.length) {
    const results = await Promise.allSettled(devices.slice(0, 10).map((device) => fetchDeviceDescription(device.location, fetchImpl)));
    results.forEach((result, index) => {
      const info = result.status === 'fulfilled' ? result.value : null;
      devices[index].description = info;
      if (info && info.friendlyName) devices[index].friendlyName = info.friendlyName;
    });
  }
  const mapped = devices.map((device) => ({
    usn: device.usn,
    st: device.st,
    location: device.location,
    server: device.server,
    name: device.friendlyName || device.server || typeLabel(device.st, device.server),
    type: (device.description && device.description.deviceType) || device.st || 'upnp',
    typeLabel: typeLabel(device.st, device.server),
    model: device.description ? device.description.modelName || null : null,
    manufacturer: device.description ? device.description.manufacturer || null : null,
    description: device.description || null,
    discoveredAt: nowIso(),
  }));
  log(`[iot/ssdp] M-SEARCH st=${st} 收到 ${mapped.length} 条响应（${Date.now() - started}ms）`);
  return { ok: true, count: mapped.length, devices: mapped, ms: Date.now() - started, st, address, port, errors: errors.slice(0, 5) };
}

export default { SSDP_VERSION, SSDP_ADDRESS, SSDP_PORT, buildSearchMessage, parseSsdpResponse, typeLabel, ssdpDiscover };