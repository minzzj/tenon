// 榫卯 v2.1 · 消费级「超级终端」桌面动作：打开程序/网页/媒体/流转展示 + 程序清单
// 全部 risk=reversible、manualOnly=false；TENON_V2=1 时注册给中枢，走现有 task pull 执行。
// 安全：只允许 ①内置程序映射 ②完整路径（必须存在）③http(s) URL ④PATH 中的安全命令名；
//       PowerShell 一律用 Start-Process + 单引号转义，不接受用户拼接参数；URL 做协议/字符白名单校验。
import fs from 'node:fs';
import path from 'node:path';
import { isWindows, psQuote, runPowerShell, makeTempDir, removeTempDir, readUtf8Json, wrapResultScript } from './lib/ps.js';
import { classifyFileKind, formatBytes } from './files.js';

export const APP_VERSION = '2.1.0';
const MAX_URL_LENGTH = 2048;

function repoRootOf(ctx) {
  return ctx && ctx.repoRoot ? path.resolve(ctx.repoRoot) : process.cwd();
}

function resolveFromRoot(value, ctx) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('路径参数为空');
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return path.resolve(raw);
  return path.resolve(repoRootOf(ctx), raw);
}

function paramsOf(task) {
  if (task && task.params && typeof task.params === 'object') return task.params;
  if (task && task.draft && task.draft.params && typeof task.draft.params === 'object') return task.draft.params;
  return {};
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

// ---------------------------------------------------------------- 程序目录
// candidates：常见安装路径（按顺序探测）；command：PATH 中的命令名；protocol：Windows 协议（如 ms-settings:）
export const APP_CATALOG = [
  {
    id: 'wechat', name: '微信', aliases: ['微信', 'wechat', 'weixin', 'WeChat'],
    candidates: [
      'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
      'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
      'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
      'C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe',
    ],
    command: 'WeChat.exe', processName: 'WeChat',
  },
  {
    id: 'chrome', name: 'Chrome 浏览器', aliases: ['chrome', '谷歌浏览器', 'google chrome', '浏览器'],
    candidates: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Users\\Administrator\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    ],
    command: 'chrome.exe', processName: 'chrome',
  },
  {
    id: 'edge', name: 'Edge 浏览器', aliases: ['edge', 'msedge', '微软浏览器'],
    candidates: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    command: 'msedge.exe', processName: 'msedge',
  },
  {
    id: 'notepad', name: '记事本', aliases: ['记事本', 'notepad', '文本', '文本编辑器'],
    candidates: ['C:\\Windows\\System32\\notepad.exe', 'C:\\Windows\\notepad.exe'],
    command: 'notepad.exe', processName: 'notepad',
  },
  {
    id: 'explorer', name: '资源管理器', aliases: ['资源管理器', 'explorer', '文件管理器', '我的电脑', '此电脑'],
    candidates: ['C:\\Windows\\explorer.exe'],
    command: 'explorer.exe', processName: 'explorer',
  },
  {
    id: 'calc', name: '计算器', aliases: ['计算器', 'calc', 'calculator'],
    candidates: ['C:\\Windows\\System32\\calc.exe'],
    command: 'calc.exe', processName: 'CalculatorApp',
  },
  {
    id: 'taskmgr', name: '任务管理器', aliases: ['任务管理器', 'taskmgr', 'task manager'],
    candidates: ['C:\\Windows\\System32\\Taskmgr.exe'],
    command: 'taskmgr.exe', processName: 'Taskmgr',
  },
  {
    id: 'terminal', name: '终端', aliases: ['终端', 'terminal', 'powershell', '命令行', 'cmd'],
    candidates: [
      'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\wt.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
    ],
    command: 'powershell.exe', processName: 'powershell',
  },
  {
    id: 'settings', name: '系统设置', aliases: ['设置', 'settings', '系统设置', '控制面板'],
    candidates: [],
    protocol: 'ms-settings:', processName: 'SystemSettings',
  },
  {
    id: 'photos', name: '照片', aliases: ['照片', 'photos', '图片查看器'],
    candidates: [],
    protocol: 'ms-photos:', processName: 'Microsoft.Photos',
  },
  {
    id: 'paint', name: '画图', aliases: ['画图', 'paint', 'mspaint'],
    candidates: ['C:\\Windows\\System32\\mspaint.exe'],
    command: 'mspaint.exe', processName: 'mspaint',
  },
  {
    id: 'music', name: '音乐播放器', aliases: ['音乐', 'music', '播放器', 'media player', 'wmplayer'],
    candidates: [
      'C:\\Program Files\\Windows Media Player\\wmplayer.exe',
      'C:\\Program Files (x86)\\Windows Media Player\\wmplayer.exe',
      'C:\\Program Files\\Windows Media Player\\wmplayer.exe',
    ],
    command: 'wmplayer.exe', processName: 'wmplayer',
  },
];

