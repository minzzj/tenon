// 榫卯 V5 · IoT 接入管理（Home Assistant REST / MQTT Discovery / SSDP）
// 统一设备模型 + 导入设备配置中心（data/devices/iot-devices.json）+ 控制 + /api/v2/iot/* 路由。
// 诚实边界：品牌设备经 Home Assistant / MQTT 桥接接入（小米/华为/苹果/Aqara/涂鸦等由 HA 官方集成或 MQTT 网关提供），
//           本模块不直连厂商云；SSDP 发现的设备仅能查看（是否可控取决于其 UPnP 实现），导入后如需控制请接 HA/MQTT。
import fs from 'node:fs';
import path from 'node:path';
import { readJson, atomicWriteJson, httpError, nowIso, maskSecret, clampInt, pickString, shortHash } from './util.js';
import { createHomeAssistantClient, HA_VERSION } from './homeassistant.js';
import { createMqttAdapter, MQTT_VERSION } from './mqtt.js';
import { ssdpDiscover as defaultSsdpDiscover, SSDP_VERSION } from './ssdp.js';

export const IOT_VERSION = '5.0.0';
export const ROUTES = [
  { method: 'GET', path: '/api/v2/iot/status' },
  { method: 'GET', path: '/api/v2/iot/config' },
  { method: 'PATCH', path: '/api/v2/iot/config' },
  { method: 'POST', path: '/api/v2/iot/test' },
  { method: 'GET', path: '/api/v2/iot/discover' },
  { method: 'GET', path: '/api/v2/iot/ha/entities' },
  { method: 'POST', path: '/api/v2/iot/import' },
  { method: 'GET', path: '/api/v2/iot/devices' },
  { method: 'GET', path: '/api/v2/iot/mqtt/devices' },
  { method: 'GET', path: '/api/v2/iot/last-discovery' },
  { method: 'POST', path: '/api/v2/iot/devices/:id/control' },
  { method: 'DELETE', path: '/api/v2/iot/devices/:id' },
];

