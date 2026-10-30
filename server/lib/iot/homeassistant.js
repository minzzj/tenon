// 榫卯 V5 · Home Assistant REST 客户端
// 品牌设备通过 HA 桥接接入（小米/华为/苹果/Aqara/涂鸦等官方集成由 HA 提供）；本模块只调用 HA 本地 REST API。
// test(): GET /api/ → 版本；listEntities(): GET /api/states → 统一设备；control(): POST /api/services/{domain}/{service}；getState()。
import { httpError, nowIso, safeJsonParse } from './util.js';

export const HA_VERSION = '5.0.0';

// 各 domain 可执行命令（统一命令名 → HA service）
export const DOMAIN_COMMANDS = {
  light: { turn_on: 'turn_on', turn_off: 'turn_off', toggle: 'toggle', set_brightness: 'turn_on' },
  switch: { turn_on: 'turn_on', turn_off: 'turn_off', toggle: 'toggle' },
  fan: { turn_on: 'turn_on', turn_off: 'turn_off', toggle: 'toggle', set_percentage: 'set_percentage' },
  climate: { turn_on: 'turn_on', turn_off: 'turn_off', set_temperature: 'set_temperature', set_hvac_mode: 'set_hvac_mode' },
  media_player: {
    turn_on: 'turn_on', turn_off: 'turn_off', play: 'media_play', pause: 'media_pause', play_pause: 'media_play_pause',
    next: 'media_next_track', previous: 'media_previous_track', set_volume: 'volume_set', mute: 'volume_mute',
  },
  cover: { open: 'open_cover', close: 'close_cover', stop: 'stop_cover', toggle: 'toggle' },
  lock: { lock: 'lock', unlock: 'unlock', open: 'open' },
  vacuum: { start: 'start', pause: 'pause', stop: 'stop', return_home: 'return_to_base' },
  scene: { turn_on: 'turn_on' },
  script: { turn_on: 'turn_on' },
  automation: { turn_on: 'turn_on', turn_off: 'turn_off', trigger: 'trigger' },
  input_boolean: { turn_on: 'turn_on', turn_off: 'turn_off', toggle: 'toggle' },
};

const READ_ONLY_DOMAINS = new Set(['sensor', 'binary_sensor', 'weather', 'sun', 'person', 'zone', 'device_tracker', 'update']);

const COMMAND_ALIASES = {
  on: 'turn_on', off: 'turn_off', toggle: 'toggle', open: 'open', close: 'close', stop: 'stop',
  play: 'play', pause: 'pause', play_pause: 'play_pause', next: 'next', previous: 'previous',
  mute: 'mute', brightness: 'set_brightness', set_brightness: 'set_brightness',
  set_temperature: 'set_temperature', temperature: 'set_temperature', set_hvac_mode: 'set_hvac_mode',
  set_volume: 'set_volume', volume: 'set_volume', lock: 'lock', unlock: 'unlock',
  start: 'start', return_home: 'return_home', trigger: 'trigger', set_percentage: 'set_percentage',
};

export function normalizeCommand(command) {
  const raw = String(command === undefined || command === null ? '' : command).trim().toLowerCase();
  return COMMAND_ALIASES[raw] || raw;
}

export function capabilitiesOf(domain) {
  if (READ_ONLY_DOMAINS.has(domain)) return ['read'];
  const map = DOMAIN_COMMANDS[domain];
  return map ? Object.keys(map) : ['read'];
}

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

