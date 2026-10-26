/* 榫卯 Tenon v2 · 统一错误码文案库（Round4）
 * 12 个高频错误码：现象 / 原因 / 下一步（可点击）/ 复制诊断（版本·端口·时间·最近 5 条事件）。
 * 用法：<script src="errors.js"></script> 后 window.TenonErrors.render('PORT_IN_USE',{detail:'...'})
 * 兼容桌面 app.js 与手机独立页（不依赖任何框架）。 */
(function () {
  'use strict';
  var EVENTS_KEY = 'tenon:diag-events-v1';
  var CODES = {
    PORT_IN_USE: {
      title: '端口被占用', severity: 'bad',
      phenomenon: '中枢启动失败，日志出现 EADDRINUSE / 端口已被占用。',
      cause: '另一个程序（或上一个没退干净的榫卯实例）占着中枢端口。',
      steps: [{ label: '查看端口与进程诊断', href: '#/devices' }, { label: '改端口重试', href: '#/devices' }],
    },
    FIREWALL: {
      title: '防火墙拦截', severity: 'warn',
      phenomenon: '手机能打开配对页，但一直转圈 / 传输失败；局域网发现看不到设备。',
      cause: 'Windows 防火墙或杀毒软件拦截了中枢端口与局域网发现（UDP）。',
      steps: [{ label: '打开安装与防火墙说明', href: '#/devices' }, { label: '允许专用网络访问', href: '#/devices' }],
    },
    CODE_EXPIRED: {
      title: '配对码已过期', severity: 'warn',
      phenomenon: '输入 6 位配对码提示「过期 / 无效」。',
      cause: '配对码有有效期（默认 5 分钟），超时后自动失效。',
      steps: [{ label: '重新生成配对码', href: '#/link' }],
    },
    VERSION_MISMATCH: {
      title: '版本不匹配', severity: 'warn',
      phenomenon: '手机/桌面 App 连接后提示协议不一致，或部分功能不可用。',
      cause: '电脑端与手机端安装包版本不同，v2 协议字段有差异。',
      steps: [{ label: '下载最新安装包', href: '#/devices' }, { label: '查看版本号', href: '#/devices' }],
    },
    DISK_FULL: {
      title: '磁盘空间不足', severity: 'bad',
      phenomenon: '上传素材 / 传文件失败，提示写入失败或空间不足。',
      cause: '素材库或接收目录所在磁盘可用空间不足。',
      steps: [{ label: '清理素材库', href: '#/assets' }, { label: '查看存储占用', href: '#/assets' }],
    },
    PERMISSION_DENIED: {
      title: '权限不足', severity: 'warn',
      phenomenon: '操作被拒绝（HTTP 403），按钮提示无权限。',
      cause: '当前使用的是只读角色 / 缺少操作员令牌，或设备未绑定。',
      steps: [{ label: '输入操作员令牌', href: '#/link' }, { label: '检查设备绑定状态', href: '#/devices' }],
    },
    TIMEOUT: {
      title: '请求超时', severity: 'warn',
      phenomenon: '页面一直加载中，或操作长时间没有响应。',
      cause: '中枢忙碌 / 网络不稳定 / 远程设备无响应。',
      steps: [{ label: '重试', action: 'retry' }, { label: '刷新页面', href: '#' }],
    },
    CHECKSUM_FAILED: {
      title: '校验失败', severity: 'bad',
      phenomenon: '文件传输完成但提示 SHA-256 校验不一致 / 文件损坏。',
      cause: '传输中断、磁盘写入错误或文件在传输过程中被改动。',
      steps: [{ label: '重新发送文件', href: '#/link' }, { label: '查看传输详情', href: '#/link' }],
    },
    DEVICE_OFFLINE: {
      title: '设备离线', severity: 'warn',
      phenomenon: '操作提示设备离线 / 遥控无响应。',
      cause: '目标电脑或手机的榫卯程序没有运行，或网络断开。',
      steps: [{ label: '查看设备状态', href: '#/devices' }, { label: '启动对方榫卯', href: '#/devices' }],
    },
    TOKEN_INVALID: {
      title: '令牌失效', severity: 'warn',
      phenomenon: '提示需要操作令牌 / 令牌无效（HTTP 401）。',
      cause: '操作员令牌被重置，或复制粘贴时多了空格。',
      steps: [{ label: '查看令牌位置说明', href: '#/link' }, { label: '重新输入令牌', href: '#/link' }],
    },
    READONLY: {
      title: '只读模式', severity: 'info',
      phenomenon: '写操作按钮点击无效 / 提示只读（HTTP 423）。',
      cause: '当前是第二个实例的只读模式，或启动参数包含 --read-only。',
      steps: [{ label: '了解只读模式', href: '#/devices' }, { label: '使用主实例操作', href: '#' }],
    },
    UNKNOWN: {
      title: '未知错误', severity: 'bad',
      phenomenon: '操作失败但错误信息不明确。',
      cause: '服务端返回了未归类的错误，或网络层异常。',
      steps: [{ label: '复制诊断发给支持', action: 'copy-diag' }, { label: '刷新重试', href: '#' }],
    },
  };
  var ORDER = ['PORT_IN_USE', 'FIREWALL', 'CODE_EXPIRED', 'VERSION_MISMATCH', 'DISK_FULL', 'PERMISSION_DENIED', 'TIMEOUT', 'CHECKSUM_FAILED', 'DEVICE_OFFLINE', 'TOKEN_INVALID', 'READONLY', 'UNKNOWN'];
  var events = [];
  var ctx = { version: '', port: '', hub: '', startedAt: new Date().toISOString() };

  function loadEvents() {
    try {
      var raw = localStorage.getItem(EVENTS_KEY);
      if (raw) events = JSON.parse(raw) || [];
    } catch (_) { events = []; }
    if (!Array.isArray(events)) events = [];
    return events;
  }
  function saveEvents() {
    try { localStorage.setItem(EVENTS_KEY, JSON.stringify(events.slice(-20))); } catch (_) {}
  }
  loadEvents();

  function recordEvent(type, at, detail) {
    events.push({ at: at || new Date().toISOString(), type: String(type || 'event'), detail: String(detail || '').slice(0, 160) });
    events = events.slice(-20);
    saveEvents();
    return events;
  }
  function recentEvents(n) {
    var list = events.slice(-(n || 5)).reverse();
    if (!list.length) return ['（暂无事件）'];
    return list.map(function (e) { return (e.at || '') + ' ' + e.type + (e.detail ? ' · ' + e.detail : ''); });
  }
  function setContext(partial) { ctx = Object.assign(ctx, partial || {}); }
  function initContext() {
    try {
      if (!ctx.port) ctx.port = location.port || (location.protocol === 'https:' ? '443' : '80');
      if (!ctx.hub) ctx.hub = location.host || '本机';
    } catch (_) {}
    try {
      if (!ctx.version && window.TENON_VERSION) ctx.version = window.TENON_VERSION;
    } catch (_) {}
    try {
      if (!ctx.version && typeof fetch === 'function') {
        fetch('/api/v2/health', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
          if (d && (d.version || d.commit)) ctx.version = d.version || d.commit;
        }).catch(function () {});
      }
    } catch (_) {}
  }
  function diagnoseText(code, opts) {
    var c = CODES[code] || CODES.UNKNOWN;
    var lines = [];
    lines.push('[榫卯诊断] ' + code + ' · ' + c.title);
    if (opts && opts.detail) lines.push('详情：' + String(opts.detail).slice(0, 300));
    lines.push('版本：' + (ctx.version || '未知（未连接中枢）'));
    lines.push('端口：' + (ctx.port || '未知') + ' · 中枢：' + (ctx.hub || '未知'));
    lines.push('时间：' + new Date().toISOString());
    lines.push('页面：' + (typeof location !== 'undefined' ? location.href : ''));
    lines.push('最近 5 条事件：');
    recentEvents(5).forEach(function (line) { lines.push('  - ' + line); });
    return lines.join('\n');
  }
  function escHtml(v) {
    return String(v === undefined || v === null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function stepsHtml(c) {
    var parts = [];
    (c.steps || []).forEach(function (s) {
      if (s.href) parts.push('<a class="btn btn-sm" href="' + escHtml(s.href) + '" data-testid="error-next">' + escHtml(s.label) + '</a>');
      else parts.push('<button class="btn btn-sm" data-err-action="' + escHtml(s.action || 'retry') + '" data-testid="error-next">' + escHtml(s.label) + '</button>');
    });
    return parts.join(' ');
  }
  function render(code, opts) {
    var key = String(code || 'UNKNOWN');
    var c = CODES[key] || CODES.UNKNOWN;
    var diag = diagnoseText(key, opts);
    var detail = (opts && opts.detail) ? '<div class="tiny dim" data-testid="error-detail">详情：' + escHtml(opts.detail) + '</div>' : '';
    return '<div class="tenon-error-card alert alert-' + (c.severity === 'bad' ? 'bad' : c.severity === 'info' ? 'info' : 'warn') + '" data-testid="tenon-error-card" data-error-code="' + escHtml(key) + '">' +
      '<div class="tenon-error-head"><span class="tag" data-testid="error-code">' + escHtml(key) + '</span><strong data-testid="error-title">' + escHtml(c.title) + '</strong><span class="tiny dim">' + escHtml(c.severity) + '</span></div>' +
      detail +
      '<div class="tenon-error-body">' +
      '<div><b>现象</b>：<span data-testid="error-phenomenon">' + escHtml(c.phenomenon) + '</span></div>' +
      '<div><b>原因</b>：<span data-testid="error-cause">' + escHtml(c.cause) + '</span></div>' +
      '<div class="tenon-error-next"><b>下一步</b>：' + stepsHtml(c) + '</div>' +
      '<div class="tenon-error-actions"><button class="btn btn-sm" data-err-action="copy-diag" data-testid="btn-copy-diagnose">复制诊断</button>' +
      '<button class="btn btn-sm" data-err-action="dismiss">关闭</button></div>' +
      '<details class="tenon-error-details"><summary>复制诊断内容（版本 / 端口 / 时间 / 最近 5 条事件）</summary><pre data-testid="error-diagnose">' + escHtml(diag) + '</pre></details>' +
      '</div></div>';
  }
  function fromHttp(status, message, network) {
    var msg = String(message || '');
    if (network) return 'TIMEOUT';
    if (status === 401) return 'TOKEN_INVALID';
    if (status === 403) return 'PERMISSION_DENIED';
    if (status === 423) return 'READONLY';
    if (/EADDRINUSE|端口.*占用|地址已被占用/i.test(msg)) return 'PORT_IN_USE';
    if (/防火墙|firewall/i.test(msg)) return 'FIREWALL';
    if (/过期|expired/i.test(msg)) return 'CODE_EXPIRED';
    if (/版本|version/i.test(msg)) return 'VERSION_MISMATCH';
    if (/磁盘|空间不足|disk/i.test(msg)) return 'DISK_FULL';
    if (/超时|timeout/i.test(msg)) return 'TIMEOUT';
    if (/校验|checksum|sha-?256/i.test(msg)) return 'CHECKSUM_FAILED';
    if (/离线|offline/i.test(msg)) return 'DEVICE_OFFLINE';
    if (/令牌|token/i.test(msg)) return 'TOKEN_INVALID';
    if (/只读|readonly|read-only/i.test(msg)) return 'READONLY';
    return 'UNKNOWN';
  }
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return '已复制诊断信息，可直接粘贴给支持同学';
      }
    } catch (_) {}
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
      return '已复制诊断信息，可直接粘贴给支持同学';
    } catch (_) { return '复制失败，请展开下方诊断内容手动复制'; }
  }
  function toast(msg, kind) {
    if (typeof window.tenonToast === 'function') { window.tenonToast(msg, kind || 'ok'); return; }
    var el = document.createElement('div');
    el.className = 'tenon-errors-toast toast ' + (kind === 'bad' ? 'toast-bad' : 'toast-ok');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:9999;padding:10px 16px;border-radius:10px;background:#0d1a28;color:#e9f1fa;border:1px solid #66e3d2;font-size:13px';
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
  }
  function handleClick(ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-err-action]') : null;
    if (!btn) return;
    var action = btn.getAttribute('data-err-action');
    var card = btn.closest ? btn.closest('[data-testid="tenon-error-card"]') : null;
    var code = card ? card.getAttribute('data-error-code') : 'UNKNOWN';
    var detail = card ? (card.querySelector('[data-testid="error-detail"]') || {}).textContent || '' : '';
    if (action === 'copy-diag') {
      toast(copyText(diagnoseText(code, { detail: detail })), 'ok');
    } else if (action === 'dismiss') {
      if (card && card.parentNode) card.parentNode.removeChild(card);
    } else if (action === 'retry') {
      recordEvent('error.retry', null, code);
      if (typeof window.tenonRetry === 'function') window.tenonRetry(code);
      else location.reload();
    }
  }
  window.TenonErrors = {
    CODES: CODES, ORDER: ORDER, render: render, fromHttp: fromHttp, diagnoseText: diagnoseText,
    recordEvent: recordEvent, recentEvents: recentEvents, setContext: setContext, initContext: initContext,
    copyDiagnose: function (code, opts) { return copyText(diagnoseText(code || 'UNKNOWN', opts || {})); },
    toast: toast,
  };
  initContext();
  document.addEventListener('click', handleClick);
  document.addEventListener('DOMContentLoaded', initContext);
})();