// 榫卯 v2 · Windows 通知桥
// 发送顺序：BurntToast（若装了）→ WinRT Toast → NotifyIcon 气泡 → msg.exe → 控制台日志兜底。
// 另外订阅中枢 SSE：notification.relayed 事件 → 本机通知（手机通知镜像）。
import { isWindows, psQuote, runPowerShell, makeTempDir, removeTempDir, readUtf8Json, wrapResultScript } from './lib/ps.js';
import { subscribeEvents } from './hub.js';

function winrtBody(title, body) {
  return `$result = @{ ok = $false; method = 'winrt'; error = $null }
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $nodes = $template.GetElementsByTagName('text')
  $nodes.Item(0).AppendChild($template.CreateTextNode(${psQuote(title)})) | Out-Null
  $nodes.Item(1).AppendChild($template.CreateTextNode(${psQuote(body)})) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  $aumid = ''
  try { $aumid = (Get-StartApps | Where-Object { $_.Name -like 'Windows PowerShell*' } | Select-Object -First 1).AppID } catch { $aumid = '' }
  if (-not $aumid) { $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe' }
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
  $result.ok = $true
} catch { $result.error = $_.Exception.Message }`;
}

function burntToastBody(title, body) {
  return `$result = @{ ok = $false; method = 'burnttoast'; error = $null }
try {
  if (-not (Get-Module -ListAvailable -Name BurntToast)) { throw 'BurntToast 模块未安装' }
  Import-Module BurntToast -ErrorAction Stop
  New-BurntToastNotification -Text ${psQuote(title)}, ${psQuote(body)} -ErrorAction Stop
  $result.ok = $true
} catch { $result.error = $_.Exception.Message }`;
}

function balloonBody(title, body) {
  return `$result = @{ ok = $false; method = 'notifyicon'; error = $null }
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icon = New-Object System.Windows.Forms.NotifyIcon
  $icon.Icon = [System.Drawing.SystemIcons]::Information
  $icon.Visible = $true
  $icon.ShowBalloonTip(5000, ${psQuote(title)}, ${psQuote(body)}, [System.Windows.Forms.ToolTipIcon]::Info)
  Start-Sleep -Milliseconds 1100
  $icon.Dispose()
  $result.ok = $true
} catch { $result.error = $_.Exception.Message }`;
}

function msgBody(title, body) {
  return `$result = @{ ok = $false; method = 'msg'; error = $null }
try {
  $msg = Get-Command msg.exe -ErrorAction Stop
  & $msg.Source * /TIME:5 (${psQuote(title + '：' + body)})
  $result.ok = $true
} catch { $result.error = $_.Exception.Message }`;
}

const METHODS = [
  { id: 'winrt', body: winrtBody },
  { id: 'notifyicon', body: balloonBody },
  { id: 'msg', body: msgBody },
];

// 发送一条本机 Windows 通知；返回 {ok, method, error}
export async function sendWindowsNotification({ title = '榫卯 Tenon', body = '', method, platform = process.platform, powershellPath, timeoutMs = 20000 } = {}) {
  const safeTitle = String(title || '榫卯 Tenon').slice(0, 120);
  const safeBody = String(body || '').slice(0, 400);
  if (!isWindows(platform)) return { ok: false, method: 'log', unsupported: true, error: '仅 Windows 支持桌面通知' };
  const forced = method || process.env.TENON_NOTIFY_METHOD || null;
  if (forced === 'log') return { ok: true, method: 'log', fallback: true, error: null };
  const plan = forced === 'burnttoast'
    ? [{ id: 'burnttoast', body: burntToastBody }, ...METHODS]
    : forced
      ? METHODS.filter((m) => m.id === forced).concat(METHODS.filter((m) => m.id !== forced))
      : METHODS;
  const errors = [];
  for (const candidate of plan) {
    const dir = makeTempDir('tenon-notify-');
    try {
      const resultFile = `${dir}\\result.json`;
      const script = wrapResultScript(candidate.body(safeTitle, safeBody), resultFile);
      const run = await runPowerShell(script, { timeoutMs, powershellPath });
      const parsed = readUtf8Json(resultFile);
      if (parsed && parsed.ok) return { ok: true, method: candidate.id, error: null };
      errors.push(`${candidate.id}: ${(parsed && parsed.error) || `exit=${run.code}`}`);
    } finally {
      removeTempDir(dir);
    }
  }
  // 最后兜底：控制台日志（也便于自测/无桌面会话环境取证）
  return { ok: true, method: 'log', fallback: true, error: errors.join(' | ') };
}

export function createNotifier({ hub, deviceId = 'node-local', log = console, env = process.env } = {}) {
  const status = {
    running: false,
    sent: 0,
    lastAt: null,
    last: null,
    reportPath: null,
    history: [],
  };
  let stopStream = null;

  async function notify({ title = '榫卯 Tenon', body = '', method } = {}) {
    const result = await sendWindowsNotification({ title, body, method });
    result.title = String(title || '');
    result.body = String(body || '');
    result.at = new Date().toISOString();
    status.sent += 1;
    status.lastAt = result.at;
    status.last = result;
    status.history.unshift(result);
    if (status.history.length > 20) status.history.length = 20;
    log(`[通知] ${result.ok ? '已发送' : '发送失败'}（method=${result.method}）：${result.title}${result.body ? ' · ' + result.body : ''}`);
    return result;
  }

  // 上报通知事件：POST /api/v2/link/notification {from,app,title,text}（Lead 已定路由，link-core 提供）
  async function report({ app = 'desktop', title = '', text = '', preview = '' } = {}) {
    if (!hub || typeof hub.postJson !== 'function') return { ok: false, error: '未配置中枢客户端' };
    try {
      await hub.postJson('/api/v2/link/notification', {
        from: deviceId,
        app: String(app).slice(0, 60),
        title: String(title).slice(0, 120),
        text: String(text || preview || '').slice(0, 300),
      });
      status.lastReportAt = new Date().toISOString();
      return { ok: true, path: '/api/v2/link/notification' };
    } catch (err) {
      status.lastReportError = { at: new Date().toISOString(), message: String(err && err.message ? err.message : err) };
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  // 处理一条账本事件：手机通知镜像 → 本机通知
  async function mirrorEvent(event) {
    if (!event || typeof event !== 'object') return null;
    const payload = event.data || {};
    if (event.type === 'notification.relayed') {
      return notify({
        title: payload.title || `手机通知${payload.app ? ' · ' + payload.app : ''}`,
        body: payload.preview || payload.text || '',
      });
    }
    if (event.type === 'clipboard.shared' && payload.from && payload.from !== deviceId) {
      return notify({ title: '剪贴板已同步', body: String(payload.preview || payload.text || '').slice(0, 120) });
    }
    return null;
  }

  function startMirror() {
    if (status.running) return stopStream;
    status.running = true;
    stopStream = subscribeEvents({
      hub,
      onEvent: async (event) => {
        try {
          await mirrorEvent(event);
        } catch (err) {
          log(`[通知] 事件处理失败：${err && err.message ? err.message : err}`);
        }
      },
      onError: (err) => log(`[通知] 事件订阅断开（会自动重连）：${err && err.message ? err.message : err}`),
    });
    log('[通知] 已订阅中枢事件（notification.relayed → 本机通知镜像）');
    return stopStream;
  }

  function stopMirror() {
    status.running = false;
    if (typeof stopStream === 'function') stopStream();
    stopStream = null;
  }

  return { status, notify, report, mirrorEvent, startMirror, stopMirror, statusOf: () => ({ ...status, history: status.history.slice() }) };
}

export default { sendWindowsNotification, createNotifier };