export function mapEntity(raw) {
  const domain = String((raw && raw.entity_id) || '').split('.')[0] || 'unknown';
  const entityId = String((raw && raw.entity_id) || '');
  const attrs = (raw && raw.attributes) || {};
  return {
    id: `ha:${entityId}`,
    name: String(attrs.friendly_name || entityId),
    type: domain,
    domain,
    entityId,
    state: raw && raw.state !== undefined ? raw.state : null,
    attributes: {
      friendly_name: attrs.friendly_name || null,
      device_class: attrs.device_class || null,
      unit_of_measurement: attrs.unit_of_measurement || null,
      supported_features: attrs.supported_features || 0,
      brightness: attrs.brightness !== undefined ? attrs.brightness : null,
      current_temperature: attrs.current_temperature !== undefined ? attrs.current_temperature : null,
      temperature: attrs.temperature !== undefined ? attrs.temperature : null,
      hvac_mode: attrs.hvac_mode || null,
      media_title: attrs.media_title || null,
      volume_level: attrs.volume_level !== undefined ? attrs.volume_level : null,
      source: attrs.source || null,
    },
    capabilities: capabilitiesOf(domain),
    available: raw && raw.state !== 'unavailable' && raw.state !== 'unknown',
    source: 'ha',
    updatedAt: raw && raw.last_changed ? raw.last_changed : nowIso(),
  };
}

// control 的 params 白名单（避免把任意字段透传到 HA）
function mapServiceParams(domain, command, params = {}) {
  const out = {};
  const p = params && typeof params === 'object' ? params : {};
  const numeric = (value, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, n));
  };
  if (command === 'set_brightness' || (command === 'turn_on' && (p.brightness_pct !== undefined || p.brightness !== undefined))) {
    const level = p.brightness_pct !== undefined ? numeric(p.brightness_pct, 0, 100) : p.brightness !== undefined ? numeric((Number(p.brightness) / 255) * 100, 0, 100) : null;
    if (level !== null) out.brightness_pct = Math.round(level);
  }
  if (p.brightness_pct !== undefined && command === 'turn_on' && out.brightness_pct === undefined) out.brightness_pct = Math.round(numeric(p.brightness_pct, 0, 100) || 0);
  if (p.color_temp_kelvin !== undefined) {
    const v = numeric(p.color_temp_kelvin, 1000, 20000);
    if (v !== null) out.color_temp_kelvin = Math.round(v);
  }
  if (Array.isArray(p.rgb_color) && p.rgb_color.length === 3) out.rgb_color = p.rgb_color.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))));
  if (p.temperature !== undefined) {
    const v = numeric(p.temperature, -100, 100);
    if (v !== null) out.temperature = v;
  }
  if (p.hvac_mode !== undefined) out.hvac_mode = String(p.hvac_mode).slice(0, 30);
  if (p.volume_level !== undefined || command === 'set_volume') {
    const raw = p.volume_level !== undefined ? p.volume_level : p.level !== undefined ? Number(p.level) / 100 : null;
    const v = numeric(raw, 0, 1);
    if (v !== null) out.volume_level = v;
  }
  if (p.is_volume_muted !== undefined) out.is_volume_muted = !!p.is_volume_muted;
  else if (command === 'mute') out.is_volume_muted = p.mute !== false;
  if (p.percentage !== undefined) {
    const v = numeric(p.percentage, 0, 100);
    if (v !== null) out.percentage = Math.round(v);
  }
  if (p.transition !== undefined) {
    const v = numeric(p.transition, 0, 3600);
    if (v !== null) out.transition = v;
  }
  if (p.effect !== undefined) out.effect = String(p.effect).slice(0, 60);
  return out;
}

export function buildServiceRequest(entityId, command, params = {}) {
  const domain = String(entityId).split('.')[0];
  const map = DOMAIN_COMMANDS[domain] || {};
  const cmd = normalizeCommand(command);
  const service = map[cmd];
  if (!service) {
    const supported = READ_ONLY_DOMAINS.has(domain) ? '该设备只读（sensor 等）' : `支持：${Object.keys(map).join(', ') || '无'}`;
    throw httpError(400, `设备 ${entityId}（domain=${domain}）不支持命令 ${command}；${supported}`, 'UNSUPPORTED_COMMAND');
  }
  return { domain, service, body: { entity_id: entityId, ...mapServiceParams(domain, cmd, params) } };
}

