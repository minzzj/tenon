// 榫卯 V5 · IoT 接入真实自测（Home Assistant REST 桩 / aedes MQTT broker / SSDP UDP 桩 + 真实网卡 M-SEARCH /
// /api/v2/iot/* 路由真 HTTP / node-agent system.notify 真实通知 / agent 注册 21 能力）
// 运行：node test/verify/run-v5-iot.mjs
// 产出：_internal/op-data/v5-iot-evidence.json + v5-iot-evidence.md
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { createIotService, ROUTES } from '../../server/lib/iot/index.js';
import { createHomeAssistantClient, buildServiceRequest } from '../../server/lib/iot/homeassistant.js';
import { createMqttAdapter } from '../../server/lib/iot/mqtt.js';
import { parseSsdpResponse, buildSearchMessage, ssdpDiscover, typeLabel } from '../../server/lib/iot/ssdp.js';
import { findNotifyCapability } from '../../node-agent/notifier.js';
import { startStubHub } from '../../node-agent/__tests__/stub-hub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-v5-iot-'));
const EVID_DIR = path.join(REPO, '_internal', 'op-data');
const STARTED_AT = new Date();
const evidence = { kind: 'v5-iot', startedAt: STARTED_AT.toISOString(), platform: process.platform, node: process.version, checks: [], sections: {} };
let failures = 0;
const cleanups = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(id, title, ok, detail, extra) {
  const item = { id, title, ok: !!ok, detail: detail === undefined ? '' : String(detail), extra: extra || null, at: new Date().toISOString() };
  evidence.checks.push(item);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}${detail ? ' · ' + detail : ''}`);
  return item;
}
async function waitFor(fn, label, timeout = 10000, interval = 100) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await Promise.resolve().then(fn).catch(() => null);
    if (value) return value;
    await sleep(interval);
  }
  throw new Error(`等待超时：${label}`);
}
async function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      resolve({ text, json });
    });
    req.on('error', reject);
  });
}
function sendJson(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// ---------------------------------------------------------------- 1) HA 桩
const HA_ENTITIES = [
  { entity_id: 'light.living_room', state: 'off', attributes: { friendly_name: '客厅灯', brightness: 120, supported_features: 41 }, last_changed: '2026-10-30T13:00:00Z' },
  { entity_id: 'switch.fan', state: 'on', attributes: { friendly_name: '风扇开关', device_class: 'switch' }, last_changed: '2026-10-30T13:01:00Z' },
  { entity_id: 'sensor.temperature', state: '23.5', attributes: { friendly_name: '温度', unit_of_measurement: '°C', device_class: 'temperature' }, last_changed: '2026-10-30T13:02:00Z' },
  { entity_id: 'climate.ac', state: 'cool', attributes: { friendly_name: '空调', current_temperature: 26, temperature: 24, hvac_mode: 'cool' }, last_changed: '2026-10-30T13:03:00Z' },
  { entity_id: 'media_player.tv', state: 'playing', attributes: { friendly_name: '客厅电视', media_title: '新闻', volume_level: 0.4 }, last_changed: '2026-10-30T13:04:00Z' },
  { entity_id: 'cover.curtain', state: 'closed', attributes: { friendly_name: '窗帘', device_class: 'curtain' }, last_changed: '2026-10-30T13:05:00Z' },
];

async function startHaStub() {
  const state = { serviceCalls: [], statesRequests: 0, authMissing: 0, entities: HA_ENTITIES.map((entity) => ({ ...entity, attributes: { ...entity.attributes } })) };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) state.authMissing += 1;
    if (url.pathname === '/api/') return sendJson(res, 200, { message: 'API running.', version: '2025.10.0', location_name: '桩 Home Assistant' });
    if (url.pathname === '/api/states' && req.method === 'GET') {
      state.statesRequests += 1;
      return sendJson(res, 200, state.entities);
    }
    const stateMatch = /^\/api\/states\/(.+)$/.exec(url.pathname);
    if (stateMatch && req.method === 'GET') {
      const entityId = decodeURIComponent(stateMatch[1]);
      const hit = state.entities.find((entity) => entity.entity_id === entityId);
      if (!hit) return sendJson(res, 404, { message: 'Entity not found' });
      return sendJson(res, 200, hit);
    }
    const serviceMatch = /^\/api\/services\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (serviceMatch && req.method === 'POST') {
      const body = await readBody(req);
      const call = { domain: serviceMatch[1], service: serviceMatch[2], body: body.json, auth: auth.replace('Bearer ', '') };
      state.serviceCalls.push(call);
      const target = body.json && body.json.entity_id ? state.entities.find((entity) => entity.entity_id === body.json.entity_id) : null;
      if (target) {
        if (serviceMatch[1] === 'light' || serviceMatch[1] === 'switch') target.state = serviceMatch[2] === 'turn_off' ? 'off' : 'on';
        if (serviceMatch[1] === 'cover') target.state = serviceMatch[2] === 'open_cover' ? 'open' : 'closed';
        if (serviceMatch[1] === 'climate') target.attributes.temperature = body.json.temperature;
      }
      return sendJson(res, 200, target ? [{ entity_id: target.entity_id, state: target.state }] : []);
    }
    return sendJson(res, 404, { message: 'not found: ' + url.pathname });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, state };
}

// ---------------------------------------------------------------- 2) aedes MQTT broker
async function startMqttBroker() {
  // aedes v1：默认导出已移除，用 Aedes.createBroker()（async）
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  cleanups.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => {
      try {
        broker.close(() => resolve());
      } catch {
        resolve();
      }
    });
  });
  return { port, url: `mqtt://127.0.0.1:${port}`, broker };
}

