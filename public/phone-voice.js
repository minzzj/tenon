/* 榫卯 V3 · 手机语音输入（真实链路）：手机麦克风 → 电脑本地 FunASR → DeepSeek 规划 → Agent 执行 → 回显/播放回复
 * 依赖 /api/v2/voice/transcribe（multipart file）、/command、/confirm、/reply-audio；令牌 localStorage['tenon:token'] */
(function () {
  'use strict';
  var TOKEN_KEY = 'tenon:token';
  var st = { rec: false, busy: false, media: null, chunks: [], rec2: null };
  function tok() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function $(id) { return document.getElementById(id); }
  function mk(tag, attrs, html) { var e = document.createElement(tag); if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }
  function toast(msg, kind, dur) {
    try { if (typeof window.toast === 'function') { window.toast(msg, kind || 'ok', dur || 3600); return; } } catch (e) {}
    var d = $('phone-voice-toast'); if (!d) { d = mk('div', { id: 'phone-voice-toast' }); document.body.appendChild(d); }
    d.className = 'pv-toast ' + (kind || 'ok'); d.textContent = msg; d.style.display = 'block';
    clearTimeout(d._t); d._t = setTimeout(function () { d.style.display = 'none'; }, dur || 3600);
  }
  function styles() {
    if ($('phone-voice-style')) return;
    document.head.appendChild(mk('style', { id: 'phone-voice-style' }, [
      '#phone-voice-card{position:fixed;left:12px;right:12px;bottom:84px;z-index:9999;background:rgba(10,14,20,.96);border:1px solid rgba(120,200,255,.35);border-radius:16px;padding:14px 16px;color:#eaf6ff;font-size:15px;line-height:1.5;display:none;box-shadow:0 12px 40px rgba(0,0,0,.5)}',
      '#phone-voice-card .pv-cap{font-size:13px;color:#7fd3ff;margin-bottom:6px}',
      '#phone-voice-card .pv-say{font-size:19px;font-weight:600;margin-bottom:8px}',
      '#phone-voice-card .pv-meta{font-size:13px;color:#9fb4c8;margin-top:4px}',
      '#phone-voice-card .pv-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
      '#phone-voice-card button{border:1px solid rgba(140,210,255,.45);background:rgba(30,90,140,.5);color:#eaf6ff;border-radius:10px;padding:8px 14px;font-size:14px}',
      '#phone-voice-card button.primary{background:#1f6feb;border-color:#1f6feb}',
      '#pv-btn{position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:9998;width:76px;height:76px;border-radius:50%;border:2px solid rgba(120,200,255,.5);background:radial-gradient(circle at 35% 30%,#2b5f92,#0c1724);color:#fff;font-size:30px;box-shadow:0 8px 30px rgba(30,120,220,.45)}',
      '#pv-btn[data-recording="1"]{background:radial-gradient(circle at 35% 30%,#e05656,#7a1111);border-color:#ff9a9a;animation:pv-pulse 1s infinite}',
      '@keyframes pv-pulse{0%{box-shadow:0 0 0 0 rgba(255,80,80,.55)}70%{box-shadow:0 0 0 26px rgba(255,80,80,0)}100%{box-shadow:0 0 0 0 rgba(255,80,80,0)}}',
      '.pv-toast{position:fixed;left:12px;right:12px;top:16px;z-index:10000;background:#16324a;color:#eaf6ff;border:1px solid #2b6c9a;border-radius:12px;padding:10px 14px;font-size:14px;display:none}',
      '.pv-toast.bad{background:#4a1a1a;border-color:#9a2b2b}'
    ].join('\n')));
  }
  function showCard(cap, say, meta, actions) {
    styles();
    var c = $('phone-voice-card');
    if (!c) { c = mk('div', { id: 'phone-voice-card', 'data-testid': 'phone-voice-card' }); document.body.appendChild(c); }
    c.style.display = 'block';
    c.innerHTML = '<div class="pv-cap">' + (cap || '') + '</div><div class="pv-say">' + (say || '') + '</div><div class="pv-meta">' + (meta || '') + '</div><div class="pv-actions"></div>';
    var box = c.querySelector('.pv-actions');
    (actions || []).forEach(function (a) { var b = mk('button', { class: a.primary ? 'primary' : '', 'data-testid': a.testid || 'pv-action' }, a.label); b.onclick = a.onClick; box.appendChild(b); });
  }
  function hideCard() { var c = $('phone-voice-card'); if (c) c.style.display = 'none'; }
  function setRec(on) { var b = $('pv-btn'); if (b) b.setAttribute('data-recording', on ? '1' : '0'); }
  function ensureUi() {
    styles();
    if (!$('pv-btn')) {
      var b = mk('button', { id: 'pv-btn', 'data-testid': 'phone-voice-btn', title: '手机说一句（电脑本地识别）' }, '🎙');
      b.onclick = function () { st.rec ? stop() : start(); };
      document.body.appendChild(b);
    }
    document.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== document) {
        var tid = t.id || '';
        var testid = t.getAttribute ? (t.getAttribute('data-testid') || '') : '';
        if (tid === 'm-voice' || testid === 'm-voice-orb' || testid === 'm-voice') {
          e.preventDefault(); e.stopImmediatePropagation();
          st.rec ? stop() : start();
          return;
        }
        t = t.parentNode;
      }
    }, true);
  }
  async function start() {
    if (st.busy) { toast('上一句还在处理，请稍等', 'warn'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('浏览器不支持录音（需要允许麦克风）', 'bad', 5000); return; }
    if (typeof MediaRecorder === 'undefined') { toast('浏览器不支持录音（MediaRecorder）', 'bad', 5000); return; }
    try { st.media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { toast('无法使用麦克风：' + (e && e.message || e) + '（请允许权限）', 'bad', 6000); return; }
    var mime = '';
    ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].forEach(function (m) { if (!mime && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) mime = m; });
    try { st.rec2 = mime ? new MediaRecorder(st.media, { mimeType: mime }) : new MediaRecorder(st.media); }
    catch (e) { toast('录音初始化失败：' + (e && e.message || e), 'bad'); return; }
    st.chunks = [];
    st.rec2.ondataavailable = function (ev) { if (ev.data && ev.data.size) st.chunks.push(ev.data); };
    st.rec2.onstop = function () {
      try { st.media.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      var blob = new Blob(st.chunks, { type: st.rec2.mimeType || mime || 'audio/webm' });
      st.chunks = []; st.rec = false; setRec(false);
      if (blob.size < 800) { toast('录音太短，再说一句', 'warn'); return; }
      handleAudio(blob);
    };
    try { st.rec2.start(200); } catch (e) { toast('开始录音失败：' + (e && e.message || e), 'bad'); return; }
    st.rec = true; setRec(true);
    showCard('🎙 正在录音 · 再点一下结束', '请说，例如「打开记事本」「把音量调到 60」', '', []);
  }
  function stop() { if (st.rec2 && st.rec) { try { st.rec2.stop(); } catch (e) { st.rec = false; setRec(false); } } }
  async function handleAudio(blob) {
    st.busy = true;
    var ext = /mp4|aac/.test(blob.type) ? 'm4a' : (/ogg/.test(blob.type) ? 'ogg' : 'webm');
    showCard('电脑本地识别中…（音频只在你的电脑处理）', '识别中…', '', []);
    try {
      var fd = new FormData(); fd.append('file', blob, 'phone.' + ext); fd.append('audio', blob, 'phone.' + ext);
      var r = await fetch('/api/v2/voice/transcribe', { method: 'POST', body: fd, headers: { 'x-tenon-token': tok() }, credentials: 'same-origin' });
      if (r.status === 401 || r.status === 423) { showCard('需要操作令牌', '请在设置里填写操作令牌', '在手机设置页/桌面 #/voice 保存一次即可', [{ label: '知道了', primary: true, onClick: hideCard }]); return; }
      var j = await r.json().catch(function () { return {}; });
      if (!j.ok || !(j.text || '').trim()) { showCard('本地识别完成', '没听清，再说一次或改用文字输入', 'provider=' + (j.provider || '') + ' · ' + (j.ms || '') + 'ms', [{ label: '关闭', onClick: hideCard }]); return; }
      showCard('本地识别：' + (j.provider || 'funasr') + ' · ' + (j.ms || '?') + 'ms', j.text, '正在交给电脑理解…', [{ label: '取消', onClick: hideCard }]);
      await sendCommand(j.text);
    } catch (e) {
      showCard('连接电脑失败', '请确认手机和电脑同一 WiFi、中枢地址正确', String(e && e.message || e), [{ label: '关闭', onClick: hideCard }]);
    } finally { st.busy = false; }
  }
  async function sendCommand(text) {
    showCard('电脑理解中（DeepSeek）· 然后执行', text, '', []);
    var r = await fetch('/api/v2/voice/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tenon-token': tok() }, credentials: 'same-origin', body: JSON.stringify({ text: text }) });
    if (r.status === 401 || r.status === 423) { showCard('需要操作令牌', '请在设置里填写操作令牌', '', [{ label: '关闭', onClick: hideCard }]); return; }
    var j = await r.json().catch(function () { return {}; });
    var steps = (j.steps || []).map(function (s) { return (s.status === 'succeeded' || s.status === 'dispatched' ? '✅ ' : (s.status === 'failed' ? '❌ ' : '⏳ ')) + (s.label || ''); }).join('　');
    var meta = (j.provider ? '理解：' + j.provider : '') + (j.latencyMs ? ' · ' + j.latencyMs + 'ms' : '') + (steps ? '<br>' + steps : '');
    if (j.needConfirm) {
      showCard('⚠ 需要你确认（不可逆动作）', j.say || '这个动作不可逆，确认后执行', meta, [
        { label: '确认执行', primary: true, testid: 'pv-confirm', onClick: function () { confirmRun(j, text); } },
        { label: '取消', onClick: hideCard }
      ]);
      return;
    }
    var actions = [{ label: '关闭', onClick: hideCard }];
    if (j.audio && j.audio.url) actions.unshift({ label: '🔊 播放语音', onClick: function () { playAudio(j.audio.url); } });
    showCard(j.ok === false ? '部分未完成' : '已执行', j.say || '完成', meta, actions);
    if (j.audio && j.audio.url) playAudio(j.audio.url);
  }
  async function confirmRun(j, text) {
    showCard('确认中…', '正在执行', '', []);
    var payload = { confirmed: true, text: text, yes: true, confirmId: j.confirmId || null };
    var r = null;
    try { r = await fetch('/api/v2/voice/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tenon-token': tok() }, credentials: 'same-origin', body: JSON.stringify(payload) }); } catch (e) { r = null; }
    if (!r || r.status === 404 || r.status === 405) {
      r = await fetch('/api/v2/voice/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tenon-token': tok() }, credentials: 'same-origin', body: JSON.stringify({ text: text, confirmed: true }) });
    }
    var j2 = await r.json().catch(function () { return {}; });
    if (j2.already) { showCard('已处理过', j2.message || '已执行/已取消，无需再次确认', '', [{ label: '关闭', onClick: hideCard }]); return; }
    var steps = (j2.steps || []).map(function (s) { return (s.status === 'succeeded' || s.status === 'dispatched' ? '✅ ' : (s.status === 'failed' ? '❌ ' : '⏳ ')) + (s.label || ''); }).join('　');
    showCard(j2.ok === false ? '未完成' : '已确认并执行', j2.say || j2.message || '完成', (steps || ''), [{ label: '关闭', onClick: hideCard }]);
    if (j2.audio && j2.audio.url) playAudio(j2.audio.url);
  }
  function playAudio(url) {
    try { fetch(url, { headers: { 'x-tenon-token': tok() }, credentials: 'same-origin' }).then(function (r) { return r.blob(); }).then(function (b) { var a = new Audio(URL.createObjectURL(b)); a.play().catch(function () {}); }).catch(function () {}); } catch (e) {}
  }
  function mount() { try { ensureUi(); } catch (e) { console.error('[phone-voice]', e); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.TenonPhoneVoice = { start: start, stop: stop, send: sendCommand, state: st };
})();
