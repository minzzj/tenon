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
    settings: { title: '设置', sub: '模式、数据目录、AI 状态、token 用量、许可证' },
    link: { title: '互联', sub: '发现、配对、信任、文件互传、剪贴板与通知镜像；零外网依赖' },
    assets: { title: '素材库', sub: '归集、哈希去重、OCR 搜索、标签与谱系；批量加入中转站' },
    basket: { title: '中转站', sub: '手机暂存、电脑一次取用；跨设备流转的超级中转站' },
    scenes: { title: '场景', sub: '打印素材 / 投屏照片 / 备份到 NAS；不可逆动作需确认' },
    enterprise: { title: '企业控制台', sub: '成员与角色、动作权限、审批、审计导出与保留期' },
    super: { title: '超级终端', sub: '一台小软件，调动家里所有设备与程序 · 说话或一倾，内容就滑到电脑上' },
    handoff: { title: '流转接收', sub: '从手机流转过来的网页 / 照片 / 文字，滑入电脑，可打开或收藏' }
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
    query: {},
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
    if (S.route === 'super' || S.route === 'handoff') {
      var dc2 = $('#domain-chip');
      if (dc2) { dc2.textContent = '我的设备'; dc2.setAttribute('title', '本机中枢 · 数据只在家里'); }
    }
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
    var navMore = $('#nav-more');
    if (navMore && navMore.querySelector('a.active')) navMore.classList.add('open');
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
    var v2c = $('#v2-confirm-modal');
    return !!(imp && !imp.classList.contains('hidden')) || !!(auth && !auth.classList.contains('hidden')) || !!(v2c && !v2c.classList.contains('hidden'));
  }
  function stateSig() {
    var s = snap();
    if (!s) return 'none' + (v2IsRoute(S.route) ? '|v2:' + v2Sig() : '');
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
    if (v2IsRoute(S.route)) parts.push('v2:' + v2Sig());
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
      if (v2IsRealtimeEvent(type)) { v2OnRealtimeEvent(obj); refreshSoon(SSE_DEBOUNCE); return; }
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
    var raw = (location.hash || '').replace(/^#\/?/, '');
    var query = {};
    var qi = raw.indexOf('?');
    if (qi >= 0) {
      var qs = raw.slice(qi + 1);
      raw = raw.slice(0, qi);
      qs.split('&').forEach(function (kv) {
        if (!kv) return;
        var p = kv.split('=');
        try { query[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' ')); } catch (_) {}
      });
    }
    var parts = raw.split('/').filter(Boolean);
    var name = ROUTE_META[parts[0]] ? parts[0] : (raw ? 'overview' : 'super');
    var param = null;
    if (parts[1]) { try { param = decodeURIComponent(parts[1]); } catch (_) { param = parts[1]; } }
    return { name: name, param: param, query: query };
  }
  function onRoute() {
    var r = parseRoute();
    var changed = (r.name !== S.route) || (r.param !== S.param);
    S.route = r.name;
    S.param = r.param;
    S.query = r.query || {};
    if (S.route === 'tasks' && S.param) S.selectedTaskId = S.param;
    if (v2IsRoute(S.route)) v2EnsureLoaded(S.route);
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
    var v2Form = v2CaptureForm();
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
    v2RestoreForm(v2Form);
    v2AfterRender();
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
      case 'link': return v2RenderLink();
      case 'assets': return v2RenderAssets();
      case 'basket': return v2RenderBasket();
      case 'scenes': return v2RenderScenes();
      case 'enterprise': return v2RenderEnterprise();
      case 'super': return superRenderSuper();
      case 'handoff': return superRenderHandoff();
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
      case 'nav-toggle': {
        var moreBox2 = $('#nav-more');
        if (moreBox2) moreBox2.classList.toggle('open');
        if (target) target.setAttribute('aria-expanded', (moreBox2 && moreBox2.classList.contains('open')) ? 'true' : 'false');
        break;
      }
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

  /* ======================================================================
   * v2-P0 页面：互联 / 素材库 / 中转站 / 场景 / 企业控制台
   * 与真实中枢（7410，v2 全模块 51 路由）对齐后的版本：
   *   - 配对码：GET /api/v2/link/pair/qr（不再从 peers.pairing 读）
   *   - 中转站：GET /api/v2/assets/basket、POST /api/v2/assets/basket {items:[{assetId}],to}、
   *             POST /api/v2/assets/basket/take {ids,to}
   *   - 传输：GET /api/v2/link/transfers + transfer.* SSE
   *   - 审批：GET /api/v2/approvals、POST /api/v2/approvals/:id/decide {ok,reason}
   *   - 成员：GET/POST /api/v2/org/users、PATCH /api/v2/org/users/:id {role,allowedActions,status}
   * 只追加，不改动 v0.1 已验收的 9 页与 testid；接口异常时降级不崩。
   * ====================================================================== */

  var V2_ROUTES = { link: 1, assets: 1, basket: 1, scenes: 1, enterprise: 1, super: 1, handoff: 1 };
  var V2_LOCAL_ACTIONS = [
    { id: 'asset.print', name: '打印素材', risk: 'irreversible', requiresConfirmation: true },
    { id: 'asset.showOnDesktop', name: '投屏到电脑', risk: 'reversible' },
    { id: 'asset.backup', name: '备份到文件夹 / NAS', risk: 'reversible' },
    { id: 'channel.notify', name: '发送通知', risk: 'irreversible', requiresConfirmation: true },
    { id: 'system.open', name: '打开应用 / 文件', risk: 'reversible' }
  ];
  var V2_EXTRA_ACTIONS = ['asset.ingest', 'asset.tag', 'asset.share', 'transfer.send', 'clipboard.share', 'scene.run', 'audit.export'];
  var V2_ROLES = [
    { id: 'admin', name: '管理员' },
    { id: 'member', name: '成员' },
    { id: 'guest', name: '访客' }
  ];
  var V2 = {
    loaded: {},
    loading: {},
    status: {},
    data: {
      peers: [],
      self: null,
      discovery: null,
      pairQr: null,
      transfers: [],
      clipboard: null,
      clipHistory: [],
      notifications: [],
      assets: [],
      assetTotal: 0,
      assetStats: null,
      assetDetail: null,
      assetLineage: null,
      assetFilters: { q: '', kind: '', device: '', from: '', to: '' },
      assetSelection: [],
      basket: [],
      basketStats: null,
      basketTarget: '',
      scenes: [],
      sceneRuns: [],
      sceneFormOpen: false,
      sceneDraftSteps: [],
      orgUsers: [],
      orgRoles: [],
      editUserId: '',
      approvals: [],
      policy: null,
      actions: [],
      actor: 'u_admin',
      entTab: 'users',
      lastLoad: 0
    },
    confirm: null
  };

  /* ---------- v2 基础工具 ---------- */
  function v2IsRoute(route) { return !!V2_ROUTES[route || S.route]; }
  function v2Arr(data, keys) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    var cand = keys || ['items', 'list', 'data', 'results', 'peers', 'assets', 'scenes', 'users', 'approvals', 'transfers', 'notifications', 'basket'];
    for (var i = 0; i < cand.length; i++) if (Array.isArray(data[cand[i]])) return data[cand[i]];
    return [];
  }
  function v2Bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
  function v2Speed(bps) { return bps ? v2Bytes(bps) + '/s' : '—'; }
  function v2ErrText(st) {
    if (!st) return '未检测';
    if (st.kind === 'missing') return '接口未挂载（HTTP 404）';
    if (st.kind === 'auth') return '需要操作令牌（HTTP ' + st.http + '）';
    if (st.kind === 'offline') return '无法连接中枢（离线）';
    return st.msg || ('HTTP ' + st.http);
  }
  function v2Degrade(keys, what) {
    var missing = [];
    for (var i = 0; i < keys.length; i++) {
      var st = V2.status[keys[i]];
      if (st && !st.ok) missing.push(st);
    }
    if (!missing.length) return '';
    var lines = missing.map(function (st) { return '<code>' + esc(st.path || '') + '</code> ' + esc(v2ErrText(st)); }).join(' · ');
    return '<div class="v2-degrade alert alert-warn" data-testid="v2-degrade">' +
      '<div><strong>' + esc(what || 'v2 接口未就绪') + '（只读降级）</strong>：' + lines +
      ' <button class="btn btn-sm" data-v2="refresh-page" data-page="' + attr(S.route) + '">重试</button></div>' +
      '<div class="hint-note">页面布局与交互可用；中枢挂载 <code>/api/v2/*</code> 后自动加载真实数据，无需额外操作。</div></div>';
  }
  function v2LoadingNote(keys) {
    for (var i = 0; i < keys.length; i++) if (!V2.status[keys[i]]) return '<div class="tiny dim" data-testid="v2-loading">正在检测 v2 接口…</div>';
    return '';
  }
  function v2RefreshBtn(page, testid) {
    return '<button class="btn btn-sm" data-v2="refresh-page" data-page="' + attr(page || S.route) + '" data-testid="' + attr(testid || ('btn-refresh-' + (page || S.route))) + '">刷新</button>';
  }
  function v2Fetch(key, path, opts) {
    V2.loading[key] = true;
    return api(path, opts || {}).then(function (res) {
      V2.loading[key] = false;
      var bad = !res.ok || (res.data && typeof res.data === 'object' && res.data.ok === false && res.data.error);
      if (!bad) {
        V2.status[key] = { ok: true, kind: 'ok', http: res.status, path: path, at: Date.now() };
        return res.data;
      }
      var kind = res.network ? 'offline' : (res.status === 404 ? 'missing' : ((res.status === 401 || res.status === 403) ? 'auth' : 'error'));
      var msg = '';
      if (res.data && typeof res.data === 'object') msg = res.data.error || res.data.message || '';
      else if (typeof res.data === 'string') msg = res.data.slice(0, 120);
      V2.status[key] = { ok: false, kind: kind, http: res.status, path: path, msg: msg, at: Date.now() };
      return null;
    }, function () {
      V2.loading[key] = false;
      V2.status[key] = { ok: false, kind: 'error', http: 0, path: path };
      return null;
    });
  }
  /* v2 写操作：支持 POST / PATCH / PUT / DELETE，复用令牌引导 */
  function v2WriteMethod(method, path, body, label) {
    if (S.snapshot && S.snapshot.readOnly) { toast('只读模式：当前角色缺写权限', 'warn'); return Promise.resolve(null); }
    if (S.stale && !S.serverOk) { toast(asOfLabel() + ' · 离线只读，写操作不可用', 'warn'); return Promise.resolve(null); }
    return askTokenIfNeeded().then(function (tok) {
      if (!tok) { toast('已取消：未提供令牌', 'warn'); return null; }
      var opts = { method: method, body: body === undefined ? {} : body, token: tok };
      return api(path, opts).then(function (res) {
        if (res.status === 401) {
          setToken('');
          return askToken('令牌无效或已过期，请重新输入').then(function (tok2) {
            if (!tok2) return null;
            return api(path, { method: method, body: body === undefined ? {} : body, token: tok2 });
          });
        }
        return res;
      }).then(function (res) {
        if (!res) return null;
        if (res.status === 401) { toast(label + '失败：令牌无效（HTTP 401）', 'bad'); return null; }
        if (res.network) { toast(label + '失败：无法连接中枢', 'bad'); return null; }
        if (!res.ok) {
          var msg = (res.data && (res.data.error || res.data.message)) || ('HTTP ' + res.status);
          toast(label + '失败：' + msg, 'bad');
          return null;
        }
        if (res.data && res.data.ok === false && !res.data.needsConfirm) {
          toast(label + '失败：' + (res.data.error || '服务端拒绝'), 'bad');
          return null;
        }
        toast(label + '：已完成', 'ok');
        refreshSoon(160);
        return res.data || { ok: true };
      });
    });
  }
  function v2Post(path, body, label) { return v2WriteMethod('POST', path, body, label); }
  function v2Patch(path, body, label) { return v2WriteMethod('PATCH', path, body, label); }

  /* ---------- 数据加载 ---------- */
  function v2LoadPeers() {
    return v2Fetch('peers', '/api/v2/link/peers').then(function (data) {
      if (!data) { V2.data.peers = []; return; }
      V2.data.self = data.self || null;
      V2.data.discovery = data.discovery || null;
      V2.data.peers = v2Arr(data, ['peers', 'items', 'list']);
    });
  }
  function v2LoadPairQr() {
    return v2Fetch('pairQr', '/api/v2/link/pair/qr').then(function (data) {
      if (data && data.code) V2.data.pairQr = data;
    });
  }
  function v2LoadClipboardLatest() {
    return v2Fetch('clipboard', '/api/v2/link/clipboard/latest').then(function (data) {
      if (!data) return;
      V2.data.clipboard = data.clipboard || data.item || data || null;
    });
  }
  function v2NormTransfer(t) {
    t = t || {};
    var files = listOf(t.files);
    var normFiles = files.map(function (f) { return (f && typeof f === 'object') ? f : { name: String(f) }; });
    var total = Number(t.totalBytes || t.bytes || t.size || 0);
    var sent = Number(t.sentBytes || t.bytesSent || (t.status === 'completed' ? total : 0) || 0);
    var status = String(t.status || t.state || 'started');
    var progress = t.progress !== undefined ? Number(t.progress) : (total ? Math.min(100, Math.round(sent / total * 100)) : (status === 'completed' ? 100 : 0));
    return {
      transferId: String(t.transferId || t.id || t.transfer || ''),
      peerId: t.peerId || t.nodeId || t.peerDeviceId || t.from || t.to || '',
      peerName: t.peerName || t.nodeName || '',
      direction: t.direction || (String(t.state || '').indexOf('incoming') >= 0 ? 'receive' : 'send'),
      files: normFiles,
      totalBytes: total,
      sentBytes: sent,
      status: status,
      progress: progress,
      speedBps: Number(t.speedBps || t.speed || 0),
      sha256: t.sha256 || '',
      reason: t.reason || t.error || '',
      at: t.createdAt || t.at || t.startedAt || t.updatedAt || ''
    };
  }
  function v2MergeTransfers(list) {
    var incoming = listOf(list).map(v2NormTransfer);
    var existing = V2.data.transfers.slice();
    var used = {};
    var out = [];
    incoming.forEach(function (t) {
      used[t.transferId] = 1;
      var match = null;
      for (var i = 0; i < existing.length; i++) if (existing[i].transferId === t.transferId) { match = existing[i]; break; }
      if (match && match.progress >= t.progress && match.status === 'completed') {
        out.push(match);
      } else if (match) {
        for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) match[k] = t[k];
        out.push(match);
      } else {
        out.push(t);
      }
    });
    existing.forEach(function (t) { if (!used[t.transferId]) out.push(t); });
    V2.data.transfers = out.slice(0, 20);
  }
  function v2LoadTransfers() {
    return v2Fetch('transfers', '/api/v2/link/transfers').then(function (data) {
      if (!data) return;
      v2MergeTransfers(v2Arr(data, ['transfers', 'items', 'list']));
    });
  }
  function v2LoadNotifications() {
    return v2Fetch('notifications', '/api/v2/link/notifications').then(function (data) {
      if (!data) return;
      var list = v2Arr(data, ['notifications', 'items', 'list']);
      var seen = {};
      V2.data.notifications.forEach(function (n) { seen[(n.at || '') + '|' + (n.title || '')] = 1; });
      list.forEach(function (n) {
        var item = { app: n.app || n.from || '通知', title: n.title || '', preview: n.preview || n.text || '', at: n.at || '', from: n.from || '' };
        if (!seen[(item.at || '') + '|' + (item.title || '')]) V2.data.notifications.push(item);
      });
      V2.data.notifications = V2.data.notifications.slice(0, 20);
    });
  }
  function v2LoadAssets() {
    var f = V2.data.assetFilters;
    var q = ['limit=60', 'offset=0'];
    if (f.q) q.push('q=' + encodeURIComponent(f.q));
    if (f.kind) q.push('kind=' + encodeURIComponent(f.kind));
    if (f.device) q.push('device=' + encodeURIComponent(f.device));
    if (f.from) q.push('from=' + encodeURIComponent(f.from));
    if (f.to) q.push('to=' + encodeURIComponent(f.to));
    var path = '/api/v2/assets?' + q.join('&');
    return v2Fetch('assets', path).then(function (data) {
      if (!data) { V2.data.assets = []; return; }
      V2.data.assets = v2Arr(data, ['assets', 'items', 'list']);
      V2.data.assetTotal = data.total !== undefined ? data.total : V2.data.assets.length;
    });
  }
  function v2LoadAssetStats() {
    return v2Fetch('assetStats', '/api/v2/assets/stats').then(function (data) {
      if (data) V2.data.assetStats = data;
    });
  }
  function v2LoadAssetDetail(id) {
    if (!id) return Promise.resolve();
    return v2Fetch('assetDetail', '/api/v2/assets/' + encodeURIComponent(id)).then(function (data) {
      if (!data) return;
      V2.data.assetDetail = data.asset || data;
      V2.data.assetLineage = data.lineage || null;
    });
  }
  function v2LoadBasket() {
    return v2Fetch('basketList', '/api/v2/assets/basket').then(function (data) {
      if (!data) return;
      V2.data.basket = v2Arr(data, ['items', 'basket', 'list']);
      V2.data.basketStats = data.stats || null;
    });
  }
  function v2LoadScenes() {
    return v2Fetch('scenes', '/api/v2/scenes').then(function (data) {
      if (!data) { V2.data.scenes = []; return; }
      V2.data.scenes = v2Arr(data, ['scenes', 'items', 'list']);
    });
  }
  function v2LoadActions() {
    return v2Fetch('model', '/api/v2/things/model').then(function (data) {
      var acts = data && (data.actions || (data.model && data.model.actions));
      if (Array.isArray(acts) && acts.length) V2.data.actions = acts;
      else if (!V2.data.actions.length) V2.data.actions = V2_LOCAL_ACTIONS.slice();
    });
  }
  function v2LoadOrgUsers() {
    return v2Fetch('orgUsers', '/api/v2/org/users').then(function (data) {
      if (!data) return;
      V2.data.orgUsers = v2Arr(data, ['users', 'items', 'list', 'members']);
      V2.data.orgRoles = v2Arr(data, ['roles']);
      if (data.actor && data.actor.userId) V2.data.actor = data.actor.userId;
    });
  }
  function v2LoadPolicy() {
    return v2Fetch('policy', '/api/v2/org/policy').then(function (data) {
      if (data) V2.data.policy = data.policy || data;
    });
  }
  function v2LoadApprovals() {
    return v2Fetch('approvals', '/api/v2/approvals').then(function (data) {
      if (!data) return;
      V2.data.approvals = v2Arr(data, ['approvals', 'items', 'list']);
    });
  }
  function v2RefreshPage(page) {
    page = page || S.route;
    if (page === 'link') return Promise.all([v2LoadPeers(), v2LoadPairQr(), v2LoadClipboardLatest(), v2LoadTransfers(), v2LoadNotifications()]);
    if (page === 'assets') return Promise.all([v2LoadAssets(), v2LoadAssetStats()]);
    if (page === 'basket') return Promise.all([v2LoadBasket(), v2LoadAssets(), v2LoadPeers()]);
    if (page === 'scenes') return Promise.all([v2LoadScenes(), v2LoadActions()]);
    if (page === 'enterprise') {
      return Promise.all([v2LoadOrgUsers(), v2LoadPolicy(), v2LoadApprovals(), v2LoadActions()]).then(function () {
        if (!V2.data.policy) V2.data.policy = { approvalRequiredForIrreversible: true, auditRetentionDays: 30, retentionOptions: [7, 30, 180] };
      });
    }
    if (page === 'super' || page === 'handoff') return superLoadState();
    return Promise.resolve();
  }
  function v2EnsureLoaded(route) {
    route = route || S.route;
    if (!v2IsRoute(route)) return;
    var now = Date.now();
    if (V2.loading[route + ':all']) return;
    if (V2.loaded[route] && now - V2.loaded[route] < 12000) return;
    V2.loaded[route] = now;
    V2.loading[route + ':all'] = true;
    v2RefreshPage(route).then(function () {
      V2.loading[route + ':all'] = false;
      render();
    });
  }

  /* ---------- 配对 / 二维码 ---------- */
  function v2PairingInfo() {
    var q = V2.data.pairQr;
    if (q && q.code) {
      return {
        code: String(q.code),
        qr: q.qr || '',
        host: (q.host || location.hostname) + (q.port ? ':' + q.port : ''),
        hostRaw: q.host || location.hostname,
        port: q.port || location.port || '',
        expiresAt: q.expiresAt || '',
        ttlMs: q.ttlMs || 0,
        deviceId: q.deviceId || (V2.data.self && V2.data.self.deviceId) || '',
        name: q.name || (V2.data.self && V2.data.self.name) || '',
        platform: q.platform || '',
        source: 'backend',
        fingerprint: ''
      };
    }
    return { code: '', qr: '', host: '', hostRaw: '', port: '', expiresAt: '', ttlMs: 0, deviceId: '', name: '', platform: '', source: 'missing', fingerprint: '' };
  }
  function v2PairPayload() {
    var info = v2PairingInfo();
    return info.qr ? String(info.qr) : '';
  }
  function v2AfterRender() {
    if (S.route !== 'link') return;
    var canvas = $('#pair-qr');
    if (!canvas) return;
    var payload = v2PairPayload();
    if (!payload) { canvas.setAttribute('data-ok', '0'); return; }
    try {
      if (!window.TenonQR || typeof window.TenonQR.render !== 'function') throw new Error('qr.js 未加载');
      window.TenonQR.render(canvas, payload, { size: 148, margin: 3 });
      canvas.setAttribute('data-ok', '1');
    } catch (err) {
      window.__tenonErrors.push('qr fallback: ' + String((err && err.message) || err));
      canvas.setAttribute('data-ok', '0');
      var ctx = canvas.getContext && canvas.getContext('2d');
      if (ctx) {
        canvas.width = 148;
        canvas.height = 148;
        ctx.fillStyle = '#0c1524';
        ctx.fillRect(0, 0, 148, 148);
        ctx.fillStyle = '#8fa3bd';
        ctx.font = '11px ui-monospace, monospace';
        ctx.fillText('二维码不可用', 10, 46);
        ctx.fillText('请使用配对码手动配对', 10, 66);
      }
    }
  }
  function v2DoPair() {
    var input = $('#pair-code-input');
    var code = input ? String(input.value || '').replace(/\D/g, '') : '';
    if (!/^\d{4,8}$/.test(code)) { toast('请输入对方显示的 4–8 位配对码', 'warn'); if (input) { try { input.focus(); } catch (_) {} } return; }
    v2Post('/api/v2/link/pair', { code: code }, '配对设备').then(function (data) {
      if (!data) return;
      if (input) input.value = '';
      v2RefreshPage('link').then(function () { render(); });
    });
  }
  function v2DoRegenerate() {
    v2Post('/api/v2/link/pair/regenerate', {}, '刷新配对码').then(function (data) {
      if (!data) return;
      v2LoadPairQr().then(function () { render(); });
    });
  }
  function v2DoRevoke(peerId) {
    if (!peerId) return;
    v2ConfirmOpen('撤销信任设备', '撤销后该设备不能再向本机发起任务或传输。', '<div class="tiny muted">设备：<code>' + esc(peerId) + '</code></div>', function () {
      return v2Post('/api/v2/link/revoke', { peerId: peerId }, '撤销信任').then(function (data) {
        if (data) v2RefreshPage('link').then(function () { render(); });
      });
    });
  }

  /* ---------- 文件传输 ---------- */
  function v2FindTransfer(id) {
    for (var i = 0; i < V2.data.transfers.length; i++) if (V2.data.transfers[i].transferId === id) return V2.data.transfers[i];
    return null;
  }
  function v2UpsertTransfer(t) {
    var cur = v2FindTransfer(t.transferId);
    if (cur) { for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) cur[k] = t[k]; return cur; }
    var norm = v2NormTransfer(t);
    V2.data.transfers.unshift(norm);
    if (V2.data.transfers.length > 20) V2.data.transfers.length = 20;
    return norm;
  }
  function v2PatchTransfers() {
    var rows = $$('[data-testid="transfer-row"]');
    for (var i = 0; i < rows.length; i++) {
      var t = v2FindTransfer(rows[i].getAttribute('data-transfer-id'));
      if (!t) continue;
      var bar = rows[i].querySelector('.progress > i');
      if (bar) bar.style.width = Math.max(0, Math.min(100, t.progress || 0)) + '%';
      var st = rows[i].querySelector('[data-role="transfer-status"]');
      if (st) st.textContent = v2TransferStatusText(t);
    }
  }
  function v2TransferStatusText(t) {
    var map = { started: '已发起', uploading: '传输中', receiving: '接收中', finishing: '校验 SHA-256…', completed: '已完成 · 校验通过', failed: '失败', cancelled: '已取消', staged: '待确认', queued: '排队中' };
    var s = map[t.status] || t.status;
    if (t.status === 'uploading' || t.status === 'receiving') s += ' ' + (t.progress || 0) + '% · ' + v2Speed(t.speedBps);
    if (t.status === 'completed') {
      if (t.totalBytes) s += ' · ' + v2Bytes(t.totalBytes);
      if (t.sha256) s += ' · SHA-256 ' + String(t.sha256).slice(0, 10) + '…';
    }
    if (t.reason) s += ' · ' + t.reason;
    return s;
  }
  function v2TransferFilesText(t) {
    var files = listOf(t.files);
    if (!files.length) return '（未知文件）';
    var names = files.map(function (f) { return (f && f.name) ? f.name : '文件'; });
    if (names.length <= 2) return names.join('、');
    return names.slice(0, 2).join('、') + ' 等 ' + names.length + ' 个';
  }
  function v2StartUpload() {
    var input = $('#transfer-files');
    var peerSel = $('#transfer-peer');
    var files = input && input.files ? Array.prototype.slice.call(input.files) : [];
    if (!files.length) { toast('先选择要发送的文件', 'warn'); return; }
    var peerId = peerSel ? peerSel.value : '';
    if (!peerId) { toast('先选择已配对的目标设备', 'warn'); return; }
    var meta = files.map(function (f) { return { name: f.name, size: f.size }; });
    var total = files.reduce(function (a, f) { return a + f.size; }, 0);
    v2Post('/api/v2/link/transfer/init', { peerId: peerId, direction: 'send', files: meta }, '发起文件传输').then(function (data) {
      if (!data || !data.transferId) return;
      var transferId = data.transferId;
      var chunkSize = Number(data.chunkSize) || 1048576;
      v2UpsertTransfer({ transferId: transferId, peerId: peerId, direction: 'send', files: meta, totalBytes: total, status: 'uploading', progress: 0, at: nowIso() });
      render();
      v2UploadAll(transferId, chunkSize, files, total).then(function () {
        v2UpsertTransfer({ transferId: transferId, status: 'finishing', progress: 100 });
        v2PatchTransfers();
        return v2Post('/api/v2/link/transfer/' + encodeURIComponent(transferId) + '/finish', {}, '完成文件传输');
      }).then(function (fin) {
        v2UpsertTransfer({ transferId: transferId, status: 'completed', progress: 100, sha256: (fin && (fin.sha256 || (fin.result && fin.result.sha256))) || '' });
        v2PatchTransfers();
        render();
      }).catch(function (err) {
        v2UpsertTransfer({ transferId: transferId, status: 'failed', reason: String((err && err.message) || err) });
        v2PatchTransfers();
        toast('传输失败：' + String((err && err.message) || err), 'bad');
      });
    });
  }
  function v2UploadAll(transferId, chunkSize, files, total) {
    var fi = 0, off = 0, sent = 0;
    function step() {
      if (fi >= files.length) return Promise.resolve();
      var file = files[fi];
      if (off >= file.size) { fi++; off = 0; return step(); }
      var end = Math.min(off + chunkSize, file.size);
      var blob = file.slice(off, end);
      var tok = getToken();
      var started = Date.now();
      var headers = { 'Content-Type': 'application/octet-stream' };
      if (tok) headers['x-tenon-token'] = tok;
      return fetch('/api/v2/link/transfer/' + encodeURIComponent(transferId) + '/chunk?offset=' + sent, {
        method: 'PUT', headers: headers, body: blob, credentials: 'same-origin'
      }).then(function (res) {
        if (!res.ok) throw new Error(res.status === 401 ? '需要操作令牌（HTTP 401）' : ('分块上传失败 HTTP ' + res.status));
        sent += blob.size;
        off = end;
        var t = v2FindTransfer(transferId);
        if (t) {
          t.sentBytes = sent; t.totalBytes = total;
          t.progress = total ? Math.min(99, Math.round(sent / total * 100)) : 0;
          t.speedBps = Math.round(blob.size / Math.max(0.001, (Date.now() - started) / 1000));
        }
        v2PatchTransfers();
        return step();
      });
    }
    return step();
  }

  /* ---------- 剪贴板 ---------- */
  function v2SendClipboard() {
    var input = $('#clipboard-input');
    var kindSel = $('#clipboard-kind');
    var text = input ? String(input.value || '').trim() : '';
    if (!text) { toast('先输入要互传的文本或链接', 'warn'); return; }
    var kind = kindSel ? kindSel.value : 'text';
    v2Post('/api/v2/link/clipboard', { kind: kind, text: text, from: 'web-ui' }, '发送剪贴板').then(function (data) {
      if (!data) return;
      if (input) input.value = '';
      V2.data.clipHistory.unshift({ kind: kind, text: text, at: nowIso(), direction: 'send' });
      if (V2.data.clipHistory.length > 20) V2.data.clipHistory.length = 20;
      v2LoadClipboardLatest().then(function () { render(); });
    });
  }

  /* ---------- 素材库 ---------- */
  function v2AssetKind(kind) {
    var m = { image: '图片', video: '视频', audio: '音频', doc: '文档', pdf: 'PDF', other: '其他' };
    return m[kind] || kind || '素材';
  }
  function v2AssetThumbUrl(a, w) {
    var id = a.id || a.assetId;
    var urls = a.thumbUrls;
    if (urls && urls[String(w)]) return urls[String(w)];
    if (urls && urls[w]) return urls[w];
    return '/api/v2/assets/' + encodeURIComponent(id) + '/thumb?w=' + (w || 320);
  }
  function v2AssetHasThumb(a) {
    return !!(a && (a.thumbUrls || a.thumb) && !a.thumbError);
  }
  function v2AssetTags(a) { return listOf(a && a.tags); }
  function v2AssetOcrText(a) {
    if (!a) return '';
    if (a.ocr && a.ocr.text) return a.ocr.text;
    return a.ocrText || '';
  }
  function v2AssetSource(a) {
    var s = objOf(a && a.source);
    return (s.deviceId ? s.deviceId : '未知设备') + (s.path ? ' · ' + s.path : '');
  }
  function v2AssetDeviceOptions() {
    var seen = {}, out = [];
    var add = function (id, label) { if (!id || seen[id]) return; seen[id] = 1; out.push({ id: id, label: label || id }); };
    var st = V2.data.assetStats;
    if (st && st.byDevice) for (var k in st.byDevice) add(k, k);
    nodesList().forEach(function (n) { add(n.id, n.name + '（' + n.id + '）'); });
    add('node-local', 'node-local');
    return out;
  }
  function v2AssetSelected(id) { return V2.data.assetSelection.indexOf(id) >= 0; }
  function v2ToggleAssetSelect(id) {
    var i = V2.data.assetSelection.indexOf(id);
    if (i >= 0) V2.data.assetSelection.splice(i, 1);
    else V2.data.assetSelection.push(id);
  }
  function v2OpenAsset(id) {
    V2.data.assetDetail = null;
    V2.data.assetLineage = null;
    v2LoadAssetDetail(id).then(function () { render(); });
  }
  function v2AddSelectedToBasket() {
    if (!V2.data.assetSelection.length) { toast('先勾选要加入中转站的素材', 'warn'); return; }
    v2AddToBasket(V2.data.assetSelection.slice(), '#asset-basket-target');
  }
  function v2AddAssetToBasket(id) {
    if (!id) return;
    v2AddToBasket([id], '#asset-basket-target');
  }
  function v2AddToBasket(ids, targetSel) {
    var target = $(targetSel || '#asset-basket-target');
    var to = target ? target.value : '';
    var items = ids.map(function (id) { return { assetId: id }; });
    v2Post('/api/v2/assets/basket', { items: items, to: to || undefined, note: 'web-ui' }, '加入中转站').then(function (data) {
      if (!data) return;
      V2.data.assetSelection = [];
      v2LoadBasket().then(function () { render(); });
    });
  }
  function v2AddTag() {
    var a = V2.data.assetDetail;
    if (!a) return;
    var input = $('#asset-tag-input');
    var tags = String(input ? input.value : '').split(/[，,\s]+/).filter(Boolean);
    if (!tags.length) { toast('先输入标签（逗号分隔）', 'warn'); return; }
    v2Post('/api/v2/assets/' + encodeURIComponent(a.id || a.assetId) + '/tags', { tags: tags }, '素材打标签').then(function (data) {
      if (!data) return;
      if (input) input.value = '';
      V2.data.assetDetail = data.asset || a;
      render();
    });
  }

  /* ---------- 中转站 ---------- */
  function v2BasketId(item) { return item.id || item.basketId || item.assetId; }
  function v2BasketStaged(items) {
    return listOf(items || V2.data.basket).filter(function (b) { return (b.status || 'staged') === 'staged'; });
  }
  function v2BasketTake(ids) {
    var staged = v2BasketStaged();
    var takeIds = listOf(ids).length ? ids : staged.map(v2BasketId);
    if (!takeIds.length) { toast('中转站没有待取用的条目', 'warn'); return; }
    var sel = $('#basket-target');
    var to = sel ? sel.value : (V2.data.basketTarget || '');
    v2Post('/api/v2/assets/basket/take', { ids: takeIds, to: to || undefined }, '中转站取用').then(function (data) {
      if (!data) return;
      toast('已取用 ' + ((data.taken || takeIds).length) + ' 项' + (to ? ' → ' + to : ''), 'ok');
      v2LoadBasket().then(function () { render(); });
    });
  }
  function v2BasketClear() {
    var staged = v2BasketStaged();
    if (!staged.length) { toast('没有待取用的条目可清空', 'warn'); return; }
    v2WriteMethod('DELETE', '/api/v2/assets/basket', { ids: staged.map(v2BasketId) }, '清空中转站').then(function (data) {
      if (data) { v2LoadBasket().then(function () { render(); }); return; }
      v2Post('/api/v2/assets/basket/take', { ids: staged.map(v2BasketId) }, '逐条取用清空').then(function (d2) {
        if (d2) v2LoadBasket().then(function () { render(); });
      });
    });
  }

  /* ---------- 场景 ---------- */
  function v2ActionById(id) {
    var acts = V2.data.actions.length ? V2.data.actions : V2_LOCAL_ACTIONS;
    for (var i = 0; i < acts.length; i++) {
      if (acts[i].id === id || acts[i].actionId === id) return acts[i];
    }
    for (var j = 0; j < V2_LOCAL_ACTIONS.length; j++) if (V2_LOCAL_ACTIONS[j].id === id) return V2_LOCAL_ACTIONS[j];
    return null;
  }
  function v2StepRisk(step) {
    var a = v2ActionById(step && (step.actionId || step.id || step.action));
    if (a && a.risk) return a.risk;
    if (step && step.risk) return step.risk;
    return 'reversible';
  }
  function v2StepNeedsConfirm(step) {
    var a = v2ActionById(step && (step.actionId || step.id || step.action));
    return !!(step && step.needsConfirm) || !!(a && (a.requiresConfirmation || a.risk === 'irreversible'));
  }
  function v2ActionDefaultParams(actionId) {
    var act = v2ActionById(actionId);
    var schema = act && act.params;
    var out = {};
    if (schema && schema.properties) {
      for (var k in schema.properties) {
        var p = schema.properties[k] || {};
        if (p.default !== undefined) out[k] = p.default;
        else if (p.type === 'integer' || p.type === 'number') out[k] = p.minimum !== undefined ? p.minimum : 1;
        else if (p.type === 'boolean') out[k] = false;
        else if (p.type === 'array') out[k] = [];
        else out[k] = '';
      }
    }
    return out;
  }
  function v2ActionRequiredParams(actionId) {
    var act = v2ActionById(actionId);
    return (act && act.params && listOf(act.params.required)) || [];
  }
  function v2SceneAddStep() {
    var first = (V2.data.actions[0] && V2.data.actions[0].id) || 'asset.backup';
    V2.data.sceneDraftSteps.push({ actionId: first, targetDeviceId: '', params: JSON.stringify(v2ActionDefaultParams(first)) });
    render(true);
  }
  function v2SceneDelStep(idx) {
    V2.data.sceneDraftSteps.splice(Number(idx) || 0, 1);
    render(true);
  }
  function v2SceneSave() {
    var nameEl = $('#scene-name');
    var name = nameEl ? String(nameEl.value || '').trim() : '';
    if (!name) { toast('先给场景起个名字', 'warn'); return; }
    if (!V2.data.sceneDraftSteps.length) { toast('至少添加一个步骤', 'warn'); return; }
    var steps = [];
    var bad = '';
    V2.data.sceneDraftSteps.forEach(function (st) {
      var params = {};
      try { params = st.params ? JSON.parse(st.params) : {}; } catch (_) { bad = '参数 JSON 格式错误：' + st.actionId; params = null; }
      if (params === null) return;
      var req = v2ActionRequiredParams(st.actionId);
      for (var i = 0; i < req.length; i++) {
        if (params[req[i]] === undefined || params[req[i]] === '') { bad = '缺少必填参数「' + req[i] + '」：' + st.actionId; }
      }
      steps.push({ actionId: st.actionId, params: params, targetDeviceId: st.targetDeviceId || '', needsConfirm: v2StepNeedsConfirm(st) });
    });
    if (bad) { toast(bad, 'warn', 5200); return; }
    v2Post('/api/v2/scenes', { name: name, steps: steps }, '保存场景').then(function (data) {
      if (!data) return;
      V2.data.sceneFormOpen = false;
      V2.data.sceneDraftSteps = [];
      v2RefreshPage('scenes').then(function () { render(); });
    });
  }
  function v2SceneFind(id) {
    for (var i = 0; i < V2.data.scenes.length; i++) {
      if (String(V2.data.scenes[i].id || V2.data.scenes[i].sceneId) === String(id)) return V2.data.scenes[i];
    }
    return null;
  }
  function v2PushSceneRun(rec) {
    var ts = new Date(rec.at).getTime() || Date.now();
    for (var i = 0; i < V2.data.sceneRuns.length; i++) {
      var r = V2.data.sceneRuns[i];
      if (String(r.sceneId) === String(rec.sceneId) &&
          Math.abs((new Date(r.at).getTime() || 0) - ts) < 8000 &&
          String(r.summary || '') === String(rec.summary || '')) return;
    }
    V2.data.sceneRuns.unshift(rec);
    if (V2.data.sceneRuns.length > 20) V2.data.sceneRuns.length = 20;
  }
  function v2SceneRecordRun(scene, data) {
    data = data || {};
    v2PushSceneRun({
      sceneId: data.sceneId || (scene && scene.id),
      name: data.name || (scene && scene.name) || '',
      by: data.by || V2.data.actor,
      at: data.finishedAt || data.startedAt || nowIso(),
      ok: data.ok !== false,
      summary: data.summary || (listOf(data.steps).filter(function (s) { return s.ok; }).length + ' 步完成'),
      taskIds: data.taskIds || []
    });
  }
  function v2SceneRun(sceneId) {
    var scene = v2SceneFind(sceneId);
    if (!scene) { toast('场景不存在', 'bad'); return; }
    function doRun() {
      return v2Post('/api/v2/scenes/' + encodeURIComponent(sceneId) + '/run', { confirmed: true, by: V2.data.actor }, '执行场景').then(function (data) {
        if (!data) return;
        if (data.ok === false && data.needsConfirm && listOf(data.confirmReasons).length) {
          v2ShowConfirmThenRun(scene, data);
          return;
        }
        if (data.ok === false && (data.approvalRequired || data.approval_required || data.approvalId)) {
          toast('该场景需要审批：已提交审批请求，等待管理员通过', 'warn', 5200);
          v2RefreshPage('enterprise').then(function () { render(); });
          return;
        }
        v2SceneRecordRun(scene, data);
        v2RefreshPage('scenes').then(function () { render(); });
      });
    }
    api('/api/v2/scenes/' + encodeURIComponent(sceneId) + '/preview', { method: 'POST', body: {} }).then(function (res) {
      var p = (res && res.ok && res.data) ? res.data : null;
      var preview = p ? (p.preview || p) : null;
      if (preview && preview.needsConfirm) { v2ShowConfirmThenRun(scene, preview); return; }
      if (preview && preview.blocked) { toast('场景不可执行：' + listOf(preview.confirmReasons).join('；'), 'warn'); return; }
      if (!p && res && res.status && res.status !== 200) { toast('场景预览失败：HTTP ' + res.status, 'bad'); return; }
      doRun();
    });
  }
  function v2ShowConfirmThenRun(scene, preview) {
    var steps = listOf(preview && preview.steps);
    var reasons = listOf(preview && preview.confirmReasons);
    var body = '<div class="stack"><div>场景：<strong>' + esc(scene.name || scene.id) + '</strong></div>' +
      '<div>步骤：' + (steps.length || listOf(scene.steps).length) + ' 步，其中不可逆 ' + steps.filter(function (s) { return s.risk === 'irreversible'; }).length + ' 步</div>' +
      '<ul class="items">' + (steps.length ? steps.map(function (st, i) {
        return '<li><span class="mono dim tiny">' + (i + 1) + '</span><span>' + esc(st.actionName || st.actionId) + ' · ' + esc(st.targetDeviceName || st.targetDeviceId || '自动选择') + '</span><span class="tag amber">' + (st.risk === 'irreversible' ? '不可逆' : '可逆') + '</span></li>';
      }).join('') : listOf(scene.steps).map(function (st, i) {
        return '<li><span class="mono dim tiny">' + (i + 1) + '</span><span>' + esc(st.actionId) + '</span></li>';
      }).join('')) + '</ul>' +
      (reasons.length ? '<div class="alert alert-warn">' + reasons.map(function (r) { return esc(r); }).join('<br>') + '</div>' : '') +
      '<div class="hint-note">不可逆动作执行后不能自动撤销；取消则什么都不做。</div></div>';
    v2ConfirmOpen('执行场景 · 含不可逆动作', '将发生什么、影响谁、能否撤销——确认后才会执行。', body, function () {
      return v2Post('/api/v2/scenes/' + encodeURIComponent(scene.id) + '/run', { confirmed: true, by: V2.data.actor }, '执行场景（已确认）').then(function (data) {
        if (!data) return;
        v2SceneRecordRun(scene, data);
        v2RefreshPage('scenes').then(function () { render(); });
      });
    });
  }

  /* ---------- 企业控制台 ---------- */
  function v2PolicyObj() {
    if (!V2.data.policy) V2.data.policy = { approvalRequiredForIrreversible: true, auditRetentionDays: 30, retentionOptions: [7, 30, 180] };
    var p = V2.data.policy;
    if (!listOf(p.retentionOptions).length) p.retentionOptions = [7, 30, 180];
    return p;
  }
  function v2RoleName(id) {
    for (var i = 0; i < V2.data.orgRoles.length; i++) if (V2.data.orgRoles[i].role === id) return V2.data.orgRoles[i].label || id;
    for (var j = 0; j < V2_ROLES.length; j++) if (V2_ROLES[j].id === id) return V2_ROLES[j].name;
    return id || '成员';
  }
  function v2PermActions() {
    var ids = [], seen = {};
    var add = function (id, name, risk) {
      if (!id || seen[id]) return;
      seen[id] = 1;
      ids.push({ id: id, name: name || id, risk: risk || 'reversible' });
    };
    V2.data.actions.forEach(function (a) { add(a.id, a.name, a.risk); });
    V2_EXTRA_ACTIONS.forEach(function (id) { add(id, id, 'reversible'); });
    if (V2.data.orgRoles.length) {
      V2.data.orgRoles.forEach(function (r) { listOf(r.defaultActions).forEach(function (id) { if (id !== '*') add(id, id, 'reversible'); }); });
    }
    return ids;
  }
  function v2UserAllowed(user, actionId) {
    if (!user) return false;
    var aa = user.allowedActions;
    if (!aa) {
      for (var i = 0; i < V2.data.orgRoles.length; i++) {
        if (V2.data.orgRoles[i].role === user.role) {
          var defs = listOf(V2.data.orgRoles[i].defaultActions);
          return defs.indexOf('*') >= 0 || defs.indexOf(actionId) >= 0;
        }
      }
      return user.role === 'admin';
    }
    if (Array.isArray(aa)) return aa.indexOf('*') >= 0 || aa.indexOf(actionId) >= 0;
    var allow = listOf(aa.allow);
    return allow.indexOf('*') >= 0 || allow.indexOf(actionId) >= 0;
  }
  function v2OrgAddUser() {
    var nameEl = $('#org-user-name');
    var roleEl = $('#org-user-role');
    var name = nameEl ? String(nameEl.value || '').trim() : '';
    var role = roleEl ? roleEl.value : 'member';
    if (!name) { toast('先输入成员名称', 'warn'); return; }
    v2Post('/api/v2/org/users', { name: name, role: role }, '新增成员').then(function (data) {
      if (!data) return;
      if (nameEl) nameEl.value = '';
      v2RefreshPage('enterprise').then(function () { render(); });
    });
  }
  function v2OrgSelectUser(userId) {
    V2.data.editUserId = (V2.data.editUserId === userId) ? '' : userId;
    render(true);
  }
  function v2OrgSaveUser() {
    var uid = V2.data.editUserId;
    if (!uid) return;
    var roleEl = $('#org-edit-role');
    var role = roleEl ? roleEl.value : 'member';
    var allowed = [];
    var boxes = $$('[data-v2-perm]');
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) allowed.push(boxes[i].getAttribute('data-action-id'));
    var payload = { role: role };
    if (role !== 'admin') payload.allowedActions = allowed;
    v2Patch('/api/v2/org/users/' + encodeURIComponent(uid), payload, '保存成员权限').then(function (data) {
      if (!data) { v2RefreshPage('enterprise').then(function () { render(); }); return; }
      if (data.user) {
        for (var j = 0; j < V2.data.orgUsers.length; j++) if (V2.data.orgUsers[j].userId === uid) V2.data.orgUsers[j] = data.user;
      }
      v2RefreshPage('enterprise').then(function () { render(); });
    });
  }
  function v2OrgActivateUser() {
    var uid = V2.data.editUserId;
    if (!uid) return;
    v2Patch('/api/v2/org/users/' + encodeURIComponent(uid), { status: 'active' }, '启用成员').then(function (data) {
      if (data) v2RefreshPage('enterprise').then(function () { render(); });
    });
  }
  function v2SavePolicy() {
    var p = v2PolicyObj();
    var retentionEl = $('#org-policy-retention');
    var approvalEl = $('#org-approval-toggle');
    var payload = {
      approvalRequiredForIrreversible: approvalEl ? !!approvalEl.checked : !!p.approvalRequiredForIrreversible,
      auditRetentionDays: retentionEl ? Number(retentionEl.value) || p.auditRetentionDays || 30 : p.auditRetentionDays || 30
    };
    v2Patch('/api/v2/org/policy', payload, '保存企业策略').then(function (data) {
      if (!data) return;
      v2LoadPolicy().then(function () { render(); });
    });
  }
  function v2ApprovalDecide(id, ok) {
    if (!id) return;
    v2Post('/api/v2/approvals/' + encodeURIComponent(id) + '/decide', { ok: !!ok, reason: ok ? '前端通过' : '前端拒绝' }, ok ? '通过审批' : '拒绝审批').then(function (data) {
      if (!data) return;
      v2RefreshPage('enterprise').then(function () { render(); });
    });
  }
  function v2ExportAudit(format) {
    download('/api/v2/org/audit/export?format=' + encodeURIComponent(format || 'csv'), 'tenon-v2-audit.' + (format || 'csv'));
  }

  /* ---------- 通用确认弹窗 ---------- */
  function v2ConfirmOpen(title, sub, bodyHtml, onOk) {
    V2.confirm = { onOk: onOk };
    setText('#v2-confirm-title', title || '确认执行');
    setText('#v2-confirm-sub', sub || '');
    var body = $('#v2-confirm-body');
    if (body) body.innerHTML = bodyHtml || '';
    var m = $('#v2-confirm-modal');
    if (m) m.classList.remove('hidden');
  }
  function v2ConfirmClose() {
    V2.confirm = null;
    var m = $('#v2-confirm-modal');
    if (m) m.classList.add('hidden');
    flushPendingRender();
  }
  function v2ConfirmOk() {
    var cb = V2.confirm && V2.confirm.onOk;
    v2ConfirmClose();
    if (typeof cb === 'function') {
      var p = cb();
      if (p && p.catch) p.catch(function () {});
    }
  }

  /* ---------- 表单状态保留（重绘不丢输入） ---------- */
  function v2CaptureForm() {
    var out = { values: {}, checks: {}, focus: null, selStart: 0, selEnd: 0 };
    var els = $$('[data-keep]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = el.getAttribute('data-keep') || el.id;
      if (!key) continue;
      if (el.type === 'checkbox') out.checks[key] = !!el.checked;
      else out.values[key] = el.value;
    }
    var active = document.activeElement;
    if (active && active.getAttribute && active.getAttribute('data-keep')) {
      out.focus = active.getAttribute('data-keep') || active.id;
      try { out.selStart = active.selectionStart; out.selEnd = active.selectionEnd; } catch (_) {}
    }
    return out;
  }
  function v2RestoreForm(saved) {
    if (!saved) return;
    $$('[data-keep]').forEach(function (el) {
      var key = el.getAttribute('data-keep') || el.id;
      if (!key) return;
      if (el.type === 'checkbox' && Object.prototype.hasOwnProperty.call(saved.checks, key)) el.checked = saved.checks[key];
      else if (Object.prototype.hasOwnProperty.call(saved.values, key)) el.value = saved.values[key];
    });
    if (saved.focus) {
      var target = document.querySelector('[data-keep="' + saved.focus + '"]');
      if (target) {
        try {
          target.focus();
          if (target.setSelectionRange) target.setSelectionRange(saved.selStart || 0, saved.selEnd || 0);
        } catch (_) {}
      }
    }
  }

  /* ---------- 渲染：互联 ---------- */
  function v2PeerId(p) { return p.id || p.peerId || p.deviceId || ''; }
  function v2PeerTrusted(p) {
    if (p.trusted !== undefined) return !!p.trusted;
    if (p.paired !== undefined) return !!p.paired;
    return p.status === 'trusted' || p.status === 'paired';
  }
  function v2PeerRow(p) {
    var id = v2PeerId(p);
    var trusted = v2PeerTrusted(p);
    var online = p.online !== false;
    var name = p.name || p.deviceName || id || '未命名设备';
    var meta = [p.platform || '未知平台', (p.host || p.ip || '') + (p.port ? ':' + p.port : ''), p.fingerprint ? '指纹 ' + String(p.fingerprint).slice(0, 12) : ''].filter(Boolean).join(' · ');
    return '<div class="peer-row" data-testid="link-peer" data-peer-id="' + attr(id) + '">' +
      '<span class="online-dot ' + (online ? 'on' : 'off') + '"></span>' +
      '<div class="peer-main"><div class="peer-name" data-testid="link-peer-name">' + esc(name) + '</div><div class="peer-meta">' + esc(meta) + '</div></div>' +
      '<div class="peer-badges">' +
      (trusted ? '<span class="badge no-dot b-ok">已信任</span>' : '<span class="badge no-dot b-warn">未配对</span>') +
      (online ? '<span class="badge no-dot b-ok">在线</span>' : '<span class="badge no-dot b-muted">离线</span>') +
      '</div>' +
      '<div class="peer-actions">' +
      (trusted ? '<button class="btn btn-sm" data-v2="revoke" data-peer-id="' + attr(id) + '" data-testid="btn-revoke">撤销信任</button>' : '') +
      '</div></div>';
  }
  function v2RenderLink() {
    var keys = ['peers', 'pairQr', 'clipboard', 'transfers'];
    var peers = V2.data.peers;
    var trusted = peers.filter(v2PeerTrusted);
    var info = v2PairingInfo();
    var self = V2.data.self;
    var html = pageHead('互联', '同一 WiFi 自动发现、扫码/配对码配对、文件互传（分块 + SHA-256）、剪贴板与通知镜像；零外网依赖。', v2RefreshBtn('link', 'btn-refresh-link'));
    html += v2Degrade(keys, '互联接口') + v2LoadingNote(keys);
    html += '<div class="v2-grid-2">';
    html += '<div class="card v2-card"><div class="card-title">配对 <span class="tiny dim">配对码 2 分钟内有效</span></div>' +
      '<div class="pair-panel"><div class="qr-box"><canvas id="pair-qr" data-testid="pair-qr" class="qr-canvas"></canvas>' +
      '<div class="tiny dim" style="margin-top:6px">手机扫码或输入配对码</div></div>' +
      '<div class="pair-side"><div class="q-index">本机配对码</div>' +
      '<div class="pair-code num" data-testid="pair-code">' + (info.code ? esc(info.code.replace(/(\d{3})(\d{3})/, '$1 $2')) : '— — —') + '</div>' +
      '<div class="hint-note" data-testid="pair-status">' + (info.code
        ? 'host ' + esc(info.host) + (info.expiresAt ? ' · 有效期至 ' + esc(fullTime(info.expiresAt)) : '') + ' · 刷新后旧码失效'
        : '配对码接口未就绪（GET /api/v2/link/pair/qr）') + '</div>' +
      '<div class="form-row" style="margin-top:8px">' +
      '<input type="text" id="pair-code-input" data-testid="pair-code-input" data-keep="pair-code-input" placeholder="输入对方 6 位配对码" inputmode="numeric" maxlength="8" style="max-width:170px">' +
      '<button class="btn btn-primary btn-sm" data-v2="pair" data-testid="btn-pair">配对</button>' +
      '<button class="btn btn-sm" data-v2="pair-regenerate" data-testid="btn-pair-regenerate">刷新配对码</button>' +
      '</div>' +
      '<div class="mini-kv" style="margin-top:10px">' +
      '<span class="k">本机</span><span class="v">' + esc((self && self.name) || info.name || '未知') + ' <span class="mono dim">' + esc((self && self.deviceId) || info.deviceId || '') + '</span></span>' +
      '<span class="k">平台</span><span class="v">' + esc((self && self.platform) || info.platform || '未知') + '</span>' +
      '<span class="k">地址</span><span class="v mono">' + esc((self && self.host ? self.host + ':' + self.port : info.host || '未知')) + '</span>' +
      '<span class="k">发现</span><span class="v">' + ((V2.data.discovery && V2.data.discovery.enabled) ? 'UDP 已开启（端口 ' + esc(V2.data.discovery.port) + '）' : '未开启') + '</span>' +
      '</div></div></div></div>';
    html += '<div class="card v2-card"><div class="card-title">已发现设备 <span class="count mono">' + peers.length + '</span> <span class="tiny dim">已信任 ' + trusted.length + '</span></div>' +
      '<div class="v2-list" data-testid="link-peer-list">' +
      (peers.length ? peers.map(v2PeerRow).join('') : emptyBlock('未发现设备', '同一 WiFi 下的手机会自动出现；也可用配对码手动配对。')) +
      '</div><div class="hint-note" style="margin-top:8px">发现接口：<code>GET /api/v2/link/peers</code> · 配对：<code>POST /api/v2/link/pair</code> · 撤销：<code>POST /api/v2/link/revoke</code></div></div>';
    html += '</div>';
    html += '<div class="section"><div class="section-head"><h2>文件传输</h2><span class="hint">分块 PUT / 断点续传 / SHA-256 校验 · 列表来自 GET /api/v2/link/transfers</span></div>' +
      '<div class="card v2-card"><div class="form-row">' +
      '<div class="field" style="max-width:220px"><label>目标设备</label><select id="transfer-peer" data-testid="transfer-peer" data-keep="transfer-peer"><option value="">选择已配对设备</option>' +
      peers.map(function (p) { return '<option value="' + attr(v2PeerId(p)) + '">' + esc(p.name || v2PeerId(p)) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field" style="min-width:240px"><label>选择文件（可多选）</label><input type="file" id="transfer-files" data-testid="transfer-file-input" multiple></div>' +
      '<button class="btn btn-primary btn-sm" data-v2="transfer-send" data-testid="btn-transfer-send">发送到设备</button>' +
      '</div>' +
      '<div class="v2-list" data-testid="transfer-list" style="margin-top:10px">' +
      (V2.data.transfers.length ? V2.data.transfers.map(function (t) {
        var pct = Math.max(0, Math.min(100, t.progress || 0));
        return '<div class="transfer-row" data-testid="transfer-row" data-transfer-id="' + attr(t.transferId) + '">' +
          '<div class="transfer-main"><div class="transfer-name">' + esc(v2TransferFilesText(t)) + '</div>' +
          '<div class="tiny dim">' + esc(t.direction === 'receive' ? '接收 ← ' + (t.peerName || t.peerId) : '发送 → ' + (t.peerName || t.peerId)) + ' · ' + v2Bytes(t.totalBytes || 0) + '</div></div>' +
          '<div class="progress" data-testid="transfer-progress"><i style="width:' + pct + '%"></i></div>' +
          '<div class="transfer-status tiny" data-role="transfer-status" data-testid="transfer-status">' + esc(v2TransferStatusText(t)) + '</div>' +
          '</div>';
      }).join('') : emptyBlock('还没有传输记录', '选择文件并发送后显示进度、速度与 SHA-256 校验结果；对端发起的接收记录也会出现。')) +
      '</div></div></div>';
    var clip = V2.data.clipboard;
    html += '<div class="section"><div class="section-head"><h2>剪贴板与通知</h2><span class="hint">Android 前台场景 ≤2s；桌面复制 → 手机通知</span></div>' +
      '<div class="v2-grid-2">';
    html += '<div class="card v2-card"><div class="card-title">剪贴板互传</div>' +
      '<div class="form-row"><div class="field" style="flex:2"><label>要发送的文本 / 链接</label><textarea id="clipboard-input" data-testid="clipboard-input" data-keep="clipboard-input" rows="2" placeholder="复制一段文本或链接，发给已配对手机"></textarea></div>' +
      '<div class="field" style="max-width:120px"><label>类型</label><select id="clipboard-kind" data-testid="clipboard-kind" data-keep="clipboard-kind"><option value="text">文本</option><option value="link">链接</option></select></div>' +
      '<button class="btn btn-primary btn-sm" data-v2="clipboard-send" data-testid="btn-clipboard-send">发送</button></div>' +
      '<div class="clip-latest" data-testid="clipboard-latest" style="margin-top:10px">' +
      '<div class="q-index">最近接收</div>' + (clip ? '<div class="clip-text">' + esc(clip.preview || clip.text || '（空内容）') + '</div><div class="tiny dim">' + esc(clip.from ? '来自 ' + clip.from + ' · ' : '') + esc(dateOf(clip.at)) + '</div>' : '<div class="tiny dim">暂无接收记录</div>') + '</div>' +
      '<div class="v2-list" data-testid="clipboard-history" style="margin-top:10px">' +
      (V2.data.clipHistory.length ? V2.data.clipHistory.map(function (c) {
        return '<div class="clip-row" data-testid="clipboard-item"><span class="tag">' + esc(c.kind === 'link' ? '链接' : '文本') + '</span><span class="clip-text">' + esc(String(c.text || '').slice(0, 120)) + '</span><span class="dim tiny">' + esc(dateOf(c.at)) + '</span></div>';
      }).join('') : '<div class="tiny dim">本会话发送记录会出现在这里</div>') + '</div></div>';
    html += '<div class="card v2-card"><div class="card-title">通知镜像 <span class="count mono">' + V2.data.notifications.length + '</span></div>' +
      '<div class="v2-list" data-testid="notification-list">' +
      (V2.data.notifications.length ? V2.data.notifications.map(function (n) {
        return '<div class="notif-row" data-testid="notification-row"><span class="tag">' + esc(n.app || n.from || '通知') + '</span><div class="notif-main"><div>' + esc(n.title || '（无标题）') + '</div><div class="tiny dim">' + esc(String(n.preview || '').slice(0, 80)) + '</div></div><span class="dim tiny">' + esc(dateOf(n.at)) + '</span></div>';
      }).join('') : emptyBlock('暂无通知', '手机通知镜像会通过事件流与 POST /api/v2/link/notification 进来。')) + '</div></div>';
    html += '</div></div>';
    return html;
  }

  /* ---------- 渲染：素材库 ---------- */
  function v2AssetCard(a) {
    var id = a.id || a.assetId;
    var selected = v2AssetSelected(id);
    var tags = v2AssetTags(a).slice(0, 3);
    var hasThumb = v2AssetHasThumb(a);
    return '<div class="asset-card' + (selected ? ' selected' : '') + '" data-testid="asset-card" data-asset-id="' + attr(id) + '">' +
      '<div class="asset-thumb" data-v2="asset-open" data-asset-id="' + attr(id) + '">' +
      (hasThumb ? '<img data-testid="asset-thumb" loading="lazy" alt="' + attr(a.name || '素材') + '" src="' + attr(v2AssetThumbUrl(a, 320)) + '" onerror="this.style.opacity=0">' : '<div class="tiny dim" style="padding:18px">无缩略图</div>') +
      '<span class="badge no-dot b-muted asset-kind">' + esc(v2AssetKind(a.kind)) + '</span></div>' +
      '<div class="asset-meta"><div class="asset-name" title="' + attr(a.name || '') + '">' + esc(a.name || id) + '</div>' +
      '<div class="asset-sub tiny dim">' + v2Bytes(a.size) + (a.createdAt ? ' · ' + esc(dateOf(a.createdAt)) : '') + (v2AssetOcrText(a) ? ' · OCR' : '') + '</div>' +
      (tags.length ? '<div class="asset-tags">' + tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
      '</div>' +
      '<label class="asset-check" title="选择加入中转站"><input type="checkbox" data-testid="asset-select" data-asset-id="' + attr(id) + '"' + (selected ? ' checked' : '') + '></label>' +
      '</div>';
  }
  function v2RenderAssets() {
    var keys = ['assets', 'assetStats'];
    var f = V2.data.assetFilters;
    var detail = V2.data.assetDetail;
    var lineage = V2.data.assetLineage;
    var stats = objOf(V2.data.assetStats);
    var devices = v2AssetDeviceOptions();
    var html = pageHead('素材库', '自动归集、哈希去重、OCR 搜索、标签与谱系；批量选中加入中转站，手机可一次取用。', v2RefreshBtn('assets', 'btn-refresh-assets'));
    html += v2Degrade(keys, '素材接口') + v2LoadingNote(keys);
    html += '<div class="card v2-card"><div class="form-row">' +
      '<div class="field" style="flex:2;min-width:220px"><label>搜索（文件名 / OCR 文本 / 标签 / SHA-256）</label>' +
      '<input type="text" id="asset-search" data-testid="asset-search" data-keep="asset-search" placeholder="例：样品 或 发票 或 周报" value="' + attr(f.q) + '"></div>' +
      '<div class="field" style="max-width:130px"><label>类型</label><select id="asset-filter-kind" data-testid="asset-filter-kind" data-keep="asset-filter-kind">' +
      ['', 'image', 'video', 'audio', 'doc', 'pdf', 'other'].map(function (k) { return '<option value="' + k + '"' + (f.kind === k ? ' selected' : '') + '>' + (k ? v2AssetKind(k) : '全部类型') + '</option>'; }).join('') + '</select></div>' +
      '<div class="field" style="max-width:170px"><label>设备</label><select id="asset-filter-device" data-testid="asset-filter-device" data-keep="asset-filter-device">' +
      '<option value="">全部设备</option>' + devices.map(function (d) { return '<option value="' + attr(d.id) + '"' + (f.device === d.id ? ' selected' : '') + '>' + esc(d.label) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field" style="max-width:140px"><label>起始日期</label><input type="date" id="asset-filter-from" data-testid="asset-filter-from" data-keep="asset-filter-from" value="' + attr(f.from) + '"></div>' +
      '<div class="field" style="max-width:140px"><label>结束日期</label><input type="date" id="asset-filter-to" data-testid="asset-filter-to" data-keep="asset-filter-to" value="' + attr(f.to) + '"></div>' +
      '<button class="btn btn-sm" data-v2="refresh-page" data-page="assets" data-testid="btn-asset-search">搜索</button>' +
      '</div>' +
      '<div class="row-wrap" style="margin-top:8px"><span class="tag" data-testid="asset-stats">共 ' + (V2.data.assetTotal || 0) + ' 项素材</span>' +
      (stats.byKind ? '<span class="tag">按类型 ' + Object.keys(stats.byKind).map(function (k) { return v2AssetKind(k) + ' ' + stats.byKind[k]; }).join(' / ') + '</span>' : '') +
      (stats.basket ? '<span class="tag">中转站 待取 ' + (stats.basket.staged || 0) + ' / 已取 ' + (stats.basket.taken || 0) + '</span>' : '') +
      '<span class="tag">已选 ' + V2.data.assetSelection.length + ' 项</span>' +
      '<span class="spacer"></span><span class="tiny dim">检索：GET /api/v2/assets?q=&kind=&device=&from=&to=</span></div></div>';
    html += '<div class="split" style="margin-top:12px">';
    html += '<div><div class="asset-grid" data-testid="asset-grid">' +
      (V2.data.assets.length ? V2.data.assets.map(v2AssetCard).join('') : emptyBlock('暂无素材', '电脑端文件扫描或手机分享上传后，素材会出现在这里。')) +
      '</div>' +
      '<div class="card v2-card" style="margin-top:12px"><div class="row-wrap">' +
      '<span class="tiny muted">批量操作：</span>' +
      '<div class="field" style="max-width:210px"><select id="asset-basket-target" data-testid="asset-basket-target" data-keep="asset-basket-target"><option value="">选择目标设备（可选）</option>' +
      devices.map(function (d) { return '<option value="' + attr(d.id) + '">' + esc(d.label) + '</option>'; }).join('') + '</select></div>' +
      '<button class="btn btn-primary btn-sm" data-v2="asset-basket" data-testid="btn-asset-basket">加入中转站（' + V2.data.assetSelection.length + '）</button>' +
      '<a class="btn btn-ghost btn-sm" href="#/basket" data-testid="btn-goto-basket">去中转站 →</a>' +
      '</div></div></div>';
    html += '<div class="asset-detail-wrap" data-testid="asset-detail">';
    if (!detail) {
      html += '<div class="card v2-card"><div class="empty"><strong>选择一张素材</strong>点击左侧素材卡查看大图、元数据、OCR 文本、标签、来源与谱系。</div></div>';
    } else {
      var did = detail.id || detail.assetId;
      var tags = v2AssetTags(detail);
      var ocrText = v2AssetOcrText(detail);
      html += '<div class="card v2-card"><div class="detail-head"><div><div class="detail-title" data-testid="asset-detail-name">' + esc(detail.name || did) + '</div>' +
        '<div class="task-meta"><span class="mono">' + esc(did) + '</span><span class="tag">' + esc(v2AssetKind(detail.kind)) + '</span><span class="tag">' + v2Bytes(detail.size) + '</span><span class="tag' + (detail.removed ? ' red' : '') + '">' + (detail.removed ? '已移除' : '在库') + '</span></div></div>' +
        '<button class="modal-close" data-v2="asset-close" aria-label="关闭">×</button></div>' +
        '<div class="asset-big">' + (v2AssetHasThumb(detail) ? '<img data-testid="asset-detail-img" alt="' + attr(detail.name || '素材') + '" src="' + attr(v2AssetThumbUrl(detail, 640)) + '" onerror="this.style.display=\'none\'">' : '<div class="tiny dim" style="padding:24px">无缩略图（非图片或解析失败）</div>') + '</div>' +
        '<div class="mini-kv" style="margin-top:8px">' +
        '<span class="k">来源</span><span class="v" style="word-break:break-all">' + esc(v2AssetSource(detail)) + '</span>' +
        '<span class="k">SHA-256</span><span class="v mono" style="font-size:10.5px;word-break:break-all">' + esc(detail.sha256 || '无记录') + '</span>' +
        '<span class="k">MIME / 尺寸</span><span class="v">' + esc(detail.mime || '—') + (detail.image ? ' · ' + detail.image.width + '×' + detail.image.height : '') + '</span>' +
        '<span class="k">入库时间</span><span class="v">' + esc(fullTime(detail.createdAt)) + '</span>' +
        '<span class="k">出现次数</span><span class="v">' + (listOf(detail.occurrences).length || 1) + ' 处（跨设备溯源）</span>' +
        (detail.ocr ? '<span class="k">OCR</span><span class="v">' + esc(detail.ocr.status || '—') + (detail.ocr.confidence ? ' · 置信度 ' + detail.ocr.confidence : '') + '</span>' : '') +
        '</div>' +
        '<div class="draft-sec" style="margin-top:10px"><h4>OCR 文本 <span class="seg">tesseract chi_sim+eng</span></h4><div class="val" data-testid="asset-detail-ocr">' + (ocrText ? esc(ocrText) : '<span class="dim">（无 OCR 文本：非图片、未识别或识别中）</span>') + '</div></div>' +
        '<div class="draft-sec" style="margin-top:8px"><h4>标签</h4><div class="val" data-testid="asset-detail-tags">' + (tags.length ? tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join(' ') : '<span class="dim">暂无标签</span>') + '</div>' +
        '<div class="form-row" style="margin-top:8px"><input type="text" id="asset-tag-input" data-testid="asset-tag-input" data-keep="asset-tag-input" placeholder="添加标签，逗号分隔" style="max-width:220px">' +
        '<button class="btn btn-sm" data-v2="asset-tag" data-testid="btn-asset-tag">添加标签</button>' +
        '<button class="btn btn-primary btn-sm" data-v2="asset-basket-add" data-asset-id="' + attr(did) + '" data-testid="btn-asset-basket-single">加入中转站</button></div></div>' +
        (lineage ? '<div class="draft-sec" style="margin-top:8px"><h4>谱系 <span class="seg">lineage</span></h4><div class="val">' +
          '<div class="tiny dim">事件 ' + listOf(lineage.events).length + ' 条 · 引用 ' + (listOf(lineage.refs).length || listOf(lineage.references).length || 0) + ' 处</div>' +
          '<ul class="items" style="margin-top:4px">' + listOf(lineage.events).slice(0, 6).map(function (ev) {
            return '<li><span class="mono dim tiny">' + esc(dateOf(ev.at)) + '</span><span>' + esc(ev.type || '') + '</span></li>';
          }).join('') + '</ul></div></div>' : '') +
        '<div class="tiny dim" style="margin-top:8px">详情：GET /api/v2/assets/:id（含 lineage）· 标签：POST /api/v2/assets/:id/tags</div></div>';
    }
    html += '</div></div>';
    return html;
  }

  /* ---------- 渲染：中转站 ---------- */
  function v2RenderBasket() {
    var keys = ['basketList'];
    var stages = V2.data.basket;
    var staged = v2BasketStaged(stages);
    var taken = stages.filter(function (b) { return b.status === 'taken'; });
    var peers = V2.data.peers;
    var html = pageHead('中转站', '手机暂存、电脑一次取用；跨设备流转的「超级中转站」。',
      '<div class="btn-row">' + v2RefreshBtn('basket', 'btn-refresh-basket') + '</div>');
    html += v2Degrade(keys, '中转站接口') + v2LoadingNote(keys);
    html += '<div class="split" style="margin-top:12px"><div>';
    html += '<div class="card v2-card"><div class="card-title">暂存列表 <span class="count mono">' + staged.length + '</span> <span class="tiny dim">已取用 ' + taken.length + '</span></div>' +
      '<div class="v2-list" data-testid="basket-list" style="margin-top:8px">' +
      (stages.length ? stages.map(function (b) {
        var stat = b.status || 'staged';
        return '<div class="basket-item" data-testid="basket-item" data-item-id="' + attr(v2BasketId(b)) + '">' +
          '<span class="badge no-dot ' + (stat === 'taken' ? 'b-ok' : 'b-warn') + '">' + (stat === 'taken' ? '已取用' : '待取用') + '</span>' +
          '<div class="basket-main"><div class="basket-name">' + esc(b.name || b.assetId || b.id) + '</div><div class="tiny dim">' + v2Bytes(b.size) + (b.kind ? ' · ' + esc(v2AssetKind(b.kind)) : '') + (b.to ? ' · 目标 ' + esc(b.to) : '') + ' · ' + esc(dateOf(b.createdAt || b.at)) + '</div></div>' +
          (stat !== 'taken' ? '<button class="btn btn-sm" data-v2="basket-take-item" data-item-id="' + attr(v2BasketId(b)) + '">取用</button>' : '') +
          '</div>';
      }).join('') : emptyBlock('中转站是空的', '在素材库勾选素材 →「加入中转站」，手机等设备可一次取用。')) +
      '</div></div>';
    html += '</div><div>';
    html += '<div class="card v2-card"><div class="card-title">取用</div>' +
      '<div class="field"><label>取用目标设备（可选）</label><select id="basket-target" data-testid="basket-target" data-keep="basket-target"><option value="">不指定（本机中转站）</option>' +
      peers.map(function (p) { return '<option value="' + attr(v2PeerId(p)) + '">' + esc(p.name || v2PeerId(p)) + '</option>'; }).join('') +
      nodesList().map(function (n) { return '<option value="' + attr(n.id) + '">' + esc(n.name) + '（' + esc(n.id) + '）</option>'; }).join('') + '</select></div>' +
      '<div class="btn-row" style="margin-top:10px">' +
      '<button class="btn btn-primary" data-v2="basket-take" data-testid="btn-basket-take">全部取用（' + staged.length + '）</button>' +
      '<button class="btn btn-sm" data-v2="basket-refresh" data-testid="btn-refresh-basket2">刷新</button>' +
      '<button class="btn btn-danger btn-sm" data-v2="basket-clear" data-testid="btn-basket-clear">清空待取用</button></div>' +
      '<div class="hint-note" style="margin-top:8px">暂存：<code>POST /api/v2/assets/basket {items:[{assetId}],to}</code> · 取用：<code>POST /api/v2/assets/basket/take {ids,to}</code></div></div>';
    html += '</div></div>';
    return html;
  }

  /* ---------- 渲染：场景 ---------- */
  function v2ActionOptions(selected) {
    var acts = V2.data.actions.length ? V2.data.actions : V2_LOCAL_ACTIONS;
    return acts.map(function (a) {
      var id = a.id || a.actionId;
      return '<option value="' + attr(id) + '"' + (selected === id ? ' selected' : '') + '>' + esc(a.name || id) + ((a.risk === 'irreversible' || a.requiresConfirmation) ? '（不可逆）' : '') + '</option>';
    }).join('');
  }
  function v2DeviceOptions(selected) {
    return '<option value="">自动选择设备</option>' + nodesList().map(function (n) {
      return '<option value="' + attr(n.id) + '"' + (selected === n.id ? ' selected' : '') + '>' + esc(n.name) + '</option>';
    }).join('');
  }
  function v2ActionHint(actionId) {
    var act = v2ActionById(actionId);
    if (!act) return '';
    var req = listOf(act.params && act.params.required);
    return '必填参数：' + (req.length ? req.join(', ') : '无') + (act.available === false ? ' · 当前不可用（会降级/模拟）' : '') + (act.targetDevices ? ' · 目标设备 ' + listOf(act.targetDevices).map(function (d) { return d.name || d.deviceId; }).join('/') : '');
  }
  function v2RenderScenes() {
    var keys = ['scenes', 'model'];
    if (!V2.data.actions.length) V2.data.actions = V2_LOCAL_ACTIONS.slice();
    var scenes = V2.data.scenes;
    var html = pageHead('场景', '打印素材 / 投屏照片到电脑 / 备份到 NAS 或文件夹；不可逆动作需确认，执行记审计。',
      '<div class="btn-row">' + v2RefreshBtn('scenes', 'btn-refresh-scenes') +
      '<button class="btn btn-primary btn-sm" data-v2="scene-new" data-testid="btn-scene-new">新建场景</button></div>');
    html += v2Degrade(keys, '场景接口') + v2LoadingNote(keys);
    if (V2.data.sceneFormOpen) {
      if (!V2.data.sceneDraftSteps.length) V2.data.sceneDraftSteps.push({ actionId: (V2.data.actions[0] && V2.data.actions[0].id) || 'asset.backup', targetDeviceId: '', params: '{}' });
      html += '<div class="card v2-card" data-testid="scene-form"><div class="card-title">新建场景</div>' +
        '<div class="field" style="margin-top:8px"><label>场景名称</label><input type="text" id="scene-name" data-testid="scene-name" data-keep="scene-name" placeholder="例：下班后打印样品并备份"></div>' +
        '<div class="v2-list" style="margin-top:10px">' + V2.data.sceneDraftSteps.map(function (st, i) {
          var act = v2ActionById(st.actionId);
          return '<div class="scene-step-row" data-testid="scene-step">' +
            '<span class="mono dim tiny">' + (i + 1) + '</span>' +
            '<select data-testid="scene-step-action" data-v2-change="step-action" data-index="' + i + '">' + v2ActionOptions(st.actionId) + '</select>' +
            '<select data-testid="scene-step-device" data-v2-change="step-device" data-index="' + i + '">' + v2DeviceOptions(st.targetDeviceId) + '</select>' +
            '<textarea data-testid="scene-step-params" data-keep="step-params-' + i + '" data-v2-input="step-params" data-index="' + i + '" rows="1" placeholder=\'{"file":"示例空间/样品图/样品01.png"}\'>' + esc(st.params || '{}') + '</textarea>' +
            '<span class="tag ' + ((act && (act.risk === 'irreversible' || act.requiresConfirmation)) ? 'amber' : 'cyan') + '">' + esc((act && act.name) || st.actionId) + '</span>' +
            '<button class="btn btn-sm" data-v2="scene-del-step" data-index="' + i + '">删除</button>' +
            '<div class="tiny dim" style="grid-column:1/-1">' + esc(v2ActionHint(st.actionId)) + '</div>' +
            '</div>';
        }).join('') + '</div>' +
        '<div class="btn-row" style="margin-top:10px">' +
        '<button class="btn btn-sm" data-v2="scene-add-step" data-testid="btn-scene-add-step">+ 添加步骤</button>' +
        '<button class="btn btn-primary" data-v2="scene-save" data-testid="btn-scene-save">保存场景</button>' +
        '<span class="tiny dim">动作清单来自 <code>GET /api/v2/things/model</code>（含参数 schema 与风险）</span></div></div>';
    }
    html += '<div class="scene-grid" data-testid="scene-list" style="margin-top:12px">' +
      (scenes.length ? scenes.map(function (sc) {
        var id = sc.id || sc.sceneId;
        var steps = listOf(sc.steps);
        var irr = steps.filter(v2StepNeedsConfirm).length;
        return '<div class="card v2-card scene-card" data-testid="scene-card" data-scene-id="' + attr(id) + '">' +
          '<div class="detail-head"><div class="scene-name">' + esc(sc.name || id) + '</div>' +
          '<div class="badge-row">' + (irr ? '<span class="badge no-dot b-warn">含不可逆 ' + irr + '</span>' : '<span class="badge no-dot b-ok">全可逆</span>') + '</div></div>' +
          '<div class="tiny muted" style="margin-top:4px">' + steps.length + ' 步 · 更新 ' + esc(relTime(sc.updatedAt || sc.createdAt)) + ' · by ' + esc(sc.createdBy || '你') + '</div>' +
          '<ul class="items" style="margin-top:6px">' + steps.map(function (st) {
            var act = v2ActionById(st.actionId || st.action);
            return '<li><span class="mono dim tiny">·</span><span>' + esc((act && act.name) || st.actionId || st.action) + '</span><span class="dim tiny">' + esc(st.targetDeviceId || '自动') + '</span><span class="' + (v2StepNeedsConfirm(st) ? 'warn' : 'dim') + ' tiny">' + (v2StepNeedsConfirm(st) ? '需确认' : '可逆') + '</span></li>';
          }).join('') + '</ul>' +
          '<div class="btn-row" style="margin-top:10px"><button class="btn btn-primary btn-sm" data-v2="scene-run" data-scene-id="' + attr(id) + '" data-testid="scene-run">一键执行</button>' +
          '<a class="btn btn-ghost btn-sm" href="#/assets">去素材库选素材 →</a></div></div>';
      }).join('') : emptyBlock('还没有场景', '点右上角「新建场景」：例如 打印素材 → 备份到 NAS（不可逆步骤会先确认）。')) +
      '</div>';
    html += '<div class="section"><div class="section-head"><h2>最近执行</h2><span class="hint">执行结果 + 事件流 scene.ran（审计可导出）</span></div>' +
      '<div class="card v2-card"><div class="v2-list" data-testid="scene-last-runs">' +
      (V2.data.sceneRuns.length ? V2.data.sceneRuns.map(function (r) {
        return '<div class="run-row" data-testid="scene-run-row"><span class="mono dim tiny">' + esc(dateOf(r.at)) + '</span><span>' + esc(r.name || r.sceneId || '场景') + '</span><span class="tag' + (r.ok === false ? ' red' : ' cyan') + '">' + (r.ok === false ? '失败' : '已执行') + '</span><span class="dim tiny">' + esc(r.by || '你') + '</span><span class="dim tiny">' + esc(String(r.summary || '').slice(0, 80)) + '</span></div>';
      }).join('') : '<div class="tiny dim">还没有执行记录（执行后显示结果，并经 SSE 推送 scene.ran）</div>') + '</div></div></div>';
    return html;
  }

  /* ---------- 渲染：企业控制台 ---------- */
  function v2RenderEnterprise() {
    var keys = ['orgUsers', 'policy', 'approvals'];
    var p = v2PolicyObj();
    var tab = V2.data.entTab || 'users';
    var users = V2.data.orgUsers;
    var html = pageHead('企业控制台', '成员与角色、按角色限制动作、不可逆动作审批开关、审计保留期与导出；私有化部署 + 审计合规。', v2RefreshBtn('enterprise', 'btn-refresh-enterprise'));
    html += v2Degrade(keys, '企业接口') + v2LoadingNote(keys);
    html += '<div class="tabs" style="margin-bottom:12px">' +
      [['users', '成员与角色'], ['policy', '策略与权限'], ['approvals', '审批'], ['audit', '审计导出']].map(function (t) {
        return '<button class="filter-chip' + (tab === t[0] ? ' active' : '') + '" data-v2="ent-tab" data-tab="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div>';
    if (tab === 'users') {
      var editUser = null;
      for (var i = 0; i < users.length; i++) if (users[i].userId === V2.data.editUserId) { editUser = users[i]; break; }
      html += '<div class="split"><div><div class="card v2-card"><div class="card-title">成员 <span class="count mono">' + users.length + '</span></div>' +
        '<div class="v2-list" data-testid="org-user-list">' +
        (users.length ? users.map(function (u) {
          var uid = u.id || u.userId;
          return '<div class="org-user' + (uid === V2.data.editUserId ? ' active' : '') + '" data-testid="org-user" data-user-id="' + attr(uid) + '">' +
            '<span class="role-pill role-' + esc(u.role || 'member') + '">' + esc(u.roleLabel || v2RoleName(u.role)) + '</span>' +
            '<div class="org-main"><div class="org-name">' + esc(u.name || uid) + '</div><div class="tiny dim">' + esc(u.status || 'active') + (u.inviteCode ? ' · 邀请码 ' + esc(u.inviteCode) : '') + (u.email ? ' · ' + esc(u.email) : '') + '</div></div>' +
            '<span class="tag">' + (u.role === 'admin' ? '全部动作' : '动作 ' + listOf(u.effectiveActions).length) + '</span>' +
            '<button class="btn btn-sm" data-v2="org-select-user" data-user-id="' + attr(uid) + '" data-testid="btn-org-edit-user">编辑</button></div>';
        }).join('') : emptyBlock('还没有成员', '新增成员并分配角色（管理员 / 成员 / 访客）。')) +
        '</div></div></div>' +
        '<div class="card v2-card"><div class="card-title">新增成员</div>' +
        '<div class="field" style="margin-top:8px"><label>成员名称</label><input type="text" id="org-user-name" data-testid="org-user-name" data-keep="org-user-name" placeholder="例：张三"></div>' +
        '<div class="field" style="margin-top:8px"><label>角色</label><select id="org-user-role" data-testid="org-user-role" data-keep="org-user-role">' +
        V2_ROLES.map(function (r) { return '<option value="' + r.id + '">' + r.name + '</option>'; }).join('') + '</select></div>' +
        '<button class="btn btn-primary btn-block" style="margin-top:10px" data-v2="org-add-user" data-testid="btn-org-add-user">创建成员</button>' +
        '<div class="hint-note" style="margin-top:8px">POST /api/v2/org/users · 新成员状态为 invited（需激活）；越权留痕 enterprise.denied。</div></div>' +
        (editUser ? '<div class="card v2-card" style="margin-top:12px" data-testid="org-edit-panel"><div class="card-title">编辑成员 · ' + esc(editUser.name || editUser.userId) + '</div>' +
          '<div class="field" style="margin-top:8px"><label>角色</label><select id="org-edit-role" data-testid="org-user-role-edit" data-keep="org-edit-role">' +
          V2_ROLES.map(function (r) { return '<option value="' + r.id + '"' + (editUser.role === r.id ? ' selected' : '') + '>' + r.name + '</option>'; }).join('') + '</select></div>' +
          '<div class="field" style="margin-top:8px"><label>动作权限（勾选 = 允许）</label><div class="perm-grid" data-testid="org-actions">' +
          v2PermActions().map(function (a) {
            return '<div class="perm-row"><span class="perm-name">' + esc(a.name) + (a.risk === 'irreversible' ? '<span class="tag amber">不可逆</span>' : '') + '<span class="mono dim" style="font-size:10px">' + esc(a.id) + '</span></span>' +
              '<label class="perm-check"><input type="checkbox" data-testid="org-action-perm" data-v2-perm="1" data-action-id="' + attr(a.id) + '"' + (v2UserAllowed(editUser, a.id) ? ' checked' : '') + '></label></div>';
          }).join('') + '</div></div>' +
          '<div class="btn-row" style="margin-top:10px"><button class="btn btn-primary" data-v2="org-save-user" data-testid="btn-save-user">保存成员权限</button>' +
          (editUser.status !== 'active' ? '<button class="btn" data-v2="org-activate-user" data-testid="btn-org-activate-user">启用成员</button>' : '') +
          '<button class="btn btn-ghost" data-v2="org-select-user" data-user-id="">收起</button></div>' +
          '<div class="hint-note" style="margin-top:8px">PATCH /api/v2/org/users/:id {role, allowedActions, status} · 只读实例下写操作返回 423。</div></div>' : '') +
        '</div>';
    } else if (tab === 'policy') {
      var retentionOpts = listOf(p.retentionOptions).length ? p.retentionOptions : [7, 30, 180];
      html += '<div class="v2-grid-2"><div class="card v2-card"><div class="card-title">安全策略</div>' +
        '<div class="setting-row"><span class="k">不可逆动作需审批</span><span class="v"><label class="switch"><input type="checkbox" id="org-approval-toggle" data-testid="org-approval-toggle" data-keep="org-approval-toggle"' + (p.approvalRequiredForIrreversible !== false ? ' checked' : '') + '> 开启（打印 / 发送 / 删除需审批）</label></span></div>' +
        '<div class="setting-row"><span class="k">审计保留期</span><span class="v"><select id="org-policy-retention" data-testid="org-policy-retention" data-keep="org-policy-retention">' +
        retentionOpts.map(function (d) { return '<option value="' + d + '"' + (Number(p.auditRetentionDays) === Number(d) ? ' selected' : '') + '>' + d + ' 天</option>'; }).join('') + '</select></span></div>' +
        '<div class="setting-row"><span class="k">数据域</span><span class="v">' + esc(p.dataDomain || (snap() && snap().domainLabel) || '默认数据域') + '</span></div>' +
        '<div class="setting-row"><span class="k">跨域引用需审批</span><span class="v">' + (p.crossDomainRequiresApproval ? '<span class="tag amber">是</span>' : '<span class="tag">否</span>') + '</span></div>' +
        '<div class="setting-row"><span class="k">审批有效期</span><span class="v">' + esc(String(p.approvalTtlHours || 24)) + ' 小时</span></div>' +
        '<button class="btn btn-primary" style="margin-top:10px" data-v2="save-policy" data-testid="btn-save-policy">保存策略</button>' +
        '<div class="hint-note" style="margin-top:8px">PATCH /api/v2/org/policy · 保留期 7 / 30 / 180 天对应单机 / 团队 / 企业。</div></div>' +
        '<div class="card v2-card"><div class="card-title">审计与合规要点</div><div class="license">' +
        '<p>全量事件写入本地账本（哈希链），审计导出按保留期过滤；导出本身也记账。</p>' +
        '<p>角色越权尝试写入 <code>enterprise.denied</code>；审批流写入 <code>approval.requested</code> / <code>approval.decided</code>。</p>' +
        '<p>SSO / 企业微信 / 钉钉适配器接口由后端提供（凭据企业自备），未配置时使用 mock。</p>' +
        '<p>私有化部署：数据、日志、模型调用记录都在自己的服务器上；默认零外联。</p></div></div></div>';
    } else if (tab === 'approvals') {
      var pendingCount = V2.data.approvals.filter(function (a) { return a.status === 'pending'; }).length;
      html += '<div class="card v2-card"><div class="card-title">审批列表 <span class="count mono">' + V2.data.approvals.length + '</span> <span class="tiny dim">待审批 ' + pendingCount + '</span></div>' +
        '<div class="v2-list" data-testid="approval-list">' +
        (V2.data.approvals.length ? V2.data.approvals.map(function (ap) {
          var apid = ap.id || ap.requestId;
          var status = ap.status || 'pending';
          var stCls = status === 'approved' ? 'b-ok' : status === 'rejected' ? 'b-bad' : 'b-warn';
          return '<div class="approval-row" data-testid="approval-row" data-approval-id="' + attr(apid) + '">' +
            '<span class="badge no-dot ' + stCls + '">' + esc(status === 'approved' ? '已通过' : status === 'rejected' ? '已拒绝' : '待审批') + '</span>' +
            '<div class="approval-main"><div>' + esc(ap.actionName || ap.action || '不可逆动作') + ' <span class="tag' + (ap.risk === 'irreversible' ? ' amber' : '') + '">' + esc(ap.risk || '') + '</span></div><div class="tiny dim">发起人 ' + esc(ap.byName || ap.by || '你') + ' · ' + esc(dateOf(ap.createdAt || ap.at)) + (ap.decidedByName ? ' · 审批人 ' + esc(ap.decidedByName) : '') + (ap.reason ? ' · ' + esc(ap.reason) : '') + '</div></div>' +
            (status === 'pending' ? '<div class="btn-row"><button class="btn btn-primary btn-sm" data-v2="approval-decide" data-approval-id="' + attr(apid) + '" data-ok="1" data-testid="btn-approval-approve">通过</button>' +
              '<button class="btn btn-danger btn-sm" data-v2="approval-decide" data-approval-id="' + attr(apid) + '" data-ok="0" data-testid="btn-approval-reject">拒绝</button></div>' : '') +
            '</div>';
        }).join('') : emptyBlock('暂无审批请求', '开启「不可逆动作需审批」后，打印 / 发送等动作会出现在这里。')) +
        '</div><div class="btn-row" style="margin-top:10px"><button class="btn btn-sm" data-v2="refresh-page" data-page="enterprise" data-testid="btn-refresh-approvals">刷新审批列表</button></div>' +
        '<div class="hint-note" style="margin-top:8px">GET /api/v2/approvals · POST /api/v2/approvals/:id/decide {ok,reason}（只有管理员可审批、不能自批）</div></div>';
    } else {
      html += '<div class="v2-grid-2"><div class="card v2-card"><div class="card-title">审计导出</div>' +
        '<div class="license"><p>复用事件账本，按保留期过滤；导出动作本身也记账。</p><p>当前保留期：<strong>' + esc(String(p.auditRetentionDays || 30)) + ' 天</strong>（可在「策略」页调整）。</p></div>' +
        '<div class="btn-row" style="margin-top:10px">' +
        '<button class="btn btn-primary btn-sm" data-v2="v2-export" data-format="csv" data-testid="btn-export-v2-audit-csv">导出 CSV</button>' +
        '<button class="btn btn-sm" data-v2="v2-export" data-format="json" data-testid="btn-export-v2-audit-json">导出 JSON</button>' +
        '<button class="btn btn-sm" data-v2="v2-export" data-format="md" data-testid="btn-export-v2-audit-md">导出 Markdown</button></div>' +
        '<div class="hint-note" style="margin-top:8px">GET /api/v2/org/audit/export?format=csv|json|md（需令牌）</div></div>' +
        '<div class="card v2-card"><div class="card-title">动作审计</div>' +
        '<div class="v2-list">' + (V2.data.actions.length ? V2.data.actions.map(function (a) {
          return '<div class="drill-item"><span>' + esc(a.name || a.id) + '</span><span class="tag ' + (a.risk === 'irreversible' ? 'amber' : 'cyan') + '">' + esc(a.risk || 'reversible') + '</span><span class="dim tiny" style="margin-left:auto">' + esc(a.id) + '</span></div>';
        }).join('') : '<div class="tiny dim">动作清单：GET /api/v2/things/model</div>') + '</div></div></div>';
    }
    return html;
  }

  /* ---------- v2 事件流（SSE 推送的新事件类型） ---------- */
  function v2IsRealtimeEvent(type) {
    return /^(link|transfer|clipboard|notification|asset|basket|scene|org|enterprise|approval|super)\./.test(String(type || ''));
  }
  function v2OnRealtimeEvent(ev) {
    var type = String((ev && ev.type) || '');
    var d = (ev && ev.data) || {};
    var at = (ev && ev.at) || nowIso();
    try {
      if (type === 'link.peer.seen') {
        var id = d.deviceId || d.peerId;
        var found = null;
        for (var i = 0; i < V2.data.peers.length; i++) if (v2PeerId(V2.data.peers[i]) === id) { found = V2.data.peers[i]; break; }
        if (!found) { found = { deviceId: id }; V2.data.peers.push(found); }
        found.name = d.name || found.name;
        found.platform = d.platform || found.platform;
        found.host = d.ip || d.host || found.host;
        found.port = d.port || found.port;
        found.online = true;
        found.lastSeen = at;
      } else if (type === 'link.paired') {
        var pid = d.peerId || d.deviceId;
        var peer = null;
        for (var j = 0; j < V2.data.peers.length; j++) if (v2PeerId(V2.data.peers[j]) === pid) { peer = V2.data.peers[j]; break; }
        if (!peer) { peer = { deviceId: pid }; V2.data.peers.push(peer); }
        peer.name = d.name || peer.name;
        peer.platform = d.platform || peer.platform;
        peer.trusted = true;
      } else if (type === 'link.revoked') {
        for (var k = 0; k < V2.data.peers.length; k++) if (v2PeerId(V2.data.peers[k]) === (d.peerId || d.deviceId)) { V2.data.peers[k].trusted = false; }
      } else if (type === 'transfer.started') {
        v2UpsertTransfer({ transferId: d.transferId, peerId: d.peerId, direction: d.direction, files: d.files, totalBytes: d.totalBytes, status: d.direction === 'receive' ? 'receiving' : 'started', at: at });
      } else if (type === 'transfer.completed') {
        v2UpsertTransfer({ transferId: d.transferId, peerId: d.peerId, direction: d.direction, files: d.files, status: 'completed', progress: 100, totalBytes: d.bytes, sha256: d.sha256, speedBps: d.speedBps, at: at });
      } else if (type === 'transfer.failed') {
        v2UpsertTransfer({ transferId: d.transferId, status: 'failed', reason: d.reason, at: at });
      } else if (type === 'clipboard.shared') {
        V2.data.clipHistory.unshift({ kind: d.kind || 'text', text: d.preview || d.text || '', at: at, direction: d.from === 'local' ? 'send' : 'receive', from: d.from });
        if (V2.data.clipHistory.length > 20) V2.data.clipHistory.length = 20;
        if (d.from !== 'local' || d.to) V2.data.clipboard = { kind: d.kind, preview: d.preview || d.text, text: d.text, from: d.from, at: at };
      } else if (type === 'notification.relayed') {
        V2.data.notifications.unshift({ app: d.app, title: d.title, preview: d.preview, from: d.from, at: at });
        if (V2.data.notifications.length > 20) V2.data.notifications.length = 20;
      } else if (type === 'asset.ingested' || type === 'asset.tagged' || type === 'asset.shared' || type === 'asset.removed') {
        V2.loaded.assets = 0;
        if (V2.data.assetDetail && (V2.data.assetDetail.id === d.assetId)) v2LoadAssetDetail(d.assetId);
      } else if (type === 'scene.ran') {
        v2PushSceneRun({ sceneId: d.sceneId, name: v2SceneName(d.sceneId), by: d.by, result: d.result, at: at, ok: !(d.result && d.result.ok === false), summary: (d.result && d.result.summary) || '' });
        V2.loaded.scenes = 0;
      } else if (type === 'scene.defined' || type === 'org.user.created' || type === 'enterprise.role.changed' || type === 'approval.requested' || type === 'approval.decided') {
        if (type.indexOf('scene') === 0) V2.loaded.scenes = 0; else V2.loaded.enterprise = 0;
      } else if (type === 'super.handoff') {
        superOnHandoffEvent(d, at);
      } else if (type === 'super.asked') {
        SUPER.asks.unshift({ text: d.text, reply: d.reply, at: at });
        if (SUPER.asks.length > 20) SUPER.asks.length = 20;
      } else if (type === 'basket.staged' || type === 'basket.taken') {
        V2.loaded.basket = 0;
      }
    } catch (err) {
      window.__tenonErrors.push('v2OnEvent: ' + String((err && err.message) || err));
    }
    if (v2IsRoute(S.route)) scheduleV2Refresh();
  }
  function v2SceneName(id) {
    for (var i = 0; i < V2.data.scenes.length; i++) if (String(V2.data.scenes[i].id || V2.data.scenes[i].sceneId) === String(id)) return V2.data.scenes[i].name;
    return id || '场景';
  }
  var v2RefreshTimer = null;
  function scheduleV2Refresh() {
    if (v2RefreshTimer) return;
    v2RefreshTimer = setTimeout(function () {
      v2RefreshTimer = null;
      if (!v2IsRoute(S.route)) return;
      V2.loaded[S.route] = 0;
      v2EnsureLoaded(S.route);
    }, 800);
  }

  /* ---------- v2 签名（参与重绘判定，避免无变化重绘） ---------- */
  function v2Sig() {
    var d = V2.data;
    var st = [];
    for (var k in V2.status) if (Object.prototype.hasOwnProperty.call(V2.status, k)) st.push(k + ':' + (V2.status[k].ok ? 'ok' : V2.status[k].kind));
    switch (S.route) {
      case 'link':
        return 'L' + d.peers.map(function (p) { return [v2PeerId(p), p.name || '', v2PeerTrusted(p) ? 1 : 0, p.online ? 1 : 0].join(':').slice(0, 80); }).join('|') +
          'Q' + (d.pairQr ? d.pairQr.code + '@' + d.pairQr.expiresAt : '') +
          'T' + d.transfers.map(function (t) { return [t.transferId, t.status, Math.round(t.progress || 0)].join(':'); }).join('|') +
          'C' + d.clipHistory.length + 'N' + d.notifications.length + 'S' + st.join(',');
      case 'assets':
        return 'A' + d.assets.map(function (a) { return (a.id || a.assetId) + ':' + (a.name || ''); }).join('|') + 'T' + d.assetTotal +
          'D' + (d.assetDetail ? (d.assetDetail.id || d.assetDetail.assetId) : '') + 'L' + (d.assetLineage ? listOf(d.assetLineage.events).length : '') +
          'X' + d.assetSelection.join(',') + 'F' + JSON.stringify(d.assetFilters) + 'S' + st.join(',');
      case 'basket':
        return 'B' + d.basket.map(function (b) { return v2BasketId(b) + ':' + (b.status || '') + ':' + (b.to || ''); }).join('|') + 'S' + st.join(',');
      case 'scenes':
        return 'C' + d.scenes.map(function (s) { return (s.id || s.sceneId) + ':' + (s.name || '') + ':' + listOf(s.steps).length; }).join('|') +
          'R' + d.sceneRuns.length + 'D' + d.sceneDraftSteps.map(function (st2) { return st2.actionId + ':' + st2.targetDeviceId + ':' + st2.params; }).join('|') + 'O' + (d.sceneFormOpen ? 1 : 0) + 'S' + st.join(',');
      case 'enterprise':
        return 'U' + d.orgUsers.map(function (u) { return (u.userId || u.id) + ':' + (u.role || '') + ':' + (u.status || '') + ':' + JSON.stringify(u.allowedActions || ''); }).join('|').slice(0, 900) +
          'P' + JSON.stringify(d.policy || {}) + 'A' + d.approvals.map(function (a) { return (a.requestId || a.id) + ':' + (a.status || 'pending'); }).join('|') +
          'T' + d.entTab + 'E' + (d.editUserId || '') + 'S' + st.join(',');
      case 'super': return 'S' + superSig();
      case 'handoff': return 'H' + superSig();
      default: return '';
    }
  }

  /* ---------- v2 交互入口 ---------- */
  function v2OnClick(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-v2]') : null;
    if (!el) return;
    if (el.disabled) return;
    var act = el.getAttribute('data-v2');
    var ds = el.dataset || {};
    ev.preventDefault();
    ev.stopPropagation();
    S.lastUserActionAt = Date.now();
    switch (act) {
      case 'refresh-page': v2RefreshPage(ds.page || S.route).then(function () { render(); }); break;
      case 'pair': v2DoPair(); break;
      case 'pair-regenerate': v2DoRegenerate(); break;
      case 'revoke': v2DoRevoke(ds.peerId); break;
      case 'transfer-send': v2StartUpload(); break;
      case 'clipboard-send': v2SendClipboard(); break;
      case 'asset-open': v2OpenAsset(ds.assetId); break;
      case 'asset-close': V2.data.assetDetail = null; V2.data.assetLineage = null; render(true); break;
      case 'asset-basket': v2AddSelectedToBasket(); break;
      case 'asset-basket-add': v2AddAssetToBasket(ds.assetId); break;
      case 'asset-tag': v2AddTag(); break;
      case 'basket-take': v2BasketTake([]); break;
      case 'basket-take-item': v2BasketTake([ds.itemId]); break;
      case 'basket-refresh': v2LoadBasket().then(function () { render(); }); break;
      case 'basket-clear': v2BasketClear(); break;
      case 'scene-new': V2.data.sceneFormOpen = !V2.data.sceneFormOpen; if (V2.data.sceneFormOpen && !V2.data.sceneDraftSteps.length) v2SceneAddStep(); else render(true); break;
      case 'scene-add-step': v2SceneAddStep(); break;
      case 'scene-del-step': v2SceneDelStep(ds.index); break;
      case 'scene-save': v2SceneSave(); break;
      case 'scene-run': v2SceneRun(ds.sceneId); break;
      case 'org-add-user': v2OrgAddUser(); break;
      case 'org-select-user': v2OrgSelectUser(ds.userId || ''); break;
      case 'org-save-user': v2OrgSaveUser(); break;
      case 'org-activate-user': v2OrgActivateUser(); break;
      case 'ent-tab': V2.data.entTab = ds.tab || 'users'; render(true); break;
      case 'save-policy': v2SavePolicy(); break;
      case 'approval-decide': v2ApprovalDecide(ds.approvalId, ds.ok === '1'); break;
      case 'v2-export': v2ExportAudit(ds.format || 'csv'); break;
      case 'confirm-ok': v2ConfirmOk(); break;
      case 'confirm-cancel': v2ConfirmClose(); break;
      default: break;
    }
  }
  function v2OnChange(ev) {
    var t = ev.target;
    if (!t) return;
    S.lastUserActionAt = Date.now();
    var testid = t.getAttribute ? t.getAttribute('data-testid') : '';
    if (testid === 'asset-select') {
      v2ToggleAssetSelect(t.getAttribute('data-asset-id'));
      var card = t.closest ? t.closest('[data-testid="asset-card"]') : null;
      if (card) card.classList.toggle('selected', !!t.checked);
      var batch = $('[data-testid="btn-asset-basket"]');
      if (batch) batch.textContent = '加入中转站（' + V2.data.assetSelection.length + '）';
      return;
    }
    if (testid === 'asset-filter-kind') { V2.data.assetFilters.kind = t.value; v2LoadAssets().then(function () { render(); }); return; }
    if (testid === 'asset-filter-device') { V2.data.assetFilters.device = t.value; v2LoadAssets().then(function () { render(); }); return; }
    if (testid === 'asset-filter-from') { V2.data.assetFilters.from = t.value; v2LoadAssets().then(function () { render(); }); return; }
    if (testid === 'asset-filter-to') { V2.data.assetFilters.to = t.value; v2LoadAssets().then(function () { render(); }); return; }
    if (testid === 'basket-target') { V2.data.basketTarget = t.value; return; }
    var change = t.getAttribute ? t.getAttribute('data-v2-change') : '';
    if (change === 'step-action' || change === 'step-device') {
      var idx = Number(t.getAttribute('data-index')) || 0;
      var stp = V2.data.sceneDraftSteps[idx];
      if (stp) {
        if (change === 'step-action') {
          stp.actionId = t.value;
          stp.params = JSON.stringify(v2ActionDefaultParams(t.value));
        } else stp.targetDeviceId = t.value;
      }
      render(true);
    }
  }
  function v2OnInput(ev) {
    var t = ev.target;
    if (!t) return;
    var testid = t.getAttribute ? t.getAttribute('data-testid') : '';
    if (testid === 'asset-search') {
      V2.data.assetFilters.q = String(t.value || '');
      if (S.searchTimer) clearTimeout(S.searchTimer);
      S.searchTimer = setTimeout(function () { v2LoadAssets().then(function () { render(); }); }, 420);
      return;
    }
    var inputKind = t.getAttribute ? t.getAttribute('data-v2-input') : '';
    if (inputKind === 'step-params') {
      var idx = Number(t.getAttribute('data-index')) || 0;
      if (V2.data.sceneDraftSteps[idx]) V2.data.sceneDraftSteps[idx].params = t.value;
    }
  }
  function v2Attach() {
    document.addEventListener('click', v2OnClick);
    document.addEventListener('change', v2OnChange);
    document.addEventListener('input', v2OnInput);
    setInterval(function () {
      if (v2IsRoute(S.route) && !modalOpen() && !S.stale) v2EnsureLoaded(S.route);
    }, 12000);
  }

  /* ======================================================================
   * v2.1 消费级「超级终端」：默认首页 #/super + 流转接收页 #/handoff
   * 一句话/语音调动家里设备与程序；手机一倾内容滑到电脑。
   * 后端 /api/v2/super/* 未就绪时全部降级提示，不崩、不假装成功。
   * ====================================================================== */
  var SUPER_SUGGESTIONS = ['打开微信', '把这张照片甩到电脑', '回家模式', '放首歌'];
  var SUPER_PROGRAMS_FALLBACK = [
    { id: 'wechat', name: '微信', icon: '💬', ask: '打开微信', available: true },
    { id: 'chrome', name: 'Chrome', icon: '🌐', ask: '打开 Chrome', available: true },
    { id: 'notepad', name: '记事本', icon: '📝', ask: '打开记事本', available: true },
    { id: 'explorer', name: '文件', icon: '📁', ask: '打开资源管理器', available: true },
    { id: 'calc', name: '计算器', icon: '🧮', ask: '打开计算器', available: true },
    { id: 'music', name: '音乐', icon: '🎵', ask: '放首歌', available: true },
    { id: 'photos', name: '照片', icon: '🖼️', ask: '打开照片', available: true },
    { id: 'print', name: '打印', icon: '🖨️', ask: '打印这张照片', available: true }
  ];
  var SUPER = {
    status: null,
    home: null,
    state: null,
    devices: [],
    programs: [],
    handoffs: [],
    asks: [],
    lastAsk: null,
    listening: false,
    rec: null,
    busy: false,
    loadingAll: false,
    backendMissing: false,
    catalog: null,
    suggestions: [],
    loadedAt: 0
  };

  function superIsRoute(route) { return (route || S.route) === 'super' || (route || S.route) === 'handoff'; }
  function superKindIcon(kind, name) {
    var k = String(kind || '').toLowerCase();
    var map = { computer: '💻', pc: '💻', windows: '💻', laptop: '💻', phone: '📱', android: '📱', ios: '📱', tv: '📺', speaker: '🔊', printer: '🖨️', nas: '🗄️', light: '💡', hub: '🏠', server: '🗄️', tablet: '📱' };
    if (map[k]) return map[k];
    var n = String(name || '');
    if (/电脑|工作台|中枢|windows|mac/i.test(n)) return '💻';
    if (/手机|android|iphone/i.test(n)) return '📱';
    if (/电视|tv/i.test(n)) return '📺';
    if (/音箱|speaker|音响/i.test(n)) return '🔊';
    if (/打印|printer/i.test(n)) return '🖨️';
    if (/nas|群晖|存储/i.test(n)) return '🗄️';
    return '📦';
  }
  function superProgIcon(p) {
    if (p && p.icon) return p.icon;
    var n = String((p && (p.name || p.id)) || '');
    if (/微信|wechat/i.test(n)) return '💬';
    if (/chrome|浏览器|edge/i.test(n)) return '🌐';
    if (/记事本|notepad|文本/i.test(n)) return '📝';
    if (/文件|explorer/i.test(n)) return '📁';
    if (/计算器|calc/i.test(n)) return '🧮';
    if (/音乐|music|歌/i.test(n)) return '🎵';
    if (/照片|photo|相册/i.test(n)) return '🖼️';
    if (/打印|print/i.test(n)) return '🖨️';
    return '▶️';
  }
  function superDeviceSentence(d) {
    if (d.sentence) return d.sentence;
    if (d.note) return d.note;
    var caps = listOf(d.capabilities).map(function (c) { return (c && (c.name || c.id)) || String(c); }).filter(Boolean);
    if (caps.length) return '能' + caps.slice(0, 3).join('、') + (caps.length > 3 ? ' 等 ' + caps.length + ' 项能力' : '');
    return '可被超级终端调用';
  }
  function superNormDevice(d) {
    d = d || {};
    var id = d.id || d.deviceId || d.nodeId || '';
    var name = d.name || d.deviceName || id || '未知设备';
    var kind = d.kind || d.type || d.platform || '';
    var online = d.online !== undefined ? !!d.online : (d.connected !== undefined ? !!d.connected : true);
    var simulated = !!d.simulated || d.mode === 'simulate';
    return { id: id, name: name, kind: kind, platform: d.platform || '', online: online, simulated: simulated, capabilities: listOf(d.capabilities || d.actions), sentence: d.oneLine || d.sentence || '', note: d.note || d.reason || '', evidence: d.evidence || '', raw: d };
  }
  function superDevices() {
    var list = [];
    var seen = {};
    var push = function (d) {
      var nd = superNormDevice(d);
      if (!nd.id || seen[nd.id]) return;
      seen[nd.id] = 1;
      list.push(nd);
    };
    var catalogDevices = listOf(SUPER.catalog && SUPER.catalog.devices);
    catalogDevices.forEach(push);
    if (!catalogDevices.length) {
      nodesList().forEach(function (n) {
        push({ id: n.id, name: n.name, kind: n.platform || n.kind || '', online: !!(n.online && !n.disconnected), capabilities: listOf(n.capabilities), note: n.disconnected ? '已断开 · 引用关系保留' : (n.online ? '' : '离线 · 唤醒后可用'), simulated: n.kind === 'imported' });
      });
      // 消费级家庭目录：手机/电视/音箱即使暂未接入也展示为「可用位置」，明确标注模拟
      push({ id: 'phone-mine', name: '我的手机', kind: 'phone', online: false, note: '手机页打开 /m 即可连接；倾一下就把内容甩过来' });
      push({ id: 'tv-living', name: '客厅电视', kind: 'tv', online: false, simulated: true, note: '模拟设备 · 后端接入后可用' });
      push({ id: 'speaker-living', name: '客厅音箱', kind: 'speaker', online: false, simulated: true, note: '模拟设备 · 后端接入后可用' });
    }
    // 确保六类家庭设备都出现（电脑/手机/电视/音箱/打印机/NAS）
    var has = function (re) { return list.some(function (d) { return re.test(d.name) || re.test(d.kind); }); };
    if (!has(/电脑|工作台|中枢|hub|windows|mac/i)) push({ id: 'pc-this', name: '这台电脑', kind: 'computer', online: true, note: '本机中枢所在电脑' });
    if (!has(/手机|phone|android/i)) push({ id: 'phone-mine', name: '我的手机', kind: 'phone', online: false, note: '手机页打开 /m 即可连接' });
    if (!has(/电视|tv/i)) push({ id: 'tv-living', name: '客厅电视', kind: 'tv', online: false, simulated: true, note: '模拟设备' });
    if (!has(/音箱|speaker/i)) push({ id: 'speaker-living', name: '客厅音箱', kind: 'speaker', online: false, simulated: true, note: '模拟设备' });
    if (!has(/打印|printer/i)) push({ id: 'printer-home', name: '打印机', kind: 'printer', online: false, note: '未连接' });
    if (!has(/nas|群晖|存储/i)) push({ id: 'nas-home', name: 'NAS', kind: 'nas', online: false, note: '未连接' });
    return list;
  }
  function superPrograms() {
    var fromHome = listOf(SUPER.catalog && SUPER.catalog.programs);
    if (fromHome.length) {
      return fromHome.map(function (p) {
        return {
          id: p.id || p.programId || p.name,
          name: p.name || p.id,
          icon: p.emoji || p.icon || superProgIcon(p),
          ask: p.ask || ('打开' + (p.name || p.id)),
          available: p.available !== false,
          reason: p.reason || p.note || (p.availableAs === 'node' && listOf(p.targetDevices).length ? '' : ''),
          actionId: p.actionId || '',
          raw: p
        };
      });
    }
    return SUPER_PROGRAMS_FALLBACK.map(function (p) {
      var copy = {};
      for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) copy[k] = p[k];
      if (SUPER.backendMissing) {
        copy.available = false;
        copy.reason = '超级终端服务未就绪（POST /api/v2/super/ask），暂时点不了';
      }
      return copy;
    });
  }
  function superLoadState() {
    if (SUPER.loadingAll) return Promise.resolve();
    SUPER.loadingAll = true;
    return Promise.all([
      v2Fetch('superState', '/api/v2/super/state'),
      v2Fetch('superHome', '/api/v2/super/home')
    ]).then(function (res) {
      SUPER.loadingAll = false;
      var st = res[0], home = res[1];
      if (st) {
        SUPER.state = st;
        SUPER.handoffs = listOf(st.handoffs).map(superNormHandoff);
        SUPER.asks = listOf(st.asks);
      }
      if (home) {
        SUPER.home = home;
        SUPER.catalog = home.catalog || home;
        SUPER.suggestions = listOf(home.suggestions).map(function (x) { return typeof x === 'string' ? x : (x.text || x.label || x.say || ''); }).filter(Boolean);
        if (!SUPER.suggestions.length) SUPER.suggestions = SUPER_SUGGESTIONS;
        var recent = home.recent || {};
        if (!st) {
          SUPER.asks = listOf(recent.asks);
          SUPER.handoffs = listOf(recent.handoffs).map(superNormHandoff);
        }
        if (!SUPER.asks.length) SUPER.asks = listOf(recent.asks);
        if (!SUPER.handoffs.length) SUPER.handoffs = listOf(recent.handoffs).map(superNormHandoff);
      }
      if (!SUPER.lastAsk && SUPER.asks.length) {
        var last = SUPER.asks[0] || {};
        var r = last.result || {};
        SUPER.lastAsk = {
          text: last.text || '',
          reply: last.reply || last.say || '',
          plan: listOf(last.plan),
          steps: listOf(r.steps),
          needsConfirm: !!last.needsConfirm,
          ai: r.ai || null,
          at: last.at || nowIso(),
          status: 'done'
        };
      }
      SUPER.backendMissing = !st && !home;
      SUPER.loadedAt = Date.now();
      render();
    });
  }
  function superStepList(ask) {
    return listOf(ask && (ask.plan || ask.steps || ask.actions));
  }
  function superStepState(st) {
    var s = String((st && (st.status || st.state)) || '');
    if (st && st.ok === true) return { icon: '✅', cls: 'ok', label: '已完成' };
    if (s === 'succeeded' || s === 'ok' || s === 'done' || s === 'completed') return { icon: '✅', cls: 'ok', label: '已完成' };
    if (s === 'running') return { icon: '⏳', cls: 'run', label: '进行中' };
    if (st && st.ok === false) return { icon: '❌', cls: 'bad', label: '失败' };
    if (s === 'failed' || s === 'error' || s === 'timeout') return { icon: '❌', cls: 'bad', label: '失败' };
    if (s === 'pending' || s === 'queued' || s === 'drafted') return { icon: '⏳', cls: 'wait', label: '排队中' };
    if (s === 'dispatched') return { icon: '⏳', cls: 'wait', label: '已派发' };
    if (s === 'degraded') return { icon: '⚠️', cls: 'wait', label: '降级执行' };
    return { icon: '⏳', cls: 'wait', label: s || '准备中' };
  }
  function superStepLabel(st) {
    return st.label || st.actionName || st.say || st.capabilityId || st.action || st.capability || st.targetDeviceName || '执行一步';
  }
  function superAsk(text) {
    text = String(text || '').trim();
    if (!text) { toast('先说一句要做什么', 'warn'); return; }
    if (SUPER.busy) return;
    SUPER.busy = true;
    SUPER.lastAsk = { text: text, reply: '正在理解这句话…', plan: [], at: nowIso(), status: 'asking' };
    render(true);
    v2Post('/api/v2/super/ask', { text: text, source: 'desktop' }, '超级终端').then(function (data) {
      SUPER.busy = false;
      if (data && (data.reply || data.say)) {
        SUPER.backendMissing = false;
        SUPER.lastAsk = {
          text: text,
          reply: data.reply || data.say,
          plan: listOf(data.plan),
          steps: listOf(data.steps),
          at: nowIso(),
          status: 'done',
          needsConfirm: !!(data.needsConfirm),
          ai: data.ai || (data.intent && data.intent.ai) || null,
          result: data
        };
        if (listOf(data.handoffs).length) SUPER.handoffs = listOf(data.handoffs).map(superNormHandoff).concat(SUPER.handoffs);
      } else {
        SUPER.backendMissing = true;
        SUPER.lastAsk = {
          text: text,
          reply: '超级终端服务还没接上（/api/v2/super/ask 未就绪）。这句话我已经记下：「' + text + '」。后端就绪后，同样的操作会真正调动家里的设备与程序。',
          plan: [],
          at: nowIso(),
          status: 'degraded'
        };
      }
      render(true);
    });
  }
  function superVoice() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { superVoiceFallback('浏览器不支持麦克风（webkitSpeechRecognition），已切文字输入'); return; }
    if (SUPER.listening && SUPER.rec) {
      try { SUPER.rec.stop(); } catch (_) {}
      SUPER.listening = false;
      render(false);
      return;
    }
    try {
      var rec = new SR();
      rec.lang = 'zh-CN';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      SUPER.rec = rec;
      rec.onresult = function (e) {
        var transcript = '';
        try { transcript = e.results[0][0].transcript || ''; } catch (_) {}
        SUPER.listening = false;
        if (transcript) {
          var input = $('#super-ask-input');
          if (input) input.value = transcript;
          toast('听到：' + transcript, 'ok');
          superAsk(transcript);
        } else superVoiceFallback('没听清，已切文字输入');
        render(false);
      };
      rec.onerror = function (e) {
        SUPER.listening = false;
        var why = e && e.error;
        if (why === 'not-allowed' || why === 'permission-denied') superVoiceFallback('麦克风权限被拒绝，已切文字输入');
        else if (why === 'no-speech') superVoiceFallback('没听到声音，已切文字输入');
        else superVoiceFallback('语音识别不可用（' + (why || '未知') + '），已切文字输入');
        render(false);
      };
      rec.onend = function () { SUPER.listening = false; render(false); };
      SUPER.listening = true;
      rec.start();
      toast('正在听…请说话', 'ok');
      render(false);
    } catch (err) {
      SUPER.listening = false;
      superVoiceFallback('语音识别启动失败，已切文字输入');
    }
  }
  function superVoiceFallback(msg) {
    SUPER.listening = false;
    toast(msg, 'warn', 5200);
    var input = $('#super-ask-input');
    if (input) { try { input.focus(); } catch (_) {} }
  }
  function superOnHandoffEvent(d, at) {
    var rec = superNormHandoff({
      handoffId: d.handoffId || d.id,
      kind: d.kind,
      url: d.url,
      assetId: d.assetId,
      text: d.text,
      fromDevice: d.fromDevice || d.from,
      toDevice: d.toDevice,
      at: at
    });
    if (!rec.at) rec.at = at;
    var exists = false;
    for (var i = 0; i < SUPER.handoffs.length; i++) if (SUPER.handoffs[i].id === rec.id || (rec.url && SUPER.handoffs[i].url === rec.url && SUPER.handoffs[i].at === rec.at)) { exists = true; break; }
    if (!exists) SUPER.handoffs.unshift(rec);
    if (SUPER.handoffs.length > 20) SUPER.handoffs.length = 20;
    toast('📱 手机甩来一条内容：' + superHandoffLabel(rec), 'ok', 5600);
    if (S.route === 'handoff') render(true);
  }
  function superNormHandoff(h) {
    h = h || {};
    var payload = h.payload || {};
    return {
      id: h.handoffId || h.id || ('ho_' + (h.at || Date.now())),
      kind: h.kind || payload.kind || 'text',
      url: h.url || payload.url || '',
      assetId: h.assetId || payload.assetId || '',
      text: h.text || payload.text || '',
      from: h.fromDevice || h.from || payload.fromDevice || '手机',
      to: h.toDevice || h.to || payload.toDevice || '',
      at: h.at || payload.at || nowIso(),
      dispatched: !!h.dispatched
    };
  }
  function superHandoffLabel(h) {
    if (!h) return '';
    if (h.url) return h.url.length > 48 ? h.url.slice(0, 48) + '…' : h.url;
    if (h.text) return h.text.slice(0, 40);
    if (h.assetId) return '素材 ' + h.assetId;
    return '一条内容';
  }
  function superHandoffIcon(h) {
    var k = String((h && h.kind) || '');
    if (k === 'page' || k === 'url' || (h && h.url)) return '🌐';
    if (k === 'photo' || k === 'asset' || (h && h.assetId)) return '🖼️';
    return '📝';
  }
  function superRecentHandoffs() {
    var seen = {};
    var out = [];
    listOf(SUPER.handoffs).concat(SUPER.state && listOf(SUPER.state.handoffs) || []).forEach(function (h) {
      var id = h.id || h.handoffId || ((h.url || '') + '|' + (h.at || ''));
      if (!id || seen[id]) return;
      seen[id] = 1;
      out.push(h);
    });
    out.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
    return out.slice(0, 8);
  }
  function superHandoffContent() {
    var q = objOf(S.query);
    if (q.url || q.text || q.kind || q.assetId) {
      return { id: q.id || 'url-param', kind: q.kind || (q.url ? 'page' : 'text'), url: q.url || '', text: q.text || '', assetId: q.assetId || '', from: q.from || '手机', at: q.at || nowIso(), fromUrl: true };
    }
    return superRecentHandoffs()[0] || null;
  }
  function superContentHtml(c, big) {
    if (!c) return '';
    var kind = String(c.kind || '');
    var html = '<div class="handoff-card' + (big ? ' handoff-slide' : '') + '">' +
      '<div class="handoff-head"><span class="handoff-icon">' + superHandoffIcon(c) + '</span>' +
      '<div><div class="handoff-title">' + (big ? '从手机流转过来' : superHandoffLabel(c)) + '</div>' +
      '<div class="tiny dim">' + esc(c.from || '手机') + ' · ' + esc(dateOf(c.at)) + (c.fromUrl ? ' · 来自流转链接' : '') + '</div></div>' +
      '<span class="tag">' + esc(kind === 'page' || kind === 'url' ? '网页' : kind === 'photo' || kind === 'asset' ? '照片/素材' : '文字') + '</span></div>';
    if (c.url || kind === 'page' || kind === 'url') {
      var isHttp = /^https?:\/\//i.test(c.url || '');
      html += '<div class="handoff-body"><div class="handoff-url mono">' + esc(c.url || '（无网址）') + '</div>';
      if (big) html += '<div class="handoff-preview">🔗 ' + (isHttp ? '网页会在电脑浏览器里打开；内容留在本机，不上传。' : '非网页链接（可能是手机页面），可在手机上重新打开。') + '</div>';
      html += '</div><div class="handoff-actions">' +
        '<button class="btn btn-primary" data-super="handoff-open" data-url="' + attr(c.url || '') + '" data-testid="btn-handoff-open">在电脑上打开</button>' +
        '<button class="btn" data-super="handoff-fav" data-url="' + attr(c.url || '') + '" data-testid="btn-handoff-fav">收藏</button></div>';
    } else if (c.assetId) {
      html += '<div class="handoff-body handoff-photo"><img alt="流转素材" src="' + attr('/api/v2/assets/' + encodeURIComponent(c.assetId) + '/thumb?w=640') + '" onerror="this.style.display=\'none\'"></div>' +
        '<div class="handoff-actions"><button class="btn btn-primary" data-super="handoff-open" data-asset-id="' + attr(c.assetId) + '" data-testid="btn-handoff-open">在电脑上打开大图</button>' +
        '<a class="btn" href="#/assets" data-testid="btn-handoff-goto-assets">去素材库</a></div>';
    } else {
      html += '<div class="handoff-body"><div class="handoff-text">' + esc(c.text || '（空内容）') + '</div></div>' +
        '<div class="handoff-actions"><button class="btn btn-primary" data-super="handoff-copy" data-text="' + attr(c.text || '') + '" data-testid="btn-handoff-copy">复制文字</button>' +
        '<button class="btn" data-super="handoff-fav" data-text="' + attr(c.text || '') + '" data-testid="btn-handoff-fav">收藏</button></div>';
    }
    return html + '</div>';
  }
  function superOpenHandoff(ds) {
    if (ds.url) {
      if (/^https?:\/\//i.test(ds.url)) { try { window.open(ds.url, '_blank', 'noopener'); } catch (_) { location.href = ds.url; } toast('已在电脑浏览器打开', 'ok'); }
      else toast('这条内容不是网页链接：' + ds.url, 'warn', 4800);
      return;
    }
    if (ds.assetId) { try { window.open('/api/v2/assets/' + encodeURIComponent(ds.assetId) + '/thumb?w=640', '_blank', 'noopener'); } catch (_) {} toast('已打开素材大图', 'ok'); return; }
    if (ds.text) { superCopyText(ds.text); return; }
  }
  function superCopyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { toast('已复制到本机剪贴板', 'ok'); }, function () { toast('复制失败，可手动选择文字', 'warn'); });
        return;
      }
    } catch (_) {}
    toast('浏览器不允许自动复制，可手动选择文字', 'warn');
  }
  function superFav(ds) {
    try {
      var key = 'tenon:fav-handoff';
      var list = JSON.parse(localStorage.getItem(key) || '[]') || [];
      list.unshift({ url: ds.url || '', text: ds.text || '', assetId: ds.assetId || '', at: nowIso() });
      localStorage.setItem(key, JSON.stringify(list.slice(0, 30)));
      toast('已收藏，之后在「流转」区还能找到', 'ok');
    } catch (_) { toast('收藏失败（浏览器存储不可用）', 'warn'); }
  }
  function superSig() {
    return 'D' + superDevices().map(function (d) { return d.id + ':' + (d.online ? 1 : 0) + ':' + (d.simulated ? 1 : 0); }).join('|') +
      'P' + superPrograms().length + 'A' + JSON.stringify(SUPER.lastAsk || {}) + 'H' + superRecentHandoffs().length +
      'Q' + JSON.stringify(S.query || {}) + 'T' + (SUPER.status && SUPER.status.kind ? SUPER.status.kind : '?') +
      'B' + (SUPER.backendMissing ? 1 : 0) + 'L' + (SUPER.listening ? 1 : 0) + 'S' + (SUPER.busy ? 1 : 0);
  }
  function superDegradeBanner() {
    if (!SUPER.backendMissing) return '';
    return '<div class="super-degrade alert alert-warn" data-testid="super-degrade">' +
      '<div><strong>超级终端的 AI 服务还没接上</strong>（<code>GET /api/v2/super/state</code> / <code>POST /api/v2/super/ask</code> 未就绪）：设备来自本机账本，语音与程序点击会先降级提示。<span class="tiny dim">后端就绪后自动生效，无需刷新。</span></div>' +
      '<div class="hint-note" style="margin-top:6px"><button class="btn btn-sm" data-super="refresh" data-testid="btn-super-retry">重新检测</button></div></div>';
  }
  function superAskBlock() {
    var ask = SUPER.lastAsk;
    var steps = superStepList(ask);
    var html = '<div class="super-ask-card card v2-card">' +
      '<div class="super-ask-row"><div class="field" style="flex:1"><label>想让它做什么？直接说一句</label>' +
      '<textarea id="super-ask-input" data-testid="super-ask-input" data-keep="super-ask-input" rows="2" class="super-ask-input" placeholder="例：把昨天拍的样品图裁成方图发到工作群 / 打开微信 / 放首歌 / 回家模式"></textarea></div>' +
      '<button class="btn btn-primary super-send" id="super-send" data-testid="super-send">发送</button>' +
      '<button class="btn super-voice' + (SUPER.listening ? ' listening' : '') + '" id="super-voice" data-testid="super-voice" title="按住说话（浏览器支持时可用）">🎤<span>' + (SUPER.listening ? '正在听…' : '按住说话') + '</span></button>' +
      '</div>' +
      '<div class="super-chips" style="margin-top:10px">' + (SUPER.suggestions.length ? SUPER.suggestions : SUPER_SUGGESTIONS).slice(0, 8).map(function (s) {
        return '<button class="super-chip" data-super="ask" data-text="' + attr(s) + '" data-testid="super-suggestion">' + esc(s) + '</button>';
      }).join('') + '</div>';
    if (ask) {
      var execSteps = listOf(ask.steps);
      var showSteps = execSteps.length ? execSteps : steps;
      html += '<div class="super-reply" data-testid="super-reply">' +
        '<div class="super-reply-text"><span class="super-ai-mark">✦</span><span>' + esc(ask.reply || '') + '</span>' +
        (ask.ai && ask.ai.fallback ? '<span class="tag">规则引擎</span>' : '') + '</div>' +
        (ask.needsConfirm ? '<div class="alert alert-warn" style="margin-top:8px">这一步会改动外部内容（打印 / 发送 / 删除），需要你确认后才会执行。</div>' : '') +
        (showSteps.length ? '<div class="super-steps">' + showSteps.map(function (st) {
          var state = superStepState(st);
          var risk = st.risk || (v2ActionById(st.capabilityId) && v2ActionById(st.capabilityId).risk) || '';
          return '<div class="super-step" data-testid="super-step" data-status="' + attr(state.cls) + '" title="' + attr(st.summary || st.degradedReason || '') + '">' +
            '<span class="super-step-icon">' + state.icon + '</span>' +
            '<span class="super-step-label">' + esc(superStepLabel(st)) + (risk === 'irreversible' ? ' <span class="tag amber">不可逆</span>' : '') + '</span>' +
            (st.deviceName || st.targetDeviceName ? '<span class="tag">' + esc(st.deviceName || st.targetDeviceName) + '</span>' : '') +
            '<span class="super-step-state ' + state.cls + '">' + state.label + '</span></div>';
        }).join('') + '</div>' : '') +
        (listOf(ask.result && ask.result.taskIds).length ? '<div class="tiny dim" style="margin-top:6px">任务：' + ask.result.taskIds.map(function (t) { return '<a href="#/tasks/' + attr(t) + '">' + esc(t) + '</a>'; }).join('、') + ' · 去「任务」看执行进度</div>' : '') +
        '</div>';
    }
    return html + '</div>';
  }
  function superRenderSuper() {
    var devices = superDevices();
    var programs = superPrograms();
    var handoffs = superRecentHandoffs();
    var html = '<section class="super-hero">' +
      '<div class="super-eyebrow">TENON · 超级终端</div>' +
      '<h2 class="super-title" data-testid="super-title">榫卯 · 超级终端</h2>' +
      '<p class="super-sub">一台小软件，调动家里所有设备与程序。说一句话，或者把手机往前一倾，内容就滑到电脑上。</p>' +
      '<div class="super-hero-tags"><span class="tag cyan">本机运行 · 私有</span><span class="tag">语音 + AI 识别</span><span class="tag">手机一倾就流转</span></div>' +
      '</section>';
    html += superDegradeBanner();
    /* 设备横排 */
    html += '<section class="super-section"><div class="super-section-head"><h3>我的设备</h3><span class="hint">' + devices.filter(function (d) { return d.online; }).length + ' 台在线 · 共 ' + devices.length + ' 台</span></div>' +
      '<div class="super-devices" data-testid="super-devices">' + devices.map(function (d) {
        return '<div class="super-device' + (d.online ? ' online' : '') + (d.simulated ? ' simulated' : '') + '" data-testid="super-device" data-node-id="' + attr(d.id) + '">' +
          '<div class="super-device-top"><span class="super-device-icon">' + superKindIcon(d.kind, d.name) + '</span>' +
          '<span class="super-device-name">' + esc(d.name) + '</span>' +
          '<span class="super-device-dot ' + (d.online ? 'on' : 'off') + '" title="' + (d.online ? '在线' : '离线') + '"></span></div>' +
          '<div class="super-device-sentence">' + esc(superDeviceSentence(d)) + '</div>' +
          '<div class="super-device-badges">' + (d.online ? '<span class="badge no-dot b-ok">在线</span>' : '<span class="badge no-dot b-muted">离线</span>') +
          (d.simulated ? '<span class="badge no-dot b-warn">模拟设备</span>' : '') + '</div></div>';
      }).join('') + '</div></section>';
    /* AI 助手 */
    html += '<section class="super-section"><div class="super-section-head"><h3>AI 语音助手</h3><span class="hint">说得越像人话越好；不确定时它会问，不会替你猜</span></div>' + superAskBlock() + '</section>';
    /* 程序 tiles */
    html += '<section class="super-section"><div class="super-section-head"><h3>程序</h3><span class="hint">点一下就让电脑打开；灰色表示当前不可用</span></div>' +
      '<div class="super-programs" data-testid="super-programs">' + programs.map(function (p) {
        return '<div class="super-program' + (p.available === false ? ' disabled' : '') + '" data-testid="super-program" data-program-id="' + attr(p.id) + '" title="' + attr(p.reason || '') + '">' +
          '<button class="super-program-main" data-super="program" data-program-id="' + attr(p.id) + '" data-ask="' + attr(p.ask || ('打开' + p.name)) + '">' +
          '<span class="super-program-icon">' + superProgIcon(p) + '</span><span class="super-program-name">' + esc(p.name) + '</span></button>' +
          '<button class="super-program-aux" data-super="program-desktop" data-ask="' + attr('在电脑上打开' + p.name) + '" data-testid="super-program-open">在电脑上打开</button>' +
          (p.available === false ? '<div class="super-program-why">' + esc(p.reason || '当前不可用') + '</div>' : '') +
          '</div>';
      }).join('') + '</div></section>';
    /* 流转 */
    html += '<section class="super-section"><div class="super-section-head"><h3>流转</h3><span class="hint">从手机流过来的内容 · 0.3 秒滑入</span>' +
      '<a class="btn btn-sm" href="#/handoff" data-testid="btn-goto-handoff">打开发送页 →</a></div>' +
      '<div class="super-handoffs" data-testid="super-handoffs">' +
      (handoffs.length ? handoffs.slice(0, 6).map(function (h) {
        return '<button class="super-handoff-card handoff-slide" data-testid="super-handoff-card" data-super="handoff-card" data-handoff-id="' + attr(h.id || '') + '" data-url="' + attr(h.url || '') + '" data-text="' + attr(h.text || '') + '" data-asset-id="' + attr(h.assetId || '') + '">' +
          '<span class="super-handoff-icon">' + superHandoffIcon(h) + '</span>' +
          '<span class="super-handoff-main"><b>' + esc(superHandoffLabel(h)) + '</b><span class="tiny dim">' + esc(h.from || '手机') + ' · ' + esc(dateOf(h.at)) + '</span></span>' +
          '<span class="super-handoff-arrow">↗</span></button>';
      }).join('') : '<div class="super-empty card"><strong>还没有流转内容</strong>在手机上打开 /m，点「甩到电脑」或把手机往前一倾，内容就会出现在这里。</div>') +
      '</div></section>';
    /* 快捷去别处 */
    html += '<section class="super-section"><div class="super-section-head"><h3>更多</h3><span class="hint">素材、场景、设备细节都在这里</span></div>' +
      '<div class="super-quick"><a class="btn" href="#/assets">素材库</a><a class="btn" href="#/scenes">场景</a><a class="btn" href="#/devices">我的设备</a><a class="btn" href="#/link">互联配对</a><a class="btn" href="#/messages">消息</a></div></section>';
    return html;
  }
  function superRenderHandoff() {
    var content = superHandoffContent();
    var recent = superRecentHandoffs();
    var html = pageHead('流转接收', '从手机流转过来的内容：网页 / 照片 / 文字。滑入电脑后可以打开、收藏，内容只在本机。',
      '<div class="btn-row"><button class="btn btn-sm" data-super="refresh" data-testid="btn-handoff-refresh">刷新</button><a class="btn btn-sm" href="#/super" data-testid="btn-handoff-back">返回超级终端</a></div>');
    if (SUPER.backendMissing) {
      html += '<div class="super-degrade alert alert-warn" data-testid="super-degrade"><div>流转服务还没接上（<code>GET /api/v2/super/state</code> 未就绪）。当前显示的是页面链接里的内容；手机甩送会先降级提示。</div></div>';
    }
    html += '<div class="handoff-view" data-testid="handoff-view">' +
      (content ? superContentHtml(content, true) : '<div class="super-empty card"><strong>还没有流转内容</strong>把手机往前一倾，或点手机页「甩到电脑」，内容会在这里滑入。</div>') +
      '</div>';
    html += '<section class="super-section"><div class="super-section-head"><h3>最近的流转</h3><span class="hint">' + recent.length + ' 条</span></div>' +
      '<div class="super-handoffs">' + (recent.length ? recent.map(function (h) {
        return '<button class="super-handoff-card" data-testid="super-handoff-card" data-super="handoff-card" data-handoff-id="' + attr(h.id || '') + '" data-url="' + attr(h.url || '') + '" data-text="' + attr(h.text || '') + '" data-asset-id="' + attr(h.assetId || '') + '">' +
          '<span class="super-handoff-icon">' + superHandoffIcon(h) + '</span>' +
          '<span class="super-handoff-main"><b>' + esc(superHandoffLabel(h)) + '</b><span class="tiny dim">' + esc(h.from || '手机') + ' · ' + esc(dateOf(h.at)) + '</span></span>' +
          '<span class="super-handoff-arrow">↗</span></button>';
      }).join('') : '<div class="tiny dim">暂无历史流转</div>') + '</div></section>';
    return html;
  }
  function superOnClick(ev) {
    var t0 = ev.target;
    if (t0 && t0.closest) {
      if (t0.closest('#super-send')) {
        ev.preventDefault();
        var askInput0 = $('#super-ask-input');
        superAsk(askInput0 ? askInput0.value : '');
        return;
      }
      if (t0.closest('#super-voice')) {
        ev.preventDefault();
        superVoice();
        return;
      }
    }
    var el = t0 && t0.closest ? t0.closest('[data-super]') : null;
    if (!el) return;
    ev.preventDefault();
    S.lastUserActionAt = Date.now();
    var act = el.getAttribute('data-super');
    var ds = el.dataset || {};
    if (act === 'ask') superAsk(ds.text || '');
    else if (act === 'program' || act === 'program-desktop') superAsk(ds.ask || '');
    else if (act === 'refresh') superLoadState();
    else if (act === 'handoff-card') {
      var target = ds.url ? { url: ds.url } : (ds.assetId ? { assetId: ds.assetId } : { text: ds.text || '' });
      var c = { id: ds.handoffId, kind: target.url ? 'page' : (target.assetId ? 'photo' : 'text'), url: target.url || '', assetId: target.assetId || '', text: target.text || '', from: '手机', at: nowIso() };
      S.handoffPreview = c;
      location.hash = '#/handoff?kind=' + encodeURIComponent(c.kind) + (c.url ? '&url=' + encodeURIComponent(c.url) : '') + (c.text ? '&text=' + encodeURIComponent(c.text) : '') + (c.assetId ? '&assetId=' + encodeURIComponent(c.assetId) : '');
    } else if (act === 'handoff-open') superOpenHandoff(ds);
    else if (act === 'handoff-fav') superFav(ds);
    else if (act === 'handoff-copy') superCopyText(ds.text || '');
  }
  function superAttach() {
    /* 事件全部委托到 document：重绘替换 #view 后按钮依然可用（super 页面每 12s 会轻量刷新） */
    document.addEventListener('click', superOnClick);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && ev.target && ev.target.id === 'super-ask-input') {
        ev.preventDefault();
        if (SUPER.listening && SUPER.rec) { try { SUPER.rec.stop(); } catch (_) {} }
        superAsk(ev.target.value);
      }
    });
    setInterval(function () {
      if (superIsRoute(S.route) && !modalOpen() && !S.stale) {
        if (!SUPER.loadedAt || Date.now() - SUPER.loadedAt > 12000) superLoadState();
      }
    }, 6000);
  }

  /* ---------- 初始化 ---------- */
  function init() {
    setToken(getToken());
    if (!location.hash || location.hash === '#') { try { history.replaceState(null, '', '#/super'); } catch (_) {} }
    var cached = loadSnapshot();
    if (cached) { S.snapshot = cached.snapshot; S.cachedAt = cached.at; S.stale = true; }
    var r = parseRoute();
    S.route = r.name;
    S.param = r.param;
    S.query = r.query || {};
    if (S.route === 'tasks' && S.param) S.selectedTaskId = S.param;
    if (v2IsRoute(S.route)) v2EnsureLoaded(S.route);
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
    v2Attach();
    superAttach();
    window.addEventListener('hashchange', onRoute);
    setInterval(function () { if (!S.sseOpen) loadState(); }, 12000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) loadState(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
