// V5 · 提醒服务：data/reminders/reminders.json + 15s 调度器
// 到点：账本 reminder.fired + SSE reminder + TTS 播报 + node-agent system.notify（未注册优雅降级）
// 挂载：server/lib/v2/index.js 追加 { dir:'reminders', name:'reminders', factory:'createRemindersService' }
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { replay } from '../state.js';
import { createRemindersStore } from './store.js';
import { parseReminder, nextDailyIso } from './parse.js';

const TICK_MS = 15000;
const NODE_ONLINE_MS = 180000;

function nowIso() { return new Date().toISOString(); }
function dayOf(iso) { const d = new Date(iso || Date.now()); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
async function readBody(req, limit = 2 * 1024 * 1024) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) { const e = new Error('请求体过大'); e.statusCode = 413; throw e; } chunks.push(chunk); } return Buffer.concat(chunks); }
async function readJson(req) { const raw = await readBody(req); if (!raw.length) return {}; try { return JSON.parse(raw.toString('utf8')); } catch { const e = new Error('JSON 解析失败'); e.statusCode = 400; throw e; } }
function httpError(status, msg) { const e = new Error(msg); e.statusCode = status; return e; }
function readJsonFile(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

export async function createRemindersService({ root, ledger, dataDir, readOnly = false, authed = () => false, state = null, onEvent = null } = {}) {
  const store = createRemindersStore({ dataDir, ledger });
  const ttsDir = path.join(dataDir, 'reminders', 'tts');
  fs.mkdirSync(ttsDir, { recursive: true });
  const clients = new Set();
  const status = { startedAt: nowIso(), fired: 0, lastFired: null, lastError: null, lastNotify: null, lastTts: null, tickAt: null };

  function currentState() { try { return replay(ledger.events); } catch { return state || { nodes: {}, meta: {} }; } }
  function broadcast(ev) {
    const line = 'data: ' + JSON.stringify(ev) + '\n\n';
    for (const res of Array.from(clients)) { try { res.write(line); } catch { clients.delete(res); } }
    try { if (typeof onEvent === 'function') onEvent(ev); } catch { /* ignore */ }
  }
  function requireWrite(req, ctx) {
    if (readOnly) throw httpError(423, '另一窗口为只读');
    const ok = (ctx && typeof ctx.authed === 'function' && ctx.authed(req)) || (typeof authed === 'function' && authed(req));
    if (!ok) throw httpError(401, '需要登录令牌');
  }

  function voicePlayEnabled() {
    if (String(process.env.TENON_REMINDER_PLAY || '') === '0') return false;
    if (String(process.env.TENON_REMINDER_PLAY || '') === '1') return true;
    const cfg = readJsonFile(path.join(dataDir, 'voice', 'config.json'), null);
    if (cfg && cfg.tts && typeof cfg.tts.play === 'boolean') return cfg.tts.play;
    return true;
  }

  function runPowerShell(args, timeoutMs = 60000) {
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    });
  }

  async function speakReminder(item) {
    const file = path.join(ttsDir, 'reminder-' + item.id + '-' + Date.now() + '.wav');
    const script = path.join(root, 'scripts', 'voice', 'speak.ps1');
    const text = '提醒：' + item.text;
    if (!fs.existsSync(script)) return { ok: false, file: null, error: 'speak.ps1 不存在' };
    const r = await runPowerShell(['-File', script, '-Text', text, '-OutFile', file], 60000);
    const ok = !r.err && fs.existsSync(file) && fs.statSync(file).size > 1000;
    let played = false;
    if (ok && voicePlayEnabled()) {
      try {
        const safe = file.replace(/'/g, "''");
        const child = spawn('powershell.exe', ['-NoProfile', '-Command', "$p=New-Object System.Media.SoundPlayer '" + safe + "'; $p.PlaySync()"], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref(); played = true;
      } catch { played = false; }
    }
    const out = { ok, file: ok ? path.relative(root, file).split(path.sep).join('/') : null, bytes: ok ? fs.statSync(file).size : 0, played, text, voice: 'speak.ps1', error: ok ? null : String((r.err && r.err.message) || r.stderr || 'speak.ps1 失败').slice(0, 200) };
    status.lastTts = { at: nowIso(), ...out };
    return out;
  }

  function findNotifyNode() {
    const st = currentState();
    const nodes = Object.values((st && st.nodes) || {});
    return nodes.find((n) => n && n.id !== 'hub' && !n.disconnected && (n.capabilities || []).some((c) => c && c.id === 'system.notify'))
      && nodes.filter((n) => n && n.id !== 'hub' && !n.disconnected && (n.capabilities || []).some((c) => c && c.id === 'system.notify')).find((n) => n.online || (n.lastSeen && Date.now() - new Date(n.lastSeen).getTime() < NODE_ONLINE_MS)) || null;
  }

  function notifyNode(item) {
    try {
      const node = findNotifyNode();
      if (!node) {
        status.lastNotify = { at: nowIso(), dispatched: false, reason: '没有在线且支持 system.notify 的 node-agent' };
        return status.lastNotify;
      }
      const taskId = 'task_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const draft = { summary: '系统通知：' + item.text, capabilities: [{ id: 'system.notify', name: '系统通知', risk: 'reversible', manualOnly: false, version: '5.0.0' }], targetDevice: { id: node.id, name: node.name || node.id }, params: { title: '榫卯提醒', body: item.text, timeoutMs: 8000 }, risk: { level: 'reversible', reasons: [] }, missing: [] };
      ledger.append('task.drafted', { taskId, text: '提醒通知：' + item.text, draft, requester: 'reminders', source: 'reminder', evidenceLevel: 'none' }, 'reminders');
      ledger.append('task.queued', { taskId, nodeId: node.id, note: '提醒到点，通知 node-agent 弹窗' }, 'reminders');
      status.lastNotify = { at: nowIso(), dispatched: true, taskId, nodeId: node.id, nodeName: node.name || node.id, method: 'system.notify' };
      return status.lastNotify;
    } catch (err) {
      status.lastNotify = { at: nowIso(), dispatched: false, reason: String((err && err.message) || err).slice(0, 200) };
      return status.lastNotify;
    }
  }

  function fire(item) {
    const firedAt = nowIso();
    const today = dayOf(firedAt);
    const tts = null;
    let notify = null;
    try { notify = notifyNode(item); } catch (err) { notify = { dispatched: false, reason: String((err && err.message) || err) }; }
    const data = { id: item.id, text: item.text, at: item.at, recurrence: item.recurrence, firedAt, source: item.source, notify };
    try {
      ledger.append('reminder.fired', data, 'reminders');
    } catch (err) { status.lastError = String((err && err.message) || err); }
    // TTS 稍后补产：先广播提醒事件，再异步生成 WAV 并补写一条 reminder.tts 账本（不阻塞下一次调度）
    broadcast({ type: 'reminder', id: item.id, text: item.text, at: item.at, recurrence: item.recurrence, firedAt, notify, tts: null, ts: Date.now() });
    speakReminder(item).then((ttsInfo) => {
      try {
        status.lastFired = { at: firedAt, id: item.id, text: item.text, tts: ttsInfo, notify };
        ledger.append('reminder.tts', { id: item.id, ok: !!ttsInfo.ok, file: ttsInfo.file, bytes: ttsInfo.bytes, played: !!ttsInfo.played, text: ttsInfo.text, error: ttsInfo.error || null }, 'reminders');
        broadcast({ type: 'reminder_tts', id: item.id, text: item.text, tts: ttsInfo, ts: Date.now() });
      } catch { /* ignore */ }
    }).catch(() => {});
    // 更新下一次/完成
    if (item.recurrence === 'daily') {
      item.firedAt = firedAt;
      item.lastFiredDay = today;
      item.at = nextDailyIso(item.at, new Date());
      item.updatedAt = nowIso();
      store.saveItem(item);
    } else {
      item.firedAt = firedAt;
      item.lastFiredDay = today;
      item.done = true;
      item.enabled = false;
      item.updatedAt = nowIso();
      store.saveItem(item);
    }
    status.fired += 1;
    status.lastFired = { at: firedAt, id: item.id, text: item.text, notify, tts };
    return { id: item.id, firedAt, notify };
  }

  let busy = false;
  async function tick() {
    if (busy) return { ok: true, busy: true, fired: [] };
    busy = true;
    status.tickAt = nowIso();
    const fired = [];
    try {
      store.load();
      const now = Date.now();
      const items = store.list({ status: 'pending' });
      for (const item of items) {
        const atMs = new Date(item.at).getTime();
        if (!Number.isFinite(atMs) || atMs > now) continue;
        if (item.recurrence === 'daily' && item.lastFiredDay === dayOf(now)) continue;
        if (item.recurrence !== 'daily' && item.firedAt) continue;
        try { fired.push(fire(item)); } catch (err) { status.lastError = String((err && err.message) || err); }
      }
      if (fired.length) broadcast({ type: 'tick', fired: fired.map((f) => f.id), at: nowIso() });
    } catch (err) {
      status.lastError = String((err && err.message) || err);
    } finally {
      busy = false;
    }
    return { ok: true, busy: false, fired };
  }

  let timer = null;
  function startScheduler() {
    if (timer) return;
    timer = setInterval(() => { tick().catch((err) => { status.lastError = String((err && err.message) || err); }); }, TICK_MS);
    if (timer.unref) timer.unref();
    setTimeout(() => { tick().catch(() => {}); }, 1200).unref?.();
  }
  function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }
  startScheduler();
  process.once('exit', () => { try { stopScheduler(); } catch { /* ignore */ } });

  function pendingPayload() {
    store.load();
    const list = store.list({ status: 'pending' });
    const now = Date.now();
    return {
      ok: true,
      items: list.map((x) => ({ ...x, dueInMs: new Date(x.at).getTime() - now, overdue: new Date(x.at).getTime() <= now })),
      fired: list.filter((x) => x.firedAt).slice(0, 20),
      now: nowIso(),
    };
  }

  const routes = [
    { method: 'GET', path: '/reminders', handler: async (req, res, ctx) => {
      const u = ctx.url;
      const items = store.list({ status: u.searchParams.get('status') || '' });
      sendJson(res, 200, { ok: true, items: items.map((x) => ({ ...x, dueInMs: new Date(x.at).getTime() - Date.now(), overdue: new Date(x.at).getTime() <= Date.now() && !x.done })), total: items.length, pending: store.list({ status: 'pending' }).length, scheduler: { tickMs: TICK_MS, tickAt: status.tickAt, fired: status.fired, lastError: status.lastError } });
    } },
    { method: 'GET', path: '/reminders/pending', handler: async (req, res) => sendJson(res, 200, pendingPayload()) },
    { method: 'GET', path: '/reminders/stream', handler: async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ type: 'hello', service: 'reminders', now: nowIso() }) + '\n\n');
      clients.add(res);
      const ping = setInterval(() => { try { res.write(': ping ' + Date.now() + '\n\n'); } catch { /* ignore */ } }, 15000);
      if (ping.unref) ping.unref();
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
    } },
    { method: 'POST', path: '/reminders', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      let parsed = null;
      let at = body.at || null;
      let recurrence = body.recurrence === 'daily' ? 'daily' : (body.daily === true ? 'daily' : 'once');
      let text = String(body.text || '').trim();
      if (!at || !text) {
        parsed = parseReminder(body.text || '');
        if (!parsed.ok) { sendJson(res, 400, { ok: false, error: parsed.error, code: 'REMINDER_PARSE_FAILED', parsed }); return; }
        at = at || parsed.at;
        text = text || parsed.text;
        if (body.recurrence === undefined && body.daily === undefined) recurrence = parsed.recurrence;
      }
      if (body.inMinutes && !body.at) at = new Date(Date.now() + Number(body.inMinutes) * 60000).toISOString();
      const atDate = new Date(at);
      if (!Number.isFinite(atDate.getTime())) { sendJson(res, 400, { ok: false, error: '时间不合法（at 需 ISO 或 HH:MM）' }); return; }
      const item = store.create({ text: text || '提醒', at: atDate.toISOString(), recurrence, source: body.source || 'text' });
      broadcast({ type: 'reminder_created', item, ts: Date.now() });
      sendJson(res, 201, { ok: true, item, id: item.id, parsed: parsed ? { human: parsed.human, at: parsed.at, text: parsed.text } : null });
    } },
    { method: 'POST', path: '/reminders/tick', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const r = await tick();
      sendJson(res, 200, { ...r, status: { tickAt: status.tickAt, fired: status.fired, lastError: status.lastError } });
    } },
    { method: 'GET', path: '/reminders/:id', handler: async (req, res, ctx) => {
      const item = store.get(ctx.params.id);
      if (!item) { sendJson(res, 404, { ok: false, error: '提醒不存在', code: 'REMINDER_NOT_FOUND' }); return; }
      sendJson(res, 200, { ok: true, item });
    } },
    { method: 'PATCH', path: '/reminders/:id', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const body = await readJson(req);
      const item = store.update(ctx.params.id, body);
      if (!item) { sendJson(res, 404, { ok: false, error: '提醒不存在', code: 'REMINDER_NOT_FOUND' }); return; }
      sendJson(res, 200, { ok: true, item });
    } },
    { method: 'DELETE', path: '/reminders/:id', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const ok = store.remove(ctx.params.id);
      if (!ok) { sendJson(res, 404, { ok: false, error: '提醒不存在' }); return; }
      broadcast({ type: 'reminder_deleted', id: ctx.params.id, ts: Date.now() });
      sendJson(res, 200, { ok: true, id: ctx.params.id, deleted: true });
    } },
    { method: 'POST', path: '/reminders/:id/done', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const item = store.markDone(ctx.params.id);
      if (!item) { sendJson(res, 404, { ok: false, error: '提醒不存在' }); return; }
      broadcast({ type: 'reminder_done', id: item.id, text: item.text, ts: Date.now() });
      sendJson(res, 200, { ok: true, item, already: !!item.done });
    } },
    { method: 'POST', path: '/reminders/:id/ack', handler: async (req, res, ctx) => {
      requireWrite(req, ctx);
      const item = store.markDone(ctx.params.id);
      if (!item) { sendJson(res, 404, { ok: false, error: '提醒不存在' }); return; }
      sendJson(res, 200, { ok: true, item });
    } },
  ];

  function setDataDir(next) { /* 预留 */ }

  const service = {
    name: 'reminders',
    version: '5.0.0',
    routes,
    store,
    tick,
    status,
    parse: parseReminder,
    startScheduler,
    stopScheduler,
    setDataDir,
    stats: () => ({ pending: store.list({ status: 'pending' }).length, done: store.list({ status: 'done' }).length, fired: status.fired, lastFired: status.lastFired, lastError: status.lastError }),
  };
  return service;
}

export default createRemindersService;