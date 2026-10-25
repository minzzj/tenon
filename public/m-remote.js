/* 榫卯 Tenon v3 · 手机遥控电脑（/m/remote）
 * 触控板（pointer 单指移动 / 轻点左键 / 双指滚动）、键盘（文字 + 常用组合键）、媒体/音量、常用程序一键启动。
 * 真实调用 /api/v2/remote/*（node-agent 在电脑上真实执行 SendInput/CoreAudio），失败显示下一步，不假装成功。 */
(function () {
  'use strict';
  var TOKEN_KEY = 'tenon:token';
  var state = {
    token: '',
    devices: [],
    deviceId: '',
    status: null,
    moveAcc: { dx: 0, dy: 0, timer: null },
    busy: false,
    lastError: '',
  };

  function $(sel) { return document.querySelector(sel); }
  function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (_) {} }
  function toast(msg, kind) {
    var root = $('#m-toast');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (kind === 'ok' ? 'toast-ok' : kind === 'warn' ? 'toast-warn' : 'toast-bad');
    el.innerHTML = '<span class="toast-icon">' + (kind === 'ok' ? '✓' : '!') + '</span><span>' + esc(msg) + '</span>';
    root.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    if (opts.token) headers['x-tenon-token'] = opts.token;
    else if (state.token) headers['x-tenon-token'] = state.token;
    var body = null;
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: body, credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        var ct = (res.headers && res.headers.get('content-type')) || '';
        var p = ct.indexOf('json') >= 0 ? res.json().catch(function () { return null; }) : res.text().catch(function () { return null; });
        return p.then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .catch(function (err) { return { ok: false, status: 0, network: true, error: String((err && err.message) || err) }; });
  }
  function needToken() {
    $('#remote-token-card').classList.remove('hidden');
    var input = $('#remote-token-input');
    if (input) input.focus();
  }
  function currentDevice() {
    for (var i = 0; i < state.devices.length; i++) if (state.devices[i].id === state.deviceId) return state.devices[i];
    return null;
  }
  function setStatusText(text, kind) {
    var el = $('#remote-status');
    if (el) { el.textContent = text; el.className = 'tiny ' + (kind === 'ok' ? 'm-ok' : kind === 'warn' ? 'm-warn' : kind === 'bad' ? 'm-bad' : 'dim'); }
  }
  function renderDevices() {
    var sel = $('#remote-device');
    if (!sel) return;
    var options = state.devices.map(function (d) {
      var tags = [];
      if (!d.bound) tags.push('未绑定');
      if (!d.online) tags.push('离线');
      return '<option value="' + esc(d.id) + '"' + (d.id === state.deviceId ? ' selected' : '') + '>' + esc(d.name || d.id) + (tags.length ? '（' + tags.join('·') + '）' : '') + '</option>';
    });
    sel.innerHTML = options.length ? options.join('') : '<option value="">没有可遥控的电脑（先在 #/devices 绑定并启动 node-agent）</option>';
    if (!state.deviceId && state.devices.length) {
      var pick = null;
      for (var i = 0; i < state.devices.length; i++) if (state.devices[i].bound && state.devices[i].online) { pick = state.devices[i]; break; }
      state.deviceId = (pick || state.devices[0]).id;
      sel.value = state.deviceId;
    }
    var dev = currentDevice();
    if (!dev) {
      setStatusText('没有可遥控的电脑：请先在电脑端「我的设备」绑定，并启动 node-agent（TENON_V2=1）', 'warn');
      return;
    }
    if (!dev.bound) setStatusText('「' + (dev.name || dev.id) + '」尚未绑定：回到电脑端 #/devices 点「一键绑定」', 'warn');
    else if (!dev.online) setStatusText('「' + (dev.name || dev.id) + '」离线：确认电脑 node-agent 在线', 'warn');
    else setStatusText('已连接「' + (dev.name || dev.id) + '」· 就绪', 'ok');
  }
  function loadDevices() {
    return api('/api/v2/remote/devices').then(function (res) {
      if (!res.ok || !res.data || !Array.isArray(res.data.devices)) {
        toast('无法读取可遥控设备：' + ((res.data && res.data.error) || ('HTTP ' + res.status)), 'bad');
        return null;
      }
      state.devices = res.data.devices;
      var query = new URLSearchParams(location.search);
      var wanted = query.get('device') || '';
      if (wanted && state.devices.some(function (d) { return d.id === wanted; })) state.deviceId = wanted;
      renderDevices();
      return res.data;
    });
  }
  function refreshStatus() {
    var dev = currentDevice();
    if (!dev) return Promise.resolve();
    return api('/api/v2/remote/' + encodeURIComponent(dev.id) + '/status').then(function (res) {
      var asof = $('#remote-asof');
      if (!res.ok || !res.data || !res.data.ok) {
        setStatusText('状态读取失败：' + ((res.data && res.data.error) || ('HTTP ' + res.status)), 'bad');
        if (asof) asof.textContent = '未连接';
        return;
      }
      state.status = res.data;
      if (asof) asof.textContent = '已连接 ' + new Date().toLocaleTimeString();
      var latency = $('#remote-latency');
      if (latency) latency.textContent = res.data.latencyMs == null ? '延迟待测' : (res.data.latencyMs + ' ms');
      var queue = res.data.queue && res.data.queue.length ? res.data.queue[0] : null;
      var devInfo = res.data.device;
      var text = '已连接「' + devInfo.name + '」';
      if (queue) text += ' · 最近遥控 ' + queue.status + (queue.summary ? '：' + queue.summary : '');
      setStatusText(text, devInfo.online ? 'ok' : 'warn');
      var appsBox = $('#remote-apps');
      var apps = (res.data.device.programs && res.data.device.programs.length) ? res.data.device.programs : [];
      if (appsBox && apps.length) {
        appsBox.innerHTML = apps.map(function (a) {
          return '<button class="btn btn-sm" data-remotectl="app" data-app="' + esc(a.app || a.name) + '" data-testid="m-remote-app-' + esc(a.id || a.name) + '">' + esc(a.name) + '</button>';
        }).join('');
      }
    });
  }
  function send(type, payload) {
    var dev = currentDevice();
    if (!dev) { toast('先选择一台电脑', 'warn'); return Promise.resolve(null); }
    if (!state.token) { needToken(); toast('遥控需要操作令牌（电脑端启动日志里）', 'warn'); return Promise.resolve(null); }
    if (state.busy) return Promise.resolve(null);
    state.busy = true;
    return api('/api/v2/remote/' + encodeURIComponent(dev.id) + '/input', {
      method: 'POST',
      token: state.token,
      body: { type: type, payload: payload },
    }).then(function (res) {
      state.busy = false;
      if (res.status === 401) { setToken(''); state.token = ''; needToken(); toast('令牌无效，请重新输入', 'bad'); return null; }
      if (!res.ok || !res.data || res.data.ok === false) {
        var msg = (res.data && res.data.error) || ('HTTP ' + res.status);
        toast('遥控失败：' + msg, 'bad');
        setStatusText('遥控失败：' + msg, 'bad');
        return null;
      }
      return res.data;
    });
  }
  function flushMove() {
    var acc = state.moveAcc;
    acc.timer = null;
    var dx = Math.round(acc.dx);
    var dy = Math.round(acc.dy);
    acc.dx = 0;
    acc.dy = 0;
    if (!dx && !dy) return;
    send('mouse', { action: 'move', dx: Math.max(-600, Math.min(600, dx)), dy: Math.max(-600, Math.min(600, dy)) });
  }
  function queueMove(dx, dy) {
    var acc = state.moveAcc;
    acc.dx += dx;
    acc.dy += dy;
    if (!acc.timer) acc.timer = setTimeout(flushMove, 40);
  }
  function bindPad() {
    var pad = $('#remote-pad');
    if (!pad) return;
    var drag = null;
    pad.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      drag = { x: ev.clientX, y: ev.clientY, lastX: ev.clientX, lastY: ev.clientY, moved: 0, startAt: Date.now() };
      try { pad.setPointerCapture(ev.pointerId); } catch (_) {}
      pad.classList.add('active');
    });
    pad.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.lastX;
      var dy = ev.clientY - drag.lastY;
      drag.lastX = ev.clientX;
      drag.lastY = ev.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (dx || dy) queueMove(dx, dy);
      ev.preventDefault();
    });
    function endDrag(ev) {
      if (!drag) return;
      var d = drag;
      drag = null;
      pad.classList.remove('active');
      var quick = Date.now() - d.startAt < 380;
      if (d.moved < 10 && quick) send('mouse', { action: 'click', button: 'left' });
    }
    pad.addEventListener('pointerup', endDrag);
    pad.addEventListener('pointercancel', endDrag);
    pad.addEventListener('pointerleave', endDrag);
    // 双指滚动（touch 事件）
    var two = null;
    pad.addEventListener('touchstart', function (ev) {
      if (ev.touches.length === 2) {
        two = { y: (ev.touches[0].clientY + ev.touches[1].clientY) / 2, acc: 0 };
        ev.preventDefault();
      }
    }, { passive: false });
    pad.addEventListener('touchmove', function (ev) {
      if (!two || ev.touches.length !== 2) return;
      var y = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
      two.acc += (two.y - y);
      two.y = y;
      if (Math.abs(two.acc) >= 24) {
        var delta = two.acc > 0 ? 120 : -120;
        two.acc = 0;
        send('mouse', { action: 'wheel', delta: delta });
      }
      ev.preventDefault();
    }, { passive: false });
    pad.addEventListener('touchend', function (ev) {
      if (ev.touches.length < 2) two = null;
    });
  }
  function bindActions() {
    document.addEventListener('click', function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-remotectl]') : null;
      if (!el) return;
      ev.preventDefault();
      var act = el.getAttribute('data-remotectl');
      var ds = el.dataset || {};
      if (act === 'refresh') { loadDevices().then(refreshStatus); return; }
      if (act === 'save-token') {
        var input = $('#remote-token-input');
        var tok = input ? String(input.value || '').trim() : '';
        if (!tok) { toast('先输入操作令牌', 'warn'); return; }
        setToken(tok); state.token = tok;
        $('#remote-token-card').classList.add('hidden');
        toast('令牌已保存，可以遥控了', 'ok');
        refreshStatus();
        return;
      }
      if (act === 'click') { send('mouse', { action: 'click', button: ds.button || 'left' }); return; }
      if (act === 'wheel') { send('mouse', { action: 'wheel', delta: Number(ds.delta) || 120 }); return; }
      if (act === 'send-text') {
        var textEl = $('#remote-text');
        var text = textEl ? String(textEl.value || '') : '';
        if (!text) { toast('先输入要发送的文字', 'warn'); return; }
        send('key', { text: text }).then(function (r) { if (r && textEl) textEl.value = ''; });
        return;
      }
      if (act === 'combo') { send('key', { combo: ds.combo }); return; }
      if (act === 'media') { send('media', { action: ds.media }); return; }
      if (act === 'app') { send('app', { app: ds.app }); return; }
    });
    var sel = $('#remote-device');
    if (sel) sel.addEventListener('change', function () { state.deviceId = sel.value; refreshStatus(); renderDevices(); });
  }
  function init() {
    state.token = getToken();
    if (!state.token) needToken();
    bindPad();
    bindActions();
    loadDevices().then(refreshStatus);
    setInterval(refreshStatus, 3000);
    setInterval(function () { if (state.devices.length) loadDevices(); }, 15000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshStatus(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();