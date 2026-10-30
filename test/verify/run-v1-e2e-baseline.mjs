#!/usr/bin/env node
/**
 * 榫卯 Tenon · 真实浏览器 E2E（零 npm 依赖，Node >= 22）
 *
 * 用 CDP 驱动本机真实 Chrome/Edge：真实导航、真实鼠标点击、真实键盘输入、真实截图。
 * 默认自启动一套隔离实例（端口 7411 + 临时数据目录 data-e2e），跑完清理；
 * 也可复用已在运行的实例。
 *
 * 用法：
 *   node test/e2e/run-real-browser.js             自启动隔离实例并测试
 *   node test/e2e/run-real-browser.js --no-start  复用已运行实例（TENON_E2E_BASE，默认 7410）
 *   node test/e2e/run-real-browser.js --keep      保留临时数据/浏览器，便于排查
 * 环境变量：CHROME_PATH（可选）、TENON_E2E_BASE、TENON_E2E_PORT
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashOf } from '../../server/lib/ledger.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const NO_START = argv.includes('--no-start');
const KEEP = argv.includes('--keep');
const PORT = Number(process.env.TENON_E2E_PORT || 7411);
const BASE = (process.env.TENON_E2E_BASE || (NO_START ? 'http://127.0.0.1:7410' : 'http://127.0.0.1:' + PORT)).replace(/\/$/, '');
// P0 回归用：同一 data-e2e 目录的第二个实例，应自动只读并拒写（端口避开 7410/7411）
const RO_PORT = Number(process.env.TENON_E2E_RO_PORT || PORT + 1);
const RO_BASE = 'http://127.0.0.1:' + RO_PORT;
const DATA_DIR = path.join(ROOT, 'data-e2e');
const EVIDENCE_DIR = path.join(ROOT, '_internal', 'checker', 'e2e-baseline');
const SHOT_DIR = path.join(EVIDENCE_DIR, 'e2e-screenshots');
const STAMP = new Date().toISOString().replace('T', ' ').slice(0, 19);
const FILE_STAMP = STAMP.replace(/[: ]/g, '-');

const results = [];
const children = [];
const pages = [];
let chrome = null;
let chromePort = 0;
let nodeAgentProc = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log('[e2e] ' + m);
function fail(msg) { throw new Error(msg); }
function assert(cond, msg) { if (!cond) fail(msg); }
async function waitFor(fn, timeout = 15000, interval = 250, label = '条件') {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(interval);
  }
  fail('等待超时：' + label + (last ? '（' + last.message + '）' : ''));
}
async function httpJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url + ' -> ' + text.slice(0, 160));
  try { return JSON.parse(text); } catch { return text; }
}
function killTree(proc) {
  if (!proc || !proc.pid) return;
  try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }
}

function readToken() {
  const dir = NO_START ? path.join(ROOT, 'data') : DATA_DIR;
  const file = path.join(dir, 'secrets.json');
  if (!fs.existsSync(file)) fail('找不到 ' + file + '：请先启动中枢（node server/start.js）');
  return JSON.parse(fs.readFileSync(file, 'utf8')).operatorToken;
}

function startServices() {
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const seed = spawnSync(process.execPath, ['scripts/seed-demo.js', '--fresh', '--data-dir', DATA_DIR], { cwd: ROOT, encoding: 'utf8' });
  if (seed.status !== 0) fail('种子数据生成失败：' + (seed.stderr || seed.stdout).slice(-400));
  log('隔离种子数据已生成（' + DATA_DIR + '）');
  const hub = spawn(process.execPath, ['server/start.js'], {
    cwd: ROOT,
    env: { ...process.env, TENON_PORT: String(PORT), TENON_HOST: '127.0.0.1', TENON_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(hub);
  const node = spawn(process.execPath, ['node-agent/agent.js'], {
    cwd: ROOT,
    env: { ...process.env, TENON_HUB_URL: BASE, TENON_DATA_DIR: DATA_DIR, TENON_NODE_ID: 'node-local' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  nodeAgentProc = node;
  children.push(node);
}
function stopServices() {
  for (const c of children) killTree(c);
}
/** 账本行数（只读磁盘）。只读回归用它断言事件数前后不变。 */
function countLedgerEvents(dir) {
  const file = path.join(dir, 'events.jsonl');
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length;
}