const CAP_LABELS = {
  turn_on: '打开', turn_off: '关闭', toggle: '切换', set_brightness: '调亮度', set_temperature: '设温度',
  set_hvac_mode: '设模式', play: '播放', pause: '暂停', play_pause: '播放/暂停', next: '下一个',
  previous: '上一个', set_volume: '调音量', mute: '静音', open: '打开（开合类）', close: '关闭（开合类）',
  stop: '停止', lock: '上锁', unlock: '解锁', start: '启动', return_home: '回充/归位', trigger: '触发',
  set_percentage: '设档位', set_position: '设位置', read: '只读状态',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, '请求体过大', 'BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(httpError(400, '请求体不是合法 JSON', 'INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function queryOf(ctx, req) {
  try {
    if (ctx && ctx.url && typeof ctx.url.searchParams !== 'undefined') return ctx.url.searchParams;
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function paramsOf(ctx, req) {
  if (ctx && ctx.params && typeof ctx.params === 'object') return ctx.params;
  try {
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/api\/v2\/iot\/devices\/([^/]+)\/control$/.exec(url.pathname) || /^\/api\/v2\/iot\/devices\/([^/]+)$/.exec(url.pathname);
    return m ? { id: decodeURIComponent(m[1]) } : {};
  } catch {
    return {};
  }
}

function capabilityManifest(domain, commands, adapter) {
  return (commands || []).map((command) => ({
    id: `iot.${domain}.${command}`,
    name: CAP_LABELS[command] || command,
    risk: 'reversible',
    manualOnly: false,
    version: IOT_VERSION,
    evidence: 'declared',
    adapter,
    command,
  }));
}

function mapHaCapabilities(domain, commands, adapter = 'ha') {
  return capabilityManifest(domain, commands, adapter);
}

function deviceIdOfHa(entityId) {
  return `iot:ha:${entityId}`;
}

export function createIotService(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const dataDir = path.resolve(opts.dataDir || path.join(root, 'data'));
  const ledger = opts.ledger || null;
  const readOnly = !!opts.readOnly;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const ssdpFn = typeof opts.ssdpDiscoverFn === 'function' ? opts.ssdpDiscoverFn : defaultSsdpDiscover;
  const configFile = path.join(dataDir, 'iot', 'config.json');
  const devicesFile = path.join(dataDir, 'devices', 'iot-devices.json');
  const lastScanFile = path.join(dataDir, 'iot', 'ssdp-last.json');

  const readConfigured = () => {
    const saved = readJson(configFile, null);
    const env = process.env;
    return {
      ha: {
        baseUrl: (saved && saved.ha && saved.ha.baseUrl) || env.TENON_HA_URL || '',
        token: (saved && saved.ha && saved.ha.token) || env.TENON_HA_TOKEN || '',
      },
      mqtt: {
        url: (saved && saved.mqtt && saved.mqtt.url) || env.TENON_MQTT_URL || '',
        username: (saved && saved.mqtt && saved.mqtt.username) || env.TENON_MQTT_USERNAME || '',
        password: (saved && saved.mqtt && saved.mqtt.password) || env.TENON_MQTT_PASSWORD || '',
        prefix: (saved && saved.mqtt && saved.mqtt.prefix) || env.TENON_MQTT_PREFIX || 'homeassistant',
      },
    };
  };

  let config = readConfigured();
  const ha = opts.haClient || createHomeAssistantClient({ baseUrl: config.ha.baseUrl, token: config.ha.token, fetchImpl, log });
  const mqttAdapter = opts.mqttAdapter || createMqttAdapter({ config: config.mqtt, dataDir, log });

  function loadDevices() {
    const raw = readJson(devicesFile, null);
    if (raw && raw.devices && typeof raw.devices === 'object') return raw.devices;
    return {};
  }
  let devices = loadDevices();
  let lastScan = readJson(lastScanFile, null);
  let lastHa = { at: null, ok: null, version: null, error: null, entities: 0 };

  function saveDevices() {
    atomicWriteJson(devicesFile, { version: 1, updatedAt: nowIso(), devices });
  }

  function append(type, data) {
    try {
      if (readOnly) return; // 只读实例不写账本（P2 修复：/iot/discover 等 GET 不应在只读实例产生事件）
      if (ledger && typeof ledger.append === 'function') ledger.append(type, data, 'iot');
    } catch (err) {
      log(`[iot] 写账本事件失败（${type}）：${err && err.message ? err.message : err}`);
    }
  }

  function configView() {
    return {
      ok: true,
      version: IOT_VERSION,
      ha: { baseUrl: config.ha.baseUrl, tokenMasked: maskSecret(config.ha.token), tokenSet: !!config.ha.token, configured: !!config.ha.baseUrl },
      mqtt: {
        url: config.mqtt.url,
        username: config.mqtt.username,
        passwordMasked: maskSecret(config.mqtt.password),
        passwordSet: !!config.mqtt.password,
        prefix: config.mqtt.prefix || 'homeassistant',
        configured: !!config.mqtt.url,
      },
      sources: {
        ha: { name: 'Home Assistant REST（桥接小米/华为/苹果/Aqara/涂鸦等品牌）', adapter: 'ha' },
        mqtt: { name: 'MQTT（HA MQTT Discovery / 自建网关）', adapter: 'mqtt' },
        ssdp: { name: 'SSDP 局域网发现（只读发现，UPnP 设备）', adapter: 'ssdp' },
      },
      updatedAt: config.updatedAt || null,
    };
  }

  function bySource() {
    const out = { ha: 0, mqtt: 0, ssdp: 0 };
    for (const device of Object.values(devices)) out[device.source] = (out[device.source] || 0) + 1;
    return out;
  }

  function status() {
    return {
      ok: true,
      version: IOT_VERSION,
      adapters: { ha: HA_VERSION, mqtt: MQTT_VERSION, ssdp: SSDP_VERSION },
      ha: {
        configured: !!config.ha.baseUrl,
        baseUrl: config.ha.baseUrl,
        tokenMasked: maskSecret(config.ha.token),
        lastTestAt: lastHa.at,
        lastTestOk: lastHa.ok,
        versionKnown: lastHa.version,
        entitiesCached: lastHa.entities,
        lastError: lastHa.error,
      },
      mqtt: { ...mqttAdapter.status(), configured: !!config.mqtt.url },
      ssdp: { lastScanAt: lastScan && lastScan.at ? lastScan.at : null, lastScanCount: lastScan && lastScan.devices ? lastScan.devices.length : 0, lastScanSt: lastScan && lastScan.st ? lastScan.st : null },
      devices: { total: Object.keys(devices).length, bySource: bySource() },
      at: nowIso(),
    };
  }

  function patchConfig(patch = {}) {
    const body = patch && typeof patch === 'object' ? patch : {};
    const next = { ha: { ...config.ha }, mqtt: { ...config.mqtt } };
    if (body.ha && typeof body.ha === 'object') {
      if (body.ha.baseUrl !== undefined) {
        const baseUrl = pickString(body.ha.baseUrl, 300).replace(/\/+$/, '');
        if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw httpError(400, 'HA baseUrl 必须是 http(s) 地址', 'INVALID_CONFIG');
        next.ha.baseUrl = baseUrl;
      }
      if (body.ha.token !== undefined) {
        const token = pickString(body.ha.token, 400);
        next.ha.token = token;
      }
    }
    if (body.mqtt && typeof body.mqtt === 'object') {
      if (body.mqtt.url !== undefined) {
        const url = pickString(body.mqtt.url, 300);
        if (url && !/^(mqtts?|wss?):\/\//i.test(url) && !/^[\w.-]+(:\d{1,5})?$/.test(url)) throw httpError(400, 'MQTT url 需为 mqtt://host:1883 或 host:1883', 'INVALID_CONFIG');
        next.mqtt.url = url;
      }
      if (body.mqtt.username !== undefined) next.mqtt.username = pickString(body.mqtt.username, 100);
      if (body.mqtt.password !== undefined) next.mqtt.password = pickString(body.mqtt.password, 200);
      if (body.mqtt.prefix !== undefined) {
        const prefix = pickString(body.mqtt.prefix, 60) || 'homeassistant';
        if (!/^[\w./-]+$/.test(prefix)) throw httpError(400, 'MQTT 前缀只能包含字母数字和 / . _ -', 'INVALID_CONFIG');
        next.mqtt.prefix = prefix.replace(/\/+$/, '');
      }
    }
    config = { ...next, updatedAt: nowIso() };
    atomicWriteJson(configFile, { version: 1, ...config });
    ha.setConfig({ baseUrl: config.ha.baseUrl, token: config.ha.token });
    mqttAdapter.applyConfig(config.mqtt);
    if (config.mqtt.url) {
      try {
        mqttAdapter.connect();
      } catch (err) {
        log(`[iot/mqtt] 连接失败：${err && err.message ? err.message : err}`);
      }
    }
    log('[iot] 配置已更新');
    return configView();
  }

  async function test({ target = 'all' } = {}) {
    const out = { ok: true, ha: null, mqtt: null, at: nowIso() };
    if (target === 'all' || target === 'ha') {
      const result = await ha.test();
      lastHa = { at: nowIso(), ok: !!result.ok, version: result.version || null, error: result.error || null, entities: lastHa.entities };
      out.ha = { configured: !!config.ha.baseUrl, ...result };
      if (!result.ok) out.ok = false;
    }
    if (target === 'all' || target === 'mqtt') {
      if (!config.mqtt.url) {
        out.mqtt = { configured: false, ok: false, error: 'MQTT 未配置（url 为空）' };
        if (target === 'all' && config.ha.baseUrl) { /* 只要求已配置项通过 */ }
      } else {
        if (!mqttAdapter.isConnected()) mqttAdapter.connect();
        const deadline = Date.now() + 5000;
        while (!mqttAdapter.isConnected() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 150));
        const st = mqttAdapter.status();
        out.mqtt = { configured: true, ok: st.connected, connected: st.connected, url: st.url, prefix: st.prefix, devices: st.devices, error: st.connected ? null : st.lastError || '连接超时' };
        if (!st.connected) out.ok = false;
      }
    }
    return out;
  }

  async function discover({ st = 'ssdp:all', timeoutMs = 5000 } = {}) {
    const result = await ssdpFn({ st, timeoutMs: clampInt(timeoutMs, 1000, 15000, 5000), fetchImpl, log });
    lastScan = { at: nowIso(), st, devices: result.devices || [], count: result.count || 0, ms: result.ms || 0 };
    try {
      atomicWriteJson(lastScanFile, lastScan);
    } catch { /* ignore */ }
    append('iot.discovered', {
      count: lastScan.count,
      st,
      devices: lastScan.devices.slice(0, 20).map((device) => ({ usn: device.usn, st: device.st, location: device.location, server: device.server, name: device.name })),
      ms: result.ms || 0,
    });
    return { ...result, lastScanAt: lastScan.at };
  }

  async function listHaEntities({ domain = null } = {}) {
    const entities = await ha.listEntities({ domain });
    lastHa = { ...lastHa, at: nowIso(), ok: true, entities: entities.length, error: null };
    return { ok: true, count: entities.length, entities, at: nowIso() };
  }

  async function importDevices({ source, ids = null } = {}) {
    const src = String(source || '').toLowerCase();
    if (!['ha', 'mqtt', 'ssdp'].includes(src)) throw httpError(400, 'source 必须是 ha / mqtt / ssdp', 'INVALID_SOURCE');
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map((id) => String(id).replace(/^iot:/, ''))) : null;
    const imported = [];
    const skipped = [];
    if (src === 'ha') {
      const entities = await ha.listEntities();
      for (const entity of entities) {
        const key = entity.entityId;
        if (wanted && !wanted.has(key) && !wanted.has(entity.id) && !wanted.has(deviceIdOfHa(key))) continue;
        if (wanted && !wanted.has(key) && !wanted.has(entity.id) && !wanted.has(deviceIdOfHa(key))) { skipped.push(key); continue; }
        const id = deviceIdOfHa(key);
        devices[id] = {
          id,
          name: entity.name,
          type: entity.type,
          domain: entity.domain,
          source: 'ha',
          adapter: 'ha',
          sourceId: key,
          state: entity.state,
          attributes: entity.attributes,
          available: entity.available,
          capabilities: mapHaCapabilities(entity.domain, entity.capabilities, 'ha'),
          commands: entity.capabilities,
          importedAt: (devices[id] && devices[id].importedAt) || nowIso(),
          updatedAt: nowIso(),
        };
        imported.push(devices[id]);
      }
    } else if (src === 'mqtt') {
      for (const device of mqttAdapter.listDevices()) {
        const key = device.id.replace(/^mqtt:/, '');
        if (wanted && !wanted.has(key) && !wanted.has(device.id) && !wanted.has(device.id.replace(/^mqtt:/, 'iot:mqtt:'))) continue;
        const id = `iot:${device.id}`;
        devices[id] = {
          id,
          name: device.name,
          type: device.type,
          domain: device.domain,
          source: 'mqtt',
          adapter: 'mqtt',
          sourceId: device.id,
          state: device.state || null,
          attributes: { uniqueId: device.uniqueId, stateTopic: device.stateTopic, commandTopic: device.commandTopic },
          available: true,
          capabilities: capabilityManifest(device.domain, device.capabilities || ['read'], 'mqtt'),
          commands: device.capabilities || ['read'],
          importedAt: (devices[id] && devices[id].importedAt) || nowIso(),
          updatedAt: nowIso(),
        };
        imported.push(devices[id]);
      }
    } else {
      const list = (lastScan && lastScan.devices) || [];
      for (const device of list) {
        const key = device.usn || device.location;
        if (!key) continue;
        if (wanted && !wanted.has(key) && !wanted.has(device.usn) && !wanted.has(device.location)) continue;
        const id = `iot:ssdp:${shortHash(key)}`;
        devices[id] = {
          id,
          name: device.name || device.server || key,
          type: device.type || 'upnp',
          domain: 'upnp',
          source: 'ssdp',
          adapter: 'ssdp',
          sourceId: key,
          location: device.location || null,
          server: device.server || null,
          state: 'discovered',
          attributes: { location: device.location, usn: device.usn, st: device.st, server: device.server, model: device.model || null },
          available: true,
          capabilities: [{ id: 'iot.upnp.read', name: '只读发现', risk: 'reversible', manualOnly: true, version: IOT_VERSION, evidence: 'possible', adapter: 'ssdp', command: 'read' }],
          commands: ['read'],
          note: 'SSDP 设备仅做发现；控制需接入 Home Assistant 或 MQTT 网关（诚实边界）',
          importedAt: (devices[id] && devices[id].importedAt) || nowIso(),
          updatedAt: nowIso(),
        };
        imported.push(devices[id]);
      }
    }
    if (!imported.length) return { ok: true, imported: 0, skipped: skipped.length, devices: [], source: src, message: wanted ? '没有匹配的 id 可导入' : '没有可导入的设备' };
    saveDevices();
    append('iot.imported', { source: src, count: imported.length, devices: imported.map((device) => ({ id: device.id, name: device.name, type: device.type, source: device.source })) });
    log(`[iot] 已导入 ${imported.length} 个 ${src} 设备`);
    return { ok: true, imported: imported.length, skipped: skipped.length, devices: imported, source: src };
  }

  function listDevices() {
    return { ok: true, count: Object.keys(devices).length, bySource: bySource(), devices: Object.values(devices) };
  }

  function deleteDevice(id) {
    const key = String(id || '');
    const target = devices[key] || Object.values(devices).find((device) => device.id === key || device.sourceId === key);
    if (!target) throw httpError(404, `IoT 设备不存在：${key}`, 'IOT_DEVICE_NOT_FOUND');
    delete devices[target.id];
    saveDevices();
    log(`[iot] 已删除设备 ${target.id}`);
    return { ok: true, removed: target.id };
  }

  async function controlDevice(id, command, params = {}) {
    const raw = String(id || '');
    if (!raw) throw httpError(400, '缺少设备 id', 'INVALID_DEVICE');
    const device = devices[raw] || Object.values(devices).find((item) => item.id === raw || item.sourceId === raw || item.id === `iot:${raw}`);
    const cmd = pickString(command, 60).toLowerCase();
    if (!cmd) throw httpError(400, '缺少 command（如 turn_on/turn_off/toggle/set_brightness）', 'INVALID_COMMAND');
    let result;
    try {
      if (device) {
        if (device.adapter === 'ha') result = await ha.control(device.sourceId, cmd, params);
        else if (device.adapter === 'mqtt') result = await mqttAdapter.publishDevice(device.sourceId, cmd, params);
        else throw httpError(400, `设备 ${device.id} 为 SSDP 只读发现，不能直接控制；请通过 Home Assistant / MQTT 接入后控制`, 'SSDP_READONLY');
        device.state = result.state !== undefined && result.state !== null ? result.state : device.state;
        device.updatedAt = nowIso();
        saveDevices();
      } else if (raw.startsWith('ha:') || raw.includes('.')) {
        // 未导入的 HA 实体也允许直接控制（前端实体面板方便使用）
        result = await ha.control(raw.replace(/^iot:/, ''), cmd, params);
      } else if (raw.startsWith('mqtt:') || raw.startsWith('iot:mqtt:')) {
        result = await mqttAdapter.publishDevice(raw, cmd, params);
      } else {
        throw httpError(404, `IoT 设备不存在：${raw}`, 'IOT_DEVICE_NOT_FOUND');
      }
    } catch (err) {
      append('iot.controlled', { deviceId: device ? device.id : raw, command: cmd, params: params || {}, ok: false, adapter: device ? device.adapter : null, error: String(err && err.message ? err.message : err).slice(0, 200) });
      throw err;
    }
    append('iot.controlled', { deviceId: device ? device.id : raw, command: cmd, params: params || {}, ok: true, adapter: result.adapter || (device && device.adapter) || null });
    log(`[iot] 控制 ${device ? device.id : raw}：${cmd} ok`);
    return { ok: true, deviceId: device ? device.id : raw, command: cmd, result, at: nowIso() };
  }

  function createRoutes() {
    const wrap = (fn) => async (req, res, ctx = {}) => {
      try {
        await fn(req, res, ctx);
      } catch (err) {
        const code = Number(err && err.statusCode) || 500;
        if (!res.headersSent) sendJson(res, code, { ok: false, error: String((err && err.message) || err), code: err && err.code });
        else {
          try {
            res.end();
          } catch { /* ignore */ }
        }
      }
    };
    const requireWrite = (req, ctx) => {
      if (ctx && typeof ctx.authed === 'function') {
        if (!ctx.authed(req)) throw httpError(401, '需要操作令牌', 'NEED_OPERATOR_TOKEN');
      }
    };
    return [
      { method: 'GET', path: '/api/v2/iot/status', handler: wrap(async (req, res) => sendJson(res, 200, status())) },
      { method: 'GET', path: '/api/v2/iot/config', handler: wrap(async (req, res) => sendJson(res, 200, configView())) },
      {
        method: 'PATCH',
        path: '/api/v2/iot/config',
        handler: wrap(async (req, res, ctx) => {
          requireWrite(req, ctx);
          const body = await readBody(req);
          sendJson(res, 200, patchConfig(body));
        }),
      },
      {
        method: 'POST',
        path: '/api/v2/iot/test',
        handler: wrap(async (req, res, ctx) => {
          requireWrite(req, ctx);
          const body = await readBody(req).catch(() => ({}));
          sendJson(res, 200, await test({ target: body.target || 'all' }));
        }),
      },
      {
        method: 'GET',
        path: '/api/v2/iot/discover',
        handler: wrap(async (req, res, ctx) => {
          const query = queryOf(ctx, req);
          const st = query.get('st') || 'ssdp:all';
          const timeoutMs = clampInt(query.get('timeoutMs'), 1000, 15000, 5000);
          sendJson(res, 200, await discover({ st, timeoutMs }));
        }),
      },
      {
        method: 'GET',
        path: '/api/v2/iot/ha/entities',
        handler: wrap(async (req, res, ctx) => {
          const query = queryOf(ctx, req);
          sendJson(res, 200, await listHaEntities({ domain: query.get('domain') || null }));
        }),
      },
      {
        method: 'POST',
        path: '/api/v2/iot/import',
        handler: wrap(async (req, res, ctx) => {
          requireWrite(req, ctx);
          const body = await readBody(req);
          sendJson(res, 200, await importDevices({ source: body.source, ids: body.ids }));
        }),
      },
      { method: 'GET', path: '/api/v2/iot/devices', handler: wrap(async (req, res) => sendJson(res, 200, listDevices())) },
      {
        method: 'GET',
        path: '/api/v2/iot/mqtt/devices',
        handler: wrap(async (req, res) => sendJson(res, 200, { ok: true, count: mqttAdapter.listDevices().length, devices: mqttAdapter.listDevices(), status: mqttAdapter.status() })),
      },
      { method: 'GET', path: '/api/v2/iot/last-discovery', handler: wrap(async (req, res) => sendJson(res, 200, { ok: true, lastScan: lastScan || null })) },
      {
        method: 'POST',
        path: '/api/v2/iot/devices/:id/control',
        handler: wrap(async (req, res, ctx) => {
          requireWrite(req, ctx);
          const params = paramsOf(ctx, req);
          const body = await readBody(req);
          const result = await controlDevice(params.id, body.command || body.action, body.params || body.payload || {});
          sendJson(res, 200, result);
        }),
      },
      {
        method: 'DELETE',
        path: '/api/v2/iot/devices/:id',
        handler: wrap(async (req, res, ctx) => {
          requireWrite(req, ctx);
          const params = paramsOf(ctx, req);
          sendJson(res, 200, deleteDevice(params.id));
        }),
      },
    ];
  }

  const routes = createRoutes();
  // 启动时若配置了 MQTT 则异步连接（不阻塞启动）
  if (config.mqtt.url) {
    setTimeout(() => {
      try {
        mqttAdapter.connect();
      } catch (err) {
        log(`[iot/mqtt] 启动连接失败：${err && err.message ? err.message : err}`);
      }
    }, 50).unref?.();
  }

  return {
    version: IOT_VERSION,
    routes,
    status,
    config: configView,
    patchConfig,
    test,
    discover,
    listHaEntities,
    importDevices,
    listDevices,
    controlDevice,
    deleteDevice,
    close: () => {
      try {
        mqttAdapter.disconnect();
      } catch { /* ignore */ }
    },
    // 供执行器 device.control 识别 iot: 设备后调用
    isIotDeviceId: (id) => /^iot:|^ha:|^mqtt:/.test(String(id || '')),
  };
}

export default createIotService;