/* 榫卯 Tenon v0.1 · 桌面控制台
 * 原生 JS，无依赖、无 CDN；GET /api/state + SSE /api/stream 实时刷新。
 * 首屏只读可看；写操作前若无 token 引导输入（POST /api/auth，令牌存 localStorage）。 */
(function () {
  'use strict';

  /* ---------- 自测用错误收集（不打断界面） ---------- */
  window.__tenonErrors = [];
  window.addEventListener('error', function (e) {
    try { window.__tenonErrors.push(String((e && e.message) || e || 'error')); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    try { window.__tenonErrors.push('unhandledrejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || '')); } catch (_) {}
  });

  var TOKEN_KEY = 'tenon:token';
  var SNAP_KEY = 'tenon:snapshot';
  var ROUTE_META = {
    overview: { title: '总览', sub: '只回答三个问题：这台机器能做什么、这件事办到哪一步、数据出了哪道门' },
    devices: { title: '设备', sub: 'L0 设备卡：它是谁、能做什么、谁在用；断开前必出影响预览' },
    capabilities: { title: '能力', sub: '谁提供、谁能用、最近三次调用、授权何时到期；每条关系都能点开证据' },
    tasks: { title: '任务', sub: '一件事办到哪一步：草案五段、时间线、确认 / 拒绝 / 取消 / 重试' },
    messages: { title: '消息', sub: '只发摘要与链接，不发正文；链接需登录才能看到正文' },
    checkup: { title: '体检', sub: '一键体检：阻断 / 警告 / 提示 / 无法判定；空结果也列出检查范围' },
    audit: { title: '审计', sub: '账本可导出 CSV / JSON / Markdown；导出本身也记账' },
    drills: { title: '演练', sub: '断网、限流、授权过期、版本不符、循环、磁盘满、跨域、无证据：显式降级而不是删除' },
    settings: { title: '设置', sub: '模式、数据目录、AI 状态、token 用量、许可证' }
  };
  var STATUS = {
    draft: { label: '草案', cls: 'b-muted' },
    pending: { label: '待确认', cls: 'b-warn' },
    queued: { label: '排队中', cls: 'b-info' },
    running: { label: '执行中', cls: 'b-info' },
    succeeded: { label: '已完成', cls: 'b-ok' },
    failed: { label: '失败', cls: 'b-bad' },
    timeout: { label: '超时', cls: 'b-warn' },
    cancelled: { label: '已取消', cls: 'b-muted' },
    delivered: { label: '已送达', cls: 'b-ok' },
    undelivered: { label: '未送达', cls: 'b-warn' },
    limited: { label: '限流', cls: 'b-warn' },
    queued_retry: { label: '排队重试', cls: 'b-info' },
    delivered_fallback: { label: '降级送达', cls: 'b-ok' }
  };
  var EVIDENCE = {
    certain: { label: '确定', cls: 'b-ok' },
    possible: { label: '可能', cls: 'b-warn' },
    unknown: { label: '未知', cls: 'b-muted' }
  };
  var FINDING = {
    blocked: { label: '阻断', cls: 'b-bad' },
    warning: { label: '警告', cls: 'b-warn' },
    notice: { label: '提示', cls: 'b-info' },
    undetermined: { label: '无法判定', cls: 'b-muted' }
  };
  var DRILLS = [
    { kind: 'offline', title: '断网演练', desc: '模拟拔掉公网：局域网内功能照常，公网任务排队；再点一次恢复。', btn: '切换断网 / 恢复' },
    { kind: 'rate-limit', title: '通道限流', desc: '微信通道限流：排队重试，超时改备用通道，界面标延迟。', btn: '触发限流' },
    { kind: 'auth-expired', title: '授权过期', desc: '能力授权过期：相关任务暂停并提醒续期。', btn: '触发过期' },
    { kind: 'version-mismatch', title: '版本不符', desc: '节点版本过旧：保留关系、标不兼容与所需版本。', btn: '触发版本不符' },
    { kind: 'loop', title: '循环阻止', desc: 'A→B→A 的循环链：拒绝保存并画出示意。', btn: '触发循环' },
    { kind: 'disk-full', title: '磁盘满', desc: '写入失败：停写摘要、保留事件、恢复后补算。', btn: '触发磁盘满' },
    { kind: 'cross-domain', title: '跨域引用', desc: '引用域外设备：允许但标跨域、要求审批。', btn: '触发跨域' },
    { kind: 'unknown-evidence', title: '无证据', desc: '对象无记录：显式标「无记录」，不推断。', btn: '触发无证据' },
    { kind: 'restore', title: '一键恢复', desc: '恢复演练造成的降级，服务端记一条恢复事件。', btn: '恢复' }
  ];

  var S = {
    snapshot: null,
    route: 'overview',
    param: null,
    stale: false,
    serverOk: false,
    sseOpen: false,
    lastOkAt: 0,
    cachedAt: 0,
    taskFilter: 'all',
    checkupScope: 'all',
    selectedTaskId: null,
    impactDevice: null,
    impact: null,
    answers: {},
    draftBusy: false,
    authResolve: null,
    stateBusy: false,
    lastRenderRoute: null,
    lastRenderParam: null,
    lastRenderSig: null,
    lastRenderAt: 0,
    pendingRender: false,
    flushTimer: null,
    lastUserActionAt: 0
  };

  /* ---------- 基础工具 ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function attr(v) { return esc(v); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function toDate(v) {
    if (v === null || v === undefined || v === '') return null;
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function hhmm(v) { var d = toDate(v); return d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : '--:--'; }
  function dateOf(v) {
    var d = toDate(v);
    if (!d) return '—';
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return (sameDay ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + hhmm(d);
  }
  function fullTime(v) {
    var d = toDate(v);
    if (!d) return '—';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hhmm(d);
  }
  function relTime(v) {
    var d = toDate(v);
    if (!d) return '未知';
    var diff = Date.now() - d.getTime();
    if (diff < 0) return '刚刚';
    var min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    var h = Math.floor(min / 60);
    if (h < 24) return h + ' 小时前';
    var day = Math.floor(h / 24);
    if (day < 30) return day + ' 天前';
    return fullTime(v);
  }
  function yes(cond) { return !!cond; }
  function listOf(v) { return Array.isArray(v) ? v : []; }
  function objOf(v) { return v && typeof v === 'object' ? v : {}; }

  function statusBadge(st) {
    var m = STATUS[st] || { label: st || '未知', cls: 'b-muted' };
    return '<span class="badge no-dot ' + m.cls + '">' + esc(m.label) + '</span>';
  }
  function riskBadge(level) {
    if (level === 'irreversible') return '<span class="tag amber">不可逆</span>';
    if (level === 'reversible') return '<span class="tag cyan">可逆</span>';
    return '<span class="tag">风险未知</span>';
  }
  function evidenceBadge(level) {
    var m = EVIDENCE[level] || EVIDENCE.unknown;
    return '<span class="badge no-dot ' + m.cls + '">证据：' + m.label + '</span>';
  }
  function nodeEvidenceBadge(ev) {
    if (ev === 'confirmed') return '<span class="badge no-dot b-ok">证据：已核对</span>';
    if (ev === 'declared') return '<span class="badge no-dot b-warn">证据：声明</span>';
    return '<span class="badge no-dot b-muted">证据：无记录</span>';
  }
  function drillLabel(kind) {
    var d = null;
    for (var i = 0; i < DRILLS.length; i++) if (DRILLS[i].kind === kind) { d = DRILLS[i]; break; }
    return d ? d.title : (kind || '演练');
  }
  function scopeLabel(scope) {
    var m = { all: '全部', devices: '设备与模型', auth: '权限与角色', channels: '通道可用' };
    return m[scope] || scope || '全部';
  }
  function modeLabel(mode) {
    var m = { solo: '单机模式', team: '团队模式', enterprise: '企业模式' };
    return m[mode] || (mode || '单机模式');
  }

  /* ---------- 本地存储 ---------- */
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function setToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (_) {}
    S.token = t || '';
  }
  function saveSnapshot(snapObj) {
    try { localStorage.setItem(SNAP_KEY, JSON.stringify({ at: Date.now(), snapshot: snapObj })); } catch (_) {}
  }
  function loadSnapshot() {
    try {
      var raw = localStorage.getItem(SNAP_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (o && o.snapshot && typeof o.snapshot === 'object') return o;
    } catch (_) {}
    return null;
  }

  /* ---------- 数据访问 ---------- */
  function snap() { return S.snapshot; }
  function nodesList() { var s = snap(); return s && Array.isArray(s.nodes) ? s.nodes : []; }
  function tasksList() { var s = snap(); return s && Array.isArray(s.tasks) ? s.tasks : []; }
  function messagesList() { var s = snap(); return s && Array.isArray(s.messages) ? s.messages : []; }
  function checkupsList() { var s = snap(); return s && Array.isArray(s.checkups) ? s.checkups : []; }
  function nodeById(id) { var l = nodesList(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function taskById(id) { var l = tasksList(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function capabilitiesList() {
    var s = snap();
    if (!s) return [];
    if (Array.isArray(s.capabilities) && s.capabilities.length) return s.capabilities;
    var out = [];
    var l = nodesList();
    for (var i = 0; i < l.length; i++) {
      var n = l[i];
      if (n.disconnected) continue;
      var caps = Array.isArray(n.capabilities) ? n.capabilities : [];
      for (var j = 0; j < caps.length; j++) {
        var c = caps[j];
        out.push({
          id: c.id, name: c.name, risk: c.risk, manualOnly: !!c.manualOnly, version: c.version,
          evidence: c.evidence || n.evidence, authExpiresAt: c.authExpiresAt,
          authExpired: !!c.authExpired, compatible: c.compatible !== false,
          required: c.required, current: c.current,
          nodeId: n.id, nodeName: n.name, online: !!n.online,
          recentCalls: null
        });
      }
    }
    return out;
  }
  function pendingTasks() {
    return tasksList().filter(function (t) { return t.status === 'pending'; });
  }
  function selectedTask() {
    var tasks = tasksList();
    if (!tasks.length) return null;
    var want = (S.route === 'tasks' && S.param) ? S.param : S.selectedTaskId;
    if (want) {
      var t = taskById(want);
      if (t) { S.selectedTaskId = want; return t; }
    }
    var first = null;
    for (var i = 0; i < tasks.length; i++) if (tasks[i].status === 'pending') { first = tasks[i]; break; }
    if (!first) first = tasks[0];
    if (!want) S.selectedTaskId = first.id;
    return first;
  }

  /* ---------- 异步 API ---------- */
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
      method: opts.method || 'GET',
      headers: headers,
      body: body,
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      var ct = (res.headers && res.headers.get('content-type')) || '';
      var dataPromise;
      if (ct.indexOf('json') >= 0) {
        dataPromise = res.json().catch(function () { return null; });
      } else {
        dataPromise = res.text().catch(function () { return null; });
      }
      return dataPromise.then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).catch(function (err) {
      return { ok: false, status: 0, network: true, error: String((err && err.message) || err) };
    });
  }

  /* ---------- toast ---------- */
  function toast(msg, kind, ms) {
    var root = $('#toast-root');
    if (!root) return;
    var el = document.createElement('div');
    var cls = kind === 'ok' ? 'toast-ok' : kind === 'warn' ? 'toast-warn' : kind === 'bad' ? 'toast-bad' : '';
    var icon = kind === 'ok' ? '✓' : kind === 'warn' ? '!' : kind === 'bad' ? '×' : '·';
    el.className = 'toast ' + cls;
    el.innerHTML = '<span class="toast-icon">' + icon + '</span><span>' + esc(msg) + '</span>';
    root.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s ease';
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 280);
    }, ms || 3800);
  }

  /* ---------- 令牌 / 登录 ---------- */
  function showAuth(reason) {
    var modal = $('#auth-modal');
    if (!modal) return;
    var input = $('#auth-token');
    var err = $('#auth-error');
    if (input) input.value = '';
    if (err) err.textContent = '';
    if (reason) { var r = $('#auth-reason'); if (r) r.textContent = reason; }
    modal.classList.remove('hidden');
    setTimeout(function () { try { input.focus(); } catch (_) {} }, 30);
  }
  function hideAuth() {
    var modal = $('#auth-modal');
    if (modal) modal.classList.add('hidden');
    flushPendingRender();
  }
  function resolveAuth(tok) {
    var r = S.authResolve;
    S.authResolve = null;
    if (r) r(tok);
  }
  function askToken(reason) {
    return new Promise(function (resolve) {
      if (S.authResolve) { var old = S.authResolve; S.authResolve = null; old(null); }
      S.authResolve = resolve;
      showAuth(reason || '写操作需要操作令牌（启动日志中打印）。');
    });
  }
  function submitAuth() {
    var input = $('#auth-token');
    var err = $('#auth-error');
    var tok = input ? String(input.value || '').trim() : '';
    if (!tok) { if (err) err.textContent = '请输入令牌'; return; }
    if (err) err.textContent = '验证中…';
    return api('/api/auth', { method: 'POST', body: { token: tok }, token: tok }).then(function (res) {
      if (res.ok && res.data && res.data.ok !== false) {
        setToken(tok);
        hideAuth();
        updateChrome();
        render(true);
        toast('登录成功：写操作会带 x-tenon-token', 'ok');
        resolveAuth(tok);
      } else if (res.network) {
        if (err) err.textContent = '无法连接中枢：离线或静态演示模式下不能登录。';
      } else {
        if (err) err.textContent = '令牌校验失败（HTTP ' + res.status + '）';
      }
    });
  }

  /* ---------- 写操作 ---------- */
  function apiWrite(path, body, label, opts) {
    opts = opts || {};
    if (S.snapshot && S.snapshot.readOnly) {
      toast('只读模式：当前角色缺写权限，写操作已禁用', 'warn');
      return Promise.resolve(null);
    }
    if (S.stale && !S.serverOk) {
      toast(asOfLabel() + ' · 离线只读，写操作不可用', 'warn');
      return Promise.resolve(null);
    }
    return askTokenIfNeeded().then(function (tok) {
      if (!tok) { toast('已取消：未提供令牌', 'warn'); return null; }
      var payload = body === undefined ? {} : body;
      return api(path, { method: 'POST', body: payload, token: tok }).then(function (res) {
        if (res.status === 401) {
          setToken('');
          return askToken('令牌无效或已过期，请重新输入').then(function (tok2) {
            if (!tok2) { toast('已取消：未提供令牌', 'warn'); return null; }
            return api(path, { method: 'POST', body: payload, token: tok2 });
          });
        }
        return res;
      }).then(function (res) {
        if (!res) return null;
        if (res.status === 401) { toast(label + '失败：令牌无效（HTTP 401）', 'bad'); return null; }
        if (res.network) { toast(label + '失败：无法连接中枢（离线或静态演示）', 'bad'); return null; }
        if (!res.ok) {
          var msg = (res.data && (res.data.error || res.data.message || (typeof res.data === 'string' ? res.data.slice(0, 120) : ''))) || ('HTTP ' + res.status);
          toast(label + '失败：' + msg, 'bad');
          return null;
        }
        if (res.data && res.data.ok === false) {
          toast(label + '失败：' + (res.data.error || '服务端拒绝'), 'bad');
          return null;
        }
        if (!opts.quiet) toast(label + '：已提交', 'ok');
        refreshSoon(160);
        return res.data || { ok: true };
      });
    });
  }
  function askTokenIfNeeded() {
    var t = getToken();
    if (t) return Promise.resolve(t);
    return askToken('写操作需要操作令牌（启动日志中打印的 operatorToken）。');
  }

  /* ---------- 数据时间 / 顶栏 / 连接状态 ---------- */
  function asOfSource() {
    if (S.snapshot && S.snapshot.dataAsOf) return S.snapshot.dataAsOf;
    if (S.cachedAt) return new Date(S.cachedAt).toISOString();
    return null;
  }
  function asOfLabel() {
    var src = asOfSource();
    if (!src) return '数据截至 --:--';
    var d = toDate(src);
    if (!d) return '数据截至 --:--';
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var body = sameDay ? hhmm(d) : ((d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm(d));
    return '数据截至 ' + body + (S.stale ? '（缓存）' : '');
  }
  function setText(sel, text) { var el = $(sel); if (el) el.textContent = text; }
  function updateChrome() {
    var asof = $('#data-asof');
    if (asof) {
      asof.textContent = asOfLabel();
      asof.setAttribute('data-stale', S.stale ? '1' : '0');
      asof.setAttribute('title', S.stale ? '当前离线，显示本机缓存的数据时间' : '数据时间（服务端账本最后一条事件）');
    }
    var conn = $('#conn');
    var connText = $('#conn-text');
    var state = (S.stale && !S.serverOk) ? 'stale' : ((S.sseOpen || S.serverOk) ? 'ok' : 'connecting');
    if (conn) conn.setAttribute('data-state', state);
    if (connText) connText.textContent = state === 'ok' ? (S.sseOpen ? '实时连接' : '已连接') : state === 'stale' ? '离线 · 缓存' : '连接中';
    var banner = $('#offline-banner');
    if (banner) {
      if (S.stale) {
        banner.classList.remove('hidden');
        setText('#offline-title', '离线只读');
        setText('#offline-text', asOfLabel() + ' · 无法连接中枢，正在显示本机缓存；写操作已禁用。启动中枢后自动恢复。');
      } else {
        banner.classList.add('hidden');
      }
    }
    var s = snap();
    setText('#domain-chip', (s && s.domainLabel) ? s.domainLabel : '工作室数据域');
    setText('#sf-mode', (s ? modeLabel(s.mode) : (S.stale ? '离线' : '连接中')) + (s && s.readOnly ? ' · 只读' : ' · 零外联'));
    var dot = $('#sf-dot');
    if (dot) dot.style.background = S.stale ? 'var(--amber)' : 'var(--green)';
    setText('#sf-token', getToken() ? '已登录 · 可执行写操作' : '未登录 · 只读可看');
    setText('#btn-auth', getToken() ? '令牌' : '登录');
    var authChip = $('#auth-state');
    if (authChip) {
      var logged = !!getToken();
      authChip.textContent = logged ? '已登录 · 可写' : '只读 · 未登录';
      authChip.setAttribute('data-auth', logged ? 'ok' : 'readonly');
      authChip.setAttribute('title', logged ? '已保存操作令牌：写操作会带 x-tenon-token' : '未登录：首屏只读；写操作会先引导输入令牌');
    }
    var meta = ROUTE_META[S.route] || ROUTE_META.overview;
    setText('#view-title', meta.title);
    setText('#view-sub', meta.sub);
    $$('#nav a').forEach(function (a) {
      if (a.getAttribute('data-route') === S.route) a.classList.add('active');
      else a.classList.remove('active');
    });
    document.title = '榫卯 Tenon · ' + meta.title;
  }

  /* ---------- 状态加载 / SSE ---------- */
  var es = null;
  var pollTimer = null;
  var refreshTimer = null;
  function refreshSoon(ms) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { refreshTimer = null; loadState(); }, ms || 300);
  }
  function loadState(opts) {
    opts = opts || {};
    if (S.stateBusy && !opts.force) return Promise.resolve(false);
    S.stateBusy = true;
    return api('/api/state').then(function (res) {
      S.stateBusy = false;
      if (res.ok && res.data && typeof res.data === 'object' && !res.data.error) {
        S.snapshot = res.data;
        S.serverOk = true;
        S.stale = false;
        S.lastOkAt = Date.now();
        saveSnapshot(res.data);
        render();
        updateChrome();
        return true;
      }
      S.serverOk = false;
      if (!S.snapshot) {
        var cached = loadSnapshot();
        if (cached) {
          S.snapshot = cached.snapshot;
          S.cachedAt = cached.at;
        }
      }
      S.stale = true;
      render();
      updateChrome();
      return false;
    });
  }
  /* ---------- 实时刷新策略：SSE 事件节流 + 实质变化才重绘 + 弹窗期间暂停 ---------- */
  var RENDER_MIN_GAP = 500;      // 同一列表 500ms 内不重建两次
  var SSE_DEBOUNCE = 250;        // SSE 事件 250ms debounce 合并刷新
  function nowIso() { return new Date().toISOString(); }
  function modalOpen() {
    var imp = $('#impact-modal');
    var auth = $('#auth-modal');
    return !!(imp && !imp.classList.contains('hidden')) || !!(auth && !auth.classList.contains('hidden'));
  }
  function stateSig() {
    var s = snap();
    if (!s) return 'none';
    var parts = [];
    parts.push('m:' + (s.mode || '') + ':' + (s.readOnly ? 1 : 0) + ':' + (s.domainLabel || ''));
    var meta = objOf(s.meta);
    parts.push('meta:' + (meta.degraded ? 1 : 0) + ':' + (meta.diskFull ? 1 : 0) + ':' + (meta.lastRoleError ? 1 : 0));
    var nodes = nodesList();
    var ns = [];
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var caps = listOf(n.capabilities).map(function (c) {
        return [c.id, c.risk, c.manualOnly ? 1 : 0, c.authExpired ? 1 : 0, c.compatible === false ? 1 : 0, c.version || '', c.authExpiresAt || ''].join(':');
      });
      ns.push([n.id, n.online ? 1 : 0, n.disconnected ? 1 : 0, n.hidden ? 1 : 0, n.evidence || '', n.domain || '', n.name || '', caps.join(';')].join('~'));
    }
    ns.sort();
    parts.push('n:' + ns.join('|'));
    var tasks = tasksList();
    var ts = [];
    for (var j = 0; j < tasks.length; j++) {
      var t = tasks[j];
      ts.push([t.id, t.status, t.nodeId || '', t.capabilityId || '', t.result ? 1 : 0, t.delivery ? 1 : 0, t.rejectReason || '', t.retries || 0, t.evidenceLevel || ''].join('~'));
    }
    parts.push('t:' + ts.join('|'));
    var msgs = messagesList();
    parts.push('msg:' + msgs.length + ':' + (msgs[0] ? msgs[0].id : ''));
    parts.push('chk:' + checkupsList().length);
    parts.push('aux:' + listOf(s.drills).length + ':' + listOf(s.loops).length + ':' + listOf(s.audit).length + ':' + listOf(s.recovery).length);
    parts.push('ai:' + (s.ai && s.ai.available ? 1 : 0));
    if (s.integrity && s.integrity.ok === false) parts.push('integ:bad');
    if (S.route === 'settings') parts.push('usage:' + ((objOf(s.aiUsage).calls) || 0) + ':' + ((objOf(s.aiUsage).tokensIn) || 0) + ':' + ((objOf(s.aiUsage).tokensOut) || 0));
    if (S.route === 'tasks') {
      var sel = S.selectedTaskId ? taskById(S.selectedTaskId) : null;
      if (sel) parts.push('steps:' + listOf(sel.steps).length);
    }
    return parts.join('||');
  }
  /* 不重建列表 DOM，只就地更新「在线 / 最近活跃 / 数据时间」等文字 */
  function patchLive() {
    try {
      var nodes = nodesList();
      var cards = $$('[data-testid="device-card"]');
      if (cards.length && nodes.length) {
        var map = {};
        for (var i = 0; i < nodes.length; i++) map[nodes[i].id] = nodes[i];
        for (var k = 0; k < cards.length; k++) {
          var node = map[cards[k].getAttribute('data-node-id')];
          if (!node) continue;
          var dot = cards[k].querySelector('.online-dot');
          var isOn = !!(node.online && !node.disconnected);
          if (dot) { dot.classList.toggle('on', isOn); dot.classList.toggle('off', !isOn); }
          var seen = cards[k].querySelector('[data-role="last-seen"]');
          if (seen) seen.textContent = '上次活跃 ' + (node.lastSeen ? relTime(node.lastSeen) : '未知');
        }
      }
    } catch (_) {}
    updateChrome();
  }
  function flushPendingRender() {
    if (S.flushTimer) { clearTimeout(S.flushTimer); S.flushTimer = null; }
    if (!S.pendingRender) return;
    if (modalOpen()) return;
    if (Date.now() - (S.lastUserActionAt || 0) < 600) { scheduleFlush(650); return; }
    S.pendingRender = false;
    render(true);
  }
  function scheduleFlush(delay) {
    if (S.flushTimer) return;
    S.flushTimer = setTimeout(function () {
      S.flushTimer = null;
      if (!S.pendingRender) return;
      if (modalOpen()) return;
      if (Date.now() - (S.lastUserActionAt || 0) < 600) { scheduleFlush(650); return; }
      S.pendingRender = false;
      render(true);
    }, Math.max(60, delay || RENDER_MIN_GAP));
  }
  /* node.heartbeat：不整页重绘，只更新在线点与「最近活跃」文字 */
  function applyHeartbeatEvent(ev) {
    var d = (ev && ev.data) || {};
    var nodeId = d.nodeId;
    if (!nodeId) return;
    var node = nodeById(nodeId);
    if (!node) { refreshSoon(SSE_DEBOUNCE); return; }
    var wasOnline = !!node.online;
    node.online = true;
    node.lastSeen = (ev && ev.at) || nowIso();
    if (S.snapshot) S.snapshot.dataAsOf = node.lastSeen;
    if (!wasOnline) { refreshSoon(SSE_DEBOUNCE); return; }
    patchLive();
  }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () { loadState(); }, 10000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  function connectSSE() {
    if (!('EventSource' in window)) { startPolling(); return; }
    try { es = new EventSource('/api/stream'); } catch (err) { startPolling(); return; }
    es.onopen = function () { S.sseOpen = true; stopPolling(); updateChrome(); };
    es.onmessage = function (ev) {
      S.sseOpen = true;
      S.serverOk = true;
      var obj = null;
      try { obj = ev && ev.data ? JSON.parse(ev.data) : null; } catch (_) {}
      var type = obj && obj.type ? String(obj.type) : '';
      if (type === 'node.heartbeat') { applyHeartbeatEvent(obj); return; }
      if (type === 'ai.called') { refreshSoon(1200); return; }
      refreshSoon(SSE_DEBOUNCE);
    };
    es.onerror = function () {
      S.sseOpen = false;
      if (es) { try { es.close(); } catch (_) {} es = null; }
      startPolling();
      updateChrome();
      setTimeout(function () { if (!es) connectSSE(); }, 10000);
    };
  }

  /* ---------- 路由与渲染 ---------- */
  function parseRoute() {
    var raw = (location.hash || '#/overview').replace(/^#\/?/, '');
    var parts = raw.split('/').filter(Boolean);
    var name = ROUTE_META[parts[0]] ? parts[0] : 'overview';
    var param = null;
    if (parts[1]) { try { param = decodeURIComponent(parts[1]); } catch (_) { param = parts[1]; } }
    return { name: name, param: param };
  }
  function onRoute() {
    var r = parseRoute();
    var changed = (r.name !== S.route) || (r.param !== S.param);
    S.route = r.name;
    S.param = r.param;
    if (S.route === 'tasks' && S.param) S.selectedTaskId = S.param;
    render(true);
    if (changed) { try { window.scrollTo(0, 0); } catch (_) {} }
  }
  function render(force) {
    var view = $('#view');
    if (!view) return;
    var sig = stateSig();
    if (!force && S.lastRenderRoute === S.route && S.lastRenderParam === S.param && S.lastRenderSig === sig) {
      patchLive();
      return;
    }
    /* 弹窗打开时暂停列表重绘：不替换弹窗外的按钮节点，关弹窗后再补渲染 */
    if (!force && modalOpen()) {
      S.pendingRender = true;
      patchLive();
      return;
    }
    /* 用户刚点过（600ms 内）不重建 DOM，避免点击中途按钮被 detach */
    var sinceUser = Date.now() - (S.lastUserActionAt || 0);
    if (!force && sinceUser < 600) {
      S.pendingRender = true;
      scheduleFlush(650 - sinceUser);
      patchLive();
      return;
    }
    /* 同一列表 500ms 内不重建两次 */
    var sinceRender = Date.now() - (S.lastRenderAt || 0);
    if (!force && sinceRender < RENDER_MIN_GAP) {
      S.pendingRender = true;
      scheduleFlush(RENDER_MIN_GAP - sinceRender + 30);
      patchLive();
      return;
    }
    var draftEl = $('#draft-text');
    var draftVal = draftEl ? draftEl.value : '';
    var draftFocus = draftEl && document.activeElement === draftEl;
    var scopeEl = $('#checkup-scope');
    var scopeVal = scopeEl ? scopeEl.value : '';
    var html = '';
    try {
      html = routeHtml();
    } catch (err) {
      window.__tenonErrors.push('render: ' + String((err && err.message) || err));
      html = '<div class="error-box">页面渲染出错：' + esc((err && err.message) || err) + '</div>';
    }
    view.innerHTML = html;
    if (draftVal) { var d1 = $('#draft-text'); if (d1) d1.value = draftVal; }
    if (scopeVal) { var s1 = $('#checkup-scope'); if (s1) s1.value = scopeVal; }
    if (draftFocus) {
      var d2 = $('#draft-text');
      if (d2) { try { d2.focus(); d2.setSelectionRange(d2.value.length, d2.value.length); } catch (_) {} }
    }
    S.lastRenderRoute = S.route;
    S.lastRenderParam = S.param;
    S.lastRenderSig = stateSig();
    S.lastRenderAt = Date.now();
    S.pendingRender = false;
    if (S.flushTimer) { clearTimeout(S.flushTimer); S.flushTimer = null; }
    updateChrome();
  }
  function routeHtml() {
    switch (S.route) {
      case 'devices': return renderDevices();
      case 'capabilities': return renderCapabilities();
      case 'tasks': return renderTasks();
      case 'messages': return renderMessages();
      case 'checkup': return renderCheckup();
      case 'audit': return renderAudit();
      case 'drills': return renderDrills();
      case 'settings': return renderSettings();
      default: return renderOverview();
    }
  }

  /* ---------- 通用片段 ---------- */
  function pageHead(title, lead, right) {
    return '<div class="page-head"><div><h2>' + esc(title) + '</h2><p class="lead">' + esc(lead) + '</p></div>' +
      (right ? '<div class="row-wrap">' + right + '</div>' : '') + '</div>';
  }
  function offlineEmpty() {
    return '<div class="empty"><strong>尚未连上中枢 · 静态演示模式</strong>' +
      '页面本身可以打开与浏览；启动 <code>node server/start.js</code> 后刷新即可看到设备、任务与审计。首屏只读不需要登录。</div>';
  }
  function emptyBlock(title, sub) {
    return '<div class="empty"><strong>' + esc(title) + '</strong>' + esc(sub) + '</div>';
  }
  function tag(text, cls) { return '<span class="tag ' + (cls || '') + '">' + esc(text) + '</span>'; }
  function shortDate(v) {
    var d = toDate(v);
    return d ? (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm(d) : '—';
  }
  function settingRow(k, v) {
    return '<div class="setting-row"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>';
  }
  function statCard(label, value, note, color, amber) {
    return '<div class="card"><div class="q-index">' + esc(label) + '</div>' +
      '<div class="stat-value' + (amber ? ' amber' : '') + '"' + (color ? ' style="color:' + color + '"' : '') + '>' + value + '</div>' +
      '<div class="stat-note">' + note + '</div></div>';
  }

  /* ---------- 设备卡 ---------- */
  function deviceCard(n) {
    var caps = listOf(n.capabilities);
    var outside = n.domain === 'outside' || n.readOnly;
    var badges = [];
    if (n.disconnected) badges.push('<span class="badge no-dot b-muted">已断开 · 留墓碑</span>');
    else badges.push(n.online ? '<span class="badge no-dot b-ok">在线</span>' : '<span class="badge no-dot b-bad">离线</span>');
    badges.push(nodeEvidenceBadge(n.evidence));
    if (outside) badges.push('<span class="badge no-dot b-warn">域外 · 仅可查看</span>');
    if (n.hidden) badges.push('<span class="badge no-dot b-muted">隐身中</span>');
    if (n.kind === 'imported') badges.push('<span class="badge no-dot b-muted">导入设备</span>');
    var capLines = '';
    if (caps.length) {
      for (var i = 0; i < caps.length; i++) {
        var c = caps[i];
        var bits = '';
        bits += '<span class="tag ' + (c.risk === 'irreversible' ? 'amber' : 'cyan') + '">' + (c.risk === 'irreversible' ? '不可逆' : '可逆') + '</span>';
        if (c.manualOnly) bits += '<span class="tag">仅手动</span>';
        var exp = toDate(c.authExpiresAt);
        if (c.authExpired || (exp && exp.getTime() < Date.now())) bits += '<span class="tag red">授权已过期</span>';
        else if (exp) bits += '<span class="tag amber">授权 ' + esc(shortDate(c.authExpiresAt)) + ' 到期</span>';
        if (c.compatible === false) bits += '<span class="tag red">版本不符' + (c.required ? '（需 ' + esc(c.required) + '，当前 ' + esc(c.current || '未知') + '）' : '') + '</span>';
        if (c.version) bits += '<span class="tag">v' + esc(c.version) + '</span>';
        capLines += '<div class="cap-line"><span class="cap-name">' + esc(c.name || c.id) + '</span>' +
          '<span class="cap-meta"><span class="mono" style="font-size:10px;color:var(--dim)">' + esc(c.id) + '</span>' + bits + '</span></div>';
      }
    } else {
      capLines = '<div class="cap-line"><span class="muted tiny">无已登记能力 · 只能人工确认</span></div>';
    }
    var evidenceLines = [];
    evidenceLines.push('node.evidence=' + esc(n.evidence || 'none') + ' · kind=' + esc(n.kind || 'node'));
    evidenceLines.push('fingerprint=' + esc(n.fingerprint || '无记录'));
    if (listOf(n.aliases).length) evidenceLines.push('曾用名：' + esc(listOf(n.aliases).join(' / ')));
    evidenceLines.push('registeredAt=' + esc(fullTime(n.registeredAt || n.lastSeen)));
    if (n.tombstoneAt) evidenceLines.push('tombstoneAt=' + esc(fullTime(n.tombstoneAt)) + '（名字、最后状态与引用关系保留 30 天）');
    evidenceLines.push(caps.length
      ? '能力证据：' + esc(caps.map(function (c) { return c.id + '=' + (c.evidence || n.evidence || 'unknown'); }).join(' · '))
      : '该设备无能力证据：只能人工确认');
    var actions = '<div class="card-actions">' +
      '<button class="btn btn-danger btn-sm" data-testid="btn-impact" data-action="open-impact" data-node-id="' + attr(n.id) + '"' + (n.disconnected ? ' disabled' : '') + '>断开（先看影响）</button>' +
      '<button class="btn btn-sm" data-action="device-rescan" data-node-id="' + attr(n.id) + '"' + (n.disconnected ? ' disabled' : '') + '>补扫</button>' +
      '<button class="btn btn-sm" data-action="device-hide" data-node-id="' + attr(n.id) + '" data-hidden="' + (n.hidden ? '1' : '0') + '">' + (n.hidden ? '取消隐身' : '隐身') + '</button>' +
      '</div>';
    return '<article class="card device-card fade" data-testid="device-card" data-node-id="' + attr(n.id) + '">' +
      '<div class="device-head"><div>' +
      '<div class="device-name"><span class="online-dot ' + (n.online && !n.disconnected ? 'on' : 'off') + '"></span>' + esc(n.name || n.id) + '</div>' +
      '<div class="device-meta"><span class="mono">' + esc(n.id) + '</span><span class="sep">·</span><span>' + esc(n.platform || '未知平台') + '</span>' +
      '<span class="sep">·</span><span>数据域 ' + (outside ? '域外' : esc(n.domain || '域内')) + '</span>' +
      (n.lastSeen ? '<span class="sep">·</span><span data-role="last-seen">上次活跃 ' + esc(relTime(n.lastSeen)) + '</span>' : '<span class="sep">·</span><span data-role="last-seen">上次活跃 未知</span>') +
      '</div></div><div class="badge-row">' + badges.join('') + '</div></div>' +
      '<div class="caps">' + capLines + '</div>' +
      '<details class="evidence"><summary>证据档位 · ' + caps.length + ' 条能力关系</summary><div class="evidence-list">' +
      evidenceLines.map(function (l) { return '<div>' + l + '</div>'; }).join('') +
      '</div></details>' + actions + '</article>';
  }

  /* ---------- 总览 ---------- */
  function timelineItems(limit) {
    var s = snap();
    var out = [];
    if (!s) return out;
    var tasks = tasksList();
    for (var i = 0; i < Math.min(tasks.length, 40); i++) {
      var t = tasks[i];
      var steps = listOf(t.steps);
      for (var j = Math.max(0, steps.length - 2); j < steps.length; j++) {
        var st = steps[j];
        if (!st) continue;
        out.push({
          at: st.at || t.updatedAt || t.createdAt,
          kind: '任务',
          label: st.label || '步骤',
          detail: (t.text || (t.draft && t.draft.summary) || t.id) + (st.detail ? ' · ' + st.detail : ''),
          taskId: t.id
        });
      }
    }
    var cks = checkupsList();
    for (var k = 0; k < Math.min(cks.length, 3); k++) {
      var c = cks[k];
      out.push({ at: c.at, kind: '体检', label: c.summary || (c.verdict === 'none' ? '未发现问题' : '发现 ' + listOf(c.findings).length + ' 项'), detail: '范围 ' + scopeLabel(c.scope) + ' · 已检查 ' + (c.checked || 0) + ' 项' });
    }
    var msgs = messagesList();
    for (var m = 0; m < Math.min(msgs.length, 4); m++) {
      var msg = msgs[m];
      out.push({ at: msg.at, kind: '回传', label: (msg.channelLabel || msg.channel || '通道') + ' · ' + (msg.status || 'delivered'), detail: msg.summary || '', taskId: msg.taskId });
    }
    var drills = listOf(s.drills);
    for (var d = Math.max(0, drills.length - 4); d < drills.length; d++) {
      out.push({ at: drills[d].at, kind: '演练', label: drillLabel(drills[d].kind), detail: drills[d].detail || '' });
    }
    var recovery = listOf(s.recovery);
    for (var r = 0; r < recovery.length; r++) {
      out.push({ at: recovery[r].at, kind: '恢复', label: '异常恢复', detail: recovery[r].note || ('缺口约 ' + Math.round((recovery[r].gapMs || 0) / 1000) + ' 秒，任务未重复执行') });
    }
    var loops = listOf(s.loops);
    for (var l = 0; l < loops.length; l++) {
      out.push({ at: loops[l].at, kind: '阻止', label: '循环任务已阻止', detail: loops[l].message || listOf(loops[l].chain).join('→') });
    }
    var audit = listOf(s.audit);
    for (var a = 0; a < audit.length; a++) {
      out.push({ at: audit[a].at, kind: '审计', label: '导出 ' + String(audit[a].format || '').toUpperCase(), detail: '共 ' + (audit[a].count || 0) + ' 条 · ' + (audit[a].by || '你') });
    }
    out.sort(function (x, y) { return String(y.at || '').localeCompare(String(x.at || '')); });
    return out.slice(0, limit || 10);
  }
  function timelineHtml(items, emptyTitle, emptySub) {
    if (!items.length) return emptyBlock(emptyTitle || '暂无事件', emptySub || '任务、体检、回传与演练的记录会出现在这里。');
    return '<ol class="timeline">' + items.map(function (it) {
      return '<li class="tl-item done"><div class="tl-head">' + tag(it.kind) + '<span class="tl-label">' + esc(it.label) + '</span>' +
        '<span class="tl-time">' + esc(dateOf(it.at)) + '</span></div>' +
        (it.detail ? '<div class="tl-detail">' + esc(it.detail) + '</div>' : '') + '</li>';
    }).join('') + '</ol>';
  }
  function renderOverview() {
    var s = snap();
    var nodes = nodesList();
    var tasks = tasksList();
    var caps = capabilitiesList();
    var msgs = messagesList();
    var online = nodes.filter(function (n) { return n.online && !n.disconnected && !n.hidden; }).length;
    var hidden = nodes.filter(function (n) { return n.hidden; }).length;
    var pending = pendingTasks().length;
    var active = tasks.filter(function (t) { return t.status === 'running' || t.status === 'queued'; }).length;
    var done = tasks.filter(function (t) { return t.status === 'succeeded'; }).length;
    var bad = tasks.filter(function (t) { return t.status === 'failed' || t.status === 'timeout'; }).length;
    var irreversible = caps.filter(function (c) { return c.risk === 'irreversible'; }).length;
    var manual = caps.filter(function (c) { return c.manualOnly; }).length;
    var delivered = msgs.filter(function (m) { return m.status !== 'undelivered'; }).length;
    var undelivered = msgs.filter(function (m) { return m.status === 'undelivered'; }).length;
    var outside = nodes.filter(function (n) { return n.domain === 'outside'; }).length;
    var channels = [];
    msgs.forEach(function (m) { var ch = m.channelLabel || m.channel; if (ch && channels.indexOf(ch) < 0) channels.push(ch); });
    var pendingList = pendingTasks().slice(0, 3);
    var latestTasks = tasks.slice(0, 3);
    var html = pageHead('总览', '给一个人或一个组织，把设备、软件与 AI 串成一条可查的任务链。只回答三个问题。',
      '<span class="tag">' + esc(modeLabel(s && s.mode)) + '</span>' +
      '<span class="tag ' + (s && s.ai && s.ai.available ? 'cyan' : '') + '">AI ' + (s && s.ai && s.ai.available ? '已接入' : '规则引擎') + '</span>' +
      (s && s.integrity ? '<span class="tag ' + (s.integrity.ok === false ? 'red' : '') + '">账本 ' + (s.integrity.ok === false ? '有缺口' : '完整') + '</span>' : ''));
    if (!s) html += '<div style="margin-bottom:12px"><div class="alert alert-warn">尚未连上中枢：当前为静态演示模式。用 <code>node server/start.js</code> 启动后刷新；断网时页面会读本机缓存并在顶栏标注数据时间。</div></div>';
    var alerts = '';
    if (s) {
      if (s.meta && s.meta.degraded) alerts += '<div class="alert alert-warn">降级模式：' + esc(s.meta.degraded.mode || '') + ' · ' + esc(s.meta.degraded.reason || '已显式降级') + '</div>';
      if (s.meta && s.meta.diskFull) alerts += '<div class="alert alert-warn">空间不足，摘要暂停，事件已保留</div>';
      if (s.meta && s.meta.lastRoleError) alerts += '<div class="alert alert-warn">只读：' + esc(s.meta.lastRoleError.message || '需要管理员角色') + '</div>';
      if (s.recovery && s.recovery.length) alerts += '<div class="alert alert-warn">上次异常恢复：' + esc((s.recovery[s.recovery.length - 1].note) || '已按账本重放恢复，任务未重复执行') + '</div>';
      if (s.integrity && s.integrity.ok === false) alerts += '<div class="alert alert-bad">事件账本存在缺口：' + listOf(s.integrity.gaps).length + ' 处，已标记，不静默失败</div>';
    }
    html += '<div class="grid grid-3">';
    html += '<div class="card qcard"><div class="q-index">Q1 · 这台机器能做什么</div>' +
      '<div class="stat-value">' + online + '<span class="unit">/ ' + nodes.length + ' 台在线</span></div>' +
      '<div class="stat-note">已登记能力 <strong>' + caps.length + '</strong> 项 · 不可逆 <strong>' + irreversible + '</strong> 项 · 仅手动 <strong>' + manual + '</strong> 项' + (hidden ? ' · 隐身 ' + hidden : '') + '</div>' +
      '<ul class="stat-list">' + (caps.length ? caps.slice(0, 3).map(function (c) {
        return '<li><span class="li-dot"></span><span>' + esc(c.name || c.id) + ' <span class="dim">· ' + esc(c.nodeName || '') + '</span></span>' +
          '<span style="margin-left:auto">' + riskBadge(c.risk) + '</span></li>';
      }).join('') : '<li class="dim">暂无能力：设备接入后会在此出现</li>') + '</ul></div>';
    html += '<div class="card qcard amber"><div class="q-index">Q2 · 这件事办到哪一步</div>' +
      '<div class="stat-value amber">' + pending + '<span class="unit">条待你确认</span></div>' +
      '<div class="stat-note">进行中 <strong>' + active + '</strong> 条 · 已完成 <strong>' + done + '</strong> 条 · 失败/超时 <strong>' + bad + '</strong> 条</div>' +
      '<ul class="stat-list">' + (pendingList.length ? pendingList.map(function (t) {
        return '<li><span class="li-dot"></span><a href="#/tasks/' + attr(t.id) + '">' + esc((t.draft && t.draft.summary) || t.text || t.id) + '</a></li>';
      }).join('') : (latestTasks.length ? latestTasks.map(function (t) {
        return '<li><span class="li-dot"></span><span>' + esc((t.draft && t.draft.summary) || t.text || t.id) + '</span><span style="margin-left:auto">' + statusBadge(t.status) + '</span></li>';
      }).join('') : '<li class="dim">暂无任务：说一句话就会生成草案</li>')) + '</ul></div>';
    html += '<div class="card qcard dim"><div class="q-index">Q3 · 数据出了哪道门</div>' +
      '<div class="stat-value">' + delivered + '<span class="unit">条回执已出站</span></div>' +
      '<div class="stat-note">数据域 <strong>' + esc((s && s.domainLabel) || '工作室数据域') + '</strong> · 通道 <strong>' + esc(channels.length ? channels.join(' / ') : '站内') + '</strong></div>' +
      '<ul class="stat-list">' +
      '<li><span class="li-dot"></span><span>敏感内容只发摘要与链接，正文需登录查看</span></li>' +
      (outside ? '<li><span class="li-dot"></span><span class="amber">域外设备 ' + outside + ' 台：标「仅可查看」，出域需审批</span></li>' : '') +
      (undelivered ? '<li><span class="li-dot"></span><span>未送达 ' + undelivered + ' 条：站内可查，未静默失败</span></li>' : '') +
      '</ul></div>';
    html += '</div>';
    if (alerts) html += '<div class="stack" style="margin-top:12px">' + alerts + '</div>';
    html += '<div class="section"><div class="section-head"><h2>设备</h2><span class="hint">L0 设备卡 · 能力、证据档位、断开前必出影响预览</span></div>' +
      (nodes.length ? '<div class="grid grid-auto">' + nodes.map(deviceCard).join('') + '</div>' : offlineEmpty()) + '</div>';
    html += '<div class="section"><div class="section-head"><h2>最近时间线</h2><span class="hint">' + esc(asOfLabel()) + '</span></div>' +
      '<div class="card">' + timelineHtml(timelineItems(10)) + '</div></div>';
    return html;
  }

  /* ---------- 设备 ---------- */
  function renderDevices() {
    var nodes = nodesList();
    var hidden = nodes.filter(function (n) { return n.hidden; }).length;
    var gone = nodes.filter(function (n) { return n.disconnected; }).length;
    var html = pageHead('设备', 'L0 设备卡：它是谁、能做什么、谁在用。离线保留上次状态；断开前必出影响预览，点取消后能力、任务、设备状态全部不变。',
      '<span class="tag">' + nodes.length + ' 台设备</span>' + (hidden ? '<span class="tag">隐身 ' + hidden + '</span>' : '') + (gone ? '<span class="tag red">已断开 ' + gone + '</span>' : ''));
    if (!nodes.length) return html + offlineEmpty();
    html += '<div class="grid grid-auto">' + nodes.map(deviceCard).join('') + '</div>';
    html += '<div class="hint-note" style="margin-top:14px">可补扫、可隐身、可只读接入；失败时说明卡在哪一步。断开只留墓碑：名字、最后状态与引用关系保留 30 天。无证据的关系显式标「无记录」，不推断。</div>';
    return html;
  }

  /* ---------- 能力 ---------- */
  function recentCallsFor(cap) {
    if (Array.isArray(cap.recentCalls)) return cap.recentCalls.slice(0, 3);
    var tasks = tasksList().filter(function (t) {
      return t.capabilityId === cap.id && ['succeeded', 'failed', 'timeout'].indexOf(t.status) >= 0;
    });
    tasks.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    return tasks.slice(0, 3);
  }
  function authExpiryText(c) {
    var exp = toDate(c.authExpiresAt);
    if (c.authExpired) return { text: '已过期，相关任务已暂停', cls: 'b-bad' };
    if (!exp) return { text: '未设置到期时间', cls: 'b-muted' };
    var days = Math.ceil((exp.getTime() - Date.now()) / 86400000);
    if (days < 0) return { text: fullTime(c.authExpiresAt) + '（已过期）', cls: 'b-bad' };
    if (days <= 30) return { text: fullTime(c.authExpiresAt) + '（' + days + ' 天后到期）', cls: 'b-warn' };
    return { text: fullTime(c.authExpiresAt) + '（' + days + ' 天后到期）', cls: 'b-ok' };
  }
  function capCard(c) {
    var exp = authExpiryText(c);
    var recent = recentCallsFor(c);
    var tasksRef = tasksList().filter(function (t) { return t.capabilityId === c.id; });
    var usedBy = c.manualOnly
      ? '仅手动：需要你操作，不自动调用'
      : (tasksRef.length ? '本数据域 · 发起人「你」 · 关联任务 ' + tasksRef.length + ' 条' : '本数据域 · 发起人「你」 · 暂无调用记录');
    var calls = '';
    if (recent.length) {
      calls = recent.map(function (t) {
        return '<div class="call"><span class="call-time">' + esc(dateOf(t.updatedAt || t.createdAt)) + '</span>' + statusBadge(t.status) +
          '<span class="call-text">' + esc((t.draft && t.draft.summary) || t.text || t.id) + '</span></div>';
      }).join('');
    } else {
      calls = '<div class="call dim">最近三次调用：无记录（无证据不推断）</div>';
    }
    var evidenceLines = [];
    evidenceLines.push('capability.evidence=' + esc(c.evidence || 'unknown'));
    evidenceLines.push('node=' + esc(c.nodeId || '—') + ' · nodeName=' + esc(c.nodeName || '—') + ' · online=' + (c.online ? 'true' : 'false'));
    if (c.version) evidenceLines.push('version=' + esc(c.version));
    if (c.authExpiresAt) evidenceLines.push('authExpiresAt=' + esc(c.authExpiresAt));
    if (c.compatible === false) evidenceLines.push('compatible=false · required=' + esc(c.required || '未知') + ' · current=' + esc(c.current || '未知'));
    tasksRef.slice(0, 3).forEach(function (t) {
      evidenceLines.push('task ' + esc(t.id) + ' · ' + esc(t.status) + ' · ' + esc(fullTime(t.updatedAt || t.createdAt)));
    });
    return '<article class="card cap-card fade" data-testid="cap-card" data-cap-id="' + attr(c.id) + '" data-node-id="' + attr(c.nodeId || '') + '">' +
      '<div class="cap-head"><div><div class="cap-title">' + esc(c.name || c.id) + '</div><div class="cap-id">' + esc(c.id) + '</div></div>' +
      '<div class="badge-row">' + riskBadge(c.risk) + (c.manualOnly ? '<span class="tag amber">仅手动</span>' : '') + evidenceBadge(c.evidence || 'unknown') + '</div></div>' +
      '<div class="cap-kv">' +
      '<span class="k">提供者</span><span class="v">' + esc(c.nodeName || '未知设备') + ' ' + (c.online ? '<span class="badge no-dot b-ok">在线</span>' : '<span class="badge no-dot b-bad">离线</span>') + '</span>' +
      '<span class="k">谁能用</span><span class="v">' + esc(usedBy) + '</span>' +
      '<span class="k">授权到期</span><span class="v"><span class="badge no-dot ' + exp.cls + '">' + esc(exp.text) + '</span></span>' +
      (c.compatible === false ? '<span class="k">版本</span><span class="v"><span class="badge no-dot b-bad">不兼容：需要 ' + esc(c.required || '更高版本') + '，当前 ' + esc(c.current || '未知') + '</span></span>' : '') +
      '</div>' +
      '<div class="calls"><div class="calls-label">最近三次调用</div>' + calls + '</div>' +
      '<details class="evidence"><summary>证据（点开看依据）</summary><div class="evidence-list">' +
      evidenceLines.map(function (l) { return '<div>' + l + '</div>'; }).join('') +
      '</div></details></article>';
  }
  function renderCapabilities() {
    var caps = capabilitiesList();
    var irreversible = caps.filter(function (c) { return c.risk === 'irreversible'; }).length;
    var expired = caps.filter(function (c) { return c.authExpired || (toDate(c.authExpiresAt) && toDate(c.authExpiresAt).getTime() < Date.now()); }).length;
    var manual = caps.filter(function (c) { return c.manualOnly; }).length;
    var html = pageHead('能力', '谁提供、谁能用、最近三次调用、授权何时到期；每条关系都能点开证据，无证据标未知。',
      '<span class="tag">' + caps.length + ' 项能力</span><span class="tag amber">不可逆 ' + irreversible + '</span>' + (expired ? '<span class="tag red">授权过期 ' + expired + '</span>' : '') + (manual ? '<span class="tag">仅手动 ' + manual + '</span>' : ''));
    if (!caps.length) return html + offlineEmpty();
    html += '<div class="grid grid-auto">' + caps.map(capCard).join('') + '</div>';
    html += '<div class="hint-note" style="margin-top:14px">不推断软件内部行为、不读文件内容；按人、按设备、按时段的授权到期都在这里显示。跨数据域引用允许但需审批。</div>';
    return html;
  }

  /* ---------- 任务 ---------- */
  function filterTasks(tasks) {
    switch (S.taskFilter) {
      case 'pending': return tasks.filter(function (t) { return t.status === 'pending'; });
      case 'active': return tasks.filter(function (t) { return t.status === 'queued' || t.status === 'running'; });
      case 'done': return tasks.filter(function (t) { return ['succeeded', 'cancelled', 'failed', 'timeout'].indexOf(t.status) >= 0; });
      case 'attention': return tasks.filter(function (t) { return t.status === 'failed' || t.status === 'timeout'; });
      default: return tasks;
    }
  }
  function taskRow(t) {
    var d = t.draft || {};
    var summary = d.summary || t.text || t.id;
    var node = nodeById(t.nodeId);
    var active = S.selectedTaskId === t.id;
    return '<button type="button" class="task-row' + (active ? ' active' : '') + '" data-testid="task-row" data-task-id="' + attr(t.id) + '" data-action="task-open">' +
      '<div>' + statusBadge(t.status) + '</div>' +
      '<div style="min-width:0"><div class="task-title">' + esc(summary) + '</div>' +
      '<div class="task-meta"><span class="mono">' + esc(t.id) + '</span>' +
      (node ? '<span>' + esc(node.name) + '</span>' : '<span class="dim">目标设备未知</span>') +
      (d.risk ? riskBadge(d.risk.level) : '') +
      '<span>' + esc(t.requester || '你') + '</span></div></div>' +
      '<div class="task-time">' + esc(dateOf(t.updatedAt || t.createdAt)) + '<br><span class="dim">' + esc(relTime(t.updatedAt || t.createdAt)) + '</span></div>' +
      '</button>';
  }
  function draftSec(seg, title, html) {
    return '<div class="draft-sec"><h4><span class="seg">' + seg + '</span>' + esc(title) + '</h4><div class="val">' + html + '</div></div>';
  }
  function explainHtml(t) {
    var answer = S.answers[t.id];
    return '<div class="draft-sec" style="margin-top:8px"><h4>解释链路 <span class="seg">AI · explain</span></h4>' +
      '<div class="val' + (answer ? '' : ' dim') + '" id="explain-out">' +
      (answer ? esc(answer) : '点「解释链路」：用 60 字以内说清这条任务由谁办、办到哪、数据去了哪。') + '</div></div>';
  }
  function resultHtml(t) {
    var r = t.result;
    if (!r) return '';
    var h = '<div class="draft-sec" style="margin-top:8px"><h4>执行结果 <span class="seg">result</span></h4><div class="val">' + esc(r.summary || '') + '</div>';
    var items = listOf(r.items);
    if (items.length) {
      h += '<ul class="items">' + items.map(function (it) {
        return '<li><span class="' + (it.ok ? 'ok' : 'bad') + '">' + (it.ok ? '✓' : '×') + '</span><span>' + esc(it.name || '') + (it.detail ? ' · ' + esc(it.detail) : '') + '</span></li>';
      }).join('') + '</ul>';
    }
    if (r.partial) h += '<div class="alert alert-warn" style="margin-top:8px">部分成功：逐项列出成功与失败，失败的可在时间线里追。</div>';
    return h + '</div>';
  }
  function deliveryHtml(t) {
    var d = t.delivery;
    var attempts = listOf(t.deliveryAttempts);
    if (!d && !attempts.length) return '';
    var h = '<div class="draft-sec" style="margin-top:8px"><h4>回传 <span class="seg">delivery</span></h4>';
    if (d) {
      h += '<div class="row-wrap">' + statusBadge(d.status || 'delivered') + tag(d.channel || '未知通道') +
        (d.link ? '<a class="tiny" href="' + attr(d.link) + '" target="_blank" rel="noopener">' + esc(d.link) + '</a>' : '') + '</div>' +
        '<div class="tiny muted" style="margin-top:4px">只发摘要与链接：' + esc(String(d.summary || '').slice(0, 120)) + '</div>';
    }
    if (attempts.length) {
      h += '<div class="items" style="margin-top:6px">' + attempts.slice(-4).map(function (a) {
        return '<li><span class="mono dim tiny">' + esc(hhmm(a.at)) + '</span><span>' + esc(a.channel || '通道') + ' · ' + esc(a.status || '') + (a.reason ? ' · ' + esc(a.reason) : '') + '</span></li>';
      }).join('') + '</div>';
    }
    return h + '</div>';
  }
  function taskDetailHtml(t) {
    if (!t) return '<div class="card"><div class="empty"><strong>未选择任务</strong>左侧点一条任务查看草案五段、时间线与操作。</div></div>';
    var d = t.draft || {};
    var caps = listOf(d.capabilities);
    var risk = d.risk || t.risk || { level: 'reversible', reasons: [] };
    var target = d.targetDevice;
    if (!target && t.nodeId) { var n = nodeById(t.nodeId); target = { id: t.nodeId, name: n ? n.name : t.nodeId }; }
    var missing = listOf(d.missing || t.missing);
    var steps = listOf(t.steps);
    var canConfirm = t.status === 'pending';
    var canReject = t.status === 'pending';
    var canCancel = ['pending', 'queued', 'running', 'draft'].indexOf(t.status) >= 0;
    var canRetry = ['failed', 'timeout', 'cancelled'].indexOf(t.status) >= 0;
    var targetNode = target ? nodeById(target.id) : null;
    var capsHtml = caps.length
      ? caps.map(function (c) { return '<span class="tag cyan">' + esc(c.name || c.id) + ' · ' + esc(c.id) + '</span>' + (c.manualOnly ? '<span class="tag amber">仅手动</span>' : ''); }).join(' ')
      : '<span class="amber">未匹配到能力' + (missing.length ? '：' + esc(missing[0]) : '：需要追问') + '</span>';
    var targetHtml = target
      ? esc(target.name || target.id) + ' <span class="mono dim">' + esc(target.id) + '</span>' + (targetNode && targetNode.online ? '' : ' <span class="tag red">离线 / 不可达</span>') + (targetNode && targetNode.domain === 'outside' ? ' <span class="tag amber">跨数据域，需审批</span>' : '')
      : '<span class="amber">目标设备未知</span>';
    return '<div class="card">' +
      '<div class="detail-head"><div>' +
      '<div class="detail-title">' + esc(d.summary || t.text || t.id) + '</div>' +
      '<div class="task-meta" style="margin-top:5px"><span class="mono">' + esc(t.id) + '</span>' + statusBadge(t.status) + evidenceBadge(t.evidenceLevel) + riskBadge(risk.level) + '</div>' +
      '</div><div class="tiny muted" style="text-align:right">' + esc(fullTime(t.createdAt)) + '<br>发起人 ' + esc(t.requester || '你') + ' · 来源 ' + esc(t.source === 'phone' ? '手机' : '桌面') + '</div></div>' +
      '<div class="draft-grid">' +
      draftSec('①', '任务草案', esc(d.summary || t.text || '（无）')) +
      draftSec('②', '用到的能力', capsHtml) +
      draftSec('③', '目标设备', targetHtml) +
      draftSec('④', '缺失项', missing.length ? '<ul class="missing">' + missing.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>' : '<span class="dim">无缺失项，参数齐全</span>') +
      draftSec('⑤', '风险等级', (risk.level === 'irreversible'
        ? '<span class="badge no-dot b-warn">不可逆</span> 需逐次确认：确认后才派发'
        : '<span class="badge no-dot b-ok">可逆</span> 可免确认直接派发') +
        (listOf(risk.reasons).length ? '<div class="tl-detail">' + esc(listOf(risk.reasons).join('；')) + '</div>' : '')) +
      '</div>' +
      (d.params && Object.keys(d.params).length
        ? '<div class="draft-sec" style="margin-top:8px"><h4>参数 <span class="seg">params</span></h4><div class="params">' + esc(JSON.stringify(d.params, null, 2)) + '</div></div>'
        : '') +
      '<div class="action-bar">' +
      '<button class="btn btn-primary btn-sm" data-testid="btn-confirm" data-action="task-confirm"' + (canConfirm ? '' : ' disabled title="仅待确认任务可确认"') + '>确认执行</button>' +
      '<button class="btn btn-danger btn-sm" data-testid="btn-reject" data-action="task-reject"' + (canReject ? '' : ' disabled title="仅待确认任务可拒绝"') + '>拒绝</button>' +
      '<button class="btn btn-sm" data-testid="btn-cancel" data-action="task-cancel"' + (canCancel ? '' : ' disabled title="该任务已结束"') + '>取消</button>' +
      '<button class="btn btn-sm" data-testid="btn-retry" data-action="task-retry"' + (canRetry ? '' : ' disabled title="仅失败 / 超时 / 已取消可重试"') + '>重试</button>' +
      '<button class="btn btn-ghost btn-sm" data-testid="btn-explain" data-action="task-explain">解释链路</button>' +
      '<button class="btn btn-ghost btn-sm" data-action="task-open-receipt" data-task-id="' + attr(t.id) + '">打开回执</button>' +
      '<div class="note">' + (canConfirm ? '不可逆动作：将发生什么、影响谁、能否撤销——确认后才会派发。' : canCancel ? '取消只停止后续步骤，已完成的步骤不回滚。' : canRetry ? '重试会重新排队，原因会记进时间线。' : '该任务已结束：可查看证据、结果与回执链接。') + '</div>' +
      '</div>' +
      explainHtml(t) +
      '<div class="section-head" style="margin-top:16px"><h2>时间线</h2><span class="hint">每一步都能在账本里找到证据</span></div>' +
      timelineHtml(steps.map(function (st) { return { at: st.at, kind: '步骤', label: st.label, detail: st.detail }; }), '暂无步骤', '任务事件会按顺序出现在这里。') +
      resultHtml(t) + deliveryHtml(t) +
      (t.rejectReason ? '<div class="reject-note">拒绝原因：' + esc(t.rejectReason) + '（拒绝也记账，作为下次的负例）</div>' : '') +
      '</div>';
  }
  function renderTasks() {
    var tasks = tasksList();
    var pending = tasks.filter(function (t) { return t.status === 'pending'; }).length;
    var html = pageHead('任务', '一件事办到哪一步：草案列出用到的能力与缺失项，不可逆动作逐次确认，可取消、可重试、可解释链路。',
      '<span class="tag' + (pending ? ' amber' : '') + '">待确认 ' + pending + '</span><span class="tag">共 ' + tasks.length + ' 条</span>');
    html += '<div class="card"><div class="card-title">说一句话 → 生成任务草案</div>' +
      '<div class="card-sub">AI 只出草案，执行走能力接口；缺参数会写进缺失项，不替你猜。Ctrl + Enter 提交。</div>' +
      '<div class="form-row" style="margin-top:10px">' +
      '<div class="field"><textarea id="draft-text" data-testid="task-input" placeholder="例：把昨天拍的样品图裁成方图，发到工作群 / 打印三份样品01 / 把这段文字总结成周报"></textarea></div>' +
      '<button class="btn btn-primary" data-testid="btn-draft" data-action="draft-create">生成草案</button>' +
      '</div>' +
      '<div class="hint-note" style="margin-top:6px">可逆动作免确认直接派发；不可逆动作（发送 / 删除 / 付款 / 打印）停下来等你确认；仅手动能力只提示、不自动调用。</div></div>';
    var filters = [['all', '全部'], ['pending', '待确认'], ['active', '进行中'], ['done', '已结束'], ['attention', '失败 / 超时']];
    html += '<div class="split" style="margin-top:14px"><div><div class="list-filter">' +
      filters.map(function (f) {
        return '<button class="filter-chip' + (S.taskFilter === f[0] ? ' active' : '') + '" data-action="task-filter" data-filter="' + f[0] + '">' + f[1] + '</button>';
      }).join('') + '</div>';
    var filtered = filterTasks(tasks);
    html += '<div class="task-list">' + (filtered.length
      ? filtered.map(taskRow).join('')
      : emptyBlock(tasks.length ? '没有符合条件的任务' : '还没有任务', tasks.length ? '换个筛选，或在上面说一句话生成草案。' : '在输入框说一句话，中枢会生成五段草案。')) + '</div></div>';
    html += '<div id="task-detail" class="detail">' + taskDetailHtml(selectedTask()) + '</div></div>';
    return html;
  }

  /* ---------- 消息 ---------- */
  function renderMessages() {
    var list = messagesList();
    var html = pageHead('消息', '只发摘要与链接，不发正文；链接需登录才能看到正文。限流、换通道、未送达都会标出来。',
      '<span class="tag">' + list.length + ' 条</span>');
    html += '<div class="alert alert-info">回传通道只负责送达：微信 / QQ / 邮件 / 站内。敏感内容只发摘要与链接，正文需登录后在中枢查看；失败可换通道、可重试、可标未送达。</div>';
    if (!list.length) return html + '<div style="margin-top:12px">' + emptyBlock('暂无消息', '任务结束后这里会出现摘要与回执链接。') + '</div>';
    html += '<div class="message-list" style="margin-top:12px">' + list.map(function (m) {
      var link = m.link || (m.taskId ? '/r/' + m.taskId : '');
      return '<article class="message-row" data-testid="message-row" data-message-id="' + attr(m.id) + '">' +
        '<div class="msg-head">' + statusBadge(m.status) + '<span class="msg-title">' + esc(m.title || '任务回执') + '</span>' +
        tag(m.channelLabel || m.channel || '通道') + (m.sensitive ? '<span class="tag amber sensitive">已脱敏</span>' : '') +
        '<span class="spacer" style="flex:1"></span><span class="mono tiny dim">' + esc(dateOf(m.at)) + '</span></div>' +
        '<div class="msg-summary">' + esc(m.summary || '（无摘要）') + '</div>' +
        '<div class="msg-foot">' + (link ? '<a href="' + attr(link) + '" target="_blank" rel="noopener">查看回执 ' + esc(link) + '</a>' : '<span class="dim">无链接</span>') +
        '<span class="dim">任务 <a href="#/tasks/' + attr(m.taskId || '') + '">' + esc(m.taskId || '—') + '</a></span>' +
        '<span class="dim">' + (m.status === 'undelivered' ? '未送达，站内可查' : '已留在账本里') + '</span></div></article>';
    }).join('') + '</div>';
    return html;
  }

  /* ---------- 体检 ---------- */
  function findingHtml(f) {
    var m = FINDING[f.level] || { label: f.level || '提示', cls: 'b-muted' };
    return '<div class="finding" data-testid="checkup-finding" data-level="' + attr(f.level || 'notice') + '">' +
      '<div class="row-wrap"><span class="badge no-dot ' + m.cls + '">' + esc(m.label) + '</span><span class="finding-title">' + esc(f.title || '') + '</span></div>' +
      (f.detail ? '<div class="finding-detail">' + esc(f.detail) + '</div>' : '') +
      (f.evidence ? '<div class="finding-evidence">证据：' + esc(f.evidence) + '</div>' : '') +
      '</div>';
  }
  function checkupCard(c) {
    var findings = listOf(c.findings);
    var counts = { blocked: 0, warning: 0, notice: 0, undetermined: 0 };
    findings.forEach(function (f) { if (counts[f.level] !== undefined) counts[f.level]++; });
    var h = '<article class="card checkup-card" data-checkup-id="' + attr(c.id) + '">' +
      '<div class="checkup-head"><div class="row-wrap">' +
      '<span class="badge no-dot ' + (c.verdict === 'none' ? 'b-ok' : 'b-warn') + '">' + (c.verdict === 'none' ? '未发现问题' : '发现 ' + findings.length + ' 项') + '</span>' +
      tag(scopeLabel(c.scope)) + tag('已检查 ' + (c.checked || 0) + ' 项') +
      '<span class="tag' + (counts.blocked ? ' red' : '') + '">阻断 ' + counts.blocked + '</span>' +
      '<span class="tag' + (counts.warning ? ' amber' : '') + '">警告 ' + counts.warning + '</span>' +
      '<span class="tag">提示 ' + counts.notice + '</span>' +
      '<span class="tag">无法判定 ' + counts.undetermined + '</span>' +
      '</div><div class="checkup-time">' + esc(fullTime(c.at)) + ' · ' +
      '<a href="/api/checkup/' + attr(c.id) + '/export?format=md" target="_blank" rel="noopener" data-testid="btn-export-checkup" data-action="checkup-export" data-checkup-id="' + attr(c.id) + '">导出 Markdown</a></div></div>' +
      '<div class="tiny muted" style="margin-top:6px">' + esc(c.summary || '') + '</div>';
    h += findings.length
      ? '<div style="margin-top:6px">' + findings.map(findingHtml).join('') + '</div>'
      : '<div class="alert alert-info" style="margin-top:10px">未发现问题，已检查 ' + (c.checked || 0) + ' 项（' + esc(scopeLabel(c.scope)) + '）。空结果也是一份结果——否则分不清「没问题」与「没检查」。</div>';
    return h + '</article>';
  }
  function renderCheckup() {
    var list = checkupsList();
    var html = pageHead('上线体检', '一条命令装在自己的服务器上；一页看清哪些能力可用、哪些授权到期、哪条通道被降级。发现分阻断 / 警告 / 提示 / 无法判定。',
      '<span class="tag">' + list.length + ' 份报告</span>');
    html += '<div class="card"><div class="row-wrap">' +
      '<div class="field" style="max-width:240px"><label for="checkup-scope">检查范围</label><select id="checkup-scope">' +
      ['all', 'devices', 'auth', 'channels'].map(function (k) {
        return '<option value="' + k + '"' + (S.checkupScope === k ? ' selected' : '') + '>' + scopeLabel(k) + '</option>';
      }).join('') + '</select></div>' +
      '<button class="btn btn-primary" data-testid="btn-run-checkup" data-action="checkup-run">一键体检</button>' +
      '<span class="hint-note">检查设备与模型、权限与角色、通道可用、账本完整性、任务健康、AI 与外部依赖、数据与审计。</span></div></div>';
    if (!list.length) return html + '<div style="margin-top:12px">' + emptyBlock('还没有体检报告', '点「一键体检」生成第一份：没有发现时会写「未发现问题，已检查 N 项」。') + '</div>';
    html += '<div style="margin-top:12px">' + list.map(checkupCard).join('') + '</div>';
    return html;
  }

  /* ---------- 审计 ---------- */
  function renderAudit() {
    var s = snap() || {};
    var integ = objOf(s.integrity);
    var audit = listOf(s.audit);
    var html = pageHead('审计', '账本可导出 CSV / JSON / Markdown；导出本身也记账。谁在何时、用哪台设备、动了什么、结果如何。',
      '<div class="btn-row">' +
      '<button class="btn btn-primary btn-sm" data-testid="btn-export-csv" data-action="export" data-format="csv">导出 CSV</button>' +
      '<button class="btn btn-sm" data-testid="btn-export-json" data-action="export" data-format="json">导出 JSON</button>' +
      '<button class="btn btn-sm" data-testid="btn-export-md" data-action="export" data-format="md">导出 Markdown</button>' +
      '</div>');
    if (!s || !s.seq) html += '<div style="margin-bottom:12px">' + offlineEmpty() + '</div>';
    var eventCount = integ.events !== undefined ? integ.events : (s.seq || 0);
    html += '<div class="grid grid-3">' +
      statCard('账本完整性', integ.ok === false ? '有缺口' : '完整', integ.ok === false ? listOf(integ.gaps).length + ' 处缺口已标记，不静默失败' : '哈希链逐条可校验', integ.ok === false ? 'var(--red)' : 'var(--green)') +
      statCard('事件数', '<span class="mono">' + eventCount + '</span>', 'seq ' + esc(String(s.seq || 0)) + ' · 只追加，不修改') +
      statCard('数据时间', '<span style="font-size:20px">' + esc(asOfLabel()) + '</span>', '超过 24 小时会提示重跑体检') +
      '</div>';
    html += '<div class="section"><div class="section-head"><h2>最近审计（导出记录）</h2><span class="hint">导出动作本身也写账本</span></div>';
    html += audit.length
      ? '<div class="card"><div class="drill-list">' + audit.map(function (a) {
        return '<div class="drill-item"><span class="mono dim tiny">' + esc(dateOf(a.at)) + '</span><span>' + esc(String(a.format || '').toUpperCase()) + ' · 共 ' + esc(a.count || 0) + ' 条</span><span class="dim" style="margin-left:auto">' + esc(a.by || '你') + '</span></div>';
      }).join('') + '</div></div>'
      : '<div class="card">' + emptyBlock('尚未导出过审计', '点上方 CSV / JSON / Markdown 导出；每次导出都会留下记录。') + '</div>';
    html += '</div>';
    html += '<div class="section"><div class="section-head"><h2>最近关键事件</h2><span class="hint">' + esc(asOfLabel()) + '</span></div>' +
      '<div class="card">' + timelineHtml(timelineItems(12)) + '</div></div>';
    html += '<div class="hint-note" style="margin-top:14px">审计保留：单机 7 天 / 团队 30 天 / 企业 180 天。数据、日志、模型调用记录都在自己的服务器上；拔掉公网，审计记录完整、时间连续。</div>';
    return html;
  }

  /* ---------- 演练 ---------- */
  function renderDrills() {
    var s = snap() || {};
    var drills = listOf(s.drills);
    var loops = listOf(s.loops);
    var html = pageHead('演练', '边界只能显式降级，不能删除。每个按钮都会在账本里留一条事件，界面说清「为什么慢了 / 为什么停了」。',
      '<span class="tag">' + drills.length + ' 次演练</span>');
    html += '<div class="alert alert-info">演练会真实改写当前状态（例如夹断通道、把设备标成授权过期）；点「一键恢复」可还原。断网演练是开 / 关切换。</div>';
    html += '<div class="drill-grid" style="margin-top:12px">' + DRILLS.map(function (d) {
      return '<div class="drill-card"><h3>' + esc(d.title) + '</h3><div class="drill-desc">' + esc(d.desc) + '</div>' +
        '<button class="btn ' + (d.kind === 'restore' ? 'btn-ghost' : 'btn-sm') + '" data-testid="drill-' + d.kind + '" data-action="drill" data-kind="' + d.kind + '">' + esc(d.btn) + '</button></div>';
    }).join('') + '</div>';
    html += '<div class="section"><div class="section-head"><h2>最近演练记录</h2><span class="hint">时间连续，不丢事件</span></div>';
    html += drills.length
      ? '<div class="card"><div class="drill-list">' + drills.slice().reverse().map(function (d) {
        return '<div class="drill-item"><span class="mono dim tiny">' + esc(dateOf(d.at)) + '</span><span>' + esc(drillLabel(d.kind)) + '</span><span class="dim" style="margin-left:auto">' + esc(d.detail || '') + '</span></div>';
      }).join('') + '</div></div>'
      : '<div class="card">' + emptyBlock('还没有演练记录', '点上面任一按钮，观察界面如何显式降级。') + '</div>';
    html += '</div>';
    if (loops.length) {
      html += '<div class="section"><div class="section-head"><h2>循环阻止记录</h2><span class="hint">A→B→A，已阻止</span></div><div class="card"><div class="drill-list">' +
        loops.map(function (l) {
          return '<div class="drill-item"><span class="mono dim tiny">' + esc(dateOf(l.at)) + '</span><span>' + esc(l.message || listOf(l.chain).join('→')) + '</span></div>';
        }).join('') + '</div></div></div>';
    }
    return html;
  }

  /* ---------- 设置 ---------- */
  function maskToken(t) {
    if (!t) return '未保存';
    if (t.length <= 8) return '••••';
    return t.slice(0, 4) + '••••' + t.slice(-3);
  }
  function renderSettings() {
    var s = snap() || {};
    var ai = objOf(s.ai);
    var usage = objOf(s.aiUsage);
    var places = objOf(usage.places);
    var last = usage.last || null;
    var tok = getToken();
    var html = pageHead('设置', '模式、数据目录、AI 状态、token 用量与许可证。默认零外联：数据、日志与调用记录都在自己的服务器上。',
      '<span class="tag">v' + esc(s.version || '0.1') + '</span>' +
      '<span class="tag ' + (s.readOnly ? 'amber' : 'cyan') + '">' + (s.readOnly ? '只读' : '可写') + '</span>');
    html += '<div class="settings-grid">';
    html += '<div class="card"><div class="card-title">运行</div>' +
      settingRow('模式', s.mode ? esc(modeLabel(s.mode)) + ' <span class="dim">（' + esc(s.mode) + '）</span>' : '<span class="dim">连接后显示</span>') +
      settingRow('数据域', esc(s.domainLabel || '工作室数据域')) +
      settingRow('数据目录', esc(s.dataDir || 'data/') + ' <span class="dim tiny">由 TENON_DATA_DIR 决定</span>') +
      settingRow('只读', s.readOnly ? '<span class="tag amber">是：需要管理员角色</span>' : '<span class="tag cyan">否</span>') +
      settingRow('服务端时间', s.serverNow ? esc(fullTime(s.serverNow)) : '<span class="dim">—</span>') +
      settingRow('版本', esc(s.version || '0.1')) +
      '</div>';
    html += '<div class="card"><div class="card-title">AI 状态</div>' +
      settingRow('可用', (ai.available ? '<span class="tag cyan">已配置 API key</span>' : '<span class="tag amber">未配置：规则引擎降级</span>')) +
      settingRow('提供方 / 模型', esc((ai.provider || 'rule') + (ai.model ? ' · ' + ai.model : ''))) +
      settingRow('调用次数', '<span class="mono">' + (usage.calls || 0) + '</span>') +
      settingRow('token 用量', '<span class="mono">' + (usage.tokensIn || 0) + ' 入 / ' + (usage.tokensOut || 0) + ' 出</span>') +
      settingRow('缓存 / 降级', '<span class="mono">' + (usage.cached || 0) + ' / ' + (usage.fallback || 0) + '</span>') +
      settingRow('最近一次', last ? '<span class="mono tiny">' + esc((last.place || '') + ' · ' + (last.tokens || 0) + ' tokens · ' + dateOf(last.at)) + '</span>' : '<span class="dim">暂无调用</span>') +
      '<div class="usage-bar" title="调用预算 20 次"><i style="width:' + Math.min(100, Math.round(((usage.calls || 0) / 20) * 100)) + '%"></i></div>' +
      '<div class="tiny dim" style="margin-top:5px">预算：最多 20 次 / 40000 tokens；超出后自动降级为规则引擎，界面标「未知」而不是猜。</div></div>';
    var placeKeys = Object.keys(places);
    html += '<div class="card"><div class="card-title">token 分布</div>' +
      (placeKeys.length
        ? placeKeys.map(function (k) { return settingRow(k, '<span class="mono">' + places[k] + ' tokens</span>'); }).join('')
        : '<div class="empty" style="margin-top:8px">尚无 token 消耗记录</div>') + '</div>';
    html += '<div class="card"><div class="card-title">操作令牌</div>' +
      settingRow('状态', tok ? '<span class="tag cyan">已登录 · 写操作会带 x-tenon-token</span>' : '<span class="tag">未登录 · 只读可看</span>') +
      settingRow('令牌', tok ? '<span class="mono">' + esc(maskToken(tok)) + '</span>' : '<span class="dim">未保存</span>') +
      '<div class="btn-row" style="margin-top:10px">' +
      '<button class="btn btn-primary btn-sm" data-action="open-auth">' + (tok ? '更换令牌' : '登录') + '</button>' +
      '<button class="btn btn-sm" data-action="token-clear"' + (tok ? '' : ' disabled') + '>清除令牌</button></div>' +
      '<div class="tiny dim" style="margin-top:8px">令牌保存在本机 localStorage，只在请求头里出现；服务端 <code>data/secrets.json</code> 的 operatorToken 在启动日志里打印。</div></div>';
    html += '<div class="card"><div class="card-title">许可证</div><div class="license">' +
      '<p>榫卯 Tenon v0.1 · 可自建的设备、软件与 AI 连接中枢。</p>' +
      '<p>源代码可审计；默认零外联；卸载后不留后台进程与残留权限。</p>' +
      '<p>许可证：CC BY-NC-SA 4.0（署名 · 非商业性使用 · 相同方式共享）；商业使用需另行授权，见 <code>COMMERCIAL.md</code>。</p>' +
      '</div></div>';
    html += '</div>';
    return html;
  }

  /* ---------- 影响预览 ---------- */
  function localImpact(nodeId) {
    var node = nodeById(nodeId);
    var rel = tasksList().filter(function (t) { return t.nodeId === nodeId && t.capabilityId; });
    var certain = [], possible = [], unknown = [];
    rel.forEach(function (t) {
      var st = t.status;
      if (['pending', 'queued', 'running', 'draft'].indexOf(st) >= 0) {
        if (t.evidenceLevel === 'certain' && node && node.evidence === 'confirmed') certain.push(t.id);
        else possible.push(t.id);
      } else if (['succeeded', 'failed', 'timeout'].indexOf(st) >= 0) {
        possible.push(t.id);
      } else {
        unknown.push(t.id);
      }
    });
    if (!rel.length) unknown.push('（该设备的能力关系无证据，仅可人工确认）');
    return {
      deviceId: nodeId,
      deviceName: node ? node.name : nodeId,
      counts: { certain: certain.length, possible: possible.length, unknown: unknown.length },
      certain: certain, possible: possible, unknown: unknown,
      sentence: '确定 ' + certain.length + ' 条、可能 ' + possible.length + ' 条、未知 ' + unknown.length + ' 条',
      note: '没有记录不等于没有引用：无记录时只能人工确认。',
      local: true
    };
  }
  function impactHtml(imp, local) {
    var c = imp.counts || { certain: 0, possible: 0, unknown: 0 };
    function group(label, ids, cls) {
      var list = listOf(ids);
      if (!list.length) return '';
      return '<div class="impact-group"><div class="gl">' + esc(label) + '（' + list.length + '）</div><div class="chip-list">' +
        list.map(function (id) {
          if (taskById(id)) {
            return '<a class="tag ' + (cls || '') + '" href="#/tasks/' + attr(id) + '" data-action="impact-goto" data-task-id="' + attr(id) + '">' + esc(id) + '</a>';
          }
          return '<span class="tag">' + esc(id) + '</span>';
        }).join('') + '</div></div>';
    }
    return '<div class="alert alert-info">' + esc(imp.sentence || '') + '</div>' +
      '<div class="impact-counts">' +
      '<div class="impact-count certain"><div class="n">' + (c.certain || 0) + '</div><div class="l">确定 · 正在进行的任务</div></div>' +
      '<div class="impact-count possible"><div class="n">' + (c.possible || 0) + '</div><div class="l">可能 · 进行中或最近引用</div></div>' +
      '<div class="impact-count unknown"><div class="n">' + (c.unknown || 0) + '</div><div class="l">未知 · 无记录，只能人工确认</div></div>' +
      '</div>' +
      group('确定', imp.certain, 'red') + group('可能', imp.possible, 'amber') + group('未知', imp.unknown) +
      (imp.note ? '<div class="hint-note" style="margin-top:8px">' + esc(imp.note) + '</div>' : '') +
      (local ? '<div class="hint-note">离线估算：按本机已缓存记录静态计算，不能替代中枢结果；此时断开按钮禁用。</div>' : '') +
      '<div class="hint-note" style="margin-top:8px">取消后能力、任务、设备状态全部不变；确认断开只留墓碑（保留 30 天）。</div>';
  }
  function openImpact(nodeId) {
    if (!nodeId) return;
    var modal = $('#impact-modal');
    if (!modal) return;
    S.impactDevice = nodeId;
    var node = nodeById(nodeId);
    setText('#impact-title', '断开前 · 影响预览');
    setText('#impact-sub', (node ? node.name : nodeId) + ' · 静态可算、可离线；确定 / 可能 / 未知三级');
    var body = $('#impact-body');
    if (body) body.innerHTML = '<div class="empty">正在静态计算影响…</div>';
    setText('#impact-note', '没有记录不等于没有引用：无记录时只能人工确认。');
    var btn = $('[data-testid="impact-disconnect"]');
    if (btn) btn.disabled = true;
    modal.classList.remove('hidden');
    api('/api/impact?deviceId=' + encodeURIComponent(nodeId)).then(function (res) {
      if (res.ok && res.data && !res.data.error) {
        S.impact = res.data;
        if (body) body.innerHTML = impactHtml(res.data, false);
        setText('#impact-note', res.data.note || '没有记录不等于没有引用：无记录时只能人工确认。');
        var b2 = $('[data-testid="impact-disconnect"]');
        if (b2) b2.disabled = false;
      } else {
        var local = localImpact(nodeId);
        S.impact = local;
        if (body) {
          body.innerHTML = '<div class="alert alert-warn">影响预览接口不可用' + (res.network ? '（当前离线）' : '（HTTP ' + res.status + '）') +
            '：以下是本机按已缓存记录做的静态估算，不能替代中枢结果。</div>' + impactHtml(local, true);
        }
        setText('#impact-note', '没有记录不等于没有引用：离线估算只能人工确认。');
        var b3 = $('[data-testid="impact-disconnect"]');
        if (b3) b3.disabled = true;
      }
    });
  }
  function closeImpact() {
    var modal = $('#impact-modal');
    if (modal) modal.classList.add('hidden');
    S.impactDevice = null;
    S.impact = null;
    flushPendingRender();
  }
  function doDisconnect() {
    var id = S.impactDevice;
    if (!id) { closeImpact(); return Promise.resolve(); }
    return apiWrite('/api/devices/' + encodeURIComponent(id) + '/disconnect', {}, '断开设备').then(function (data) {
      if (data) closeImpact();
    });
  }

  /* ---------- 动作 ---------- */
  function navigateTask(taskId) {
    if (!taskId) return;
    var target = '#/tasks/' + encodeURIComponent(taskId);
    if (location.hash === target) { S.selectedTaskId = taskId; render(true); }
    else location.hash = target;
  }
  function createDraft() {
    var el = $('#draft-text');
    var text = el ? String(el.value || '').trim() : '';
    if (!text) {
      toast('先写一句要办的事，例如「把昨天的样品图裁成方图，发到工作群」', 'warn');
      if (el) { try { el.focus(); } catch (_) {} }
      return Promise.resolve();
    }
    if (S.draftBusy) return Promise.resolve();
    S.draftBusy = true;
    return apiWrite('/api/tasks/draft', { text: text, source: 'desktop' }, '生成草案').then(function (data) {
      S.draftBusy = false;
      if (data && data.taskId) {
        S.selectedTaskId = data.taskId;
        var ta = $('#draft-text');
        if (ta) ta.value = '';
        if (data.needsConfirm) toast('草案已生成：不可逆动作，等你确认后才派发', 'warn', 4800);
        else if (data.blocked) toast('草案已生成，但缺参数：看「缺失项」', 'warn', 4800);
        else if (data.manualOnly) toast('草案已生成：该能力仅手动，需要你操作', 'warn', 4800);
        navigateTask(data.taskId);
        render(true);
      }
    });
  }
  function taskAction(kind, label) {
    var t = selectedTask();
    if (!t) return Promise.resolve();
    var body = {};
    if (kind === 'confirm') body = { note: '确认执行不可逆动作' };
    return apiWrite('/api/tasks/' + encodeURIComponent(t.id) + '/' + kind, body, label).then(function (data) {
      if (data) refreshSoon(120);
    });
  }
  function explainTask() {
    var t = selectedTask();
    if (!t) return Promise.resolve();
    return apiWrite('/api/tasks/' + encodeURIComponent(t.id) + '/explain', {}, '解释链路', { quiet: true }).then(function (data) {
      if (data && data.text) {
        S.answers[t.id] = data.text;
        render(true);
        toast('解释已生成' + (data.ai && data.ai.provider === 'rule' ? '（规则降级）' : ''), 'ok');
      }
    });
  }
  function runCheckup() {
    var sel = $('#checkup-scope');
    var scope = sel ? sel.value : (S.checkupScope || 'all');
    S.checkupScope = scope;
    return apiWrite('/api/checkup/run', { scope: scope }, '一键体检').then(function (data) {
      if (data && data.checkup) {
        var c = data.checkup;
        toast('体检完成：' + (c.summary || ('发现 ' + listOf(c.findings).length + ' 项')), c.verdict === 'none' ? 'ok' : 'warn', 5200);
        refreshSoon(200);
      }
    });
  }
  function runDrill(kind) {
    return apiWrite('/api/drills/' + encodeURIComponent(kind), {}, '演练 · ' + drillLabel(kind)).then(function (data) {
      if (data && data.detail) toast(String(data.detail), 'ok', 4600);
    });
  }
  function download(path, filename) {
    var headers = {};
    var tok = getToken();
    if (tok) headers['x-tenon-token'] = tok;
    return fetch(path, { headers: headers, credentials: 'same-origin' }).then(function (res) {
      if (!res.ok) { toast('导出失败：HTTP ' + res.status, 'bad'); return; }
      return res.blob().then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename || 'tenon-export';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 500);
        toast('已开始导出：' + (filename || '文件'), 'ok');
        refreshSoon(400);
      });
    }).catch(function (err) {
      toast('导出失败：' + String((err && err.message) || err), 'bad');
    });
  }

  /* ---------- 事件委托 ---------- */
  function onDocumentClick(ev) {
    var target = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!target) return;
    var action = target.getAttribute('data-action');
    var ds = target.dataset || {};
    if (target.disabled) return;
    if (action === 'auth-submit') return;
    ev.preventDefault();
    switch (action) {
      case 'open-auth':
        if (getToken()) showAuth('更换令牌：输入新的操作令牌（旧令牌会被替换）。');
        else showAuth('写操作需要操作令牌；首屏只读不需要登录。');
        break;
      case 'auth-cancel': hideAuth(); resolveAuth(null); break;
      case 'open-impact': openImpact(ds.nodeId); break;
      case 'impact-cancel': closeImpact(); break;
      case 'impact-disconnect': doDisconnect(); break;
      case 'impact-goto': closeImpact(); navigateTask(ds.taskId); break;
      case 'device-rescan': apiWrite('/api/devices/' + encodeURIComponent(ds.nodeId) + '/rescan', {}, '补扫'); break;
      case 'device-hide': apiWrite('/api/devices/' + encodeURIComponent(ds.nodeId) + '/hide', {}, ds.hidden === '1' ? '取消隐身' : '隐身'); break;
      case 'task-filter': S.taskFilter = ds.filter || 'all'; render(true); break;
      case 'task-open': navigateTask(ds.taskId || target.getAttribute('data-task-id')); break;
      case 'draft-create': createDraft(); break;
      case 'task-confirm': taskAction('confirm', '确认执行'); break;
      case 'task-reject': taskAction('reject', '拒绝任务'); break;
      case 'task-cancel': taskAction('cancel', '取消任务'); break;
      case 'task-retry': taskAction('retry', '重试任务'); break;
      case 'task-explain': explainTask(); break;
      case 'task-open-receipt': {
        var t = taskById(ds.taskId);
        var link = (t && t.delivery && t.delivery.link) || '/r/' + ds.taskId;
        try { window.open(link, '_blank', 'noopener'); } catch (_) { location.href = link; }
        break;
      }
      case 'checkup-run': runCheckup(); break;
      case 'checkup-export': download('/api/checkup/' + encodeURIComponent(ds.checkupId) + '/export?format=md', 'tenon-checkup-' + ds.checkupId + '.md'); break;
      case 'export': download('/api/audit/export?format=' + encodeURIComponent(ds.format || 'json'), 'tenon-audit.' + (ds.format || 'json')); break;
      case 'drill': runDrill(ds.kind); break;
      case 'token-clear':
        setToken('');
        updateChrome();
        render(true);
        toast('已清除本机令牌：现在只读可看', 'ok');
        break;
      default: break;
    }
  }
  function onDocumentSubmit(ev) {
    if (ev.target && ev.target.id === 'auth-form') {
      ev.preventDefault();
      submitAuth();
    }
  }
  function onDocumentKeydown(ev) {
    if (ev.key === 'Escape') { closeImpact(); hideAuth(); resolveAuth(null); return; }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && ev.target && ev.target.id === 'draft-text') {
      ev.preventDefault();
      createDraft();
    }
  }
  function onDocumentChange(ev) {
    if (ev.target && ev.target.id === 'checkup-scope') S.checkupScope = ev.target.value;
  }

  /* ---------- 初始化 ---------- */
  function init() {
    setToken(getToken());
    var cached = loadSnapshot();
    if (cached) { S.snapshot = cached.snapshot; S.cachedAt = cached.at; S.stale = true; }
    var r = parseRoute();
    S.route = r.name;
    S.param = r.param;
    if (S.route === 'tasks' && S.param) S.selectedTaskId = S.param;
    render(true);
    updateChrome();
    loadState({ force: true });
    connectSSE();
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('pointerdown', function () { S.lastUserActionAt = Date.now(); }, true);
    document.addEventListener('click', function () { S.lastUserActionAt = Date.now(); }, true);
    document.addEventListener('keydown', function () { S.lastUserActionAt = Date.now(); }, true);
    document.addEventListener('submit', onDocumentSubmit);
    document.addEventListener('keydown', onDocumentKeydown);
    document.addEventListener('change', onDocumentChange);
    window.addEventListener('hashchange', onRoute);
    setInterval(function () { if (!S.sseOpen) loadState(); }, 12000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) loadState(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