/** 起第二个实例（同 DATA_DIR）：start.js 检测到 hub.lock 被活进程持有 → 自动 readOnly。 */
async function startReadOnlyInstance() {
  const ro = spawn(process.execPath, ['server/start.js'], {
    cwd: ROOT,
    env: { ...process.env, TENON_PORT: String(RO_PORT), TENON_HOST: '127.0.0.1', TENON_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(ro);
  await waitFor(async () => {
    try {
      const st = await httpJson(RO_BASE + '/api/state');
      return st && st.readOnly === true ? st : null;
    } catch {
      return null;
    }
  }, 25000, 300, '只读第二实例启动');
  log('只读第二实例就绪：' + RO_BASE + '（readOnly=true）');
  return ro;
}

async function waitHub() {
  await waitFor(async () => {
    try { const st = await httpJson(BASE + '/api/state'); return st && st.nodes ? st : null; } catch { return null; }
  }, 25000, 300, '中枢启动');
  await waitFor(async () => {
    const st = await httpJson(BASE + '/api/state');
    const n = st.nodes.find((x) => x.id === 'node-local');
    return n && n.online ? n : null;
  }, 20000, 300, '节点上线');
  log('中枢与节点就绪：' + BASE);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  fail('未找到 Chrome/Edge，可设置环境变量 CHROME_PATH 指向浏览器可执行文件');
}
async function launchChrome() {
  chromePort = 9300 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-e2e-chrome-'));
  chrome = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-features=Translate', '--remote-debugging-port=' + chromePort,
    '--user-data-dir=' + profile, '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' });
  await waitFor(async () => {
    try { const v = await httpJson('http://127.0.0.1:' + chromePort + '/json/version'); return v && v.webSocketDebuggerUrl; } catch { return null; }
  }, 25000, 250, 'Chrome CDP 就绪');
  log('真实浏览器已启动（Chrome/Edge，CDP ' + chromePort + '）');
}

class Page {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) for (const fn of this.listeners.get(msg.method) || []) fn(msg.params);
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时：' + method)); }
      }, 25000);
      timer.unref?.();
    });
  }
  on(method, fn) { const arr = this.listeners.get(method) || []; arr.push(fn); this.listeners.set(method, arr); }
  once(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待事件超时：' + method)), timeout);
      const handler = (params) => { clearTimeout(timer); resolve(params); };
      this.on(method, handler);
    });
  }
  async navigate(url) {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded.catch(() => {});
    await sleep(600);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text;
      fail('页面 JS 异常：' + String(d).slice(0, 300));
    }
    return r.result ? r.result.value : undefined;
  }
  async addToken(token) {
    await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "try{localStorage.setItem('tenon:token','" + token + "')}catch(e){}",
    });
  }
  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
  }
  async shot(name) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const file = path.join(SHOT_DIR, name);
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.send('Page.bringToFront').catch(() => {});
        const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
        return 'docs/测试证据/e2e-screenshots/' + name;
      } catch (e) {
        lastErr = e;
        await sleep(800);
      }
    }
    throw new Error('截图失败（' + name + '）：' + (lastErr ? lastErr.message : '未知'));
  }
  async click(selector) {
    const box = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!box) fail('找不到可点击元素：' + selector);
    await sleep(150);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(300);
  }
  async type(selector, text) {
    const ok = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`);
    if (!ok) fail('找不到输入框：' + selector);
    await this.send('Input.insertText', { text });
    await sleep(200);
  }
  async text() { return this.eval('document.body.innerText'); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function newPage({ token = '', width = 1280, height = 800, url = 'about:blank' } = {}) {
  const res = await fetch('http://127.0.0.1:' + chromePort + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  const info = await res.json();
  const page = new Page(info.webSocketDebuggerUrl);
  await page.connect();
  await page.setViewport(width, height);
  if (token) await page.addToken(token);
  pages.push(page);
  return page;
}

const state = () => httpJson(BASE + '/api/state');
function record(id, name, pass, detail, screenshot) {
  results.push({ id, name, pass, detail: detail || '', screenshot: screenshot || null });
  log((pass ? 'PASS ' : 'FAIL ') + id + ' ' + name + (detail ? ' — ' + detail : ''));
}
async function businessSignature() {
  const st = await state();
  return JSON.stringify({
    devices: st.nodes.map((n) => [n.id, n.online, n.disconnected]),
    tasks: st.tasks.map((t) => [t.id, t.status, t.delivery ? t.delivery.channel : null]),
  });
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  if (!NO_START) startServices();
  await waitHub();
  const token = readToken();
  await launchChrome();

  const desktop = await newPage({ token, width: 1280, height: 800 });
  const mobile = await newPage({ token, width: 430, height: 860 });

  // A2：手机一句话 → 五段草案 → 节点真实执行 → 回执
  {
    const suffix = 'E2E-' + Date.now().toString(36);
    const text = '把昨天的样品图裁成方图，输出 1024 像素 ' + suffix;
    await mobile.navigate(BASE + '/m');
    await waitFor(async () => (await mobile.text()).includes('说一句话'), 12000, 250, '手机页渲染');
    await mobile.type('[data-testid="m-input"]', text);
    await mobile.click('[data-testid="m-send"]');
    const draftOk = await waitFor(async () => {
      const t = await mobile.text();
      return ['任务草案', '用到的能力', '目标设备', '缺失项', '风险等级'].every((k) => t.includes(k)) ? t : null;
    }, 15000, 300, '手机页五段草案');
    assert(draftOk.includes('可逆'), '可逆任务未标风险等级');
    const shotDraft = await mobile.shot('A2-phone-draft.png');
    const task = await waitFor(async () => {
      const st = await state();
      const t = st.tasks.find((x) => x.text.includes(suffix));
      return t || null;
    }, 15000, 250, '任务创建');
    const done = await waitFor(async () => {
      const st = await state();
      const t = st.tasks.find((x) => x.id === task.id);
      return t && ['succeeded', 'failed', 'timeout'].includes(t.status) ? t : null;
    }, 30000, 300, '节点执行完成');
    assert(done.status === 'succeeded', '任务未成功：' + done.status);
    assert((done.result.summary || '').includes('9 张成功，1 张失败'), '结果摘要不符：' + (done.result && done.result.summary));
    const delivered = await waitFor(async () => {
      const st = await state();
      const t = st.tasks.find((x) => x.id === task.id);
      return t && t.delivery ? t : null;
    }, 20000, 250, '回执产生');
    record('A2', '手机一句话→五段草案→节点真实执行→回执', true, `task=${done.id} status=${done.status} channel=${delivered.delivery.channel}`, shotDraft);

    await desktop.navigate(BASE + '/legacy#/tasks/' + done.id);
    const detail = await waitFor(async () => {
      const t = await desktop.text();
      return t.includes('时间线') && t.includes('9 张成功，1 张失败') ? t : null;
    }, 20000, 300, '桌面任务详情与执行结果');
    assert(detail.includes('已回传'), '详情页缺少回执步骤');
    const shotTimeline = await desktop.shot('A2-desktop-timeline.png');
    record('A2b', '桌面时间线含结果与回执步骤', true, 'timeline ok', shotTimeline);
  }

  // A3：不可逆动作未确认不执行；拒绝留事件（原因「未填写」）
  {
    const suffix = 'E2E-' + Date.now().toString(36);
    const text = '把交付链接发送到工作群 ' + suffix;
    await mobile.navigate(BASE + '/m');
    await waitFor(async () => (await mobile.text()).includes('说一句话'), 12000, 250, '手机页渲染');
    await mobile.type('[data-testid="m-input"]', text);
    await mobile.click('[data-testid="m-send"]');
    const pending = await waitFor(async () => {
      const st = await state();
      const t = st.tasks.find((x) => x.text.includes(suffix));
      return t && t.status === 'pending' ? t : null;
    }, 15000, 250, '不可逆任务进入待确认');
    assert(pending.risk && pending.risk.level === 'irreversible', '风险等级不是不可逆');
    assert(!pending.delivery, '未确认就产生了回执');
    const shotPending = await mobile.shot('A3-phone-irreversible-pending.png');
    await desktop.navigate(BASE + '/legacy#/tasks/' + pending.id);
    await waitFor(async () => (await desktop.text()).includes('拒绝'), 12000, 250, '任务详情渲染');
    await desktop.click('[data-testid="btn-reject"]');
    const rejected = await waitFor(async () => {
      const st = await state();
      const t = st.tasks.find((x) => x.id === pending.id);
      return t && t.status === 'cancelled' ? t : null;
    }, 15000, 250, '拒绝生效');
    assert(rejected.rejectReason === '未填写', '拒绝原因不是「未填写」：' + rejected.rejectReason);
    const shotReject = await desktop.shot('A3-rejected-reason.png');
    record('A3', '不可逆未确认不执行、拒绝留事件「未填写」', true, 'cancelled with reason 未填写', shotReject);
  }

  // A6 + A5：影响预览三级、取消零变化、断开后 3 条任务降级（<10s）
  {
    await desktop.navigate(BASE + '/legacy#/devices');
    await waitFor(async () => (await desktop.text()).includes('打印服务器'), 12000, 250, '设备页渲染');
    const shotSig = async () => (await state()).nodes.map((n) => [n.id, n.disconnected, n.online].join(':')).join('|');
    const sigBefore = await shotSig();
    await desktop.click('[data-testid="device-card"][data-node-id="dev-printer"] [data-testid="btn-impact"]');
    const preview = await waitFor(async () => {
      const t = await desktop.eval(`(() => { const el = document.querySelector('[data-testid="impact-preview"]'); return el ? el.innerText : ''; })()`);
      return t && t.includes('确定') ? t : null;
    }, 12000, 250, '影响预览弹窗');
    assert(/确定\s*3/.test(preview), '预览「确定」不是 3：' + preview.replace(/\s+/g, ' ').slice(0, 120));
    assert(/可能\s*1/.test(preview), '预览「可能」不是 1');
    assert(/未知\s*1/.test(preview), '预览「未知」不是 1');
    const shotImpact = await desktop.shot('A6-impact-preview.png');
    await desktop.click('[data-testid="impact-cancel"]');
    await sleep(600);
    const sigAfter = await shotSig();
    assert(sigAfter === sigBefore, '取消后设备状态发生变化');
    record('A6', '影响预览 确定3/可能1/未知1，取消后零变化', true, preview.replace(/\s+/g, ' ').slice(0, 80), shotImpact);

    await desktop.click('[data-testid="device-card"][data-node-id="dev-printer"] [data-testid="btn-impact"]');
    await waitFor(async () => (await desktop.eval(`(() => !!document.querySelector('[data-testid="impact-disconnect"]'))()`)), 12000, 250, '断开按钮');
    const t0 = Date.now();
    await desktop.click('[data-testid="impact-disconnect"]');
    const degraded = await waitFor(async () => {
      const st = await state();
      const ids = ['seed_task_02', 'seed_task_07', 'seed_task_08'];
      const tasks = ids.map((id) => st.tasks.find((t) => t.id === id));
      const ok = tasks.every((t) => t && t.needsReview);
      return ok ? { elapsed: Date.now() - t0, tasks } : null;
    }, 12000, 150, '3 条引用任务降级');
    assert(degraded.elapsed < 10000, '降级耗时超过 10 秒：' + degraded.elapsed + 'ms');
    const shotDown = await desktop.shot('A5-device-disconnected.png');
    record('A5', '断开被 3 条任务引用的设备，10 秒内三处降级', true, 'elapsed=' + degraded.elapsed + 'ms', shotDown);
  }

  // A4：消息收件箱只有摘要+链接；回执正文需登录
  {
    await desktop.navigate(BASE + '/legacy#/messages');
    const msgText = await waitFor(async () => {
      const t = await desktop.text();
      return t.includes('查看回执') ? t : null;
    }, 12000, 250, '消息收件箱');
    assert(msgText.includes('已脱敏'), '收件箱缺少脱敏标识');
    const shotMsg = await desktop.shot('A4-messages.png');
    const st = await state();
    const receiptTask = st.tasks.filter((t) => t.delivery && t.delivery.link).slice(-1)[0];
    assert(receiptTask, '没有可打开的回执任务');
    const guest = await newPage({ width: 1280, height: 800 });
    const legacyPath = (u) => (String(u).startsWith('/#/') ? '/legacy' + String(u) : String(u));
    await guest.navigate(BASE + legacyPath(receiptTask.delivery.link));
    const gate = await guest.text();
    assert(gate.includes('需要登录查看正文'), '未登录回执没有登录门禁');
    const shotGate = await guest.shot('A4-receipt-gate.png');
    // 回执正文由服务端按 cookie 鉴权：通过真实浏览器 fetch 登录一次（与用户点登录等效）
    await desktop.eval('fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: ' + JSON.stringify(token) + ' }) }).then(function (r) { return r.ok; })');
    await sleep(300);
    await desktop.navigate(BASE + legacyPath(receiptTask.delivery.link));
    const body = await waitFor(async () => {
      const t = await desktop.text();
      return t.includes('时间线') ? t : null;
    }, 12000, 250, '登录后回执正文');
    assert(body.includes('摘要'), '回执正文缺少摘要');
    const shotBody = await desktop.shot('A4-receipt-loggedin.png');
    record('A4', '收件箱摘要+链接、正文需登录', true, 'gate + body ok', shotMsg + ' ; ' + shotGate + ' ; ' + shotBody);
  }

  // A7：断网演练（外联关闭、本地功能不减）与恢复
  {
    await desktop.navigate(BASE + '/legacy#/drills');
    await waitFor(async () => (await desktop.text()).includes('断网'), 12000, 250, '演练页');
    await desktop.click('[data-testid="drill-offline"]');
    const degraded = await waitFor(async () => {
      const st = await state();
      return st.meta && st.meta.degraded && st.meta.degraded.mode === 'offline-drill' ? st : null;
    }, 12000, 250, '断网演练生效');
    assert(degraded.ai && degraded.ai.offline === true, '断网演练下 AI 未降级');
    const shotOffline = await desktop.shot('A7-offline-drill.png');
    await desktop.click('[data-testid="drill-restore"]');
    await waitFor(async () => {
      const st = await state();
      return !(st.meta && st.meta.degraded && st.meta.degraded.mode === 'offline-drill') ? st : null;
    }, 12000, 250, '演练恢复');
    record('A7', '断网演练：外联关闭、AI 降级、可恢复', true, 'degraded -> restored', shotOffline);
  }

  // A8：账本完整性 + 无重复执行（配合强杀演练的自动核对）
  {
    const dir = NO_START ? path.join(ROOT, 'data') : DATA_DIR;
    const file = path.join(dir, 'events.jsonl');
    const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let chainOk = true;
    for (let i = 1; i < events.length; i += 1) {
      if (events[i].prev !== events[i - 1].hash || hashOf(events[i]) !== events[i].hash) { chainOk = false; break; }
    }
    const seqOk = events.every((e, i) => e.seq === i + 1);
    const counts = new Map();
    for (const e of events) if (e.type === 'task.succeeded') counts.set(e.data.taskId, (counts.get(e.data.taskId) || 0) + 1);
    const dup = [...counts.entries()].filter(([, n]) => n > 1);
    assert(chainOk, '账本哈希链断裂');
    assert(seqOk, '账本 seq 不连续');
    assert(dup.length === 0, '存在重复执行的任务：' + JSON.stringify(dup));
    record('A8', '账本哈希链/seq 连续、无重复执行', true, 'events=' + events.length);
  }

  // A9：只读第二实例（P0 回归）—— 所有会写账本的路径必须 423，账本事件数前后不变；
  // 主实例的审计导出会 append audit.exported，因此必须登录令牌，未登录 401。
  {
    const dir = NO_START ? path.join(ROOT, 'data') : DATA_DIR;
    const secrets = JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'), 'utf8'));
    const unauth = await fetch(BASE + '/api/audit/export?format=json');
    await unauth.text();
    assert(unauth.status === 401, '主实例未鉴权 GET /api/audit/export 应 401，实际 ' + unauth.status);
    const authed = await fetch(BASE + '/api/audit/export?format=json', { headers: { 'x-tenon-token': token } });
    await authed.text();
    assert(authed.status === 200, '主实例带令牌 GET /api/audit/export 应 200，实际 ' + authed.status);

    // 停掉本 E2E 自己的节点进程，避免节点心跳在断言窗口内写账本，干扰「事件数前后不变」
    if (nodeAgentProc) {
      killTree(nodeAgentProc);
      nodeAgentProc = null;
    }
    await sleep(700);
    await startReadOnlyInstance();

    const countBefore = countLedgerEvents(dir);
    const rExport = await fetch(RO_BASE + '/api/audit/export?format=json');
    await rExport.text();
    assert(rExport.status === 423, '只读实例 GET /api/audit/export 应 423，实际 ' + rExport.status);
    const rPull = await fetch(RO_BASE + '/api/node/pull?nodeId=node-local', { headers: { 'x-tenon-node': secrets.nodeToken } });
    const pullText = await rPull.text();
    assert(rPull.status === 423, '只读实例 GET /api/node/pull 应 423，实际 ' + rPull.status + ' ' + pullText.slice(0, 80));
    const rDraft = await fetch(RO_BASE + '/api/tasks/draft', {
      method: 'POST',
      headers: { 'x-tenon-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '只读实例写入探测 ' + Date.now() }),
    });
    await rDraft.text();
    assert(rDraft.status === 423, '只读实例 POST /api/tasks/draft 应 423，实际 ' + rDraft.status);
    await sleep(400);
    const countAfter = countLedgerEvents(dir);
    assert(countAfter === countBefore, '只读实例探测期间账本事件数发生变化：' + countBefore + ' -> ' + countAfter);

    const roState = await httpJson(RO_BASE + '/api/state');
    assert(roState.readOnly === true, '第二实例 readOnly 不为 true');
    assert(roState.integrity && roState.integrity.ok === true, '只读实例读到的账本完整性失败：' + JSON.stringify(roState.integrity));
    const mainState = await state();
    assert(mainState.integrity && mainState.integrity.ok === true, '主实例账本完整性失败：' + JSON.stringify(mainState.integrity));
    record('A9', '只读第二实例所有写账本路径 423、账本事件数不变；主实例审计导出需登录', true, '主实例 export 401/200；只读 export 423、node/pull 423、draft 423、events=' + countAfter + ' 不变');
  }

  for (const p of pages) p.close();
}

function finish(ok, error) {
  try { for (const p of pages) p.close(); } catch { /* ignore */ }
  try { if (chrome) killTree(chrome); } catch { /* ignore */ }
  if (!NO_START) stopServices();
  if (!KEEP) {
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const report = {
    stamp: STAMP,
    base: BASE,
    browser: 'real Chrome/Edge via CDP (headless=new)',
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    checks: results,
    error: error ? String(error.message || error) : null,
  };
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'e2e-' + FILE_STAMP + '.json'), JSON.stringify(report, null, 2));
  } catch { /* ignore */ }
  log('结果：' + report.passed + ' 通过 / ' + report.failed + ' 失败' + (error ? '（错误：' + error.message + '）' : ''));
  if (!ok) process.exitCode = 1;
}

const started = Date.now();
main()
  .then(() => finish(true))
  .catch((e) => finish(false, e));