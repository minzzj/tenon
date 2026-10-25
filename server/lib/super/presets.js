// 榫卯 Tenon v2.3 · 一键场景预设（回家 / 工作 / 睡前）
//
// 设计：
// - 预设 = 一组真实可执行的 super plan 步骤（capabilityId 来自 server/lib/super/actions.js：
//   app.launch / url.open / system.volume / media.show / handoff.show），交给现有 executor 走真实执行
//   （node 动作 → task.drafted/task.queued → node-agent 认领执行；hub 动作 → 中枢直接执行）。
// - 默认 3 个预设内置在本文件；`scripts/seed-home.js` 会把自定义预设写进 data/super/presets.json，
//   服务优先读文件（校验失败自动回退内置，不阻塞启动）。
// - 运行占位符：$HUB（中枢地址，例如 http://192.168.3.123:7410）、$ROOT（仓库根绝对路径）。
import fs from 'node:fs';
import path from 'node:path';
import { getSuperAction } from './actions.js';

export const PRESET_VERSION = '1.0.0';

export const DEFAULT_PRESETS = [
  {
    id: 'home',
    name: '回家模式',
    icon: '🏠',
    description: '打开 Chrome 与桌面欢迎页、音量调大一点、播放回家音乐',
    steps: [
      { capabilityId: 'app.launch', label: '打开 Chrome', params: { app: 'chrome' } },
      { capabilityId: 'url.open', label: '打开桌面欢迎页', params: { url: '$HUB/' } },
      { capabilityId: 'system.volume', label: '音量调到 30%', params: { action: 'up', level: 30 } },
      { capabilityId: 'app.launch', label: '播放回家音乐', params: { app: '$ROOT/示例空间/音乐/回家.wav' } },
      { capabilityId: 'handoff.show', label: '桌面显示「欢迎回家」', params: { kind: 'text', text: '欢迎回家 · 已为你打开常用页面并播放音乐' } },
    ],
  },
  {
    id: 'work',
    name: '工作模式',
    icon: '💼',
    description: '一次性打开 Chrome、记事本、资源管理器，进入工作状态（装微信的机器会额外打开微信）',
    steps: [
      { capabilityId: 'app.launch', label: '打开 Chrome', params: { app: 'chrome' } },
      { capabilityId: 'app.launch', label: '打开记事本', params: { app: 'notepad' } },
      { capabilityId: 'app.launch', label: '打开资源管理器', params: { app: 'explorer' } },
    ],
  },
  {
    id: 'sleep',
    name: '睡前模式',
    icon: '🌙',
    description: '静音电脑，桌面显示晚安页',
    steps: [
      { capabilityId: 'system.volume', label: '静音', params: { action: 'mute' } },
      { capabilityId: 'handoff.show', label: '桌面显示「晚安」', params: { kind: 'text', text: '晚安 · 电脑已静音，明天见' } },
    ],
  },
];

export function expandPlaceholders(value, ctx = {}) {
  if (typeof value === 'string') {
    return value
      .split('$HUB').join(String(ctx.hubUrl || ''))
      .split('$ROOT').join(String(ctx.root || ''));
  }
  if (Array.isArray(value)) return value.map((item) => expandPlaceholders(item, ctx));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandPlaceholders(v, ctx);
    return out;
  }
  return value;
}

function sanitizePreset(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const name = String(raw.name || '').trim();
  if (!id || !name) return null;
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!steps.length) return null;
  const cleanSteps = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    const capabilityId = String(step.capabilityId || step.actionId || '').trim();
    const action = getSuperAction(capabilityId);
    if (!action) continue;
    cleanSteps.push({
      capabilityId,
      label: String(step.label || action.name || capabilityId).slice(0, 80),
      params: step.params && typeof step.params === 'object' ? step.params : {},
    });
  }
  if (!cleanSteps.length) return null;
  return {
    id,
    name: name.slice(0, 40),
    icon: String(raw.icon || '⚡').slice(0, 8),
    description: String(raw.description || '').slice(0, 200),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    steps: cleanSteps.slice(0, 20),
  };
}

export function presetsFileOf(dataDir) {
  return path.join(dataDir, 'super', 'presets.json');
}

/** 读取预设：优先 data/super/presets.json，校验失败回退内置 */
export function loadPresets(dataDir) {
  const file = presetsFileOf(dataDir);
  let source = 'default';
  let list = DEFAULT_PRESETS;
  try {
    if (fs.existsSync(file)) {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const rawList = Array.isArray(doc) ? doc : doc && Array.isArray(doc.presets) ? doc.presets : null;
      if (rawList && rawList.length) {
        const clean = rawList.map(sanitizePreset).filter(Boolean);
        if (clean.length) {
          list = clean.sort((a, b) => a.order - b.order);
          source = 'file';
        }
      }
    }
  } catch {
    // 文件损坏：回退内置，不阻塞中枢
  }
  return {
    version: PRESET_VERSION,
    source,
    file: file,
    presets: list.map((preset) => ({
      ...preset,
      steps: preset.steps.map((step) => ({ ...step })),
    })),
  };
}

export function findPreset(dataDir, presetId) {
  const id = String(presetId || '').trim().toLowerCase();
  const doc = loadPresets(dataDir);
  return { preset: doc.presets.find((p) => p.id === id) || null, doc };
}

export default { PRESET_VERSION, DEFAULT_PRESETS, loadPresets, findPreset, expandPlaceholders, presetsFileOf };