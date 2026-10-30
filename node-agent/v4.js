// 榫卯 V4 · node-agent 执行器能力：system.exec / window.list / window.focus / screen.capture
// 全部本机执行、不转发；写成 TENON_V2=1 时的任务能力，由现有 task pull 队列派发。
// 安全：
//   - system.exec 只走 cmd.exe /d /s /c，危险操作黑名单（格式化/关机/diskpart/reg delete/递归删除…）直接拒绝；
//     超时 kill 进程树；stdout/stderr 各截断 4000 字；所有执行（含被拒绝的）本地落 data/exec-audit.log。
//   - window.focus 只按标题/进程名匹配真实可见窗口，不接受任意参数拼接。
//   - screen.capture 只写 data/screen/ 下 PNG；可选 base64（超过 512KB 不内联，避免账本膨胀）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isWindows, psQuote, runPowerShell, makeTempDir, removeTempDir, readUtf8Json, wrapResultScript } from './lib/ps.js';

export const V4_VERSION = '4.0.0';
export const EXEC_MAX_OUTPUT = 4000;
export const EXEC_DEFAULT_TIMEOUT_MS = 15000;
export const EXEC_MAX_TIMEOUT_MS = 120000;
export const WINDOW_LIMIT = 50;
export const SCREEN_MAX_BASE64_BYTES = 512 * 1024;
const CAPTURE_MEMORY_LIMIT = 200000;

// ---------------------------------------------------------------- 公共工具
function repoRootOf(ctx) {
  return ctx && ctx.repoRoot ? path.resolve(ctx.repoRoot) : process.cwd();
}

function dataDirOf(ctx) {
  return ctx && ctx.dataDir ? path.resolve(ctx.dataDir) : path.join(repoRootOf(ctx), 'data');
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
      /* 进度上报失败不影响能力 */
    }
  }
}

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

export function truncateOutput(text, max = EXEC_MAX_OUTPUT) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.length <= max) return { text: value, truncated: false, originalLength: value.length };
  return {
    text: `${value.slice(0, max)}\n…[已截断：原始 ${value.length} 字符，仅保留前 ${max}]`,
    truncated: true,
    originalLength: value.length,
  };
}

// 中文 Windows 的 cmd 默认按 GBK 输出；先按 UTF-8 严格解码，失败再按 GBK 解码（对外统一返回字符串）
export function decodeCommandOutput(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (!buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

// ---------------------------------------------------------------- system.exec
// 危险操作黑名单（命中即拒绝执行；宁可误伤，不放行破坏性命令）
export const DANGEROUS_PATTERNS = [
  { re: /\bformat(\.com)?\b(?!-)/i, reason: '格式化磁盘' },
  { re: /\bdiskpart\b/i, reason: 'diskpart 磁盘分区' },
  { re: /\b(shutdown|restart-computer|stop-computer)\b/i, reason: '关机/重启' },
  { re: /\breg\s+delete\b/i, reason: 'reg delete 删除注册表' },
  { re: /\breg\s+add\b/i, reason: 'reg add 写注册表' },
  { re: /\b(del|erase)\b[^\n]*\/[a-z]*[sq]/i, reason: '递归/静默删除' },
  { re: /\b(rmdir|rd)\b[^\n]*\/s/i, reason: '递归删除目录' },
  { re: /\b(rm)\s+-(rf|fr|r\s+-f)\b/i, reason: 'rm -rf 递归删除' },
  { re: /\bremove-item\b[^\n]*\s-(recurse|r)\b/i, reason: 'Remove-Item 递归删除' },
  { re: /\b(mkfs|dd\s+if=|wipefs)\b/i, reason: '磁盘文件系统破坏' },
  { re: /\bbcdedit\b/i, reason: '修改启动配置' },
  { re: /\bvssadmin\b/i, reason: '卷影/备份删除' },
  { re: /\bcipher\b[^\n]*\/w/i, reason: '擦除磁盘空闲空间' },
  { re: /\bwmic\b[^\n]*\bdelete\b/i, reason: 'WMI 删除' },
  { re: /\bnet\s+(user|localgroup)\b[^\n]*\/delete/i, reason: '删除系统账户/组' },
  { re: /\bpowershell(\.exe)?\b[^\n]*-(enc|encodedcommand)\b/i, reason: '编码绕过执行 PowerShell' },
  { re: /\bcertutil\b[^\n]*-(urlcache|decode)\b/i, reason: 'certutil 下载/解码载荷' },
  { re: /\bicacls\b[^\n]*(\/reset|\/deny)/i, reason: '重置/拒绝文件权限' },
  { re: /\btakeown\b/i, reason: '夺取文件所有权' },
  { re: /\bdel\b[^\n]*\\windows\\/i, reason: '删除 Windows 系统目录文件' },
  { re: /(^|[^a-z])format\s+[a-z]:/i, reason: '格式化盘符' },
];

export function checkDangerousCommand(command) {
  const value = String(command === undefined || command === null ? '' : command);
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.re.test(value)) return { dangerous: true, reason: rule.reason, pattern: String(rule.re) };
  }
  return null;
}

