// 榫卯 V5 · MQTT 接入（含 Home Assistant MQTT Discovery）
// - 连接 broker（url/用户名/密码/发现前缀可配），断线自动重连（mqtt 包 reconnectPeriod）
// - 订阅 `${prefix}/+/+/config` 自动发现设备（保存 data/iot/mqtt-devices.json），订阅 state topic 更新状态
// - publish 控制到设备命令 topic；连接状态/错误可读
import mqtt from 'mqtt';
import crypto from 'node:crypto';
import { readJson, atomicWriteJson, httpError, nowIso } from './util.js';

export const MQTT_VERSION = '5.0.0';

function normalizeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^(mqtts?|wss?):\/\//i.test(raw)) return raw;
  return `mqtt://${raw}`;
}

function parsePayload(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload === undefined || payload === null ? '' : payload);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function mqttCapabilities(component, config = {}) {
  const caps = [];
  const has = (key) => config && config[key];
  if (has('command_topic')) {
    caps.push('turn_on', 'turn_off');
    if (component === 'light') caps.push('set_brightness');
    if (component === 'cover') caps.push('open', 'close', 'stop');
    if (component === 'media_player') caps.push('play', 'pause', 'play_pause', 'next', 'previous');
    if (component === 'climate') caps.push('set_temperature');
    if (component === 'fan') caps.push('set_percentage');
    if (component === 'switch') caps.push('toggle');
  }
  if (has('brightness_command_topic')) caps.push('set_brightness');
  if (has('temperature_command_topic')) caps.push('set_temperature');
  if (has('position_topic') || has('set_position_topic')) caps.push('set_position');
  if (has('state_topic')) caps.push('read');
  return [...new Set(caps)];
}

export function mapDiscoveryConfig(component, objectId, config = {}) {
  const device = config && typeof config === 'object' ? config : {};
  const name = String(device.name || (device.device && device.device.name) || objectId || 'MQTT 设备');
  return {
    id: `mqtt:${component}:${objectId}`,
    name,
    type: component || 'unknown',
    domain: component || 'unknown',
    component,
    objectId: String(objectId || ''),
    uniqueId: device.uniq_id || `${component}.${objectId}`,
    stateTopic: device.state_topic || null,
    commandTopic: device.command_topic || null,
    brightnessStateTopic: device.brightness_state_topic || null,
    brightnessCommandTopic: device.brightness_command_topic || null,
    temperatureCommandTopic: device.temperature_command_topic || null,
    setPositionTopic: device.set_position_topic || null,
    payloadOn: String(device.payload_on !== undefined ? device.payload_on : 'ON'),
    payloadOff: String(device.payload_off !== undefined ? device.payload_off : 'OFF'),
    available: true,
    capabilities: mqttCapabilities(component, device),
    source: 'mqtt',
    discoveredAt: nowIso(),
    state: null,
  };
}

