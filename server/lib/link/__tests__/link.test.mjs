// 榫卯 Tenon v2 · link-core 独立测试（node:test，零 npm 依赖）
// 运行：node --test "server/lib/link/__tests__/link.test.mjs"
// 覆盖：配对码/QR、入站配对与信任持久化、撤销（双向）、分块传输+SHA-256+速度、断点续传、
//       校验失败、to-desktop 的 incoming 列表 / 文件下载 / ack 完成事件、剪贴板、通知、UDP 发现、
//       以及「两台本机进程真实 UDP + HTTP 跑一次传输」的端到端速度证据。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../../ledger.js';
import { createLinkService, matchRoutes } from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PEER_SCRIPT = path.join(HERE, 'peer-process.mjs');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-link-test-'));
const daemons = [];
const children = [];
let seq = 0;

after(async () => {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  for (const daemon of daemons) {
    try {
      await daemon.close();
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function startDaemon(opts = {}) {
  const name = opts.name || 'd' + ++seq;
  const dataDir = path.join(tmpRoot, 'daemon-' + name);
  fs.mkdirSync(dataDir, { recursive: true });
  const ledger = new Ledger(path.join(dataDir, 'ledger'));
  const token = opts.token || 'op-' + name;
  let service = null;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://placeholder');
      const matched = matchRoutes(service.routes, req.method, url.pathname);
      if (!matched) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
        return;
      }
      await matched.route.handler(req, res, { link: service, params: matched.params, query: url.searchParams });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      } else {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  service = createLinkService({
    dataDir,
    ledger,
    port,
    tokens: { operatorToken: token, nodeToken: 'node-' + name },
    discovery: opts.discovery === true,
    discoveryPort: opts.discoveryPort,
    unicastTargets: opts.unicastTargets || [],
    intervalMs: opts.intervalMs || 400,
    timeoutMs: opts.timeoutMs || 3000,
    codeTtlMs: opts.codeTtlMs,
    log: () => {},
  });
  let closed = false;
  const daemon = {
    name,
    dataDir,
    ledger,
    service,
    server,
    port,
    token,
    base: 'http://127.0.0.1:' + port,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        service.close();
      } catch {
        /* ignore */
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
  daemons.push(daemon);
  return daemon;
}

/** 统一 HTTP 助手：token===null 表示匿名；token===undefined 用 daemon.token */
async function api(daemon, method, apiPath, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.token !== null) headers['x-tenon-token'] = opts.token === undefined ? daemon.token : opts.token;
  const request = { method, headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(opts.body);
  }
  if (opts.raw !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
    request.body = Buffer.isBuffer(opts.raw) ? opts.raw : Buffer.from(opts.raw);
  }
  const res = await fetch(daemon.base + apiPath, request);
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data, buf, headers: res.headers };
}

function waitFor(fn, timeout = 15000, interval = 150, label = '条件') {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const value = await fn();
        if (value) return resolve(value);
      } catch {
        /* 继续等待 */
      }
      if (Date.now() - started > timeout) return reject(new Error('等待超时：' + label));
      setTimeout(tick, interval);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const eventTypes = (daemon) => daemon.ledger.events.map((ev) => ev.type);

function writeRandomFile(name, size) {
  const file = path.join(tmpRoot, name + '-' + crypto.randomBytes(3).toString('hex'));
  fs.writeFileSync(file, crypto.randomBytes(size));
  return { path: file, size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

async function pair(a, b) {
  const info = await api(b, 'GET', '/api/v2/link/pair/qr', { token: b.token });
  assert.equal(info.status, 200, '获取配对码失败');
  const paired = await api(a, 'POST', '/api/v2/link/pair', {
    body: { code: info.data.code, host: '127.0.0.1', port: b.port },
  });
  assert.equal(paired.status, 200, '配对失败：' + JSON.stringify(paired.data));
  return paired.data;
}

function peerToken(daemon, peerId) {
  const target = daemon.service.pairing.callTarget(peerId);
  return target ? target.token : '';
}

test('配对码：6 位数字 + QR payload 格式 + 需登录 + 过期失效', async () => {
  const d = await startDaemon({ name: 'pairqr' });
  const anonymous = await api(d, 'GET', '/api/v2/link/pair/qr', { token: null });
  assert.equal(anonymous.status, 401, '未登录不应拿到配对码');
  const qr = await api(d, 'GET', '/api/v2/link/pair/qr');
  assert.equal(qr.status, 200);
  assert.match(qr.data.code, /^\d{6}$/);
  assert.match(qr.data.qr, /^tenon:\/\/pair\?host=127\.0\.0\.1:\d+&code=\d{6}&fp=/);
  assert.ok(Date.parse(qr.data.expiresAt) > Date.now(), '过期时间应在未来');
  const regen = await api(d, 'POST', '/api/v2/link/pair/regenerate', { body: {} });
  assert.equal(regen.status, 200);
  let changed = regen.data.code !== qr.data.code;
  for (let i = 0; i < 3 && !changed; i += 1) {
    const again = await api(d, 'POST', '/api/v2/link/pair/regenerate', { body: {} });
    changed = again.data.code !== qr.data.code;
  }
  assert.ok(changed, '重新生成后配对码应变化');

  const shortTtl = await startDaemon({ name: 'pairttl', codeTtlMs: 80 });
  const ttlInfo = await api(shortTtl, 'GET', '/api/v2/link/pair/qr');
  await sleep(120);
  const expired = await api(shortTtl, 'POST', '/api/v2/link/pair', {
    token: null,
    body: { code: ttlInfo.data.code, from: { deviceId: 'dev_late', name: '迟到设备', platform: 'android' } },
  });
  assert.equal(expired.status, 403, '过期配对码应被拒绝');
});

test('入站配对：正确码 → link.paired 事件 + trust.json 持久化；错误码被拒', async () => {
  const b = await startDaemon({ name: 'inbound' });
  const info = await api(b, 'GET', '/api/v2/link/pair/qr');
  const wrongCode = info.data.code === '000000' ? '111111' : '000000';
  const before = b.ledger.events.length;
  const wrong = await api(b, 'POST', '/api/v2/link/pair', {
    token: null,
    body: { code: wrongCode, from: { deviceId: 'dev_bad', name: '坏设备', platform: 'android' } },
  });
  assert.equal(wrong.status, 403);
  assert.equal(b.ledger.events.length, before, '错误配对码不得产生事件');

  const ok = await api(b, 'POST', '/api/v2/link/pair', {
    token: null,
    body: {
      code: info.data.code,
      from: { deviceId: 'dev_phone_01', name: '小手机', platform: 'android', fingerprint: 'fp-phone', port: 45678, peerToken: 'pt_from_phone' },
    },
  });
  assert.equal(ok.status, 200);
  assert.match(ok.data.peerToken, /^pt_[0-9a-f]{36}$/);
  assert.equal(ok.data.peerId, b.service.identity.deviceId, '应答方应返回自己的 deviceId');
  const paired = b.ledger.events.filter((ev) => ev.type === 'link.paired').pop();
  assert.ok(paired, '应 append link.paired');
  assert.equal(paired.data.peerId, 'dev_phone_01');
  assert.equal(paired.data.by, 'code');
  const trustFile = path.join(b.dataDir, 'link', 'trust.json');
  assert.ok(fs.existsSync(trustFile), 'trust.json 应落盘');
  const trust = JSON.parse(fs.readFileSync(trustFile, 'utf8'));
  assert.equal(trust.peers.dev_phone_01.name, '小手机');
  assert.equal(trust.peers.dev_phone_01.inboundTokenHash.length, 64, '应存 inbound token 哈希而不是明文');
});

test('撤销信任：link.revoked 事件 + 对端同步移除 + 旧 peerToken 失效', async () => {
  const a = await startDaemon({ name: 'rev-a' });
  const b = await startDaemon({ name: 'rev-b' });
  await pair(a, b);
  const oldToken = peerToken(a, b.service.identity.deviceId);
  assert.ok(oldToken, '配对后应有出站 peerToken');
  assert.equal(a.service.pairing.isTrusted(b.service.identity.deviceId), true);

  const revoke = await api(a, 'POST', '/api/v2/link/revoke', {
    body: { peerId: b.service.identity.deviceId, reason: '不再信任' },
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.data.ok, true);
  assert.equal(a.service.pairing.isTrusted(b.service.identity.deviceId), false);
  const revoked = a.ledger.events.filter((ev) => ev.type === 'link.revoked').pop();
  assert.ok(revoked);
  assert.equal(revoked.data.reason, '不再信任');

  // 对端若可达会收到撤销通知（双向移除）
  await waitFor(() => b.service.pairing.isTrusted(a.service.identity.deviceId) === false, 6000, 120, '对端移除本机');
  assert.equal(b.service.pairing.isTrusted(a.service.identity.deviceId), false);

  // 旧 token 已失效：对端不再认识它
  const rejected = await api(b, 'POST', '/api/v2/link/transfer/init', {
    token: oldToken,
    body: { peerId: a.service.identity.deviceId, direction: 'from-desktop', files: [{ name: 'x.bin', size: 1 }] },
  });
  assert.equal(rejected.status, 401, '撤销后旧 peerToken 应失效');
});
test('from-desktop 传输：分块 + SHA-256 + 速度 + transfer.completed 事件', async () => {
  const a = await startDaemon({ name: 'fx-a' });
  const b = await startDaemon({ name: 'fx-b' });
  await pair(a, b);
  const file = writeRandomFile('from-desktop', 1536 * 1024);
  const sent = await api(a, 'POST', '/api/v2/link/transfer/send', {
    body: { peerId: b.service.identity.deviceId, path: file.path, direction: 'from-desktop' },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.ok, true);
  assert.equal(sent.data.done, true);
  assert.equal(sent.data.bytes, file.size);
  assert.equal(sent.data.sha256, file.sha256, '发送端 SHA-256 应一致');
  assert.ok(sent.data.speedBps > 0, '应记录速度');
  assert.ok(sent.data.ms >= 1, '应记录耗时');

  const remote = await api(b, 'GET', '/api/v2/link/transfer/' + sent.data.remoteTransferId);
  assert.equal(remote.status, 200);
  assert.equal(remote.data.transfer.status, 'completed');
  assert.equal(remote.data.transfer.direction, 'from-desktop');
  assert.equal(remote.data.transfer.receivedBytes, file.size);

  const recvDir = path.join(b.dataDir, 'link', 'transfers', 'received');
  const names = fs.readdirSync(recvDir);
  const hit = names.find((name) => name.endsWith('from-desktop') || name.includes(path.basename(file.path)));
  assert.ok(hit, '接收目录应有落盘文件：' + names.join(','));
  const savedSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(recvDir, hit))).digest('hex');
  assert.equal(savedSha, file.sha256, '接收文件 SHA-256 应与源文件一致');

  const types = eventTypes(b);
  assert.ok(types.includes('transfer.started'));
  const completed = b.ledger.events.filter((ev) => ev.type === 'transfer.completed').pop();
  assert.ok(completed, '应 append transfer.completed');
  assert.equal(completed.data.files[0].sha256, file.sha256);
  assert.equal(completed.data.files[0].ok, true);
  assert.equal(completed.data.bytes, file.size);
  assert.ok(completed.data.ms > 0);
  assert.ok(completed.data.speedBps > 0);
});

test('断点续传：中断后按 offset 续传，最终 SHA-256 一致', async () => {
  const a = await startDaemon({ name: 'rs-a' });
  const b = await startDaemon({ name: 'rs-b' });
  await pair(a, b);
  const file = writeRandomFile('resume', 2 * 1024 * 1024);
  const first = await api(a, 'POST', '/api/v2/link/transfer/send', {
    body: { peerId: b.service.identity.deviceId, path: file.path, direction: 'from-desktop', maxBytes: Math.floor(file.size / 3) },
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.done, false, '模拟断线时不应完成');
  assert.ok(first.data.sent > 0 && first.data.sent < file.size);
  const mid = await api(b, 'GET', '/api/v2/link/transfer/' + first.data.remoteTransferId);
  assert.equal(mid.data.transfer.status, 'active');
  assert.equal(mid.data.transfer.files[0].received, first.data.sent, '服务端应记录已接收字节数');

  const resumed = await api(a, 'POST', '/api/v2/link/transfer/resume', {
    body: { peerId: b.service.identity.deviceId, transferId: first.data.remoteTransferId, path: file.path, direction: 'from-desktop' },
  });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  assert.equal(resumed.data.done, true);
  assert.equal(resumed.data.sha256, file.sha256);
  const done = await api(b, 'GET', '/api/v2/link/transfer/' + first.data.remoteTransferId);
  assert.equal(done.data.transfer.status, 'completed');
  assert.equal(done.data.transfer.receivedBytes, file.size);
});

test('SHA-256 不匹配：finish 返回 422 + transfer.failed 事件 + 不产出正式文件', async () => {
  const a = await startDaemon({ name: 'bad-a' });
  const b = await startDaemon({ name: 'bad-b' });
  await pair(a, b);
  const file = writeRandomFile('badsha', 512 * 1024);
  const token = peerToken(a, b.service.identity.deviceId);
  const wrongSha = '0'.repeat(64);
  const init = await api(b, 'POST', '/api/v2/link/transfer/init', {
    token,
    body: { peerId: a.service.identity.deviceId, direction: 'from-desktop', files: [{ name: 'bad.bin', size: file.size, sha256: wrongSha }] },
  });
  assert.equal(init.status, 200);
  const transferId = init.data.transferId;
  const chunk = await api(b, 'PUT', '/api/v2/link/transfer/' + transferId + '/chunk?offset=0&file=0', { token, raw: fs.readFileSync(file.path) });
  assert.equal(chunk.status, 200, JSON.stringify(chunk.data));
  const finished = await api(b, 'POST', '/api/v2/link/transfer/' + transferId + '/finish', { token, body: { sha256: wrongSha } });
  assert.equal(finished.status, 422);
  assert.equal(finished.data.ok, false);
  const failed = b.ledger.events.filter((ev) => ev.type === 'transfer.failed').pop();
  assert.ok(failed, '应 append transfer.failed');
  assert.match(failed.data.reason, /SHA-256/);
  const recvDir = path.join(b.dataDir, 'link', 'transfers', 'received');
  assert.equal(fs.readdirSync(recvDir).length, 0, '校验失败不应产出正式文件');
});

test('to-desktop：incoming 列表 → 文件下载（Content-Type/Length/Disposition）→ ack 后 completed 事件', async () => {
  const a = await startDaemon({ name: 'td-a' });
  const b = await startDaemon({ name: 'td-b' });
  await pair(a, b);
  const file = writeRandomFile('phone-photo.jpg', 1024 * 1024);
  const sent = await api(a, 'POST', '/api/v2/link/transfer/send', {
    body: { peerId: b.service.identity.deviceId, path: file.path, name: '手机照片.jpg', direction: 'to-desktop' },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.done, true);
  assert.equal(sent.data.awaitingAck, true, 'to-desktop 在 finish 后应等待桌面 ack');
  const transferId = sent.data.remoteTransferId;

  const list = await api(b, 'GET', '/api/v2/link/transfers?nodeId=desktop-1&state=incoming');
  assert.equal(list.status, 200);
  assert.equal(list.data.ok, true);
  const item = list.data.transfers.find((entry) => entry.transferId === transferId);
  assert.ok(item, 'incoming 列表应包含该传输');
  assert.equal(item.direction, 'to-desktop');
  assert.equal(item.totalBytes, file.size);
  assert.equal(item.files[0].sha256, file.sha256);
  assert.ok(item.createdAt);
  assert.equal(item.peerId, a.service.identity.deviceId);

  const download = await api(b, 'GET', '/api/v2/link/transfer/' + transferId + '/file?index=0');
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-length'), String(file.size));
  assert.match(download.headers.get('content-type'), /^image\//, 'jpg 应按图片类型返回');
  assert.match(download.headers.get('content-disposition'), /attachment; filename=/);
  const downloadedSha = crypto.createHash('sha256').update(download.buf).digest('hex');
  assert.equal(downloadedSha, file.sha256, '下载内容应与手机上传文件一致');

  const ack = await api(b, 'POST', '/api/v2/link/transfer/' + transferId + '/ack', {
    body: { nodeId: 'desktop-1', saved: [{ name: '手机照片.jpg', path: 'C:/Users/demo/接收/手机照片.jpg', sha256: file.sha256, ok: true }], ok: true },
  });
  assert.equal(ack.status, 200, JSON.stringify(ack.data));
  assert.equal(ack.data.ok, true);
  assert.ok(ack.data.bytes > 0 && ack.data.speedBps > 0);
  const completed = b.ledger.events.filter((ev) => ev.type === 'transfer.completed').pop();
  assert.ok(completed, 'ack 后应 append transfer.completed');
  assert.equal(completed.data.transferId, transferId);
  assert.equal(completed.data.files[0].sha256, file.sha256);
  assert.equal(completed.data.files[0].ok, true);
  assert.equal(completed.data.bytes, file.size);
  assert.ok(completed.data.speedBps > 0, '事件里应带速度');
  const status = await api(b, 'GET', '/api/v2/link/transfer/' + transferId);
  assert.equal(status.data.transfer.status, 'completed');
  assert.equal(status.data.transfer.receivedBytes, file.size);
  assert.equal(status.data.transfer.ackedBy, 'desktop-1', 'ack 应记录 nodeId');
  // incoming 列表 ack 后不再返回
  const listAfter = await api(b, 'GET', '/api/v2/link/transfers?nodeId=desktop-1&state=incoming');
  assert.ok(!listAfter.data.transfers.some((entry) => entry.transferId === transferId));

  const anonymousList = await api(b, 'GET', '/api/v2/link/transfers?state=incoming', { token: null });
  assert.equal(anonymousList.status, 401, '传输列表需要操作员令牌');
});
test('剪贴板：text/link 事件 clipboard.shared、latest 形状、读接口需登录', async () => {
  const d = await startDaemon({ name: 'clip' });
  const anonymous = await api(d, 'POST', '/api/v2/link/clipboard', { token: null, body: { kind: 'text', text: 'x' } });
  assert.equal(anonymous.status, 401, '写剪贴板需要令牌');
  const textShare = await api(d, 'POST', '/api/v2/link/clipboard', {
    body: { kind: 'text', text: '手机复制的一段文字', from: 'dev_phone_01', to: 'dev_desktop_01' },
  });
  assert.equal(textShare.status, 200);
  assert.equal(textShare.data.ok, true);
  assert.equal(textShare.data.clipboard.kind, 'text');
  assert.equal(textShare.data.clipboard.preview, '手机复制的一段文字');
  const linkShare = await api(d, 'POST', '/api/v2/link/clipboard', {
    body: { kind: 'link', text: 'https://example.com/tenon', from: 'dev_phone_01' },
  });
  assert.equal(linkShare.status, 200);
  const latest = await api(d, 'GET', '/api/v2/link/clipboard/latest');
  assert.equal(latest.status, 200);
  assert.equal(latest.data.ok, true);
  assert.equal(latest.data.clipboard.kind, 'link');
  assert.equal(latest.data.clipboard.text, 'https://example.com/tenon');
  assert.ok(latest.data.clipboard.at && latest.data.clipboard.from);
  const anonymousRead = await api(d, 'GET', '/api/v2/link/clipboard/latest', { token: null });
  assert.equal(anonymousRead.status, 401, '读剪贴板也需要登录');
  const events = d.ledger.events.filter((ev) => ev.type === 'clipboard.shared');
  assert.equal(events.length, 2);
  assert.equal(events[0].data.kind, 'text');
  assert.equal(events[0].data.to, 'dev_desktop_01');
  assert.equal(events[1].data.kind, 'link');
});

test('通知镜像：notification.relayed 事件 + 列表查询', async () => {
  const d = await startDaemon({ name: 'notify' });
  const relayed = await api(d, 'POST', '/api/v2/link/notification', {
    body: { from: 'dev_phone_01', app: '微信', title: '张三', text: '晚上 7 点吃饭吗？' },
  });
  assert.equal(relayed.status, 200);
  assert.deepEqual(relayed.data, { ok: true });
  const ev = d.ledger.events.filter((e) => e.type === 'notification.relayed').pop();
  assert.ok(ev, '应 append notification.relayed');
  assert.equal(ev.data.from, 'dev_phone_01');
  assert.equal(ev.data.app, '微信');
  assert.equal(ev.data.title, '张三');
  assert.equal(ev.data.preview, '晚上 7 点吃饭吗？');
  const list = await api(d, 'GET', '/api/v2/link/notifications?limit=10');
  assert.equal(list.status, 200);
  assert.equal(list.data.notifications.length, 1);
  assert.equal(list.data.notifications[0].preview, '晚上 7 点吃饭吗？');
});

test('Android 兼容：/notify 别名 + 下载别名 /download 与 GET /chunk', async () => {
  const a = await startDaemon({ name: 'and-a' });
  const b = await startDaemon({ name: 'and-b' });
  await pair(a, b);
  const file = writeRandomFile('android-alias', 768 * 1024);
  const sent = await api(a, 'POST', '/api/v2/link/transfer/send', {
    body: { peerId: b.service.identity.deviceId, path: file.path, direction: 'from-desktop' },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const transferId = sent.data.remoteTransferId;

  for (const suffix of ['/api/v2/link/transfer/' + transferId + '/file?index=0', '/api/v2/link/transfer/' + transferId + '/download?index=0', '/api/v2/link/transfer/' + transferId + '/chunk?offset=0']) {
    const res = await api(b, 'GET', suffix);
    assert.equal(res.status, 200, suffix + ' -> ' + res.status);
    assert.equal(res.buf.length, file.size, suffix + ' 长度不一致');
    assert.equal(crypto.createHash('sha256').update(res.buf).digest('hex'), file.sha256, suffix + ' SHA 不一致');
  }

  // /notify 与 /notification 两个别名都要能写事件
  const viaNotify = await api(b, 'POST', '/api/v2/link/notify', {
    body: { from: 'dev_android', app: '微信', title: '别名测试', text: 'notify 别名' },
  });
  assert.equal(viaNotify.status, 200);
  assert.deepEqual(viaNotify.data, { ok: true });
  const viaNotification = await api(b, 'POST', '/api/v2/link/notification', {
    body: { from: 'dev_android', app: '微信', title: '别名测试2', text: 'notification 别名' },
  });
  assert.equal(viaNotification.status, 200);
  const relays = b.ledger.events.filter((ev) => ev.type === 'notification.relayed');
  assert.equal(relays.length, 2, '两个通知别名都应 append 事件');
  assert.equal(relays[0].data.preview, 'notify 别名');
});

test('Android 配对：只带 6 位码（无 operator token）→ 返回 peerId/name/platform/token，且 token 可调后续写接口', async () => {
  const d = await startDaemon({ name: 'and-pair' });
  const qr = await api(d, 'GET', '/api/v2/link/pair/qr');
  const anonymousWrong = await api(d, 'POST', '/api/v2/link/pair', {
    token: null,
    body: { code: qr.data.code === '123456' ? '654321' : '123456', deviceId: 'dev_android_bad' },
  });
  assert.equal(anonymousWrong.status, 403, '不存在的码应 403');

  const paired = await api(d, 'POST', '/api/v2/link/pair', {
    token: null,
    body: { code: qr.data.code, deviceId: 'dev_android_01', name: '安卓机', platform: 'android' },
  });
  assert.equal(paired.status, 200, JSON.stringify(paired.data));
  assert.equal(paired.data.ok, true);
  assert.equal(paired.data.peerId, d.service.identity.deviceId, 'peerId 应为 hub 的 deviceId');
  assert.equal(paired.data.name, d.service.identity.name);
  assert.equal(paired.data.platform, d.service.identity.platform);
  assert.match(paired.data.token, /^pt_[0-9a-f]{36}$/);
  // token = 发起方(Android)调本机用的会话 token；peerToken = 本机回调发起方用的 token，两者独立
  assert.match(paired.data.peerToken, /^pt_[0-9a-f]{36}$/);
  assert.equal(d.service.pairing.isTrusted('dev_android_01'), true);

  // Android 拿到的 token 可直接调后续写接口（peer 身份）
  const clip = await api(d, 'POST', '/api/v2/link/clipboard', {
    token: paired.data.token,
    body: { kind: 'text', text: '来自安卓的剪贴板' },
  });
  assert.equal(clip.status, 200, JSON.stringify(clip.data));
  assert.equal(clip.data.clipboard.preview, '来自安卓的剪贴板');
  const latest = await api(d, 'GET', '/api/v2/link/clipboard/latest', { token: paired.data.token });
  assert.equal(latest.data.clipboard.text, '来自安卓的剪贴板');
});
test('UDP 发现：两台本机服务真 UDP 互相发现并 append link.peer.seen', async () => {
  const dir = 'udp-' + Date.now().toString(36);
  const a = await startDaemon({ name: dir + '-a', discovery: true, discoveryPort: 7433, unicastTargets: ['127.0.0.1:7433'], intervalMs: 300 });
  const b = await startDaemon({ name: dir + '-b', discovery: true, discoveryPort: 7433, unicastTargets: ['127.0.0.1:7433'], intervalMs: 300 });
  try {
    const started = Date.now();
    const seen = await waitFor(async () => {
      const peersA = (await api(a, 'GET', '/api/v2/link/peers', { token: null })).data;
      const peersB = (await api(b, 'GET', '/api/v2/link/peers', { token: null })).data;
      const hitA = peersA.peers.find((p) => p.deviceId === b.service.identity.deviceId && p.online);
      const hitB = peersB.peers.find((p) => p.deviceId === a.service.identity.deviceId && p.online);
      return hitA && hitB ? { hitA, hitB } : null;
    }, 15000, 300, 'UDP 互相发现');
    const elapsed = Date.now() - started;
    assert.ok(seen.hitA.ip, '应拿到对端 IP');
    assert.equal(Number(seen.hitA.port), b.port, 'hello 应带对端 HTTP 端口');
    assert.equal(seen.hitA.platform, process.platform === 'win32' ? 'windows' : seen.hitA.platform);
    const peerSeen = a.ledger.events.filter((ev) => ev.type === 'link.peer.seen');
    assert.ok(peerSeen.length >= 1, '应 append link.peer.seen');
    const first = peerSeen[0].data;
    assert.equal(first.deviceId, b.service.identity.deviceId);
    assert.ok(first.ip && first.port && first.at);
    console.log('[udp] 两台服务真 UDP 互相发现耗时 ' + elapsed + 'ms；事件 link.peer.seen=' + peerSeen.length);
  } finally {
    await a.close();
    await b.close();
  }
});

// ---- 两台本机进程：真实 UDP 发现 + 真实 HTTP 分块传输 ----
function startPeerProcess({ name, dataDir, httpPort, udpPort, unicast, token }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      PEER_SCRIPT,
      '--data', dataDir,
      '--port', String(httpPort),
      '--udp', String(udpPort),
      '--token', token,
      '--name', name,
      '--unicast', unicast.join(','),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error('peer 进程启动超时：' + stderr.slice(-400)));
    }, 25000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const line = stdout.split('\n').find((item) => item.startsWith('TENON-READY '));
      if (!line) return;
      clearTimeout(timer);
      try {
        resolve({ child, info: JSON.parse(line.slice('TENON-READY '.length)), stderr: () => stderr });
      } catch (err) {
        reject(err);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      if (!stdout.includes('TENON-READY')) {
        clearTimeout(timer);
        reject(new Error('peer 进程退出 code=' + code + '：' + stderr.slice(-500)));
      }
    });
  });
}

async function stopPeer(peer) {
  if (!peer || !peer.child || peer.child.exitCode != null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    peer.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      peer.child.kill('SIGTERM');
    } catch {
      resolve();
    }
  });
}

const asDaemon = (peer) => ({ base: 'http://127.0.0.1:' + peer.info.port, token: peer.info.operatorToken });

test('两台本机进程：真实 UDP 发现 + 真实 HTTP 分块传输（to-desktop → 下载 → ack），报告速度', async () => {
  const runId = Date.now().toString(36);
  const dataA = path.join(tmpRoot, 'proc-a-' + runId);
  const dataB = path.join(tmpRoot, 'proc-b-' + runId);
  let peerA = null;
  let peerB = null;
  try {
    peerA = await startPeerProcess({
      name: '手机模拟-' + runId, dataDir: dataA, httpPort: 7431, udpPort: 7433,
      unicast: ['127.0.0.1:7434'], token: 'op-a-' + runId,
    });
    peerB = await startPeerProcess({
      name: '电脑模拟-' + runId, dataDir: dataB, httpPort: 7432, udpPort: 7434,
      unicast: ['127.0.0.1:7433'], token: 'op-b-' + runId,
    });
    const a = asDaemon(peerA);
    const b = asDaemon(peerB);

    // 1) 真 UDP 发现（两进程）
    const discoveryStart = Date.now();
    const discovered = await waitFor(async () => {
      const peersA = (await api(a, 'GET', '/api/v2/link/peers', { token: null })).data;
      const peersB = (await api(b, 'GET', '/api/v2/link/peers', { token: null })).data;
      const hitA = peersA.peers.find((p) => p.deviceId === peerB.info.deviceId);
      const hitB = peersB.peers.find((p) => p.deviceId === peerA.info.deviceId);
      return hitA && hitB ? { hitA, hitB } : null;
    }, 20000, 300, '两进程 UDP 互相发现');
    const discoveryMs = Date.now() - discoveryStart;
    assert.ok(discovered.hitA.ip, 'A 应发现 B 的 IP');
    assert.equal(Number(discovered.hitA.port), peerB.info.port);

    // 2) 真 HTTP 配对
    const pairRes = await api(a, 'POST', '/api/v2/link/pair', {
      body: { code: peerB.info.code, host: '127.0.0.1', port: peerB.info.port },
    });
    assert.equal(pairRes.status, 200, '两进程配对失败：' + JSON.stringify(pairRes.data));

    // 3) 8MB 文件：手机进程 -> 电脑进程（to-desktop），电脑下载后 ack
    const file = writeRandomFile('e2e-8mb', 8 * 1024 * 1024);
    const sendStart = Date.now();
    const sent = await api(a, 'POST', '/api/v2/link/transfer/send', {
      body: { peerId: peerB.info.deviceId, path: file.path, name: '演示视频素材.bin', direction: 'to-desktop' },
    });
    assert.equal(sent.status, 200, '传输失败：' + JSON.stringify(sent.data));
    assert.equal(sent.data.bytes, file.size);
    const transferId = sent.data.remoteTransferId;

    const incoming = await api(b, 'GET', '/api/v2/link/transfers?nodeId=desktop-e2e&state=incoming');
    assert.ok(incoming.data.transfers.some((t) => t.transferId === transferId), '电脑端应看到待接收传输');

    const download = await api(b, 'GET', '/api/v2/link/transfer/' + transferId + '/file?index=0');
    assert.equal(download.status, 200);
    const downloadedSha = crypto.createHash('sha256').update(download.buf).digest('hex');
    assert.equal(downloadedSha, file.sha256, '两进程下载内容 SHA-256 应一致');

    const ack = await api(b, 'POST', '/api/v2/link/transfer/' + transferId + '/ack', {
      body: { nodeId: 'desktop-e2e', saved: [{ name: '演示视频素材.bin', path: path.join(tmpRoot, 'saved.bin'), sha256: file.sha256, ok: true }], ok: true },
    });
    assert.equal(ack.status, 200);

    await waitFor(async () => {
      const status = await api(b, 'GET', '/api/v2/link/transfer/' + transferId);
      return status.data.transfer.status === 'completed' ? status : null;
    }, 8000, 120, '电脑端 ack 后完成');

    // 4) 从电脑进程自己的账本读 transfer.completed（真实落盘事件）
    const eventsFile = path.join(dataB, 'ledger', 'events.jsonl');
    const events = fs.readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const completed = events.filter((ev) => ev.type === 'transfer.completed').pop();
    assert.ok(completed, '电脑进程账本应有 transfer.completed');
    assert.equal(completed.data.bytes, file.size);
    assert.equal(completed.data.files[0].sha256, file.sha256);
    assert.ok(completed.data.speedBps > 0);
    const elapsed = Date.now() - sendStart;
    const speedMB = completed.data.speedBps / 1024 / 1024;
    console.log(
      '[two-process] UDP 发现 ' + discoveryMs + 'ms；8MB 两进程传输（真实 TCP+分块）总耗时 ' + elapsed + 'ms，' +
      '服务端记录 ' + completed.data.bytes + ' B / ' + completed.data.ms + 'ms = ' + speedMB.toFixed(2) + ' MB/s（' + completed.data.speedBps + ' B/s）',
    );
    assert.ok(speedMB > 1, '本机两进程传输速度应大于 1MB/s，实际 ' + speedMB.toFixed(2));
  } catch (err) {
    console.error('[two-process][debug] error:', err && err.message);
    console.error('[two-process][debug] A exitCode:', peerA && peerA.child ? peerA.child.exitCode : 'n/a');
    console.error('[two-process][debug] B exitCode:', peerB && peerB.child ? peerB.child.exitCode : 'n/a');
    console.error('[two-process][debug] A stderr:\n' + (peerA ? peerA.stderr() : '(none)'));
    console.error('[two-process][debug] B stderr:\n' + (peerB ? peerB.stderr() : '(none)'));
    throw err;
  } finally {
    await stopPeer(peerA);
    await stopPeer(peerB);
  }
});