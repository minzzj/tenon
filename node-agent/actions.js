// 榫卯 v2 · 电脑端受控动作能力（供物模型/场景调用，TENON_V2=1 时由 agent 注册）
// system.open / system.volume / system.power（默认禁用，需 TENON_ALLOW_POWER=1 + 二次确认）/ file.print
import path from 'node:path';
import { isWindows, psQuote, runPowerShell, makeTempDir, removeTempDir, readUtf8Json, wrapResultScript } from './lib/ps.js';
import { openPath, printFile } from './files.js';
import { CS_AUDIO } from './input.js';

export const ACTION_VERSION = '2.0.0';

function paramsOf(task) {
  if (task && task.params && typeof task.params === 'object') return task.params;
  if (task && task.draft && task.draft.params && typeof task.draft.params === 'object') return task.draft.params;
  return {};
}

function repoRootOf(ctx) {
  return ctx && ctx.repoRoot ? path.resolve(ctx.repoRoot) : process.cwd();
}

function resolveFromRoot(value, ctx) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('路径参数为空');
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return path.resolve(raw);
  return path.resolve(repoRootOf(ctx), raw);
}

async function step(ctx, label, detail) {
  if (ctx && typeof ctx.step === 'function') {
    try {
      await ctx.step(label, detail);
    } catch {
      /* 进度上报失败不影响动作 */
    }
  }
}

function runPs(body, timeoutMs = 20000) {
  const dir = makeTempDir('tenon-action-');
  const promise = (async () => {
    try {
      const resultFile = `${dir}\\result.json`;
      const run = await runPowerShell(wrapResultScript(body, resultFile), { timeoutMs });
      const parsed = readUtf8Json(resultFile);
      if (!parsed) return { ok: false, error: `PowerShell 未返回结果（exit=${run.code}）${run.stderr.slice(0, 140)}` };
      return parsed;
    } finally {
      removeTempDir(dir);
    }
  })();
  return promise;
}

const VOLUME_BODY = `$result = @{ ok = $false; error = $null; action = $action; steps = $steps }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TenonVolume {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public static void Press(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
"@
if ($action -eq 'mute') { [TenonVolume]::Press(0xAD) }
elseif ($action -eq 'up') { for ($i = 0; $i -lt $steps; $i++) { [TenonVolume]::Press(0xAF) } }
elseif ($action -eq 'down') { for ($i = 0; $i -lt $steps; $i++) { [TenonVolume]::Press(0xAE) } }
else { throw ('不支持的音量动作：' + $action) }
$result.ok = $true`;

// ---------- system.open ----------
async function runSystemOpen(task, ctx) {
  const params = paramsOf(task);
  const target = params.target || params.path || params.url;
  if (!target) throw new Error('缺少参数 target（要打开的文件/文件夹/链接）');
  if (!isWindows()) throw new Error('仅 Windows 支持本机打开动作');
  const absolute = /^https?:\/\//i.test(String(target)) ? String(target) : resolveFromRoot(target, ctx);
  await step(ctx, '打开目标', String(absolute));
  const result = await openPath(absolute, { app: params.app || null });
  if (!result.ok) throw new Error(`打开失败：${result.error || '未知原因'}`);
  const kindMap = { file: '文件', folder: '文件夹', url: '链接', 'with-app': '文件（指定应用）' };
  return {
    summary: `已打开${kindMap[result.kind] || '目标'}：${params.app ? params.app + ' · ' : ''}${String(target)}`,
    items: [{ name: String(target), ok: true, detail: result.kind || 'opened' }],
    partial: false,
  };
}

