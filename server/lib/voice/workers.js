// 榫卯 V3 · 语音 worker 管理（ASR / 本地 LLM / TTS），异常自动重启，优雅停止
// 契约（Lead 交付）：
//   asr_worker.py --file <wav>            → JSON {text,confidence}
//   asr_worker.py --mic                   → JSONL {type:'partial'|'final',text,ts}
//   llm_worker.py（持久进程，stdin/stdout 每行 JSON {messages,max_tokens} → {text,provider,ms}）
//   speak.ps1 -Text "..." [-OutFile x.wav] → SAPI Huihui 朗读/写 WAV
// 本文件也提供 mock 模式（无 worker 时联调/UI 演示）与 TTS 内置 SAPI 兜底。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { nowIso } from '../link/util.js';

function wavDurationMs(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 0;
    let pos = 12;
    let channels = 1;
    let sampleRate = 16000;
    let bits = 16;
    let dataSize = 0;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('ascii', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(pos + 10) || 1;
        sampleRate = buf.readUInt32LE(pos + 12) || 16000;
        bits = buf.readUInt16LE(pos + 22) || 16;
      } else if (id === 'data') {
        dataSize = Math.min(size, buf.length - (pos + 8));
        break;
      }
      pos += 8 + size + (size % 2);
    }
    if (!dataSize) return 0;
    return Math.round((dataSize / (channels * sampleRate * (bits / 8))) * 1000);
  } catch { return 0; }
}

