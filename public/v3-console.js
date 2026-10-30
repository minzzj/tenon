/* 榫卯 V3 · 桌面语音控制台（#/voice 页面内容 + SSE + 文本命令 + 配置）
 * 独立模块：window.TenonVoiceConsole.render() 返回 HTML；load/connect/patch 自己管理 DOM。
 * 与 app.js 解耦（app.js 只做薄封装），桌面与移动共享 /api/v2/voice/* 契约。 */
(function () {
  'use strict';
  var TOKEN_KEY = 'tenon:token';
  var V = { status: null, transcripts: [], events: [], es: null, loadedAt: 0, loading: false, error: '', busy: false, startedAt: 0, diary: null, diaryLoading: false };

  function $(sel) { return document.querySelector(sel); }
  function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (_) {} }
  function time(at) {
    try { var d = new Date(at || Date.now()); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); } catch (_) { return ''; }
  }
  function toast(msg, kind) {
    if (typeof window.tenonToast === 'function') { window.tenonToast(msg, kind || 'ok'); return; }
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:9999;padding:10px 16px;border-radius:10px;background:#0d1a28;color:#e9f1fa;border:1px solid #66e3d2;font-size:13px';
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3000);
  }
  function request(method, path, body) {
    var headers = { Accept: 'application/json' };
    var tok = getToken();
    if (tok) headers['x-tenon-token'] = tok;
    var opts = { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) { return { status: r.status, ok: r.ok, data: d }; });
    });
  }
  function stateLabel(st) {
    var map = { idle: '待机（未开启）', starting: '启动中…（首次加载模型约 10–30 秒）', listening: '正在聆听', wake: '已唤醒', session: '会话中', thinking: '理解中…', executing: '执行中…', reply: '已回复', error: '异常（文本仍可用）', unknown: '未知（服务未就绪）' };
    return map[st] || st || '未知';
  }
  function chip(text, kind) {
    return '<span class="tag ' + (kind === 'ok' ? 'cyan' : kind === 'bad' ? 'red' : '') + '">' + esc(text) + '</span>';
  }
  function captionHtml() {
    var evs = V.events.slice(-40);
    if (!evs.length) return '<div class="v3-caption" data-testid="voice-caption" data-kind="final"><span class="v3-ts">—</span>已连接语音服务：说「榫卯」唤醒，或使用下方文本入口。</div>';
    return evs.map(function (ev) {
      var kind = 'final'; var text = '';
      if (ev.type === 'partial') { kind = 'partial'; text = (ev.text || '') + '…'; }
      else if (ev.type === 'transcript' || ev.type === 'final') { kind = ev.wake ? 'wake' : 'final'; text = (ev.wake ? '🔔 ' : '') + (ev.text || ''); }
      else if (ev.type === 'wake') { kind = 'wake'; text = '🔔 已唤醒「' + (ev.word || '') + '」' + (ev.via === 'pinyin' ? '（拼音命中）' : ''); }
      else if (ev.type === 'thinking') { text = '🤔 正在理解：' + (ev.text || ''); }
      else if (ev.type === 'executing') { text = '⚙️ 正在执行：' + ((ev.actions || []).join('、') || ''); }
      else if (ev.type === 'reply') { text = '💬 ' + (ev.text || ''); }
      else if (ev.type === 'error') { kind = 'error'; text = '⚠️ ' + (ev.text || ''); }
      else if (ev.type === 'tts') { text = '🔊 语音回复已生成 ' + Math.round((ev.bytes || 0) / 1024) + 'KB'; }
      else if (ev.type === 'session_end') { text = '（会话结束：' + (ev.reason || '超时') + '）'; }
      else if (ev.type === 'level' || ev.type === 'status' || ev.type === 'status_snapshot' || ev.type === 'ready' || ev.type === 'speech_start' || ev.type === 'speech_end') return '';
      else return '';
      return '<div class="v3-caption" data-testid="voice-caption" data-kind="' + kind + '"><span class="v3-ts">' + esc(time(ev.at)) + '</span>' + esc(text) + '</div>';
    }).join('') || '<div class="v3-caption" data-kind="final"><span class="v3-ts">—</span>等待语音事件…</div>';
  }
  function replyHtml() {
    var ev = null;
    for (var i = V.events.length - 1; i >= 0; i -= 1) if (V.events[i].type === 'reply') { ev = V.events[i]; break; }
    var reply = ev || (V.status && V.status.lastReply) || null;
    if (!reply) return '<div class="tiny dim" data-testid="voice-reply-empty">还没有回复：说「榫卯，打开记事本」或在下方输入命令。</div>';
    var meta = [];
    if (reply.provider) meta.push('提供方 ' + reply.provider);
    if (reply.latencyMs != null) meta.push(Math.round(reply.latencyMs) + 'ms');
    if (reply.tts && reply.tts.ok) meta.push('TTS ' + Math.round((reply.tts.bytes || 0) / 1024) + 'KB');
    else if (reply.tts && reply.tts.error) meta.push('TTS 失败');
    var steps = (reply.steps || []).slice(0, 6).map(function (s) {
      return '<div class="v3-step" data-ok="' + (s.status === 'succeeded' || s.status === 'dispatched' ? '1' : '0') + '">' + (s.status === 'succeeded' || s.status === 'dispatched' ? '✓' : '✗') + ' ' + esc(s.label || '') + (s.summary ? ' · ' + esc(String(s.summary).slice(0, 80)) : '') + '</div>';
    }).join('');
    return '<div class="v3-reply-label">AI 回复</div><div class="v3-reply-text" data-testid="voice-reply-text">' + esc(reply.text || '') + '</div>' +
      (steps ? '<div class="v3-steps" data-testid="voice-reply-steps">' + steps + '</div>' : '') +
      (meta.length ? '<div class="v3-reply-meta" data-testid="voice-reply-meta">' + meta.map(function (m) { return '<span class="v3-chip">' + esc(m) + '</span>'; }).join('') + '</div>' : '') +
(reply.tts && reply.tts.audio && reply.tts.audio.id ? '<audio data-testid="voice-reply-audio" controls data-audio-id="' + esc(reply.tts.audio.id) + '" style="width:100%;margin-top:8px"></audio>' : '');
  }
  function loadReplyAudio() {
    var audio = document.querySelector('[data-testid="voice-reply-audio"]');
    if (!audio || audio.src) return;
    var id = audio.getAttribute('data-audio-id');
    if (!id) return;
    try {
      fetch('/api/v2/voice/reply-audio?id=' + encodeURIComponent(id), { headers: { 'x-tenon-token': getToken() }, credentials: 'same-origin' })
        .then(function (res) { if (!res.ok) throw new Error('audio HTTP ' + res.status); return res.blob(); })
        .then(function (blob) { audio.src = URL.createObjectURL(blob); })
        .catch(function () {});
    } catch (_) {}
  }
  function eventsText() {
    var evs = (V.events.length ? V.events : ((V.status && V.status.recentEvents) || [])).slice(-25);
    return evs.map(function (ev) { return time(ev.at) + ' ' + (ev.type || '') + (ev.text ? ' · ' + String(ev.text).slice(0, 60) : '') + (ev.state ? ' · ' + ev.state : '') + (ev.word ? ' · ' + ev.word : ''); }).join('\n') || '（暂无事件）';
  }
  function transcriptsHtml() {
    var items = V.transcripts.slice(-16).reverse();
    if (!items.length) return '<div class="tiny dim">今天还没有转写：开启语音后所有识别文字会记录在本机 data/voice/transcripts/。</div>';
    return items.map(function (it) {
      return '<div class="v3-transcript" data-testid="voice-transcript" data-sensitive="' + (it.redacted ? '1' : '0') + '"><span class="v3-ts">' + esc(time(it.at)) + '</span>' + (it.wake ? '🔔 ' : '') + esc(it.text || (it.redacted ? '（敏感内容已过滤）' : '')) + ' <span class="tiny dim">' + esc(it.source || '') + '</span></div>';
    }).join('');
  }

  function aiProviderLabel(status) {
    if (!status) return '未就绪';
    if (status.ai && status.ai.available) return 'DeepSeek 云端理解';
    var p = (status.providers && status.providers.llm) || 'local';
    return p === 'local' ? '本地 Qwen 理解' : p === 'rule' ? '规则引擎（离线降级）' : ('模型 ' + p);
  }
  function diaryHtml() {
    var d = V.diary;
    var autoTime = ((V.status && V.status.diary && V.status.diary.time) || '23:00');
    if (!d) return '<div class="tiny dim" data-testid="voice-diary-empty">尚未生成今日日报/日记：点「生成今日总结」，或每晚 ' + esc(autoTime) + ' 自动生成（数据只在本机，云端只收聚合摘要）。</div>';
    if (!d.exists) return '<div class="tiny dim" data-testid="voice-diary-empty">今日总结还没生成（自动时间 ' + esc(autoTime) + '）。<button class="btn btn-sm" id="voice-diary-generate" data-testid="voice-diary-generate">生成今日总结</button></div>';
    var md = String(d.markdown || '');
    var pm = md.match(/<!-- provider=(\w+)/);
    return '<div class="tiny dim" data-testid="voice-diary-provider">' + esc(d.date) + ' · 生成模型：' + esc(pm ? pm[1] : 'unknown') + ' · <button class="btn btn-sm" id="voice-diary-generate" data-testid="voice-diary-generate">重新生成</button></div>' +
      '<pre class="v3-events" data-testid="voice-diary-content" style="max-height:300px;white-space:pre-wrap">' + esc(md.slice(0, 4000)) + '</pre>';
  }
  function loadDiary() {
    return request('GET', '/api/v2/voice/diary').then(function (r) {
      if (r.ok && r.data) {
        V.diary = r.data;
        var box = document.getElementById('voice-diary');
        if (box) {
          box.innerHTML = diaryHtml();
          var btn = document.getElementById('voice-diary-generate');
          if (btn) btn.addEventListener('click', generateDiary);
        }
      }
    }, function () {});
  }
  function generateDiary() {
    if (V.diaryLoading) return;
    V.diaryLoading = true;
    var btn = document.getElementById('voice-diary-generate');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    request('POST', '/api/v2/voice/diary/generate', {}).then(function (r) {
      V.diaryLoading = false;
      if (btn) { btn.disabled = false; btn.textContent = '生成今日总结'; }
      if (r.status === 401) { showToken(); return; }
      if (!r.ok) { toast('日报生成失败：' + ((r.data && r.data.error) || r.status), 'bad'); return; }
      toast('今日总结已生成（provider=' + (r.data.provider || '') + '）', 'ok');
      loadDiary();
    }, function () { V.diaryLoading = false; if (btn) { btn.disabled = false; btn.textContent = '生成今日总结'; } toast('无法连接中枢', 'bad'); });
  }

  function render() {
    var status = V.status;
    var providers = (status && status.providers) || {};
    var workers = (status && status.workers) || {};
    var state = (status && status.state) || 'unknown';
    var enabled = !!(status && status.enabled);
    var html = '<nav class="v3-page" style="border-radius:22px;padding:18px;border:1px solid #16233a;margin-bottom:16px" data-testid="voice-console">' +
      '<div class="v3-head" style="padding-top:0"><div><h1 style="margin:0;font-size:18px">语音管家</h1><div class="v3-sub">说「榫卯」唤醒 → 本地小模型规划 → 真实执行 → 语音回复；所有转写只留在本机 data/voice/</div></div>' +
      '<div class="v3-status" data-testid="voice-status">' + chip(stateLabel(state), state === 'error' ? 'bad' : enabled ? 'ok' : '') + chip('ASR ' + (providers.asr || '—'), providers.asr === 'unavailable' ? 'bad' : 'ok') + chip('模型 ' + (providers.llm || '—'), providers.llm === 'rule' ? '' : 'ok') + chip('TTS ' + (providers.tts || '—'), providers.tts === 'off' ? '' : 'ok') + '</div></div>' +
      (V.error ? (window.TenonErrors ? window.TenonErrors.render('UNKNOWN', { detail: V.error }) : '<div class="alert alert-bad" data-testid="voice-error">' + esc(V.error) + '</div>') : '') +
      '<div class="v3-orb-wrap" style="padding:8px 0 0"><button class="v3-orb" id="voice-orb" data-testid="voice-orb" data-active="' + (enabled && ['listening', 'session', 'wake', 'thinking', 'executing'].indexOf(state) >= 0 ? '1' : '0') + '" data-state="' + esc(state) + '" title="开启/关闭语音"><span class="v3-orb-icon">' + (state === 'thinking' || state === 'executing' ? '🧠' : state === 'error' ? '⚠️' : '🎙️') + '</span><span class="v3-orb-label">' + (enabled ? '语音已开启' : '点我开启') + '</span></button>' +
      '<div class="v3-state" id="voice-state-text" data-testid="voice-state">' + esc(stateLabel(state) + (status && status.lastError ? ' · ' + status.lastError : '')) + '</div>' +
      '<div class="v3-tools"><button class="btn btn-primary btn-sm" id="voice-toggle" data-testid="voice-toggle">' + (enabled ? '关闭语音' : '开启语音') + '</button>' +
      '<button class="btn btn-sm" id="voice-refresh" data-testid="voice-refresh">刷新状态</button>' +
      '<a class="btn btn-sm" href="/m-live.html" target="_blank" rel="noopener" data-testid="voice-open-hud">手机实时字幕 →</a></div>' +
      '<div class="tiny dim" style="margin-top:6px" data-testid="voice-wake">' + (status && status.lastWake ? '最近唤醒：' + esc(status.lastWake.word || '') + ' · ' + esc(time(status.lastWake.at)) + (status.lastWake.via === 'pinyin' ? '（拼音命中）' : '') : '还没有唤醒记录（唤醒词：' + esc((status && status.wakeAliases ? status.wakeAliases.join(' / ') : '榫卯 / 小榫')) + '，支持拼音同音）') + '</div></div>' +
      '<div class="v3-hud" data-testid="voice-hud"><div class="v3-hud-head"><span class="dot"></span>实时字幕（SSE）<span class="tiny dim">部分转写 / 唤醒 / 回复</span></div><div class="v3-caption-stream" id="voice-caption-stream" data-testid="voice-caption-stream">' + captionHtml() + '</div>' +
      '<div class="v3-reply-card" id="voice-reply" data-testid="voice-reply">' + replyHtml() + '</div></div>' +
      '<div class="v3-input-row"><input id="voice-command-input" data-testid="voice-command-input" placeholder="文本入口（无麦克风也能用）：打开记事本 / 把音量调到 40 / 回家模式" autocomplete="off"><button class="btn btn-primary btn-sm" id="voice-command-send" data-testid="voice-command-send">发送</button></div>' +
      '<div class="tiny dim" style="margin-top:6px">无 worker 时这是兜底入口：走规则引擎真实执行，不会假装成功。</div></nav>' +

      '<div class="v3-grid">' +
      '<div class="v3-card"><h3>语音配置 <span class="tiny dim">/api/v2/voice/config</span></h3>' +
      '<div class="v3-field"><label>唤醒词（逗号分隔）</label><input id="voice-config-wakewords" data-testid="voice-config-wakewords" value="' + esc((status && status.wakeWords ? status.wakeWords.join('，') : '榫卯，小榫')) + '"></div>' +
      '<div class="v3-field"><label>ASR</label><select id="voice-config-asr" data-testid="voice-config-asr">' + ['auto', 'funasr', 'windows', 'mock', 'off'].map(function (v) { return '<option value="' + v + '"' + (status && status.asrProvider === v ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></div>' +
      '<div class="v3-field"><label>本地模型</label><select id="voice-config-llm" data-testid="voice-config-llm">' + ['auto', 'local', 'rule', 'mock'].map(function (v) { return '<option value="' + v + '"' + (status && status.llmProvider === v ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></div>' +
      '<div class="v3-field"><label>语音回复 TTS</label><label class="tiny"><input type="checkbox" id="voice-config-tts" data-testid="voice-config-tts" ' + (status && status.tts && status.tts.enabled ? 'checked' : '') + '> 开启朗读（SAPI ' + esc((status && status.tts && status.tts.voice) || 'Huihui') + '）</label></div>' +
      '<div class="v3-field"><label>静音超时（毫秒，会话结束）</label><input type="number" id="voice-config-silence" data-testid="voice-config-silence" value="' + esc((status && status.silenceTimeoutMs) || 3000) + '"></div>' +
      '<button class="btn btn-primary btn-sm" id="voice-save-config" data-testid="voice-save-config">保存配置</button>' +
      '<div class="v3-hint" style="margin-top:8px">ASR 首次加载模型约 10–30 秒：状态显示「启动中」；模型不可用时回退规则引擎与文本入口。所有转写只写本机 data/voice/，不上传。</div></div>' +
      '<div class="v3-card"><h3>最近转写 <button class="btn btn-sm" id="voice-transcript-reload" data-testid="voice-transcript-reload">刷新</button></h3><div class="v3-transcript-list" id="voice-transcript-list" data-testid="voice-transcript-list">' + transcriptsHtml() + '</div></div>' +
      '<div class="v3-card"><h3>Worker 诊断</h3><div class="v3-hint" data-testid="voice-worker-status">ASR：' + esc((workers.asr && workers.asr.state) || '—') + (workers.asr && workers.asr.lastError ? ' · ' + esc(workers.asr.lastError) : '') + '<br>LLM：' + esc((workers.llm && workers.llm.state) || '—') + (workers.llm && workers.llm.model ? ' · ' + esc(workers.llm.model) : '') + (workers.llm && workers.llm.lastError ? ' · ' + esc(workers.llm.lastError) : '') + '<br>TTS：' + esc((workers.tts && workers.tts.state) || '—') + (providers.tts === 'speak.ps1' ? ' · speak.ps1' : providers.tts === 'sapi-inline' ? ' · SAPI 兜底' : '') + '</div>' +
      '<div class="tiny dim" style="margin-top:8px" data-testid="voice-data-dir">本机数据目录：' + esc((status && status.dataDir) || 'data/voice') + '</div></div>' +
      '<div class="v3-card"><h3>今日日报 / 日记 <span class="tiny dim" data-testid="voice-diary-time">每晚 ' + esc(((status && status.diary && status.diary.time) || '23:00')) + ' 自动生成</span></h3><div id="voice-diary" data-testid="voice-diary">' + diaryHtml() + '</div></div>' +
      '<div class="v3-card"><h3>最近事件</h3><div class="v3-events" id="voice-events" data-testid="voice-events">' + esc(eventsText()) + '</div></div>' +
      '</div>';
    return html;
  }

  function patch() {
    var cap = $('#voice-caption-stream');
    if (cap) { cap.innerHTML = captionHtml(); cap.scrollTop = cap.scrollHeight; }
    var reply = $('#voice-reply');
    if (reply) reply.innerHTML = replyHtml(); loadReplyAudio();
    var ev = $('#voice-events');
    if (ev) ev.textContent = eventsText();
    var st = $('#voice-state-text');
    if (st && V.status) st.textContent = stateLabel(V.status.state) + (V.status.enabled ? '' : ' · 未开启') + (V.status.lastError ? ' · ' + V.status.lastError : '');
    var orb = $('#voice-orb');
    if (orb && V.status) {
      orb.setAttribute('data-state', V.status.state || 'idle');
      orb.setAttribute('data-active', V.status.enabled && ['listening', 'session', 'wake', 'thinking', 'executing'].indexOf(V.status.state) >= 0 ? '1' : '0');
    }
    var btn = $('#voice-toggle');
    if (btn && V.status) btn.textContent = V.status.enabled ? '关闭语音' : '开启语音';
  }

  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    V.events.push(ev);
    if (V.events.length > 200) V.events = V.events.slice(-200);
    if (ev.type === 'status' || ev.type === 'status_snapshot') {
      var base = V.status || {};
      V.status = Object.assign({}, base, ev.type === 'status_snapshot' ? ev : { state: ev.state || base.state, enabled: ev.enabled === undefined ? base.enabled : ev.enabled });
    }
    if (ev.type === 'reply' && ev.text && typeof window.tenonToast === 'function') window.tenonToast('AI 回复：' + String(ev.text).slice(0, 70), 'ok');
    patch();
  }

  function connect() {
    if (V.es || typeof EventSource === 'undefined') return;
    try {
      var es = new EventSource('/api/v2/voice/stream');
      V.es = es;
      es.onmessage = function (msg) { var ev = null; try { ev = JSON.parse(msg.data); } catch (_) { return; } handleEvent(ev); };
      es.onerror = function () {
        if (V.es) { try { V.es.close(); } catch (_) {} V.es = null; }
        setTimeout(function () { if ($('#voice-console')) connect(); }, 4000);
      };
    } catch (_) { V.es = null; }
  }

  function load(force) {
    if (V.loading) return Promise.resolve(null);
    if (!force && V.loadedAt && Date.now() - V.loadedAt < 5000) return Promise.resolve(V.status);
    V.loading = true;
    return request('GET', '/api/v2/voice/status').then(function (r) {
      V.loading = false; V.loadedAt = Date.now();
      if (r.ok && r.data && r.data.ok) {
        V.status = r.data; V.error = '';
        patch();
        loadTranscripts();
        loadDiary();
        return r.data;
      }
      if (r.status === 404) V.error = '语音模块未挂载：/api/v2/voice/* 404（确认中枢已重启且 v2 已包含 voice 模块）';
      else if (r.status === 423) V.error = '当前实例为只读模式（423）：语音写操作不可用';
      else V.error = '语音状态读取失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status));
      renderIntoPlaceholder();
      return null;
    }, function () {
      V.loading = false;
      V.error = '无法连接中枢：语音服务暂不可用（恢复后自动重试；文本命令需中枢在线）';
      renderIntoPlaceholder();
      return null;
    });
  }

  function loadTranscripts() {
    return request('GET', '/api/v2/voice/transcripts?limit=30').then(function (r) {
      if (r.ok && r.data && r.data.items) { V.transcripts = r.data.items; patch(); }
    }, function () {});
  }

  function renderIntoPlaceholder() {
    var el = $('#voice-console-placeholder') || $('#voice-console');
    if (!el) return;
    var target = document.createElement('div');
    target.innerHTML = render();
    var holder = document.getElementById('voice-console');
    if (holder && holder.parentNode) holder.parentNode.replaceChild(target.firstChild, holder);
    bind();
  }

  function bind() {
    var orb = $('#voice-orb');
    if (orb) orb.addEventListener('click', toggle);
    var toggleBtn = $('#voice-toggle');
    if (toggleBtn) toggleBtn.addEventListener('click', toggle);
    var refresh = $('#voice-refresh');
    if (refresh) refresh.addEventListener('click', function () { V.loadedAt = 0; load(true); loadTranscripts(); });
    var send = $('#voice-command-send');
    if (send) send.addEventListener('click', runCommand);
    var input = $('#voice-command-input');
    if (input) input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') runCommand(); });
    var save = $('#voice-save-config');
    if (save) save.addEventListener('click', saveConfig);
    var reload = $('#voice-transcript-reload');
    if (reload) reload.addEventListener('click', loadTranscripts);
    var diaryBtn = document.getElementById('voice-diary-generate');
    if (diaryBtn) diaryBtn.addEventListener('click', generateDiary);
  }

  function toggle() {
    if (V.busy) return;
    V.busy = true;
    var enabled = !!(V.status && V.status.enabled);
    var path = enabled ? '/api/v2/voice/stop' : '/api/v2/voice/start';
    request('POST', path, {}).then(function (r) {
      V.busy = false;
      if (r.status === 401) { showToken(); return; }
      if (!r.ok) { toast('语音开关失败：' + ((r.data && r.data.error) || r.status), 'bad'); return; }
      toast(enabled ? '已关闭语音采集' : '已开启语音：说「榫卯」唤醒（首次加载模型约 10–30 秒）', 'ok');
      V.loadedAt = 0; load(true);
    }, function () { V.busy = false; toast('无法连接中枢', 'bad'); });
  }

  function runCommand() {
    var input = $('#voice-command-input');
    var text = input ? String(input.value || '').trim() : '';
    if (!text) { toast('先输入一条命令', 'warn'); return; }
    if (V.busy) return;
    V.busy = true;
    V.events.push({ type: 'transcript', text: text, wake: false, at: new Date().toISOString() });
    patch();
    request('POST', '/api/v2/voice/command', { text: text, source: 'text' }).then(function (r) {
      V.busy = false;
      if (r.status === 401) { showToken(); return; }
      if (!r.ok) { toast('命令失败：' + ((r.data && r.data.error) || r.status), 'bad'); return; }
      if (input) input.value = '';
      if (r.data && r.data.say) V.events.push({ type: 'reply', text: r.data.say, provider: r.data.provider, latencyMs: r.data.latencyMs, steps: r.data.steps, tts: r.data.tts, at: new Date().toISOString() });
      if (r.data && r.data.steps) V.events[V.events.length - 1].steps = r.data.steps;
      patch();
      V.loadedAt = 0; load(false);
    }, function () { V.busy = false; toast('无法连接中枢', 'bad'); });
  }

  function saveConfig() {
    var wake = $('#voice-config-wakewords');
    var asr = $('#voice-config-asr');
    var llm = $('#voice-config-llm');
    var tts = $('#voice-config-tts');
    var silence = $('#voice-config-silence');
    var patchBody = {};
    if (wake) patchBody.wakeWords = String(wake.value || '').split(/[,，、\s]+/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 8);
    if (asr) patchBody.asrProvider = asr.value;
    if (llm) patchBody.llmProvider = llm.value;
    if (tts) patchBody.tts = { enabled: !!tts.checked };
    if (silence) patchBody.silenceTimeoutMs = Number(silence.value) || 3000;
    request('PATCH', '/api/v2/voice/config', patchBody).then(function (r) {
      if (r.status === 401) { showToken(); return; }
      if (!r.ok) { toast('保存失败：' + ((r.data && r.data.error) || r.status), 'bad'); return; }
      toast('语音配置已保存', 'ok');
      V.loadedAt = 0; load(true);
    }, function () { toast('无法连接中枢', 'bad'); });
  }

  function showToken() {
    if (!document.getElementById('v3-token-card')) {
      var card = document.createElement('div');
      card.id = 'v3-token-card';
      card.className = 'alert alert-warn';
      card.setAttribute('data-testid', 'voice-token-card');
      card.style.marginTop = '12px';
      card.innerHTML = '<strong>需要操作令牌</strong>：语音写操作需要一次 operatorToken（电脑启动日志 / data/secrets.json）。<div class="row-wrap" style="margin-top:8px"><input type="password" id="v3-token-input" data-testid="voice-token-input" placeholder="operatorToken" style="flex:1;min-width:200px"><button class="btn btn-primary btn-sm" id="v3-token-save" data-testid="voice-token-save">保存令牌</button></div>';
      var host = document.getElementById('voice-console');
      if (host && host.parentNode) host.parentNode.insertBefore(card, host.nextSibling);
      var save = document.getElementById('v3-token-save');
      if (save) save.addEventListener('click', function () {
        var inp = document.getElementById('v3-token-input');
        var tok = inp ? String(inp.value || '').trim() : '';
        if (!tok) { toast('请输入操作令牌', 'warn'); return; }
        setToken(tok);
        toast('令牌已保存', 'ok');
        V.loadedAt = 0; load(true);
      });
    } else {
      document.getElementById('v3-token-card').classList.remove('hidden');
    }
  }

  window.TenonVoiceConsole = {
    render: render,
    load: load,
    connect: connect,
    patch: patch,
    bind: bind,
    syncRoute: function (route) {
      if (route === 'voice') { if (!V.loadedAt) load(); connect(); }
      else if (V.es) { try { V.es.close(); } catch (_) {} V.es = null; }
    },
    toggle: toggle,
    runCommand: runCommand,
    saveConfig: saveConfig,
    state: V,
  };
})();