export function createMqttAdapter({ config = {}, dataDir, log = () => {} } = {}) {
  const file = dataDir ? `${dataDir}/iot/mqtt-devices.json` : null;
  const saved = file ? readJson(file, null) : null;
  const devices = new Map();
  if (saved && saved.devices && typeof saved.devices === 'object') {
    for (const [id, device] of Object.entries(saved.devices)) devices.set(id, device);
  }
  const states = new Map();
  const status = {
    configured: false,
    connected: false,
    connecting: false,
    url: '',
    prefix: 'homeassistant',
    lastError: null,
    lastMessageAt: null,
    subscribedStateTopics: 0,
  };
  let cfg = {
    url: normalizeUrl(config.url),
    username: String(config.username || ''),
    password: String(config.password || ''),
    prefix: String(config.prefix || 'homeassistant').replace(/\/+$/, '') || 'homeassistant',
  };
  let client = null;
  let clientId = `tenon-iot-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

  function persist() {
    if (!file) return;
    const out = { version: 1, updatedAt: nowIso(), devices: {} };
    for (const [id, device] of devices) out.devices[id] = device;
    try {
      atomicWriteJson(file, out);
    } catch (err) {
      log(`[iot/mqtt] 保存发现设备失败：${err && err.message ? err.message : err}`);
    }
  }

  function applyConfig(next = {}) {
    const oldUrl = cfg.url;
    cfg = {
      url: normalizeUrl(next.url !== undefined ? next.url : cfg.url),
      username: next.username !== undefined ? String(next.username || '') : cfg.username,
      password: next.password !== undefined ? String(next.password || '') : cfg.password,
      prefix: next.prefix !== undefined ? String(next.prefix || 'homeassistant').replace(/\/+$/, '') || 'homeassistant' : cfg.prefix,
    };
    status.url = cfg.url;
    status.prefix = cfg.prefix;
    status.configured = !!cfg.url;
    if (client && oldUrl !== cfg.url) {
      disconnect();
      if (cfg.url) connect();
    }
    return { ...cfg, url: cfg.url, prefix: cfg.prefix };
  }

  function stateTopics() {
    const topics = new Set();
    for (const device of devices.values()) {
      if (device.stateTopic) topics.add(device.stateTopic);
      if (device.brightnessStateTopic) topics.add(device.brightnessStateTopic);
    }
    return [...topics];
  }

  function subscribeTopics() {
    if (!client || !status.connected) return;
    const discovery = `${cfg.prefix}/+/+/config`;
    client.subscribe([discovery, ...stateTopics()], { qos: 1 }, (err) => {
      if (err) status.lastError = String(err.message || err);
    });
  }

  function handleDiscovery(topic, payload) {
    const match = new RegExp(`^${cfg.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/]+)/([^/]+)/config$`).exec(topic);
    if (!match) return;
    const component = match[1];
    const objectId = match[2];
    const config = parsePayload(payload);
    if (!config || typeof config !== 'object') return;
    const device = mapDiscoveryConfig(component, objectId, config);
    devices.set(device.id, device);
    persist();
    if (device.stateTopic) {
      try {
        client.subscribe(device.stateTopic, { qos: 1 });
        status.subscribedStateTopics = stateTopics().length;
      } catch {
        /* ignore */
      }
    }
    log(`[iot/mqtt] 发现设备 ${device.id}（${device.name}，${component}）`);
  }

  function handleState(topic, payload) {
    const value = parsePayload(payload);
    status.lastMessageAt = nowIso();
    let hit = false;
    for (const device of devices.values()) {
      if (device.stateTopic === topic) {
        device.state = typeof value === 'string' ? value : JSON.stringify(value);
        device.updatedAt = nowIso();
        states.set(device.id, device.state);
        hit = true;
      }
      if (device.brightnessStateTopic === topic) {
        device.brightness = Number(value);
        device.updatedAt = nowIso();
        hit = true;
      }
    }
    if (hit) persist();
    return hit;
  }

  function connect() {
    if (!cfg.url) {
      status.configured = false;
      status.lastError = 'MQTT 未配置（url 为空）';
      return { ok: false, error: status.lastError };
    }
    if (client) return { ok: true, already: true, connected: status.connected };
    status.configured = true;
    status.connecting = true;
    try {
      client = mqtt.connect(cfg.url, {
        username: cfg.username || undefined,
        password: cfg.password || undefined,
        clientId,
        reconnectPeriod: 3000,
        connectTimeout: 8000,
        clean: true,
        protocolVersion: 4,
      });
    } catch (err) {
      status.connecting = false;
      status.lastError = String(err && err.message ? err.message : err);
      client = null;
      return { ok: false, error: status.lastError };
    }
    client.on('connect', () => {
      status.connected = true;
      status.connecting = false;
      status.lastError = null;
      log(`[iot/mqtt] 已连接 ${cfg.url}`);
      subscribeTopics();
    });
    client.on('reconnect', () => {
      status.connecting = true;
      status.connected = false;
    });
    client.on('close', () => {
      status.connected = false;
      status.connecting = !!cfg.url;
    });
    client.on('error', (err) => {
      status.lastError = String(err && err.message ? err.message : err);
      status.connected = false;
    });
    client.on('message', (topic, payload) => {
      if (topic.endsWith('/config') && topic.startsWith(`${cfg.prefix}/`)) handleDiscovery(topic, payload);
      else handleState(topic, payload);
    });
    return { ok: true, connecting: true, url: cfg.url };
  }

  function disconnect() {
    if (client) {
      try {
        client.end(true);
      } catch {
        /* ignore */
      }
      client = null;
    }
    status.connected = false;
    status.connecting = false;
    return { ok: true };
  }

  function listDevices() {
    return [...devices.values()].map((device) => ({ ...device, state: states.has(device.id) ? states.get(device.id) : device.state }));
  }

  function findDevice(id) {
    const raw = String(id || '').replace(/^iot:/, '');
    return devices.get(raw) || devices.get(String(id)) || [...devices.values()].find((device) => device.uniqueId === raw) || null;
  }

  function buildPublish(device, command, params = {}) {
    const cmd = String(command || '').trim().toLowerCase();
    const p = params && typeof params === 'object' ? params : {};
    const current = String(device.state || '').toUpperCase();
    if (['turn_on', 'on'].includes(cmd)) return { topic: device.commandTopic, payload: device.payloadOn || 'ON', command: 'turn_on' };
    if (['turn_off', 'off'].includes(cmd)) return { topic: device.commandTopic, payload: device.payloadOff || 'OFF', command: 'turn_off' };
    if (cmd === 'toggle') return { topic: device.commandTopic, payload: current === 'ON' ? device.payloadOff || 'OFF' : device.payloadOn || 'ON', command: 'toggle' };
    if (['set_brightness', 'brightness'].includes(cmd)) {
      if (!device.brightnessCommandTopic) throw httpError(400, `设备 ${device.id} 不支持亮度控制（无 brightness_command_topic）`, 'UNSUPPORTED_COMMAND');
      const pct = Number(p.brightness_pct !== undefined ? p.brightness_pct : p.brightness !== undefined ? (Number(p.brightness) / 255) * 100 : NaN);
      if (!Number.isFinite(pct)) throw httpError(400, 'set_brightness 需要 brightness_pct（0-100）', 'INVALID_PARAMS');
      const scaled = Math.max(0, Math.min(255, Math.round((pct / 100) * 255)));
      return { topic: device.brightnessCommandTopic, payload: String(scaled), command: 'set_brightness' };
    }
    if (['open', 'close', 'stop'].includes(cmd)) return { topic: device.commandTopic, payload: cmd.toUpperCase(), command: cmd };
    if (['play', 'pause', 'play_pause', 'next', 'previous'].includes(cmd)) return { topic: device.commandTopic, payload: cmd.toUpperCase(), command: cmd };
    if (['set_temperature', 'temperature'].includes(cmd)) {
      if (!device.temperatureCommandTopic) throw httpError(400, `设备 ${device.id} 不支持温度设置（无 temperature_command_topic）`, 'UNSUPPORTED_COMMAND');
      const value = Number(p.temperature !== undefined ? p.temperature : p.value);
      if (!Number.isFinite(value)) throw httpError(400, 'set_temperature 需要 temperature（数字）', 'INVALID_PARAMS');
      return { topic: device.temperatureCommandTopic, payload: String(value), command: 'set_temperature' };
    }
    if (['set_position', 'position'].includes(cmd)) {
      if (!device.setPositionTopic) throw httpError(400, `设备 ${device.id} 不支持位置控制（无 set_position_topic）`, 'UNSUPPORTED_COMMAND');
      const value = Number(p.position !== undefined ? p.position : p.value);
      if (!Number.isFinite(value)) throw httpError(400, 'set_position 需要 position（0-100）', 'INVALID_PARAMS');
      return { topic: device.setPositionTopic, payload: String(Math.max(0, Math.min(100, value))), command: 'set_position' };
    }
    throw httpError(400, `MQTT 设备 ${device.id} 不支持命令 ${command}`, 'UNSUPPORTED_COMMAND');
  }

  async function publishDevice(id, command, params = {}) {
    const device = findDevice(id);
    if (!device) throw httpError(404, `MQTT 设备不存在：${id}`, 'MOT_DEVICE_NOT_FOUND');
    if (!client || !status.connected) throw httpError(503, 'MQTT 未连接，无法下发控制指令', 'MQTT_NOT_CONNECTED');
    const pub = buildPublish(device, command, params);
    if (!pub.topic) throw httpError(400, `设备 ${device.id} 没有命令 topic，无法控制`, 'UNSUPPORTED_COMMAND');
    await new Promise((resolve, reject) => {
      client.publish(pub.topic, pub.payload, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
    if (pub.command === 'turn_on') {
      device.state = device.payloadOn || 'ON';
      states.set(device.id, device.state);
    } else if (pub.command === 'turn_off') {
      device.state = device.payloadOff || 'OFF';
      states.set(device.id, device.state);
    }
    return { ok: true, adapter: 'mqtt', deviceId: device.id, command: pub.command, topic: pub.topic, payload: pub.payload, state: device.state || null, at: nowIso() };
  }

  return {
    kind: 'mqtt',
    get config() {
      return { ...cfg };
    },
    applyConfig,
    connect,
    disconnect,
    status: () => ({ ...status, devices: devices.size, savedDevices: devices.size }),
    listDevices,
    findDevice,
    publishDevice,
    isConnected: () => !!status.connected,
  };
}

export default { MQTT_VERSION, mqttCapabilities, mapDiscoveryConfig, createMqttAdapter };