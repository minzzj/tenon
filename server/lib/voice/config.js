// 榫卯 V3 · 语音管家配置（data/voice/config.json，本地优先，敏感项不外传）
import fs from 'node:fs';
import path from 'node:path';

export const VOICE_VERSION = '3.0.0';
export const VOICE_CONFIG_FILE = 'data/voice/config.json';

export const DEFAULT_CONFIG = {
  version: VOICE_VERSION,
  enabled: true, // V4 正常模式：常驻语音默认开启（用户可在设置/托盘暂停）
  wakeWords: ['榫卯', '小榫'],
  language: 'zh-CN',
  silenceTimeoutMs: 3000,
  wakeTimeoutMs: 8000,
  asrProvider: 'auto', // auto | paraformer | funasr | windows | mock | off
  // V6：唤醒与记录分离（唤醒用短片段快速检测；记录用完整模型+标点；均本地）
  asrSplit: true,
  // V6.4：24 小时录音（唤醒与全天记录是两个独立功能）
  ambient: { enabled: true, saveTranscripts: true },
  asr: {
    wakeProvider: 'paraformer',
    recordProvider: 'paraformer',
    hotwords: ['榫卯', '小榫', '打开记事本', '音量', '调到', 'Chrome', '浏览器', '照片', '甩到电脑', '回家模式', '总结', '提醒'],
    wakeSilenceMs: 500,
    wakeMaxMs: 2500,
    recordSilenceMs: 1000,
    recordMaxMs: 15000,
    sessionTimeoutMs: 6000,
    threshold: 200,
  },
  llmProvider: 'auto', // auto | local | rule | mock
  tts: { enabled: true, play: true, voice: 'Microsoft Huihui Desktop', rate: 0, volume: 100 },
  micDevice: '',
  executor: { mode: 'local', baseUrl: '', token: '' }, // local=本进程 super；hub=调本机中枢（独立运行/自测）
  workers: {
    python: 'python',
    asrScript: 'scripts/voice/asr_worker.py',
    wakeScript: 'scripts/voice/dual_worker.py',
    llmScript: 'scripts/voice/llm_worker.py',
    speakScript: 'scripts/voice/speak.ps1',
    transcribeScript: 'scripts/voice/transcribe.ps1',
  },
  retentionDays: 30,
  maxTranscriptsPerDay: 5000,
  diary: { enabled: true, time: '23:00', catchUp: true },
  prompts: {},
  mock: { enabled: false, wakeText: '榫卯', commandText: '把音量调到 40', autoRunOnStart: true },
};

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : { ...(base || {}) };
  if (!isPlainObject(extra)) return out;
  for (const [k, v] of Object.entries(extra)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function configFileOf(dataDir) {
  return path.join(dataDir, 'voice', 'config.json');
}

export function envOverrides(env = process.env) {
  const out = {};
  if (env.TENON_VOICE_ENABLED != null) out.enabled = String(env.TENON_VOICE_ENABLED) === '1' || String(env.TENON_VOICE_ENABLED) === 'true';
  if (env.TENON_VOICE_MOCK != null) {
    const on = String(env.TENON_VOICE_MOCK) === '1' || String(env.TENON_VOICE_MOCK) === 'true';
    out.mock = { enabled: on, autoRunOnStart: on };
    if (on) {
      out.asrProvider = 'mock';
      out.llmProvider = 'mock';
    }
  }
  if (env.TENON_VOICE_ASR_SCRIPT) out.workers = { ...(out.workers || {}), asrScript: env.TENON_VOICE_ASR_SCRIPT };
  if (env.TENON_VOICE_LLM_SCRIPT) out.workers = { ...(out.workers || {}), llmScript: env.TENON_VOICE_LLM_SCRIPT };
  if (env.TENON_VOICE_SPEAK_SCRIPT) out.workers = { ...(out.workers || {}), speakScript: env.TENON_VOICE_SPEAK_SCRIPT };
  if (env.TENON_VOICE_EXECUTOR) out.executor = { ...(out.executor || {}), mode: env.TENON_VOICE_EXECUTOR };
  if (env.TENON_VOICE_HUB_URL) out.executor = { ...(out.executor || {}), baseUrl: env.TENON_VOICE_HUB_URL };
  if (env.TENON_VOICE_HUB_TOKEN) out.executor = { ...(out.executor || {}), token: env.TENON_VOICE_HUB_TOKEN };
  return out;
}

export function normalizeConfig(raw = {}) {
  const cfg = deepMerge(DEFAULT_CONFIG, raw || {});
  cfg.version = VOICE_VERSION;
  if (!Array.isArray(cfg.wakeWords) || !cfg.wakeWords.length) cfg.wakeWords = DEFAULT_CONFIG.wakeWords.slice();
  cfg.wakeWords = cfg.wakeWords.map((w) => String(w || '').trim()).filter(Boolean).slice(0, 8);
  cfg.silenceTimeoutMs = Math.max(800, Math.min(30000, Number(cfg.silenceTimeoutMs) || DEFAULT_CONFIG.silenceTimeoutMs));
  cfg.wakeTimeoutMs = Math.max(1000, Math.min(30000, Number(cfg.wakeTimeoutMs) || DEFAULT_CONFIG.wakeTimeoutMs));
  if (!['auto', 'paraformer', 'funasr', 'windows', 'mock', 'off'].includes(cfg.asrProvider)) cfg.asrProvider = 'auto';
  if (!['auto', 'local', 'rule', 'mock'].includes(cfg.llmProvider)) cfg.llmProvider = 'auto';
  if (!['local', 'hub'].includes(cfg.executor.mode)) cfg.executor.mode = 'local';
  cfg.executor.baseUrl = String(cfg.executor.baseUrl || '').trim();
  cfg.executor.token = String(cfg.executor.token || '');
  cfg.wakeWords = cfg.wakeWords.map((w) => w.replace(/\s+/g, ''));
  if (!cfg.diary || typeof cfg.diary !== 'object') cfg.diary = { enabled: true, time: '23:00', catchUp: true };
  cfg.diary.enabled = cfg.diary.enabled !== false;
  cfg.diary.catchUp = cfg.diary.catchUp !== false;
  cfg.diary.time = /^\\d{1,2}:\\d{2}$/.test(String(cfg.diary.time || '')) ? String(cfg.diary.time) : '23:00';
  if (!cfg.prompts || typeof cfg.prompts !== 'object') cfg.prompts = {};
  return cfg;
}

export function loadConfig(dataDir, env = process.env) {
  let file = null;
  try {
    file = JSON.parse(fs.readFileSync(configFileOf(dataDir), 'utf8'));
  } catch {
    file = null;
  }
  return normalizeConfig(deepMerge(file || {}, envOverrides(env)));
}

export function saveConfig(dataDir, cfg) {
  const normalized = normalizeConfig(cfg);
  const file = configFileOf(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return normalized;
}

/** 前端可见配置（去掉执行 token 等） */
export function publicConfig(cfg) {
  return {
    enabled: !!cfg.enabled,
    wakeWords: cfg.wakeWords.slice(),
    language: cfg.language,
    silenceTimeoutMs: cfg.silenceTimeoutMs,
    wakeTimeoutMs: cfg.wakeTimeoutMs,
    asrProvider: cfg.asrProvider,
    asrSplit: cfg.asrSplit !== false,
    ambient: { enabled: cfg.ambient ? cfg.ambient.enabled !== false : true },
    asr: {
      wakeProvider: (cfg.asr && cfg.asr.wakeProvider) || 'paraformer',
      recordProvider: (cfg.asr && cfg.asr.recordProvider) || 'paraformer',
      hotwords: ((cfg.asr && cfg.asr.hotwords) || []).slice(0, 40),
    },
    llmProvider: cfg.llmProvider,
    tts: { ...cfg.tts },
    micDevice: cfg.micDevice,
    executor: { mode: cfg.executor.mode },
    workers: { ...cfg.workers },
    retentionDays: cfg.retentionDays,
    mock: { enabled: !!cfg.mock.enabled },
    version: VOICE_VERSION,
  };
}

/** PATCH 只允许这些路径，避免误改执行器 token 之类 */
export const PATCHABLE_KEYS = ['enabled', 'wakeWords', 'language', 'silenceTimeoutMs', 'asrProvider', 'llmProvider', 'tts', 'micDevice', 'retentionDays', 'diary', 'prompts', 'ambient'];

export default { VOICE_VERSION, DEFAULT_CONFIG, loadConfig, saveConfig, normalizeConfig, publicConfig, deepMerge, configFileOf };