// 榫卯 Tenon v2 · Round2 P0-1 配对前置自检单测（node --test server/lib/link/__tests__/preflight.test.mjs）
// 覆盖六项检查的通过/失败态：中枢 / 网段 / 端口 / 发现端口 / 版本 / 数据目录，另测 force 注入与诊断文本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPreflight, sameSubnet, normalizeForce } from '../preflight.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function mkDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-preflight-'));
}

function fakeDiscovery(overrides = {}) {
  return {
    stats: () => ({
      enabled: true,
      running: true,
      port: 7413,
      httpPort: 7410,
      disabledReason: '',
      sendCount: 3,
      helloCount: 1,
      lastHelloAt: new Date().toISOString(),
      lastHelloFrom: '192.168.1.8:7410',
      peers: 1,
      ...overrides,
    }),
  };
}

function okFetch(url) {
  return Promise.resolve({ ok: true, status: 200 });
}

function pick(items, id) {
  const item = items.find((i) => i.id === id);
  assert.ok(item, '缺少自检项 ' + id);
  return item;
}

test('六项全绿：基线通过 + 每项都有 label/fix 结构', async () => {
  const dataDir = mkDataDir();
  const pf = createPreflight({ root: ROOT, dataDir, port: 7410, advertiseHost: '127.0.0.1', discovery: fakeDiscovery(), fetchImpl: okFetch, version: '0.2.0' });
  const r = await pf.run({ clientIp: '127.0.0.1' });
  assert.equal(r.items.length, 6);
  assert.equal(r.allPass, true);
  for (const item of r.items) {
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
    assert.ok(Array.isArray(item.fix));
    assert.equal(item.ok, true);
  }
  assert.match(r.diagnostics, /结论：全部通过/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('中枢不在线 → hub 红项 + 三步修复', async () => {
  const dataDir = mkDataDir();
  const failFetch = () => Promise.reject(new Error('ECONNREFUSED'));
  const pf = createPreflight({ root: ROOT, dataDir, port: 7410, advertiseHost: '127.0.0.1', discovery: fakeDiscovery(), fetchImpl: failFetch, version: '0.2.0' });
  const r = await pf.run({ clientIp: '127.0.0.1' });
  const hub = pick(r.items, 'hub');
  assert.equal(hub.ok, false);
  assert.equal(hub.fix.length, 3);
  assert.match(hub.detail, /无响应/);
  assert.equal(r.allPass, false);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('不同网段 → subnet 红项并给出下一步（同网段判定函数）', async () => {
  const addresses = [{ iface: 'eth0', address: '192.168.3.123', netmask: '255.255.255.0' }];
  assert.equal(sameSubnet('192.168.3.77', addresses).ok, true);
  assert.equal(sameSubnet('10.99.99.99', addresses).ok, false);
  const dataDir = mkDataDir();
  const pf = createPreflight({ root: ROOT, dataDir, port: 7410, advertiseHost: '127.0.0.1', discovery: fakeDiscovery(), fetchImpl: okFetch, version: '0.2.0' });
  const r = await pf.run({ clientIp: '10.99.99.99' });
  const subnet = pick(r.items, 'subnet');
  assert.equal(subnet.ok, false);
  assert.equal(subnet.fix.length, 3);
  assert.match(subnet.detail, /10\.99\.99\.99/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('端口不可达 → port 红项（对外地址 fetch 失败）', async () => {
  const dataDir = mkDataDir();
  const fetchImpl = (url) => (String(url).includes('127.0.0.1') ? Promise.resolve({ ok: true, status: 200 }) : Promise.reject(new Error('timeout')));
  const pf = createPreflight({ root: ROOT, dataDir, port: 7410, advertiseHost: '192.168.3.123', discovery: fakeDiscovery(), fetchImpl, version: '0.2.0' });
  const r = await pf.run({ clientIp: '192.168.3.9' });
  const port = pick(r.items, 'port');
  assert.equal(port.ok, false);
  assert.match(port.detail, /192\.168\.3\.123:7410/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('发现端口未运行 → discovery 红项并带出原因', async () => {
  const dataDir = mkDataDir();
  const pf = createPreflight({ root: ROOT, dataDir, port: 7410, advertiseHost: '127.0.0.1', discovery: fakeDiscovery({ running: false, disabledReason: '绑定 UDP 端口失败：EADDRINUSE', sendCount: 0, helloCount: 0 }), fetchImpl: okFetch, version: '0.2.0' });
  const r = await pf.run({ clientIp: '127.0.0.1' });
  const disc = pick(r.items, 'discovery');
  assert.equal(disc.ok, false);
  assert.match(disc.detail, /未开启/);
  assert.match(disc.detail, /EADDRINUSE/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('版本不一致 → version 红项；未上报版本按兼容通过', async () => {
  const dataDir = mkDataDir();
  const pf = createPreflight({ root: ROOT, dataDir, port: 7410, advertiseHost: '127.0.0.1', discovery: fakeDiscovery(), fetchImpl: okFetch, version: '0.2.0' });
  const mismatch = await pf.run({ clientIp: '127.0.0.1', clientVersion: '0.0.1' });
  assert.equal(pick(mismatch.items, 'version').ok, false);
  const legacy = await pf.run({ clientIp: '127.0.0.1', clientVersion: 'v2' });
  assert.equal(pick(legacy.items, 'version').ok, true, '旧客户端只报协议版本时兼容');
  const same = await pf.run({ clientIp: '127.0.0.1', clientVersion: '0.2.0' });
  assert.equal(pick(same.items, 'version').ok, true);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('数据目录不可写 → data 红项（父路径是文件，必然失败）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-preflight-ro-'));
  const blocker = path.join(tmp, 'not-a-dir');
  fs.writeFileSync(blocker, 'x');
  const pf = createPreflight({ root: ROOT, dataDir: blocker, port: 7410, advertiseHost: '127.0.0.1', discovery: fakeDiscovery(), fetchImpl: okFetch, version: '0.2.0' });
  const r = await pf.run({ clientIp: '127.0.0.1' });
  const data = pick(r.items, 'data');
  assert.equal(data.ok, false);
  assert.match(data.detail, /不可写/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('依赖注入/环境变量 force 可构造任意红项（含 normalizeForce 解析）', async () => {
  const dataDir = mkDataDir();
  assert.deepEqual(normalizeForce('hub,data'), { hub: true, data: true });
  const pf = createPreflight({ root: ROOT, dataDir, port: 7410, advertiseHost: '127.0.0.1', discovery: fakeDiscovery(), fetchImpl: okFetch, version: '0.2.0', force: { hub: true, port: { ok: false, detail: '注入：端口被防火墙拦截' } } });
  const r = await pf.run({ clientIp: '127.0.0.1' });
  assert.equal(pick(r.items, 'hub').ok, false);
  assert.equal(pick(r.items, 'port').ok, false);
  assert.match(pick(r.items, 'port').detail, /注入/);
  assert.equal(pick(r.items, 'data').ok, true);
  assert.match(r.diagnostics, /✗ 中枢在线/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});