export function createHomeAssistantClient({ baseUrl = '', token = '', fetchImpl = globalThis.fetch, timeoutMs = 10000, log = () => {} } = {}) {
  let cfg = { baseUrl: normalizeBaseUrl(baseUrl), token: String(token || '') };
  const state = { lastTestAt: null, lastTestOk: null, lastVersion: null, lastError: null, calls: 0 };

  function setConfig(next = {}) {
    if (next.baseUrl !== undefined) cfg.baseUrl = normalizeBaseUrl(next.baseUrl);
    if (next.token !== undefined) cfg.token = String(next.token || '');
    return { ...cfg };
  }

  function config() {
    return { baseUrl: cfg.baseUrl, tokenSet: !!cfg.token };
  }

  async function request(pathname, { method = 'GET', body } = {}) {
    if (!cfg.baseUrl) throw httpError(400, 'Home Assistant 未配置（baseUrl 为空）', 'HA_NOT_CONFIGURED');
    const url = cfg.baseUrl + pathname;
    const headers = { accept: 'application/json' };
    if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    state.calls += 1;
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => '');
    const data = safeJsonParse(text, text ? { message: text } : null);
    if (!res.ok) {
      const err = httpError(res.status === 401 ? 401 : res.status, `Home Assistant HTTP ${res.status}（${method} ${pathname}）：${String(text).slice(0, 180)}`, 'HA_HTTP_ERROR');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function test() {
    try {
      const data = await request('/api/');
      const version = (data && (data.version || data.message)) || null;
      state.lastTestAt = nowIso();
      state.lastTestOk = true;
      state.lastVersion = version;
      state.lastError = null;
      log(`[iot/ha] 连接成功 version=${version || '未知'}`);
      return { ok: true, version, location_name: (data && data.location_name) || null, baseUrl: cfg.baseUrl };
    } catch (err) {
      state.lastTestAt = nowIso();
      state.lastTestOk = false;
      state.lastError = String(err && err.message ? err.message : err);
      return { ok: false, error: state.lastError };
    }
  }

  async function listEntities({ domain = null } = {}) {
    const list = await request('/api/states');
    const entities = (Array.isArray(list) ? list : []).map(mapEntity);
    const filtered = domain ? entities.filter((item) => item.domain === String(domain)) : entities;
    return filtered;
  }

  async function getState(idOrEntityId) {
    const entityId = String(idOrEntityId || '').replace(/^ha:/, '');
    if (!entityId) throw httpError(400, '缺少 entity_id');
    const raw = await request(`/api/states/${encodeURIComponent(entityId)}`);
    return mapEntity(raw);
  }

  async function control(idOrEntityId, command, params = {}) {
    const entityId = String(idOrEntityId || '').replace(/^ha:/, '');
    if (!entityId) throw httpError(400, '缺少 entity_id');
    const req = buildServiceRequest(entityId, command, params);
    const result = await request(`/api/services/${req.domain}/${req.service}`, { method: 'POST', body: req.body });
    let after = null;
    try {
      after = await getState(entityId);
    } catch {
      after = null;
    }
    return {
      ok: true,
      adapter: 'ha',
      entityId,
      command: normalizeCommand(command),
      domain: req.domain,
      service: req.service,
      requestBody: req.body,
      state: after ? after.state : null,
      device: after || null,
      haResponse: Array.isArray(result) ? { changed: result.length } : result || null,
      at: nowIso(),
    };
  }

  return { kind: 'ha', config, setConfig, test, listEntities, getState, control, status: () => ({ ...state, baseUrl: cfg.baseUrl, tokenSet: !!cfg.token }) };
}

export default { HA_VERSION, DOMAIN_COMMANDS, capabilitiesOf, mapEntity, normalizeCommand, buildServiceRequest, createHomeAssistantClient };