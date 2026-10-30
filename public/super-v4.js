/* 榫卯 V4 · 超级终端单页应用（首页/设备/今日/设置） */
(function () {
  'use strict';
  var TOKEN_KEY = 'tenon:token';
  var AGENT_KEY = 'tenon:agent';
  var S = { token: '', status: null, devices: [], diary: null, lastFinal: '', lastPartialAt: 0, es: null, tab: 'home', agent: 'builtin', openclaw: null };
  function $(id) { return document.getElementById(id); }
  function tok() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} S.token = t || ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function fmtTime(ts) { if (!ts) return ''; var d = new Date(typeof ts === 'number' ? ts : Date.parse(ts)); if (isNaN(d.getTime())) return ''; return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
  async function api(method, path, body, timeoutMs) {
    var headers = { 'x-tenon-token': S.token };
    var opts = { method: method, headers: headers, credentials: 'same-origin' };
    if (body !== undefined && body !== null) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) { opts.signal = ctrl.signal; setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs || 120000); }
    var r = await fetch(path, opts);
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (r.status === 401 || r.status === 423) {
      S.token = '';
      showTokenHint();
      throw new Error('需要操作令牌');
    }
    return { status: r.status, data: data, ok: r.ok };
  }
  function showTokenHint() {
    setMsg('需要操作令牌：请在「设置」里粘贴中枢操作令牌（data/secrets.json 里的 operatorToken）');
    switchTab('settings');
  }
  function setMsg(t) { var m = $('settings-msg'); if (m) m.textContent = t || ''; var h = $('home-hint'); if (h && t) h.textContent = t; }
  async function resolveToken() {
    if (tok()) { S.token = tok(); return; }
    try { if (window.tenonDesktop && window.tenonDesktop.getToken) { var t = await window.tenonDesktop.getToken(); if (t) { setToken(t); return; } } } catch (e) {}
    S.token = '';
  }
  function switchTab(name) {
    S.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === name); });
    Array.prototype.forEach.call(document.querySelectorAll('.page'), function (p) { p.classList.toggle('active', p.id === 'page-' + name); });
    if (name === 'devices') loadDevices();
    if (name === 'today') loadToday();
    if (name === 'settings') fillSettings();
  }
  // ---------- 状态与字幕（单行：partial 灰 / final 亮；同句只留一条） ----------
  function setCaption(finalText, partialText) {
    var f = $('sub-final'), p = $('sub-partial');
    if (partialText !== undefined && partialText !== null) { p.textContent = partialText; p.style.display = partialText ? 'inline' : 'none'; }
    if (finalText !== undefined && finalText !== null) {
      S.lastFinal = finalText;
      f.textContent = finalText; p.textContent = ''; p.style.display = 'none';
    }
  }
  function setVoiceChip(on, state) {
    var c = $('chip-voice'); if (!c) return;
    var listen = on || state === 'listening' || state === 'wake' || state === 'session';
    c.textContent = listen ? (state === 'listening' ? '正在聆听' : (state === 'session' ? '会话中' : '语音就绪')) : '语音待机';
    c.classList.toggle('on', !!listen);
    var orb = $('mic-orb'); if (orb) orb.classList.toggle('listening', !!listen);
  }
  async function refreshStatus() {
    try {
      var r = await api('GET', '/api/v2/voice/status');
      S.status = r.data || {};
      var st = S.status;
      setVoiceChip(st.enabled, st.state);
      $('online-dot').classList.add('on');
      if (st.workers && st.workers.asr && st.workers.asr.state === 'running') $('chip-voice').classList.add('on');
      var lt = st.lastTranscript;
      if (lt && lt.text && lt.at) {
        var key = lt.text + '|' + lt.at;
        if (key !== S._lastTranscriptKey) { S._lastTranscriptKey = key; setCaption(lt.text); }
      }
      if (st.lastReply && st.lastReply.at && st.lastReply.at !== S._lastReplyAt) {
        S._lastReplyAt = st.lastReply.at;
        renderResult({ say: st.lastReply.text, provider: st.lastReply.provider, latencyMs: st.lastReply.latencyMs, needConfirm: st.lastReply.needConfirm, confirmId: st.lastReply.confirmId, actions: st.lastCommand && st.lastCommand.actions });
        setCaption(st.lastReply.text || S.lastFinal);
      }
      var sc = $('chip-screen'); if (sc) { sc.textContent = window.tenonDesktop ? (window.tenonDesktop.screenCapture === false ? '屏幕采集暂停' : '屏幕采集中') : '屏幕采集（桌面端）'; }
    } catch (e) { $('online-dot').classList.remove('on'); }
  }
  function connectSSE() {
    if (typeof EventSource === 'undefined') return;
    try {
      if (S.es) { try { S.es.close(); } catch (e) {} }
      S.es = new EventSource('/api/v2/voice/stream');
      S.es.onmessage = function (ev) {
        try {
          var m = JSON.parse(ev.data || '{}');
          if (m.type === 'transcript' && m.text) { setCaption(m.text); }
          else if (m.type === 'partial' && m.text) { setCaption(undefined, m.text); }
          else if (m.type === 'wake') { setCaption('「' + (m.word || '榫卯') + '」我在，请说'); }
          else if (m.type === 'reply' && m.text) { renderResult(m); setCaption(m.text); }
          else if (m.type === 'status' || m.type === 'status_snapshot') { refreshStatus(); }
          else if (m.type === 'error' && m.text) { renderResult({ say: m.text, error: true }); }
        } catch (e) {}
      };
      S.es.onerror = function () { try { S.es.close(); } catch (e) {} S.es = null; setTimeout(connectSSE, 4000); };
    } catch (e) { setTimeout(connectSSE, 5000); }
  }
  // ---------- 结果卡 ----------
  function renderResult(j) {
    if (!j) return;
    var card = $('result'); card.classList.remove('hidden');
    $('result-provider').textContent = (j.provider || 'local') + (j.latencyMs ? ' · ' + (j.latencyMs / 1000).toFixed(1) + 's' : '');
    $('result-time').textContent = fmtTime(Date.now());
    $('result-say').textContent = j.say || j.text || (j.error ? '出错了' : '');
    var steps = j.steps || j.actions || [];
    $('result-steps').innerHTML = (steps || []).slice(0, 8).map(function (s) {
      var st = s.status || (s.ok === false ? 'failed' : 'succeeded');
      var cls = /fail|error/.test(st) ? 'fail' : (/ok|success|dispatch|succeed/.test(st) ? 'ok' : '');
      return '<span class="st ' + cls + '">' + esc(s.label || s.action || s) + '</span>';
    }).join('');
    var acts = $('result-actions'); acts.innerHTML = '';
    if (j.needConfirm) {
      var b = document.createElement('button'); b.className = 'primary'; b.textContent = '确认执行';
      b.onclick = function () { confirmRun(j); }; acts.appendChild(b);
    }
  }
  async function confirmRun(j) {
    try {
      var r = await api('POST', '/api/v2/voice/confirm', { confirmId: j.confirmId || j.confirm_id || null, yes: true });
      renderResult({ say: (r.data && r.data.message) || (r.data && r.data.say) || '已确认', provider: 'deepseek' });
    } catch (e) { renderResult({ say: '确认失败：' + e.message, error: true }); }
  }
  async function sendCommand(text) {
    if (!text || !text.trim()) return;
    var cmd = text.trim();
    if (S.agent === 'openclaw') {
      setCaption('“' + cmd + '” → OpenClaw（小龙虾）执行中…');
      try {
        var r = await api('POST', '/api/v2/agent/openclaw', { text: cmd, timeoutMs: 180000 });
        var d = r.data || {};
        renderResult({ say: d.say || ('OpenClaw 完成（' + (d.durationMs || 0) + 'ms）'), provider: 'openclaw · ' + (d.model || ''), latencyMs: d.durationMs, steps: [] });
        setCaption(d.say || '');
      } catch (e) { renderResult({ say: 'OpenClaw 执行失败：' + e.message + '（可到设置切回自研执行器）', error: true }); }
      return;
    }
    setCaption('“' + cmd + '” → 电脑理解中…');
    try {
      var r = await api('POST', '/api/v2/voice/command', { text: cmd });
      var d = r.data || {};
      renderResult(d);
      setCaption(d.say || d.text || '');
    } catch (e) { renderResult({ say: '执行失败：' + e.message, error: true }); }
  }
  // ---------- 设备 ----------
  async function loadDevices() {
    var box = $('device-list'); if (!box) return;
    box.innerHTML = '<div class="muted">加载中…</div>';
    try {
      var r = await api('GET', '/api/v2/devices');
      var d = r.data || {};
      var list = d.devices || d.items || [];
      if (!Array.isArray(list) || !list.length) { box.innerHTML = '<div class="muted">未发现设备：请确认 node-agent 已启动（电脑本机）或手机 App 已打开。</div>'; return; }
      S.devices = list;
      box.innerHTML = list.map(function (dev) {
        var bound = !!dev.bound || !!dev.isBound || dev.status === 'bound';
        var online = dev.online !== false;
        return '<div class="device" data-id="' + esc(dev.id) + '">' +
          '<h3><span class="dot ' + (online ? 'on' : '') + '"></span>' + esc(dev.name || dev.id) + '</h3>' +
          '<div class="meta">' + esc(dev.type || dev.kind || '设备') + ' · ' + (bound ? '已绑定' : '未绑定') + ' · ' + (online ? '在线' : '离线') + '</div>' +
          '<div class="acts">' +
          (bound ? '<button class="primary" data-act="unbind">移除</button>' : '<button class="primary" data-act="bind">使用这台</button>') +
          '<button data-cmd="把电脑音量调到 60">音量 60</button><button data-cmd="打开记事本">打开记事本</button><button data-cmd="回家模式">回家模式</button>' +
          '</div></div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('button[data-act]'), function (b) {
        b.onclick = async function () {
          var card = b.closest('.device'); var id = card.getAttribute('data-id');
          var act = b.getAttribute('data-act');
          b.disabled = true;
          try {
            var apiPath = '/api/v2/devices/' + encodeURIComponent(id) + '/' + act;
            var rr = await api('POST', apiPath, {});
            if (rr.ok) { b.textContent = act === 'bind' ? '已绑定' : '已移除'; setTimeout(loadDevices, 600); }
            else { b.textContent = '失败'; setMsg('操作失败：' + ((rr.data && rr.data.error) || rr.status)); b.disabled = false; }
          } catch (e) { b.textContent = '失败'; b.disabled = false; }
        };
      });
      Array.prototype.forEach.call(box.querySelectorAll('button[data-cmd]'), function (b) { b.onclick = function () { sendCommand(b.getAttribute('data-cmd')); }; });
    } catch (e) { box.innerHTML = '<div class="muted">加载失败：' + esc(e.message) + '</div>'; }
  }
  // ---------- 今日 ----------
  async function loadToday() {
    var today = new Date().toISOString().slice(0, 10);
    try {
      var r = await api('GET', '/api/v2/voice/transcripts?limit=60');
      var items = (r.data && (r.data.items || r.data.transcripts)) || [];
      $('voice-list').innerHTML = items.slice(-40).reverse().map(function (it) {
        return '<div class="item"><span class="t">' + esc(fmtTime(it.at || it.ts)) + '</span>' + esc((it.preview || it.text || '').slice(0, 160)) + '</div>';
      }).join('') || '<div class="muted">今天还没有语音记录</div>';
    } catch (e) { $('voice-list').innerHTML = '<div class="muted">读取失败：' + esc(e.message) + '</div>'; }
    try {
      var sc = await api('GET', '/api/v2/voice/screen?limit=60');
      var sitems = (sc.data && sc.data.items) || [];
      $('screen-list').innerHTML = sitems.slice(-40).reverse().map(function (it) {
        return '<div class="item"><span class="t">' + esc(fmtTime(it.at || it.ts)) + '</span>' + esc((it.app || '') + ' ' + (it.title || '')) + '<br><span style="color:#8aa5bd">' + esc((it.text || '').slice(0, 200)) + '</span></div>';
      }).join('') || '<div class="muted">今天还没有屏幕文字</div>';
    } catch (e) { $('screen-list').innerHTML = '<div class="muted">读取失败：' + esc(e.message) + '</div>'; }
    await loadDiary();
  }
  async function loadDiary() {
    try {
      var r = await api('GET', '/api/v2/voice/diary');
      var d = r.data || {};
      var md = d.markdown || d.content || '';
      if (md) {
        S.diary = d;
        $('diary-card').classList.remove('hidden');
        $('diary-provider').textContent = 'DeepSeek · 每日总结';
        $('diary-time').textContent = d.date || '';
        $('diary-md').textContent = md;
      }
    } catch (e) { /* 无总结时忽略 */ }
  }
  $('diary-generate').onclick = async function () {
    var b = this; b.disabled = true; b.textContent = '生成中…';
    try { await api('POST', '/api/v2/voice/diary/generate', { force: true }); await loadDiary(); b.textContent = '现在总结'; b.disabled = false; }
    catch (e) { b.textContent = '生成失败'; b.disabled = false; setMsg('总结失败：' + e.message); }
  };
  $('today-refresh').onclick = function (e) { e.preventDefault(); loadToday(); };
  $('dev-refresh').onclick = function () { loadDevices(); };
  // ---------- 设置 ----------
  async function fillSettings() {
    try {
      var c = await api('GET', '/api/v2/voice/config');
      var cfg = (c.data && c.data.config) || {};
      $('set-token').value = S.token || '';
      $('set-enabled').checked = !!cfg.enabled;
      $('set-wakewords').value = (cfg.wakeWords || []).join(',');
      $('set-tts').checked = !!(cfg.tts && cfg.tts.play);
      $('set-diary-time').value = (cfg.diary && cfg.diary.time) || '23:00';
      $('set-retention').value = cfg.retentionDays || 30;
      $('set-screen-interval').value = (cfg.screen && cfg.screen.intervalSec) || 60;
      try { S.agent = localStorage.getItem(AGENT_KEY) || 'builtin'; } catch (e) { S.agent = 'builtin'; }
      if ($('set-agent')) $('set-agent').value = S.agent;
      var chipA = $('chip-agent'); if (chipA) chipA.textContent = S.agent === 'openclaw' ? 'OpenClaw 小龙虾' : '自研执行器';
    } catch (e) { setMsg('读取配置失败：' + e.message); }
  }
  $('set-load').onclick = function () { S.token = $('set-token').value.trim(); setToken(S.token); fillSettings(); };
  $('set-save').onclick = async function () {
    S.token = $('set-token').value.trim(); setToken(S.token);
    try { S.agent = $('set-agent') ? $('set-agent').value : 'builtin'; localStorage.setItem(AGENT_KEY, S.agent); } catch (e) {}
    var chipA2 = $('chip-agent'); if (chipA2) chipA2.textContent = S.agent === 'openclaw' ? 'OpenClaw 小龙虾' : '自研执行器';
    var body = {
      enabled: $('set-enabled').checked,
      wakeWords: $('set-wakewords').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      tts: { play: $('set-tts').checked },
      diary: { time: $('set-diary-time').value || '23:00' },
      retentionDays: Number($('set-retention').value) || 30,
      screen: { intervalSec: Number($('set-screen-interval').value) || 60 },
    };
    try { var r = await api('PATCH', '/api/v2/voice/config', body); setMsg(r.ok ? '已保存到中枢 ✓' : '保存失败'); refreshStatus(); }
    catch (e) { setMsg('保存失败：' + e.message); }
  };
  $('set-diag').onclick = async function () {
    try {
      var st = await api('GET', '/api/v2/voice/status');
      var ag = await api('GET', '/api/v2/agent/status');
      setMsg('语音：' + JSON.stringify((st.data && st.data.workers) || {}) + '\n执行器：' + ((ag.data && ag.data.provider) || '?') + ' / 模型 ' + ((ag.data && ag.data.model) || '?'));
    } catch (e) { setMsg('诊断失败：' + e.message); }
  };
  // ---------- 麦克风 ----------
  async function toggleMic() {
    try {
      var st = S.status || {};
      var on = !!st.enabled;
      var r = await api('POST', on ? '/api/v2/voice/stop' : '/api/v2/voice/start', {});
      setCaption(on ? '已暂停语音监听' : '正在开启语音监听…');
      setTimeout(refreshStatus, 800);
    } catch (e) { setCaption('语音开关失败：' + e.message); }
  }
  // ---------- 事件绑定 ----------
  document.addEventListener('DOMContentLoaded', async function () {
    document.querySelectorAll('.tab').forEach(function (b) { b.onclick = function () { switchTab(b.getAttribute('data-tab')); }; });
    $('btn-settings').onclick = function () { switchTab('settings'); };
    $('mic-orb').onclick = toggleMic;
    $('cmd-send').onclick = function () { sendCommand($('cmd-input').value); $('cmd-input').value = ''; };
    $('cmd-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') { sendCommand($('cmd-input').value); $('cmd-input').value = ''; } });
    document.querySelectorAll('.quick button').forEach(function (b) { b.onclick = function () { sendCommand(b.getAttribute('data-cmd')); }; });
    await resolveToken();
    try { S.agent = localStorage.getItem(AGENT_KEY) || 'builtin'; } catch (e) {}
    var chipA0 = $('chip-agent'); if (chipA0) chipA0.textContent = S.agent === 'openclaw' ? 'OpenClaw 小龙虾' : '自研执行器';
    try { var oc = await api('GET', '/api/v2/agent/openclaw/status'); S.openclaw = (oc.data || null); } catch (e) {}
    await refreshStatus();
    connectSSE();
    setInterval(function () { if (!document.hidden) refreshStatus(); }, 1500);
    setInterval(function () { if (!document.hidden && S.tab === 'today') loadToday(); }, 60000);
    await loadDevices();
  });
})();
