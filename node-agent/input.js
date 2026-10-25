// 榫卯 Tenon v2 · Round3 手机遥控输入能力（input.mouse / input.key / input.media）
// 走 Win32 SendInput/keybd_event，真实控制鼠标、键盘、媒体键；每个能力返回可验证证据（光标位置/前台窗口/按键）。
// 只在 Windows 生效；非 Windows 明确报错，不假装成功。
import {
  isWindows,
  psQuote,
  runPowerShell,
  makeTempDir,
  removeTempDir,
  readUtf8Json,
  wrapResultScript,
} from './lib/ps.js';

export const INPUT_VERSION = '3.0.0';

const MEDIA_VK = {
  'play-pause': 0xb3,
  next: 0xb0,
  prev: 0xb1,
  mute: 0xad,
  'vol-up': 0xaf,
  'vol-down': 0xae,
};

// 白名单组合键 → 按下/抬起的 VK 序列
const COMBO_VK = {
  enter: { tap: [0x0d] },
  esc: { tap: [0x1b] },
  escape: { tap: [0x1b] },
  tab: { tap: [0x09] },
  space: { tap: [0x20] },
  backspace: { tap: [0x08] },
  delete: { tap: [0x2e] },
  up: { tap: [0x26] },
  down: { tap: [0x28] },
  left: { tap: [0x25] },
  right: { tap: [0x27] },
  home: { tap: [0x24] },
  end: { tap: [0x23] },
  pageup: { tap: [0x21] },
  pagedown: { tap: [0x22] },
  'ctrl+a': { hold: [0x11], tap: [0x41] },
  'ctrl+c': { hold: [0x11], tap: [0x43] },
  'ctrl+v': { hold: [0x11], tap: [0x56] },
  'ctrl+x': { hold: [0x11], tap: [0x58] },
  'ctrl+z': { hold: [0x11], tap: [0x5a] },
  'ctrl+s': { hold: [0x11], tap: [0x53] },
  'ctrl+w': { hold: [0x11], tap: [0x57] },
  'ctrl+shift+esc': { hold: [0x11, 0x10], tap: [0x1b] },
  'alt+tab': { hold: [0x12], tap: [0x09] },
  'alt+f4': { hold: [0x12], tap: [0x73] },
  'win+d': { hold: [0x5b], tap: [0x44] },
  'win+e': { hold: [0x5b], tap: [0x45] },
  'win+r': { hold: [0x5b], tap: [0x52] },
};

