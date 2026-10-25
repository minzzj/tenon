// 榫卯 Tenon v2 · Round2 P0-1：配对前置自检（Preflight）
// 六项自检：中枢在线 / 同网段 / 端口可达 / 发现端口广播状态 / 版本一致 / 数据目录可写
// 每项：{id,label,ok,detail,fix[]}；失败项 fix 为可执行的三步「下一步」，全绿才在 UI 放二维码。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_FIX = {
  hub: [
    '确认中枢进程在运行：在程序目录执行 node server/start.js',
    '检查端口是否被占用：netstat -ano | findstr :{port}',
    '仍失败时重启中枢，然后刷新本页重试',
  ],
  subnet: [
    '让手机和电脑连同一个 WiFi / 路由器',
    '关闭路由器的「AP 隔离 / 访客网络隔离」',
    '实在不行用「手输配对码」兜底（本页始终可用）',
  ],
  port: [
    '在电脑浏览器打开 {url} 确认能访问',
    '检查 Windows 防火墙是否放行 Node.js（专用网络）',
    '确认手机与电脑在同一网段后重试；也可手输配对码',
  ],
  discovery: [
    '确认 UDP 端口 {discoveryPort} 未被安全软件拦截',
    '关闭 VPN / 代理后重启中枢，让发现端口重新广播',
    '发现不可用时仍可用配对码/二维码配对（不阻塞）',
  ],
  version: [
    '刷新本页，让手机端与电脑端使用同一版本',
    '若刚更新过程序，重启中枢并重新打开手机页',
    '版本差异较大时请先升级到同一版本再配对',
  ],
  data: [
    '检查程序目录 data/ 是否有写权限（不要放在只读目录）',
    '确认磁盘未满、未被安全软件锁定',
    '修复权限后重启中枢再刷新本页',
  ],
};

function readPkgVersion(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export function normalizeForce(force) {
  if (!force) return {};
  if (typeof force === 'string') {
    const out = {};
    for (const id of force.split(',').map((x) => x.trim()).filter(Boolean)) out[id] = true;
    return out;
  }
  return force && typeof force === 'object' ? force : {};
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

/** 判断 clientIp 是否与任一网卡地址同网段（按各自 netmask） */
export function sameSubnet(clientIp, addresses) {
  const c = ipv4ToInt(clientIp);
  if (c == null) return { ok: false, matched: null };
  for (const addr of addresses || []) {
    const a = ipv4ToInt(addr.address);
    const m = ipv4ToInt(addr.netmask || '255.255.255.0');
    if (a == null || m == null) continue;
    if ((c & m) === (a & m)) return { ok: true, matched: addr };
  }
  return { ok: false, matched: null };
}

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push({ iface: name, address: item.address, netmask: item.netmask });
    }
  }
  return out;
}

