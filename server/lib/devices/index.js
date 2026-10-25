// 榫卯 v2.2 · 设备绑定服务（Round 1）
// 职责：
//   1) GET  /api/v2/devices            合并 state.nodes + link 信任设备，并标注「已绑定/已安装/在线/能力数」
//   2) POST /api/v2/devices/:id/bind   写 data/devices/bindings.json（原子写）+ 账本 device.bound（幂等）
//   3) POST /api/v2/devices/:id/unbind 解绑 + 账本 device.unbound
//   4) POST /api/v2/devices/:id/action 一键操作 hello / check / open-console（未知 400）
//   5) GET  /api/v2/devices/install    安装包信息（Windows zip / Android APK 大小、版本、下载地址、三步说明）
// 挂载：Lead 的 server/lib/v2/index.js 已包含 { dir:'devices', factory:'createDevicesService' }，本文件导出该工厂。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { replay } from '../state.js';
import { createDeviceRoutes, ROUTES } from './routes.js';

// node-agent 心跳每 60s 才落一条 node.heartbeat 事件，这里放宽到 120s 避免误判离线
const NODE_ONLINE_MS = 120000;
const KNOWN_ACTIONS = ['hello', 'check', 'open-console'];

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function httpError(statusCode, message) {
  const err = new Error(message || 'HTTP ' + statusCode);
  err.statusCode = statusCode;
  return err;
}

function pkgVersion(root) {
  return (readJson(path.join(root, 'package.json'), {}) || {}).version || '0.0.0';
}

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, updatedAt: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

// ---------- Round2 P0-4：设备卡字段辅助 ----------
export function relativeTimeText(iso) {
  if (!iso) return '暂无记录';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '暂无记录';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分钟前';
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + ' 小时前';
  const day = Math.floor(hour / 24);
  if (day < 30) return day + ' 天前';
  const month = Math.floor(day / 30);
  if (month < 12) return month + ' 个月前';
  return Math.floor(month / 12) + ' 年前';
}

export function platformIconOf(device) {
  const platform = String((device && device.platform) || '').toLowerCase();
  const kind = String((device && device.kind) || '');
  if (kind === 'hub') return '🧭';
  if (platform.indexOf('android') >= 0 || platform.indexOf('ios') >= 0 || kind === 'phone') return '📱';
  if (platform.indexOf('windows') >= 0 || platform.indexOf('win') >= 0) return '🖥️';
  if (platform.indexOf('mac') >= 0 || platform.indexOf('darwin') >= 0) return '💻';
  if (platform.indexOf('linux') >= 0) return '🐧';
  return kind === 'device' ? '🛰️' : '🖥️';
}

const CAP_TAG_RULES = [
  { id: 'file', label: '文件', re: /(file|asset|upload|download|transfer)/i },
  { id: 'clipboard', label: '剪贴板', re: /clipboard/i },
  { id: 'notify', label: '通知', re: /notif|channel\.notify/i },
  { id: 'program', label: '程序', re: /(app|program|system\.|llm|ocr|media|printer|print|image|crop)/i },
  { id: 'scene', label: '场景', re: /scene/i },
  { id: 'screen', label: '投屏', re: /(screen|display|cast|showOnDesktop)/i },
];

export function capabilityTagsOf(device) {
  const caps = Array.isArray(device && device.capabilities) ? device.capabilities : [];
  const ids = caps.map((c) => String((c && (c.id || c.name)) || ''));
  const tags = [];
  const seen = new Set();
  for (const rule of CAP_TAG_RULES) {
    if (ids.some((id) => rule.re.test(id))) {
      if (!seen.has(rule.id)) { seen.add(rule.id); tags.push(rule.label); }
    }
  }
  // 手机/已配对 link 设备默认具备 文件/剪贴板/通知/场景（按平台推断，detail 里标明来源）
  if ((device.kind === 'phone' || device.sourceKind === 'link') && tags.length === 0) tags.push('文件', '剪贴板', '通知');
  return tags;
}

