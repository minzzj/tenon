/* 榫卯 Tenon v2-P0 · 手机页（/m/link 与 /m/assets 共用）
 * 原生 JS、无依赖、无 CDN；真实调用 /api/v2/*；接口未就绪时清晰降级；
 * 断网时读 localStorage 快照显示「数据截至 HH:mm」并禁写。 */
(function () {
  'use strict';

  var TOKEN_KEY = 'tenon:token';
  var CACHE_KEY = 'tenon:m-v2-cache';
  var BASKET_KEY = 'tenon:m-v2-basket';
  var PAGE = (document.body && document.body.getAttribute('data-page')) || 'link';
  window.__tenonErrors = window.__tenonErrors || [];
  window.addEventListener('error', function (e) {
    try { window.__tenonErrors.push(String((e && e.message) || e || 'error')); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    try { window.__tenonErrors.push('unhandledrejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || '')); } catch (_) {}
  });

  var S = {
    peers: [],
    pairing: null,
    nodes: [],
    localCode: '',
    transfers: [],
    clipHistory: [],
    clipboard: null,
    notifications: [],
    assets: [],
    total: 0,
    detail: null,
    basket: [],
    stale: false,
    cachedAt: 0,
    dataAsOf: null,
    serverOk: false,
    loading: false,
    status: {},
    searchQ: '',
    kindFilter: '',
    busy: false,
    renderTimer: null
  };

  function $(sel) { return document.querySelector(sel); }
  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function listOf(v) { return Array.isArray(v) ? v : []; }
  function objOf(v) { return v && typeof v === 'object' ? v : {}; }
  function arrOf(data, keys) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    var cand = keys || ['items', 'list', 'data', 'results', 'peers', 'assets', 'events'];
    for (var i = 0; i < cand.length; i++) if (Array.isArray(data[cand[i]])) return data[cand[i]];
    return [];
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
  function bytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (_) {} }

  function api(path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    var token = opts.token !== undefined ? opts.token : getToken();
    if (token) headers['x-tenon-token'] = token;
    var body;
    if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; try { body = JSON.stringify(opts.body); } catch (_) { body = '{}'; } }
    return fetch(path, { method: opts.method || 'GET', headers: headers, body: body, credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) {
        var ct = (res.headers && res.headers.get('content-type')) || '';
        var p = ct.indexOf('json') >= 0 ? res.json().catch(function () { return null; }) : res.text().catch(function () { return null; });
        return p.then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
      })
      .catch(function (err) { return { ok: false, status: 0, network: true, error: String((err && err.message) || err) }; });
  }
  function setStatus(key, res) {
    if (res.ok) { S.status[key] = { ok: true, http: res.status }; return; }
    var kind = res.network ? 'offline' : (res.status === 404 ? 'missing' : ((res.status === 401 || res.status === 403) ? 'auth' : 'error'));
    S.status[key] = { ok: false, kind: kind, http: res.status };
  }
  function toast(msg, kind) {
    var root = $('#m-toast');
    if (!root) {
      root = document.createElement('div');
      root.id = 'm-toast';
      root.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:99;display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;width:calc(100% - 32px);max-width:420px';
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
    return '数据截至 ' + (same ? hhmm(d) : ((d.getMonth() + 1) + '/' + d.getDate() + ' ' + hhmm(d))) + (S.stale ? '（缓存）' : '');
  }

  /* ---------- 本地缓存（断网可读） ---------- */
  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        at: Date.now(),
        dataAsOf: S.dataAsOf,
        peers: S.peers,
        transfers: S.transfers.slice(0, 10),
        clipHistory: S.clipHistory.slice(0, 10),
        notifications: S.notifications.slice(0, 10),
        clipboard: S.clipboard,
        assets: S.assets,
        total: S.total
      }));
    } catch (_) {}
  }
  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return false;
      var c = JSON.parse(raw);
      if (!c || typeof c !== 'object') return false;
      S.cachedAt = c.at || 0;
      S.dataAsOf = c.dataAsOf || null;
      S.peers = listOf(c.peers);
      S.transfers = listOf(c.transfers);
      S.clipHistory = listOf(c.clipHistory);
      S.notifications = listOf(c.notifications);
      S.clipboard = c.clipboard || null;
      S.assets = listOf(c.assets);
      S.total = c.total || S.assets.length;
      return true;
    } catch (_) { return false; }
  }
  function readBasket() {
    try { return JSON.parse(localStorage.getItem(BASKET_KEY) || '[]') || []; } catch (_) { return []; }
  }
  function writeBasket(list) {
    try { localStorage.setItem(BASKET_KEY, JSON.stringify(list.slice(0, 50))); } catch (_) {}
  }

  /* ---------- 加载 ---------- */
  function load() {
    if (S.loading) return Promise.resolve();
    S.loading = true;
    return api('/api/state').then(function (stateRes) {
      var online = stateRes.ok && stateRes.data && !stateRes.data.error;
      if (online) {
        S.serverOk = true;
        S.stale = false;
        S.dataAsOf = stateRes.data.dataAsOf || S.dataAsOf;
        S.nodes = listOf(stateRes.data.nodes);
      } else {
        S.serverOk = false;
        S.stale = true;
        loadCache();
      }
      var jobs = [];
      if (online && PAGE === 'link') {
        jobs.push(api('/api/v2/link/peers').then(function (r) {
          setStatus('peers', r);
          if (r.ok && r.data) S.peers = arrOf(r.data, ['peers', 'items', 'list']);
        }));
        jobs.push(api('/api/v2/link/pair/qr').then(function (r) {
          setStatus('pairQr', r);
          if (r.ok && r.data && r.data.code) S.pairing = r.data;
        }));
        jobs.push(api('/api/v2/link/clipboard/latest').then(function (r) {
          setStatus('clipboard', r);
          if (r.ok && r.data) S.clipboard = r.data.clipboard || r.data.item || r.data;
        }));
        jobs.push(api('/api/v2/link/transfers').then(function (r) {
          setStatus('transfers', r);
          if (r.ok && r.data) S.transfers = arrOf(r.data, ['transfers', 'items', 'list']).slice(0, 10);
        }));
        jobs.push(api('/api/v2/link/notifications').then(function (r) {
          setStatus('notifications', r);
          if (r.ok && r.data) S.notifications = arrOf(r.data, ['notifications', 'items', 'list']).slice(0, 10);
        }));
      } else if (online && PAGE === 'assets') {
        var q = '/api/v2/assets?limit=24';
        if (S.searchQ) q += '&q=' + encodeURIComponent(S.searchQ);
        if (S.kindFilter) q += '&kind=' + encodeURIComponent(S.kindFilter);
        jobs.push(api(q).then(function (r) {
          setStatus('assets', r);
          if (r.ok && r.data) { S.assets = arrOf(r.data, ['assets', 'items', 'list']); S.total = r.data.total !== undefined ? r.data.total : S.assets.length; }
        }));
        jobs.push(api('/api/v2/assets/basket').then(function (r) {
          setStatus('basketList', r);
          if (r.ok && r.data) { S.basket = arrOf(r.data, ['items', 'basket', 'list']); writeBasket(S.basket); }
        }));
      }
      if (PAGE === 'assets') {
        if (!S.basket.length) S.basket = readBasket();
        S.total = Math.max(S.total, 0);
      }
      return Promise.all(jobs).then(function () {
        S.loading = false;
        if (online) saveCache();
        render();
      });
    });
  }

  /* ---------- 实时事件 ---------- */
  var es = null;
  var everConnected = false;
  function connectSSE() {
    if (!('EventSource' in window)) return;
    try { es = new EventSource('/api/stream'); } catch (_) { return; }
    es.onmessage = function (ev) {
      var obj = null;
      try { obj = JSON.parse(ev.data); } catch (_) { return; }
      if (!obj || !obj.type) return;
      var t = String(obj.type);
      var d = obj.data || {};
      var at = obj.at || new Date().toISOString();
      if (t === 'transfer.started') {
        upsertTransfer({ transferId: d.transferId, peerId: d.peerId, direction: d.direction, files: d.files, totalBytes: d.totalBytes, status: d.direction === 'receive' ? 'receiving' : 'started', progress: 0, at: at });
        scheduleRender();
      } else if (t === 'transfer.completed') {
        var tr = upsertTransfer({ transferId: d.transferId, peerId: d.peerId, direction: d.direction, files: d.files });
        tr.status = 'completed'; tr.progress = 100; tr.bytes = d.bytes; tr.ms = d.ms; tr.speedBps = d.speedBps;
        scheduleRender();
      } else if (t === 'transfer.failed') {
        var tf = upsertTransfer({ transferId: d.transferId });
        tf.status = 'failed'; tf.reason = d.reason;
        scheduleRender();
      } else if (t === 'clipboard.shared') {
        S.clipHistory.unshift({ kind: d.kind || 'text', text: d.preview || d.text || '', at: at, from: d.from });
        if (S.clipHistory.length > 20) S.clipHistory.length = 20;
        S.clipboard = { kind: d.kind, preview: d.preview || d.text, from: d.from, at: at };
        scheduleRender();
      } else if (t === 'notification.relayed') {
        S.notifications.unshift({ app: d.app, title: d.title, preview: d.preview, at: at });
        if (S.notifications.length > 20) S.notifications.length = 20;
        scheduleRender();
      } else if (t === 'link.peer.seen' || t === 'link.paired' || t === 'link.revoked') {
        load();
      }
    };
    es.onopen = function () { everConnected = true; };
    es.onerror = function () {
      try { es.close(); } catch (_) {}
      es = null;
      if (!everConnected) return;
      setTimeout(connectSSE, 10000);
    };
  }
  function upsertTransfer(t) {
    for (var i = 0; i < S.transfers.length; i++) if (S.transfers[i].transferId === t.transferId) {
      for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) S.transfers[i][k] = t[k];
      return S.transfers[i];
    }
    t.progress = t.progress === undefined ? 0 : t.progress;
    S.transfers.unshift(t);
    if (S.transfers.length > 10) S.transfers.length = 10;
    return t;
  }
  function scheduleRender() {
    if (S.renderTimer) return;
    S.renderTimer = setTimeout(function () {
      S.renderTimer = null;
      render();
    }, 400);
  }

  /* ---------- 渲染 ---------- */
  function degradeText() {
    var missing = [], auth = [], offline = [];
    for (var k in S.status) {
      if (!Object.prototype.hasOwnProperty.call(S.status, k)) continue;
      var st = S.status[k];
      if (st.ok) continue;
      if (st.kind === 'missing') missing.push(k);
      else if (st.kind === 'auth') auth.push(k);
      else if (st.kind === 'offline') offline.push(k);
    }
    if (!missing.length && !auth.length && !offline.length) return '';
    var msg = [];
    if (offline.length) msg.push('无法连接中枢（离线）');
    if (missing.length) msg.push('v2 接口未挂载（HTTP 404）：' + missing.join(' / '));
    if (auth.length) msg.push('需要操作令牌（HTTP 401）');
    return '<div class="v2-degrade alert alert-warn" data-testid="m-v2-degrade">' + esc(msg.join(' · ')) +
      ' <button class="btn btn-sm" data-mv2="refresh">重试</button></div>';
  }
  function render() {
    var asof = $('#m-asof');
    if (asof) asof.textContent = asOfLabel();
    var banner = $('#m-offline-banner-v2');
    if (banner) {
      if (S.stale) {
        banner.classList.remove('hidden');
        var txt = $('#m-offline-text-v2');
        if (txt) txt.textContent = asOfLabel() + ' · 无法连接中枢，显示本机缓存（只读）';
      } else {
        banner.classList.add('hidden');
      }
    }
    var degrade = $('#m-degrade');
    if (degrade) degrade.innerHTML = degradeText();
    if (PAGE === 'link') renderLink();
    else renderAssets();
    var sendables = document.querySelectorAll('[data-mv2-write]');
    for (var i = 0; i < sendables.length; i++) sendables[i].disabled = S.stale;
  }
  function pairCode() {
    if (S.pairing && S.pairing.code) return String(S.pairing.code);
    if (!S.localCode) {
      var s = '';
      for (var i = 0; i < 6; i++) s += String(Math.floor(Math.random() * 10));
      S.localCode = s;
    }
    return S.localCode;
  }
  function renderLink() {
    var codeEl = $('#m-pair-code');
    if (codeEl) codeEl.textContent = pairCode().replace(/(\d{3})(\d{3})/, '$1 $2');
    var peers = $('#m-peers');
    if (peers) {
      peers.innerHTML = S.peers.length ? S.peers.map(function (p) {
        var id = p.id || p.peerId || p.deviceId || '';
        var trusted = p.trusted !== undefined ? !!p.trusted : (p.paired !== undefined ? !!p.paired : p.status === 'trusted');
        var online = p.online !== false;
        return '<div class="v2-m-row" data-testid="m-link-peer" data-peer-id="' + esc(id) + '">' +
          '<span class="online-dot ' + (online ? 'on' : 'off') + '"></span>' +
          '<div style="min-width:0"><div class="nm">' + esc(p.name || id || '设备') + '</div>' +
          '<div class="sub">' + esc(p.platform || '') + (p.ip ? ' · ' + esc(p.ip) + (p.port ? ':' + esc(p.port) : '') : '') + '</div></div>' +
          '<div class="right">' + (trusted ? '<span class="badge no-dot b-ok">已信任</span>' : '<span class="badge no-dot b-warn">未配对</span>') + '</div></div>';
      }).join('') : '<div class="m-receipt"><div class="sum muted">未发现设备：同一 WiFi 下电脑会出现在这里，也可用配对码手动配对。</div></div>';
    }
    var clipBox = $('#m-clipboard-latest');
    if (clipBox) {
      var c = S.clipboard;
      clipBox.innerHTML = c ? '<div class="k" style="font-size:10px;color:var(--dim)">最近接收</div><div style="font-size:12.5px;margin-top:3px;word-break:break-word">' + esc(c.preview || c.text || '（空内容）') + '</div><div class="tiny dim">' + esc(c.from ? '来自 ' + c.from + ' · ' : '') + esc(dateOf(c.at)) + '</div>' : '<div class="tiny dim">暂无接收记录</div>';
    }
    var histEl = $('#m-clipboard-history');
    if (histEl) {
      histEl.innerHTML = S.clipHistory.length ? S.clipHistory.slice(0, 6).map(function (h) {
        return '<div class="m-receipt" data-testid="m-clipboard-item"><div class="sum">' + esc(String(h.text || '').slice(0, 160)) + '</div><div class="foot"><span class="tag">' + esc(h.kind === 'link' ? '链接' : '文本') + '</span><span>' + esc(dateOf(h.at)) + '</span></div></div>';
      }).join('') : '<div class="tiny dim">本会话发送 / 接收的剪贴板记录会出现在这里</div>';
    }
    var trEl = $('#m-transfers');
    if (trEl) {
      trEl.innerHTML = S.transfers.length ? S.transfers.map(function (t) {
        var pct = Math.max(0, Math.min(100, t.progress || 0));
        var files = listOf(t.files).map(function (f) { return f && f.name ? f.name : '文件'; });
        var status = t.status === 'completed' ? '已完成 · SHA-256 校验通过' : t.status === 'failed' ? ('失败' + (t.reason ? '：' + t.reason : '')) : ('传输中 ' + pct + '%' + (t.speedBps ? ' · ' + bytes(t.speedBps) + '/s' : ''));
        return '<div class="m-receipt" data-testid="m-transfer-row" data-transfer-id="' + esc(t.transferId) + '">' +
          '<div class="sum">' + esc(files.join('、') || '文件') + ' · ' + esc(bytes(t.totalBytes || 0)) + '</div>' +
          '<div class="progress" data-testid="m-transfer-progress" style="margin-top:6px"><i style="width:' + pct + '%"></i></div>' +
          '<div class="foot"><span>' + esc(status) + '</span></div></div>';
      }).join('') : '<div class="tiny dim">还没有传输记录</div>';
    }
    var notifEl = $('#m-notifications');
    if (notifEl) {
      notifEl.innerHTML = S.notifications.length ? S.notifications.slice(0, 8).map(function (n) {
        return '<div class="m-receipt" data-testid="m-notification-row"><div class="top"><span class="tag">' + esc(n.app || '通知') + '</span><span>' + esc(n.title || '') + '</span></div><div class="sum">' + esc(String(n.preview || '').slice(0, 100)) + '</div><div class="foot"><span>' + esc(dateOf(n.at)) + '</span></div></div>';
      }).join('') : '<div class="tiny dim">手机通知镜像会显示在这里（notification.relayed）</div>';
    }
  }
  function renderAssets() {
    var grid = $('#m-assets-grid');
    var countEl = $('#m-asset-count');
    if (countEl) countEl.textContent = String(S.total || S.assets.length);
    if (grid) {
      grid.innerHTML = S.assets.length ? S.assets.map(function (a) {
        var id = a.id || a.assetId;
        var thumb = (a.thumbUrls && (a.thumbUrls['320'] || a.thumbUrls[320])) || ('/api/v2/assets/' + encodeURIComponent(id) + '/thumb?w=320');
        var hasThumb = !!(a.thumbUrls || a.thumb) && !a.thumbError;
        return '<div class="v2-m-asset" data-testid="m-asset-card" data-asset-id="' + esc(id) + '" data-mv2="asset-open">' +
          (hasThumb ? '<img loading="lazy" alt="' + esc(a.name || '') + '" src="' + esc(thumb) + '" onerror="this.style.opacity=0.15">' : '<div style="aspect-ratio:1/1;display:grid;place-items:center;font-size:10px;color:var(--dim)">无缩略图</div>') +
          '<div class="nm">' + esc(a.name || id) + '</div></div>';
      }).join('') : '<div class="m-receipt" style="grid-column:1/-1"><div class="sum muted">暂无素材：手机分享/上传或电脑扫描入库后出现在这里。</div></div>';
    }
    var detail = $('#m-asset-detail');
    if (detail) {
      var d = S.detail;
      detail.innerHTML = d ? '<div class="m-receipt" data-testid="m-asset-detail" data-asset-id="' + esc(d.id || d.assetId) + '">' +
        '<div class="top"><span>' + esc(d.name || d.id) + '</span><span class="badge no-dot b-muted" style="margin-left:auto">' + esc(d.kind || '素材') + '</span></div>' +
        '<div class="sum">' + bytes(d.size) + ' · ' + esc(d.sha256 ? 'SHA-256 ' + String(d.sha256).slice(0, 12) + '…' : '无哈希记录') + '</div>' +
        '<div class="sum" style="color:var(--muted)">来源：' + esc((objOf(d.source).deviceId || '未知设备') + (objOf(d.source).path ? ' · ' + objOf(d.source).path : '')) + '</div>' +
        ((d.ocr && d.ocr.text) || d.ocrText ? '<div class="sum" style="margin-top:4px">OCR：' + esc(String((d.ocr && d.ocr.text) || d.ocrText).slice(0, 160)) + '</div>' : '') +
        (listOf(d.tags).length ? '<div class="foot">' + listOf(d.tags).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join(' ') + '</div>' : '') +
        '<div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-mv2="basket-add" data-asset-id="' + esc(d.id || d.assetId) + '" data-testid="m-btn-basket-add" data-mv2-write="1">加入中转站</button>' +
        '<button class="btn btn-sm" data-mv2="detail-close">关闭</button></div></div>'
        : '<div class="m-receipt"><div class="sum muted">点上面素材卡查看详情，可加入中转站。</div></div>';
    }
    var basket = $('#m-basket');
    if (basket) {
      basket.innerHTML = S.basket.length ? S.basket.map(function (b) {
        var stat = b.status || 'staged';
        return '<div class="v2-m-row" data-testid="m-basket-item" data-item-id="' + esc(b.id || b.basketId || b.assetId) + '"><div><div class="nm">' + esc(b.name || b.assetId || b.id) + '</div><div class="sub">' + esc(b.kind || '素材') + ' · ' + bytes(b.size) + ' · ' + (stat === 'taken' ? '已取用' : '待取用') + (b.to ? ' · ' + esc(b.to) : '') + '</div></div>' +
          (stat !== 'taken' ? '<div class="right"><span class="badge no-dot b-warn">待取用</span></div>' : '<div class="right"><span class="badge no-dot b-ok">已取用</span></div>') + '</div>';
      }).join('') : '<div class="tiny dim">中转站是空的：在「素材」页选素材加入。</div>';
      var bcount = $('#m-basket-count');
      if (bcount) bcount.textContent = String(S.basket.filter(function (b) { return (b.status || 'staged') === 'staged'; }).length);
    }
    var targetSel = $('#m-basket-target');
    if (targetSel) {
      var cur = targetSel.value;
      var opts = ['<option value="">不指定（本机中转站）</option>'];
      listOf(S.nodes).forEach(function (n) { opts.push('<option value="' + esc(n.id) + '">' + esc(n.name) + '（' + esc(n.id) + '）</option>'); });
      opts.push('<option value="node-local">node-local</option>');
      targetSel.innerHTML = opts.join('');
      if (cur) targetSel.value = cur;
    }
  }

  /* ---------- 写操作 ---------- */
  function ensureToken() {
    var t = getToken();
    if (t) return Promise.resolve(t);
    var panel = $('#m-token-row');
    if (panel) panel.classList.remove('hidden');
    toast('写操作需要令牌：输入启动日志里的 operatorToken', 'warn');
    return Promise.resolve('');
  }
  function saveToken() {
    var input = $('#m-token-input');
    var tok = input ? String(input.value || '').trim() : '';
    if (!tok) { toast('请输入令牌', 'warn'); return; }
    api('/api/auth', { method: 'POST', body: { token: tok }, token: tok }).then(function (r) {
      if (r.ok && r.data && r.data.ok !== false) {
        setToken(tok);
        var panel = $('#m-token-row');
        if (panel) panel.classList.add('hidden');
        toast('令牌已保存，可以继续操作', 'ok');
        load();
      } else {
        toast('令牌校验失败' + (r.status ? '（HTTP ' + r.status + '）' : '（无法连接）'), 'bad');
      }
    });
  }
  function mv2Write(path, body, label, after) {
    if (S.stale) { toast(asOfLabel() + ' · 离线只读，写操作不可用', 'warn'); return Promise.resolve(null); }
    return ensureToken().then(function (tok) {
      if (!tok) return null;
      var opts = { method: 'POST', body: body || {}, token: tok };
      return api(path, opts).then(function (r) {
        if (r.status === 401) { setToken(''); ensureToken(); toast('令牌失效，请重新输入', 'bad'); return null; }
        if (r.network) { S.stale = true; render(); toast(label + '失败：无法连接中枢', 'bad'); return null; }
        if (!r.ok) { toast(label + '失败：HTTP ' + r.status, 'bad'); return null; }
        if (r.data && r.data.ok === false) { toast(label + '失败：' + ((r.data && r.data.error) || '服务端拒绝'), 'bad'); return null; }
        toast(label + '：已提交', 'ok');
        if (typeof after === 'function') after(r.data);
        return r.data;
      });
    });
  }
  function doPair() {
    var input = $('#m-link-code-input');
    var code = input ? String(input.value || '').replace(/\D/g, '') : '';
    if (!code) { toast('输入电脑上显示的配对码', 'warn'); return; }
    mv2Write('/api/v2/link/pair', { code: code }, '配对', function () {
      if (input) input.value = '';
      load();
    });
  }
  function sendClipboard() {
    var input = $('#m-clipboard-input');
    var text = input ? String(input.value || '').trim() : '';
    if (!text) { toast('先说点要互传的内容', 'warn'); return; }
    mv2Write('/api/v2/link/clipboard', { kind: /^https?:\/\//.test(text) ? 'link' : 'text', text: text }, '发送剪贴板', function () {
      if (input) input.value = '';
      S.clipHistory.unshift({ kind: 'text', text: text, at: new Date().toISOString() });
      render();
    });
  }
  function uploadFile() {
    var input = $('#m-file-input');
    var files = input && input.files ? Array.prototype.slice.call(input.files) : [];
    if (!files.length) { toast('先选择要发送的文件', 'warn'); return; }
    var peerId = '';
    if (S.peers.length) {
      for (var i = 0; i < S.peers.length; i++) {
        var trusted = S.peers[i].trusted !== undefined ? !!S.peers[i].trusted : (S.peers[i].paired !== undefined ? !!S.peers[i].paired : S.peers[i].status === 'trusted');
        if (trusted) { peerId = S.peers[i].id || S.peers[i].peerId || S.peers[i].deviceId; break; }
        if (!peerId) peerId = S.peers[i].id || S.peers[i].peerId || S.peers[i].deviceId || '';
      }
    }
    if (!peerId) { toast('先配对一台电脑，再传文件', 'warn'); return; }
    var meta = files.map(function (f) { return { name: f.name, size: f.size }; });
    var total = files.reduce(function (a, f) { return a + f.size; }, 0);
    ensureToken().then(function (tok) {
      if (!tok) return;
      if (S.stale) { toast('离线只读：无法上传', 'warn'); return; }
      api('/api/v2/link/transfer/init', { method: 'POST', body: { peerId: peerId, direction: 'send', files: meta }, token: tok }).then(function (r) {
        if (!r.ok || !r.data || !r.data.transferId) { toast('发起传输失败：HTTP ' + r.status, 'bad'); return; }
        var transferId = r.data.transferId;
        var chunkSize = Number(r.data.chunkSize) || 1048576;
        var t = upsertTransfer({ transferId: transferId, peerId: peerId, direction: 'send', files: meta, totalBytes: total, status: 'uploading', progress: 0 });
        render();
        var fi = 0, off = 0, sent = 0;
        function step() {
          if (fi >= files.length) return Promise.resolve();
          var file = files[fi];
          if (off >= file.size) { fi++; off = 0; return step(); }
          var end = Math.min(off + chunkSize, file.size);
          var blob = file.slice(off, end);
          var started = Date.now();
          return fetch('/api/v2/link/transfer/' + encodeURIComponent(transferId) + '/chunk?offset=' + sent, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream', 'x-tenon-token': tok },
            body: blob,
            credentials: 'same-origin'
          }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            sent += blob.size;
            off = end;
            t.progress = total ? Math.min(99, Math.round(sent / total * 100)) : 0;
            t.speedBps = Math.round(blob.size / Math.max(0.001, (Date.now() - started) / 1000));
            scheduleRender();
            return step();
          });
        }
        step().then(function () {
          return api('/api/v2/link/transfer/' + encodeURIComponent(transferId) + '/finish', { method: 'POST', body: {}, token: tok });
        }).then(function (fin) {
          t.status = 'completed';
          t.progress = 100;
          render();
          toast('文件已发送：SHA-256 校验由中枢完成', 'ok');
        }).catch(function (err) {
          t.status = 'failed';
          t.reason = String((err && err.message) || err);
          render();
          toast('传输失败：' + t.reason, 'bad');
        });
      });
    });
  }
  function openAsset(id) {
    api('/api/v2/assets/' + encodeURIComponent(id)).then(function (r) {
      if (r.ok && r.data) { S.detail = r.data.asset || r.data; render(); }
      else toast('素材详情加载失败（HTTP ' + r.status + '）', 'warn');
    });
  }
  function basketAdd(id) {
    mv2Write('/api/v2/assets/basket', { items: [{ assetId: id }] }, '加入中转站', function () {
      load();
    });
  }
  function basketTake() {
    var staged = S.basket.filter(function (b) { return (b.status || 'staged') === 'staged'; });
    if (!staged.length) { toast('中转站没有待取用的条目', 'warn'); return; }
    var sel = $('#m-basket-target');
    var to = sel ? sel.value : '';
    mv2Write('/api/v2/assets/basket/take', { ids: staged.map(function (b) { return b.id || b.basketId || b.assetId; }), to: to || undefined }, '中转站取用', function () { load(); });
  }
  function basketClear() {
    writeBasket([]);
    toast('本机缓存列表已清空（服务端条目请在电脑端取用）', 'warn');
    load();
  }

  /* ---------- 事件绑定 ---------- */
  function onClick(ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('[data-mv2]') : null;
    if (!el) return;
    ev.preventDefault();
    var act = el.getAttribute('data-mv2');
    switch (act) {
      case 'refresh': load(); break;
      case 'pair': doPair(); break;
      case 'clipboard-send': sendClipboard(); break;
      case 'upload': uploadFile(); break;
      case 'asset-open': openAsset(el.getAttribute('data-asset-id')); break;
      case 'detail-close': S.detail = null; render(); break;
      case 'basket-add': basketAdd(el.getAttribute('data-asset-id')); break;
      case 'basket-take': basketTake(); break;
      case 'basket-clear': basketClear(); break;
      case 'token-save': saveToken(); break;
      case 'goto-assets': location.href = '/m/assets'; break;
      case 'goto-link': location.href = '/m/link'; break;
      case 'goto-home': location.href = '/m'; break;
      default: break;
    }
  }
  function onChange(ev) {
    var t = ev.target;
    if (!t) return;
    if (t.id === 'm-asset-search') {
      S.searchQ = String(t.value || '');
      if (S.searchTimer) clearTimeout(S.searchTimer);
      S.searchTimer = setTimeout(load, 420);
    } else if (t.id === 'm-asset-filter-kind') {
      S.kindFilter = t.value;
      load();
    }
  }

  function init() {
    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    if (PAGE === 'assets') S.basket = readBasket();
    loadCache();
    render();
    load();
    connectSSE();
    setInterval(function () {
      if (S.stale && getToken() !== undefined) load();
    }, 8000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
