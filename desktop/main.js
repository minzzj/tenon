// 榫卯超级终端 · Electron 桌面主进程（V4 单程序）
// 功能：托盘常驻；启动本地中枢（复用 server/start.js）；启动屏幕文字采集；加载超级终端界面；托盘菜单控制监听/采集/总结/退出。
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, Notification, globalShortcut, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

function resolveRoot() {
  const tryDir = (dir) => fs.existsSync(path.join(dir, 'server', 'start.js')) && fs.existsSync(path.join(dir, 'public', 'index.html'));
  // 1) 显式环境变量
  if (process.env.TENON_ROOT && tryDir(process.env.TENON_ROOT)) return process.env.TENON_ROOT;
  // 2) 便携版解压目录 / 安装目录：向上找仓库（exe 放在仓库根时直接用仓库）
  let d = path.dirname(app.getPath('exe'));
  for (let i = 0; i < 6; i += 1) {
    if (tryDir(d)) return d;
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  // 3) 打包资源目录（extraResources 放在 resourcesPath 根）
  if (app.isPackaged && tryDir(process.resourcesPath)) return process.resourcesPath;
  return path.resolve(__dirname, '..');
}
const ROOT = resolveRoot();
const DATA_DIR = app.isPackaged && !fs.existsSync(path.join(ROOT, 'data')) ? path.join(app.getPath('userData'), 'data') : path.join(ROOT, 'data');
const HUB = process.env.TENON_DESKTOP_HUB || 'http://127.0.0.1:7410';
const PORT = Number(process.env.TENON_DESKTOP_PORT || 7410);
const PAUSE_FILE = path.join(DATA_DIR, 'voice', 'screen.pause');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'desktop.log');
let win = null, tray = null, hubChild = null, captureChild = null, agentChild = null, quitting = false;
let overlay = null;
let quick = { phase: 'idle', said: '', reply: '', busy: false, active: false, lastReplyAt: 0, lastSaidAt: 0 };
let token = '';
let state = { voiceListening: false, screenCapture: true };

