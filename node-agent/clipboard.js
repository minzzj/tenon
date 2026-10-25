// 榫卯 v2 · Windows 剪贴板双向同步
// 读/写都走 PowerShell 5.1（-STA + System.Windows.Forms.Clipboard），1 秒轮询：
//   本机变化 → POST /api/v2/link/clipboard（kind=text|link）
//   中枢最新一条（GET /api/v2/link/clipboard/latest）且来自别的设备 → 写回本机剪贴板
// 防回环：自己上报的内容、刚写回的内容都不会再次上报；远端写回不触发本机上报。
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isWindows, psQuote, runPowerShell, makeTempDir, removeTempDir, readUtf8Json, wrapResultScript } from './lib/ps.js';

const READ_BODY = `Add-Type -AssemblyName System.Windows.Forms
$result = @{ ok = $false; text = $null; error = $null }
for ($i = 0; $i -lt 3; $i++) {
  try {
    $result.text = $null
    if ([System.Windows.Forms.Clipboard]::ContainsText()) { $result.text = [System.Windows.Forms.Clipboard]::GetText() }
    $result.ok = $true
    break
  } catch {
    $result.error = $_.Exception.Message
    Start-Sleep -Milliseconds 80
  }
}`;

const WRITE_BODY = `Add-Type -AssemblyName System.Windows.Forms
$payload = [System.IO.File]::ReadAllText($__payloadFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$result = @{ ok = $false; error = $null }
for ($i = 0; $i -lt 3; $i++) {
  try {
    $text = [string]$payload.text
    if ([string]::IsNullOrEmpty($text)) { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText($text) }
    $result.ok = $true
    $result.error = $null
    break
  } catch {
    $result.error = $_.Exception.Message
    Start-Sleep -Milliseconds 80
  }
}`;

export function hashText(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

// 链接/普通文本分类（契约 clipboard.shared.kind: text|link|files）
export function classifyKind(text) {
  const value = String(text || '').trim();
  if (/^https?:\/\/\S+$/i.test(value)) return 'link';
  return 'text';
}

export async function readClipboardText({ platform = process.platform, powershellPath, timeoutMs = 8000 } = {}) {
  if (!isWindows(platform)) return { ok: false, unsupported: true, text: null, error: '仅 Windows 支持剪贴板同步' };
  const dir = makeTempDir('tenon-clip-r-');
  try {
    const resultFile = `${dir}\\result.json`;
    const script = wrapResultScript(READ_BODY, resultFile);
    const run = await runPowerShell(script, { timeoutMs, powershellPath });
    const parsed = readUtf8Json(resultFile);
    if (!parsed) return { ok: false, text: null, error: `PowerShell 未返回结果（exit=${run.code}）${run.stderr.slice(0, 120)}` };
    return { ok: !!parsed.ok, text: typeof parsed.text === 'string' ? parsed.text : null, error: parsed.error || null };
  } finally {
    removeTempDir(dir);
  }
}

export async function writeClipboardText(text, { platform = process.platform, powershellPath, timeoutMs = 8000 } = {}) {
  if (!isWindows(platform)) return { ok: false, unsupported: true, error: '仅 Windows 支持剪贴板同步' };
  const dir = makeTempDir('tenon-clip-w-');
  try {
    const payloadFile = `${dir}\\payload.json`;
    const resultFile = `${dir}\\result.json`;
    const value = String(text === undefined || text === null ? '' : text);
    fs.writeFileSync(payloadFile, JSON.stringify({ text: value }), 'utf8');
    const script = [
      `$__payloadFile = ${psQuote(payloadFile)}`,
      wrapResultScript(WRITE_BODY, resultFile),
    ].join('\n');
    const run = await runPowerShell(script, { timeoutMs, powershellPath });
    const parsed = readUtf8Json(resultFile);
    if (!parsed) return { ok: false, error: `PowerShell 未返回结果（exit=${run.code}）${run.stderr.slice(0, 120)}` };
    return { ok: !!parsed.ok, error: parsed.error || null };
  } finally {
    removeTempDir(dir);
  }
}

function parseLatest(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [payload.item, payload.clipboard, payload.latest, payload.data, payload];
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const text = typeof item.text === 'string' ? item.text : typeof item.content === 'string' ? item.content : null;
    if (text === null) continue;
    return {
      id: item.id || item.clipboardId || null,
      kind: item.kind || 'text',
      text,
      from: item.from || item.deviceId || item.nodeId || null,
      at: item.at || item.createdAt || null,
    };
  }
  return null;
}

