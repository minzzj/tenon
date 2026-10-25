import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { newId } from './ledger.js';
import { replay, snapshot, impact, relations, recentCalls } from './state.js';
import {
  listCapabilities, createDraft, confirmTask, rejectTask, cancelTask, retryTask,
  executeHubTask, deliverReceipt, wouldCycle, downgradeTasks,
} from './tasks.js';
import { createChannels } from './channels.js';
import { runCheckup } from './checkup.js';
import { createV2 } from './v2/index.js';

const HUB_CAPS = new Set(['channel.notify', 'llm.summarize']);

// P0 修复：只读实例只放行「不写账本」的纯读接口；其余 /api/* 一律 423（含节点接口与 GET 写路径）。
const READ_ONLY_GET = new Set(['/api/state', '/api/stream', '/api/messages', '/api/impact']);
const READ_ONLY_POST = new Set(['/api/auth', '/api/logout']);
function readOnlyAllowed(method, pathname) {
  if (method === 'GET' && READ_ONLY_GET.has(pathname)) return true;
  if (method === 'GET' && /^\/api\/checkup\/[^/]+\/export$/.test(pathname)) return true;
  if (method === 'POST' && READ_ONLY_POST.has(pathname)) return true;
  if (method === 'GET' && pathname.startsWith('/api/v2/')) return true;
  return false;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.apk': 'application/vnd.android.package-archive',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function send(res, code, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function parseCookie(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req, limit = 1048576) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

export async function createHttpServer({ root, ledger, state, ai, secret, mode, readOnly, version = '0.1.0', onShutdown, dataDir }) {
  const channels = createChannels({ ledger, state });
  const clients = new Set();
  const scheduled = new Set();
  const liveSeen = new Map();
  const persistedBeat = new Map();
  const aiDefault = ai.available;
  let offline = false;

  const pub = path.join(root, 'public');

  function schedule(key, fn) {
    if (scheduled.has(key)) return;
    scheduled.add(key);
    setTimeout(() => {
      scheduled.delete(key);
      try {
        fn();
      } catch {
        /* follow-up failures must not crash the hub */
      }
    }, 80);
  }

  ledger.subscribe((ev) => {
    for (const res of clients) {
      try {
        res.write('data: ' + JSON.stringify(ev) + '\n\n');
      } catch {
        clients.delete(res);
      }
    }
    const d = ev.data || {};
    if (['task.succeeded', 'task.failed', 'task.timeout'].includes(ev.type) && d.taskId) {
      schedule('deliver:' + d.taskId, () => {
        const st = replay(ledger.events);
        deliverReceipt({ ledger, state: st, channels, taskId: d.taskId });
      });
    }
    if (ev.type === 'task.queued' && d.taskId) {
      schedule('hubrun:' + d.taskId, () => {
        const st = replay(ledger.events);
        const t = st.tasks[d.taskId];
        if (t && HUB_CAPS.has(t.capabilityId) && t.status === 'queued') {
          executeHubTask({ ledger, state: st, ai, channels, taskId: d.taskId });
        }
      });
    }
  });

  function buildSnapshot() {
    const st = replay(ledger.events);
    const now = Date.now();
    const nodes = Object.values(st.nodes).map((n) => ({
      ...n,
      online: n.id === 'hub'
        ? true
        : n.kind === 'node'
          ? (liveSeen.has(n.id) ? now - liveSeen.get(n.id) < 8000 : !!(n.online && n.lastSeen && now - new Date(n.lastSeen).getTime() < 8000))
          : !!n.online,
    }));
    const rels = relations(st);
    const caps = listCapabilities(st).map((c) => ({
      ...c,
      recentCalls: recentCalls(st, c.id, 3),
      usageTasks: rels.filter((r) => r.capabilityId === c.id).map((r) => ({ taskId: r.taskId, status: r.task.status, updatedAt: r.task.updatedAt })).slice(0, 20),
    }));
    return snapshot(st, {
      nodes,
      capabilities: caps,
      readOnly,
      version,
      ai: { available: ai.available, model: ai.model, offline },
      integrity: ledger.integrity(),
      serverNow: new Date().toISOString(),
    });
  }

  function tokenOf(req) {
    const h = req.headers['x-tenon-token'];
    if (h) return String(h);
    return parseCookie(req.headers.cookie || '').tenon_token || '';
  }

  const authed = (req) => tokenOf(req) === secret.operatorToken;
  const v2 = await createV2({ root, ledger, state, ai, secret, readOnly, dataDir: dataDir || path.join(root, 'data'), authed });

  function serveFile(res, rel) {
    const full = path.resolve(pub, rel);
    if (!full.startsWith(pub + path.sep) && full !== pub) return send(res, 403, 'forbidden');
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, 'Not found');
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    send(res, 200, fs.readFileSync(full), type);
  }

  function receiptPage(req, res, taskId) {
    const st = replay(ledger.events);
    const t = st.tasks[taskId];
    if (!t) return send(res, 404, '回执不存在', 'text/html; charset=utf-8');
    const head = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>榫卯 · 回执</title><style>body{background:#070B14;color:#E9F1FA;font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:24px;line-height:1.7}.card{max-width:760px;margin:0 auto;background:#0d1524;border:1px solid #1d2a3d;border-radius:14px;padding:22px}h1{font-size:20px;color:#66E3D2}li{color:#8FA3BD}small{color:#5f7592}code{color:#FFB45C}</style>';
    if (!authed(req)) {
      return send(res, 200, head + '<div class="card"><h1>需要登录查看正文</h1><p>消息里只带摘要与链接，正文与文件不出内网。请输入操作令牌：</p><p><input id="t" placeholder="操作令牌" style="width:70%;padding:10px;background:#070B14;color:#E9F1FA;border:1px solid #1d2a3d;border-radius:8px"> <button id="go" style="padding:10px 16px;border-radius:8px;border:0;background:#66E3D2;color:#04131a;font-weight:700">登录</button></p><p><small>令牌在启动器中打印，或见 data/secrets.json。</small></p><div id="err" style="color:#FFB45C"></div></div><script>document.getElementById("go").onclick=async()=>{const r=await fetch("/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:document.getElementById("t").value})});if(r.ok){location.reload()}else{document.getElementById("err").textContent="令牌不正确"}};</script></html>', 'text/html; charset=utf-8');
    }
    const steps = (t.steps || []).map((s) => `<li><b>${esc(s.label)}</b> <small>${esc(s.at)}</small><br>${esc(s.detail)}</li>`).join('');
    return send(res, 200, head + `<div class="card"><h1>回执 · ${esc(t.text)}</h1><p>状态：<code>${esc(t.status)}</code>　任务：<code>${esc(t.id)}</code></p><p>摘要：${esc((t.result && t.result.summary) || t.delivery && t.delivery.summary || '（无摘要）')}</p><h1 style="font-size:16px">时间线（每一步都有证据）</h1><ul>${steps}</ul><p><small>链接需登录查看正文；消息通道只发摘要与链接。</small></p></div></html>`, 'text/html; charset=utf-8');
  }

  async function handleNode(req, res, u, pathname) {
    if (String(req.headers['x-tenon-node'] || '') !== secret.nodeToken) return json(res, 401, { error: '节点令牌无效' });
    if (pathname === '/api/node/register' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.nodeId) return json(res, 400, { error: 'nodeId required' });
      const st = replay(ledger.events);
      ledger.append('node.registered', {
        nodeId: b.nodeId,
        name: b.name || (st.nodes[b.nodeId] && st.nodes[b.nodeId].name) || b.nodeId,
        platform: b.platform || 'unknown',
        fingerprint: b.fingerprint || '',
        capabilities: Array.isArray(b.capabilities) ? b.capabilities : (st.nodes[b.nodeId] ? st.nodes[b.nodeId].capabilities : []),
        domain: b.domain || st.meta.domain,
      }, 'node:' + b.nodeId);
      liveSeen.set(b.nodeId, Date.now());
      persistedBeat.set(b.nodeId, Date.now());
      return json(res, 200, { ok: true, nodeId: b.nodeId, hubTime: new Date().toISOString() });
    }
    if (pathname === '/api/node/heartbeat' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.nodeId) return json(res, 400, { error: 'nodeId required' });
      const nowMs = Date.now();
      liveSeen.set(b.nodeId, nowMs);
      const lastPersisted = persistedBeat.get(b.nodeId) || 0;
      if (nowMs - lastPersisted > 60000) {
        persistedBeat.set(b.nodeId, nowMs);
        ledger.append('node.heartbeat', { nodeId: b.nodeId, at: b.at || new Date().toISOString() }, 'node:' + b.nodeId);
      }
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/node/pull' && req.method === 'GET') {
      const nodeId = u.searchParams.get('nodeId');
      const st = replay(ledger.events);
      const node = st.nodes[nodeId];
      const tasks = Object.values(st.tasks).filter((t) => t.status === 'queued' && t.nodeId === nodeId && !HUB_CAPS.has(t.capabilityId)).slice(0, 3);
      for (const t of tasks) ledger.append('task.started', { taskId: t.id, nodeId, nodeName: node ? node.name : nodeId }, 'node:' + nodeId);
      return json(res, 200, {
        ok: true,
        tasks: tasks.map((t) => ({
          id: t.id,
          taskId: t.id,
          capabilityId: t.capabilityId,
          params: (t.draft && t.draft.params) || {},
          text: t.text,
          draft: t.draft,
        })),
      });
    }
    if (pathname === '/api/node/event' && req.method === 'POST') {
      const b = await readBody(req);
      const type = b.type;
      const data = b.data || {};
      const allowed = ['task.step', 'task.succeeded', 'task.failed', 'task.cancelled', 'task.timeout'];
      if (!allowed.includes(type)) return json(res, 400, { error: '不支持的事件类型' });
      if (!data.taskId) return json(res, 400, { error: 'taskId required' });
      const st = replay(ledger.events);
      if (!st.tasks[data.taskId]) return json(res, 404, { error: '任务不存在' });
      ledger.append(type, data, 'node:' + (data.nodeId || ''));
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: '未知节点接口' });
  }

  async function drill(kind, body) {
    const st = replay(ledger.events);
    if (kind === 'offline') {
      const on = body.on !== false;
      offline = on;
      ai.available = on ? false : aiDefault;
      if (on) {
        channels.disable('wechat-mock', '断网演练：外网关闭');
        channels.disable('email-mock', '断网演练：外网关闭');
        ledger.append('system.degraded', { mode: 'offline-drill', reason: '外网关闭，本机与局域网功能不减，审计连续' });
      } else {
        channels.enable('wechat-mock');
        channels.enable('email-mock');
      }
      ledger.append('drill.ran', { kind: 'offline', detail: on ? '已切断外联（演练）：AI 降级为规则、外部通道停用，站内与审计不受影响' : '外联已恢复' });
      return on ? '断网演练已开启：本地功能可用、审计连续' : '外联已恢复';
    }
    if (kind === 'rate-limit') {
      channels.forceLimit();
      ledger.append('drill.ran', { kind, detail: '微信通道已打满，下一条回执将出现「微信限流，已改邮件，延迟约 10 分钟」' });
      return '已触发通道限流演练';
    }
    if (kind === 'auth-expired') {
      const node = Object.values(st.nodes).find((n) => (n.capabilities || []).some((c) => c.id === 'printer.mock'));
      if (!node) throw new Error('未找到打印服务器设备');
      ledger.append('capability.authExpired', { nodeId: node.id, capabilityId: 'printer.mock' });
      ledger.append('drill.ran', { kind, detail: '授权已于 3 天前到期，任务已暂停' });
      return '已模拟授权过期';
    }
    if (kind === 'version-mismatch') {
      const node = Object.values(st.nodes).find((n) => (n.capabilities || []).some((c) => c.id === 'llm.summarize'));
      if (!node) throw new Error('未找到本地模型设备');
      ledger.append('capability.versionMismatch', { nodeId: node.id, capabilityId: 'llm.summarize', required: '2.3', current: '2.1' });
      ledger.append('drill.ran', { kind, detail: '需要 2.3 以上，当前 2.1' });
      return '已模拟版本不兼容';
    }
    if (kind === 'loop') {
      if (wouldCycle([['A', 'B'], ['B', 'C']], 'C', 'A')) {
        ledger.append('loop.blocked', { chain: 'A→B→C→A', message: 'A→B→A，已阻止' });
        ledger.append('drill.ran', { kind, detail: '循环依赖已阻止' });
        return '循环任务已阻止：A→B→A';
      }
      throw new Error('未检测到循环');
    }
    if (kind === 'disk-full') {
      ledger.append('system.diskFull', { full: true });
      ledger.append('drill.ran', { kind, detail: '空间不足，摘要暂停，事件已保留' });
      return '已模拟磁盘满';
    }
    if (kind === 'cross-domain') {
      const node = Object.values(st.nodes).find((n) => n.domain === 'outside' || /NAS/i.test(n.name || ''));
      if (!node) throw new Error('未找到 NAS 设备');
      ledger.append('device.movedOutOfDomain', { nodeId: node.id });
      ledger.append('drill.ran', { kind, detail: '已离开数据域，仅可查看' });
      return '设备已离开数据域';
    }
    if (kind === 'unknown-evidence') {
      const id = newId('dev');
      ledger.append('device.imported', {
        nodeId: id,
        name: '未知设备-2F1A',
        platform: 'unknown',
        fingerprint: '',
        evidence: 'none',
        capabilities: [{ id: 'unknown.cap', name: '未登记能力', risk: 'unknown' }],
      });
      ledger.append('drill.ran', { kind, detail: '已加入一台无证据设备' });
      return '已加入无证据设备（卡片显示「无记录」）';
    }
    if (kind === 'role') {
      ledger.append('role.insufficient', { need: 'admin', message: '只读：需要管理员角色' });
      ledger.append('drill.ran', { kind, detail: '当前角色只读' });
      return '只读：需要管理员角色';
    }
    if (kind === 'restore') {
      offline = false;
      ai.available = aiDefault;
      channels.enable('wechat-mock');
      channels.enable('email-mock');
      ledger.append('system.degraded', { mode: 'normal', reason: '演练已恢复：外联与 AI 正常' });
      ledger.append('system.diskFull', { full: false });
      ledger.append('drill.ran', { kind, detail: '演练状态已恢复' });
      return '演练状态已恢复';
    }
    throw new Error('未知演练：' + kind);
  }

  async function handleApi(req, res, u, pathname) {
    const method = req.method;
    // P0 修复：只读实例必须在鉴权与路由分发之前统一拦截。此前 /api/node/* 在 readOnly 判断之前分发、
    // GET /api/audit/export 会 append audit.exported，导致第二实例也能写账本、写坏哈希链。
    if (readOnly && !readOnlyAllowed(method, pathname)) {
      return json(res, 423, { error: '另一窗口为只读' });
    }
    if (pathname === '/api/state' && method === 'GET') return json(res, 200, buildSnapshot());
    if (pathname === '/api/stream' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
    if (pathname === '/api/auth' && method === 'POST') {
      const b = await readBody(req);
      if (String(b.token || '') !== secret.operatorToken) return json(res, 401, { error: '令牌不正确' });
      res.setHeader('Set-Cookie', 'tenon_token=' + encodeURIComponent(secret.operatorToken) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800');
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/logout' && method === 'POST') {
      res.setHeader('Set-Cookie', 'tenon_token=; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (pathname.startsWith('/api/v2/')) {
      if (readOnly && method !== 'GET') return json(res, 423, { error: '另一窗口为只读' });
      // link 模块内部自带鉴权（operatorToken / nodeToken / 配对后的 peerToken，含匿名凭配对码配对），
      // 其余 v2 模块仍由这里统一要求 operator token。
      const isLinkModule = pathname.startsWith('/api/v2/link/');
      if (method !== 'GET' && !isLinkModule && !authed(req)) return json(res, 401, { error: '需要登录令牌' });
      return v2.handle(req, res, u, pathname);
    }
    if (pathname === '/api/shutdown' && method === 'POST') {
      // P2 修复：优雅停机——由 start.js 的 shutdown 写 system.stopped、关服务、释放 hub.lock；
      // 不直接 process.exit，避免正常停机被下次启动误判为崩溃恢复。
      if (!authed(req)) return json(res, 401, { error: '需要登录令牌' });
      json(res, 200, { ok: true, detail: '正在优雅停止：写入 system.stopped 并释放锁' });
      setTimeout(() => {
        try {
          if (typeof onShutdown === 'function') onShutdown();
        } catch {
          /* ignore */
        }
      }, 150);
      return undefined;
    }
    if (pathname.startsWith('/api/node/')) return handleNode(req, res, u, pathname);
    if (method !== 'GET' && !authed(req)) return json(res, 401, { error: '需要登录令牌' });

    let m;
    if (pathname === '/api/tasks/draft' && method === 'POST') {
      const b = await readBody(req);
      const text = String(b.text || '').trim();
      if (!text) return json(res, 400, { error: '请先说一句话' });
      const st = replay(ledger.events);
      const r = await createDraft({ ledger, ai, state: st, text, source: b.source === 'phone' ? 'phone' : 'desktop', requester: '你' });
      if (!r.needsConfirm && !r.blocked && !r.manualOnly) {
        ledger.append('task.queued', { taskId: r.taskId, nodeId: r.draft.targetDevice ? r.draft.targetDevice.id : null, note: '可逆动作免确认，直接派发' });
      }
      return json(res, 200, { ok: true, taskId: r.taskId, draft: r.draft, ai: r.ai, needsConfirm: !!r.needsConfirm, blocked: !!r.blocked, manualOnly: !!r.manualOnly });
    }
    if ((m = pathname.match(/^\/api\/tasks\/([^/]+)\/(confirm|reject|cancel|retry|explain)$/)) && method === 'POST') {
      const id = m[1];
      const action = m[2];
      const b = await readBody(req);
      const st = replay(ledger.events);
      try {
        if (action === 'confirm') confirmTask({ ledger, state: st, taskId: id, note: b.note });
        else if (action === 'reject') rejectTask({ ledger, taskId: id, reason: b.reason });
        else if (action === 'cancel') cancelTask({ ledger, state: st, taskId: id });
        else if (action === 'retry') retryTask({ ledger, state: st, taskId: id });
        else {
          const t = st.tasks[id];
          if (!t) return json(res, 404, { error: '任务不存在' });
          const text = [t.text, ...(t.steps || []).map((s) => s.label + ' ' + s.detail)].join(' | ');
          const r = await ai.explain({ text });
          ledger.append('ai.called', { place: 'explain', provider: (r.ai && r.ai.provider) || 'rule', model: ai.model, tokensIn: (r.ai && r.ai.tokensIn) || 0, tokensOut: (r.ai && r.ai.tokensOut) || 0, cached: false, fallback: !!(r.ai && r.ai.fallback) });
          return json(res, 200, { ok: true, ...r });
        }
      } catch (err) {
        return json(res, 400, { error: String((err && err.message) || err) });
      }
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/impact' && method === 'GET') {
      const st = replay(ledger.events);
      const deviceId = u.searchParams.get('deviceId') || '';
      return json(res, 200, impact(st, deviceId));
    }
    if ((m = pathname.match(/^\/api\/devices\/([^/]+)\/(disconnect|hide|rescan)$/)) && method === 'POST') {
      const id = m[1];
      const action = m[2];
      const st = replay(ledger.events);
      if (!st.nodes[id]) return json(res, 404, { error: '设备不存在' });
      let affected = [];
      if (action === 'disconnect') {
        const preview = impact(st, id);
        ledger.append('device.disconnected', { nodeId: id });
        affected = downgradeTasks({ ledger, state: replay(ledger.events), deviceId: id, reason: '设备已断开，任务降级为待确认' });
        ledger.append('drill.ran', { kind: 'disconnect', detail: '断开 ' + id + '：预览 ' + preview.sentence + '，' + affected.length + ' 条任务降级' });
      } else if (action === 'hide') ledger.append('device.hidden', { hidden: true, nodeId: id });
      else ledger.append('drill.ran', { kind: 'rescan', detail: '补扫完成：新增 1 台，更新 ' + Object.keys(st.nodes).length + ' 台' });
      return json(res, 200, { ok: true, affected });
    }
    if (pathname === '/api/checkup/run' && method === 'POST') {
      const b = await readBody(req);
      const st = replay(ledger.events);
      const report = runCheckup({ ledger, state: st, scope: b.scope || 'all', integrity: ledger.integrity(), aiAvailable: ai.available, mode: st.meta.mode });
      return json(res, 200, { ok: true, checkup: report });
    }
    if ((m = pathname.match(/^\/api\/checkup\/([^/]+)\/export$/)) && method === 'GET') {
      const st = replay(ledger.events);
      const c = st.checkups.find((x) => x.id === m[1]);
      if (!c) return json(res, 404, { error: '体检报告不存在' });
      const lines = ['# 上线体检报告', '', `- 时间：${c.at}`, `- 范围：${c.scope}`, `- 结论：${c.summary}`, '', '| 级别 | 标题 | 说明 | 证据 |', '|---|---|---|---|'];
      for (const f of c.findings) lines.push(`| ${f.level} | ${f.title} | ${f.detail} | ${f.evidence} |`);
      if (!c.findings.length) lines.push(`| - | 未发现问题 | 已检查 ${c.checked} 项：${(c.items || []).join('、')} | - |`);
      return send(res, 200, lines.join('\n'), 'text/markdown; charset=utf-8', { 'Content-Disposition': `attachment; filename="checkup-${c.id}.md"` });
    }
    if (pathname === '/api/audit/export' && method === 'GET') {
      // P0 修复：导出动作会 append audit.exported（写账本），必须登录；只读实例已在顶部 423。
      if (!authed(req)) return json(res, 401, { error: '需要登录令牌' });
      const format = u.searchParams.get('format') || 'csv';
      const events = ledger.events;
      ledger.append('audit.exported', { format, count: events.length, by: '你' });
      if (format === 'json') {
        return send(res, 200, JSON.stringify(events, null, 2), 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="tenon-audit.json"' });
      }
      if (format === 'md') {
        const lines = ['# 审计导出', '', `- 事件数：${events.length}`, `- 导出时间：${new Date().toISOString()}`, '', '| seq | 时间 | 类型 | 执行者 | 数据摘要 |', '|---|---|---|---|---|'];
        for (const e of events.slice(-300)) lines.push(`| ${e.seq} | ${e.at} | ${e.type} | ${e.actor} | ${esc(JSON.stringify(e.data).slice(0, 80)).replace(/\|/g, '/')} |`);
        return send(res, 200, lines.join('\n'), 'text/markdown; charset=utf-8', { 'Content-Disposition': 'attachment; filename="tenon-audit.md"' });
      }
      const lines = ['seq,at,type,actor,data'];
      for (const e of events) lines.push([e.seq, e.at, e.type, e.actor, JSON.stringify(e.data).replace(/"/g, '""')].map((x) => `"${x}"`).join(','));
      return send(res, 200, lines.join('\n'), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="tenon-audit.csv"' });
    }
    if (pathname === '/api/messages' && method === 'GET') {
      const st = replay(ledger.events);
      return json(res, 200, { messages: st.messages.slice().reverse() });
    }
    if ((m = pathname.match(/^\/api\/drills\/([^/]+)$/)) && method === 'POST') {
      const b = await readBody(req);
      try {
        const detail = await drill(m[1], b);
        return json(res, 200, { ok: true, detail });
      } catch (err) {
        return json(res, 400, { error: String((err && err.message) || err) });
      }
    }
    return json(res, 404, { error: '未知接口' });
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
      const pathname = decodeURIComponent(u.pathname);
      if (pathname.startsWith('/api/')) return await handleApi(req, res, u, pathname);
      if (pathname === '/' || pathname === '/index.html') return serveFile(res, 'index.html');
      if (pathname === '/m' || pathname === '/m/') return serveFile(res, 'm.html');
      if (pathname === '/m/link') return serveFile(res, 'm-link.html');
      if (pathname === '/m/assets') return serveFile(res, 'm-assets.html');
      if (pathname === '/m/remote') return serveFile(res, 'm-remote.html');
      if (pathname === '/login') return serveFile(res, 'login.html');
      if (pathname.startsWith('/r/')) return receiptPage(req, res, pathname.slice(3));
      return serveFile(res, pathname.replace(/^\/+/, ''));
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: String((err && err.message) || err) });
      else res.end();
    }
  });

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, 15000);
  heartbeat.unref();

  function kick() {
    if (readOnly) return; // P0 修复：只读实例不得触发任何会 append 账本的后台动作（回执/中枢执行）
    const st = replay(ledger.events);
    for (const t of Object.values(st.tasks)) {
      if (t.status === 'queued' && HUB_CAPS.has(t.capabilityId)) schedule('hubrun:' + t.id, () => executeHubTask({ ledger, state: replay(ledger.events), ai, channels, taskId: t.id }));
      if (['succeeded', 'failed', 'timeout'].includes(t.status) && !t.delivery) {
        schedule('deliver:' + t.id, () => deliverReceipt({ ledger, state: replay(ledger.events), channels, taskId: t.id }));
      }
    }
  }

  return { httpServer, kick, channels, v2 };
}