export function createPreflight(opts = {}) {
  const root = path.resolve(opts.root || process.cwd());
  const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : path.join(root, 'data');
  const port = Number(opts.port || process.env.TENON_PORT || 7410);
  const addr = opts.advertiseHost || opts.host || '127.0.0.1';
  const discoveryPort = Number(opts.discoveryPort || 7413);
  const discovery = opts.discovery || null;
  const version = String(opts.version || readPkgVersion(root));
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const force = normalizeForce(opts.force || process.env.TENON_PREFLIGHT_FORCE || '');
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  function forced(id) {
    const v = force[id];
    if (v === undefined) return null;
    if (v === true) return { ok: false, detail: '已通过测试注入置为失败（TENON_PREFLIGHT_FORCE）' };
    if (v === false) return { ok: true, detail: '已通过测试注入置为通过（TENON_PREFLIGHT_FORCE）' };
    if (v && typeof v === 'object') return { ok: !!v.ok, detail: v.detail || '' };
    return null;
  }

  function fixOf(id) {
    const fill = (s) => String(s).replace('{port}', String(port)).replace('{discoveryPort}', String(discoveryPort)).replace('{url}', 'http://' + addr + ':' + port + '/');
    return (DEFAULT_FIX[id] || ['检查此项后重试']).map(fill);
  }

  function makeItem(id, label, ok, detail) {
    return { id, label, ok: !!ok, detail: String(detail || ''), fix: ok ? [] : fixOf(id) };
  }

  async function httpHealth(url) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(1500) });
      return { ok: !!res && res.ok, status: res && res.status };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  async function run(ctx = {}) {
    const clientIp = String(ctx.clientIp || '').replace(/^::ffff:/, '');
    const clientVersion = String(ctx.clientVersion || '').trim();
    const addresses = lanAddresses();
    const items = [];

    // 1) 中枢在线（本机 HTTP 自检）
    let f = forced('hub');
    if (f) items.push(makeItem('hub', '中枢在线', f.ok, f.detail));
    else {
      const r = await httpHealth('http://127.0.0.1:' + port + '/api/v2/health');
      items.push(makeItem('hub', '中枢在线', r.ok, r.ok ? '本机中枢响应正常（端口 ' + port + '）' : '本机中枢无响应：' + (r.error || 'HTTP ' + r.status)));
    }

    // 2) 同一网段
    f = forced('subnet');
    if (f) items.push(makeItem('subnet', '同一网段', f.ok, f.detail));
    else if (!clientIp) items.push(makeItem('subnet', '同一网段', true, '未识别客户端 IP（本机/反代），按同网段处理'));
    else if (/^(127\.|::1$)/.test(clientIp)) items.push(makeItem('subnet', '同一网段', true, '本机直连（' + clientIp + '）'));
    else {
      const sub = sameSubnet(clientIp, addresses);
      if (sub.ok) items.push(makeItem('subnet', '同一网段', true, '手机 ' + clientIp + ' 与中枢 ' + sub.matched.address + '（' + sub.matched.iface + '）同网段'));
      else items.push(makeItem('subnet', '同一网段', false, '手机 ' + clientIp + ' 与中枢不在同一网段（中枢网卡：' + (addresses.map((a) => a.address).join(', ') || '无') + '）'));
    }

    // 3) 端口可达（用对外广播地址访问自身）
    f = forced('port');
    if (f) items.push(makeItem('port', '端口可达', f.ok, f.detail));
    else {
      const url = 'http://' + addr + ':' + port + '/api/v2/health';
      const r = await httpHealth(url);
      items.push(makeItem('port', '端口可达', r.ok, r.ok ? url + ' 可访问' : '无法访问 ' + url + '：' + (r.error || 'HTTP ' + r.status)));
    }

    // 4) 发现端口最近广播/接收状态
    f = forced('discovery');
    if (f) items.push(makeItem('discovery', '发现端口', f.ok, f.detail));
    else {
      let st = {};
      try { st = discovery && typeof discovery.stats === 'function' ? discovery.stats() : {}; } catch { st = {}; }
      const running = !!st.running;
      const spoke = Number(st.sendCount || 0) > 0;
      const heard = Number(st.helloCount || 0) > 0;
      const ok = running && (spoke || heard);
      const parts = ['UDP ' + (st.port || discoveryPort), running ? '已开启' : '未开启', '已广播 ' + Number(st.sendCount || 0) + ' 次', heard ? '最近收到广播 ' + (st.lastHelloAt || '—') : '暂未收到其它设备广播'];
      if (!running && st.disabledReason) parts.push('原因：' + st.disabledReason);
      items.push(makeItem('discovery', '发现端口', ok, parts.join(' · ')));
    }

    // 5) 版本一致
    f = forced('version');
    if (f) items.push(makeItem('version', '版本一致', f.ok, f.detail));
    else if (!clientVersion) items.push(makeItem('version', '版本一致', true, '客户端未上报版本（按 v2 兼容处理，中枢 v' + version + '）'));
    else {
      const norm = (v) => String(v == null ? '' : v).trim().replace(/^v/i, '');
      const same = norm(clientVersion) === norm(version);
      const protocolOnly = /^(2|v2)$/i.test(norm(clientVersion)); // 旧客户端只上报协议版本时按兼容放行
      const ok = same || protocolOnly;
      items.push(makeItem('version', '版本一致', ok, '客户端 v' + norm(clientVersion) + ' · 中枢 v' + version + (ok ? (same ? '（一致）' : '（协议兼容）') : '（版本不一致，请刷新/升级到同一版本）')));
    }

    // 6) 数据目录可写
    f = forced('data');
    if (f) items.push(makeItem('data', '数据目录可写', f.ok, f.detail));
    else {
      let ok = false;
      let detail = '';
      const probe = path.join(dataDir, 'link', '.preflight-' + process.pid + '-' + Date.now() + '.tmp');
      try {
        fs.mkdirSync(path.dirname(probe), { recursive: true });
        fs.writeFileSync(probe, 'tenon-preflight', 'utf8');
        fs.unlinkSync(probe);
        ok = true;
        detail = '可写：' + path.relative(root, path.dirname(probe)).split(path.sep).join('/');
      } catch (err) {
        try { fs.unlinkSync(probe); } catch { /* ignore */ }
        detail = '不可写：' + String((err && err.message) || err);
      }
      items.push(makeItem('data', '数据目录可写', ok, detail));
    }

    const allPass = items.every((i) => i.ok);
    const diagnostics = ['[榫卯配对自检] ' + new Date().toISOString(), '中枢 v' + version + ' · http://' + addr + ':' + port, '客户端 IP：' + (clientIp || '未知')]
      .concat(items.map((i) => (i.ok ? '✓ ' : '✗ ') + i.label + '：' + i.detail))
      .concat(['结论：' + (allPass ? '全部通过，可以扫码配对' : '存在 ' + items.filter((i) => !i.ok).length + ' 项未通过')])
      .join('\n');
    const result = {
      ok: allPass,
      allPass,
      items,
      diagnostics,
      version,
      hub: { port, address: addr, addresses, discoveryPort },
      client: { ip: clientIp, sameSubnet: items.find((i) => i.id === 'subnet') ? items.find((i) => i.id === 'subnet').ok : false, version: clientVersion || null },
      at: new Date().toISOString(),
    };
    log('preflight: allPass=' + allPass + ' clientIp=' + clientIp);
    return result;
  }

  return { run, version, port, discoveryPort, force };
}

export default createPreflight;