// PATH 中查找命令（纯 Node，用于 app.list 可用性探测；不执行程序）
export function findOnPath(command, env = process.env) {
  const name = String(command || '').trim();
  if (!name) return null;
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  const hasExt = /\.[a-z0-9]+$/i.test(name);
  const names = hasExt ? [name] : [name, ...exts.map((ext) => name + ext.toLowerCase()), ...exts.map((ext) => name + ext.toUpperCase())];
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// 解析一个 app 输入 → { ok, kind, target, name, processName, mode } 或抛错
export function resolveApp(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) throw new Error('缺少参数 app（程序名 / 完整路径 / URL）');
  if (raw.length > MAX_URL_LENGTH) throw new Error('参数 app 过长（上限 2048 字符）');
  if (/[\u0000-\u001f]/.test(raw)) throw new Error('参数 app 含有非法控制字符');
  if (/^https?:\/\//i.test(raw)) {
    return { ok: true, kind: 'url', target: raw, name: raw, mode: 'url' };
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    if (/["']/.test(raw)) throw new Error('路径中不允许引号');
    const full = path.resolve(raw);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`程序路径不存在：${full}`);
    return { ok: true, kind: 'path', target: full, name: path.basename(full), mode: 'path' };
  }
  const key = normalizeKey(raw);
  const entry = APP_CATALOG.find((item) => normalizeKey(item.id) === key || normalizeKey(item.name) === key || (item.aliases || []).some((alias) => normalizeKey(alias) === key));
  if (entry) {
    for (const candidate of entry.candidates || []) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return { ok: true, kind: 'path', target: candidate, name: entry.name, appId: entry.id, processName: entry.processName, mode: 'builtin-path' };
        }
      } catch {
        /* ignore */
      }
    }
    if (entry.protocol) {
      return { ok: true, kind: 'protocol', target: entry.protocol, name: entry.name, appId: entry.id, processName: entry.processName, mode: 'builtin-protocol' };
    }
    if (entry.command) {
      const found = findOnPath(entry.command);
      if (found) return { ok: true, kind: 'path', target: found, name: entry.name, appId: entry.id, processName: entry.processName, mode: 'builtin-command' };
    }
    throw new Error(`程序未安装或找不到：${entry.name}（可用：${APP_CATALOG.map((item) => item.name).join('、')}）`);
  }
  // PATH 中的安全命令名（无路径分隔符/无 shell 元字符）
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(raw)) {
    throw new Error(`无法识别的程序名：${raw}（仅支持内置程序名/完整路径/URL；可用：${APP_CATALOG.map((item) => item.name).join('、')}）`);
  }
  const found = findOnPath(raw);
  if (found) return { ok: true, kind: 'path', target: found, name: raw, mode: 'path-command' };
  throw new Error(`找不到程序：${raw}（可用：${APP_CATALOG.map((item) => item.name).join('、')}，也可传完整路径或 URL）`);
}