// ---------------------------------------------------------------- 3) SSDP UDP 桩（模拟局域网 UPnP 设备响应）
async function startSsdpStub({ friendlyName = '桩 智能电视', deviceType = 'urn:schemas-upnp-org:device:MediaRenderer:1' } = {}) {
  const httpServer = http.createServer((req, res) => {
    if (String(req.url).includes('desc.xml')) {
      res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
      res.end(`<?xml version="1.0"?><root><device><deviceType>${deviceType}</deviceType><friendlyName>${friendlyName}</friendlyName><manufacturer>TenonStub</manufacturer><modelName>StubTV-1</modelName></device></root>`);
      return;
    }
    res.writeHead(404);
    res.end('no');
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const httpPort = httpServer.address().port;
  const udp = dgram.createSocket('udp4');
  const received = [];
  udp.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8');
    received.push({ from: `${rinfo.address}:${rinfo.port}`, head: text.split(/\r?\n/).slice(0, 4).join(' | ') });
    const response = [
      'HTTP/1.1 200 OK',
      `LOCATION: http://127.0.0.1:${httpPort}/desc.xml`,
      'CACHE-CONTROL: max-age=1800',
      'EXT:',
      `ST: ${deviceType}`,
      'USN: uuid:tenon-stub-tv::urn:schemas-upnp-org:device:MediaRenderer:1',
      'SERVER: TenonStub/1.0 UPnP/1.1 StubTV/1.0',
      '',
      '',
    ].join('\r\n');
    udp.send(response, rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
  const udpPort = udp.address().port;
  cleanups.push(async () => {
    try { udp.close(); } catch { /* ignore */ }
    await new Promise((resolve) => httpServer.close(resolve));
  });
  return { udpPort, httpPort, received };
}
// ---------------------------------------------------------------- 4) 最小 v2 挂载器（模拟 Lead 的 v2/index.js 挂载本模块路由）
function matchPath(pattern, pathname) {
  const pp = String(pattern).split('/').filter(Boolean);
  const rp = String(pathname).split('/').filter(Boolean);
  if (pp.length !== rp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i += 1) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(rp[i]);
    else if (pp[i] !== rp[i]) return null;
  }
  return params;
}

async function startIotHttpServer(service, { authed = () => true } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let matched = null;
    for (const route of service.routes) {
      if (route.method !== req.method) continue;
      const params = matchPath(route.path, url.pathname);
      if (params) {
        matched = { route, params };
        break;
      }
    }
    if (!matched) return sendJson(res, 404, { ok: false, error: '未知 v2 接口：' + url.pathname });
    await matched.route.handler(req, res, { params: matched.params, url, authed });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}` };
}

async function apiCall(base, pathname, { method = 'GET', body, token = 'stub-token' } = {}) {
  const headers = { 'x-tenon-token': token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

// ---------------------------------------------------------------- 5) 各段测试
async function testHomeAssistant() {
  const section = {};
  const stub = await startHaStub();
  section.stubUrl = stub.url;
  const ha = createHomeAssistantClient({ baseUrl: stub.url, token: 'stub-token', log: () => {} });
  const testResult = await ha.test();
  section.test = testResult;
  check('ha-test', 'HA test() → GET /api/ 版本', testResult.ok === true && /2025/.test(String(testResult.version)), `version=${testResult.version}`);
  const entities = await ha.listEntities();
  section.entityCount = entities.length;
  section.entitySample = entities.slice(0, 3);
  const light = entities.find((entity) => entity.id === 'ha:light.living_room');
  check('ha-entities', 'HA listEntities() → 统一设备映射（6 个实体）', entities.length === 6 && light && light.type === 'light' && light.domain === 'light' && String(light.name).includes('客厅灯'), `${entities.length} 个实体`);
  check('ha-capabilities', 'HA 能力映射（light 支持 turn_on/turn_off/toggle/set_brightness）', ['turn_on', 'turn_off', 'toggle', 'set_brightness'].every((cmd) => light.capabilities.includes(cmd)), light.capabilities.join(','));
  const lightOn = await ha.control('ha:light.living_room', 'set_brightness', { brightness_pct: 42 });
  const callLight = stub.state.serviceCalls[stub.state.serviceCalls.length - 1];
  section.haControl = { request: callLight, result: { service: lightOn.service, state: lightOn.state } };
  check('ha-control-light', 'HA control(light, set_brightness) → POST /api/services/light/turn_on {brightness_pct:42}', callLight.domain === 'light' && callLight.service === 'turn_on' && callLight.body.entity_id === 'light.living_room' && callLight.body.brightness_pct === 42, JSON.stringify(callLight.body));
  await ha.control('ha:switch.fan', 'toggle');
  const callSwitch = stub.state.serviceCalls[stub.state.serviceCalls.length - 1];
  check('ha-control-switch', 'HA control(switch, toggle) → switch.toggle', callSwitch.domain === 'switch' && callSwitch.service === 'toggle', JSON.stringify(callSwitch.body));
  await ha.control('ha:climate.ac', 'set_temperature', { temperature: 24 });
  const callClimate = stub.state.serviceCalls[stub.state.serviceCalls.length - 1];
  check('ha-control-climate', 'HA control(climate, set_temperature) → climate.set_temperature {temperature:24}', callClimate.domain === 'climate' && callClimate.service === 'set_temperature' && callClimate.body.temperature === 24, JSON.stringify(callClimate.body));
  await ha.control('ha:cover.curtain', 'open');
  const callCover = stub.state.serviceCalls[stub.state.serviceCalls.length - 1];
  check('ha-control-cover', 'HA control(cover, open) → cover.open_cover', callCover.domain === 'cover' && callCover.service === 'open_cover', JSON.stringify(callCover.body));
  await ha.control('ha:media_player.tv', 'play_pause');
  const callMedia = stub.state.serviceCalls[stub.state.serviceCalls.length - 1];
  check('ha-control-media', 'HA control(media_player, play_pause) → media_player.media_play_pause', callMedia.domain === 'media_player' && callMedia.service === 'media_play_pause', JSON.stringify(callMedia.body));
  const state = await ha.getState('ha:switch.fan');
  check('ha-get-state', 'HA getState() 返回单实体状态', state && state.id === 'ha:switch.fan' && state.state === 'on', `state=${state && state.state}`);
  const mapping = ['light.living_room|set_brightness', 'climate.ac|set_temperature', 'cover.curtain|open', 'media_player.tv|play_pause'].map((pair) => {
    const [entityId, command] = pair.split('|');
    return buildServiceRequest(entityId, command, { brightness_pct: 50, temperature: 25 });
  });
  section.mapping = mapping;
  check('ha-auth', 'HA 请求始终带 Bearer token', stub.state.authMissing === 0, `无 token 请求数=${stub.state.authMissing}`);
  section.serviceCallCount = stub.state.serviceCalls.length;
  evidence.sections.ha = section;
  return { ha, stub };
}

async function testMqtt() {
  const section = {};
  const broker = await startMqttBroker();
  section.brokerUrl = broker.url;
  const dataDir = path.join(TMP, 'data');
  const adapter = createMqttAdapter({ config: { url: broker.url, prefix: 'homeassistant' }, dataDir, log: () => {} });
  const connected = adapter.connect();
  await waitFor(() => adapter.isConnected(), 'MQTT 连接', 8000);
  check('mqtt-connect', 'MQTT 连接 aedes broker（自动重连配置）', adapter.isConnected() === true, broker.url);
  const publisher = mqtt.connect(broker.url);
  cleanups.push(() => new Promise((resolve) => publisher.end(true, resolve)));
  await new Promise((resolve) => publisher.on('connect', resolve));
  const discovery = {
    name: '客厅灯', uniq_id: 'light_living_v5', state_topic: 'homeassistant/light/living/state',
    command_topic: 'homeassistant/light/living/set', brightness_state_topic: 'homeassistant/light/living/brightness/state',
    brightness_command_topic: 'homeassistant/light/living/brightness/set', payload_on: 'ON', payload_off: 'OFF',
  };
  await new Promise((resolve) => publisher.publish('homeassistant/light/living/config', JSON.stringify(discovery), { qos: 1, retain: true }, resolve));
  await waitFor(() => adapter.listDevices().length >= 1, 'MQTT Discovery 发现设备', 8000);
  const devices = adapter.listDevices();
  section.discovered = devices;
  const dev = devices[0];
  check('mqtt-discovery', 'MQTT Discovery：订阅 homeassistant/+/+/config 自动发现设备', dev && dev.id === 'mqtt:light:living' && dev.name === '客厅灯' && dev.commandTopic === discovery.command_topic, dev ? `${dev.id}（${dev.name}）` : '未发现');
  await new Promise((resolve) => publisher.publish(discovery.state_topic, 'ON', { qos: 1 }, resolve));
  await waitFor(() => (adapter.findDevice('mqtt:light:living') || {}).state === 'ON', 'MQTT 状态更新', 8000);
  check('mqtt-state', 'MQTT 订阅 state topic 更新设备状态', (adapter.findDevice('mqtt:light:living') || {}).state === 'ON', 'state=ON');
  const commands = [];
  await new Promise((resolve) => publisher.subscribe(discovery.command_topic, resolve));
  await new Promise((resolve) => publisher.subscribe(discovery.brightness_command_topic, resolve));
  publisher.on('message', (topic, payload) => commands.push({ topic, payload: payload.toString() }));
  const brightnessResult = await adapter.publishDevice('mqtt:light:living', 'set_brightness', { brightness_pct: 50 });
  await waitFor(() => commands.length >= 1, 'broker 收到亮度指令', 5000);
  section.brightnessPublish = { result: brightnessResult, received: commands[commands.length - 1] };
  check('mqtt-publish-brightness', 'MQTT publish 亮度 → 目标 topic payload=128（50%）', commands.some((item) => item.topic === discovery.brightness_command_topic && item.payload === '128'), JSON.stringify(commands[commands.length - 1]));
  const onResult = await adapter.publishDevice('mqtt:light:living', 'turn_on', {});
  await waitFor(() => commands.some((item) => item.topic === discovery.command_topic && item.payload === 'ON'), 'broker 收到开灯指令', 5000);
  section.turnOnPublish = onResult;
  check('mqtt-publish-on', 'MQTT publish turn_on → command topic payload=ON', commands.some((item) => item.topic === discovery.command_topic && item.payload === 'ON'), onResult.payload);
  const savedFile = path.join(dataDir, 'iot', 'mqtt-devices.json');
  check('mqtt-persist', 'MQTT 发现设备持久化 data/iot/mqtt-devices.json', fs.existsSync(savedFile) && fs.readFileSync(savedFile, 'utf8').includes('mqtt:light:living'), savedFile);
  section.persistFile = savedFile;
  section.status = adapter.status();
  evidence.sections.mqtt = section;
  return { adapter, publisher, broker };
}

async function testSsdp() {
  const section = {};
  const msg = buildSearchMessage('ssdp:all', { mx: 3 });
  check('ssdp-message', 'SSDP M-SEARCH 报文格式（239.255.255.250:1900）', msg.startsWith('M-SEARCH * HTTP/1.1') && msg.includes('HOST: 239.255.255.250:1900') && msg.includes('ST: ssdp:all'), msg.split(/\r?\n/)[0]);
  const sample = 'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.10/desc.xml\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:abc::urn:schemas-upnp-org:device:MediaRenderer:1\r\nSERVER: Linux/4.0 UPnP/1.0\r\n\r\n';
  const parsed = parseSsdpResponse(sample);
  check('ssdp-parse', 'SSDP 响应解析（LOCATION/USN/ST/SERVER）', parsed && parsed.location.includes('192.168.1.10') && parsed.server.includes('UPnP'), JSON.stringify(parsed));
  check('ssdp-parse-invalid', 'SSDP 非 200 响应被忽略', parseSsdpResponse('NOT HTTP\r\n\r\n') === null);
  const stub = await startSsdpStub();
  const localResult = await ssdpDiscover({ address: '127.0.0.1', port: stub.udpPort, timeoutMs: 1500, log: () => {} });
  section.localStub = { result: localResult, received: stub.received.slice(0, 3), udpPort: stub.udpPort };
  check('ssdp-local-stub', 'SSDP 真实 UDP M-SEARCH → 本地 UDP 桩响应 + UPnP 描述解析 friendlyName', localResult.ok === true && localResult.count === 1 && String(localResult.devices[0].name).includes('桩 智能电视'), `${localResult.count} 条响应，name=${localResult.devices[0] && localResult.devices[0].name}`);
  check('ssdp-stub-received', 'SSDP 桩确实收到 M-SEARCH 报文', stub.received.length >= 1, JSON.stringify(stub.received[0] || null));
  const realResult = await ssdpDiscover({ st: 'ssdp:all', timeoutMs: 3500, fetchDescriptions: false, log: () => {} });
  section.realNetwork = { ok: realResult.ok, count: realResult.count, ms: realResult.ms, devices: (realResult.devices || []).slice(0, 5), errors: realResult.errors || [] };
  check('ssdp-real-network', '真实网卡 M-SEARCH（ssdp:all，5s 窗口不崩，无设备记录 0 条也可）', realResult.ok === true, `${realResult.count} 条响应 / ${realResult.ms}ms`);
  evidence.sections.ssdp = section;
  return { stub, localResult };
}
async function testManager({ ha, haStub, mqttAdapter, ssdpStub }) {
  const section = {};
  const dataDir = path.join(TMP, 'data');
  const ledger = { events: [], append(type, data, actor) { this.events.push({ type, data, actor, at: new Date().toISOString() }); } };
  const ssdpStubFn = (args = {}) => ssdpDiscover({ ...args, address: '127.0.0.1', port: ssdpStub.udpPort, timeoutMs: Math.min(Number(args.timeoutMs) || 2000, 1500), log: () => {} });
  const service = createIotService({ root: REPO, dataDir, ledger, haClient: ha, mqttAdapter, ssdpDiscoverFn: ssdpStubFn, log: () => {} });
  cleanups.push(() => service.close());
  const srv = await startIotHttpServer(service);
  const mqttUrl = mqttAdapter.config.url;

  let r = await apiCall(srv.url, '/api/v2/iot/status');
  section.statusInitial = r.data;
  check('iot-status-initial', 'GET /iot/status 初始状态（未配置、0 设备）', r.status === 200 && r.data.ok === true && r.data.ha.configured === false && r.data.devices.total === 0, `devices=${r.data.devices && r.data.devices.total}`);

  r = await apiCall(srv.url, '/api/v2/iot/config', { method: 'PATCH', body: { ha: { baseUrl: haStub.url, token: 'stub-token' }, mqtt: { url: mqttUrl, prefix: 'homeassistant' } } });
  section.configPatch = r.data;
  check('iot-config-patch', 'PATCH /iot/config 保存 HA/MQTT 配置（token 脱敏返回）', r.status === 200 && r.data.ok === true && String(r.data.ha.tokenMasked).includes('••••') && !JSON.stringify(r.data).includes('stub-token'), `tokenMasked=${r.data.ha && r.data.ha.tokenMasked}`);

  r = await apiCall(srv.url, '/api/v2/iot/config');
  check('iot-config-mask', 'GET /iot/config 只返回脱敏 token', r.status === 200 && String(r.data.ha.tokenMasked).includes('••••') && !JSON.stringify(r.data).includes('stub-token'), String(r.data.ha && r.data.ha.tokenMasked));

  r = await apiCall(srv.url, '/api/v2/iot/test', { method: 'POST', body: {} });
  section.test = r.data;
  check('iot-test', 'POST /iot/test 分别测 HA（版本）与 MQTT（连接）', r.status === 200 && r.data.ha && r.data.ha.ok === true && r.data.mqtt && r.data.mqtt.ok === true, `HA=${r.data.ha && r.data.ha.version}，MQTT connected=${r.data.mqtt && r.data.mqtt.connected}`);

  r = await apiCall(srv.url, '/api/v2/iot/ha/entities');
  section.entities = { count: r.data.count, sample: (r.data.entities || []).slice(0, 2) };
  check('iot-ha-entities', 'GET /iot/ha/entities 返回 HA 实体', r.status === 200 && r.data.count === 6, `${r.data.count} 个实体`);

  r = await apiCall(srv.url, '/api/v2/iot/import', { method: 'POST', body: { source: 'ha', ids: ['ha:light.living_room', 'ha:switch.fan'] } });
  section.importHa = { imported: r.data.imported, devices: (r.data.devices || []).map((device) => device.id) };
  check('iot-import-ha', 'POST /iot/import source=ha 写入设备（id 前缀 iot:）', r.status === 200 && r.data.imported === 2 && r.data.devices.every((device) => String(device.id).startsWith('iot:')), JSON.stringify(section.importHa.devices));

  r = await apiCall(srv.url, '/api/v2/iot/devices');
  section.devices = r.data;
  const importedLight = (r.data.devices || []).find((device) => device.id === 'iot:ha:light.living_room');
  check('iot-devices', 'GET /iot/devices 返回已接入设备（capabilities 标记 adapter）', r.data.count === 2 && importedLight && importedLight.capabilities[0].adapter === 'ha', `${r.data.count} 台；bySource=${JSON.stringify(r.data.bySource)}`);

  const callsBefore = haStub.state.serviceCalls.length;
  r = await apiCall(srv.url, '/api/v2/iot/devices/iot:ha:light.living_room/control', { method: 'POST', body: { command: 'turn_on', params: { brightness_pct: 30 } } });
  const lastCall = haStub.state.serviceCalls[haStub.state.serviceCalls.length - 1];
  section.controlHa = { status: r.status, call: lastCall, response: { ok: r.data.ok, deviceId: r.data.deviceId } };
  check('iot-control-ha', 'POST /iot/devices/:id/control → HA light.turn_on {brightness_pct:30}', r.status === 200 && lastCall && lastCall.body.brightness_pct === 30 && haStub.state.serviceCalls.length === callsBefore + 1, JSON.stringify(lastCall && lastCall.body));

  r = await apiCall(srv.url, '/api/v2/iot/import', { method: 'POST', body: { source: 'mqtt' } });
  section.importMqtt = { imported: r.data.imported, devices: (r.data.devices || []).map((device) => device.id) };
  check('iot-import-mqtt', 'POST /iot/import source=mqtt 导入发现的 MQTT 设备', r.status === 200 && r.data.imported >= 1 && r.data.devices.some((device) => String(device.id).startsWith('iot:mqtt:')), JSON.stringify(section.importMqtt.devices));

  r = await apiCall(srv.url, '/api/v2/iot/devices/iot:mqtt:light:living/control', { method: 'POST', body: { command: 'set_brightness', params: { brightness_pct: 40 } } });
  section.controlMqtt = r.data;
  check('iot-control-mqtt', 'POST /iot/devices/:id/control → MQTT publish 成功', r.status === 200 && r.data.ok === true && r.data.result && r.data.result.adapter === 'mqtt', r.data.result ? `${r.data.result.topic} = ${r.data.result.payload}` : String(r.data.error));

  r = await apiCall(srv.url, '/api/v2/iot/discover?st=ssdp:all&timeoutMs=1500');
  section.discover = { status: r.status, count: r.data.count, devices: (r.data.devices || []).map((device) => device.name) };
  check('iot-discover', 'GET /iot/discover?st=ssdp:all 触发真实 SSDP 发现', r.status === 200 && r.data.ok === true && r.data.count >= 1, `${r.data.count} 台：${(section.discover.devices || []).join('、')}`);

  r = await apiCall(srv.url, '/api/v2/iot/import', { method: 'POST', body: { source: 'ssdp' } });
  section.importSsdp = { imported: r.data.imported, devices: (r.data.devices || []).map((device) => device.id) };
  check('iot-import-ssdp', 'POST /iot/import source=ssdp 导入 SSDP 设备（只读）', r.status === 200 && r.data.imported >= 1, JSON.stringify(section.importSsdp.devices));
  const ssdpDeviceId = (section.importSsdp.devices || [])[0];
  if (ssdpDeviceId) {
    r = await apiCall(srv.url, `/api/v2/iot/devices/${encodeURIComponent(ssdpDeviceId)}/control`, { method: 'POST', body: { command: 'turn_on' } });
    section.controlSsdp = { status: r.status, error: r.data.error };
    check('iot-control-ssdp-readonly', 'SSDP 只读设备控制返回可读错误', r.status === 400 && String(r.data.error).includes('SSDP'), `HTTP ${r.status}：${String(r.data.error).slice(0, 80)}`);
  }

  r = await apiCall(srv.url, '/api/v2/iot/devices', { method: 'GET' });
  const beforeDelete = r.data.count;
  r = await apiCall(srv.url, `/api/v2/iot/devices/${encodeURIComponent('iot:ssdp:' + 'nonexistent')}`, { method: 'DELETE' });
  const missingDelete = { status: r.status, error: r.data.error };
  const deleteTarget = (section.importSsdp.devices || [])[0] || 'iot:ha:light.living_room';
  r = await apiCall(srv.url, `/api/v2/iot/devices/${encodeURIComponent(deleteTarget)}`, { method: 'DELETE' });
  const afterList = await apiCall(srv.url, '/api/v2/iot/devices');
  section.deleteDevice = { beforeDelete, afterDelete: afterList.data.count, removed: r.data.removed, missingDelete };
  check('iot-delete', 'DELETE /iot/devices/:id 删除设备（不存在给 404）', r.status === 200 && r.data.ok === true && afterList.data.count === beforeDelete - 1 && missingDelete.status === 404, `删除 ${deleteTarget}；${beforeDelete} → ${afterList.data.count}`);

  const authServer = await startIotHttpServer(service, { authed: () => false });
  r = await apiCall(authServer.url, '/api/v2/iot/config', { method: 'PATCH', body: { ha: { baseUrl: haStub.url } } });
  check('iot-auth', '写接口无鉴权返回 401', r.status === 401, `HTTP ${r.status}`);

  // 持久化文件与账本
  const configFile = path.join(dataDir, 'iot', 'config.json');
  const devicesFile = path.join(dataDir, 'devices', 'iot-devices.json');
  const savedConfig = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null;
  section.files = { configFile, devicesFile, configSaved: !!savedConfig, rawTokenStored: !!(savedConfig && savedConfig.ha && savedConfig.ha.token === 'stub-token'), devicesSaved: fs.existsSync(devicesFile) && fs.readFileSync(devicesFile, 'utf8').includes('iot:ha:light.living_room'), mqttDevicesSaved: fs.existsSync(path.join(dataDir, 'iot', 'mqtt-devices.json')) };
  check('iot-persist', '配置/设备落盘（data/iot/config.json、data/devices/iot-devices.json）', section.files.configSaved && section.files.rawTokenStored && section.files.devicesSaved && section.files.mqttDevicesSaved, JSON.stringify({ configSaved: section.files.configSaved, devicesSaved: section.files.devicesSaved, mqttSaved: section.files.mqttDevicesSaved }));

  const eventTypes = ledger.events.map((event) => event.type);
  section.ledger = { count: ledger.events.length, types: [...new Set(eventTypes)], sample: ledger.events.slice(-4) };
  check('iot-ledger', '账本写入 iot.imported / iot.controlled / iot.discovered', ['iot.imported', 'iot.controlled', 'iot.discovered'].every((type) => eventTypes.includes(type)), section.ledger.types.join(','));
  const controlled = ledger.events.find((event) => event.type === 'iot.controlled' && event.data.ok === true);
  check('iot-ledger-controlled', 'iot.controlled 事件含 deviceId/command/adapter', controlled && controlled.data.deviceId && controlled.data.command && controlled.data.adapter, controlled ? JSON.stringify(controlled.data).slice(0, 160) : '无');

  section.contract = {
    routes: ROUTES,
    responses: {
      status: ['ok', 'adapters', 'ha{configured,baseUrl,tokenMasked,lastTestAt,lastTestOk,versionKnown,entitiesCached,lastError}', 'mqtt{configured,connected,url,prefix,devices,lastError}', 'ssdp{lastScanAt,lastScanCount,lastScanSt}', 'devices{total,bySource}', 'at'],
      config: ['ok', 'ha{baseUrl,tokenMasked,tokenSet,configured}', 'mqtt{url,username,passwordMasked,passwordSet,prefix,configured}', 'sources{ha,mqtt,ssdp}'],
      test: ['ok', 'ha{configured,ok,version,error}', 'mqtt{configured,ok,connected,url,prefix,devices,error}'],
      discover: ['ok', 'count', 'devices[{usn,st,location,server,name,typeLabel,description}]', 'ms', 'st', 'lastScanAt'],
      haEntities: ['ok', 'count', 'entities[{id:"ha:<entity_id>",name,type,domain,entityId,state,attributes,capabilities,available,source}]'],
      import: ['ok', 'imported', 'skipped', 'source', 'devices[{id:"iot:<source>:<key>",name,type,domain,source,adapter,sourceId,state,attributes,capabilities[{id,name,risk,manualOnly,version,evidence,adapter,command}]}]'],
      devices: ['ok', 'count', 'bySource{ha,mqtt,ssdp}', 'devices[]'],
      control: ['ok', 'deviceId', 'command', 'result{ok,adapter,...}', 'at'],
      delete: ['ok', 'removed'],
    },
  };
  evidence.sections.manager = section;
}

async function testNotification() {
  const section = {};
  const cap = findNotifyCapability('system.notify');
  check('notify-manifest', 'system.notify 能力已注册（manifest 存在）', !!cap && cap.risk === 'reversible', cap ? `${cap.id} / ${cap.name}` : '未找到');
  const dataDir = path.join(TMP, 'notify-data');
  const ctx = { repoRoot: REPO, dataDir, nodeId: 'node-local', taskId: 'task_v5_notify' };
  const result = await cap.run({ params: { title: '榫卯 V5 提醒测试', body: '这是一条真实系统通知（V5 物联自测）' } }, ctx);
  section.result = { summary: result.summary, method: result.method, partial: result.partial };
  check('notify-real', 'system.notify 真实弹一次 Windows 通知', result.partial === false && typeof result.method === 'string', `method=${result.method}`);
  const audit = path.join(dataDir, 'exec-audit.log');
  section.audit = { file: audit, exists: fs.existsSync(audit) };
  if (fs.existsSync(audit)) {
    const lines = fs.readFileSync(audit, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    section.audit.lines = lines.length;
    section.audit.hit = lines.some((line) => line.action === 'system.notify' && line.ok === true);
  }
  check('notify-audit', 'system.notify 写本地审计 data/exec-audit.log', section.audit.exists && section.audit.hit === true, `lines=${section.audit.lines || 0}`);
  evidence.sections.notification = section;
}

async function testAgentRegister() {
  const section = {};
  const agentData = path.join(TMP, 'agent-data');
  fs.mkdirSync(agentData, { recursive: true });
  fs.writeFileSync(path.join(agentData, 'secrets.json'), JSON.stringify({ operatorToken: 'op-token', nodeToken: 'node-token' }, null, 2));
  process.env.TENON_DATA_DIR = agentData;
  process.env.TENON_HUB_URL = 'http://127.0.0.1:1';
  const agentMod = await import('../../node-agent/agent.js');
  const stubHub = await startStubHub();
  cleanups.push(() => stubHub.close());
  const agent = new agentMod.NodeAgent({ hubUrl: stubHub.url, v2Enabled: true });
  section.activeManifest = agent.activeManifest.length;
  await agent.register();
  const body = stubHub.state.registerBodies[stubHub.state.registerBodies.length - 1];
  const ids = body.capabilities.map((cap) => cap.id);
  section.registerCount = body.capabilities.length;
  section.hasNotify = ids.includes('system.notify');
  section.capsSample = ids.slice(-6);
  check('agent-register-21', 'node-agent 注册 21 项能力（含 V5 system.notify）', body.capabilities.length === 21 && ids.includes('system.notify'), `${body.capabilities.length} 项；末 6 项=${section.capsSample.join(',')}`);
  evidence.sections.agent = section;
}

// ---------------------------------------------------------------- 6) 证据与收尾
function writeEvidence() {
  evidence.finishedAt = new Date().toISOString();
  evidence.durationMs = Date.now() - STARTED_AT.getTime();
  evidence.failures = failures;
  evidence.verdict = failures === 0 ? '通过' : '有失败项';
  fs.mkdirSync(EVID_DIR, { recursive: true });
  const jsonFile = path.join(EVID_DIR, 'v5-iot-evidence.json');
  fs.writeFileSync(jsonFile, JSON.stringify(evidence, null, 2), 'utf8');
  const lines = [
    '# 榫卯 V5 · 物联接入（HA/MQTT/SSDP + system.notify）真实自测证据',
    '',
    `- 时间：${evidence.startedAt} → ${evidence.finishedAt}（${(evidence.durationMs / 1000).toFixed(1)}s）`,
    `- 环境：${evidence.platform} / Node ${evidence.node} / 依赖 mqtt@5.16.1 + aedes@1.2.0`,
    `- 结论：**${evidence.verdict}**（${evidence.checks.filter((item) => item.ok).length}/${evidence.checks.length} 项通过）`,
    '',
    '| # | 检查项 | 结果 | 说明 |',
    '|---|---|---|---|',
    ...evidence.checks.map((item, index) => `| ${index + 1} | ${item.title} | ${item.ok ? '✅ 通过' : '❌ 失败'} | ${String(item.detail || '').replace(/\|/g, '\\|')} |`),
    '',
    '## 原始数据',
    '',
    '```json',
    JSON.stringify(evidence.sections, null, 2),
    '```',
  ];
  const mdFile = path.join(EVID_DIR, 'v5-iot-evidence.md');
  fs.writeFileSync(mdFile, lines.join('\n'), 'utf8');
  return { jsonFile, mdFile };
}

async function cleanup() {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch { /* ignore */ }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
}

try {
  const haParts = await testHomeAssistant();
  const mqttParts = await testMqtt();
  const ssdpParts = await testSsdp();
  await testManager({ ha: haParts.ha, haStub: haParts.stub, mqttAdapter: mqttParts.adapter, ssdpStub: ssdpParts.stub });
  await testNotification();
  await testAgentRegister();
} catch (err) {
  failures += 1;
  check('fatal', 'V5 IoT 自测执行', false, String(err && err.stack ? err.stack.split('\n').slice(0, 6).join(' | ') : err));
} finally {
  await cleanup();
  const files = writeEvidence();
  console.log(`\n证据：${files.mdFile}`);
  console.log(`证据 JSON：${files.jsonFile}`);
  console.log(`结论：${evidence.verdict}（${evidence.checks.filter((item) => item.ok).length}/${evidence.checks.length}）`);
  process.exit(failures === 0 ? 0 : 1);
}