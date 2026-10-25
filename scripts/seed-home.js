#!/usr/bin/env node
/**
 * 榫卯 Tenon v2.3 · 一键场景种子（Round3 C）
 *
 * 用法：node scripts/seed-home.js [--data-dir data] [--root .] [--quiet]
 *
 * 做什么（可重复执行，幂等）：
 * 1) 写 data/super/presets.json：回家 / 工作 / 睡前 3 个真实场景预设
 *    （步骤走 server/lib/super/actions.js 的真实动作：app.launch / url.open / system.volume / media.show / handoff.show，
 *      由超终端 executor → node 任务队列真实执行）；
 * 2) 生成示例音乐 示例空间/音乐/回家.wav（回家模式真实播放的本地文件）；
 * 3) 往账本 append `scene.defined {sceneId,name,steps}` 审计事件（已定义过则跳过，保证可重复执行）。
 *
 * 输出：最后一行 JSON 便于程序解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../server/lib/ledger.js';
import { replay } from '../server/lib/state.js';
import { DEFAULT_PRESETS, PRESET_VERSION, presetsFileOf } from '../server/lib/super/presets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { dataDir: null, root: ROOT, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--data-dir') out.dataDir = argv[i + 1], (i += 1);
    else if (a.startsWith('--data-dir=')) out.dataDir = a.slice('--data-dir='.length);
    else if (a === '--root') out.root = argv[i + 1], (i += 1);
    else if (a.startsWith('--root=')) out.root = a.slice('--root='.length);
    else if (a === '--quiet') out.quiet = true;
    else throw new Error('未知参数：' + a);
  }
  out.root = path.resolve(out.root);
  out.dataDir = path.resolve(out.dataDir || path.join(out.root, 'data'));
  return out;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** 生成一段 2 秒、22050Hz/16bit 单声道 WAV 回家旋律（不依赖外部素材） */
function writeHomeWav(file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return { created: false, bytes: fs.statSync(file).size };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rate = 22050;
  const notes = [523.25, 659.25, 783.99, 659.25, 587.33, 523.25, 440.0, 523.25];
  const noteSec = 0.28;
  const samples = [];
  for (const freq of notes) {
    const n = Math.floor(rate * noteSec);
    for (let i = 0; i < n; i += 1) {
      const t = i / rate;
      const env = Math.min(1, i / (rate * 0.02)) * Math.min(1, (n - i) / (rate * 0.05));
      samples.push(Math.sin(2 * Math.PI * freq * t) * 0.28 * env);
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return { created: true, bytes: 44 + data.length, seconds: Number((samples.length / rate).toFixed(2)) };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { root, dataDir, quiet } = args;
  fs.mkdirSync(dataDir, { recursive: true });
  const now = new Date().toISOString();
  const presetsFile = presetsFileOf(dataDir);
  // 按本机实际安装情况微调「工作模式」：装了微信就加回微信步骤，没装则用必装程序组合（不假装成功）
  const wechatCandidates = [
    'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
    'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
  ];
  const hasWechat = wechatCandidates.some((p) => fs.existsSync(p));
  const presets = DEFAULT_PRESETS.map((preset, index) => {
    const copy = { ...preset, order: index, steps: preset.steps.map((s) => ({ ...s, params: { ...(s.params || {}) } })) };
    if (copy.id === 'work' && hasWechat && !copy.steps.some((s) => s.params && s.params.app === '微信')) {
      copy.steps.unshift({ capabilityId: 'app.launch', label: '打开微信', params: { app: '微信' } });
      copy.description = '一次性打开微信、Chrome、记事本、资源管理器，进入工作状态';
    }
    return copy;
  });
  const doc = {
    version: PRESET_VERSION,
    generatedBy: 'scripts/seed-home.js',
    updatedAt: now,
    detected: { wechat: hasWechat },
    presets,
  };
  writeJsonAtomic(presetsFile, doc);
  const mediaFile = path.join(root, '示例空间', '音乐', '回家.wav');
  const media = writeHomeWav(mediaFile);
  const ledger = new Ledger(dataDir);
  const state = replay(ledger.events);
  const defined = state.scenes && state.scenes.items ? state.scenes.items : {};
  const appended = [];
  for (const preset of doc.presets) {
    const existing = defined[preset.id];
    const steps = preset.steps.map((step, index) => ({
      index,
      actionId: step.capabilityId,
      capabilityId: step.capabilityId,
      label: step.label,
      params: step.params || {},
    }));
    const same = existing && JSON.stringify(existing.steps || []) === JSON.stringify(steps);
    if (same) continue;
    ledger.append('scene.defined', { sceneId: preset.id, name: preset.name, steps }, 'seed-home');
    appended.push(preset.id);
  }
  const summary = {
    ok: true,
    presetsFile: path.relative(root, presetsFile).split(path.sep).join('/'),
    presets: doc.presets.map((p) => ({ id: p.id, name: p.name, steps: p.steps.length })),
    mediaFile: path.relative(root, mediaFile).split(path.sep).join('/'),
    media,
    sceneDefinedAppended: appended,
    ledgerEvents: ledger.events.length,
    hint: '一键场景现在可在 #/super 首页直接执行（数据来自 data/super/presets.json）',
  };
  if (!quiet) {
    console.log('[seed-home] 预设文件：' + summary.presetsFile);
    console.log('[seed-home] 3 个场景：' + doc.presets.map((p) => p.icon + ' ' + p.name + '（' + p.steps.length + ' 步）').join(' / '));
    console.log('[seed-home] 示例音乐：' + summary.mediaFile + '（' + Math.round(media.bytes / 1024) + 'KB' + (media.created ? '，新生成' : '，已存在') + '）');
    console.log('[seed-home] scene.defined 新写入：' + (appended.length ? appended.join(', ') : '无（已存在，幂等）'));
  }
  console.log('SEED_HOME_RESULT ' + JSON.stringify(summary));
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error('seed-home 失败：' + String((err && err.message) || err));
  process.exitCode = 1;
}