function log(...a) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n');
  } catch (_) {}
}
function readToken() {
  try {
    const sec = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'secrets.json'), 'utf8'));
    token = sec.operatorToken || '';
  } catch (_) {}
  return token;
}
function api(method, p, body) {
  return new Promise((resolve) => {
    try {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = http.request(HUB + p, { method, headers: Object.assign({ 'x-tenon-token': readToken(), 'Content-Type': 'application/json' }, data ? { 'Content-Length': data.length } : {}) }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf || '{}') }); } catch (_) { resolve({ status: res.statusCode, text: buf }); } });
      });
      req.on('error', (e) => resolve({ status: -1, error: String(e.message || e) }));
      req.setTimeout(120000, () => { req.destroy(); resolve({ status: -1, error: 'timeout' }); });
      if (data) req.write(data);
      req.end();
    } catch (e) { resolve({ status: -1, error: String(e.message || e) }); }
  });
}
function hubAlive() {
  return new Promise((resolve) => {
    const req = http.get(HUB + '/api/v2/health', { timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function waitHub(ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await hubAlive()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
function startHub() {
  if (hubChild) return;
  log('starting hub');
  const isPackaged = app.isPackaged;
  const exe = isPackaged ? process.execPath : (process.platform === 'win32' ? 'node.exe' : 'node');
  const env = Object.assign({}, process.env, { TENON_HOST: '0.0.0.0', TENON_PORT: String(PORT), TENON_DATA_DIR: DATA_DIR });
  if (isPackaged) env.ELECTRON_RUN_AS_NODE = '1';
  hubChild = spawn(exe, ['server/start.js'], { cwd: ROOT, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  hubChild.stdout.on('data', (d) => log('[hub]', String(d).trim().slice(0, 400)));
  hubChild.stderr.on('data', (d) => log('[hub:err]', String(d).trim().slice(0, 400)));
  hubChild.on('exit', (code) => log('hub exited', code));
}
function startNodeAgent() {
  if (agentChild) return;
  // 关键：App 启动时同时拉起 node-agent（执行器），否则手机/语音命令只会“已派发”永远不执行
  try {
    const isPackaged = app.isPackaged;
    const exe = isPackaged ? process.execPath : (process.platform === 'win32' ? 'node.exe' : 'node');
    const env = Object.assign({}, process.env, {
      TENON_V2: '1',
      TENON_HUB_URL: HUB,
      TENON_DATA_DIR: DATA_DIR,
      TENON_NODE_NAME: '工作台',
    });
    if (isPackaged) env.ELECTRON_RUN_AS_NODE = '1';
    agentChild = spawn(exe, ['node-agent/agent.js'], { cwd: ROOT, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    agentChild.stdout.on('data', (d) => log('[agent]', String(d).trim().slice(0, 300)));
    agentChild.stderr.on('data', (d) => log('[agent:err]', String(d).trim().slice(0, 300)));
    agentChild.on('exit', (code) => { log('agent exited', code); agentChild = null; });
    agentChild.on('error', (e) => log('agent spawn err', e.message));
    log('node-agent started');
  } catch (e) { log('startNodeAgent err', e.message); }
}

function findPython() {
  const candidates = [process.env.TENON_PYTHON, 'python.exe', 'python'];
  return candidates.find((c) => c) || 'python';
}
function startCapture() {
  if (captureChild) return;
  if (fs.existsSync(PAUSE_FILE)) { state.screenCapture = false; }
  log('starting capture');
  captureChild = spawn(findPython(), ['scripts/screen/capture_loop.py', '--hub', HUB, '--token', readToken()], {
    cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  captureChild.stdout.on('data', (d) => log('[capture]', String(d).trim().slice(0, 300)));
  captureChild.stderr.on('data', (d) => log('[capture:err]', String(d).trim().slice(0, 300)));
  captureChild.on('exit', (code) => { log('capture exited', code); captureChild = null; });
}
function toggleScreen() {
  try {
    if (fs.existsSync(PAUSE_FILE)) { fs.unlinkSync(PAUSE_FILE); state.screenCapture = true; }
    else { fs.mkdirSync(path.dirname(PAUSE_FILE), { recursive: true }); fs.writeFileSync(PAUSE_FILE, String(Date.now())); state.screenCapture = false; }
  } catch (e) { log('toggleScreen err', e.message); }
  rebuildTray();
  return state.screenCapture;
}
async function toggleVoice() {
  const r = state.voiceListening ? await api('POST', '/api/v2/voice/stop') : await api('POST', '/api/v2/voice/start');
  state.voiceListening = !state.voiceListening;
  log('toggleVoice ->', state.voiceListening, r.status);
  rebuildTray();
  sendToRenderer();
  return state.voiceListening;
}
function sendToRenderer() {
  if (win && !win.isDestroyed()) { try { win.webContents.send('desktop:state', publicState()); } catch (_) {} }
}
function publicState() {
  return { isDesktop: true, version: app.getVersion(), hub: HUB, voiceListening: state.voiceListening, screenCapture: state.screenCapture, pauseFile: PAUSE_FILE };
}
function overlayUrl() { return HUB + '/desktop-overlay.html?desktop=1'; }
function overlayFile() { return path.join(__dirname, 'overlay.html'); }
function createOverlay() {
  try {
    if (overlay && !overlay.isDestroyed()) return overlay;
    const area = screen.getPrimaryDisplay().workArea;
    overlay = new BrowserWindow({
      width: 212, height: 148,
      x: Math.max(0, area.x + area.width - 226),
      y: Math.max(0, area.y + area.height - 300),
      frame: false, transparent: true, resizable: false, movable: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, focusable: true,
      title: '榫卯快捷录音',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlay.loadFile(overlayFile());
    overlay.once('ready-to-show', () => { try { overlay.showInactive(); } catch (_) {} });
    overlay.on('closed', () => { overlay = null; });
    overlay.webContents.on('did-fail-load', () => { log('overlay load failed'); });
    log('overlay created');
    return overlay;
  } catch (e) { log('overlay err', e.message); return null; }
}
function hideOverlay() { try { if (overlay && !overlay.isDestroyed()) overlay.hide(); } catch (_) {} }
function showOverlay() { try { if (!overlay) createOverlay(); else overlay.showInactive(); sendQuickStatus(); } catch (_) {} }
function sendQuickStatus(extra) {
  if (!overlay || overlay.isDestroyed()) return;
  const payload = Object.assign({ phase: quick.phase, said: quick.said, reply: quick.reply, active: quick.active }, extra || {});
  try { overlay.webContents.send('quick:status', payload); } catch (_) {}
  rebuildTray();
}
async function refreshQuickState() {
  const r = await api('GET', '/api/v2/voice/status');
  if (!r || !r.json) return;
  const st = r.json;
  const ws = st.workers || {};
  const asr = ws.asr || {};
  let phase = 'idle';
  if (quick.active || st.state === 'session' || st.state === 'reply' || st.state === 'starting') {
    if (st.state === 'starting' || asr.state === 'starting') phase = 'thinking';
    else if (st.busy) phase = 'thinking';
    else if (st.state === 'reply') phase = 'speaking';
    else if (st.state === 'session') phase = 'listening';
    else phase = 'listening';
  }
  if (st.lastError && !quick.active) phase = 'err';
  const lt = st.lastTranscript;
  if (lt && lt.at && lt.at !== quick.lastSaidAt && (lt.source === 'mic')) { quick.said = lt.text || ''; quick.lastSaidAt = lt.at; }
  const lr = st.lastReply;
  if (lr && lr.at && lr.at !== quick.lastReplyAt) { quick.reply = lr.text || ''; quick.lastReplyAt = lr.at; }
  if (!quick.active && (st.state === 'idle' || st.state === 'listening')) {
    if (Date.now() - (quick.lastActivityAt || 0) > 12000) { quick.said = ''; quick.reply = ''; phase = 'idle'; }
  }
  quick.phase = phase;
  sendQuickStatus();
}
async function quickToggle() {
  if (quick.busy) return quick.phase;
  quick.busy = true;
  try {
    if (quick.active) {
      await api('POST', '/api/v2/voice/quick/stop');
      quick.active = false; quick.phase = 'idle';
      sendQuickStatus();
    } else {
      quick.active = true; quick.phase = 'thinking'; quick.said = ''; quick.reply = '';
      quick.lastActivityAt = Date.now();
      sendQuickStatus();
      const r = await api('POST', '/api/v2/voice/quick/start');
      if (!r || !r.json || r.json.ok !== true) {
        quick.active = false; quick.phase = 'err';
        quick.reply = (r && r.json && r.json.error) || '语音引擎还没准备好，请稍等几秒再点';
        sendQuickStatus();
        setTimeout(() => { quick.phase = 'idle'; sendQuickStatus(); }, 3200);
      } else {
        quick.phase = 'listening';
        sendQuickStatus();
        // 最多 20 秒自动回到待机（避免一直转）
        setTimeout(() => { if (quick.active) { quick.active = false; refreshQuickState(); } }, 25000);
      }
    }
  } catch (e) {
    quick.active = false; quick.phase = 'err'; quick.reply = String(e.message || e); sendQuickStatus();
  } finally { quick.busy = false; }
  return quick.phase;
}
function registerMediaShortcuts() {
  try {
    const ok1 = globalShortcut.register('MediaPlayPause', () => { quickToggle(); });
    log('media key MediaPlayPause registered:', ok1);
  } catch (e) { log('media key err', e.message); }
  try {
    const ok2 = globalShortcut.register('CommandOrControl+Alt+Space', () => { quickToggle(); });
    log('hotkey Ctrl+Alt+Space registered:', ok2);
  } catch (e) { log('hotkey err', e.message); }
}

function trayImage() {
  try { return nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')); } catch (_) { return nativeImage.createEmpty(); }
}
function rebuildTray() {
  if (!tray) return;
  const voiceLabel = state.voiceListening ? '暂停语音监听' : '开启语音监听';
  const screenLabel = state.screenCapture ? '暂停屏幕采集' : '开启屏幕采集';
  const auto = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开超级终端', click: () => showWindow() },
    { label: '打开完整控制台（旧版）', click: () => { showWindow(); if (win) win.loadURL(HUB + '/?desktop=1#/super'); } },
    { type: 'separator' },
    { label: '记录 / 笔记', click: () => { showWindow(); if (win) win.loadURL(HUB + '/super.html?desktop=1#/notes'); } },
    { label: '提醒', click: () => { showWindow(); if (win) win.loadURL(HUB + '/super.html?desktop=1#/reminders'); } },
    { label: '文档（总结）', click: () => { showWindow(); if (win) win.loadURL(HUB + '/super.html?desktop=1#/documents'); } },
    { type: 'separator' },
    { label: quick.active ? '结束快捷录音' : '快捷录音（说一句直接执行）', click: () => { quickToggle(); } },
    { label: '显示悬浮录音按钮', click: () => { showOverlay(); } },
    { label: '隐藏悬浮录音按钮', click: () => { hideOverlay(); } },
    { type: 'separator' },
    { label: voiceLabel, click: () => toggleVoice() },
    { label: screenLabel, click: () => toggleScreen() },
    { label: '现在生成今日总结', click: async () => { const r = await api('POST', '/api/v2/voice/diary/generate', { force: true }); log('diary', r.status); if (win) { showWindow(); win.loadURL(HUB + '/?desktop=1#/today'); } } },
    { type: 'separator' },
    { label: '开机自启', type: 'checkbox', checked: auto, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { label: '打开数据目录', click: () => shell.openPath(path.join(ROOT, 'data')) },
    { type: 'separator' },
    { label: '退出榫卯', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.setToolTip('榫卯超级终端 · ' + (state.voiceListening ? '正在聆听' : '待机'));
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 820, minWidth: 860, minHeight: 620,
    title: '榫卯 · 超级终端', backgroundColor: '#0b0f14',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadURL(HUB + '/super.html?desktop=1');
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}
async function bootstrap() {
  const already = await hubAlive();
  if (!already) startHub();
  const ok = await waitHub();
  log('hub ready', ok);
  readToken();
  if (!captureChild && state.screenCapture) startCapture();
  // 启动执行器（node-agent）：手机/语音命令需要它真正执行
  startNodeAgent();
  await new Promise((r) => setTimeout(r, 500));
  const st = await api('GET', '/api/v2/voice/status');
  if (st && st.json && st.json.enabled) state.voiceListening = st.json.state !== 'idle' || !!st.json.startedAt;
  // 打开程序就默认进入「可录音」状态（用户常识：点开就能说）
  try {
    const pr = await api('PATCH', '/api/v2/voice/config', { enabled: true });
    if (!pr || pr.status !== 200) await api('POST', '/api/v2/voice/start');
    else await api('POST', '/api/v2/voice/start');
    state.voiceListening = true;
    log('voice auto-start on bootstrap');
  } catch (e) { log('voice auto-start err', e.message); }
  createWindow();
  tray = new Tray(trayImage());
  tray.on('click', () => (win && win.isVisible() ? win.hide() : showWindow()));
  rebuildTray();
  setInterval(async () => { const j = await api('GET', '/api/v2/voice/status'); if (j && j.json) { state.voiceListening = !!j.json.enabled; rebuildTray(); sendToRenderer(); } }, 15000);
  startV5Pollers();
  createOverlay();
  registerMediaShortcuts();
  setInterval(refreshQuickState, 1200);
  setTimeout(refreshQuickState, 1500);
}
// ---------- V5：提醒 / 新文档系统通知 ----------
const notified = new Set();
let lastDocAt = 0;
function showNative(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body: String(body || '').slice(0, 200), silent: false });
    n.on('click', () => { showWindow(); if (win) win.loadURL(HUB + '/super.html?desktop=1#/reminders'); });
    n.show();
    log('native notification:', title);
  } catch (e) { log('notification err', e.message); }
}
async function pollReminders() {
  try {
    const r = await api('GET', '/api/v2/reminders/pending');
    const items = (r.json && (r.json.items || r.json.pending || r.json.reminders)) || [];
    for (const it of items) {
      const id = String(it.id || it.reminderId || it.at + it.text);
      if (notified.has('r:' + id)) continue;
      notified.add('r:' + id);
      showNative('⏰ 提醒', it.text || it.title || '时间到了');
    }
    if (notified.size > 500) notified.clear();
  } catch (_) {}
}
async function pollDocuments() {
  try {
    const r = await api('GET', '/api/v2/documents?limit=5');
    const list = (r.json && (r.json.items || r.json.documents)) || [];
    for (const d of list) {
      const at = Date.parse(d.createdAt || d.at || 0) || Number(d.createdAt || d.at || 0) || 0;
      if (!at || at <= lastDocAt) continue;
      if (lastDocAt === 0) { lastDocAt = at; continue; }
      lastDocAt = Math.max(lastDocAt, at);
      showNative('📄 新文档已生成', (d.title || '今日总结') + '（点击查看/下载）');
    }
  } catch (_) {}
}
function startV5Pollers() {
  pollReminders();
  pollDocuments();
  setInterval(pollReminders, 15000);
  setInterval(pollDocuments, 60000);
}

app.requestSingleInstanceLock();
app.on('second-instance', () => showWindow());
app.whenReady().then(bootstrap);
app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });
app.on('before-quit', () => {
  quitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
  for (const c of [captureChild, agentChild, hubChild]) { try { if (c && !c.killed) c.kill(); } catch (_) {} }
});
ipcMain.handle('desktop:getState', () => publicState());
ipcMain.handle('desktop:toggleVoice', () => toggleVoice());
ipcMain.handle('desktop:toggleScreen', () => toggleScreen());
ipcMain.handle('desktop:getToken', () => readToken());
ipcMain.handle('desktop:generateDiary', () => api('POST', '/api/v2/voice/diary/generate', { force: true }));
ipcMain.handle('quick:toggle', () => quickToggle());
ipcMain.handle('quick:getStatus', () => ({ phase: quick.phase, said: quick.said, reply: quick.reply, active: quick.active }));
ipcMain.handle('quick:hide', () => { hideOverlay(); return true; });