export const CS_AUDIO = `using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int NotImpl1(); [return: MarshalAs(UnmanagedType.Interface)] object GetDefaultAudioEndpoint(int dataFlow, int role); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int NotImplActivate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer); }
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint channelCount);
  [PreserveSig] int SetMasterVolumeLevel(float level, ref Guid eventContext);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
  [PreserveSig] int GetMasterVolumeLevel(out float level);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, ref Guid eventContext);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
  [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
  [PreserveSig] int VolumeStepUp(ref Guid eventContext);
  [PreserveSig] int VolumeStepDown(ref Guid eventContext);
  [PreserveSig] int QueryHardwareSupport(out uint mask);
  [PreserveSig] int GetVolumeRange(out float min, out float max, out float increment);
}
public static class TenonAudio {
  static IAudioEndpointVolume Open() {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    var device = (IMMDevice)enumerator.GetDefaultAudioEndpoint(0, 1);
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object raw; device.NotImplActivate(ref iid, 23, IntPtr.Zero, out raw);
    return (IAudioEndpointVolume)raw;
  }
  public static object[] Read() { var v = Open(); float level; bool mute; v.GetMasterVolumeLevelScalar(out level); v.GetMute(out mute); return new object[] { Math.Round(level * 100.0, 1), mute }; }
  public static object[] Step(int delta) {
    var v = Open(); float level; v.GetMasterVolumeLevelScalar(out level);
    float next = level + delta * 0.02f; if (next > 1f) next = 1f; if (next < 0f) next = 0f;
    Guid g = Guid.Empty; int hr = v.SetMasterVolumeLevelScalar(next, ref g); float cur; v.GetMasterVolumeLevelScalar(out cur);
    return new object[] { hr, Math.Round(cur * 100.0, 1) };
  }
  public static object[] SetVolume(float level) {
    var v = Open(); Guid g = Guid.Empty; int hr = v.SetMasterVolumeLevelScalar(level, ref g); float cur; v.GetMasterVolumeLevelScalar(out cur);
    return new object[] { hr, Math.Round(cur * 100.0, 1) };
  }
  public static object[] EnsureMute() {
    var v = Open(); bool mute; v.GetMute(out mute);
    if (!mute) { Guid g = Guid.Empty; v.SetMute(true, ref g); }
    bool cur; v.GetMute(out cur);
    return new object[] { 0, cur };
  }
  public static object[] ToggleMute() { var v = Open(); bool mute; v.GetMute(out mute); Guid g = Guid.Empty; int hr = v.SetMute(!mute, ref g); bool cur; v.GetMute(out cur); return new object[] { hr, cur }; }
}`;
const CS_INPUT = `using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class TenonInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size = 40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  const uint MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, WHEEL = 0x0800;
  const uint KEYUP = 0x0002, UNICODE = 0x0004, UNICODE_UP = 0x0006;
  public static int[] Pos() { POINT p; GetCursorPos(out p); return new int[] { p.X, p.Y }; }
  public static void MoveRel(int dx, int dy) { POINT p; GetCursorPos(out p); SetCursorPos(p.X + dx, p.Y + dy); }
  public static void MoveAbs(int x, int y) { SetCursorPos(x, y); }
  public static void Click(string b) {
    if (b == "right") { mouse_event(RDOWN, 0, 0, 0, UIntPtr.Zero); mouse_event(RUP, 0, 0, 0, UIntPtr.Zero); }
    else if (b == "middle") { mouse_event(0x0020, 0, 0, 0, UIntPtr.Zero); mouse_event(0x0040, 0, 0, 0, UIntPtr.Zero); }
    else { mouse_event(LDOWN, 0, 0, 0, UIntPtr.Zero); mouse_event(LUP, 0, 0, 0, UIntPtr.Zero); }
  }
  public static void Down(string b) { mouse_event(b == "right" ? RDOWN : LDOWN, 0, 0, 0, UIntPtr.Zero); }
  public static void Up(string b) { mouse_event(b == "right" ? RUP : LUP, 0, 0, 0, UIntPtr.Zero); }
  public static void Wheel(int delta) { mouse_event(WHEEL, 0, 0, delta, UIntPtr.Zero); }
  public static void KeyDown(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void KeyUp(byte vk) { keybd_event(vk, 0, KEYUP, UIntPtr.Zero); }
  public static void Key(byte vk) { KeyDown(vk); KeyUp(vk); }
  public static void TypeText(string text) {
    List<INPUT> list = new List<INPUT>();
    foreach (char c in text) {
      INPUT down = new INPUT(); down.type = 1; down.ki.wVk = 0; down.ki.wScan = (ushort)c; down.ki.dwFlags = UNICODE;
      INPUT up = new INPUT(); up.type = 1; up.ki.wVk = 0; up.ki.wScan = (ushort)c; up.ki.dwFlags = UNICODE_UP;
      list.Add(down); list.Add(up);
    }
    SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
  public static string ForegroundTitle() {
    IntPtr h = GetForegroundWindow();
    StringBuilder sb = new StringBuilder(512);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
}`;

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
      /* 进度上报失败不影响输入执行 */
    }
  }
}