// 轮询同步器
export function createClipboardSync({
  hub,
  deviceId = 'node-local',
  pollMs = 1000,
  platform = process.platform,
  log = console,
  readClipboard = readClipboardText,
  writeClipboard = writeClipboardText,
  maxChars = 200000,
  onRemoteText = null,
} = {}) {
  const state = {
    available: isWindows(platform),
    running: false,
    pollMs,
    lastText: null,
    lastError: null,
    lastReportAt: null,
    lastApplyAt: null,
    reported: 0,
    applied: 0,
    hubReady: true,
    ticks: 0,
  };
  let timer = null;
  let busy = false;
  let lastSeenLocalText = null;
  let lastReportedHash = null;
  let lastAppliedText = null;
  let lastRemoteKey = null;
  let reportDown = false;
  let latestDown = false;

  function noteError(where, err) {
    state.lastError = { at: new Date().toISOString(), where, message: String(err && err.message ? err.message : err) };
  }

  async function reportLocalText(text) {
    if (!hub || typeof hub.postJson !== 'function') return false;
    if (String(text).length > maxChars) {
      state.lastError = { at: new Date().toISOString(), where: 'report', message: `剪贴板内容超过 ${maxChars} 字，已跳过上报（防止刷爆账本）` };
      return false;
    }
    try {
      await hub.postJson('/api/v2/link/clipboard', { kind: classifyKind(text), text, from: deviceId });
      state.reported += 1;
      state.lastReportAt = new Date().toISOString();
      state.hubReady = true;
      if (reportDown) {
        log('[剪贴板] 上报恢复');
        reportDown = false;
      }
      return true;
    } catch (err) {
      noteError('report', err);
      if (!reportDown) {
        reportDown = true;
        log(`[剪贴板] 上报失败：${err.message}（继续重试，中枢 v2 连接层就绪后恢复）`);
      }
      return false;
    }
  }

  async function fetchLatest() {
    if (!hub || typeof hub.getJson !== 'function') return null;
    try {
      const payload = await hub.getJson('/api/v2/link/clipboard/latest');
      state.hubReady = true;
      if (latestDown) {
        log('[剪贴板] 接收恢复');
        latestDown = false;
      }
      return parseLatest(payload);
    } catch (err) {
      noteError('latest', err);
      if (!latestDown) {
        latestDown = true;
        log(`[剪贴板] 读取中枢最新剪贴板失败：${err.message}（继续重试）`);
      }
      return null;
    }
  }

  async function syncOnce() {
    state.ticks += 1;
    state.lastError = state.lastError || null;
    const local = await readClipboard({ platform });
    if (!local || !local.ok) {
      if (local && local.unsupported) {
        state.available = false;
        return { ok: false, unsupported: true };
      }
      noteError('read', (local && local.error) || '读取剪贴板失败');
      return { ok: false, error: state.lastError.message };
    }
    const text = local.text || '';
    if (text && text !== lastSeenLocalText) {
      lastSeenLocalText = text;
      const digest = hashText(text);
      if (digest !== lastReportedHash && text !== lastAppliedText) {
        const ok = await reportLocalText(text);
        if (ok) lastReportedHash = digest;
      }
    }
    const latest = await fetchLatest();
    if (latest && latest.text) {
      const key = latest.id || `${latest.from || 'unknown'}|${hashText(latest.text)}|${latest.at || ''}`;
      if (key !== lastRemoteKey && latest.from !== deviceId) {
        lastRemoteKey = key;
        if (latest.text === text) {
          lastAppliedText = latest.text;
          return { ok: true, applied: false, reason: 'already-in-sync' };
        }
        const wrote = await writeClipboard(latest.text, { platform });
        if (wrote && wrote.ok) {
          state.applied += 1;
          state.lastApplyAt = new Date().toISOString();
          lastAppliedText = latest.text;
          lastSeenLocalText = latest.text;
          lastReportedHash = hashText(latest.text);
          log(`[剪贴板] 已接收来自 ${latest.from || '其他设备'} 的${latest.kind === 'link' ? '链接' : '文本'}（${latest.text.length} 字）`);
          if (typeof onRemoteText === 'function') {
            try {
              await onRemoteText(latest);
            } catch {
              /* 通知失败不影响同步 */
            }
          }
          return { ok: true, applied: true, from: latest.from };
        }
        noteError('write', (wrote && wrote.error) || '写入剪贴板失败');
      }
    }
    return { ok: true, applied: false };
  }

  function start() {
    if (!state.available) {
      log('[剪贴板] 非 Windows 平台，剪贴板同步未启用');
      return false;
    }
    if (state.running) return true;
    state.running = true;
    log(`[剪贴板] 已启动：每 ${pollMs / 1000} 秒轮询（读+写双向，防回环）`);
    const tick = async () => {
      if (!state.running) return;
      if (!busy) {
        busy = true;
        try {
          await syncOnce();
        } catch (err) {
          noteError('tick', err);
        } finally {
          busy = false;
        }
      }
      if (state.running) timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, 400);
    return true;
  }

  function stop() {
    state.running = false;
    if (timer) clearTimeout(timer);
    timer = null;
    return true;
  }

  return { state, syncOnce, start, stop, reportLocalText, fetchLatest, status: () => ({ ...state }) };
}

export default { readClipboardText, writeClipboardText, classifyKind, hashText, createClipboardSync };