// ---------- system.volume（Round3：CoreAudio 真实音量，支持 level 绝对值；失败回退按键） ----------
async function runSystemVolume(task, ctx) {
  if (!isWindows()) throw new Error('仅 Windows 支持音量动作');
  const params = paramsOf(task);
  let action = params.action || (params.mute === true ? 'mute' : params.delta === 'up' || params.up === true ? 'up' : params.delta === 'down' || params.down === true ? 'down' : null);
  const hasLevel = params.level !== undefined && params.level !== null;
  if (hasLevel) {
    const level = Number(params.level);
    if (!Number.isFinite(level) || level < 0 || level > 100) throw new Error(`level 必须是 0-100 的整数：${params.level}`);
    const body = `Add-Type -TypeDefinition ${psQuote(CS_AUDIO)}
$before = [TenonAudio]::Read()
$set = [TenonAudio]::SetVolume([float](${level} / 100.0))
Start-Sleep -Milliseconds 120
$after = [TenonAudio]::Read()
$result = @{ ok = $true; mode = 'coreaudio'; level = ${level}; before = $before; after = $after; hr = $set[0] }`;
    await step(ctx, '设置音量', `调到 ${level}%`);
    const r = await runPs(body, 15000);
    if (!r.ok) throw new Error(`音量设置失败：${r.error}`);
    return {
      summary: `已把音量调到 ${r.after[0]}%（原 ${r.before[0]}%，CoreAudio 真实设置）`,
      items: [{ name: 'volume', ok: true, detail: `before=${r.before[0]}% after=${r.after[0]}% mute=${r.after[1]}` }],
      partial: false,
      evidence: { mode: 'coreaudio', level, beforeVolume: r.before[0], afterVolume: r.after[0], beforeMute: r.before[1], afterMute: r.after[1] },
    };
  }
  if (!action) throw new Error('缺少参数 action（mute/up/down）或 level（0-100）');
  if (!['mute', 'up', 'down'].includes(action)) throw new Error(`不支持的音量动作：${action}`);
  const steps = Math.max(1, Math.min(50, Number(params.steps) || 5));
  await step(ctx, '调整音量', `${action}${action === 'mute' ? '' : ` × ${steps}`}`);
  const label = { mute: '切换静音', up: `音量 +${steps} 档`, down: `音量 -${steps} 档` }[action];
  if (String(process.env.TENON_ACTION_DRYRUN || '') === '1') {
    return {
      summary: `（演练）已执行：${label}`,
      items: [{ name: action, ok: true, detail: 'TENON_ACTION_DRYRUN=1 未真正按键' }],
      partial: false,
    };
  }
  const body = `Add-Type -TypeDefinition ${psQuote(CS_AUDIO)}
$before = [TenonAudio]::Read()
$mode = 'coreaudio'
${action === 'mute' ? '$hr = [TenonAudio]::EnsureMute()' : `for ($i = 0; $i -lt ${steps}; $i++) { $hr = [TenonAudio]::Step(${action === 'up' ? 1 : -1}) }`}
Start-Sleep -Milliseconds 120
$after = [TenonAudio]::Read()
$result = @{ ok = $true; mode = $mode; before = $before; after = $after }`;
  let r = await runPs(body, 15000);
  if (!r.ok) {
    const fallback = `$action = '${action}'
$steps = ${steps}
${VOLUME_BODY}`;
    r = await runPs(fallback, 15000);
    if (!r.ok) throw new Error(`音量动作失败：${r.error}`);
    return { summary: `已执行：${label}（CoreAudio 不可用，已回退按键级，可能受系统音量控制策略影响）`, items: [{ name: action, ok: true, detail: 'media-key-fallback' }], partial: false };
  }
  const detail = action === 'mute'
    ? `静音：${r.before[1] ? '已是静音' : '已静音'}（音量 ${r.after[0]}%）`
    : `音量：${r.before[0]}% → ${r.after[0]}%（${steps} 档）`;
  return {
    summary: `已执行：${label} · ${detail}`,
    items: [{ name: action, ok: true, detail }, { name: 'volume', ok: true, detail: `before=${r.before[0]}% after=${r.after[0]}%` }],
    partial: false,
    evidence: { mode: 'coreaudio', beforeVolume: r.before[0], afterVolume: r.after[0], beforeMute: r.before[1], afterMute: r.after[1] },
  };
}