function runPs(body, timeoutMs = 12000) {
  const dir = makeTempDir('tenon-input-');
  return (async () => {
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
}

function guardWindows() {
  if (!isWindows()) throw new Error('手机遥控输入仅支持 Windows 电脑');
}

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ---------- input.mouse ----------
async function runMouse(task, ctx) {
  guardWindows();
  const params = paramsOf(task);
  const action = String(params.action || 'move').toLowerCase();
  const button = ['left', 'right', 'middle'].includes(String(params.button || 'left')) ? String(params.button || 'left') : 'left';
  await step(ctx, '鼠标动作', action);
  if (action === 'move') {
    const dx = clampInt(params.dx, -4000, 4000, 0);
    const dy = clampInt(params.dy, -4000, 4000, 0);
    const hasAbs = params.x !== undefined || params.y !== undefined;
    const x = clampInt(params.x, 0, 100000, 0);
    const y = clampInt(params.y, 0, 100000, 0);
    if (!hasAbs && dx === 0 && dy === 0) throw new Error('move 需要 dx/dy 或 x/y');
    const body = `Add-Type -TypeDefinition ${psQuote(CS_INPUT)}
$before = [TenonInput]::Pos()
${hasAbs ? `[TenonInput]::MoveAbs(${x}, ${y})` : `[TenonInput]::MoveRel(${dx}, ${dy})`}
Start-Sleep -Milliseconds 30
$after = [TenonInput]::Pos()
$result = @{ ok = $true; action = 'move'; before = $before; after = $after; mode = '${hasAbs ? 'absolute' : 'relative'}' }`;
    const r = await runPs(body);
    if (!r.ok) throw new Error(`鼠标移动失败：${r.error || '未知'}`);
    return {
      summary: `鼠标已移动（${r.mode === 'absolute' ? `绝对 ${x},${y}` : `相对 ${dx},${dy}`}）→ ${r.after[0]},${r.after[1]}`,
      items: [{ name: 'cursor', ok: true, detail: `before=${r.before.join(',')} after=${r.after.join(',')}` }],
      partial: false,
      evidence: { cursor: r.after, before: r.before, mode: r.mode },
    };
  }
  if (['click', 'down', 'up'].includes(action)) {
    const body = `Add-Type -TypeDefinition ${psQuote(CS_INPUT)}
$before = [TenonInput]::Pos()
[TenonInput]::${action === 'click' ? 'Click' : action === 'down' ? 'Down' : 'Up'}('${button}')
Start-Sleep -Milliseconds 40
$after = [TenonInput]::Pos()
$result = @{ ok = $true; action = '${action}'; button = '${button}'; before = $before; after = $after; title = [TenonInput]::ForegroundTitle() }`;
    const r = await runPs(body);
    if (!r.ok) throw new Error(`鼠标${action}失败：${r.error || '未知'}`);
    return {
      summary: `已在 ${r.after[0]},${r.after[1]} 执行鼠标${action === 'click' ? '单击' : action === 'down' ? '按下' : '抬起'}（${button}）· 前台：${String(r.title || '')}`,
      items: [{ name: 'cursor', ok: true, detail: `at=${r.after.join(',')}` }, { name: 'foreground', ok: true, detail: String(r.title || '') }],
      partial: false,
      evidence: { cursor: r.after, button, foreground: r.title || '' },
    };
  }
  if (action === 'wheel') {
    const delta = clampInt(params.delta, -6000, 6000, 120);
    const body = `Add-Type -TypeDefinition ${psQuote(CS_INPUT)}
[TenonInput]::Wheel(${delta})
$result = @{ ok = $true; action = 'wheel'; delta = ${delta}; cursor = [TenonInput]::Pos(); title = [TenonInput]::ForegroundTitle() }`;
    const r = await runPs(body);
    if (!r.ok) throw new Error(`滚轮失败：${r.error || '未知'}`);
    return {
      summary: `鼠标滚轮 ${delta > 0 ? '向下' : '向上'} ${Math.abs(delta)}`,
      items: [{ name: 'wheel', ok: true, detail: `delta=${delta}` }],
      partial: false,
      evidence: { delta, cursor: r.cursor },
    };
  }
  throw new Error(`不支持的鼠标动作：${action}（支持 move/click/down/up/wheel）`);
}

// ---------- input.key ----------
async function runKey(task, ctx) {
  guardWindows();
  const params = paramsOf(task);
  const text = params.text !== undefined ? String(params.text) : '';
  const comboRaw = String(params.combo || params.keys || '').toLowerCase().trim();
  if (!text && !comboRaw) throw new Error('input.key 需要 text 或 combo（如 enter / ctrl+a / alt+tab）');
  if (text.length > 500) throw new Error('text 最长 500 字符');
  if (text) {
    await step(ctx, '键盘输入文字', text.slice(0, 40) + (text.length > 40 ? '…' : ''));
    const body = `Add-Type -TypeDefinition ${psQuote(CS_INPUT)}
$titleBefore = [TenonInput]::ForegroundTitle()
[TenonInput]::TypeText(${psQuote(text)})
Start-Sleep -Milliseconds 60
$result = @{ ok = $true; kind = 'text'; length = ${text.length}; foreground = $titleBefore }`;
    const r = await runPs(body);
    if (!r.ok) throw new Error(`键盘输入失败：${r.error || '未知'}`);
    return {
      summary: `已在「${String(r.foreground || '当前窗口')}」输入 ${text.length} 个字符`,
      items: [{ name: 'text', ok: true, detail: text.slice(0, 60) }],
      partial: false,
      evidence: { kind: 'text', length: text.length, foreground: r.foreground || '' },
    };
  }
  const combo = COMBO_VK[comboRaw];
  if (!combo) throw new Error(`不支持的组合键：${comboRaw}（白名单见接口文档，如 enter/esc/ctrl+a/ctrl+c/ctrl+v/alt+tab/win+d）`);
  await step(ctx, '组合键', comboRaw);
  const hold = combo.hold || [];
  const taps = combo.tap || [];
  const lines = [`Add-Type -TypeDefinition ${psQuote(CS_INPUT)}`];
  hold.forEach((vk) => lines.push(`[TenonInput]::KeyDown(${vk})`));
  taps.forEach((vk) => lines.push(`[TenonInput]::Key(${vk})`));
  [...hold].reverse().forEach((vk) => lines.push(`[TenonInput]::KeyUp(${vk})`));
  lines.push(`Start-Sleep -Milliseconds 60`);
  lines.push(`$result = @{ ok = $true; kind = 'combo'; combo = '${comboRaw}'; foreground = [TenonInput]::ForegroundTitle(); cursor = [TenonInput]::Pos() }`);
  const r = await runPs(lines.join('\n'));
  if (!r.ok) throw new Error(`组合键失败：${r.error || '未知'}`);
  return {
    summary: `已发送组合键 ${comboRaw}（前台窗口「${String(r.foreground || '')}」）`,
    items: [{ name: comboRaw, ok: true, detail: 'combo sent' }, { name: 'foreground', ok: true, detail: String(r.foreground || '') }],
    partial: false,
    evidence: { kind: 'combo', combo: comboRaw, foreground: r.foreground || '' },
  };
}

// ---------- input.media ----------
// 音量/静音优先走 CoreAudio（设置后回读真实音量，证据可验证）；播放/暂停/上一曲/下一曲走系统媒体键。
async function runMedia(task, ctx) {
  guardWindows();
  const params = paramsOf(task);
  const action = String(params.action || '').toLowerCase();
  if (!MEDIA_VK[action]) throw new Error(`不支持的媒体动作：${action || '（空）'}（支持 ${Object.keys(MEDIA_VK).join(' / ')}）`);
  await step(ctx, '媒体/音量键', action);
  const vk = MEDIA_VK[action];
  const repeat = Math.max(1, Math.min(20, Number(params.steps) || 1));
  const label = { 'play-pause': '播放/暂停', next: '下一曲', prev: '上一曲', mute: '静音切换', 'vol-up': '音量+', 'vol-down': '音量-' }[action];
  const isVolume = action === 'mute' || action === 'vol-up' || action === 'vol-down';
  const lines = [`Add-Type -TypeDefinition ${psQuote(CS_INPUT)}`];
  lines.push(`Add-Type -TypeDefinition ${psQuote(CS_AUDIO)}`);
  lines.push('$title = [TenonInput]::ForegroundTitle()');
  if (isVolume) {
    lines.push('$before = [TenonAudio]::Read()');
    lines.push("$mode = 'coreaudio'");
    if (action === 'mute') lines.push('$hr = [TenonAudio]::ToggleMute()');
    else lines.push(`for ($i = 0; $i -lt ${repeat}; $i++) { $hr = [TenonAudio]::Step(${action === 'vol-up' ? 1 : -1}) }`);
    lines.push('Start-Sleep -Milliseconds 120');
    lines.push('$after = [TenonAudio]::Read()');
  } else {
    lines.push("$mode = 'media-key'");
    lines.push(`for ($i = 0; $i -lt ${repeat}; $i++) { [TenonInput]::Key(${vk}); Start-Sleep -Milliseconds 80 }`);
    lines.push('$before = [TenonAudio]::Read()');
    lines.push('$after = $before');
  }
  lines.push(`$result = @{ ok = $true; action = '${action}'; vk = ${vk}; repeat = ${repeat}; mode = $mode; before = $before; after = $after; foreground = $title }`);
  let r = await runPs(lines.join('\n'));
  if (!r.ok) {
    // CoreAudio 不可用时回退系统媒体键，并在结果里写明降级（不假装成功）
    const fallback = `Add-Type -TypeDefinition ${psQuote(CS_INPUT)}
$title = [TenonInput]::ForegroundTitle()
for ($i = 0; $i -lt ${repeat}; $i++) { [TenonInput]::Key(${vk}); Start-Sleep -Milliseconds 80 }
$result = @{ ok = $true; action = '${action}'; vk = ${vk}; repeat = ${repeat}; mode = 'media-key-fallback'; error = ${psQuote(String(r.error || ''))}; foreground = $title }`;
    r = await runPs(fallback);
    if (!r.ok) throw new Error(`媒体键失败：${r.error || '未知'}`);
  }
  const ev = { action, mode: r.mode, vk, foreground: r.foreground || '', before: r.before || null, after: r.after || null };
  if (r.mode === 'coreaudio') {
    const beforeVol = Number(r.before && r.before[0]);
    const afterVol = Number(r.after && r.after[0]);
    const beforeMute = !!(r.before && r.before[1]);
    const afterMute = !!(r.after && r.after[1]);
    const detail = action === 'mute'
      ? `静音：${beforeMute ? '开' : '关'} → ${afterMute ? '开' : '关'}（音量 ${afterVol}%）`
      : `音量：${beforeVol}% → ${afterVol}%（${repeat} 档）`;
    return {
      summary: `已真实调整系统音量：${detail}`,
      items: [{ name: action, ok: true, detail }, { name: 'volume', ok: true, detail: `before=${beforeVol}% after=${afterVol}% mute=${afterMute}` }],
      partial: false,
      evidence: { ...ev, beforeVolume: beforeVol, afterVolume: afterVol, beforeMute, afterMute },
    };
  }
  return {
    summary: `已执行媒体键：${label}（前台窗口「${String(r.foreground || '')}」）`,
    items: [{ name: action, ok: true, detail: `vk=0x${vk.toString(16)} repeat=${repeat} mode=${r.mode}` }],
    partial: false,
    evidence: ev,
  };
}

function manifestOf(cap) {
  return {
    id: cap.id,
    name: cap.name,
    risk: cap.risk,
    manualOnly: !!cap.manualOnly,
    version: cap.version,
    evidence: cap.evidence,
    inputs: cap.inputs,
    outputs: cap.outputs,
  };
}

export const inputCapabilities = [
  {
    id: 'input.mouse',
    name: '控制鼠标',
    risk: 'reversible',
    manualOnly: false,
    version: INPUT_VERSION,
    evidence: 'confirmed',
    inputs: ['action: move|click|down|up|wheel', 'dx/dy（相对移动）或 x/y（绝对定位）', 'button: left|right|middle', 'delta（滚轮）'],
    outputs: ['Windows 光标位置变化', '鼠标按键/滚轮事件'],
    run: runMouse,
  },
  {
    id: 'input.key',
    name: '输入键盘',
    risk: 'reversible',
    manualOnly: false,
    version: INPUT_VERSION,
    evidence: 'confirmed',
    inputs: ['text（最多 500 字符，Unicode 输入）', 'combo（白名单：enter/esc/tab/ctrl+a/c/v/x/z/s、alt+tab、win+d 等）'],
    outputs: ['当前前台窗口收到键盘输入'],
    run: runKey,
  },
  {
    id: 'input.media',
    name: '媒体/音量键',
    risk: 'reversible',
    manualOnly: false,
    version: INPUT_VERSION,
    evidence: 'confirmed',
    inputs: ['action: play-pause|next|prev|mute|vol-up|vol-down', 'steps（可选，音量连按次数）'],
    outputs: ['系统媒体控制/音量变化'],
    run: runMedia,
  },
];

export const inputManifest = inputCapabilities.map(manifestOf);

export function findInputCapability(id) {
  return inputCapabilities.find((cap) => cap.id === id) || null;
}

export default { INPUT_VERSION, inputCapabilities, inputManifest, findInputCapability };