function playWav(file) {
  try {
    const safe = String(file).replace(/'/g, "''");
    const child = spawn('powershell', ['-NoProfile', '-Command', "$p=New-Object System.Media.SoundPlayer '" + safe + "'; $p.PlaySync()"], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch { return false; }
}

function abs(root, rel) { return path.isAbsolute(String(rel || '')) ? String(rel) : path.join(root, String(rel || '')); }
function fileExists(p) { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } }
function newId(prefix) { return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'); }

const ASR_NOT_READY = 'ASR 未就绪：缺少 scripts/voice/asr_worker.py（或 --file 模式）；可用文本命令兜底';
const LLM_NOT_READY = '本地模型未就绪：缺少 scripts/voice/llm_worker.py；已回退规则引擎';

export function mockPlanOf(text) {
  const t = String(text || '');
  if (/音量|声音|大声|小声|静音|mute/.test(t)) {
    const m = t.match(/(\d{1,3})/);
    const level = m ? Math.max(0, Math.min(100, Number(m[1]))) : null;
    return {
      say: level != null ? '好，把电脑音量调到 ' + level + '%' : '好，调整电脑音量',
      actions: [{ action: 'system.volume', params: level != null ? { action: 'up', level } : { action: 'up', steps: 3 } }],
    };
  }
  if (/打开.*(记事本|notepad)|记事本/.test(t)) return { say: '好，打开记事本', actions: [{ action: 'app.launch', params: { app: 'notepad' } }] };
  if (/打开.*(chrome|浏览器)|chrome/i.test(t)) return { say: '好，打开 Chrome', actions: [{ action: 'app.launch', params: { app: 'chrome' } }] };
  if (/微信/.test(t)) return { say: '好，打开微信', actions: [{ action: 'app.launch', params: { app: 'wechat' } }] };
  if (/回家/.test(t)) return { say: '好，执行回家模式', actions: [{ action: 'scene.run', params: { presetId: 'home' } }] };
  if (/工作/.test(t) && /模式/.test(t)) return { say: '好，执行工作模式', actions: [{ action: 'scene.run', params: { presetId: 'work' } }] };
  if (/晚安|睡前|睡觉/.test(t)) return { say: '好，执行睡前模式', actions: [{ action: 'scene.run', params: { presetId: 'sleep' } }] };
  if (/欢迎|甩到|流转|主页/.test(t)) return { say: '好，把内容甩到电脑大屏', actions: [{ action: 'handoff.show', params: { kind: 'text', text: t } }] };
  if (/打印/.test(t)) {
    return { say: '打印属于不可逆操作，需要你确认后再执行。', actions: [{ action: 'file.print', params: { file: '示例空间/样品图/样品01.png', copies: 1 } }], needConfirm: true };
  }
  if (/删除|发送|关机/.test(t)) {
    return { say: '这个操作不可逆，需要你确认后再执行。', actions: [], needConfirm: true };
  }
  if (/今天|做了什么|日报|日记/.test(t)) return { say: '今天的语音记录我会整理成日报和日记（Round 7 上线）；现在先记下来：' + t.slice(0, 40), actions: [] };
  if (/你好|在吗|榫卯/.test(t)) return { say: '我在。你可以说：打开记事本、把音量调到 40、回家模式。', actions: [] };
  return { say: '我听到了：' + t.slice(0, 60) + '。当前可执行：打开程序、调音量、回家/工作/睡前场景、甩屏。', actions: [] };
}

export function createWorkers({ root, dataDir, config, log = console, onAsrEvent = () => {} }) {
  const ttsDir = path.join(dataDir, 'voice', 'tts');
  const tmpDir = path.join(dataDir, 'voice', 'tmp');
  fs.mkdirSync(ttsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const state = {
    asr: { state: 'stopped', provider: config.asrProvider, pid: null, restarts: 0, lastError: null, lastLineAt: null, mockTimer: null },
    llm: { state: 'stopped', provider: config.llmProvider, pid: null, restarts: 0, lastError: null, queue: 0, lastResponseMs: null, pending: 0, model: null },
    tts: { state: 'idle', voice: config.tts.voice, lastFile: null, lastError: null, lastMs: null, files: 0 },
    stopping: false,
  };

  const asr = { child: null, rl: null, stopRequested: false, restartTimer: null };
  const llm = { child: null, rl: null, stopRequested: false, restartTimer: null, waiters: [] };

  // ---------------- ASR ----------------
  function setAsr(patch) { Object.assign(state.asr, patch); }

  function emitAsr(event) {
    try { onAsrEvent(event); } catch (err) { log('[voice] ASR 回调失败：' + err.message); }
  }

  function startMockSequence({ wakeText = config.mock.wakeText, commandText = config.mock.commandText, delayMs = 900 } = {}) {
    if (state.asr.mockTimer) { clearTimeout(state.asr.mockTimer); state.asr.mockTimer = null; }
    setAsr({ state: 'mock', provider: 'mock', lastError: null, lastLineAt: nowIso() });
    const wake = String(wakeText || '榫卯');
    const cmd = String(commandText || '把音量调到 40');
    const seq = [
      { type: 'partial', text: wake.slice(0, 1), wait: 250 },
      { type: 'final', text: wake, wait: delayMs },
      { type: 'partial', text: cmd.slice(0, 3), wait: 400 },
      { type: 'final', text: cmd, wait: 300 },
    ];
    const step = (i) => {
      if (i >= seq.length) { state.asr.mockTimer = null; return; }
      const item = seq[i];
      setTimeout(() => {
        setAsr({ lastLineAt: nowIso() });
        emitAsr({ type: item.type, text: item.text, source: 'mock', provider: 'mock', at: nowIso() });
        step(i + 1);
      }, item.wait);
    };
    step(0);
  }

  function startAsr() {
    if (asr.child) return true;
    asr.stopRequested = false;
    if (config.mock.enabled || config.asrProvider === 'mock') {
      startMockSequence();
      return true;
    }
    const script = abs(root, config.workers.asrScript);
    if (!fileExists(script)) {
      setAsr({ state: 'unavailable', lastError: ASR_NOT_READY });
      emitAsr({ type: 'error', text: ASR_NOT_READY, code: 'ASR_NOT_READY', at: nowIso() });
      return false;
    }
    // V6：唤醒/记录分离（dual_worker.py），不可用时回退旧 asr_worker.py --mic
    const wakeScript = abs(root, (config.workers && config.workers.wakeScript) || 'scripts/voice/dual_worker.py');
    const split = config.asrSplit !== false && fileExists(wakeScript);
    const realScript = split ? wakeScript : script;
    const asrCfg = config.asr || {};
    const args = ['--mic'];
    if (config.micDevice) args.push('--mic-device', String(config.micDevice));
    if (split) {
      const hot = ((asrCfg.hotwords && asrCfg.hotwords.length) ? asrCfg.hotwords : []).concat(config.wakeWords || []);
      if (hot.length) args.push('--hotwords', hot.join(' '));
      args.push('--wake-words', (config.wakeWords || []).join(','));
      args.push('--wake-provider', String(asrCfg.wakeProvider || 'paraformer'));
      args.push('--record-provider', String(asrCfg.recordProvider || 'paraformer'));
      args.push('--threshold', String(asrCfg.threshold || 350));
      args.push('--wake-silence-ms', String(asrCfg.wakeSilenceMs || 500));
      args.push('--wake-max-ms', String(asrCfg.wakeMaxMs || 2500));
      args.push('--record-silence-ms', String(asrCfg.recordSilenceMs || 1000));
      args.push('--record-max-ms', String(asrCfg.recordMaxMs || 15000));
      args.push('--session-timeout-ms', String(asrCfg.sessionTimeoutMs || config.silenceTimeoutMs || 6000));
      if (config.ambient && config.ambient.enabled !== false) args.push('--ambient');
    }
    try {
      setAsr({ state: 'starting', provider: split ? 'paraformer' : (config.asrProvider === 'auto' ? 'funasr' : config.asrProvider), split, lastError: null });
      const child = spawn(config.workers.python || 'python', [realScript, ...args], { cwd: root, stdio: [split ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      asr.child = child;
      setAsr({ pid: child.pid, state: 'running' });
      asr.rl = readline.createInterface({ input: child.stdout });
      asr.rl.on('line', (line) => {
        const text = String(line || '').trim();
        if (!text) return;
        let obj = null;
        try { obj = JSON.parse(text); } catch { return; }
        setAsr({ lastLineAt: nowIso() });
        if (obj && obj.type === 'ready') {
          setAsr({ state: 'running', provider: obj.wakeProvider || obj.provider || 'paraformer', recordProvider: obj.recordProvider || null, mic: obj.mic || config.micDevice || null, split: !!obj.recordProvider, lastError: null });
          emitAsr({ type: 'ready', provider: obj.provider || 'funasr', mic: obj.mic || null, at: nowIso() });
        } else if (obj && obj.type === 'wake') {
          emitAsr({ type: 'wake', text: String(obj.text || ''), word: String(obj.word || ''), via: String(obj.via || ''), rest: String(obj.rest || ''), pinyin: String(obj.pinyin || ''), provider: obj.provider || state.asr.provider, ms: obj.ms || null, at: nowIso() });
        } else if (obj && (obj.type === 'session_start' || obj.type === 'session_end')) {
          emitAsr({ type: obj.type, reason: obj.reason || null, at: nowIso() });
        } else if (obj && obj.type === 'ambient') {
          emitAsr({ type: 'ambient', text: String(obj.text || ''), pinyin: String(obj.pinyin || ''), provider: obj.provider || state.asr.provider, ms: obj.ms || null, at: nowIso() });
        } else if (obj && (obj.type === 'partial' || obj.type === 'final')) {
          emitAsr({ type: obj.type, text: String(obj.text || ''), pinyin: String(obj.pinyin || ''), source: 'mic', provider: obj.provider || state.asr.provider, ms: obj.ms || null, at: nowIso() });
        } else if (obj && obj.type === 'speech_start') {
          emitAsr({ type: 'speech_start', at: nowIso() });
        } else if (obj && obj.type === 'speech_end') {
          emitAsr({ type: 'speech_end', at: nowIso() });
        } else if (obj && (obj.type === 'heartbeat' || obj.type === 'level')) {
          emitAsr({ type: 'level', level: Number(obj.level) || 0, at: nowIso() });
        } else if (obj && obj.type === 'error') {
          setAsr({ lastError: String(obj.text || obj.error || 'ASR 错误') });
          emitAsr({ type: 'error', text: String(obj.text || obj.error || 'ASR 错误'), code: obj.code || 'ASR_ERROR', at: nowIso() });
        }
      });
      child.stderr.on('data', (buf) => { const s = String(buf || '').trim(); if (s) log('[voice-asr] ' + s.slice(0, 400)); });
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});
      child.on('error', () => {});
      if (child.stdin) child.stdin.on('error', () => {});
      child.on('exit', (code) => {
        asr.child = null;
        if (asr.stopRequested || state.stopping) { setAsr({ state: 'stopped', pid: null }); return; }
        setAsr({ state: 'error', pid: null, lastError: 'ASR worker 退出（code=' + code + '），自动重启中' });
        scheduleAsrRestart();
      });
      return true;
    } catch (err) {
      setAsr({ state: 'error', lastError: 'ASR 启动失败：' + err.message });
      scheduleAsrRestart();
      return false;
    }
  }

  function scheduleAsrRestart() {
    if (state.stopping || asr.restartTimer) return;
    const restarts = state.asr.restarts + 1;
    setAsr({ restarts });
    if (restarts > 5) { setAsr({ state: 'unavailable', lastError: 'ASR 连续失败 5 次，已停止自动重启' }); return; }
    const wait = Math.min(8000, 1000 * Math.pow(2, restarts - 1));
    asr.restartTimer = setTimeout(() => { asr.restartTimer = null; startAsr(); }, wait);
  }

  function stopAsr() {
    asr.stopRequested = true;
    if (state.asr.mockTimer) { clearTimeout(state.asr.mockTimer); state.asr.mockTimer = null; }
    if (asr.restartTimer) { clearTimeout(asr.restartTimer); asr.restartTimer = null; }
    if (asr.rl) { try { asr.rl.close(); } catch { /* ignore */ } asr.rl = null; }
    if (asr.child) { try { asr.child.kill(); } catch { /* ignore */ } asr.child = null; }
    setAsr({ state: 'stopped', pid: null });
    return true;
  }

  // ---- 快捷录音：直接让双流水线进入「记录会话」（跳过唤醒词，说一句直接交给 AI 执行） ----
  function sendAsrCommand(obj) {
    try {
      if (!asr.child || !asr.child.stdin || asr.child.stdin.destroyed || !asr.child.stdin.writable) return false;
      asr.child.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (err) {
      log('[voice] ASR 控制命令失败：' + String((err && err.message) || err));
      return false;
    }
  }
  function startQuickRecord() { return sendAsrCommand({ cmd: 'start_session' }); }
  function stopQuickRecord() { return sendAsrCommand({ cmd: 'stop_session' }); }

  async function transcribeFile(file, { timeoutMs = 45000 } = {}) {
    const wav = abs(root, file);
    if (!fileExists(wav)) throw new Error('WAV 文件不存在：' + wav);
    if (config.mock.enabled || config.asrProvider === 'mock') {
      const name = path.basename(wav).toLowerCase();
      const text = /volume|yinliang/.test(name) ? '把音量调到 40' : /chrome/.test(name) ? '打开 Chrome' : /home/.test(name) ? '回家模式' : /wake/.test(name) ? '榫卯' : '打开记事本';
      return { ok: true, text, confidence: 0.99, provider: 'mock', ms: 5, file: wav };
    }
    const script = abs(root, config.workers.asrScript);
    if (fileExists(script)) {
      const started = Date.now();
      const out = await runCapture(config.workers.python || 'python', [script, '--file', wav], { timeoutMs, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
      let parsed = null;
      for (const line of out.stdout.split('\n').reverse()) {
        const t = line.trim();
        if (!t) continue;
        try { parsed = JSON.parse(t); break; } catch { /* continue */ }
      }
      if (!parsed || typeof parsed.text !== 'string') throw new Error('ASR 未返回 JSON {text}：' + (out.stdout.slice(-200) || out.stderr.slice(-200)));
      return { ok: parsed.ok !== false, text: parsed.text, pinyin: String(parsed.pinyin || ''), confidence: parsed.confidence == null ? null : Number(parsed.confidence), provider: parsed.provider || 'funasr', ms: parsed.ms || (Date.now() - started), totalMs: parsed.totalMs || null, file: wav };
    }
    const fallback = abs(root, config.workers.transcribeScript);
    if (fileExists(fallback)) {
      const started = Date.now();
      const out = await runCapture('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fallback, '-Wav', wav], { timeoutMs, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      const text = out.stdout.trim().split('\n').filter(Boolean).pop() || '';
      if (!text) throw new Error('Windows SR 兜底识别为空：' + out.stderr.slice(-200));
      return { ok: true, text, confidence: null, provider: 'windows', ms: Date.now() - started, file: wav };
    }
    throw new Error(ASR_NOT_READY);
  }

  // ---------------- LLM ----------------
  function setLlm(patch) { Object.assign(state.llm, patch); }

  function startLlm() {
    llm.stopRequested = false;
    if (config.llmProvider === 'mock' || config.mock.enabled) { setLlm({ state: 'mock', provider: 'mock' }); return true; }
    const script = abs(root, config.workers.llmScript);
    if (!fileExists(script)) { setLlm({ state: 'unavailable', provider: 'rule', lastError: LLM_NOT_READY }); return false; }
    try {
      setLlm({ state: 'starting', lastError: null });
      const child = spawn(config.workers.python || 'python', [script], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
      llm.child = child;
      setLlm({ pid: child.pid, state: 'running', provider: 'local' });
      llm.rl = readline.createInterface({ input: child.stdout });
      llm.rl.on('line', (line) => {
        const text = String(line || '').trim();
        if (!text) return;
        let obj = null;
        try { obj = JSON.parse(text); } catch { return; }
        if (obj && obj.type === 'ready') {
          setLlm({ state: 'running', provider: 'local', model: obj.model || obj.provider || 'local-qwen', lastError: null });
          return;
        }
        let waiter = null;
        if (obj && obj.id) {
          const idx = llm.waiters.findIndex((w) => w.id === obj.id);
          if (idx >= 0) { waiter = llm.waiters.splice(idx, 1)[0]; }
        }
        if (!waiter) waiter = llm.waiters.shift();
        if (!waiter) return;
        clearTimeout(waiter.timer);
        setLlm({ lastResponseMs: obj.ms || null, pending: llm.waiters.length });
        if (obj && obj.ok === false) waiter.reject(new Error(String(obj.error || 'LLM 返回失败')));
        else waiter.resolve({ text: String((obj && obj.text) || ''), provider: (obj && obj.provider) || 'local', ms: Number((obj && obj.ms) || 0) });
      });
      child.stderr.on('data', (buf) => { const s = String(buf || '').trim(); if (s) log('[voice-llm] ' + s.slice(0, 400)); });
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});
      child.on('error', () => {});
      if (child.stdin) child.stdin.on('error', () => {});
      child.on('exit', (code) => {
        llm.child = null;
        while (llm.waiters.length) { const w = llm.waiters.shift(); clearTimeout(w.timer); w.reject(new Error('LLM worker 已退出（code=' + code + '）')); }
        if (llm.stopRequested || state.stopping) { setLlm({ state: 'stopped', pid: null }); return; }
        setLlm({ state: 'error', pid: null, lastError: 'LLM worker 退出（code=' + code + '），自动重启中' });
        scheduleLlmRestart();
      });
      return true;
    } catch (err) {
      setLlm({ state: 'error', lastError: 'LLM 启动失败：' + err.message });
      scheduleLlmRestart();
      return false;
    }
  }

  function scheduleLlmRestart() {
    if (state.stopping || llm.restartTimer) return;
    const restarts = state.llm.restarts + 1;
    setLlm({ restarts });
    if (restarts > 5) { setLlm({ state: 'unavailable', provider: 'rule', lastError: 'LLM 连续失败 5 次，已回退规则引擎' }); return; }
    const wait = Math.min(8000, 1000 * Math.pow(2, restarts - 1));
    llm.restartTimer = setTimeout(() => { llm.restartTimer = null; startLlm(); }, wait);
  }

  function stopLlm() {
    llm.stopRequested = true;
    if (llm.restartTimer) { clearTimeout(llm.restartTimer); llm.restartTimer = null; }
    if (llm.rl) { try { llm.rl.close(); } catch { /* ignore */ } llm.rl = null; }
    while (llm.waiters.length) { const w = llm.waiters.shift(); clearTimeout(w.timer); w.reject(new Error('LLM 已停止')); }
    if (llm.child) { try { llm.child.kill(); } catch { /* ignore */ } llm.child = null; }
    setLlm({ state: 'stopped', pid: null });
    return true;
  }

  async function chat(messages, { maxTokens = 512, timeoutMs = 60000 } = {}) {
    if (config.llmProvider === 'mock' || config.mock.enabled || state.llm.state === 'mock') {
      const started = Date.now();
      const last = messages[messages.length - 1] || {};
      const plan = mockPlanOf(last.content || '');
      return { text: JSON.stringify(plan), provider: 'mock', ms: Date.now() - started };
    }
    if (!llm.child || state.llm.state !== 'running') throw new Error(LLM_NOT_READY);
    return new Promise((resolve, reject) => {
      const waiter = { id: 'llm_' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6), resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = llm.waiters.indexOf(waiter);
        if (idx >= 0) llm.waiters.splice(idx, 1);
        setLlm({ pending: llm.waiters.length });
        reject(new Error('本地模型响应超时（' + Math.round(timeoutMs / 1000) + 's）'));
      }, Math.max(3000, Number(timeoutMs) || 60000));
      llm.waiters.push(waiter);
      setLlm({ pending: llm.waiters.length });
      try {
        llm.child.stdin.write(JSON.stringify({ id: waiter.id, messages, max_tokens: maxTokens }) + '\n');
      } catch (err) {
        clearTimeout(waiter.timer);
        reject(new Error('写入本地模型失败：' + err.message));
      }
    });
  }

  // ---------------- TTS ----------------
  function inlineSpeakScript() {
    return [
      'Add-Type -AssemblyName System.Speech',
      '$text = [System.IO.File]::ReadAllText($env:TENON_TTS_TEXT_FILE, [System.Text.Encoding]::UTF8)',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      'try { if ($env:TENON_TTS_VOICE) { $s.SelectVoice($env:TENON_TTS_VOICE) } } catch { }',
      'try { $s.Rate = [int]$env:TENON_TTS_RATE } catch { }',
      'if ($env:TENON_TTS_OUT) {',
      '  $s.SetOutputToWaveFile($env:TENON_TTS_OUT)',
      '  $s.Speak($text)',
      '} else {',
      '  $s.SetOutputToDefaultAudioDevice()',
      '  $s.Speak($text)',
      '}',
      '$s.Dispose()',
      'Write-Output "TTS_OK"',
    ].join('\r\n');
  }

  async function speak(text, { outFile = null, play = config.tts.play, timeoutMs = 60000 } = {}) {
    if (!config.tts.enabled) return { ok: false, skipped: true, error: 'TTS 已在配置中关闭' };
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, error: '没有要朗读的文本' };
    const started = Date.now();
    // 无论是否播放，都生成 WAV 文件：手机 App 需要 /reply-audio 播放，账本/验收也需要文件证据
    const wavFile = outFile || path.join(ttsDir, 'reply-' + newId('tts') + '.wav');
    try {
      const script = abs(root, config.workers.speakScript);
      let provider = 'speak.ps1';
      if (fileExists(script)) {
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Text', clean, '-OutFile', wavFile];
        await runCapture('powershell', args, { timeoutMs });
      } else {
        provider = 'sapi-inline';
        const stamp = newId('tts');
        const textFile = path.join(tmpDir, stamp + '.txt');
        const psFile = path.join(tmpDir, stamp + '.ps1');
        fs.writeFileSync(textFile, clean, 'utf8');
        fs.writeFileSync(psFile, inlineSpeakScript(), 'utf8');
        const env = {
          ...process.env,
          TENON_TTS_TEXT_FILE: textFile,
          TENON_TTS_OUT: wavFile,
          TENON_TTS_VOICE: config.tts.voice || '',
          TENON_TTS_RATE: String(Number(config.tts.rate) || 0),
        };
        await runCapture('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { timeoutMs, env });
        try { fs.unlinkSync(textFile); } catch { /* ignore */ }
        try { fs.unlinkSync(psFile); } catch { /* ignore */ }
      }
      const bytes = fileExists(wavFile) ? fs.statSync(wavFile).size : 0;
      if (!bytes) throw new Error('TTS 未生成 WAV（speak.ps1 或 SAPI 失败）');
      const durationMs = wavDurationMs(wavFile);
      let played = false;
      if (play) { try { played = playWav(wavFile); } catch { played = false; } }
      setTts({ ok: true, file: wavFile, bytes, ms: Date.now() - started });
      return { ok: true, file: wavFile, bytes, durationMs, ms: Date.now() - started, voice: config.tts.voice, rate: config.tts.rate || 0, sampleRate: 16000, provider, played };
    } catch (err) {
      setTts({ ok: false, error: err.message, ms: Date.now() - started });
      return { ok: false, error: 'TTS 失败：' + err.message };
    }
  }
  function setTts(patch) {
    if (patch.ok === true) { state.tts.files += 1; state.tts.lastFile = patch.file || state.tts.lastFile; state.tts.lastMs = patch.ms; state.tts.lastError = null; }
    if (patch.ok === false) state.tts.lastError = patch.error;
    state.tts.voice = config.tts.voice;
    state.tts.state = patch.ok === false ? 'error' : 'idle';
  }

  // ---------------- utils / status ----------------
  function runCapture(cmd, args, { timeoutMs = 30000, env = null } = {}) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let child = null;
      try {
        child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: env || process.env, windowsHide: true }, (err, out, errOut) => {
          stdout = String(out || '');
          stderr = String(errOut || '');
          if (err && !stdout) reject(new Error(String(err.message || err) + (stderr ? ' · ' + stderr.slice(-300) : '')));
          else resolve({ stdout, stderr, code: err ? (err.code || 1) : 0 });
        });
      } catch (err) {
        reject(err);
      }
      if (child) child.on('error', (e) => reject(e));
    });
  }

  function getStatus() {
    return {
      asr: { ...state.asr, scriptReady: fileExists(abs(root, config.workers.asrScript)), mock: config.mock.enabled || config.asrProvider === 'mock' },
      llm: { ...state.llm, scriptReady: fileExists(abs(root, config.workers.llmScript)) },
      tts: { ...state.tts },
      scripts: {
        asr: fileExists(abs(root, config.workers.asrScript)),
        llm: fileExists(abs(root, config.workers.llmScript)),
        speak: fileExists(abs(root, config.workers.speakScript)),
        transcribe: fileExists(abs(root, config.workers.transcribeScript)),
      },
      providerPlan: {
        asr: config.mock.enabled || config.asrProvider === 'mock' ? 'mock' : (fileExists(abs(root, config.workers.asrScript)) ? (config.asrProvider === 'auto' ? 'funasr' : config.asrProvider) : 'unavailable'),
        llm: config.mock.enabled || config.llmProvider === 'mock' ? 'mock' : (fileExists(abs(root, config.workers.llmScript)) ? 'local' : 'rule'),
        tts: config.tts.enabled ? (fileExists(abs(root, config.workers.speakScript)) ? 'speak.ps1' : 'sapi-inline') : 'off',
      },
    };
  }

  function stopAll() {
    state.stopping = true;
    stopAsr();
    stopLlm();
    state.stopping = false;
  }

  return {
    state,
    startAsr,
    stopAsr,
    startQuickRecord,
    stopQuickRecord,
    transcribeFile,
    startLlm,
    stopLlm,
    chat,
    speak,
    getStatus,
    stopAll,
    startMockSequence,
    fileExists: (p) => fileExists(abs(root, p)),
  };
}

export { ASR_NOT_READY, LLM_NOT_READY };
export default { createWorkers, mockPlanOf, ASR_NOT_READY, LLM_NOT_READY };