// ---------- system.power（默认禁用） ----------
async function runSystemPower(task, ctx) {
  if (!isWindows()) throw new Error('仅 Windows 支持电源动作');
  const enabled = String(process.env.TENON_ALLOW_POWER || '') === '1';
  if (!enabled) {
    throw new Error('system.power 默认禁用：设置环境变量 TENON_ALLOW_POWER=1 并在 params.confirm=true 后才允许执行');
  }
  const params = paramsOf(task);
  const action = String(params.action || '').toLowerCase();
  if (!['shutdown', 'restart', 'sleep'].includes(action)) throw new Error('缺少或非法的参数 action（shutdown/restart/sleep）');
  if (params.confirm !== true && params.confirm !== 'yes' && params.confirm !== action) {
    throw new Error('电源动作需要二次确认：params.confirm=true 才会执行');
  }
  await step(ctx, '执行电源动作', action);
  if (String(process.env.TENON_POWER_DRYRUN || '') === '1') {
    return {
      summary: `（演练）已模拟电源动作：${action}（TENON_POWER_DRYRUN=1，未真正执行）`,
      items: [{ name: action, ok: true, detail: 'dryrun' }],
      partial: false,
    };
  }
  const body = `$action = '${action}'
$result = @{ ok = $false; error = $null }
if ($action -eq 'shutdown') { shutdown.exe /s /t 8 /c "榫卯 v2 场景动作：关机" }
elseif ($action -eq 'restart') { shutdown.exe /r /t 8 /c "榫卯 v2 场景动作：重启" }
elseif ($action -eq 'sleep') { rundll32.exe powrprof.dll,SetSuspendState 0,1,0 }
else { throw ('不支持的电源动作：' + $action) }
$result.ok = $true`;
  const result = await runPs(body, 15000);
  if (!result.ok) throw new Error(`电源动作失败：${result.error}`);
  return {
    summary: `已发起电源动作：${{ shutdown: '关机', restart: '重启', sleep: '睡眠' }[action]}（8 秒延迟，可 shutdown /a 取消）`,
    items: [{ name: action, ok: true, detail: '已下发' }],
    partial: false,
  };
}

// ---------- file.print ----------
async function runFilePrint(task, ctx) {
  const params = paramsOf(task);
  const target = params.path || params.file || params.target;
  if (!target) throw new Error('缺少参数 path（要打印的文件）');
  if (!/^[a-zA-Z]:[\\/]/.test(String(target))) {
    const resolved = resolveFromRoot(target, ctx);
    if (!resolved) throw new Error('文件路径为空');
  }
  const resolved = resolveFromRoot(target, ctx);
  const copies = Math.max(1, Math.min(99, Number(params.copies) || 1));
  await step(ctx, '发起打印', `${resolved} × ${copies} 份`);
  const result = await printFile(resolved, { copies });
  if (!result.ok) throw new Error(`打印失败：${result.error || '未知原因'}`);
  return {
    summary: `已向系统默认打印机发起打印：${String(target)} × ${copies} 份（打印为不可逆动作）`,
    items: (result.jobs || []).map((job) => ({ name: `第 ${job.index} 份`, ok: !!job.ok, detail: job.ok ? '已发起' : job.error || '失败' })),
    partial: (result.jobs || []).some((job) => job.ok) && (result.jobs || []).some((job) => !job.ok),
  };
}

export const actionCapabilities = [
  {
    id: 'system.open',
    name: '打开文件/文件夹/应用',
    risk: 'reversible',
    manualOnly: false,
    version: ACTION_VERSION,
    evidence: 'confirmed',
    inputs: ['target（文件/文件夹/链接，相对仓库根或绝对路径）', 'app（可选，指定应用）'],
    outputs: ['目标在本机被打开'],
    run: runSystemOpen,
  },
  {
    id: 'system.volume',
    name: '系统音量（近似）',
    risk: 'reversible',
    manualOnly: false,
    version: ACTION_VERSION,
    evidence: 'confirmed',
    inputs: ['action: mute|up|down', 'steps（可选，默认 5）'],
    outputs: ['系统音量/静音状态变化'],
    run: runSystemVolume,
  },
  {
    id: 'system.power',
    name: '电源控制（默认禁用）',
    risk: 'irreversible',
    manualOnly: true,
    version: ACTION_VERSION,
    evidence: 'disabled-by-default',
    inputs: ['action: shutdown|restart|sleep', 'confirm: true（二次确认，必填）'],
    outputs: ['关机/重启/睡眠（需 TENON_ALLOW_POWER=1）'],
    run: runSystemPower,
  },
  {
    id: 'file.print',
    name: '打印文件',
    risk: 'irreversible',
    manualOnly: false,
    version: ACTION_VERSION,
    evidence: 'confirmed',
    inputs: ['path（文件，相对仓库根或绝对路径）', 'copies（可选，默认 1）'],
    outputs: ['系统默认打印机收到打印任务'],
    run: runFilePrint,
  },
];

function manifestOf(action) {
  return {
    id: action.id,
    name: action.name,
    risk: action.risk,
    manualOnly: !!action.manualOnly,
    version: action.version,
    evidence: action.evidence,
    inputs: action.inputs,
    outputs: action.outputs,
  };
}

export const actionsManifest = actionCapabilities.map(manifestOf);

export function findAction(id) {
  return actionCapabilities.find((action) => action.id === id) || null;
}

export default { ACTION_VERSION, actionCapabilities, actionsManifest, findAction };