// 程序清单（供中枢 catalog / app.list）
export function listApps() {
  return APP_CATALOG.map((entry) => {
    let target = null;
    let available = false;
    let mode = 'unavailable';
    for (const candidate of entry.candidates || []) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          target = candidate;
          available = true;
          mode = 'path';
          break;
        }
      } catch {
        /* ignore */
      }
    }
    if (!available && entry.protocol) {
      available = true;
      target = entry.protocol;
      mode = 'protocol';
    }
    if (!available && entry.command) {
      const found = findOnPath(entry.command);
      if (found) {
        available = true;
        target = found;
        mode = 'command';
      }
    }
    return { id: entry.id, name: entry.name, aliases: entry.aliases || [], available, mode, target };
  });
}

// ---------------------------------------------------------------- PowerShell 执行
function runPs(body, timeoutMs = 25000) {
  const dir = makeTempDir('tenon-app-');
  const promise = (async () => {
    try {
      const resultFile = `${dir}\\result.json`;
      const run = await runPowerShell(wrapResultScript(body, resultFile), { timeoutMs });
      const parsed = readUtf8Json(resultFile);
      if (!parsed) return { ok: false, error: `PowerShell 未返回结果（exit=${run.code}）${run.stderr.slice(0, 160)}` };
      return parsed;
    } finally {
      removeTempDir(dir);
    }
  })();
  return promise;
}

// Start-Process 一个已解析目标；返回进程探测结果
function launchResolved(resolved) {
  if (!isWindows()) return Promise.resolve({ ok: false, unsupported: true, error: '仅 Windows 支持打开本机程序' });
  const probe = resolved.processName
    ? `Start-Sleep -Milliseconds 700
$found = $null
try { $found = Get-Process -Name ${psQuote(String(resolved.processName).replace(/\.exe$/i, ''))} -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { $found = $null }
if ($found) { $result.processFound = $true; $result.processId = $found.Id }
else { $result.processFound = $false }`
    : `Start-Sleep -Milliseconds 500
$result.processFound = $null`;
  const body = `$target = ${psQuote(resolved.target)}
$result = @{ ok = $false; error = $null; kind = ${psQuote(resolved.kind)}; target = $target; processFound = $null; processId = $null }
Start-Process -FilePath $target
$result.ok = $true
${probe}`;
  return runPs(body);
}

// ---------------------------------------------------------------- 能力实现
async function runAppLaunch(task, ctx) {
  const params = paramsOf(task);
  const input = params.app || params.name || params.target;
  await step(ctx, '解析程序', String(input || ''));
  const resolved = resolveApp(input);
  const launched = await launchResolved(resolved);
  if (!launched.ok) throw new Error(`打开失败：${launched.error || '未知原因'}`);
  const verified = launched.processFound === true;
  return {
    summary: `已打开「${resolved.name}」${verified ? `（进程已确认运行，PID ${launched.processId}）` : '（已发起启动）'}`,
    items: [{ name: resolved.name, ok: true, detail: `${resolved.mode}${verified ? ' · 进程已确认' : ''}${resolved.kind === 'url' ? ' · URL' : ''}` }],
    partial: false,
  };
}