export function sourceTextOf(device) {
  if (device.sourceKind === 'hub') return '本机';
  if (device.sourceKind !== 'link') return '自动发现';
  const by = String(device.pairedBy || '');
  if (by === 'qr' || by === 'scan') return '扫码';
  if (by === 'manual' || by === 'code') return '手输';
  if (by === 'discovery') return '自动发现';
  return device.bound ? '手输' : '自动发现';
}

export function createDevicesService(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : path.join(root, 'data');
  const bindingsFile = path.join(dataDir, 'devices', 'bindings.json');
  const tokens = opts.tokens || opts.secret || readJson(path.join(dataDir, 'secrets.json'), null) || {};
  const readOnly = !!opts.readOnly;
  const ledger = opts.ledger || null;
  const seedState = opts.state || null;

  function currentState() {
    try {
      if (ledger && Array.isArray(ledger.events)) return replay(ledger.events);
    } catch {
      /* replay 失败时退回 v2 创建时的 state 快照 */
    }
    return seedState || { nodes: {}, meta: {} };
  }

  function readBindings() {
    const store = readJson(bindingsFile, null);
    if (!store || typeof store !== 'object' || !store.devices || typeof store.devices !== 'object') {
      return { version: 1, devices: {}, names: {}, updatedAt: null };
    }
    if (!store.names || typeof store.names !== 'object') store.names = {};
    return store;
  }

  function saveBindings(store) {
    store.version = 1;
    store.updatedAt = new Date().toISOString();
    atomicWriteJson(bindingsFile, store);
  }

  function appendEvent(type, data) {
    if (!ledger || typeof ledger.append !== 'function') return;
    try {
      ledger.append(type, data, 'hub');
    } catch {
      /* 账本追加失败不应让绑定接口失败（绑定文件已落盘） */
    }
  }

  function nodeOnline(node, now) {
    if (!node) return false;
    if (node.id === 'hub') return true;
    if (node.kind === 'node') {
      if (!node.online) return false;
      const last = node.lastSeen ? new Date(node.lastSeen).getTime() : 0;
      return now - last < NODE_ONLINE_MS;
    }
    return !!node.online;
  }

  /** 合并 state.nodes（电脑/中枢/模拟设备）+ link 信任设备 */
  function collectDevices(linkService) {
    const st = currentState();
    const now = Date.now();
    const out = [];
    const seen = new Set();
    for (const node of Object.values(st.nodes || {})) {
      const kind = node.id === 'hub' ? 'hub' : node.kind === 'node' ? 'computer' : 'device';
      out.push({
        id: node.id,
        name: node.name || node.id,
        kind,
        platform: node.platform || 'unknown',
        online: nodeOnline(node, now),
        installed: kind === 'computer' || kind === 'hub',
        capabilitiesCount: Array.isArray(node.capabilities) ? node.capabilities.length : 0,
        lastSeen: node.lastSeen || null,
        evidence: node.evidence || 'unknown',
        domain: node.domain || (st.meta && st.meta.domain) || 'studio',
        source: 'node',
        sourceKind: kind === 'hub' ? 'hub' : 'node',
        sourceText: kind === 'hub' ? '本机' : '自动发现',
        actions: KNOWN_ACTIONS.slice(),
        capabilities: (node.capabilities || []).map((c) => ({ id: c.id, name: c.name, risk: c.risk, manualOnly: !!c.manualOnly })),
      });
      seen.add(node.id);
    }
    let linkPeers = [];
    try {
      if (linkService && typeof linkService.peersInfo === 'function') {
        const info = linkService.peersInfo();
        linkPeers = Array.isArray(info && info.peers) ? info.peers : [];
      } else if (linkService && linkService.pairing && typeof linkService.pairing.listTrusted === 'function') {
        linkPeers = linkService.pairing.listTrusted();
      }
    } catch {
      linkPeers = [];
    }
    for (const peer of linkPeers) {
      const id = peer.deviceId || peer.peerId;
      if (!id || seen.has(id)) continue;
      const isPhone = String(peer.platform || '').toLowerCase().indexOf('android') >= 0 || String(peer.platform || '').toLowerCase().indexOf('ios') >= 0;
      out.push({
        id,
        name: peer.name || id,
        kind: isPhone ? 'phone' : 'computer',
        platform: peer.platform || 'unknown',
        online: !!peer.online,
        installed: !!peer.paired,
        capabilitiesCount: 0,
        lastSeen: peer.lastSeen || null,
        evidence: peer.paired ? 'confirmed' : 'declared',
        domain: 'studio',
        source: 'link',
        sourceKind: 'link',
        pairedBy: peer.by || '',
        actions: peer.online ? KNOWN_ACTIONS.slice() : ['hello', 'check'],
        capabilities: [],
      });
      seen.add(id);
    }
    return out;
  }

  function decorate(devices, bindings) {
    const names = bindings.names || {};
    return devices.map((device) => {
      const binding = bindings.devices[device.id] || null;
      const renamed = names[device.id] || null;
      const name = renamed && renamed.name ? renamed.name : device.name;
      const capabilityTags = capabilityTagsOf(device);
      const lastSeen = device.lastSeen || (binding ? binding.boundAt : null);
      return {
        ...device,
        name,
        originName: renamed ? device.name : null,
        renamedAt: renamed ? renamed.at : null,
        bound: !!binding,
        boundAt: binding ? binding.boundAt : (device.sourceKind === 'link' && device.pairedAt ? device.pairedAt : null),
        boundBy: binding ? binding.boundBy || '你' : null,
        installed: !!device.installed || !!(binding && binding.installedAt),
        // P0-4 字段补齐：平台图标 / 在线 / 最近活跃相对时间 / 能力标签 / 来源 / 绑定时间
        platformIcon: platformIconOf(device),
        lastActiveText: relativeTimeText(lastSeen),
        lastSeenText: relativeTimeText(lastSeen),
        capabilityTags,
        sourceText: sourceTextOf(device),
        bindable: device.kind !== 'hub',
      };
    });
  }

  function sorted(devices) {
    return devices.slice().sort((a, b) => {
      if (a.bound !== b.bound) return a.bound ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN');
    });
  }

  function installInfo() {
    const pub = path.join(root, 'public', 'download');
    const zipFile = path.join(pub, 'tenon-node-win.zip');
    const zipStat = statOf(zipFile);
    const meta = readJson(path.join(pub, 'install-meta.json'), null) || {};
    let newestApk = null;
    try {
      const apks = fs
        .readdirSync(pub)
        .filter((name) => /\.apk$/i.test(name))
        .map((name) => ({ name, abs: path.join(pub, name), stat: statOf(path.join(pub, name)) }))
        .filter((x) => x.stat)
        .sort((a, b) => b.stat.updatedAt.localeCompare(a.stat.updatedAt));
      if (apks.length) newestApk = apks[0];
    } catch {
      newestApk = null;
    }
    const hubUrl = meta.hubUrl || '';
    return {
      version: meta.version || pkgVersion(root),
      createdAt: meta.createdAt || (zipStat ? zipStat.updatedAt : null),
      hubUrl,
      winZip: {
        available: !!zipStat,
        size: zipStat ? zipStat.size : 0,
        updatedAt: zipStat ? zipStat.updatedAt : null,
        url: '/download/tenon-node-win.zip',
        fileName: 'tenon-node-win.zip',
        version: meta.version || pkgVersion(root),
        embeddedHubUrl: hubUrl,
        note: '安装包含本机节点令牌，仅供本机/局域网内使用，勿外传',
      },
      androidApk: newestApk
        ? {
            available: true,
            name: newestApk.name,
            size: newestApk.stat.size,
            updatedAt: newestApk.stat.updatedAt,
            url: '/download/' + encodeURIComponent(newestApk.name),
            note: 'Android 原生 App（P0 调试版）：扫码打开 /m 或用手机浏览器下载',
          }
        : { available: false, size: 0, url: '', note: 'Android APK 尚未构建' },
      steps: [
        { n: 1, title: '下载并安装', detail: '下载 Windows 节点安装包，解压后右键 install-node.ps1 用 PowerShell 运行（或由页面复制命令）；手机下载 APK 安装。' },
        { n: 2, title: '打开并连上中枢', detail: '安装脚本会自动写入中枢地址并启动节点；手机 App 扫码或输入 6 位配对码连上本机。' },
        { n: 3, title: '回来点绑定', detail: '回到本页刷新，新设备会出现在「我的设备」里，点「一键绑定」即可加入超级终端。' },
      ],
      installCommand: 'powershell -ExecutionPolicy Bypass -File .\\install-node.ps1 -HubUrl ' + (hubUrl || 'http://<本机IP>:7410'),
      mUrl: '/m',
      uninstallCommand: 'powershell -ExecutionPolicy Bypass -File .\\install-node.ps1 -Uninstall',
    };
  }

  function listDevices(ctx = {}) {
    const linkService = ctx.linkService || opts.linkService || null;
    const bindings = readBindings();
    const devices = sorted(decorate(collectDevices(linkService), bindings));
    const counts = {
      total: devices.length,
      online: devices.filter((d) => d.online).length,
      bound: devices.filter((d) => d.bound).length,
      installed: devices.filter((d) => d.installed).length,
    };
    return {
      ok: true,
      devices,
      items: devices,
      counts,
      install: installInfo(),
      bindingsFile: path.relative(root, bindingsFile).split(path.sep).join('/'),
      bindingsUpdatedAt: bindings.updatedAt || null,
      serverNow: new Date().toISOString(),
    };
  }

  function findDevice(id, ctx = {}) {
    const list = collectDevices(ctx.linkService || opts.linkService || null);
    return list.find((d) => String(d.id) === String(id)) || null;
  }

  function bind(id, extra = {}) {
    const ctx = { linkService: extra.linkService };
    const bindings = readBindings();
    const device = findDevice(id, ctx);
    if (!device) throw httpError(404, '设备不存在：' + id);
    const existing = bindings.devices[id] || null;
    const decorated = decorate([device], bindings)[0];
    if (existing) {
      return { ok: true, already: true, device: decorated, binding: existing, message: '该设备已绑定（幂等）' };
    }
    const binding = {
      deviceId: device.id,
      name: device.name,
      kind: device.kind,
      platform: device.platform,
      boundAt: new Date().toISOString(),
      boundBy: extra.by || '你',
      installedAt: device.installed ? new Date().toISOString() : null,
    };
    bindings.devices[device.id] = binding;
    saveBindings(bindings);
    appendEvent('device.bound', { deviceId: device.id, name: device.name, by: binding.boundBy });
    return { ok: true, already: false, device: { ...decorated, bound: true, boundAt: binding.boundAt, boundBy: binding.boundBy }, binding };
  }

  function unbind(id, extra = {}) {
    const bindings = readBindings();
    const existing = bindings.devices[id] || null;
    if (!existing) {
      const device = findDevice(id, { linkService: extra.linkService });
      if (!device) throw httpError(404, '设备不存在：' + id);
      return { ok: true, already: true, device: { ...device, bound: false }, message: '该设备未绑定（幂等）' };
    }
    delete bindings.devices[id];
    saveBindings(bindings);
    const reason = extra.reason || '用户解绑';
    appendEvent('device.unbound', { deviceId: id, reason });
    return { ok: true, already: false, deviceId: id, reason, message: '已解绑' };
  }

  function action(id, actionName, extra = {}) {
    const name = String(actionName || '').trim();
    if (!name) throw httpError(400, '缺少 action');
    if (KNOWN_ACTIONS.indexOf(name) < 0) throw httpError(400, '未知操作：' + name + '（支持 ' + KNOWN_ACTIONS.join(' / ') + '）');
    const bindings = readBindings();
    const device = findDevice(id, extra);
    if (!device) throw httpError(404, '设备不存在：' + id);
    const decorated = decorate([device], bindings)[0];
    if (name === 'hello') {
      return {
        ok: true,
        action: 'hello',
        detail: decorated.online ? decorated.name + ' 在线，可以开始操作' : decorated.name + ' 离线（保留上次状态，任务会排队）',
        device: decorated,
        at: new Date().toISOString(),
      };
    }
    if (name === 'check') {
      return {
        ok: true,
        action: 'check',
        summary: {
          deviceId: decorated.id,
          name: decorated.name,
          online: decorated.online,
          bound: decorated.bound,
          installed: decorated.installed,
          capabilitiesCount: decorated.capabilitiesCount,
          lastSeen: decorated.lastSeen,
          verdict: decorated.online ? 'normal' : 'offline',
          sentence: decorated.online ? '设备在线，能力可用' : '设备离线：保留上次状态，任务排队，不解绑',
        },
        device: decorated,
        at: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      action: 'open-console',
      detail: '已生成超级终端入口：' + decorated.name,
      deepLink: '#/devices?focus=' + encodeURIComponent(decorated.id),
      device: decorated,
      at: new Date().toISOString(),
    };
  }

  function regenerateBindingsForTest() {
    saveBindings({ version: 1, devices: {}, names: {}, updatedAt: null });
    return { ok: true };
  }

  /** P0-4 重命名：names 覆盖持久化 + 账本 device.renamed（state 分支由 Lead 加） */
  function rename(id, name, extra = {}) {
    const linkService = extra.linkService || opts.linkService || null;
    const device = findDevice(id, { linkService });
    if (!device) throw httpError(404, '设备不存在：' + id);
    const clean = String(name == null ? '' : name).trim().replace(/[\u0000-\u001f\u007f]/g, '');
    if (!clean) throw httpError(400, '名称不能为空');
    if (clean.length > 40) throw httpError(400, '名称不能超过 40 个字符');
    const bindings = readBindings();
    const from = (bindings.names[id] && bindings.names[id].name) || device.name;
    const decorated = decorate([device], bindings)[0];
    if (from === clean) return { ok: true, unchanged: true, device: decorated };
    bindings.names[id] = { name: clean, by: extra.by || '你', at: new Date().toISOString() };
    saveBindings(bindings);
    appendEvent('device.renamed', { nodeId: device.id, deviceId: device.id, from, to: clean, by: extra.by || '你' });
    return { ok: true, unchanged: false, from, to: clean, device: decorate([device], bindings)[0] };
  }

  function activeStatus(status) {
    return ['active', 'ready', 'uploading', 'receiving', 'created', 'pending', 'queued', 'incoming', 'started'].includes(String(status || ''));
  }

  /**
   * P0-5 撤销/解绑前影响预览：确定 / 可能 / 未知，列出会中断的传输、任务、场景、剪贴板会话。
   * 纯只读、无副作用，重复调用结果稳定（counts 稳定，用于「取消零变化」验收）。
   */
  function impact(id, extra = {}) {
    const linkService = extra.linkService || opts.linkService || null;
    const things = extra.things || opts.things || null;
    const bindings = readBindings();
    const device = findDevice(id, { linkService });
    if (!device) throw httpError(404, '设备不存在：' + id);
    const decorated = decorate([device], bindings)[0];
    const st = currentState();
    const certain = [];
    const possible = [];
    const unknown = [];
    const deviceId = String(id);

    // 1) 传输：进行中=确定中断；已完成=可能（历史引用）
    let transfers = [];
    try { if (linkService && linkService.transfer && typeof linkService.transfer.listAll === 'function') transfers = linkService.transfer.listAll(100); } catch { transfers = []; }
    for (const t of transfers) {
      if (String(t.peerId || '') !== deviceId) continue;
      const names = (t.files || []).map((f) => (f && f.name) || '文件').join('、') || '文件';
      if (activeStatus(t.status)) {
        certain.push({ type: 'transfer', id: t.transferId, title: '进行中的传输：' + names, detail: '撤销后该传输会中断（状态 ' + t.status + '），未完成的文件不会自动续传' });
      } else if (['completed', 'failed', 'cancelled'].includes(String(t.status))) {
        possible.push({ type: 'transfer', id: t.transferId, title: '历史传输记录：' + names, detail: '记录保留在账本；相关文件索引/回执将不再可查' });
      }
    }

    // 2) 任务：排队/执行中的任务会失去目标设备（确定失败）
    for (const task of Object.values(st.tasks || {})) {
      if (String(task.nodeId || task.deviceId || '') !== deviceId) continue;
      const status = String(task.status || '');
      if (['pending', 'queued', 'running', 'draft', 'confirmed'].includes(status)) {
        certain.push({ type: 'task', id: task.id, title: '进行中的任务：' + String((task.draft && task.draft.summary) || task.text || task.id), detail: '撤销后该任务失去目标设备，会失败或排队等待重新绑定（状态 ' + status + '）' });
      }
    }

    // 3) 场景：引用该设备的场景下次执行会失败（确定）
    let scenes = [];
    try { if (things && typeof things.listScenes === 'function') scenes = things.listScenes(); } catch { scenes = []; }
    for (const scene of scenes || []) {
      const steps = Array.isArray(scene.steps) ? scene.steps : (Array.isArray(scene.actions) ? scene.actions : []);
      const hit = steps.some((step) => String((step && (step.targetDeviceId || step.deviceId)) || '') === deviceId);
      if (hit) certain.push({ type: 'scene', id: scene.id || scene.sceneId, title: '场景：' + String(scene.name || scene.title || scene.id), detail: '该场景包含指向此设备的步骤，撤销后下一次执行会失败' });
    }

    // 4) 剪贴板/通知镜像：来自该设备的内容与实时通道会不可达（可能）
    let clips = [];
    try { if (linkService && linkService.clipboard && typeof linkService.clipboard.list === 'function') clips = linkService.clipboard.list(20); } catch { clips = []; }
    for (const item of clips) {
      const raw = JSON.stringify(item || {});
      if (raw.indexOf(deviceId) >= 0) {
        possible.push({ type: 'clipboard', id: 'clip-' + String((item && item.at) || ''), title: '剪贴板/通知镜像：' + String((item && (item.preview || item.text)) || '').slice(0, 40), detail: '撤销后来自该设备的剪贴板与通知镜像将不再投递（记录保留在账本）' });
      }
    }
    if (decorated.online) {
      possible.push({ type: 'session', id: 'session-' + deviceId, title: '在线点对点会话', detail: '撤销后该设备已建立的配对会话立即失效（≤1s），需要重新配对才能继续使用' });
    }

    // 5) 未知：无记录的间接引用无法自动判定
    unknown.push({
      type: 'relation',
      id: 'unknown-relations',
      title: '无记录的间接引用',
      detail: '账本中没有该设备的显式场景/任务引用记录；但「无记录不等于无引用」，例如其它设备转发、人工粘贴的地址，只能人工确认。',
    });

    const counts = { certain: certain.length, possible: possible.length, unknown: unknown.length };
    const total = counts.certain + counts.possible + counts.unknown;
    return {
      ok: true,
      device: { id: decorated.id, name: decorated.name, kind: decorated.kind, platform: decorated.platform, online: decorated.online, bound: decorated.bound },
      target: { id: decorated.id, name: decorated.name },
      counts,
      impact: { certain: counts.certain, possible: counts.possible, unknown: counts.unknown },
      items: { certain, possible, unknown },
      total,
      sentence: counts.certain > 0 || counts.possible > 0
        ? '撤销「' + decorated.name + '」会影响 ' + total + ' 处（确定 ' + counts.certain + ' · 可能 ' + counts.possible + ' · 未知 ' + counts.unknown + '）'
        : '没有找到会立即中断的记录（未知 ' + counts.unknown + ' 项仍需人工确认）',
      cancelHint: '点「取消」不会产生任何变化：不写账本、不改绑定、不断开关联（本预览为只读）',
      rePairHint: '撤销后可在「互联 / 我的设备」页点「重新配对」重新连接',
      at: new Date().toISOString(),
    };
  }

  const service = {
    root,
    dataDir,
    bindingsFile,
    tokens,
    readOnly,
    ledger,
    routes: [],
    listDevices,
    findDevice,
    bind,
    unbind,
    action,
    rename,
    impact,
    installInfo,
    ROUTES,
    _resetBindings: regenerateBindingsForTest,
  };
  service.routes = createDeviceRoutes(service);
  return service;
}

export { ROUTES };
export default createDevicesService;