export function auditFileOf(ctx) {
  return path.join(dataDirOf(ctx), 'exec-audit.log');
}

// 所有执行（含被拒绝的）都本地落 JSONL 审计；审计失败不影响执行结果
export function appendExecAudit(entry, ctx = {}) {
  try {
    const file = auditFileOf(ctx);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record = {
      at: new Date().toISOString(),
      nodeId: ctx.nodeId || null,
      taskId: ctx.taskId || null,
      via: 'node-agent',
      ...entry,
    };
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    return file;
  } catch {
    return null;
  }
}

function resolveCwd(raw, ctx) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!value) return repoRootOf(ctx);
  if (value.length > 400) throw new Error('cwd 过长（上限 400 字符）');
  if (/[\u0000-\u001f]/.test(value)) throw new Error('cwd 含有非法控制字符');
  const full = /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') ? path.resolve(value) : path.resolve(repoRootOf(ctx), value);
  if (!fs.existsSync(full)) throw new Error(`工作目录不存在：${full}`);
  if (!fs.statSync(full).isDirectory()) throw new Error(`cwd 不是目录：${full}`);
  return full;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => {});
  } catch {
    /* ignore */
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

// 核心执行器：cmd.exe /d /s /c <command>；返回 {ok,exitCode,stdout,stderr,durationMs,timeout,...}
export function execCommand(params = {}, ctx = {}) {
  return new Promise((resolve, reject) => {
    if (!isWindows()) {
      reject(new Error('仅 Windows 支持命令执行（system.exec）'));
      return;
    }
    const command = String(params.command === undefined || params.command === null ? '' : params.command).trim();
    if (!command) {
      reject(new Error('缺少参数 command（要执行的 Windows 命令）'));
      return;
    }
    if (command.length > 2000) {
      reject(new Error('command 过长（上限 2000 字符）'));
      return;
    }
    if (/[\u0000\r\n]/.test(command)) {
      reject(new Error('command 不允许包含 NUL 或换行符'));
      return;
    }
    const danger = checkDangerousCommand(command);
    if (danger) {
      appendExecAudit({ rejected: true, reason: danger.reason, command: command.slice(0, 300), ok: false }, ctx);
      reject(new Error(`命令被拒绝执行：命中危险操作黑名单「${danger.reason}」。如确需，请在电脑本地手动执行。`));
      return;
    }
    let cwd;
    try {
      cwd = resolveCwd(params.cwd, ctx);
    } catch (err) {
      reject(err);
      return;
    }
    const timeoutMs = clampInt(params.timeoutMs, 1000, EXEC_MAX_TIMEOUT_MS, EXEC_DEFAULT_TIMEOUT_MS);
    const startedAt = Date.now();
    const shell = process.env.ComSpec || 'cmd.exe';
    let child;
    try {
      child = spawn(shell, ['/d', '/s', '/c', command], { cwd, windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`启动 cmd.exe 失败：${err && err.message ? err.message : err}`));
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;
    let timedOut = false;
    let timer = null;
    const finish = (exitCode, spawnError) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      // 释放管道，避免 GUI 子进程继承句柄拖住 Node 进程
      try {
        if (child.stdout) child.stdout.destroy();
        if (child.stderr) child.stderr.destroy();
      } catch { /* ignore */ }
      try { child.unref(); } catch { /* ignore */ }
      const durationMs = Date.now() - startedAt;
      const stdout = decodeCommandOutput(Buffer.concat(stdoutChunks));
      const stderr = decodeCommandOutput(Buffer.concat(stderrChunks));
      const outInfo = truncateOutput(stdout);
      const errInfo = truncateOutput(stderr);
      const result = {
        ok: !spawnError && !timedOut && exitCode === 0,
        exitCode: timedOut ? null : exitCode === undefined ? null : exitCode,
        stdout: outInfo.text,
        stderr: errInfo.text,
        durationMs,
        timeout: timedOut,
        command,
        cwd,
        truncated: { stdout: outInfo.truncated, stderr: errInfo.truncated },
        originalLength: { stdout: outInfo.originalLength, stderr: errInfo.originalLength },
        rejected: false,
      };
      if (spawnError) result.error = String(spawnError && spawnError.message ? spawnError.message : spawnError);
      appendExecAudit(
        {
          command,
          cwd,
          timeoutMs,
          ok: result.ok,
          exitCode: result.exitCode,
          timeout: timedOut,
          durationMs,
          stdoutPreview: outInfo.text.slice(0, 500),
          stderrPreview: errInfo.text.slice(0, 500),
          error: result.error || null,
        },
        ctx,
      );
      resolve(result);
    };
    const collect = (which, chunk) => {
      if (which === 'stdout') {
        if (stdoutBytes >= CAPTURE_MEMORY_LIMIT) return;
        const slice = chunk.length > CAPTURE_MEMORY_LIMIT - stdoutBytes ? chunk.subarray(0, CAPTURE_MEMORY_LIMIT - stdoutBytes) : chunk;
        stdoutChunks.push(slice);
        stdoutBytes += slice.length;
      } else {
        if (stderrBytes >= CAPTURE_MEMORY_LIMIT) return;
        const slice = chunk.length > CAPTURE_MEMORY_LIMIT - stderrBytes ? chunk.subarray(0, CAPTURE_MEMORY_LIMIT - stderrBytes) : chunk;
        stderrChunks.push(slice);
        stderrBytes += slice.length;
      }
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    child.on('error', (err) => finish(null, err));
    // 用 exit 而不是只等 close：GUI 子进程（如 start notepad）会继承管道句柄，close 可能迟迟不触发
    child.on('exit', (code, signal) => {
      setTimeout(() => finish(code === null ? (signal ? 1 : null) : code), 150);
    });
    child.on('close', (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      setTimeout(() => finish(null), 1000);
    }, timeoutMs);
  });
}

async function runSystemExec(task, ctx) {
  const params = paramsOf(task);
  await step(ctx, '执行命令', String(params.command || '').slice(0, 120));
  const result = await execCommand(params, ctx);
  const timeoutNote = result.timeout ? '，超时已终止进程树' : '';
  const exitNote = result.exitCode === null ? '' : `，退出码 ${result.exitCode}`;
  const firstLine = String(result.stdout || '').split(/\r?\n/).find((line) => line.trim()) || String(result.stderr || '').split(/\r?\n/).find((line) => line.trim()) || '';
  return {
    summary: `已执行命令：${String(params.command).slice(0, 80)}（${result.durationMs}ms${exitNote}${timeoutNote}）${firstLine ? '；输出：' + firstLine.trim().slice(0, 120) : ''}`,
    items: [
      { name: 'stdout', ok: true, detail: result.stdout || '（空）' },
      { name: 'stderr', ok: true, detail: result.stderr || '（空）' },
    ],
    partial: !result.ok,
    ok: result.ok,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
    timeout: result.timeout,
    data: result,
  };
}

// ---------------------------------------------------------------- 窗口枚举 / 聚焦（Win32 user32）
const WINDOW_CS = `using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TenonWindowApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  public static List<IntPtr> VisibleWindows() {
    var list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) list.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string Title(IntPtr hWnd) {
    int len = GetWindowTextLength(hWnd);
    if (len <= 0) return "";
    var sb = new StringBuilder(len + 1);
    GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }
  public static uint PidOf(IntPtr hWnd) { uint pid; GetWindowThreadProcessId(hWnd, out pid); return pid; }
}`;

function windowCollectScript() {
  return `Add-Type -TypeDefinition @"
${WINDOW_CS}
"@
$fg = [int64][TenonWindowApi]::GetForegroundWindow()
$procNames = @{}
foreach ($p in Get-Process -ErrorAction SilentlyContinue) { $procNames[[int]$p.Id] = $p.ProcessName }
$windows = New-Object System.Collections.ArrayList
foreach ($h in [TenonWindowApi]::VisibleWindows()) {
  $title = [TenonWindowApi]::Title($h)
  if ([string]::IsNullOrWhiteSpace($title)) { continue }
  $windowPid = [int][TenonWindowApi]::PidOf($h)
  $processName = ''
  if ($procNames.ContainsKey($windowPid)) { $processName = [string]$procNames[$windowPid] }
  [void]$windows.Add(@{ handle = [int64]$h; title = $title; pid = $windowPid; process = $processName; foreground = ([int64]$h -eq $fg); minimized = [bool][TenonWindowApi]::IsIconic($h) })
}`;
}

function runPsJson(body, timeoutMs = 25000) {
  const dir = makeTempDir('tenon-v4-');
  const promise = (async () => {
    try {
      const resultFile = `${dir}\\result.json`;
      const script = wrapResultScript(body, resultFile);
      const run = await runPowerShell(script, { timeoutMs });
      const parsed = readUtf8Json(resultFile);
      if (!parsed) return { ok: false, error: `PowerShell 未返回结果（exit=${run.code}）${String(run.stderr || '').slice(0, 200)}` };
      return parsed;
    } finally {
      removeTempDir(dir);
    }
  })();
  return promise;
}

function sortWindows(windows) {
  return windows
    .slice()
    .sort((a, b) => {
      if (!!b.foreground !== !!a.foreground) return b.foreground ? 1 : -1;
      return String(a.process || '').localeCompare(String(b.process || ''), 'en');
    })
    .slice(0, WINDOW_LIMIT);
}

export async function listVisibleWindows({ ctx = {}, timeoutMs = 25000 } = {}) {
  if (!isWindows()) throw new Error('仅 Windows 支持窗口枚举（window.list）');
  const body = `${windowCollectScript()}
$result = @{ ok = $true; foregroundHandle = $fg; windows = @($windows) }`;
  const parsed = await runPsJson(body, timeoutMs);
  if (!parsed.ok) throw new Error(`窗口枚举失败：${parsed.error || '未知原因'}`);
  const windows = sortWindows(Array.isArray(parsed.windows) ? parsed.windows.map(normalizeWindow) : []);
  const foreground = Array.isArray(parsed.windows) ? parsed.windows.find((w) => w && w.foreground) : null;
  return {
    count: windows.length,
    foreground: foreground ? normalizeWindow(foreground) : null,
    windows,
    screenHint: '同一 Windows 会话内的可见顶层窗口（已过滤无标题/不可见），最多 50 条',
  };
}

function normalizeWindow(raw) {
  return {
    handle: Number(raw && raw.handle) || 0,
    title: String((raw && raw.title) || ''),
    pid: Number(raw && raw.pid) || 0,
    process: String((raw && raw.process) || ''),
    foreground: !!(raw && raw.foreground),
    minimized: !!(raw && raw.minimized),
  };
}

export function validateFocusParams(params = {}) {
  const title = params.title === undefined || params.title === null ? '' : String(params.title).trim();
  const process = params.process === undefined || params.process === null ? '' : String(params.process).trim();
  if (!title && !process) throw new Error('缺少参数：title（窗口标题）或 process（进程名）至少给一个');
  if (title.length > 200) throw new Error('title 过长（上限 200 字符）');
  if (process.length > 200) throw new Error('process 过长（上限 200 字符）');
  if (/[\u0000-\u001f]/.test(title + process)) throw new Error('title/process 含有非法控制字符');
  return { title, process };
}

export async function focusWindow(params = {}, { timeoutMs = 25000 } = {}) {
  if (!isWindows()) throw new Error('仅 Windows 支持窗口聚焦（window.focus）');
  const { title, process } = validateFocusParams(params);
  const body = `${windowCollectScript()}
$wantTitle = ${psQuote(title)}
$wantProcess = ${psQuote(process)}
$target = $null
$bestScore = -1
foreach ($w in $windows) {
  $score = -1
  if ($wantTitle) {
    $t = [string]$w.title
    if ($t -ieq $wantTitle) { $score = 100 }
    elseif ($t.ToLower().Contains($wantTitle.ToLower())) { $score = 50 }
  }
  if ($wantProcess) {
    $pname = [string]$w.process
    if ($pname -ieq $wantProcess) { if ($score -lt 90) { $score = 90 } }
    elseif ($pname.ToLower().Contains($wantProcess.ToLower())) { if ($score -lt 40) { $score = 40 } }
  }
  if ($score -gt $bestScore) { $bestScore = $score; $target = $w }
}
if (-not $target -or $bestScore -lt 0) {
  $sample = @($windows | Select-Object -First 5 | ForEach-Object { $_.title })
  $result = @{ ok = $false; error = '未找到匹配的窗口'; sample = $sample; want = @{ title = $wantTitle; process = $wantProcess } }
} else {
  $hWnd = [IntPtr]$target.handle
  if ($target.minimized) { [TenonWindowApi]::ShowWindow($hWnd, 9) | Out-Null; Start-Sleep -Milliseconds 200 }
  # 前台锁绕过：把目标窗口线程与当前前台线程 AttachThreadInput 后再 SetForegroundWindow
  try {
    $fgWnd = [TenonWindowApi]::GetForegroundWindow()
    $tmpPid = [uint32]0
    $fgThread = [uint32][TenonWindowApi]::GetWindowThreadProcessId($fgWnd, [ref]$tmpPid)
    $targetThread = [uint32][TenonWindowApi]::GetWindowThreadProcessId($hWnd, [ref]$tmpPid)
    $attached = [bool][TenonWindowApi]::AttachThreadInput($fgThread, $targetThread, $true)
    [TenonWindowApi]::BringWindowToTop($hWnd) | Out-Null
    [TenonWindowApi]::ShowWindow($hWnd, 9) | Out-Null
    [TenonWindowApi]::SetForegroundWindow($hWnd) | Out-Null
    [TenonWindowApi]::SetFocus($hWnd) | Out-Null
    if ($attached) { [TenonWindowApi]::AttachThreadInput($fgThread, $targetThread, $false) | Out-Null }
  } catch { }
  [TenonWindowApi]::SetForegroundWindow($hWnd) | Out-Null
  Start-Sleep -Milliseconds 400
  $nowFg = [int64][TenonWindowApi]::GetForegroundWindow()
  if ($nowFg -ne [int64]$hWnd) {
    # 再试一次：最小化 → 还原 → 置前（部分系统只对刚还原的窗口放行）
    [TenonWindowApi]::ShowWindow($hWnd, 6) | Out-Null
    Start-Sleep -Milliseconds 120
    [TenonWindowApi]::ShowWindow($hWnd, 9) | Out-Null
    [TenonWindowApi]::SetForegroundWindow($hWnd) | Out-Null
    Start-Sleep -Milliseconds 300
    $nowFg = [int64][TenonWindowApi]::GetForegroundWindow()
  }
  if ($nowFg -ne [int64]$hWnd) {
    try {
      Add-Type -AssemblyName Microsoft.VisualBasic
      [Microsoft.VisualBasic.Interaction]::AppActivate([int]$target.pid) | Out-Null
      Start-Sleep -Milliseconds 350
      $nowFg = [int64][TenonWindowApi]::GetForegroundWindow()
    } catch { }
  }
  $okFocus = ($nowFg -eq [int64]$hWnd)
  $result = @{ ok = $okFocus; foregroundHandle = $nowFg; target = $target; error = $(if ($okFocus) { $null } else { '窗口已找到但未能置前（可能受系统前台锁限制）' }) }
}`;
  const parsed = await runPsJson(body, timeoutMs);
  if (!parsed.ok) {
    const sample = Array.isArray(parsed.sample) ? parsed.sample.slice(0, 5) : [];
    throw new Error(`${parsed.error || '窗口激活失败'}${sample.length ? '；当前窗口示例：' + sample.join(' ｜ ') : ''}`);
  }
  return normalizeWindow(parsed.target);
}

async function runWindowList(task, ctx) {
  await step(ctx, '枚举可见窗口', '');
  const result = await listVisibleWindows({ ctx });
  const foreground = result.foreground;
  return {
    summary: `可见窗口 ${result.count} 个${foreground ? `（前台：${foreground.title} · ${foreground.process}）` : ''}`,
    items: result.windows.map((win) => ({
      name: win.title,
      ok: true,
      detail: `${win.process || '未知进程'} · PID ${win.pid}${win.foreground ? ' · 前台' : ''}${win.minimized ? ' · 最小化' : ''}`,
    })),
    partial: false,
    windows: result.windows,
    count: result.count,
    foreground,
    data: { count: result.count, foreground, windows: result.windows },
  };
}

async function runWindowFocus(task, ctx) {
  const params = paramsOf(task);
  await step(ctx, '聚焦窗口', [params.title, params.process].filter(Boolean).join(' / '));
  const target = await focusWindow(params);
  return {
    summary: `已切换到窗口：${target.title}（${target.process || '未知进程'}，PID ${target.pid}）`,
    items: [{ name: target.title, ok: true, detail: `${target.process} · PID ${target.pid} · 前台` }],
    partial: false,
    focused: target,
    data: { focused: target },
  };
}

// ---------------------------------------------------------------- 截屏
export function validateRegion(region) {
  if (region === undefined || region === null) return null;
  if (typeof region !== 'object') throw new Error('region 必须是 {x,y,width,height} 对象');
  const x = Number(region.x);
  const y = Number(region.y);
  const width = Number(region.width);
  const height = Number(region.height);
  if (![x, y, width, height].every((n) => Number.isFinite(n))) throw new Error('region 的 x/y/width/height 必须是数字');
  if (width < 1 || height < 1) throw new Error('region 宽高必须 >= 1');
  if (width > 20000 || height > 20000) throw new Error('region 宽高过大（上限 20000）');
  if (Math.abs(x) > 50000 || Math.abs(y) > 50000) throw new Error('region 坐标超出范围');
  return { x: Math.floor(x), y: Math.floor(y), width: Math.floor(width), height: Math.floor(height) };
}

export function screenDirOf(ctx) {
  return path.join(dataDirOf(ctx), 'screen');
}

export async function captureScreen(params = {}, ctx = {}) {
  if (!isWindows()) throw new Error('仅 Windows 支持截屏（screen.capture）');
  const region = validateRegion(params.region);
  const dir = screenDirOf(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `screen-${nowStamp()}.png`);
  const regionBody = region
    ? `$x = ${region.x}
$y = ${region.y}
$w = ${region.width}
$h = ${region.height}`
    : `$x = $vs.Left
$y = $vs.Top
$w = $vs.Width
$h = $vs.Height`;
  const body = `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
${regionBody}
$x = [Math]::Max($vs.Left, [Math]::Min([int]$x, $vs.Right - 1))
$y = [Math]::Max($vs.Top, [Math]::Min([int]$y, $vs.Bottom - 1))
$w = [Math]::Max(1, [Math]::Min([int]$w, $vs.Right - $x))
$h = [Math]::Max(1, [Math]::Min([int]$h, $vs.Bottom - $y))
$file = ${psQuote(file)}
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
$bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$result = @{ ok = $true; path = $file; width = $w; height = $h; screen = @{ x = $vs.Left; y = $vs.Top; width = $vs.Width; height = $vs.Height } }`;
  const parsed = await runPsJson(body, 30000);
  if (!parsed.ok) throw new Error(`截屏失败：${parsed.error || '未知原因'}`);
  if (!fs.existsSync(file)) throw new Error(`截屏失败：未生成文件 ${file}`);
  const stat = fs.statSync(file);
  if (!stat.size || stat.size < 100) throw new Error(`截屏失败：文件为空或过小（${stat.size} 字节）`);
  const head = Buffer.alloc(4);
  try {
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
  } catch {
    /* 读取失败交给下方校验 */
  }
  if (!head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) throw new Error('截屏失败：输出不是合法 PNG');
  const data = {
    ok: true,
    path: file,
    width: Number(parsed.width) || 0,
    height: Number(parsed.height) || 0,
    bytes: stat.size,
    mime: 'image/png',
    screen: parsed.screen || null,
    region: region || null,
    at: new Date().toISOString(),
  };
  let base64 = null;
  if (params.base64 === true || params.base64 === 'true') {
    if (stat.size <= SCREEN_MAX_BASE64_BYTES) {
      base64 = fs.readFileSync(file).toString('base64');
      data.base64 = base64;
      data.base64Bytes = base64.length;
    } else {
      data.base64Skipped = `截图 ${stat.size} 字节超过内联上限 ${SCREEN_MAX_BASE64_BYTES}，只返回路径`;
    }
  }
  return {
    summary: `已截屏：${data.width}×${data.height}（PNG，${Math.round(stat.size / 1024)} KB）${region ? '区域' : '全屏'} → ${file}`,
    items: [{ name: path.basename(file), ok: true, detail: `${data.width}×${data.height} · ${Math.round(stat.size / 1024)} KB${base64 ? ' · 含 base64' : ''}` }],
    partial: false,
    path: file,
    width: data.width,
    height: data.height,
    bytes: stat.size,
    mime: 'image/png',
    base64,
    data,
  };
}

async function runScreenCapture(task, ctx) {
  const params = paramsOf(task);
  await step(ctx, '截取屏幕', params.region ? JSON.stringify(params.region) : '全屏');
  const result = await captureScreen(params, ctx);
  appendExecAudit({ action: 'screen.capture', path: result.path, width: result.width, height: result.height, bytes: result.bytes, ok: true }, ctx);
  return result;
}

// ---------------------------------------------------------------- manifest + 导出
export const v4Capabilities = [
  {
    id: 'system.exec',
    name: '执行 Windows 命令',
    risk: 'irreversible',
    manualOnly: false,
    version: V4_VERSION,
    evidence: 'confirmed',
    inputs: ['command（cmd.exe 命令，≤2000 字符，危险操作黑名单拒绝）', 'cwd（可选，工作目录）', 'timeoutMs（可选，默认 15000，最大 120000）'],
    outputs: ['{ok,exitCode,stdout,stderr,durationMs}（stdout/stderr 各截断 4000 字）', 'data/exec-audit.log 本地审计'],
    run: runSystemExec,
  },
  {
    id: 'window.list',
    name: '列出可见窗口',
    risk: 'reversible',
    manualOnly: false,
    version: V4_VERSION,
    evidence: 'confirmed',
    inputs: [],
    outputs: ['可见窗口列表（标题/进程名/PID/是否前台/是否最小化），最多 50 条'],
    run: runWindowList,
  },
  {
    id: 'window.focus',
    name: '切换前台窗口',
    risk: 'reversible',
    manualOnly: false,
    version: V4_VERSION,
    evidence: 'confirmed',
    inputs: ['title（窗口标题，模糊匹配，可选）', 'process（进程名，可选；title/process 至少一个）'],
    outputs: ['目标窗口被激活到前台'],
    run: runWindowFocus,
  },
  {
    id: 'screen.capture',
    name: '截屏（OCR 输入）',
    risk: 'reversible',
    manualOnly: false,
    version: V4_VERSION,
    evidence: 'confirmed',
    inputs: ['region（可选 {x,y,width,height}，默认全屏/多屏虚拟桌面）', 'base64（可选 true 时内联 ≤512KB 的 base64）'],
    outputs: ['PNG 文件路径 + 宽高 + 字节数（默认落 data/screen/）'],
    run: runScreenCapture,
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

export const v4Manifest = v4Capabilities.map(manifestOf);

export function findV4Capability(id) {
  return v4Capabilities.find((capability) => capability.id === id) || null;
}

export default {
  V4_VERSION,
  EXEC_MAX_OUTPUT,
  DANGEROUS_PATTERNS,
  v4Capabilities,
  v4Manifest,
  findV4Capability,
  checkDangerousCommand,
  truncateOutput,
  decodeCommandOutput,
  execCommand,
  appendExecAudit,
  auditFileOf,
  listVisibleWindows,
  focusWindow,
  validateFocusParams,
  captureScreen,
  validateRegion,
  screenDirOf,
};