async function runUrlOpen(task, ctx) {
  if (!isWindows()) throw new Error('仅 Windows 支持打开本机浏览器');
  const params = paramsOf(task);
  const url = String(params.url || params.target || '').trim();
  if (!url) throw new Error('缺少参数 url');
  if (url.length > MAX_URL_LENGTH) throw new Error('url 过长（上限 2048 字符）');
  if (!/^https?:\/\/[^\s"'<>\\]+$/i.test(url)) throw new Error(`URL 不合法（仅允许 http/https，且不能含空格/引号/尖括号）：${url.slice(0, 80)}`);
  const fullscreen = params.fullscreen === true || params.fullscreen === 'true' || params.fullscreen === 1;
  await step(ctx, fullscreen ? '全屏打开网页' : '打开网页', url);
  let body;
  let method;
  if (fullscreen) {
    const chrome = resolveApp('chrome');
    const chromePath = chrome.kind === 'path' ? chrome.target : null;
    const edge = chromePath ? null : APP_CATALOG.find((item) => item.id === 'edge');
    const edgeFound = edge ? findOnPath(edge.command) : null;
    if (chromePath) {
      method = 'Chrome --start-fullscreen';
      body = `$result = @{ ok = $false; error = $null; method = ${psQuote(method)} }
Start-Process -FilePath ${psQuote(chromePath)} -ArgumentList @('--start-fullscreen', ${psQuote(url)})
$result.ok = $true`;
    } else if (edgeFound) {
      method = 'Edge --start-fullscreen';
      body = `$result = @{ ok = $false; error = $null; method = ${psQuote(method)} }
Start-Process -FilePath ${psQuote(edgeFound)} -ArgumentList @('--start-fullscreen', ${psQuote(url)})
$result.ok = $true`;
    } else {
      method = '默认浏览器（全屏不可用，已回退）';
      body = `$result = @{ ok = $false; error = $null; method = ${psQuote(method)}; fallback = $true }
Start-Process -FilePath ${psQuote(url)}
$result.ok = $true`;
    }
  } else {
    method = '默认浏览器';
    body = `$result = @{ ok = $false; error = $null; method = '默认浏览器' }
Start-Process -FilePath ${psQuote(url)}
$result.ok = $true`;
  }
  const opened = await runPs(body, 25000);
  if (!opened.ok) throw new Error(`打开网页失败：${opened.error || '未知原因'}`);
  return {
    summary: `已${fullscreen ? '全屏' : ''}打开网页：${url}（${opened.method || method}）`,
    items: [{ name: url, ok: true, detail: opened.method || method }],
    partial: false,
  };
}

async function runMediaShow(task, ctx) {
  if (!isWindows()) throw new Error('仅 Windows 支持本机打开媒体文件');
  const params = paramsOf(task);
  const target = params.path || params.file || params.target;
  if (!target) throw new Error('缺少参数 path（图片/视频/文件路径）');
  const full = resolveFromRoot(target, ctx);
  if (!fs.existsSync(full)) throw new Error(`文件不存在：${full}`);
  const stat = fs.statSync(full);
  if (!stat.isFile()) throw new Error(`不是普通文件：${full}`);
  const kind = classifyFileKind(full);
  await step(ctx, '用默认程序打开', `${path.basename(full)}（${formatBytes(stat.size)}）`);
  const opened = await launchResolved({ kind: 'file', target: full });
  if (!opened.ok) throw new Error(`打开媒体失败：${opened.error || '未知原因'}`);
  const kindLabel = { image: '图片', video: '视频', audio: '音频', document: '文档' }[kind] || '文件';
  return {
    summary: `已用默认程序打开${kindLabel}：${path.basename(full)}（${formatBytes(stat.size)}）`,
    items: [{ name: path.basename(full), ok: true, detail: `${kind} · ${formatBytes(stat.size)} → 默认程序` }],
    partial: false,
  };
}

export function buildHandoffUrl({ kind = 'text', url = null, text = null, hubUrl } = {}) {
  const base = String(hubUrl || process.env.TENON_HUB_URL || 'http://127.0.0.1:7410').trim().replace(/\/+$/, '');
  const query = new URLSearchParams();
  query.set('kind', String(kind || 'text'));
  if (url) query.set('url', String(url));
  if (text) query.set('text', String(text).slice(0, 2000));
  return `${base}/#/handoff?${query.toString()}`;
}

async function runHandoffShow(task, ctx) {
  if (!isWindows()) throw new Error('仅 Windows 支持本机流转展示');
  const params = paramsOf(task);
  const kind = String(params.kind || 'text').toLowerCase();
  if (!['page', 'link', 'photo', 'text', 'file'].includes(kind)) throw new Error(`不支持的 kind：${kind}（page/link/photo/text/file）`);
  const url = params.url ? String(params.url) : null;
  const text = params.text ? String(params.text) : null;
  if (kind !== 'text' && !url && !text) throw new Error(`kind=${kind} 需要 url 或 text`);
  if (url && !/^https?:\/\/[^\s"'<>\\]+$/i.test(url)) throw new Error(`url 不合法（仅允许 http/https）：${url.slice(0, 80)}`);
  const hubUrl = (ctx && ctx.hubUrl) || process.env.TENON_HUB_URL || 'http://127.0.0.1:7410';
  const shownUrl = buildHandoffUrl({ kind, url, text, hubUrl });
  if (shownUrl.length > MAX_URL_LENGTH * 2) throw new Error('流转 URL 过长');
  await step(ctx, '电脑大屏展示流转内容', shownUrl.slice(0, 120));
  const opened = await runPs(`$result = @{ ok = $false; error = $null; method = '默认浏览器' }
Start-Process -FilePath ${psQuote(shownUrl)}
$result.ok = $true`, 25000);
  if (!opened.ok) throw new Error(`流转展示失败：${opened.error || '未知原因'}`);
  return {
    summary: `已在电脑大屏展示流转内容（kind=${kind}）→ ${shownUrl}`,
    items: [{ name: kind, ok: true, detail: shownUrl }],
    partial: false,
  };
}

async function runAppList(task, ctx) {
  const apps = listApps();
  const available = apps.filter((app) => app.available);
  await step(ctx, '扫描本机程序', `内置 ${apps.length} 个，可用 ${available.length} 个`);
  return {
    summary: `本机可用程序 ${available.length}/${apps.length} 个：${available.map((app) => app.name).join('、') || '无'}；另支持完整路径、http(s) URL 与 PATH 命令`,
    items: apps.map((app) => ({
      name: app.name,
      ok: app.available,
      detail: app.available ? `${app.mode} · ${app.target}` : '未安装/未找到',
    })),
    partial: false,
  };
}

// ---------------------------------------------------------------- manifest + 导出
export const appCapabilities = [
  {
    id: 'app.launch',
    name: '打开电脑程序',
    risk: 'reversible',
    manualOnly: false,
    version: APP_VERSION,
    evidence: 'confirmed',
    inputs: ['app（内置程序名，如 记事本/Chrome/微信；或完整路径；或 URL）'],
    outputs: ['对应程序在本机前台启动'],
    run: runAppLaunch,
  },
  {
    id: 'url.open',
    name: '打开网页',
    risk: 'reversible',
    manualOnly: false,
    version: APP_VERSION,
    evidence: 'confirmed',
    inputs: ['url（http/https）', 'fullscreen（可选，true 时用 Chrome/Edge --start-fullscreen）'],
    outputs: ['默认浏览器打开该网页（可全屏）'],
    run: runUrlOpen,
  },
  {
    id: 'media.show',
    name: '大屏打开图片/视频',
    risk: 'reversible',
    manualOnly: false,
    version: APP_VERSION,
    evidence: 'confirmed',
    inputs: ['path（图片/视频/文件，相对仓库根或绝对路径）'],
    outputs: ['默认程序在本机打开该文件（真实可见）'],
    run: runMediaShow,
  },
  {
    id: 'handoff.show',
    name: '流转内容上大屏',
    risk: 'reversible',
    manualOnly: false,
    version: APP_VERSION,
    evidence: 'confirmed',
    inputs: ['kind（page/link/photo/text/file）', 'url（可选）', 'text（可选）'],
    outputs: ['浏览器打开 <中枢>/#/handoff?kind=..&url=..&text=..'],
    run: runHandoffShow,
  },
  {
    id: 'app.list',
    name: '本机可启动程序清单',
    risk: 'reversible',
    manualOnly: false,
    version: APP_VERSION,
    evidence: 'confirmed',
    inputs: [],
    outputs: ['内置程序清单（名称/可用性/启动方式/路径）'],
    run: runAppList,
  },
];

function manifestOf(capability) {
  return {
    id: capability.id,
    name: capability.name,
    risk: capability.risk,
    manualOnly: !!capability.manualOnly,
    version: capability.version,
    evidence: capability.evidence,
    inputs: capability.inputs,
    outputs: capability.outputs,
  };
}

export const appsManifest = appCapabilities.map(manifestOf);

export function findAppCapability(id) {
  return appCapabilities.find((capability) => capability.id === id) || null;
}

export default { APP_VERSION, APP_CATALOG, appCapabilities, appsManifest, resolveApp, listApps, findOnPath, buildHandoffUrl, findAppCapability };