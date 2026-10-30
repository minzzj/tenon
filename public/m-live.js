/* 榫卯 V3 · 手机实时字幕 HUD（/m-live.html，/m/live 由 Lead 加静态映射）
 * 真实链路：GET /api/v2/voice/status + SSE /api/v2/voice/stream + POST /command（文本兜底）+ /start|/stop。
 * 无 worker 时显示「语音服务未就绪」，文本命令仍可用；错误可读、支持 401 令牌引导。 */
(function () {
  'use strict';
  var TOKEN_KEY = 'tenon:token';
  var state = { status: null, events: [], es: null, token: '', partialEl: null, captions: 0, connected: false };
  function $(sel) { return document.querySelector(sel); }
  function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (_) {} }
  function toast(msg, kind) {
    var root = $('#voice-toast-root');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (kind === 'ok' ? 'toast-ok' : kind === 'warn' ? 'toast-warn' : 'toast-bad');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3600);
  }
  function hhmm(at) { try { var d = new Date(at || Date.now()); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); } catch (_) { return ''; } }
  function showError(text) {
    var el = $('#voice-error');
    if (!el) return;
    if (!text) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden');
    el.textContent = text;
  }
  function request(method, path, body, useToken) {
    state.token = getToken();
    var headers = { Accept: 'application/json' };
    if ((useToken !== false) && state.token) headers['x-tenon-token'] = state.token;
    var opts = { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) { return { status: res.status, ok: res.ok, data: data }; });
    });
  }
  function setChip(sel, text, kind) {
    var el = $(sel);
    if (!el) return;
    el.textContent = text;
    el.setAttribute('data-on', kind === 'ok' ? '1' : '0');
    el.setAttribute('data-bad', kind === 'bad' ? '1' : '0');
  }
  function stateLabel(s) {
    var map = { idle: '待机（点麦克风开启）', starting: '语音服务启动中…', listening: '正在聆听', wake: '已唤醒', session: '会话中，请说命令', thinking: '正在理解…', executing: '正在执行…', reply: '已回复', error: '服务异常（可看下方错误，文本仍可用）' };
    return map[s] || s || '未知状态';
  }
  function orbState(status) {
    var orb = $('#voice-orb');
    if (!orb) return;
    var st = (status && status.state) || 'idle';
    orb.setAttribute('data-state', st);
    orb.setAttribute('data-active', status && status.enabled && ['listening', 'session', 'wake', 'thinking', 'executing'].indexOf(st) >= 0 ? '1' : '0');
    var label = $('#voice-orb-label');
    if (label) label.textContent = status && status.enabled ? (st === 'thinking' || st === 'executing' ? '处理中…' : '语音已开启') : '语音管家';
    var toggle = $('#voice-mic-toggle');
    if (toggle) { toggle.textContent = status && status.enabled ? '关闭语音' : '开启语音'; toggle.setAttribute('data-enabled', status && status.enabled ? '1' : '0'); }
  }
  function renderStatus(status) {
    if (!status) return;
    state.status = status;
    setChip('#chip-state', (status.enabled ? 'PC 常驻监听中 · ' : 'PC 未开启语音 · ') + stateLabel(status.state), status.enabled ? (status.state === 'error' ? 'bad' : 'ok') : '');
    var p = status.providers || {};
    setChip('#chip-asr', 'ASR ' + (p.asr || '未知'), p.asr === 'unavailable' ? 'bad' : p.asr ? 'ok' : '');
    setChip('#chip-llm', '模型 ' + (p.llm || '未知'), p.llm === 'rule' ? '' : p.llm ? 'ok' : 'bad');
    setChip('#chip-tts', 'TTS ' + (p.tts || '未知'), p.tts === 'off' ? '' : p.tts ? 'ok' : 'bad');
    var cloud = !!(status.ai && status.ai.available);
    setChip('#chip-ai', cloud ? '理解 DeepSeek' : '理解 本地', cloud ? 'ok' : '');
    var privacy = $('#voice-privacy');
    if (privacy) {
      privacy.textContent = cloud ? '本地识别 · 云端理解（仅唤醒命令/每晚汇总）' : '本地识别 · 本地理解（数据不出本机）';
      privacy.setAttribute('data-cloud', cloud ? '1' : '0');
    }
    var st = $('#voice-state-text');
    if (st) { st.textContent = stateLabel(status.state) + (status.lastError ? ' · ' + status.lastError : ''); st.setAttribute('data-bad', status.state === 'error' ? '1' : '0'); }
    var wake = $('#voice-wake');
    if (wake) {
      var lw = status.lastWake;
      wake.textContent = lw ? '已唤醒「' + (lw.word || '') + '」' + (lw.via === 'pinyin' ? '（拼音命中）' : '') + ' · ' + hhmm(lw.at) : '等待唤醒「榫卯 / 小榫」';
      wake.setAttribute('data-on', lw ? '1' : '0');
    }
    var ww = $('#voice-wakewords');
    if (ww && Array.isArray(status.wakeAliases) && status.wakeAliases.length) ww.textContent = status.wakeAliases.join(' / ') + '（支持拼音同音；可在桌面 #/voice 自定义）';
    var count = $('#voice-transcript-count');
    if (count && status.counters) count.textContent = String(status.counters.transcripts || 0);
    showError(status.state === 'error' || status.lastError ? (status.lastError || '语音服务异常：可查看 /api/v2/voice/status，文本命令仍可用') : '');
    orbState(status);
    if (status.recentEvents && status.recentEvents.length && !state.events.length) {
      state.events = status.recentEvents.slice(-20);
      renderEvents();
    }
  }
  function renderEvents() {
    var box = $('#voice-events');
    if (!box) return;
    box.textContent = state.events.slice(-20).map(function (e) { return hhmm(e.at) + ' ' + (e.type || 'event') + (e.text ? ' · ' + String(e.text).slice(0, 60) : '') + (e.state ? ' · ' + e.state : ''); }).join('\n');
    box.scrollTop = box.scrollHeight;
  }
  /* ---------- 单行字幕（V4 修复）----------
   * 用户明确报的 bug：同一句话既有 partial 临时行、又追加 final 最终行（甚至 SSE 重连后重复追加），
   * 看起来就是「两行重复识别」。修复：partial / final 共用固定的两个槽位——
   *   1) 1 条最终字幕（高亮，final 到达时替换同句临时行）
   *   2) 1 条临时字幕（识别中，灰色）
   * 并按 text|ts 去重：同一事件重复、重连重放、同一文本短时间内重复都不再追加。 */
  var capState = { finalText: '', finalAt: 0, lastKey: '', lastFinalText: '', lastFinalAt: 0, partialText: '' };
  function ensureCaptionStyles() {
    if (document.getElementById('v4-caption-style')) return;
    var st = document.createElement('style');
    st.id = 'v4-caption-style';
    st.textContent = [
      '#voice-caption-stream.v4-caption-stream{display:flex;flex-direction:column;gap:12px;min-height:150px;padding:18px 20px;background:#000;border:1px solid rgba(120,170,220,.18);border-radius:18px;box-sizing:border-box}',
      '.v4-cap{font-size:34px;line-height:1.42;font-weight:700;color:#f4f8ff;word-break:break-word;text-align:left}',
      '.v4-cap-partial{color:#7d8798;font-weight:500;font-size:30px}',
      '.v4-cap:empty{display:none}',
      '.v4-cap-final.flash{animation:v4capflash .5s ease-out}',
      '@keyframes v4capflash{0%{opacity:.25;transform:translateY(6px)}100%{opacity:1;transform:none}}',
      '.v4-cap-note{font-size:12px;color:#5f7592;margin:6px 2px 0;line-height:1.5}',
      '/* phone-voice.js 的悬浮麦克风在 /m/live 上缩小并移到底部右侧，避免遮挡字幕与回复卡 */',
      '#pv-btn{left:auto !important;right:16px !important;bottom:18px !important;transform:none !important;width:56px !important;height:56px !important;font-size:22px !important;opacity:.9}',
      '#phone-voice-card{bottom:86px !important}'
    ].join('\n');
    document.head.appendChild(st);
  }
  function ensureCaptionSlots() {
    ensureCaptionStyles();
    var stream = $('#voice-caption-stream');
    if (!stream) return null;
    stream.classList.add('v4-caption-stream');
    var fin = stream.querySelector('.v4-cap-final');
    var par = stream.querySelector('.v4-cap-partial');
    if (!fin || !par) {
      stream.innerHTML = '';
      fin = document.createElement('div');
      fin.className = 'v4-cap v4-cap-final';
      fin.id = 'v4-cap-final';
      fin.setAttribute('data-testid', 'voice-caption');
      fin.setAttribute('data-kind', 'final');
      par = document.createElement('div');
      par.className = 'v4-cap v4-cap-partial';
      par.id = 'v4-cap-partial';
      par.setAttribute('data-testid', 'voice-caption');
      par.setAttribute('data-kind', 'partial');
      stream.appendChild(fin);
      stream.appendChild(par);
    }
    if (!$('#voice-caption-note')) {
      var note = document.createElement('div');
      note.id = 'voice-caption-note';
      note.className = 'v4-cap-note';
      note.setAttribute('data-testid', 'voice-caption-note');
      note.textContent = '同一句话只显示一条：识别中显示灰色临时字幕，最终结果替换为高亮的一条。';
      if (stream.parentNode) stream.parentNode.insertBefore(note, stream.nextSibling);
    }
    return { stream: stream, fin: fin, par: par };
  }
  function setFinalCaption(text, at) {
    text = String(text || '').trim();
    if (!text) return;
    var key = text + '|' + String(at || '');
    if (key === capState.lastKey) return;                                        // 同一事件重复
    if (text === capState.lastFinalText && Date.now() - capState.lastFinalAt < 4000) return; // 重连重放/短时间重复
    if (text === capState.finalText && Date.now() - capState.finalAt < 2500) return;
    capState.lastKey = key;
    capState.lastFinalText = text;
    capState.lastFinalAt = Date.now();
    capState.finalText = text;
    capState.finalAt = Date.now();
    capState.partialText = '';
    var slot = ensureCaptionSlots();
    if (!slot) return;
    slot.fin.textContent = text;
    slot.par.textContent = '';
    slot.fin.classList.remove('flash');
    void slot.fin.offsetWidth;
    slot.fin.classList.add('flash');
    var hint = $('#voice-caption-note');
    if (hint) hint.textContent = '已识别 · ' + hhmm(new Date()) + '（同一句只保留这一条最终字幕）';
  }
  function setPartialCaption(text) {
    text = String(text || '').trim();
    if (!text) return;
    if (text === capState.finalText) return;               // partial 与最终结果相同：不另起一行
    if (text === capState.partialText) return;             // 同一个临时结果：原地更新，不追加
    if (capState.partialText && capState.partialText.indexOf(text) === 0) return; // 服务端回退旧前缀：忽略
    capState.partialText = text;
    var slot = ensureCaptionSlots();
    if (!slot) return;
    slot.par.textContent = text;
    var hint = $('#voice-caption-note');
    if (hint) hint.textContent = '识别中…（灰色为临时字幕，最终结果会替换它，不会多出一行）';
  }
  function appendCaption(kind, text, at) {
    if (kind === 'partial') { setPartialCaption(text); return; }
    if (kind === 'final') { setFinalCaption(text, at || new Date()); return; }
    // 唤醒/理解/执行/回复提示不再写入字幕流，避免出现多行；改到状态行显示
    var st = $('#voice-state-text');
    if (st && text) st.textContent = String(text).replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').slice(0, 140);
  }
  function renderReply(ev) {
    var card = $('#voice-reply');
    if (!card) return;
    card.classList.remove('hidden');
    $('#voice-reply-text').textContent = ev.text || '';
    var steps = $('#voice-reply-steps');
    if (steps) steps.innerHTML = (ev.steps || []).slice(0, 6).map(function (s) {
      return '<div class="v3-step" data-ok="' + (s.status === 'succeeded' || s.status === 'dispatched' ? '1' : '0') + '">' + (s.status === 'succeeded' || s.status === 'dispatched' ? '✓' : '✗') + ' ' + esc(s.label || '') + (s.summary ? ' · ' + esc(String(s.summary).slice(0, 80)) : '') + '</div>';
    }).join('');
    var meta = $('#voice-reply-meta');
    if (meta) {
      var bits = [];
      bits.push('提供方：' + (ev.provider || 'rule'));
      if (ev.latencyMs != null) bits.push(Math.round(ev.latencyMs) + 'ms');
      bits.push('TTS ' + Math.round((ev.tts.bytes || 0) / 1024) + 'KB' + (ev.tts.durationMs ? ' · ' + (ev.tts.durationMs / 1000).toFixed(1) + 's' : ''));
      if (ev.tts.audio && ev.tts.audio.id) playReplyAudio(ev.tts.audio.id);
      else if (ev.tts && ev.tts.error) bits.push('TTS 失败：' + ev.tts.error);
      meta.innerHTML = bits.map(function (b) { return '<span class="v3-chip">' + esc(b) + '</span>'; }).join('');
    }
  }
  function playReplyAudio(id) {
    var audio = $('#voice-reply-audio');
    if (!audio || !id) return;
    try {
      fetch('/api/v2/voice/reply-audio?id=' + encodeURIComponent(id), { headers: { 'x-tenon-token': getToken() }, credentials: 'same-origin' })
        .then(function (res) { if (!res.ok) throw new Error('audio HTTP ' + res.status); return res.blob(); })
        .then(function (blob) {
          audio.classList.remove('hidden');
          audio.src = URL.createObjectURL(blob);
          var p = audio.play();
          if (p && p.catch) p.catch(function () { /* 浏览器需用户手势，保留 controls 手动播放 */ });
        })
        .catch(function () { /* 音频失败不影响文字/执行 */ });
    } catch (_) {}
  }
  function addTranscriptItem(ev) {
    var list = $('#voice-transcript-list');
    if (!list) return;
    var el = document.createElement('div');
    el.className = 'v3-transcript';
    el.setAttribute('data-testid', 'voice-transcript');
    el.setAttribute('data-sensitive', ev.sensitive ? '1' : '0');
    el.innerHTML = '<span class="v3-ts">' + esc(hhmm(ev.at)) + '</span>' + (ev.wake ? '🔔 ' : '') + esc(ev.text || '') + (ev.sensitive ? '（敏感内容已过滤）' : '');
    list.appendChild(el);
    while (list.children.length > 20) list.removeChild(list.firstChild);
    var count = $('#voice-transcript-count');
    if (count && state.status && state.status.counters) count.textContent = String(state.status.counters.transcripts || list.children.length);
  }
  function setWakeChip(text) { var el = $('#voice-wake'); if (el) el.textContent = text; }
  function setStateHint(text) { var el = $('#voice-state-text'); if (el && text) el.textContent = text; }
  function handleEvent(ev) {
    if (!ev || !ev.type) return;
    state.events.push(ev);
    if (state.events.length > 120) state.events = state.events.slice(-120);
    renderEvents();
    switch (ev.type) {
      case 'status':
      case 'status_snapshot':
        renderStatus(ev.type === 'status_snapshot' ? ev : Object.assign({}, state.status || {}, { state: ev.state, enabled: ev.enabled, sessionId: ev.sessionId }));
        break;
      case 'partial':
        appendCaption('partial', ev.text || '', ev.at || ev.ts);
        break;
      case 'transcript':
        appendCaption('final', ev.text || '', ev.at || ev.ts);
        addTranscriptItem(ev);
        setWakeChip(ev.wake ? '🔔 已唤醒并识别到一句' : '等待唤醒「榫卯」');
        break;
      case 'final':
        appendCaption('final', ev.text || '', ev.at || ev.ts);
        break;
      case 'wake':
        setWakeChip('🔔 已唤醒「' + (ev.word || '榫卯') + '」');
        setStateHint('已唤醒，请说命令');
        break;
      case 'thinking':
        setStateHint('🤔 正在理解…');
        break;
      case 'executing':
        setStateHint('⚙️ 正在执行…');
        break;
      case 'reply':
        renderReply(ev);
        setWakeChip('等待唤醒「榫卯」');
        break;
      case 'error':
        setStateHint('⚠️ ' + (ev.text || '语音服务错误'));
        showError(ev.text || '语音服务错误');
        break;
      case 'level': {
        var bar = $('#voice-level');
        if (bar) bar.style.width = Math.max(0, Math.min(100, Number(ev.level) || 0)) + '%';
        break;
      }
      case 'session_end':
        setStateHint('会话结束');
        setWakeChip('等待唤醒「榫卯」');
        break;
      default:
        break;
    }
  }
  function connectSse() {
    if (state.es) { try { state.es.close(); } catch (_) {} state.es = null; }
    try {
      var es = new EventSource('/api/v2/voice/stream');
      state.es = es;
      es.onopen = function () { state.connected = true; };
      es.onmessage = function (ev) {
        var data = null;
        try { data = JSON.parse(ev.data); } catch (_) {}
        if (data) handleEvent(data);
      };
      es.onerror = function () {
        state.connected = false;
        if (state.es) { try { state.es.close(); } catch (_) {} state.es = null; }
        showError('实时字幕连接断开，正在重连…（文本命令仍可用）');
        setTimeout(refreshStatus, 3000);
      };
    } catch (_) {}
  }
  function refreshStatus() {
    return request('GET', '/api/v2/voice/status', undefined, false).then(function (r) {
      if (r.ok && r.data) {
        renderStatus(r.data);
        showError(r.data.state === 'error' || r.data.lastError ? (r.data.lastError || '') : '');
        loadTranscripts();
        return r.data;
      }
      if (r.status === 404) showError('语音模块未挂载（/api/v2/voice/* 404）：请确认中枢已重启并加载 voice 模块');
      else showError('语音服务状态读取失败：HTTP ' + r.status + (r.data && r.data.error ? ' · ' + r.data.error : ''));
      return null;
    }).catch(function () { showError('无法连接中枢：请确认电脑端榫卯正在运行'); return null; });
  }
  function loadTranscripts() {
    return request('GET', '/api/v2/voice/transcripts', undefined, false).then(function (r) {
      if (!r.ok || !r.data || !Array.isArray(r.data.items)) return;
      var list = $('#voice-transcript-list');
      if (!list) return;
      list.innerHTML = r.data.items.slice(-12).reverse().map(function (it) {
        return '<div class="v3-transcript" data-testid="voice-transcript" data-sensitive="' + (it.redacted ? '1' : '0') + '"><span class="v3-ts">' + esc(hhmm(it.at)) + '</span>' + (it.wake ? '🔔 ' : '') + esc(it.text || (it.redacted ? '（敏感内容已过滤）' : '')) + '</div>';
      }).join('');
    }).catch(function () {});
  }
  function toggleMic() {
    var enabled = !!(state.status && state.status.enabled);
    var path = enabled ? '/api/v2/voice/stop' : '/api/v2/voice/start';
    var btn = $('#voice-mic-toggle');
    if (btn) btn.disabled = true;
    request('POST', path, {}, true).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 401) { $('#voice-token-card').classList.remove('hidden'); toast('需要操作令牌才能开启语音', 'warn'); return; }
      if (!r.ok) { showError((r.data && r.data.error) || ('操作失败 HTTP ' + r.status)); toast('语音开关失败', 'bad'); return; }
      toast(enabled ? '已关闭语音采集' : '已开启语音：说「榫卯」唤醒', 'ok');
      refreshStatus();
    }).catch(function () { if (btn) btn.disabled = false; toast('无法连接中枢', 'bad'); });
  }
  function sendText() {
    var input = $('#voice-text-input');
    var text = input ? String(input.value || '').trim() : '';
    if (!text) { toast('先输入一条命令', 'warn'); return; }
    var btn = $('#voice-text-send');
    if (btn) btn.disabled = true;
    appendCaption('final', '⌨️ ' + text, Date.now());
    request('POST', '/api/v2/voice/command', { text: text, source: 'text' }, true).then(function (r) {
      if (btn) btn.disabled = false;
      if (r.status === 401) { $('#voice-token-card').classList.remove('hidden'); toast('需要操作令牌', 'warn'); return; }
      if (!r.ok) { showError((r.data && r.data.error) || ('命令失败 HTTP ' + r.status)); return; }
      if (input) input.value = '';
      if (r.data && r.data.say) renderReply({ text: r.data.say, provider: r.data.provider, latencyMs: r.data.latencyMs, steps: r.data.steps, tts: r.data.tts });
    }).catch(function () { if (btn) btn.disabled = false; toast('无法连接中枢', 'bad'); });
  }
  function bind() {
    $('#voice-orb').addEventListener('click', toggleMic);
    $('#voice-mic-toggle').addEventListener('click', toggleMic);
    $('#voice-text-send').addEventListener('click', sendText);
    $('#voice-text-input').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') sendText(); });
    var save = $('#voice-token-save');
    if (save) save.addEventListener('click', function () {
      var inp = $('#voice-token-input');
      var tok = inp ? String(inp.value || '').trim() : '';
      if (!tok) { toast('请输入操作令牌', 'warn'); return; }
      setToken(tok);
      $('#voice-token-card').classList.add('hidden');
      toast('令牌已保存', 'ok');
      refreshStatus();
    });
    document.querySelectorAll('[data-suggest]').forEach(function (el) {
      el.addEventListener('click', function () {
        var input = $('#voice-text-input');
        if (input) input.value = el.getAttribute('data-suggest') || '';
        sendText();
      });
    });
  }
  function init() {
    bind();
    try { ensureCaptionSlots(); } catch (e) {}
    refreshStatus().then(function () { connectSse(); });
    setInterval(function () { if (!state.es) refreshStatus().then(connectSse); }, 8000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
