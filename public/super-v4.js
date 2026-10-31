/* 榫卯 V5 · 超级终端单页应用（首页看板 / 记录 / 提醒 / 文档 / 设置 + IoT 接入）
 * 兼容 Electron（window.tenonDesktop 可选）；所有请求同源相对路径，无外部依赖、无 CDN。
 * 后端契约（V5，实际以 server/lib/{notes,reminders,documents,iot} 为准）：
 *   笔记  GET/POST /api/v2/notes、GET/PATCH/DELETE /api/v2/notes/:id、GET /notes/search?q=
 *   提醒  GET/POST /api/v2/reminders、POST /:id/done、DELETE /:id、GET /reminders/pending
 *   文档  GET /api/v2/documents、POST /documents/generate {kind,date}、GET /:id[/download?format=md|docx|pdf]、DELETE /:id
 *   物联  /api/v2/iot/{status,config,test,discover,ha/entities,import,devices/:id/control}
 * 后端未挂载时各模块自动降级为「示例数据」并在界面明确标注，接口就绪后自动切换真实数据。 */
(function () {
  'use strict';
  var TOKEN_KEY = 'tenon:token';
  var AGENT_KEY = 'tenon:agent';
  var S = {
    token: '',
    status: null,
    tab: 'home',
    agent: 'builtin',
    openclaw: null,
    notes: [], notesDate: '', notesQuery: '', noteDetail: null, noteSummary: null,
    reminders: [], remindersLoading: false,
    docs: [], docPreview: null,
    board: { next: null, notesCount: 0, screenCount: 0, dailyDoc: null, diary: null },
    iot: { status: null, config: null, devices: [], entities: [], discovered: [], mqttDiscovered: [] },
    mock: { notes: false, reminders: false, documents: false, iot: false },
    lastFinal: '', lastPartialAt: 0,
    es: null, aux: [], toastSeq: 0,
    composeMode: '',
    evSeen: {},
    inited: false
  };

  /* ---------------- 基础工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function tok() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) {} S.token = t || ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function pad2(n) { return ('0' + n).slice(-2); }
  function dayKey(d) { d = d ? new Date(d) : new Date(); if (isNaN(d.getTime())) d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayKey() { return dayKey(); }
  function fmtTime(ts) {
    if (!ts && ts !== 0) return '';
    var d = new Date(typeof ts === 'number' ? ts : Date.parse(ts));
    if (isNaN(d.getTime())) return '';
    return ('00' + d.getHours()).slice(-2) + ':' + ('00' + d.getMinutes()).slice(-2);
  }
  function fmtDateTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return dayKey(d) + ' ' + fmtTime(d.getTime());
  }
  function relTime(ts) {
    var t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return '';
    var diff = t - Date.now();
    var abs = Math.abs(diff);
    if (abs < 60000) return diff >= 0 ? '不到 1 分钟' : '刚刚';
    if (abs < 3600000) return (diff >= 0 ? '' : '逾期 ') + Math.round(abs / 60000) + ' 分钟' + (diff >= 0 ? '后' : '');
    if (abs < 86400000) return (diff >= 0 ? '' : '逾期 ') + Math.round(abs / 3600000) + ' 小时' + (diff >= 0 ? '后' : '');
    return (diff >= 0 ? '' : '逾期 ') + Math.round(abs / 86400000) + ' 天' + (diff >= 0 ? '后' : '');
  }
  function agoText(ts) {
    var t = new Date(ts).getTime(); if (!Number.isFinite(t)) return '';
    var diff = Date.now() - t;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.round(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.round(diff / 3600000) + ' 小时前';
    return Math.round(diff / 86400000) + ' 天前';
  }
  function debounce(fn, ms) { var t = null; return function () { var args = arguments; clearTimeout(t); t = setTimeout(function () { fn.apply(null, args); }, ms); }; }
  function toast(msg, kind, ms) {
    var root = $('toast-root'); if (!root) return;
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.setAttribute('data-testid', 'toast');
    el.textContent = String(msg == null ? '' : msg);
    root.appendChild(el);
    var id = ++S.toastSeq;
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () { el.classList.remove('show'); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260); }, ms || 3600);
    return id;
  }
  function setMsg(t) { var m = $('settings-msg'); if (m) m.textContent = t || ''; }
  function showMockBadge(id, on) { var el = $(id); if (el) el.classList.toggle('hidden', !on); }
  /* 简易确认弹窗（替代 window.confirm，Chrome/Electron 行为一致） */
  var modalResolve = null;
  function uiConfirm(title, body) {
    return new Promise(function (resolve) {
      var root = $('modal-root'); if (!root) { resolve(true); return; }
      $('modal-title').textContent = title || '确认';
      $('modal-body').textContent = body || '';
      root.classList.remove('hidden');
      modalResolve = resolve;
    });
  }
  function bindModalOnce() {
    var ok = $('modal-ok'), cancel = $('modal-cancel');
    function close(v) { var root = $('modal-root'); if (root) root.classList.add('hidden'); if (modalResolve) { var r = modalResolve; modalResolve = null; r(v); } }
    if (ok) ok.onclick = function () { close(true); };
    if (cancel) cancel.onclick = function () { close(false); };
    var mask = document.querySelector('.modal-mask');
    if (mask) mask.onclick = function () { close(false); };
  }

  /* ---------------- API（统一鉴权 + 404 可识别） ---------------- */
  async function api(method, path, body, timeoutMs) {
    var headers = {};
    if (S.token) headers['x-tenon-token'] = S.token;
    var opts = { method: method, headers: headers, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined && body !== null) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) { opts.signal = ctrl.signal; setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, timeoutMs || 120000); }
    var r;
    try { r = await fetch(path, opts); }
    catch (e) { return { status: 0, ok: false, data: null, network: true, error: e }; }
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (r.status === 401 || r.status === 423) {
      S.token = '';
      showTokenHint();
      return { status: r.status, ok: false, data: data, needAuth: true };
    }
    return { status: r.status, ok: r.ok, data: data };
  }
  /* 软请求：网络/404 不抛错，便于「后端未就绪 → 示例数据」降级 */
  async function softApi(method, path, body) {
    try { return await api(method, path, body); } catch (e) { return { status: 0, ok: false, data: null, network: true, error: e }; }
  }
  function isMissing(r) { return !r || r.status === 0 || r.status === 404; }
  function showTokenHint() { setMsg('需要操作令牌：请在「设置」里粘贴中枢操作令牌（data/secrets.json 里的 operatorToken）'); switchTab('settings'); toast('需要操作令牌，已跳转设置', 'warn'); }

  /* ---------------- 示例数据（后端未就绪时降级展示，明确标注） ---------------- */
  var MOCK = {
    notes: [], reminders: [], docs: [], iotDevices: [], iotEntities: [], ssdp: [],
    build: function () {
      var now = Date.now();
      MOCK.notes = [
        { id: 'mock_note_1', title: '今天要做的事', text: '1. 整理项目周报\n2. 和客户确认报价单\n3. 晚上梳理 V5 验收清单', excerpt: '1. 整理项目周报 2. 和客户确认报价单…', source: 'voice', date: todayKey(), time: '09:12', createdAt: new Date(now - 3600e3).toISOString(), updatedAt: new Date(now - 3600e3).toISOString(), tags: ['待办'] },
        { id: 'mock_note_2', title: '会议要点', text: '下午评审：看板需要突出「下一个提醒」；文档中心要能直接发微信；提醒支持每天重复。', excerpt: '下午评审：看板需要突出「下一个提醒」…', source: 'text', date: todayKey(), time: '14:30', createdAt: new Date(now - 1800e3).toISOString(), updatedAt: new Date(now - 1800e3).toISOString(), tags: ['会议'] },
        { id: 'mock_note_3', title: '随手记', text: '家里的灯接入 Home Assistant 后，说「打开客厅灯」就能控制。', excerpt: '家里的灯接入 Home Assistant 后…', source: 'voice', date: todayKey(), time: '17:05', createdAt: new Date(now - 600e3).toISOString(), updatedAt: new Date(now - 600e3).toISOString(), tags: ['物联'] }
      ];
      MOCK.reminders = [
        { id: 'mock_rmd_1', text: '喝水', at: new Date(now + 20 * 60e3).toISOString(), recurrence: 'once', done: false, source: 'voice', createdAt: new Date(now - 300e3).toISOString() },
        { id: 'mock_rmd_2', text: '每天晚上整理明天计划', at: new Date(now + 5 * 3600e3).toISOString(), recurrence: 'daily', done: false, source: 'text', createdAt: new Date(now - 10 * 600e3).toISOString() },
        { id: 'mock_rmd_3', text: '给客户回电话', at: new Date(now - 25 * 60e3).toISOString(), recurrence: 'once', done: true, source: 'voice', createdAt: new Date(now - 3600e3).toISOString(), doneAt: new Date(now - 20 * 60e3).toISOString() }
      ];
      MOCK.docs = [
        { id: 'mock_doc_today', title: '每日总结 · ' + todayKey(), date: todayKey(), kind: 'daily', kindLabel: '每日总结', provider: 'deepseek', degraded: false, summary: '今天主要在做 V5 多页签 UI 与笔记/提醒/文档联调；语音记录了 3 条要点，屏幕采集到工作台活跃。', structured: { 摘要: '今天主要在做 V5 多页签 UI 与笔记/提醒/文档联调；语音记录了 3 条要点。', 重点: ['完成 5 页签 UI 骨架', '接入笔记/提醒/文档真实接口', 'IoT 设置支持 HA / MQTT / SSDP'], 待办: ['跑真实 Chrome 桌面+手机截图', '补齐 IoT 控制按钮联调'], 回顾: ['语音记笔记比手动快很多', '看板让今天安排一眼可见'], 日记: '今天推进了 V5 的核心体验：说出来就能记下来，到点会提醒，总结能导出文档。' }, chars: 720, files: { md: { size: 1200 }, docx: { size: 8600 }, pdf: { size: 6400 } }, createdAt: new Date(now - 1200e3).toISOString(), updatedAt: new Date(now - 1200e3).toISOString() },
        { id: 'mock_doc_note', title: '笔记总结 · ' + todayKey(), date: todayKey(), kind: 'note-summary', kindLabel: '笔记总结', provider: 'template', degraded: true, summary: '整理了 3 条笔记：待办、会议要点与物联尝试。', structured: { 摘要: '整理了 3 条笔记：待办、会议要点与物联尝试。', 重点: ['待办 3 项', '会议 3 个决定', '物联接入思路'], 待办: ['整理项目周报', '确认报价单'], 回顾: ['笔记来源含语音 2 条、文字 1 条'], 日记: '记录开始变得有结构。' }, chars: 480, files: { md: { size: 800 }, docx: { size: 6100 }, pdf: { size: 4800 } }, createdAt: new Date(now - 2400e3).toISOString(), updatedAt: new Date(now - 2400e3).toISOString() }
      ];
      MOCK.iotDevices = [
        { id: 'iot:mock:light', name: '客厅灯', domain: 'light', type: 'light', state: 'on', source: 'ha', capabilities: ['turn_on', 'turn_off', 'brightness'] },
        { id: 'iot:mock:switch', name: '卧室插座', domain: 'switch', type: 'switch', state: 'off', source: 'mqtt', capabilities: ['turn_on', 'turn_off'] },
        { id: 'iot:mock:tv', name: '客厅电视', domain: 'media_player', type: 'media_player', state: 'idle', source: 'ha', capabilities: ['media_play', 'media_pause'] }
      ];
      MOCK.iotEntities = [
        { id: 'ha:light.living_room', name: '客厅灯', domain: 'light', state: 'on', attributes: { brightness: 200 } },
        { id: 'ha:switch.kettle', name: '热水壶插座', domain: 'switch', state: 'off' },
        { id: 'ha:sensor.temperature', name: '客厅温度', domain: 'sensor', state: '24.5' },
        { id: 'ha:media_player.tv', name: '客厅电视', domain: 'media_player', state: 'off' }
      ];
      MOCK.ssdp = [
        { name: '客厅电视 (Android TV)', type: 'MediaRenderer', location: 'http://192.168.3.21:9197/dmr', usn: 'uuid:mock-tv::urn:schemas-upnp-org:device:MediaRenderer:1', server: 'Linux/4.x UPnP/1.0' },
        { name: '无线打印机', type: 'Printer', location: 'http://192.168.3.31:631/upnp', usn: 'uuid:mock-printer', server: 'HP UPnP' }
      ];
    }
  };

  /* ---------------- 页面切换（首页 / 唤醒 / 24h 记录 / 记录 / 提醒 / 文档 / 设置 + 旧页） ---------------- */
  var TAB_PAGES = { home: 'page-home', wake: 'page-wake', ambient: 'page-ambient', records: 'page-records', reminders: 'page-reminders', documents: 'page-documents', settings: 'page-settings', devices: 'page-devices', today: 'page-today' };
  /* 唤醒 / 24h 记录是首页下的子页面：底栏高亮「首页」，返回按钮切回 home */
  var SUB_PAGES = { wake: 'home', ambient: 'home' };
  function switchTab(name) {
    if (!TAB_PAGES[name]) name = 'home';
    S.tab = name;
    var activeTab = SUB_PAGES[name] || name;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.toggle('active', b.getAttribute('data-tab') === activeTab); });
    Array.prototype.forEach.call(document.querySelectorAll('.page'), function (p) { p.classList.toggle('active', p.id === TAB_PAGES[name]); });
    if (name === 'records') loadNotes();
    else if (name === 'wake') refreshStatus();
    else if (name === 'ambient') { loadAmbientRecords(); refreshStatus(); loadScreenRecords(); loadTodaySummary(); }
    else if (name === 'reminders') loadReminders();
    else if (name === 'documents') loadDocuments();
    else if (name === 'settings') fillSettings();
    else if (name === 'devices') loadDevices();
    else if (name === 'today') loadToday();
    else if (name === 'home') loadBoard();
  }

  /* ---------------- 字幕（单行：partial 灰 / final 亮，同句只留一条） ---------------- */
  function setCaption(finalText, partialText) {
    var f = $('sub-final'), p = $('sub-partial');
    if (!f || !p) return;
    if (partialText !== undefined && partialText !== null) {
      p.textContent = partialText; p.style.display = partialText ? 'inline' : 'none';
    }
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
      if (!r.ok) throw new Error('status');
      S.status = r.data || {};
      var st = S.status;
      setVoiceChip(st.enabled, st.state);
      var od = $('online-dot'); if (od) od.classList.add('on');
      if (st.workers && st.workers.asr && st.workers.asr.state === 'running') { var cv = $('chip-voice'); if (cv) cv.classList.add('on'); }
      var lt = st.lastTranscript;
      /* 24h 全天记录只出现在 ambient 页：不进入唤醒页字幕 / 最近说过 */
      if (lt && lt.text && lt.at && lt.source !== 'ambient') {
        var key = lt.text + '|' + lt.at;
        if (key !== S._lastTranscriptKey) { S._lastTranscriptKey = key; setCaption(lt.text); }
      }
      if (st.lastReply && st.lastReply.at && st.lastReply.at !== S._lastReplyAt) {
        S._lastReplyAt = st.lastReply.at;
        renderResult({ say: st.lastReply.text, provider: st.lastReply.provider, latencyMs: st.lastReply.latencyMs, needConfirm: st.lastReply.needConfirm, confirmId: st.lastReply.confirmId, actions: st.lastCommand && st.lastCommand.actions });
        /* 修复：回复不再覆盖识别框（识别框只显示“听到的话”） */
      }
      var amb = st.ambient || {};
      var ca = $('chip-ambient');
      if (ca) { ca.textContent = amb.enabled === false ? '24h记录 关' : '24h记录 开'; ca.classList.toggle('off', amb.enabled === false); }
      renderWakeListen(st);
      renderAmbientToggle();
      var wp = $('wake-provider-chip');
      if (wp) wp.textContent = '识别：' + ((st.providers && st.providers.asr) || (st.workers && st.workers.asr && st.workers.asr.provider) || '本机');
      var sc = $('chip-screen');
      if (sc) sc.textContent = (window.tenonDesktop && window.tenonDesktop.screenCapture === false) ? '屏幕采集暂停' : '屏幕采集';
      var ag = $('chip-agent'); if (ag) ag.textContent = S.agent === 'openclaw' ? 'OpenClaw 小龙虾' : '自研执行器';
    } catch (e) { var od2 = $('online-dot'); if (od2) od2.classList.remove('on'); }
  }

  /* ---------------- SSE（语音/提醒/文档，统一去重） ---------------- */
  function seen(key) {
    if (!key) return false;
    if (S.evSeen[key]) return true;
    S.evSeen[key] = Date.now();
    var keys = Object.keys(S.evSeen);
    if (keys.length > 300) keys.slice(0, 100).forEach(function (k) { delete S.evSeen[k]; });
    return false;
  }
  /* P0 鉴权修复：EventSource 不能自定义请求头，服务端 GET /api/v2/** 现在也要求令牌，
     所以 SSE URL 统一用 ?token= 带上（同源、仅用于本机/局域网；每次重连都重新读 localStorage，
     令牌保存后无需刷新页面即可恢复）。 */
  function sseUrl(path) {
    var t = tok();
    if (!t) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(t);
  }
  function connectSSE() {
    if (typeof EventSource === 'undefined') return;
    try {
      if (S.es) { try { S.es.close(); } catch (e) {} }
      S.es = new EventSource(sseUrl('/api/v2/voice/stream'));
      S.es.onmessage = function (ev) {
        var m = null; try { m = JSON.parse(ev.data || '{}'); } catch (e) { return; }
        if (!m || !m.type) return;
        if (m.type === 'transcript' && m.text) {
          if (m.source === 'ambient') {
            /* 24h 全天记录只进 ambient 页列表，不进唤醒页字幕 / 最近说过 */
            loadAmbientRecords();
          } else {
            setCaption(m.text);
            if (m.source === 'mic') setRecUI(false, '', '');
            addTalk(m.text, { kind: m.source === 'mic' ? '语音' : '输入', at: m.at });
          }
          if (S.rec.active && m.source === 'mic') { S.rec.active = false; recPollStop(); setRecUI(false, '', ''); }
          scheduleRefreshAfterVoice();
        }
        else if (m.type === 'partial' && m.text) { if (m.source !== 'ambient') setCaption(undefined, m.text); if (S.rec.active) setRecUI(true, '正在录音…请说话', titleLive(m.text)); }
        else if (m.type === 'wake') { setCaption('「' + (m.word || '榫卯') + '」我在，请说'); if (S.rec.active) setRecUI(true, '已唤醒，请说…', ''); }
        else if (m.type === 'reply' && m.text) { addTalk(m.text, { kind: '执行', at: m.at }); if (S.rec.active) setRecUI(true, '已执行：' + String(m.text).slice(0, 40), ''); }
        else if (m.type === 'reply' && m.text) { renderResult(m); setCaption(m.text); scheduleRefreshAfterVoice(); }
        else if (m.type === 'status' || m.type === 'status_snapshot') refreshStatus();
        else if (m.type === 'error' && m.text) { renderResult({ say: m.text, error: true }); }
        else if (m.type === 'reminder') onReminderEvent(m);
        else if (m.type === 'reminder_created' || m.type === 'reminder_done' || m.type === 'reminder_deleted' || m.type === 'reminder_tts') onReminderChanged(m);
        else if (m.type === 'note_created' || m.type === 'note.created' || m.type === 'note_updated') onNoteChanged(m);
        else if (m.type === 'document' || m.type === 'document_created' || m.type === 'document_deleted') onDocumentChanged(m);
      };
      S.es.onerror = function () { try { S.es.close(); } catch (e) {} S.es = null; setTimeout(connectSSE, 4000); };
    } catch (e) { setTimeout(connectSSE, 5000); }
    connectAuxSse('/api/v2/reminders/stream', function (m) {
      if (m.type === 'reminder') onReminderEvent(m);
      else if (/^reminder_/.test(m.type || '')) onReminderChanged(m);
    });
    connectAuxSse('/api/v2/documents/stream', function (m) {
      if (m.type === 'document') onDocumentChanged(m);
      else if (m.type === 'document_deleted') onDocumentChanged(m);
    });
  }
  function connectAuxSse(path, handler) {
    try {
      var es = new EventSource(sseUrl(path));
      S.aux.push(es);
      es.onmessage = function (ev) {
        var m = null; try { m = JSON.parse(ev.data || '{}'); } catch (e) { return; }
        if (m && m.type && m.type !== 'hello') { try { handler(m); } catch (e) {} }
      };
      es.onerror = function () { try { es.close(); } catch (e) {} };
    } catch (e) { /* 后端未就绪：忽略 */ }
  }
  function onReminderEvent(m) {
    if (seen('rmd-fire:' + (m.id || '') + ':' + (m.ts || m.firedAt || ''))) return;
    toast('⏰ 提醒：' + (m.text || '到点了'), 'warn', 8000);
    setCaption('⏰ ' + (m.text || '到点了'));
    loadReminders(); loadBoard();
  }
  function onReminderChanged(m) {
    if (m.type === 'reminder_tts') return;
    if (seen(m.type + ':' + (m.id || '') + ':' + (m.ts || m.at || ''))) return;
    if (m.type === 'reminder_created' && m.item) toast('已创建提醒：' + (m.item.text || ''), 'ok');
    loadReminders(); loadBoard();
  }
  function onNoteChanged(m) {
    if (seen('note:' + (m.id || m.noteId || '') + ':' + (m.ts || m.at || ''))) return;
    if (S.tab === 'records') loadNotes(); loadBoard();
  }
  function onDocumentChanged(m) {
    var key = 'doc:' + (m.id || '') + ':' + (m.ts || m.createdAt || '');
    if (seen(key)) return;
    if (m.type === 'document_deleted') { loadDocuments(); loadBoard(); return; }
    toast('📄 ' + (m.title || '总结文档') + ' 已生成' + (m.degraded ? '（模板降级）' : ''), 'ok', 5000);
    loadDocuments(); loadBoard();
  }
  var refreshTimer = null;
  function scheduleRefreshAfterVoice() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () { loadBoard(); if (S.tab === 'records') loadNotes(); if (S.tab === 'reminders') loadReminders(); if (S.tab === 'documents') loadDocuments(); }, 1200);
  }

  /* ---------------- 结果卡 ---------------- */
  function renderResult(j) {
    if (!j) return;
    var card = $('result'); if (!card) return;
    card.classList.remove('hidden');
    var pv = $('result-provider'); if (pv) pv.textContent = (j.provider || 'local') + (j.latencyMs ? ' · ' + (j.latencyMs / 1000).toFixed(1) + 's' : '');
    var rt = $('result-time'); if (rt) rt.textContent = fmtTime(Date.now());
    var say = $('result-say'); if (say) say.textContent = j.say || j.text || (j.error ? '出错了' : '');
    var steps = j.steps || j.actions || [];
    var sd = $('result-steps');
    if (sd) sd.innerHTML = (steps || []).slice(0, 8).map(function (s) {
      var st = s.status || (s.ok === false ? 'failed' : 'succeeded');
      var cls = /fail|error/.test(st) ? 'fail' : (/ok|success|dispatch|succeed/.test(st) ? 'ok' : '');
      return '<span class="st ' + cls + '">' + esc(s.label || s.action || s) + '</span>';
    }).join('');
    var acts = $('result-actions');
    if (acts) {
      acts.innerHTML = '';
      if (j.needConfirm) {
        var b = document.createElement('button'); b.className = 'primary'; b.textContent = '确认执行';
        b.onclick = function () { confirmRun(j); }; acts.appendChild(b);
      }
    }
  }
  async function confirmRun(j) {
    var r = await api('POST', '/api/v2/voice/confirm', { confirmId: j.confirmId || j.confirm_id || null, yes: true });
    renderResult({ say: (r.data && (r.data.message || r.data.say)) || '已确认', provider: 'deepseek' });
  }

  /* ---------------- 首页看板 ---------------- */
  async function loadBoard() {
    var date = todayKey();
    var bd = $('board-date'); if (bd) bd.textContent = date;
    /* 笔记数（今日） */
    var notesCount = 0, mockNotes = false;
    var nr = await softApi('GET', '/api/v2/notes?date=' + encodeURIComponent(date) + '&limit=200');
    if (isMissing(nr)) { mockNotes = true; notesCount = MOCK.notes.length; S.mock.notes = true; }
    else { S.mock.notes = false; var nd = nr.data || {}; notesCount = Number(nd.total != null ? nd.total : (nd.items || []).length) || 0; }
    /* 屏幕采集数（今日，已有真实接口） */
    var screenCount = 0;
    var sr = await softApi('GET', '/api/v2/voice/screen?date=' + encodeURIComponent(date) + '&limit=500');
    if (!isMissing(sr)) { var sd = sr.data || {}; screenCount = Number(sd.total != null ? sd.total : (sd.items || []).length) || 0; }
    /* 下一个提醒 + 文档状态 */
    var reminders = [], docs = [];
    var rr = await softApi('GET', '/api/v2/reminders');
    if (isMissing(rr)) { S.mock.reminders = true; reminders = MOCK.reminders; } else { S.mock.reminders = false; reminders = (rr.data && (rr.data.items || rr.data.reminders)) || []; }
    var dr = await softApi('GET', '/api/v2/documents?limit=100');
    if (isMissing(dr)) { S.mock.documents = true; docs = MOCK.docs; } else { S.mock.documents = false; docs = (dr.data && (dr.data.items || dr.data.documents)) || []; }
    var pending = reminders.filter(function (x) { return !x.done; }).sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    var next = pending[0] || null;
    var dailyDoc = null;
    for (var i = 0; i < docs.length; i++) { var d = docs[i]; if (d && (d.kind === 'daily' || d.kind === 'diary') && String(d.date || '').slice(0, 10) === date) { dailyDoc = d; break; } }
    S.board = { next: next, notesCount: notesCount, screenCount: screenCount, dailyDoc: dailyDoc, diary: null, mock: mockNotes || S.mock.reminders || S.mock.documents };
    S.docs = docs; S.reminders = reminders;
    renderBoard();
  }
  function renderBoard() {
    var b = S.board || {};
    var date = todayKey();
    var bd = $('board-date'); if (bd) bd.textContent = date;
    var rt = $('board-reminder-text'), ra = $('board-reminder-at');
    if (b.next) {
      if (rt) rt.textContent = b.next.text || '提醒';
      if (ra) ra.textContent = fmtDateTime(b.next.at) + ' · ' + relTime(b.next.at) + (b.next.recurrence === 'daily' ? ' · 每天' : '');
    } else {
      if (rt) rt.textContent = '暂无提醒';
      if (ra) ra.textContent = '点这里新建（说「提醒我…」也可以）';
    }
    var nn = $('board-notes-num'); if (nn) nn.textContent = (b.notesCount || 0) + ' 条';
    var ns = $('board-notes-sub'); if (ns) ns.textContent = b.notesCount ? '说「记一下…」自动记录' : '说「记一下…」或点记录页新建';
    var sn = $('board-screen-num'); if (sn) sn.textContent = (b.screenCount || 0) + ' 条';
    var st = $('board-summary-text');
    var gen = $('board-summary-gen');
    var dls = $('board-summary-downloads');
    if (b.dailyDoc) {
      if (st) st.textContent = '已生成 · ' + ((b.dailyDoc.provider || '') === 'template' ? '模板降级' : 'DeepSeek');
      if (gen) { gen.classList.add('hidden'); }
      if (dls) dls.classList.remove('hidden');
    } else {
      if (st) st.textContent = '未生成';
      if (gen) gen.classList.remove('hidden');
      if (dls) dls.classList.add('hidden');
    }
    showMockBadge('board-mock', !!(b.mock && (S.mock.notes || S.mock.reminders || S.mock.documents)));
  }

  /* ---------------- 记录页（笔记 + AI 总结） ---------------- */
  async function loadNotes() {
    var q = ($('records-search') && $('records-search').value || '').trim();
    var date = $('records-date') ? $('records-date').value : '';
    S.notesDate = date; S.notesQuery = q;
    var path = '/api/v2/notes?limit=100';
    if (date) path += '&date=' + encodeURIComponent(date);
    if (q) path += '&q=' + encodeURIComponent(q);
    var r = await softApi('GET', path);
    var items = [];
    if (isMissing(r)) {
      S.mock.notes = true;
      items = MOCK.notes.filter(function (n) {
        if (date && n.date !== date) return false;
        if (q && (String(n.title || '') + String(n.text || '')).toLowerCase().indexOf(q.toLowerCase()) < 0) return false;
        return true;
      });
      showMockBadge('records-mock', true);
    } else {
      S.mock.notes = false;
      showMockBadge('records-mock', false);
      var d = r.data || {};
      items = d.items || d.notes || [];
    }
    S.notes = items;
    var count = $('records-count'); if (count) count.textContent = String(items.length);
    var box = $('note-list');
    if (!box) return;
    if (!items.length) { box.innerHTML = '<div class="muted empty">' + (q || date ? '没有匹配的笔记' : '今天还没有笔记：说「记一下…」，或在下面输入要点后保存。') + '</div>'; return; }
    box.innerHTML = items.map(function (n) {
      var source = n.source === 'voice' ? '语音' : '文字';
      return '<button class="note-item" data-id="' + esc(n.id) + '" data-testid="note-item">' +
        '<span class="note-time">' + esc(fmtTime(n.createdAt) || n.time || '') + '</span>' +
        '<span class="note-main"><b>' + esc(n.title || '未命名笔记') + '</b>' +
        '<span class="note-excerpt">' + esc(n.excerpt || String(n.text || '').slice(0, 120)) + '</span></span>' +
        '<span class="badge ' + (n.source === 'voice' ? 'voice' : '') + '">' + source + '</span>' +
        '<span class="note-date muted">' + esc(n.date || '') + '</span>' +
        '</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.note-item'), function (btn) {
      btn.onclick = function () { selectNote(btn.getAttribute('data-id')); };
    });
  }
  function selectNote(id) {
    var n = null;
    for (var i = 0; i < S.notes.length; i++) if (String(S.notes[i].id) === String(id)) n = S.notes[i];
    if (!n) return;
    S.noteDetail = n;
    var box = $('note-detail'); if (!box) return;
    box.innerHTML =
      '<div class="detail-head"><div><h3>' + esc(n.title || '未命名笔记') + '</h3>' +
      '<div class="muted">' + esc(fmtDateTime(n.createdAt) || n.date + ' ' + (n.time || '')) + ' · ' + (n.source === 'voice' ? '语音记录' : '文字记录') + (n.tags && n.tags.length ? ' · ' + esc(n.tags.join(' / ')) : '') + '</div></div>' +
      '<div class="head-actions"><button class="ghost danger" data-del="' + esc(n.id) + '" data-testid="note-delete">删除</button></div></div>' +
      '<pre class="note-full">' + esc(n.text || '') + '</pre>' +
      '<div class="row btns"><button class="mini" id="note-detail-summarize" data-testid="note-detail-summarize">AI 总结这段</button></div>';
    var del = box.querySelector('[data-del]');
    if (del) del.onclick = function () { deleteNote(n.id); };
    var sum = $('note-detail-summarize');
    if (sum) sum.onclick = function () { summarizeNotes(n.date || todayKey()); };
  }
  async function deleteNote(id) {
    if (!await uiConfirm('删除笔记', '删除后不可恢复（Markdown 文件也会删除），确定删除这条笔记？')) return;
    if (S.mock.notes || String(id).indexOf('mock_') === 0) {
      MOCK.notes = MOCK.notes.filter(function (n) { return String(n.id) !== String(id); });
      toast('已删除（示例模式，后端未就绪）', 'ok');
      S.notes = S.notes.filter(function (n) { return String(n.id) !== String(id); });
      var box = $('note-list'); if (box) Promise.resolve(loadNotes());
      var det = $('note-detail'); if (det) det.innerHTML = '<div class="muted">已删除。</div>';
      loadBoard(); return;
    }
    var r = await api('DELETE', '/api/v2/notes/' + encodeURIComponent(id));
    if (r.ok) { toast('笔记已删除', 'ok'); loadNotes(); loadBoard(); var det2 = $('note-detail'); if (det2) det2.innerHTML = '<div class="muted">已删除。</div>'; }
    else if (r.status === 404) { toast('后端未就绪，笔记未删除', 'warn'); }
  }
  async function createNote(text, source) {
    text = String(text || '').trim();
    if (!text) return false;
    if (S.mock.notes) {
      var n = { id: 'mock_note_' + Date.now(), title: text.slice(0, 20), text: text, excerpt: text.slice(0, 120), source: source === 'voice' ? 'voice' : 'text', date: todayKey(), time: fmtTime(Date.now()), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tags: [] };
      MOCK.notes.unshift(n); toast('已记下（示例模式，后端未就绪）', 'ok'); loadNotes(); loadBoard(); return true;
    }
    var r = await api('POST', '/api/v2/notes', { text: text, source: source || 'text' });
    if (r.ok) { toast('已记入笔记', 'ok'); loadNotes(); loadBoard(); return true; }
    if (r.status === 404) { S.mock.notes = true; showMockBadge('records-mock', true); return createNote(text, source); }
    toast('记录失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');
    return false;
  }
  async function summarizeNotes(date) {
    var btn = $('notes-summarize'); if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    toast('正在生成结构化总结（DeepSeek，可能需几秒）…', 'ok', 6000);
    var r = await softApi('POST', '/api/v2/documents/generate', { kind: 'note-summary', date: date || todayKey() });
    if (btn) { btn.disabled = false; btn.textContent = 'AI 总结这段'; }
    if (isMissing(r)) {
      S.mock.documents = true;
      var mockDoc = MOCK.docs.filter(function (d) { return d.kind === 'note-summary'; })[0] || MOCK.docs[0];
      S.noteSummary = mockDoc; renderSummary(mockDoc, true); toast('后端未就绪：已用示例总结展示结构', 'warn'); return;
    }
    if (!r.ok) { toast('总结失败：' + ((r.data && (r.data.error || r.data.message)) || ('HTTP ' + r.status)), 'bad'); return; }
    var d = r.data || {};
    var doc = d.document || d;
    S.noteSummary = doc;
    renderSummary(doc, false, d.downloads);
    loadDocuments(); loadBoard();
  }
  function renderSummary(doc, mock, downloads) {
    var card = $('note-summary'); if (!card) return;
    card.classList.remove('hidden');
    var prov = $('note-summary-provider');
    if (prov) prov.textContent = (mock ? '示例 · ' : '') + (doc.provider === 'deepseek' ? 'DeepSeek' : (doc.degraded ? '模板降级' : (doc.provider || 'AI'))) + (doc.kindLabel ? ' · ' + doc.kindLabel : '');
    var tm = $('note-summary-time'); if (tm) tm.textContent = fmtDateTime(doc.createdAt) || '';
    var body = $('note-summary-body'); if (body) body.innerHTML = structuredHtml(doc.structured, doc.summary);
    S.noteSummaryDoc = doc;
    var acts = $('note-summary-actions');
    if (acts) {
      var rows = ['md', 'docx', 'pdf'].map(function (f) { return '<button class="mini" data-dl="' + f + '" data-scope="summary" data-testid="summary-download-' + f + '">下载 ' + f.toUpperCase() + '</button>'; }).join('');
      acts.innerHTML = rows;
    }
  }
  function structuredHtml(st, summary) {
    if (!st) return '<p>' + esc(summary || '') + '</p>';
    var html = '';
    var sum = st['摘要'] || st.summary || summary || '';
    if (sum) html += '<div class="sect"><h4>摘要</h4><p>' + esc(sum) + '</p></div>';
    function listOf(k) {
      var v = st[k]; if (!v) return '';
      var arr = Array.isArray(v) ? v : [v];
      return '<div class="sect"><h4>' + k + '</h4><ul>' + arr.map(function (x) { return '<li>' + esc(typeof x === 'string' ? x : JSON.stringify(x)) + '</li>'; }).join('') + '</ul></div>';
    }
    html += listOf('重点') + listOf('待办') + listOf('回顾');
    var diary = st['日记'] || st.diary || '';
    if (diary) html += '<div class="sect"><h4>日记</h4><p>' + esc(diary) + '</p></div>';
    return html || '<p>' + esc(summary || '') + '</p>';
  }

  /* ---------------- 提醒页 ---------------- */
  async function loadReminders() {
    if (S.remindersLoading) return;
    S.remindersLoading = true;
    var r = await softApi('GET', '/api/v2/reminders');
    S.remindersLoading = false;
    var items = [];
    if (isMissing(r)) { S.mock.reminders = true; items = MOCK.reminders.slice(); showMockBadge('reminders-mock', true); }
    else {
      S.mock.reminders = false; showMockBadge('reminders-mock', false);
      items = (r.data && (r.data.items || r.data.reminders)) || [];
    }
    S.reminders = items;
    renderReminders();
    loadBoardCountsOnly();
  }
  function loadBoardCountsOnly() {
    if (S.tab !== 'home') return;
    /* 轻量更新看板里的提醒与文档状态，不重复请求屏幕/笔记 */
    var pending = (S.reminders || []).filter(function (x) { return !x.done; }).sort(function (a, b) { return new Date(a.at) - new Date(b.at); });
    S.board.next = pending[0] || null;
    S.board.mock = S.mock.reminders || S.mock.documents || S.mock.notes;
    renderBoard();
  }
  function renderReminders() {
    var now = Date.now();
    var pending = [], overdue = [], done = [];
    (S.reminders || []).forEach(function (x) {
      if (x.done) done.push(x);
      else if (new Date(x.at).getTime() <= now) overdue.push(x);
      else pending.push(x);
    });
    function sorted(arr) { return arr.slice().sort(function (a, b) { return new Date(a.at) - new Date(b.at); }); }
    pending = sorted(pending); overdue = sorted(overdue);
    done = done.slice().sort(function (a, b) { return new Date(b.doneAt || b.at) - new Date(a.doneAt || a.at); });
    var pc = $('reminders-pending-count'); if (pc) pc.textContent = String(pending.length);
    var oc = $('reminders-overdue-count'); if (oc) oc.textContent = String(overdue.length);
    var dc = $('reminders-done-count'); if (dc) dc.textContent = String(done.length);
    renderReminderList($('reminders-pending'), pending, 'pending');
    renderReminderList($('reminders-overdue'), overdue, 'overdue');
    renderReminderList($('reminders-done'), done, 'done');
  }
  function renderReminderList(box, items, kind) {
    if (!box) return;
    if (!items.length) { box.innerHTML = '<div class="muted empty">' + (kind === 'pending' ? '暂无待触发提醒' : kind === 'overdue' ? '没有逾期提醒' : '还没有完成记录') + '</div>'; return; }
    box.innerHTML = items.map(function (x) {
      var isDaily = x.recurrence === 'daily';
      return '<div class="reminder-item ' + kind + '" data-id="' + esc(x.id) + '" data-testid="reminder-item">' +
        '<span class="ri-time">' + esc(fmtDateTime(x.at)) + '</span>' +
        '<span class="ri-main"><b>' + esc(x.text || '提醒') + '</b>' +
        '<span class="ri-sub">' + esc(isDaily ? '每天' : '一次性') + ' · ' + esc(relTime(x.at)) + (x.source === 'voice' ? ' · 语音创建' : '') + '</span></span>' +
        (kind === 'done' ? '<span class="badge ok">已完成</span>' : '<span class="ri-actions"><button class="mini" data-done="' + esc(x.id) + '" data-testid="reminder-done">完成</button><button class="mini danger" data-del="' + esc(x.id) + '" data-testid="reminder-delete">删除</button></span>') +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-done]'), function (b) {
      b.onclick = function () { markReminderDone(b.getAttribute('data-done')); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function () { deleteReminder(b.getAttribute('data-del')); };
    });
  }
  async function createReminder() {
    var text = ($('reminder-text') && $('reminder-text').value || '').trim();
    var at = $('reminder-at') && $('reminder-at').value;
    var rec = $('reminder-recurrence') && $('reminder-recurrence').value || 'once';
    if (!text) { toast('请填写提醒内容', 'warn'); return; }
    if (!at) { toast('请选择提醒时间', 'warn'); return; }
    var iso = new Date(at).toISOString();
    if (S.mock.reminders) {
      MOCK.reminders.push({ id: 'mock_rmd_' + Date.now(), text: text, at: iso, recurrence: rec, done: false, source: 'text', createdAt: new Date().toISOString() });
      toast('已创建（示例模式，后端未就绪）', 'ok');
      $('reminder-text').value = '';
      loadReminders(); return;
    }
    var r = await api('POST', '/api/v2/reminders', { text: text, at: iso, recurrence: rec, source: 'text' });
    if (r.ok) {
      toast('提醒已创建' + (r.data && r.data.parsed ? '（' + r.data.parsed.human + '）' : ''), 'ok');
      if ($('reminder-text')) $('reminder-text').value = '';
      loadReminders();
    } else if (r.status === 404) { S.mock.reminders = true; showMockBadge('reminders-mock', true); createReminder(); }
    else toast('创建失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');
  }
  async function markReminderDone(id) {
    if (S.mock.reminders || String(id).indexOf('mock_') === 0) {
      MOCK.reminders.forEach(function (x) { if (String(x.id) === String(id)) { x.done = true; x.doneAt = new Date().toISOString(); } });
      toast('已完成（示例模式）', 'ok'); loadReminders(); return;
    }
    var r = await api('POST', '/api/v2/reminders/' + encodeURIComponent(id) + '/done', {});
    if (r.ok) { toast('已完成', 'ok'); loadReminders(); } else toast('操作失败', 'bad');
  }
  async function deleteReminder(id) {
    if (S.mock.reminders || String(id).indexOf('mock_') === 0) {
      MOCK.reminders = MOCK.reminders.filter(function (x) { return String(x.id) !== String(id); });
      toast('已删除（示例模式）', 'ok'); loadReminders(); return;
    }
    if (!await uiConfirm('删除提醒', '删除后不会再提醒，确定删除？')) return;
    var r = await api('DELETE', '/api/v2/reminders/' + encodeURIComponent(id));
    if (r.ok) { toast('已删除', 'ok'); loadReminders(); } else toast('删除失败', 'bad');
  }

  /* ---------------- 文档页 ---------------- */
  async function loadDocuments() {
    var r = await softApi('GET', '/api/v2/documents?limit=100');
    var items = [];
    if (isMissing(r)) { S.mock.documents = true; items = MOCK.docs.slice(); showMockBadge('documents-mock', true); }
    else { S.mock.documents = false; showMockBadge('documents-mock', false); items = (r.data && (r.data.items || r.data.documents)) || []; }
    S.docs = items;
    var count = $('documents-count'); if (count) count.textContent = String(items.length);
    var box = $('document-list'); if (!box) return;
    if (!items.length) { box.innerHTML = '<div class="muted empty">还没有总结文档：点右上「重新生成今日总结」，或在记录页「AI 总结这段」。</div>'; return; }
    box.innerHTML = items.map(function (d) {
      var size = '';
      if (d.files) { var keys = Object.keys(d.files); size = keys.join('/'); }
      var kindLabel = d.kindLabel || ({ daily: '每日总结', 'note-summary': '笔记总结', 'note-set': '笔记合集' })[d.kind] || d.kind || '总结';
      return '<div class="doc-item" data-id="' + esc(d.id) + '" data-testid="document-item">' +
        '<div class="doc-main"><b>' + esc(d.title || kindLabel) + '</b>' +
        '<span class="doc-sub muted">' + esc(fmtDateTime(d.createdAt) || d.date || '') + ' · ' + esc(kindLabel) + ' · ' + esc(d.provider === 'template' || d.degraded ? '模板降级' : (d.provider || 'AI')) + (d.chars ? ' · ' + d.chars + ' 字' : '') + (size ? ' · ' + esc(size) : '') + '</span>' +
        (d.summary ? '<span class="doc-sum">' + esc(String(d.summary).slice(0, 140)) + '</span>' : '') + '</div>' +
        '<div class="doc-actions">' +
        '<button class="mini" data-dl="md" data-id="' + esc(d.id) + '" data-testid="document-download-md">MD</button>' +
        '<button class="mini" data-dl="docx" data-id="' + esc(d.id) + '" data-testid="document-download-docx">DOCX</button>' +
        '<button class="mini" data-dl="pdf" data-id="' + esc(d.id) + '" data-testid="document-download-pdf">PDF</button>' +
        '<button class="mini danger" data-del="' + esc(d.id) + '" data-testid="document-delete">删除</button>' +
        '</div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-dl]'), function (b) {
      b.onclick = function () { downloadDoc(b.getAttribute('data-id'), b.getAttribute('data-dl')); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (b) {
      b.onclick = function () { deleteDoc(b.getAttribute('data-del')); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('.doc-main'), function (m) {
      m.onclick = function () { previewDoc(m.parentNode.getAttribute('data-id')); };
    });
  }
  async function previewDoc(id) {
    var d = null;
    for (var i = 0; i < S.docs.length; i++) if (String(S.docs[i].id) === String(id)) d = S.docs[i];
    if (!d) return;
    S.docPreview = d;
    var box = $('document-preview');
    var markdown = '';
    if (!S.mock.documents && String(id).indexOf('mock_') !== 0) {
      var r = await softApi('GET', '/api/v2/documents/' + encodeURIComponent(id));
      if (r.ok && r.data) markdown = r.data.markdown || '';
    }
    if (box) box.innerHTML =
      '<div class="detail-head"><div><h3>' + esc(d.title || '总结文档') + '</h3>' +
      '<div class="muted">' + esc(fmtDateTime(d.createdAt) || d.date || '') + ' · ' + esc(d.kindLabel || d.kind || '') + ' · ' + esc(d.provider === 'template' || d.degraded ? '模板降级' : (d.provider || 'AI')) + '</div></div>' +
      '<div class="head-actions"><button class="mini" data-dl="md" data-id="' + esc(d.id) + '">MD</button><button class="mini" data-dl="docx" data-id="' + esc(d.id) + '">DOCX</button><button class="mini" data-dl="pdf" data-id="' + esc(d.id) + '">PDF</button></div></div>' +
      '<div class="structured">' + structuredHtml(d.structured, d.summary) + '</div>' +
      (markdown ? '<details class="md-details"><summary>Markdown 原文</summary><pre class="note-full">' + esc(markdown) + '</pre></details>' : '');
    Array.prototype.forEach.call(box.querySelectorAll('[data-dl]'), function (b) {
      b.onclick = function () { downloadDoc(b.getAttribute('data-id'), b.getAttribute('data-dl')); };
    });
  }
  async function downloadDoc(id, format) {
    if (S.mock.documents || String(id).indexOf('mock_') === 0) { toast('后端未就绪：示例文档暂不能下载，接口挂载后即可导出 ' + format.toUpperCase(), 'warn', 4800); return; }
    var b = S.token || tok(); if (!b) { showTokenHint(); return; }
    try {
      var r = await fetch('/api/v2/documents/' + encodeURIComponent(id) + '/download?format=' + encodeURIComponent(format), { headers: { 'x-tenon-token': b }, credentials: 'same-origin' });
      if (!r.ok) { toast('下载失败 HTTP ' + r.status, 'bad'); return; }
      var blob = await r.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'tenon-' + id + '.' + format;
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { URL.revokeObjectURL(url); a.remove(); } catch (e) {} }, 1500);
      toast('已开始下载 ' + format.toUpperCase(), 'ok');
    } catch (e) { toast('下载失败：' + e.message, 'bad'); }
  }
  async function deleteDoc(id) {
    if (!await uiConfirm('删除文档', '文档的 MD/DOCX/PDF 会被一起删除，确定？')) return;
    if (S.mock.documents || String(id).indexOf('mock_') === 0) {
      MOCK.docs = MOCK.docs.filter(function (d) { return String(d.id) !== String(id); });
      toast('已删除（示例模式）', 'ok'); loadDocuments(); return;
    }
    var r = await api('DELETE', '/api/v2/documents/' + encodeURIComponent(id));
    if (r.ok) { toast('文档已删除', 'ok'); loadDocuments(); loadBoard(); } else toast('删除失败', 'bad');
  }
  async function generateDaily() {
    var btn = $('documents-regenerate');
    if (btn) { btn.disabled = true; btn.textContent = '生成中…'; }
    toast('正在生成今日总结文档（DeepSeek，约几秒）…', 'ok', 6000);
    var r = await softApi('POST', '/api/v2/documents/generate', { kind: 'daily', date: todayKey() });
    if (btn) { btn.disabled = false; btn.textContent = '重新生成今日总结'; }
    if (isMissing(r)) { S.mock.documents = true; showMockBadge('documents-mock', true); toast('后端未就绪：示例模式不会真正生成文档', 'warn', 4800); loadDocuments(); return; }
    if (!r.ok) { toast('生成失败：' + ((r.data && (r.data.error || r.data.message)) || ('HTTP ' + r.status)), 'bad'); return; }
    var d = (r.data && (r.data.document || r.data)) || {};
    toast('已生成：' + (d.title || '今日总结') + (d.degraded ? '（模板降级）' : ''), 'ok', 5000);
    loadDocuments(); loadBoard();
  }

  /* ---------------- 设置 / IoT ---------------- */
  async function fillSettings() {
    try {
      var c = await api('GET', '/api/v2/voice/config');
      var cfg = (c.data && c.data.config) || {};
      if ($('set-token')) $('set-token').value = S.token || '';
      if ($('set-enabled')) $('set-enabled').checked = !!cfg.enabled;
      var ambCfg = cfg.ambient || {};
      if ($('set-ambient')) $('set-ambient').checked = ambCfg.enabled !== false;
      if ($('set-wakewords')) $('set-wakewords').value = (cfg.wakeWords || []).join(',');
      if ($('set-tts')) $('set-tts').checked = !!(cfg.tts && cfg.tts.play);
      if ($('set-diary-time')) $('set-diary-time').value = (cfg.diary && cfg.diary.time) || '23:00';
      if ($('set-retention')) $('set-retention').value = cfg.retentionDays || 30;
      if ($('set-screen-interval')) $('set-screen-interval').value = (cfg.screen && cfg.screen.intervalSec) || 60;
      try { S.agent = localStorage.getItem(AGENT_KEY) || 'builtin'; } catch (e) { S.agent = 'builtin'; }
      if ($('set-agent')) $('set-agent').value = S.agent;
      var chipA = $('chip-agent'); if (chipA) chipA.textContent = S.agent === 'openclaw' ? 'OpenClaw 小龙虾' : '自研执行器';
    } catch (e) { setMsg('读取配置失败：' + e.message); }
    fillIot();
  }
  async function fillIot() {
    await loadIotStatus();
    var cfg = (S.iot.config && (S.iot.config.config || S.iot.config)) || {};
    var ha = cfg.ha || cfg.homeassistant || {};
    var mq = cfg.mqtt || {};
    if ($('iot-ha-url')) $('iot-ha-url').value = ha.baseUrl || cfg.baseUrl || '';
    if ($('iot-ha-token')) $('iot-ha-token').value = '';
    if ($('iot-ha-token')) $('iot-ha-token').placeholder = (ha.tokenSet || ha.tokenMasked) ? '已保存令牌（保存后脱敏，留空不覆盖）' : 'HA 个人资料 → 长期访问令牌';
    if ($('iot-mqtt-broker')) $('iot-mqtt-broker').value = mq.url || mq.broker || cfg.mqttUrl || '';
    if ($('iot-mqtt-prefix')) $('iot-mqtt-prefix').value = mq.prefix || cfg.prefix || 'homeassistant';
    if ($('iot-mqtt-username')) $('iot-mqtt-username').value = mq.username || '';
    if ($('iot-mqtt-password')) $('iot-mqtt-password').value = '';
    renderIotStatus();
    loadIotDevices();
  }
  async function loadIotStatus() {
    var st = await softApi('GET', '/api/v2/iot/status');
    var cfg = await softApi('GET', '/api/v2/iot/config');
    if (isMissing(st)) {
      S.mock.iot = true;
      showMockBadge('iot-mock', true);
      S.iot.status = { mock: true, ha: { configured: false, connected: false }, mqtt: { configured: false, connected: false }, devices: 3 };
      S.iot.config = { mock: true, config: {} };
    } else {
      S.mock.iot = false;
      showMockBadge('iot-mock', false);
      S.iot.status = st.data || {};
      if (!isMissing(cfg)) S.iot.config = cfg.data || {};
    }
    renderIotStatus();
  }
  function renderIotStatus() {
    var st = S.iot.status || {};
    var ha = st.ha || {};
    var mq = st.mqtt || {};
    var haOn = ha.lastTestOk === true && ha.configured !== false;
    var mqOn = mq.connected === true;
    var haChip = $('iot-ha-state');
    if (haChip) { haChip.textContent = haOn ? 'HA 已连接' : (ha.configured ? 'HA 未连接' : 'HA 未配置'); haChip.classList.toggle('on', !!haOn); }
    var mqChip = $('iot-mqtt-state');
    if (mqChip) { mqChip.textContent = mqOn ? 'MQTT 已连接' : (mq.configured ? 'MQTT 未连接' : 'MQTT 未配置'); mqChip.classList.toggle('on', !!mqOn); }
    var total = (st.devices && typeof st.devices === 'object') ? (st.devices.total || 0) : (st.devices || st.deviceCount || (S.iot.devices || []).length);
    var chipIot = $('chip-iot'); if (chipIot) chipIot.textContent = '物联 ' + (Number(total) || 0);
    var dc = $('iot-devices-count'); if (dc) dc.textContent = String((S.iot.devices || []).length || Number(total) || 0);
  }
  async function loadIotDevices() {
    var r = await softApi('GET', '/api/v2/iot/devices');
    var items = [];
    if (isMissing(r)) { S.mock.iot = true; showMockBadge('iot-mock', true); items = MOCK.iotDevices.slice(); }
    else { items = (r.data && (r.data.devices || r.data.items)) || []; }
    S.iot.devices = items;
    renderIotDevices();
    renderIotStatus();
  }
  function renderIotDevices() {
    var box = $('iot-devices'); if (!box) return;
    if (!S.iot.devices.length) { box.innerHTML = '<div class="muted">还没有接入物联设备：先配置 Home Assistant / MQTT，或发现局域网设备。</div>'; return; }
    box.innerHTML = S.iot.devices.map(function (d) {
      var domain = d.domain || d.type || 'switch';
      var on = /on|playing|open|true/i.test(String(d.state));
      var cmds = Array.isArray(d.commands) && d.commands.length ? d.commands : (Array.isArray(d.capabilities) ? d.capabilities.map(function (c) { return (c && c.command) || (c && c.id) || c; }).filter(Boolean) : []);
      var labelMap = { turn_on: '开', turn_off: '关', toggle: '切换', set_brightness: '亮度', brightness_up: '亮度+', brightness_down: '亮度-', media_play: '播放', media_pause: '暂停', media_next: '下一首', media_previous: '上一首', open_cover: '打开', close_cover: '关闭', set_temperature: '设温', read: '只读' };
      var controls = cmds.filter(function (c) { return c && c !== 'read'; }).slice(0, 3).map(function (c) { return [labelMap[c] || String(c), c]; });
      if (!controls.length && ['light', 'switch', 'socket'].indexOf(domain) >= 0) controls = [['开', 'turn_on'], ['关', 'turn_off']];
      var sourceLabel = d.source === 'mqtt' ? ' · MQTT' : d.source === 'ssdp' ? ' · SSDP' : d.source === 'ha' ? ' · HA' : '';
      return '<div class="device iot-device" data-id="' + esc(d.id) + '" data-testid="iot-device">' +
        '<h3><span class="dot ' + (on ? 'on' : '') + '"></span>' + esc(d.name || d.id) + ' <span class="badge">' + esc(domain) + sourceLabel + '</span></h3>' +
        '<div class="meta">状态：' + esc(on ? '开' : (d.state || '未知')) + (d.available === false ? ' · 不可用' : '') + (d.note ? ' · ' + esc(String(d.note).slice(0, 40)) : '') + '</div>' +
        '<div class="acts">' + (d.adapter === 'ssdp' ? '<span class="badge warn">SSDP 只读发现</span>' : '') + controls.map(function (c) { return '<button data-ctl="' + esc(c[1]) + '" data-id="' + esc(d.id) + '" data-testid="iot-control">' + esc(c[0]) + '</button>'; }).join('') +
        '<button class="danger" data-iot-del="' + esc(d.id) + '" data-testid="iot-delete">移除</button></div>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-ctl]'), function (b) {
      b.onclick = function () { iotControl(b.getAttribute('data-id'), b.getAttribute('data-ctl')); };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-iot-del]'), function (b) {
      b.onclick = function () { iotDelete(b.getAttribute('data-iot-del')); };
    });
  }
  async function iotControl(id, command) {
    if (S.mock.iot || String(id).indexOf('iot:mock') === 0) {
      S.iot.devices.forEach(function (d) {
        if (String(d.id) !== String(id)) return;
        if (command === 'turn_on' || command === 'open_cover' || command === 'media_play') d.state = 'on';
        else if (command === 'turn_off' || command === 'close_cover' || command === 'media_pause') d.state = 'off';
        else if (command === 'toggle') d.state = d.state === 'on' ? 'off' : 'on';
        else if (command === 'brightness_up') d.state = 'on';
      });
      toast('已发送 ' + command + '（示例模式：后端 /api/v2/iot 就绪后将真正控制设备）', 'warn', 4800);
      renderIotDevices(); return;
    }
    var r = await api('POST', '/api/v2/iot/devices/' + encodeURIComponent(id) + '/control', { command: command, params: {} });
    if (r.ok) { toast('已发送控制：' + command, 'ok'); loadIotDevices(); }
    else toast('控制失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');
  }
  async function iotDelete(id) {
    if (S.mock.iot || String(id).indexOf('iot:mock') === 0) { toast('示例模式：接口就绪后可移除设备', 'warn'); return; }
    if (!await uiConfirm('移除设备', '只会从榫卯的已接入设备里移除，不会影响 Home Assistant / MQTT 里的真实设备。')) return;
    var r = await api('DELETE', '/api/v2/iot/devices/' + encodeURIComponent(id));
    if (r.ok) { toast('已移除', 'ok'); loadIotDevices(); } else toast('移除失败', 'bad');
  }
  function iotConfigBody(which) {
    var body = {};
    if (which === 'ha') {
      var ha = { baseUrl: $('iot-ha-url') ? $('iot-ha-url').value.trim() : '' };
      var token = $('iot-ha-token') ? $('iot-ha-token').value.trim() : '';
      if (token) ha.token = token; // 留空则不覆盖已保存令牌
      body.ha = ha;
    } else {
      var mq = {
        url: $('iot-mqtt-broker') ? $('iot-mqtt-broker').value.trim() : '',
        username: $('iot-mqtt-username') ? $('iot-mqtt-username').value.trim() : '',
        prefix: $('iot-mqtt-prefix') ? $('iot-mqtt-prefix').value.trim() : 'homeassistant'
      };
      var pw = $('iot-mqtt-password') ? $('iot-mqtt-password').value : '';
      if (pw) mq.password = pw;
      body.mqtt = mq;
    }
    return body;
  }
  async function saveIot(which) {
    if (S.mock.iot) { toast('后端未就绪：配置未保存（接口挂载后生效）', 'warn'); return; }
    var r = await api('PATCH', '/api/v2/iot/config', iotConfigBody(which));
    if (r.ok) { toast('已保存' + (which === 'ha' ? ' Home Assistant 配置' : ' MQTT 配置'), 'ok'); await fillIot(); }
    else toast('保存失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');
  }
  async function testIot() {
    if (S.mock.iot) { toast('后端未就绪：示例模式下不发起真实连接测试', 'warn'); return; }
    toast('正在测试连接…', 'ok');
    var r = await api('POST', '/api/v2/iot/test', {});
    if (!r.ok) { toast('测试失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad'); return; }
    var d = r.data || {};
    var ha = d.ha || d.homeassistant || {};
    var mq = d.mqtt || {};
    toast('HA：' + (ha.ok ? '连接成功（' + (ha.version || '') + '）' : '失败 ' + (ha.error || '')) + '；MQTT：' + (mq.ok ? '连接成功' : '失败 ' + (mq.error || '')), ha.ok || mq.ok ? 'ok' : 'bad', 6000);
    loadIotStatus();
  }
  async function loadHaEntities() {
    if (S.mock.iot) {
      S.iot.entities = MOCK.iotEntities.slice();
      renderEntities(true); toast('示例模式：以下为示例实体', 'warn'); return;
    }
    var r = await softApi('GET', '/api/v2/iot/ha/entities');
    if (isMissing(r) || !r.ok) { toast('读取实体失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad'); return; }
    var items = (r.data && (r.data.entities || r.data.items)) || [];
    S.iot.entities = items;
    renderEntities(false);
  }
  function renderEntities(mock) {
    var box = $('iot-entities'); if (!box) return;
    box.classList.remove('hidden');
    if (!S.iot.entities.length) { box.innerHTML = '<div class="muted">没有实体：先保存并测试 HA 连接。</div>'; return; }
    box.innerHTML = '<div class="entity-head"><b>HA 实体（勾选后导入为榫卯设备）</b><button class="mini" id="iot-import-ha" data-testid="iot-import-ha">导入选中</button></div>' +
      '<div class="entity-list">' + S.iot.entities.slice(0, 100).map(function (e, i) {
        var id = e.id || e.entityId || e.entity_id || '';
        var name = e.name || e.friendlyName || id;
        var domain = e.domain || (String(id).indexOf('.') >= 0 ? String(id).split('.')[0] : '');
        return '<label class="entity-row" data-testid="iot-entity"><input type="checkbox" data-entity="' + esc(id) + '"' + (i < 6 ? ' checked' : '') + '>' +
          '<span class="entity-name">' + esc(name) + '</span><span class="badge">' + esc(domain) + '</span><span class="muted">' + esc(e.state || '') + '</span></label>';
      }).join('') + '</div>';
    var btn = $('iot-import-ha');
    if (btn) btn.onclick = importHa;
  }
  async function importHa() {
    var box = $('iot-entities'); if (!box) return;
    var ids = [];
    Array.prototype.forEach.call(box.querySelectorAll('[data-entity]'), function (c) { if (c.checked) ids.push(c.getAttribute('data-entity')); });
    if (!ids.length) { toast('先勾选要导入的实体', 'warn'); return; }
    if (S.mock.iot) {
      S.iot.devices = S.iot.devices.concat(ids.map(function (id, i) {
        var e = S.iot.entities.filter(function (x) { return (x.id || x.entityId) === id; })[0] || { name: id };
        var domain = String(id).split('.')[0] || 'switch';
        return { id: 'iot:mock:imported' + i, name: e.name || id, domain: domain, state: e.state || 'off', source: 'ha', capabilities: ['turn_on', 'turn_off'] };
      }));
      renderIotDevices(); renderIotStatus(); toast('已导入 ' + ids.length + ' 个（示例模式）', 'warn'); return;
    }
    var r = await api('POST', '/api/v2/iot/import', { source: 'ha', ids: ids });
    if (r.ok) { toast('已导入 ' + importedCount(r.data, ids.length) + ' 个设备', 'ok'); loadIotDevices(); loadIotStatus(); }
    else toast('导入失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');
  }
  async function discoverMqtt() {
    var box = $('iot-mqtt-list');
    if (S.mock.iot) {
      S.iot.mqttDiscovered = [
        { name: 'xiaomi_gateway', topic: 'homeassistant/switch/xiaomi_gateway/config', type: 'switch' },
        { name: 'telink_bulb', topic: 'homeassistant/light/telink_bulb/config', type: 'light' }
      ];
    } else {
      var r = await softApi('GET', '/api/v2/iot/mqtt/devices');
      if (isMissing(r) || !r.ok) { toast('发现失败：请先保存 MQTT 配置并测试连接（或后端尚未支持）', 'warn', 4800); return; }
      S.iot.mqttDiscovered = (r.data && (r.data.devices || r.data.items)) || [];
    }
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML = (S.iot.mqttDiscovered.length ? S.iot.mqttDiscovered.map(function (d) {
        return '<div class="discover-row"><span>' + esc(d.name || d.topic || d.id) + '</span><span class="badge">' + esc(d.type || d.domain || 'mqtt') + '</span>' +
          '<button class="mini" data-import="' + esc(d.id || d.topic || d.name) + '">导入</button></div>';
      }).join('') + '<div class="row btns"><button class="mini" id="iot-import-mqtt" data-testid="iot-import-mqtt">导入全部</button></div>' : '<div class="muted">没有发现可导入的 MQTT 设备</div>');
      Array.prototype.forEach.call(box.querySelectorAll('[data-import]'), function (b) {
        b.onclick = function () { importIot('mqtt', [b.getAttribute('data-import')]); };
      });
      var all = $('iot-import-mqtt'); if (all) all.onclick = function () { importIot('mqtt', S.iot.mqttDiscovered.map(function (d) { return d.id || d.topic || d.name; })); };
    }
  }
  async function discoverSsdp() {
    var box = $('iot-ssdp-list');
    if (S.mock.iot) { S.iot.discovered = MOCK.ssdp.slice(); }
    else {
      var r = await softApi('GET', '/api/v2/iot/discover?st=ssdp:all');
      if (isMissing(r) || !r.ok) { toast('SSDP 发现失败：后端未就绪或网络不可用', 'warn', 4800); return; }
      S.iot.discovered = (r.data && (r.data.devices || r.data.items)) || [];
    }
    if (box) {
      box.classList.remove('hidden');
      box.innerHTML = (S.iot.discovered.length ? S.iot.discovered.map(function (d) {
        return '<div class="discover-row"><span>' + esc(d.name || d.server || d.location || '局域网设备') + '</span><span class="badge">' + esc(d.type || 'SSDP') + '</span>' +
          '<span class="muted tiny">' + esc(d.location || '') + '</span><button class="mini" data-import="' + esc(d.usn || d.location || d.name) + '">导入</button></div>';
      }).join('') + '<div class="row btns"><button class="mini" id="iot-import-ssdp" data-testid="iot-import-ssdp">导入全部</button></div>' : '<div class="muted">没有发现局域网设备（SSDP 只在同网段有效）</div>');
      Array.prototype.forEach.call(box.querySelectorAll('[data-import]'), function (b) {
        b.onclick = function () { importIot('ssdp', [b.getAttribute('data-import')]); };
      });
      var all = $('iot-import-ssdp'); if (all) all.onclick = function () { importIot('ssdp', S.iot.discovered.map(function (d) { return d.usn || d.location || d.name; })); };
    }
  }
  function importedCount(data, fallback) {
    if (!data) return fallback;
    var v = data.imported;
    if (typeof v === 'number') return v;
    if (Array.isArray(v)) return v.length;
    if (Array.isArray(data.devices)) return data.devices.length;
    return fallback;
  }
  async function importIot(source, ids) {
    if (S.mock.iot) {
      S.iot.devices = S.iot.devices.concat(ids.map(function (id, i) {
        return { id: 'iot:mock:' + source + i, name: String(id).split('/').pop() || id, domain: 'switch', state: 'off', source: source, capabilities: ['turn_on', 'turn_off'] };
      }));
      renderIotDevices(); renderIotStatus(); toast('已导入 ' + ids.length + ' 个（示例模式）', 'warn'); return;
    }
    var r = await api('POST', '/api/v2/iot/import', { source: source, ids: ids });
    if (r.ok) { toast('已导入 ' + importedCount(r.data, ids.length) + ' 个设备', 'ok'); loadIotDevices(); loadIotStatus(); }
    else toast('导入失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');
  }

  /* ---------------- 快捷指令 ---------------- */
  async function runQuick(kind) {
    if (kind === 'note') {
      S.composeMode = 'note';
      var input = $('cmd-input');
      if (input) { input.value = ''; input.placeholder = '输入要记下的要点，回车保存为笔记'; input.focus(); }
      var hint = $('compose-hint'); if (hint) hint.textContent = '记录模式：输入后回车即保存到「记录」页；按 Esc 取消。';
      return;
    }
    if (kind === 'summary') { switchTab('documents'); generateDaily(); return; }
    if (kind === 'reminder') {
      var inOne = new Date(Date.now() + 60 * 1000);
      var iso = inOne.toISOString();
      if (S.mock.reminders) {
        MOCK.reminders.push({ id: 'mock_rmd_' + Date.now(), text: '喝水', at: iso, recurrence: 'once', done: false, source: 'voice', createdAt: new Date().toISOString() });
        toast('已创建提醒：喝水（示例模式）', 'ok'); loadReminders(); return;
      }
      var r = await api('POST', '/api/v2/reminders', { text: '喝水', at: iso, recurrence: 'once', source: 'voice' });
      if (r.ok) { toast('已创建提醒：1 分钟后喝水', 'ok'); loadReminders(); }
      else if (r.status === 404) { S.mock.reminders = true; showMockBadge('reminders-mock', true); runQuick('reminder'); }
      else toast('创建失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');
      return;
    }
    if (kind === 'light') {
      var target = null;
      (S.iot.devices || []).forEach(function (d) { if (!target && (/灯|light/i.test(String(d.name || '') + String(d.domain || '')))) target = d; });
      if (!target) { toast('还没接入灯：去「设置 → 物联接入」配置 Home Assistant 或 MQTT，或发现局域网设备', 'warn', 5200); switchTab('settings'); return; }
      iotControl(target.id, 'turn_on'); return;
    }
  }

  /* ---------------- 语音 / 命令 ---------------- */
  async function sendCommand(text) {
    if (!text || !text.trim()) return;
    var cmd = text.trim();
    if (S.composeMode === 'note') {
      S.composeMode = '';
      var input0 = $('cmd-input');
      if (input0) input0.placeholder = '也可以直接输入命令，例如：打开记事本 / 把音量调到 60 / 记一下今天要点';
      var hint0 = $('compose-hint'); if (hint0) hint0.textContent = '';
      await createNote(cmd, 'text');
      return;
    }
    if (S.agent === 'openclaw') {
      try {
        var r0 = await api('POST', '/api/v2/agent/openclaw', { text: cmd, timeoutMs: 180000 });
        var d0 = r0.data || {};
        renderResult({ say: d0.say || ('OpenClaw 完成（' + (d0.durationMs || 0) + 'ms）'), provider: 'openclaw · ' + (d0.model || ''), latencyMs: d0.durationMs, steps: [] });
      } catch (e) { renderResult({ say: 'OpenClaw 执行失败：' + e.message + '（可到设置切回自研执行器）', error: true }); }
      return;
    }
    try {
      var r = await api('POST', '/api/v2/voice/command', { text: cmd });
      var d = r.data || {};
      renderResult(d);
      scheduleRefreshAfterVoice();
    } catch (e) { renderResult({ say: '执行失败：' + e.message, error: true }); }
  }

  /* ---------------- 旧功能页（设备 / 今日）保留 ---------------- */
  async function loadDevices() {
    var box = $('device-list'); if (!box) return;
    box.innerHTML = '<div class="muted">加载中…</div>';
    var r = await softApi('GET', '/api/v2/devices');
    if (!r.ok) { box.innerHTML = '<div class="muted">加载失败：' + esc((r.data && r.data.error) || ('HTTP ' + r.status)) + '</div>'; return; }
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
        '<button data-cmd="把电脑音量调到 60">音量 60</button><button data-cmd="打开记事本">打开记事本</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('button[data-act]'), function (b) {
      b.onclick = async function () {
        var card = b.closest('.device'); var id = card.getAttribute('data-id');
        var act = b.getAttribute('data-act');
        b.disabled = true;
        var rr = await api('POST', '/api/v2/devices/' + encodeURIComponent(id) + '/' + act, {});
        if (rr.ok) { b.textContent = act === 'bind' ? '已绑定' : '已移除'; setTimeout(loadDevices, 600); }
        else { b.textContent = '失败'; b.disabled = false; }
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('button[data-cmd]'), function (b) { b.onclick = function () { sendCommand(b.getAttribute('data-cmd')); }; });
  }
  async function loadToday() {
    var r = await softApi('GET', '/api/v2/voice/transcripts?limit=60');
    var items = (r.data && (r.data.items || r.data.transcripts)) || [];
    var vl = $('voice-list');
    if (vl) vl.innerHTML = items.slice(-40).reverse().map(function (it) {
      return '<div class="item"><span class="t">' + esc(fmtTime(it.at || it.ts)) + '</span>' + esc((it.text || it.preview || '').slice(0, 160)) + '</div>';
    }).join('') || '<div class="muted">今天还没有语音记录</div>';
    var sr = await softApi('GET', '/api/v2/voice/screen?limit=60');
    var sitems = (sr.data && sr.data.items) || [];
    var sl = $('today-screen-list');
    if (sl) sl.innerHTML = sitems.slice(-40).reverse().map(function (it) {
      return '<div class="item"><span class="t">' + esc(fmtTime(it.at || it.ts)) + '</span>' + esc((it.app || '') + ' ' + (it.title || '')) + '<br><span class="muted">' + esc((it.text || '').slice(0, 200)) + '</span></div>';
    }).join('') || '<div class="muted">今天还没有屏幕文字</div>';
    loadDiary();
  }
  async function loadDiary() {
    var r = await softApi('GET', '/api/v2/voice/diary');
    var d = (r.data || {});
    var md = d.markdown || d.content || '';
    if (md) {
      var card = $('diary-card'); if (card) card.classList.remove('hidden');
      var pv = $('diary-provider'); if (pv) pv.textContent = 'DeepSeek · 每日总结';
      var tm = $('diary-time'); if (tm) tm.textContent = d.date || '';
      var mdEl = $('diary-md'); if (mdEl) mdEl.textContent = md;
    }
  }

  /* ---------------- 设置保存 ---------------- */
  async function saveSettings() {
    if ($('set-token')) setToken($('set-token').value.trim());
    S.agent = $('set-agent') ? $('set-agent').value : 'builtin';
    try { localStorage.setItem(AGENT_KEY, S.agent); } catch (e) {}
    var chipA = $('chip-agent'); if (chipA) chipA.textContent = S.agent === 'openclaw' ? 'OpenClaw 小龙虾' : '自研执行器';
    var body = {
      enabled: $('set-enabled') ? $('set-enabled').checked : false,
      ambient: { enabled: $('set-ambient') ? $('set-ambient').checked : true },
      wakeWords: ($('set-wakewords') ? $('set-wakewords').value : '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      tts: { play: $('set-tts') ? $('set-tts').checked : true },
      diary: { time: ($('set-diary-time') && $('set-diary-time').value) || '23:00' },
      retentionDays: Number($('set-retention') && $('set-retention').value) || 30,
      screen: { intervalSec: Number($('set-screen-interval') && $('set-screen-interval').value) || 60 }
    };
    var r = await api('PATCH', '/api/v2/voice/config', body);
    setMsg(r.ok ? '已保存到中枢 ✓' : '保存失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)));
    if (r.ok) { toast('设置已保存', 'ok'); refreshStatus(); }
  }

  /* ---------------- 唤醒监听（wake 页，独立于 24h 记录） ---------------- */
  function listenStateText(st) {
    st = st || {};
    var enabled = !!st.enabled;
    var asr = (st.workers && st.workers.asr) || {};
    if (!enabled) return '唤醒监听已暂停（点「开启唤醒监听」恢复）';
    if (st.state === 'session' || st.state === 'wake' || st.state === 'listening') return '唤醒监听中：说「榫卯」即可下命令';
    if (asr.state === 'starting') return '唤醒监听启动中…（首次加载模型约 20-40 秒）';
    if (asr.state === 'running' || asr.state === 'mock') return '唤醒监听中：说「榫卯」即可下命令';
    if (asr.state === 'unavailable' || asr.state === 'error' || st.state === 'error') return '唤醒引擎未就绪：仍可点「开始录音」或输入命令';
    return '唤醒监听已开启';
  }
  function renderWakeListen(st) {
    st = st || S.status || {};
    var enabled = !!st.enabled;
    var asr = (st.workers && st.workers.asr) || {};
    var label = $('wake-listen-state');
    if (label) label.textContent = listenStateText(st);
    var dot = $('wake-dot');
    if (dot) {
      dot.classList.toggle('on', enabled);
      dot.classList.toggle('warn', enabled && /starting/.test(String(asr.state)));
    }
    var btn = $('wake-toggle');
    if (btn && !btn.disabled) {
      btn.textContent = enabled ? '暂停唤醒监听' : '开启唤醒监听';
      btn.classList.toggle('on', enabled);
    }
    var hint = $('wake-listen-hint');
    if (hint) hint.textContent = enabled
      ? '唤醒词：' + (((st.wakeWords || [])[0]) || '榫卯') + ' · 常驻监听中；关闭只影响唤醒，不影响 24h 全天记录'
      : '监听已暂停：点右侧按钮恢复常驻唤醒；24h 全天记录在另一页独立开关';
  }
  async function toggleWakeListen() {
    var st = S.status || {};
    var on = !!st.enabled;
    var btn = $('wake-toggle');
    if (btn) { btn.disabled = true; btn.textContent = on ? '暂停中…' : '开启中…'; }
    try {
      if (on && S.rec.active) await stopRecording();
      var r = await api('POST', on ? '/api/v2/voice/stop' : '/api/v2/voice/start', {});
      if (r.ok) toast(on ? '已暂停唤醒监听' : '已开启唤醒监听', 'ok');
      else toast('语音开关失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');
      if (r.data && r.data.status) S.status = r.data.status;
    } catch (e) { toast('语音开关失败：' + e.message, 'bad'); }
    if (btn) btn.disabled = false;
    await refreshStatus();
  }

  /* ---------------- V6 录音面板 / 最近说过（修 bug：点击录音必须可见、可看实时文字） ---------------- */
  S.rec = { active: false, busy: false, polling: null, startedAt: 0, live: '' };
  S.talk = S.talk || [];

  function fmtClock(ts) {
    try { var d = ts ? new Date(ts) : new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
    catch (e) { return ''; }
  }
  function renderTalk() {
    var box = $('talk-log'); if (!box) return;
    var items = S.talk.slice(0, 20);
    if (!items.length) { box.innerHTML = '<li class="empty">还没有记录：点「开始录音」说一句，或直接输入命令</li>'; }
    else {
      box.innerHTML = items.map(function (it) {
        return '<li><span class="t">' + esc(fmtClock(it.at)) + '</span><span class="k">' + esc(it.kind || '语音') + '</span><span class="x">' + esc(it.text || '') + '</span></li>';
      }).join('');
    }
    var c = $('talk-count'); if (c) c.textContent = items.length ? ('共 ' + items.length + ' 条') : '';
  }
  function addTalk(text, meta) {
    var t = String(text || '').trim();
    if (!t) return;
    var it = { text: t, at: (meta && meta.at) || new Date().toISOString(), kind: (meta && meta.kind) || '语音' };
    if (S.talk.length && S.talk[0].text === it.text && S.talk[0].kind === it.kind) return;
    S.talk.unshift(it);
    if (S.talk.length > 30) S.talk.length = 30;
    renderTalk();
  }
  async function loadTalkHistory() {
    try {
      var r = await softApi('GET', '/api/v2/voice/transcripts?limit=12');
      var items = (r.data && (r.data.items || r.data.transcripts)) || [];
      items.slice().reverse().forEach(function (it) {
        if (it && it.text && it.source !== 'ambient') addTalk(it.text, { at: it.at, kind: it.source === 'mic' ? '语音' : '输入' });
      });
    } catch (e) { /* ignore */ }
    renderTalk();
  }
  function setRecUI(on, statusText, liveText) {
    var panel = $('rec-panel'); var btn = $('btn-record'); var st = $('rec-status'); var lv = $('rec-live'); var tm = $('rec-timer');
    if (panel) panel.classList.toggle('hidden', !on);
    if (st) st.textContent = statusText || (on ? '正在录音…请说话' : '');
    if (lv && liveText !== undefined) { S.rec.live = liveText; lv.textContent = liveText || ''; }
    if (btn) { btn.textContent = on ? '停止录音' : '开始录音'; btn.classList.toggle('danger', !!on); }
    var orb = $('mic-orb'); if (orb) orb.classList.toggle('listening', !!on);
    if (tm) {
      if (on) {
        var tick = function () {
          if (!S.rec.active) { tm.textContent = ''; return; }
          var sec = Math.max(0, Math.round((Date.now() - S.rec.startedAt) / 1000));
          tm.textContent = sec + 's';
          $('rec-timer')._t = setTimeout(tick, 500);
        };
        tick();
      } else { tm.textContent = ''; }
    }
  }
  function recPollStop() { if (S.rec.polling) { clearInterval(S.rec.polling); S.rec.polling = null; } }
  function recPollStart() {
    recPollStop();
    S.rec.polling = setInterval(async function () {
      if (!S.rec.active) { recPollStop(); return; }
      try {
        var r = await api('GET', '/api/v2/voice/status'); var d = r.data || {};
        var lt = d.lastTranscript;
        if (lt && lt.source === 'mic' && lt.text) {
          setRecUI(true, '正在录音…请说话', titleLive(lt.text));
        }
        if (d.lastReply && d.lastReply.at && Date.parse(d.lastReply.at) >= S.rec.startedAt - 800) {
          if (S.rec.active) {
            setRecUI(true, '已执行：' + (d.lastReply.text || '').slice(0, 40));
            addTalk(d.lastReply.text || '', { kind: '执行', at: d.lastReply.at });
          }
        }
      } catch (e) { /* ignore */ }
    }, 900);
  }
  function titleLive(t) { return '听到：' + String(t || '').slice(-60); }
  async function startRecording() {
    if (S.rec.active || S.rec.busy) return;
    S.rec.busy = true;
    S.rec.startedAt = Date.now();
    setRecUI(true, '正在启动录音…（等引擎就绪）', '');
    try {
      var r = await api('POST', '/api/v2/voice/quick/start', {});
      if (r.ok && (r.data || {}).ok !== false) {
        S.rec.active = true;
        setRecUI(true, '正在录音…请说话（说完点停止）', '');
        setCaption('', '');
        recPollStart();
      } else {
        var err = (r.data && r.data.error) || ('HTTP ' + r.status);
        setRecUI(true, '启动失败：' + err, '');
        setTimeout(function () { if (!S.rec.active) setRecUI(false); }, 4000);
      }
    } catch (e) { setRecUI(true, '启动失败：' + e.message, ''); }
    finally { S.rec.busy = false; }
  }
  async function stopRecording() {
    if (!S.rec.active && !S.rec.busy) return;
    S.rec.active = false;
    recPollStop();
    setRecUI(false, '', '');
    try { await api('POST', '/api/v2/voice/quick/stop', {}); } catch (e) { /* ignore */ }
    if (S.rec.live) addTalk(S.rec.live.replace(/^听到：/, ''), { kind: '语音' });
    S.rec.live = '';
  }
  function toggleRecording() { if (S.rec.active) stopRecording(); else startRecording(); }

  /* ---------------- 24 小时录音（独立页：只留痕、不执行） ---------------- */
  function ambientEnabled() {
    return !(S.status && S.status.ambient && S.status.ambient.enabled === false);
  }
  function renderAmbientToggle() {
    var on = ambientEnabled();
    var sw = $('ambient-switch'); if (sw) sw.classList.toggle('off', !on);
    var title = $('ambient-toggle-title'); if (title) title.textContent = '24h 录音：' + (on ? '开' : '关');
    var btn = $('ambient-toggle');
    if (btn && !btn.disabled) {
      btn.textContent = on ? '关闭 24h 录音' : '开启 24h 录音';
      btn.classList.toggle('primary', !on);
      btn.classList.toggle('ghost', on);
    }
    var ico = $('ambient-toggle-ico'); if (ico) ico.style.opacity = on ? '1' : '.45';
    var state = $('ambient-state');
    if (state) state.textContent = on ? '正在后台记录（只留痕，不执行命令）' : '已关闭（不再新增全天记录）';
    var homeChip = $('home-ambient-state');
    if (homeChip) { homeChip.textContent = on ? '已开启' : '已关闭'; homeChip.classList.toggle('warn', !on); }
  }
  async function setAmbient(on) {
    on = !!on;
    var btn = $('ambient-toggle');
    if (btn) { btn.disabled = true; btn.textContent = on ? '开启中…' : '关闭中…'; }
    var r = await api('PATCH', '/api/v2/voice/config', { ambient: { enabled: on } });
    if (r.ok) {
      S.status = S.status || {};
      S.status.ambient = S.status.ambient || {};
      S.status.ambient.enabled = on;
      renderAmbientToggle();
      toast(on ? '已开启 24 小时录音（后台持续留痕）' : '已关闭 24 小时录音（唤醒功能不受影响）', 'ok');
      setTimeout(refreshStatus, 900);
    } else {
      toast('切换失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'bad');
    }
    if (btn) btn.disabled = false;
    renderAmbientToggle();
  }
  function toggleAmbient(force) {
    var target = typeof force === 'boolean' ? force : !ambientEnabled();
    return setAmbient(target);
  }
  async function loadAmbientRecords() {
    var box = $('ambient-list'); if (!box) return;
    try {
      var r = await softApi('GET', '/api/v2/voice/transcripts?limit=100');
      var items = (r.data && (r.data.items || r.data.transcripts)) || [];
      var amb = items.filter(function (it) { return it && (it.source === 'ambient'); });
      var c = $('ambient-count'); if (c) c.textContent = String(amb.length);
      if (!amb.length) {
        box.innerHTML = '<li class="empty">暂无全天记录：开启「24h 录音」并保持 App 打开，平时说话会自动留痕（只记录、不执行命令）</li>';
        return;
      }
      box.innerHTML = amb.slice(0, 80).map(function (it) {
        return '<li><span class="t">' + esc(fmtClock(it.at)) + '</span><span class="k">24h</span><span class="x">' + esc(it.text || '') + '</span></li>';
      }).join('');
    } catch (e) { box.innerHTML = '<li class="empty">加载失败：' + esc(e.message) + '</li>'; }
  }

  /* ---------------- 电脑屏幕内容记录 + 今日总结（24h 页） ---------------- */
  function screenSnippet(t) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 90); }
  async function loadScreenRecords() {
    var box = $('screen-list'); if (!box) return;
    try {
      var r = await softApi('GET', '/api/v2/voice/screen?limit=30');
      var items = (r.data && (r.data.items || r.data.records)) || [];
      var cnt = $('screen-count'); if (cnt) cnt.textContent = String((r.data && r.data.total) || items.length);
      if (!items.length) { box.innerHTML = '<li class="empty">暂无屏幕记录：电脑端开启「屏幕采集」后，你看过/操作过的屏幕文字会自动记录在这里</li>'; return; }
      box.innerHTML = items.map(function (it) {
        var app = it.app || it.application || '';
        var title = it.title || it.window || '';
        var txt = screenSnippet(it.text || it.snippet || '');
        var head = [app, title].filter(Boolean).join(' · ') || '屏幕';
        return '<li><span class="t">' + esc(fmtClock(it.at || it.createdAt)) + '</span><span class="k">🖥</span><span class="x"><b>' + esc(head) + '</b> ' + esc(txt) + '</span></li>';
      }).join('');
    } catch (e) { box.innerHTML = '<li class="empty">加载失败：' + esc(e.message) + '</li>'; }
  }
  async function loadTodaySummary() {
    var st = $('summary-status'); if (!st) return;
    try {
      var r = await softApi('GET', '/api/v2/documents?limit=20');
      var items = (r.data && (r.data.items || r.data.documents)) || [];
      var today = todayKey();
      var doc = items.find(function (d) { return d && (d.kind === 'daily' || d.kind === 'note-summary') && String(d.date || d.createdAt || '').slice(0, 10) === today; }) || items[0];
      if (doc) st.textContent = '已生成 · ' + (doc.title || '今日总结') + '（' + (doc.provider || '') + '，可去文档页下载 MD/DOCX/PDF）';
      else st.textContent = '还没有今日总结，可以点「生成今日总结」';
    } catch (e) { st.textContent = '检查失败：' + e.message; }
  }
  function bindAmbientExtras() {
    if ($('screen-refresh')) $('screen-refresh').onclick = loadScreenRecords;
    if ($('summary-open')) $('summary-open').onclick = function () { switchTab('documents'); };
    if ($('summary-gen')) $('summary-gen').onclick = function () { switchTab('documents'); if (typeof generateDaily === 'function') generateDaily(); };
  }

  /* ---------------- 事件绑定 / 初始化 ---------------- */
  function bindEvents() {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.onclick = function () { switchTab(b.getAttribute('data-tab')); }; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) { b.onclick = function () { switchTab(b.getAttribute('data-goto')); }; });
    if ($('btn-settings')) $('btn-settings').onclick = function () { switchTab('settings'); };
    /* 顶栏 24h chip：只跳转「24 小时录音记录」页，不再在头栏直接切换开关 */
    if ($('chip-ambient')) {
      $('chip-ambient').onclick = function () { switchTab('ambient'); };
      $('chip-ambient').onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchTab('ambient'); } };
    }
    if ($('wake-toggle')) $('wake-toggle').onclick = toggleWakeListen;
    if ($('ambient-toggle')) $('ambient-toggle').onclick = function () { toggleAmbient(); };
    if ($('ambient-refresh')) $('ambient-refresh').onclick = function () { refreshStatus(); loadAmbientRecords(); };
    if ($('mic-orb')) $('mic-orb').onclick = toggleRecording;
    if ($('btn-record')) $('btn-record').onclick = toggleRecording;
    if ($('rec-stop')) $('rec-stop').onclick = stopRecording;
    if ($('cmd-send')) $('cmd-send').onclick = function () { var v = $('cmd-input') ? $('cmd-input').value : ''; if ($('cmd-input')) $('cmd-input').value = ''; sendCommand(v); };
    if ($('cmd-input')) $('cmd-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var v = $('cmd-input').value; $('cmd-input').value = ''; sendCommand(v); }
      if (e.key === 'Escape' && S.composeMode) { S.composeMode = ''; var h = $('compose-hint'); if (h) h.textContent = ''; }
    });
    Array.prototype.forEach.call(document.querySelectorAll('.quick button[data-cmd]'), function (b) { b.onclick = function () { sendCommand(b.getAttribute('data-cmd')); }; });
    Array.prototype.forEach.call(document.querySelectorAll('.quick button[data-quick]'), function (b) { b.onclick = function () { runQuick(b.getAttribute('data-quick')); }; });
    /* 首页看板 */
    if ($('board-reminder')) $('board-reminder').onclick = function () { switchTab('reminders'); };
    if ($('board-notes')) $('board-notes').onclick = function () { switchTab('records'); };
    if ($('board-screen')) $('board-screen').onclick = function () { switchTab('documents'); };
    if ($('board-summary-gen')) $('board-summary-gen').onclick = function () { switchTab('documents'); generateDaily(); };
    Array.prototype.forEach.call(document.querySelectorAll('#board-summary-downloads [data-dl]'), function (b) {
      b.onclick = function () { var doc = S.board && S.board.dailyDoc; if (!doc) { toast('还没有今日总结文档', 'warn'); return; } downloadDoc(doc.id, b.getAttribute('data-dl')); };
    });
    /* 记录 */
    if ($('records-refresh')) $('records-refresh').onclick = loadNotes;
    if ($('records-all')) $('records-all').onclick = function () { if ($('records-date')) $('records-date').value = ''; loadNotes(); };
    if ($('records-search')) $('records-search').oninput = debounce(loadNotes, 300);
    if ($('records-date')) $('records-date').onchange = loadNotes;
    if ($('notes-summarize')) $('notes-summarize').onclick = function () { summarizeNotes($('records-date') && $('records-date').value || todayKey()); };
    /* 提醒 */
    if ($('reminders-refresh')) $('reminders-refresh').onclick = loadReminders;
    if ($('reminder-create')) $('reminder-create').onclick = createReminder;
    if ($('reminder-quick')) $('reminder-quick').onclick = function () {
      var d = new Date(Date.now() + 60 * 1000);
      if ($('reminder-at')) $('reminder-at').value = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    };
    /* 文档 */
    if ($('documents-refresh')) $('documents-refresh').onclick = loadDocuments;
    if ($('documents-regenerate')) $('documents-regenerate').onclick = generateDaily;
    /* 设置 */
    if ($('set-load')) $('set-load').onclick = function () { if ($('set-token')) setToken($('set-token').value.trim()); fillSettings(); };
    if ($('set-save')) $('set-save').onclick = saveSettings;
    if ($('set-diag')) $('set-diag').onclick = async function () {
      var st = await softApi('GET', '/api/v2/voice/status');
      var ag = await softApi('GET', '/api/v2/agent/status');
      setMsg('语音 worker：' + JSON.stringify((st.data && st.data.workers) || {}) + '\n执行器：' + ((ag.data && ag.data.provider) || '?') + ' / 模型 ' + ((ag.data && ag.data.model) || '?'));
    };
    /* IoT */
    if ($('iot-ha-save')) $('iot-ha-save').onclick = function () { saveIot('ha'); };
    if ($('iot-ha-test')) $('iot-ha-test').onclick = testIot;
    if ($('iot-ha-entities')) $('iot-ha-entities').onclick = loadHaEntities;
    if ($('iot-mqtt-save')) $('iot-mqtt-save').onclick = function () { saveIot('mqtt'); };
    if ($('iot-mqtt-test')) $('iot-mqtt-test').onclick = testIot;
    if ($('iot-mqtt-discover')) $('iot-mqtt-discover').onclick = discoverMqtt;
    if ($('iot-ssdp-discover')) $('iot-ssdp-discover').onclick = discoverSsdp;
    if ($('iot-ssdp-import')) $('iot-ssdp-import').onclick = function () { if (!S.iot.discovered.length) { toast('先发现设备', 'warn'); return; } importIot('ssdp', S.iot.discovered.map(function (d) { return d.usn || d.location || d.name; })); };
    /* 旧页 */
    if ($('dev-refresh')) $('dev-refresh').onclick = loadDevices;
    if ($('diary-generate')) $('diary-generate').onclick = async function () {
      var b = this; b.disabled = true; b.textContent = '生成中…';
      await softApi('POST', '/api/v2/voice/diary/generate', { force: true });
      await loadDiary(); b.textContent = '现在总结'; b.disabled = false;
    };
    if ($('today-refresh')) $('today-refresh').onclick = function (e) { e.preventDefault(); loadToday(); };
    bindModalOnce();
  }
  async function init() {
    if (S.inited) return;
    S.inited = true;
    MOCK.build();
    S.token = tok();
  // 桌面 App：令牌轮换/首次启动时从 Electron 安全桥同步中枢令牌（浏览器/手机端走 localStorage 手填）
  try {
    if (window.tenonDesktop && typeof window.tenonDesktop.getToken === 'function') {
      window.tenonDesktop.getToken().then(function (t) {
        if (t && t !== tok()) { setToken(String(t)); refreshStatus(); }
      }).catch(function () {});
    }
  } catch (e) {}
    bindEvents();
    if ($('records-date')) $('records-date').value = todayKey();
    var d = new Date(Date.now() + 30 * 60 * 1000);
    if ($('reminder-at')) $('reminder-at').value = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    await resolveToken();
    try { S.agent = localStorage.getItem(AGENT_KEY) || 'builtin'; } catch (e) {}
    await refreshStatus();
    connectSSE();
    loadBoard();
    /* 定时刷新：提醒 30s（任务要求）；首页看板 30s；记录/文档页 20s 轻刷新 */
    setInterval(function () { if (!document.hidden) { if (S.tab === 'reminders') loadReminders(); else loadBoard(); } }, 30000);
    setInterval(function () { if (!document.hidden && S.tab === 'records') loadNotes(); }, 20000);
    setInterval(function () { if (!document.hidden && S.tab === 'documents') loadDocuments(); }, 20000);
    setInterval(function () { if (!document.hidden && S.tab === 'ambient') loadAmbientRecords(); }, 20000);
    setInterval(function () { if (!document.hidden) refreshStatus(); }, 3000);
    loadTalkHistory();
    renderTalk();
    renderWakeListen(S.status);
    renderAmbientToggle();
    loadAmbientRecords();
    bindAmbientExtras();
    loadScreenRecords();
    loadTodaySummary();
    window.__tenonV5 = {
      state: S, mock: MOCK, switchTab: switchTab,
      refresh: function () { loadBoard(); if (S.tab === 'records') loadNotes(); if (S.tab === 'reminders') loadReminders(); if (S.tab === 'documents') loadDocuments(); if (S.tab === 'ambient') loadAmbientRecords(); },
      api: api, toast: toast,
      loadAmbientRecords: loadAmbientRecords, refreshStatus: refreshStatus,
      toggleAmbient: toggleAmbient, toggleWakeListen: toggleWakeListen,
      startRecording: startRecording, stopRecording: stopRecording
    };
  }
  async function resolveToken() {
    if (tok()) { S.token = tok(); return; }
    try { if (window.tenonDesktop && window.tenonDesktop.getToken) { var t = await window.tenonDesktop.getToken(); if (t) { setToken(t); return; } } } catch (e) {}
    S.token = '';
  }
  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState !== 'loading') init();
})();
