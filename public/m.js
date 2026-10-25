/* 榫卯 Tenon v0.1 · 手机页 /m
 * 一句话 → 五段草案（任务草案 / 用到的能力 / 目标设备 / 缺失项 / 风险等级）→ 确认 / 拒绝 → 最近回执。
 * 断网：读 localStorage 快照显示设备卡与任务历史，横幅标「数据截至 HH:mm」，禁写。 */
(function () {
  'use strict';

  window.__tenonErrors = [];
  window.addEventListener('error', function (e) {
    try { window.__tenonErrors.push(String((e && e.message) || e || 'error')); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    try { window.__tenonErrors.push('unhandledrejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || '')); } catch (_) {}
  });

  var TOKEN_KEY = 'tenon:token';
  var CACHE_KEY = 'tenon:m-cache';
  var STATUS = {
    draft: ['草案', 'b-muted'], pending: ['待确认', 'b-warn'], queued: ['排队中', 'b-info'], running: ['执行中', 'b-info'],
    succeeded: ['已完成', 'b-ok'], failed: ['失败', 'b-bad'], timeout: ['超时', 'b-warn'], cancelled: ['已取消', 'b-muted'],
    delivered: ['已送达', 'b-ok'], undelivered: ['未送达', 'b-warn'], limited: ['限流', 'b-warn']
  };
  var S = {
    state: null,
    stale: false,
    cachedAt: 0,
    dataAsOf: null,
    draft: null,
    busy: false,
    apiBusy: false,
    lastSig: null
  };

  function $(sel) { return document.querySelector(sel); }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function toDate(v) { if (!v) return null; var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function hhmm(v) { var d = toDate(v); return d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '--:--'; }
  function dateOf(v) {
    var d = toDate(v);
    if (!d) return '—';
    var now = new Date();
    var same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return (same ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + hhmm(d);
  }
  function statusBadge(st) {
    var m = STATUS[st] || [st || '未知', 'b-muted'];
    return '<span class="badge no-dot ' + m[1] + '">' + esc(m[0]) + '</span>';
  }
  function listOf(v) { return Array.isArray(v) ? v : []; }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (_) {} }
  function saveCache(state) {
    try {
      var payload = {
        at: Date.now(),
        dataAsOf: state.dataAsOf || null,
        nodes: listOf(state.nodes),
        tasks: listOf(state.tasks).slice(0, 12),
        messages: listOf(state.messages).slice(0, 8),
        domainLabel: state.domainLabel || '',
        mode: state.mode || ''
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }
  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : null;
    } catch (_) { return null; }
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    var token = opts.token !== undefined ? opts.token : getToken();
    if (token) headers['x-tenon-token'] = token;
    var body;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      try { body = JSON.stringify(opts.body); } catch (_) { body = '{}'; }
    }
    return fetch(path, {
      method: opts.method || 'GET', headers: headers, body: body,
      credentials: 'same-origin', cache: 'no-store'
    }).then(function (res) {
      var ct = (res.headers && res.headers.get('content-type')) || '';
      var p = ct.indexOf('json') >= 0 ? res.json().catch(function () { return null; }) : res.text().catch(function () { return null; });
      return p.then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    }).catch(function (err) {
      return { ok: false, status: 0, network: true, error: String((err && err.message) || err) };
    });
  }

  function toast(msg, kind) {
    var root = $('#m-toast');
    if (!root) {
      root = document.createElement('div');
      root.id = 'm-toast';
      root.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:99;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;width:calc(100% - 32px);max-width:400px';
      document.body.appendChild(root);
    }
    var el = document.createElement('div');
    el.className = 'toast ' + (kind === 'ok' ? 'toast-ok' : kind === 'warn' ? 'toast-warn' : kind === 'bad' ? 'toast-bad' : '');
    el.style.pointerEvents = 'auto';
    el.innerHTML = '<span class="toast-icon">' + (kind === 'ok' ? '✓' : kind === 'warn' ? '!' : kind === 'bad' ? '×' : '·') + '</span><span>' + esc(msg) + '</span>';
    root.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3800);
  }

  function asOfLabel() {
    var src = S.dataAsOf || (S.cachedAt ? new Date(S.cachedAt).toISOString() : null);
    if (!src) return '数据截至 --:--';
    var d = toDate(src);
    if (!d) return '数据截至 --:--';
    var now = new Date();
    var same = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var body = same ? hhmm(d) : ((d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm(d));
    return '数据截至 ' + body + (S.stale ? '（缓存）' : '');
  }

  function applyState(state) {
    S.state = state;
    S.dataAsOf = state.dataAsOf || null;
    saveCache(state);
  }
  function applyCache() {
    var c = loadCache();
    if (!c) return false;
    S.state = { nodes: c.nodes || [], tasks: c.tasks || [], messages: c.messages || [], domainLabel: c.domainLabel || '', mode: c.mode || '' };
    S.cachedAt = c.at || 0;
    S.dataAsOf = c.dataAsOf || null;
    return true;
  }

  function load() {
    if (S.apiBusy) return Promise.resolve();
    S.apiBusy = true;
    return api('/api/state').then(function (res) {
      S.apiBusy = false;
      if (res.ok && res.data && typeof res.data === 'object' && !res.data.error) {
        S.stale = false;
        applyState(res.data);
        renderAll();
      } else {
        S.stale = true;
        if (!S.state) applyCache();
        renderAll();
      }
    });
  }

  function isOffline() { return S.stale; }
  function denyOffline() {
    toast(asOfLabel() + ' · 离线只读，等中枢恢复后再试', 'warn');
  }

  /* ---------- 渲染（列表只在实质变化时重建，避免按钮/链接被 detach） ---------- */
  function listSig(state) {
    var parts = [];
    parts.push('n:' + listOf(state.nodes).map(function (n) {
      return [n.id, n.online ? 1 : 0, n.disconnected ? 1 : 0, n.hidden ? 1 : 0, n.evidence || ''].join(':');
    }).sort().join('|'));
    parts.push('t:' + listOf(state.tasks).map(function (t) { return [t.id, t.status].join(':'); }).join('|'));
    parts.push('m:' + listOf(state.messages).map(function (m) { return [m.id, m.status].join(':'); }).join('|'));
    return parts.join('||');
  }
  function renderAll(force) {
    var state = S.state || {};
    var nodes = listOf(state.nodes);
    var tasks = listOf(state.tasks);
    var messages = listOf(state.messages);

    var asof = $('#m-asof');
    if (asof) asof.textContent = asOfLabel();
    var banner = $('#m-offline-banner');
    var offlineNote = $('#m-offline-note');
    if (S.stale) {
      if (banner) {
        banner.classList.remove('hidden');
        var txt = $('#m-offline-text');
        if (txt) txt.textContent = asOfLabel() + ' · 无法连接中枢，显示本机缓存（只读）';
      }
      if (offlineNote) offlineNote.classList.remove('hidden');
    } else {
      if (banner) banner.classList.add('hidden');
      if (offlineNote) offlineNote.classList.add('hidden');
    }
    var send = $('#m-send');
    if (send) {
      send.disabled = S.stale || S.busy;
      send.textContent = S.busy ? '发送中…' : (S.stale ? '离线只读' : '交给电脑');
    }
    var input = $('#m-input');
    if (input) input.disabled = false;

    var sig = listSig(state);
    if (!force && sig === S.lastSig) { renderDraftButtons(); return; }
    S.lastSig = sig;
    renderDevices(nodes);
    renderReceipts(messages);
    renderTasks(tasks);
    renderDraftButtons();
  }

  function renderDevices(nodes) {
    var box = $('#m-devices');
    var count = $('#m-device-count');
    if (count) count.textContent = String(nodes.length);
    if (!box) return;
    if (!nodes.length) {
      box.innerHTML = '<div class="m-receipt"><div class="sum muted">连接中枢后显示设备卡；断网时显示本机缓存。</div></div>';
      return;
    }
    box.innerHTML = nodes.map(function (n) {
      var caps = listOf(n.capabilities);
      var online = n.online && !n.disconnected;
      var outside = n.domain === 'outside' || n.readOnly;
      return '<div class="m-device" data-testid="m-device-card" data-node-id="' + esc(n.id) + '">' +
        '<span class="online-dot ' + (online ? 'on' : 'off') + '"></span>' +
        '<div style="min-width:0"><div class="nm">' + esc(n.name || n.id) + '</div>' +
        '<div class="sub">' + caps.length + ' 项能力 · ' + esc(n.platform || '未知平台') + (n.hidden ? ' · 隐身' : '') + (outside ? ' · 域外仅可查看' : '') + '</div></div>' +
        '<div class="right">' + (n.disconnected ? '<span class="badge no-dot b-muted">已断开</span>' : online ? '<span class="badge no-dot b-ok">在线</span>' : '<span class="badge no-dot b-bad">离线</span>') + '</div></div>';
    }).join('');
  }
  function renderReceipts(messages) {
    var box = $('#m-receipts');
    var count = $('#m-receipt-count');
    if (count) count.textContent = String(messages.length);
    if (!box) return;
    if (!messages.length) {
      box.innerHTML = '<div class="m-receipt"><div class="sum muted">任务完成后，这里只显示摘要与链接，正文不出内网。</div></div>';
      return;
    }
    box.innerHTML = messages.slice(0, 6).map(function (m) {
      var link = m.link || (m.taskId ? '/r/' + m.taskId : '');
      return '<div class="m-receipt" data-testid="m-receipt">' +
        '<div class="top">' + statusBadge(m.status) + '<span>' + esc(m.title || '任务回执') + '</span>' +
        '<span style="margin-left:auto" class="badge no-dot b-muted">' + esc(m.channelLabel || m.channel || '通道') + '</span></div>' +
        '<div class="sum">' + esc(m.summary || '（无摘要）') + '</div>' +
        '<div class="foot">' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener">查看回执</a>' : '<span>无链接</span>') +
        '<span>' + esc(dateOf(m.at)) + '</span>' + (m.sensitive ? '<span class="sensitive">已脱敏</span>' : '') + '</div></div>';
    }).join('');
  }
  function renderTasks(tasks) {
    var box = $('#m-tasks');
    var count = $('#m-task-count');
    if (count) count.textContent = String(tasks.length);
    if (!box) return;
    if (!tasks.length) {
      box.innerHTML = '<div class="m-receipt"><div class="sum muted">还没有任务：在上面说一句话生成草案。</div></div>';
      return;
    }
    box.innerHTML = tasks.slice(0, 8).map(function (t) {
      var summary = (t.draft && t.draft.summary) || t.text || t.id;
      return '<div class="m-receipt" data-testid="m-task-row" data-task-id="' + esc(t.id) + '">' +
        '<div class="top">' + statusBadge(t.status) + '<span>' + esc(summary) + '</span></div>' +
        '<div class="foot"><span class="mono">' + esc(t.id) + '</span><span>' + esc(dateOf(t.updatedAt || t.createdAt)) + '</span>' +
        ((t.draft && t.draft.risk && t.draft.risk.level === 'irreversible') ? '<span class="tag amber">不可逆</span>' : '') + '</div></div>';
    }).join('');
  }
  function renderDraftButtons() {
    var confirm = $('#m-confirm');
    var reject = $('#m-reject');
    var blocked = !!(S.draft && S.draft.blocked);
    if (confirm) {
      confirm.disabled = !S.draft || blocked || S.busy || S.stale;
      confirm.title = blocked ? '缺参数：先补充缺失项' : '';
    }
    if (reject) reject.disabled = !S.draft || S.busy || S.stale;
  }

  /* ---------- 草案五段 ---------- */
  function renderDraft(data) {
    var draft = (data && data.draft) || {};
    var box = $('#m-draft');
    if (!box) return;
    box.classList.remove('hidden');
    var caps = listOf(draft.capabilities);
    var risk = draft.risk || { level: 'reversible', reasons: [] };
    var missing = listOf(draft.missing);
    var target = draft.targetDevice;
    var idEl = $('#m-draft-id'); if (idEl) idEl.textContent = (data && data.taskId) || '';
    var summaryEl = $('#m-summary'); if (summaryEl) summaryEl.textContent = draft.summary || '（无）';
    var capsEl = $('#m-caps');
    if (capsEl) {
      capsEl.innerHTML = caps.length
        ? caps.map(function (c) { return '<span class="tag cyan">' + esc(c.name || c.id) + '</span>' + (c.manualOnly ? '<span class="tag amber">仅手动</span>' : ''); }).join(' ')
        : '<span style="color:var(--amber)">未匹配到能力：需要补充说明</span>';
    }
    var targetEl = $('#m-target');
    if (targetEl) targetEl.textContent = target ? (target.name || target.id) + '（' + (target.id || '') + '）' : '未知：没有可用设备';
    var missingEl = $('#m-missing');
    if (missingEl) {
      missingEl.innerHTML = missing.length
        ? '<span style="color:var(--amber)">' + missing.map(function (m) { return esc(m); }).join('；') + '</span>'
        : '<span class="dim">无缺失项，参数齐全</span>';
    }
    var riskSeg = $('#m-risk-seg');
    var riskEl = $('#m-risk');
    var riskReasonEl = $('#m-risk-reason');
    var irreversible = risk.level === 'irreversible';
    if (riskSeg) {
      riskSeg.classList.toggle('risk-bad', irreversible);
      riskSeg.classList.toggle('risk-ok', !irreversible);
    }
    if (riskEl) riskEl.innerHTML = irreversible ? '<span class="badge no-dot b-warn">不可逆</span> 需你逐次确认' : '<span class="badge no-dot b-ok">可逆</span> 可直接派发';
    if (riskReasonEl) riskReasonEl.textContent = listOf(risk.reasons).join('；') || '';
    var blockNote = $('#m-block-note');
    if (blockNote) {
      var notes = [];
      if (data && data.blocked) notes.push('缺少参数：' + (missing[0] || '需要补充说明'));
      if (data && data.manualOnly) notes.push('该能力仅手动：需要你在电脑上操作');
      if (data && data.needsConfirm) notes.push('不可逆动作：确认后才会派发');
      if (notes.length) {
        blockNote.classList.remove('hidden');
        blockNote.className = 'm-block-note alert ' + ((data && data.blocked) ? 'alert-warn' : 'alert-info');
        blockNote.innerHTML = notes.map(function (n) { return '<div>' + esc(n) + '</div>'; }).join('');
      } else {
        blockNote.classList.add('hidden');
      }
    }
    var hint = $('#m-draft-hint');
    if (hint) hint.textContent = (data && data.blocked) ? '缺参数不能派发：先补充后再发一句。' : '确认后才会派发；拒绝也记账（原因「未填写」）。';
    renderDraftButtons();
    try { box.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
  }
  function clearDraft() {
    S.draft = null;
    var box = $('#m-draft');
    if (box) box.classList.add('hidden');
    renderDraftButtons();
  }

  /* ---------- 动作 ---------- */
  function showAuthPanel(reason) {
    var panel = $('#m-auth');
    if (!panel) return;
    panel.classList.remove('hidden');
    var err = $('#m-auth-error');
    if (err) { err.textContent = reason || ''; }
    try { $('#m-token').focus(); } catch (_) {}
  }
  function saveToken() {
    var input = $('#m-token');
    var tok = input ? String(input.value || '').trim() : '';
    var err = $('#m-auth-error');
    if (!tok) { if (err) err.textContent = '请输入令牌'; return; }
    if (err) err.textContent = '验证中…';
    api('/api/auth', { method: 'POST', body: { token: tok }, token: tok }).then(function (res) {
      if (res.ok && res.data && res.data.ok !== false) {
        setToken(tok);
        var panel = $('#m-auth');
        if (panel) panel.classList.add('hidden');
        toast('令牌已保存：可以发送任务了', 'ok');
        if (input) input.value = '';
      } else if (res.network) {
        if (err) err.textContent = '无法连接中枢：离线或静态演示模式不能登录。';
      } else {
        if (err) err.textContent = '令牌校验失败（HTTP ' + res.status + '）';
      }
    });
  }
  function send() {
    if (isOffline()) { denyOffline(); return; }
    if (S.busy) return;
    var input = $('#m-input');
    var text = input ? String(input.value || '').trim() : '';
    if (!text) { toast('先说一句要办的事', 'warn'); try { input.focus(); } catch (_) {} return; }
    var tok = getToken();
    if (!tok) {
      showAuthPanel('写操作需要令牌：输入启动日志里的 operatorToken');
      toast('先保存操作令牌，再交给电脑', 'warn');
      return;
    }
    S.busy = true;
    renderAll();
    api('/api/tasks/draft', { method: 'POST', body: { text: text, source: 'phone' }, token: tok }).then(function (res) {
      S.busy = false;
      if (res.status === 401) {
        setToken('');
        showAuthPanel('令牌无效或已过期，请重新输入');
        toast('令牌无效：已清除，请重新输入', 'bad');
        renderAll();
        return;
      }
      if (res.network) {
        S.stale = true;
        renderAll();
        toast('发送失败：无法连接中枢，已切到本机缓存（只读）', 'bad');
        return;
      }
      if (!res.ok || (res.data && res.data.ok === false)) {
        var msg = (res.data && (res.data.error || res.data.message)) || ('HTTP ' + res.status);
        toast('草案生成失败：' + msg, 'bad');
        renderAll();
        return;
      }
      S.stale = false;
      S.draft = res.data;
      if (input) input.value = '';
      renderDraft(res.data);
      if (res.data && res.data.needsConfirm) toast('草案已生成：不可逆动作，等你确认', 'warn');
      else if (res.data && res.data.blocked) toast('草案已生成，但缺参数：看「缺失项」', 'warn');
      else toast('草案已生成：确认后派发', 'ok');
      load();
    });
  }
  function confirmDraft() {
    if (!S.draft || !S.draft.taskId) return;
    if (isOffline()) { denyOffline(); return; }
    var tok = getToken();
    if (!tok) { showAuthPanel('确认需要操作令牌'); return; }
    if (S.busy) return;
    S.busy = true;
    renderDraftButtons();
    api('/api/tasks/' + encodeURIComponent(S.draft.taskId) + '/confirm', { method: 'POST', body: { note: '手机确认执行' }, token: tok }).then(function (res) {
      S.busy = false;
      if (res.ok) {
        toast('已确认：任务已派发，回执会出现在「最近回执」', 'ok');
        clearDraft();
        load();
      } else {
        toast('确认失败：' + ((res.data && (res.data.error || res.data.message)) || ('HTTP ' + res.status)), 'bad');
        renderDraftButtons();
      }
    });
  }
  function rejectDraft() {
    if (!S.draft || !S.draft.taskId) return;
    if (isOffline()) { denyOffline(); return; }
    var tok = getToken();
    if (!tok) { showAuthPanel('拒绝需要操作令牌'); return; }
    if (S.busy) return;
    S.busy = true;
    renderDraftButtons();
    api('/api/tasks/' + encodeURIComponent(S.draft.taskId) + '/reject', { method: 'POST', body: {}, token: tok }).then(function (res) {
      S.busy = false;
      if (res.ok) {
        toast('已拒绝：原因记为「未填写」，事件留在账本里', 'ok');
        clearDraft();
        load();
      } else {
        toast('拒绝失败：' + ((res.data && (res.data.error || res.data.message)) || ('HTTP ' + res.status)), 'bad');
        renderDraftButtons();
      }
    });
  }


  /* ---------- 超级终端：甩到电脑 / 倾斜手势 / 语音 ---------- */
  function mSetResult(text, kind) {
    var el = $('#m-handoff-result');
    if (el) el.textContent = text;
    if (kind) toast(text, kind, 4600);
  }
  function mHandoff(trigger) {
    if (isOffline()) { mSetResult('离线只读：连上中枢才能甩过去', 'warn'); return; }
    var tok = getToken();
    if (!tok) {
      showAuthPanel('甩到电脑需要写操作令牌');
      mSetResult('先保存操作令牌，再甩到电脑', 'warn');
      return;
    }
    mSetResult('正在甩到电脑…');
    api('/api/v2/super/handoff', { method: 'POST', body: { kind: 'page', url: location.href, from: 'phone', trigger: trigger || 'button' }, token: tok }).then(function (res) {
      if (res.status === 401) {
        setToken('');
        showAuthPanel('令牌失效，请重新输入');
        mSetResult('令牌失效，请重新输入', 'bad');
        return;
      }
      if (res.ok && res.data && res.data.ok !== false) {
        mSetResult('已甩到电脑：' + (res.data.handoffId || '已送达'), 'ok');
        toast('电脑上会滑入这条内容', 'ok');
      } else if (res.status === 404) {
        mSetResult('超级终端服务还没接上（/api/v2/super/handoff 404）；页面已记下，后端就绪后一甩即到', 'warn');
      } else {
        mSetResult('甩送失败：' + ((res.data && (res.data.error || res.data.message)) || ('HTTP ' + res.status)), 'bad');
      }
    });
  }
  var mTilt = { prev: null, prevAt: 0, lastTrigger: 0, enabled: false };
  function mTiltStatus(text) {
    var el = $('#m-tilt-status');
    if (el) el.textContent = text;
  }
  function mEnableTilt() {
    var doEnable = function (ok) {
      if (!ok) { mTiltStatus('倾斜权限未开启：仍可点「甩到电脑」按钮'); toast('倾斜权限未开启，仍可点「甩到电脑」', 'warn'); return; }
      if (mTilt.enabled) return;
      mTilt.enabled = true;
      mTiltStatus('倾斜手势已开启：把手机往前一倾就甩到电脑');
      toast('倾斜手势已开启', 'ok');
    };
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        DeviceOrientationEvent.requestPermission().then(function (r) { doEnable(r === 'granted'); }).catch(function () { doEnable(false); });
      } else if (typeof window.addEventListener === 'function') {
        doEnable(true);
      } else doEnable(false);
    } catch (_) { doEnable(false); }
  }
  function mOnTilt(ev) {
    if (ev && (ev.beta === null || ev.beta === undefined)) return;
    var now = Date.now();
    if (mTilt.prev === null) { mTilt.prev = ev.beta; mTilt.prevAt = now; return; }
    var delta = Math.abs(ev.beta - mTilt.prev);
    var dt = now - mTilt.prevAt;
    if (delta > 25 && dt < 700 && now - mTilt.lastTrigger > 1000) {
      mTilt.lastTrigger = now;
      mTilt.prev = ev.beta;
      mTilt.prevAt = now;
      mSetResult('正在甩到电脑…');
      mHandoff('tilt');
      return;
    }
    if (dt > 120) { mTilt.prev = ev.beta; mTilt.prevAt = now; }
  }
  function mVoice() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      toast('浏览器不支持麦克风，已切文字输入', 'warn', 4800);
      var i0 = $('#m-input');
      if (i0) i0.focus();
      return;
    }
    try {
      var rec = new SR();
      rec.lang = 'zh-CN';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = function (e) {
        var t = '';
        try { t = e.results[0][0].transcript || ''; } catch (_) {}
        var input = $('#m-input');
        if (input && t) input.value = t;
        toast(t ? ('听到：' + t) : '没听清，已切文字输入', t ? 'ok' : 'warn');
      };
      rec.onerror = function (e) {
        var why = e && e.error;
        toast(why === 'not-allowed' ? '麦克风权限被拒绝，已切文字输入' : ('语音识别不可用（' + (why || '未知') + '），已切文字输入'), 'warn', 4800);
        var i2 = $('#m-input');
        if (i2) i2.focus();
      };
      rec.start();
      toast('正在听…请说话', 'ok');
    } catch (_) {
      toast('语音识别启动失败，已切文字输入', 'warn');
      var i3 = $('#m-input');
      if (i3) i3.focus();
    }
  }
  function mSuperInit() {
    var tiltBtn = $('#m-tilt-btn');
    if (tiltBtn) tiltBtn.addEventListener('click', function () {
      mEnableTilt();
      if (!mTilt.enabled && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 需要用户手势授权，授权回调里再触发一次
      }
      if (!mTilt.enabled) mSetResult('正在甩到电脑…');
      mHandoff('button');
    });
    var voiceBtn = $('#m-voice');
    if (voiceBtn) voiceBtn.addEventListener('click', mVoice);
    try { window.addEventListener('deviceorientation', mOnTilt); } catch (_) {}
  }

  /* ---------- 初始化 ---------- */
  function init() {
    var sendBtn = $('#m-send');
    if (sendBtn) sendBtn.addEventListener('click', send);
    var confirmBtn = $('#m-confirm');
    if (confirmBtn) confirmBtn.addEventListener('click', confirmDraft);
    var rejectBtn = $('#m-reject');
    if (rejectBtn) rejectBtn.addEventListener('click', rejectDraft);
    var authBtn = $('#m-auth-save');
    if (authBtn) authBtn.addEventListener('click', saveToken);
    var tokenInput = $('#m-token');
    if (tokenInput) {
      tokenInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); saveToken(); } });
    }
    var input = $('#m-input');
    if (input) {
      input.addEventListener('keydown', function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); send(); }
      });
    }
    mSuperInit();
    if (getToken()) {
      var panel = $('#m-auth');
      if (panel) panel.classList.add('hidden');
    }
    if (!S.state) applyCache();
    if (loadCache()) S.stale = true;
    renderAll();
    load();
    setInterval(load, 8000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
