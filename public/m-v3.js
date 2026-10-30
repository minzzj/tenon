/* 榫卯 V3 · /m 单屏极简升级：大麦克风 + 今日摘要 + 快捷入口 + 实时字幕（保留下方原有功能区块） */
(function () {
  'use strict';
  var TOKEN_KEY = 'tenon:token';
  function $(s) { return document.querySelector(s); }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function req(method, path, body) {
    var headers = { Accept: 'application/json' };
    var tok = getToken();
    if (tok) headers['x-tenon-token'] = tok;
    var opts = { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) { return r.json().catch(function () { return null; }).then(function (d) { return { status: r.status, ok: r.ok, data: d }; }); });
  }
  function setStatus(text, bad) {
    var el = $('#m-voice-status');
    if (!el) return;
    el.textContent = text;
    el.setAttribute('data-bad', bad ? '1' : '0');
    el.style.color = bad ? '#ff6b6b' : '';
  }
  function setOrb(active) { var o = $('#m-voice-orb'); if (o) o.setAttribute('data-active', active ? '1' : '0'); }
  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:99;padding:9px 14px;border-radius:10px;background:#0d1a28;color:#e9f1fa;border:1px solid #66e3d2;font-size:12.5px;max-width:86%';
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2800);
  }
  var last = null;
  function render(status) {
    last = status;
    if (!status || !status.ok) { setStatus('语音服务未就绪（可点「实时字幕」查看原因；文本命令可在桌面 #/voice 使用）', true); setOrb(false); return; }
    var stateMap = { idle: '待机', starting: '启动中…', listening: '正在聆听', session: '会话中', thinking: '理解中…', executing: '执行中…', reply: '已回复', error: '异常（文本仍可用）' };
    var pc = status.enabled ? 'PC 常驻监听中' : 'PC 未开启语音';
    setStatus(pc + (status.enabled ? ' · 🟢 ' : ' · ⚪ ') + (stateMap[status.state] || status.state) + ' · ASR ' + ((status.providers || {}).asr || '—') + ' · 模型 ' + ((status.providers || {}).llm || '—'), status.state === 'error' || (status.providers || {}).asr === 'unavailable');
    setOrb(status.enabled && ['listening', 'session', 'wake', 'thinking', 'executing'].indexOf(status.state) >= 0);
    var summary = $('#m-today-summary');
    if (summary) {
      var c = status.counters || {};
      var wake = status.lastWake ? '最近唤醒 ' + String(status.lastWake.word || '') : '今天还没有唤醒';
      var reply = status.lastReply ? ' · 最近回复：' + String(status.lastReply.text || '').slice(0, 24) : '';
      summary.textContent = '今日语音 ' + (c.transcripts || 0) + ' 条 · 命令 ' + (c.commands || 0) + ' 条 · ' + wake + reply;
    }
    var cap = $('#m-voice-caption');
    if (cap && status.lastReply) cap.textContent = '💬 ' + String(status.lastReply.text || '').slice(0, 80);
  }
  function load() {
    req('GET', '/api/v2/voice/status').then(function (r) {
      if (r.ok && r.data) render(r.data);
      else if (r.status === 404) render(null);
      else render(null);
    }).catch(function () { render(null); });
  }
  function toggleVoice() {
    var enabled = !!(last && last.enabled);
    var path = enabled ? '/api/v2/voice/stop' : '/api/v2/voice/start';
    req('POST', path, {}).then(function (r) {
      if (r.status === 401) { toast('需要操作令牌：先到 /m-live.html 或桌面 #/voice 保存一次'); return; }
      if (!r.ok) { toast('语音开关失败：' + ((r.data && r.data.error) || r.status)); return; }
      toast(enabled ? '已关闭语音' : '已开启：说「榫卯」唤醒');
      setTimeout(load, 600);
    }).catch(function () { toast('无法连接中枢'); });
  }
  function connectSse() {
    try {
      var es = new EventSource('/api/v2/voice/stream');
      es.onmessage = function (ev) {
        var d = null;
        try { d = JSON.parse(ev.data); } catch (_) {}
        if (!d) return;
        var cap = $('#m-voice-caption');
        if (d.type === 'wake' && cap) { cap.textContent = '🔔 已唤醒：' + (d.word || ''); setOrb(true); }
        else if (d.type === 'transcript' && cap) { cap.textContent = (d.wake ? '🔔 ' : '') + (d.text || ''); }
        else if (d.type === 'partial' && cap) { cap.textContent = '…' + (d.text || ''); }
        else if (d.type === 'reply') { if (cap) cap.textContent = '💬 ' + (d.text || ''); setTimeout(load, 800); }
        else if (d.type === 'status' || d.type === 'status_snapshot') { setTimeout(load, 300); }
      };
      es.onerror = function () { try { es.close(); } catch (_) {} setTimeout(connectSse, 5000); };
    } catch (_) {}
  }
  function init() {
  function renderDiary(d) {
    var content = document.getElementById('m-diary-content');
    var provider = document.getElementById('m-diary-provider');
    if (!content) return;
    if (!d || !d.exists) {
      content.textContent = '今天的总结还没生成：点下面「生成今日总结」，或每晚由电脑自动生成。';
      if (provider) provider.textContent = '未生成';
      return;
    }
    var md = String(d.markdown || '');
    var pm = md.match(/<!-- provider=([A-Za-z0-9_-]+)/);
    if (provider) provider.textContent = pm ? pm[1] : 'unknown';
    var clean = md.replace(/<!--[\s\S]*?-->/g, '').replace(/^#\s+.*$/m, '').trim();
    content.textContent = clean.slice(0, 700) + (clean.length > 700 ? '…' : '');
  }
  function loadDiary() {
    req('GET', '/api/v2/voice/diary').then(function (r) { if (r.ok && r.data) renderDiary(r.data); }).catch(function () {});
  }
  function generateDiary() {
    var btn = document.getElementById('m-diary-generate');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    req('POST', '/api/v2/voice/diary/generate', {}).then(function (r) {
      if (btn) { btn.disabled = false; btn.textContent = '生成今日总结'; }
      if (r.status === 401) { toast('需要操作令牌：先到 /m-live.html 保存一次'); return; }
      if (!r.ok) { toast('生成失败：' + ((r.data && r.data.error) || r.status)); return; }
      toast('今日总结已生成');
      loadDiary();
    }).catch(function () { if (btn) { btn.disabled = false; btn.textContent = '生成今日总结'; } toast('无法连接中枢'); });
  }
    load();
    loadDiary();
    var diaryBtn = document.getElementById('m-diary-generate');
    if (diaryBtn) diaryBtn.addEventListener('click', generateDiary);
    setInterval(load, 12000);
    var orb = $('#m-voice-orb');
    if (orb) orb.addEventListener('click', toggleVoice);
    connectSse();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
