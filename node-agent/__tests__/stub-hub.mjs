// 榫卯 v2 桌面端自测 · 本地 stub 中枢
// 同时实现 v0.1 节点接口与 v2 契约接口（clipboard/notification/assets/transfer 入站出站），
// 让 node-agent 的 v2 模块可以在不启动真实 link-core/assets-core 的情况下跑通全链路。
import http from 'node:http';
import crypto from 'node:crypto';

function collectBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function startStubHub() {
  const state = {
    clipboard: null,
    clipboardPosts: [],
    notifications: [],
    ingests: [],
    acks: [],
    chunks: [],
    uploaded: new Map(), // `${transferId}#${index}` -> { chunks: [{offset, buffer}], total }
    finishBodies: [],
    initBodies: [],
    inbox: [],
    inboundFiles: new Map(), // transferId -> [{ name, buffer }]
    registerBodies: [],
    heartbeats: [],
    nodeEvents: [],
    pullQueue: [],
    requests: [],
    sseClients: new Set(),
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    const raw = await collectBody(req);
    let body = null;
    if (raw.length) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = null;
      }
    }
    state.requests.push({
      method: req.method,
      pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      token: req.headers['x-tenon-token'] || null,
      node: req.headers['x-tenon-node'] || null,
      bytes: raw.length,
    });
    if (pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const client = { res };
      state.sseClients.add(client);
      req.on('close', () => state.sseClients.delete(client));
      return;
    }
    if (pathname === '/api/node/register' && req.method === 'POST') {
      state.registerBodies.push(body);
      return json(res, 200, { ok: true, nodeId: body.nodeId, hubTime: new Date().toISOString() });
    }
    if (pathname === '/api/node/heartbeat' && req.method === 'POST') {
      state.heartbeats.push(body);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/node/pull' && req.method === 'GET') {
      return json(res, 200, { ok: true, tasks: state.pullQueue.splice(0, 3) });
    }
    if (pathname === '/api/node/event' && req.method === 'POST') {
      state.nodeEvents.push(body);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/v2/link/clipboard' && req.method === 'POST') {
      state.clipboardPosts.push(body);
      state.clipboard = {
        at: new Date().toISOString(),
        from: body.from,
        kind: body.kind || 'text',
        text: body.text || '',
        preview: String(body.text || '').slice(0, 60),
      };
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/v2/link/clipboard/latest' && req.method === 'GET') {
      return json(res, 200, { ok: true, clipboard: state.clipboard });
    }
    if (pathname === '/api/v2/link/notification' && req.method === 'POST') {
      state.notifications.push(body);
      return json(res, 200, { ok: true });
    }
    if (pathname === '/api/v2/assets/ingest' && req.method === 'POST') {
      state.ingests.push(body);
      return json(res, 200, { ok: true, assetId: `asset_${state.ingests.length}` });
    }
    if (pathname === '/api/v2/link/transfers' && req.method === 'GET') {
      return json(res, 200, { ok: true, transfers: state.inbox.slice() });
    }
    if (pathname === '/api/v2/link/transfer/init' && req.method === 'POST') {
      state.initBodies.push(body);
      return json(res, 200, { ok: true, transferId: 'transfer_test_1', chunkSize: 1024 });
    }
    const chunkMatch = /^\/api\/v2\/link\/transfer\/([^/]+)\/chunk$/.exec(pathname);
    if (chunkMatch && req.method === 'PUT') {
      const transferId = decodeURIComponent(chunkMatch[1]);
      const offset = Number(url.searchParams.get('offset') || 0);
      const index = Number(url.searchParams.get('index') || 0);
      state.chunks.push({ transferId, offset, index, bytes: raw.length });
      const key = `${transferId}#${index}`;
      if (!state.uploaded.has(key)) state.uploaded.set(key, { chunks: [], total: 0 });
      const record = state.uploaded.get(key);
      record.chunks.push({ offset, buffer: raw });
      record.total += raw.length;
      return json(res, 200, { ok: true, offset });
    }
    const finishMatch = /^\/api\/v2\/link\/transfer\/([^/]+)\/finish$/.exec(pathname);
    if (finishMatch && req.method === 'POST') {
      state.finishBodies.push({ transferId: decodeURIComponent(finishMatch[1]), body });
      return json(res, 200, { ok: true });
    }
    const ackMatch = /^\/api\/v2\/link\/transfer\/([^/]+)\/ack$/.exec(pathname);
    if (ackMatch && req.method === 'POST') {
      const transferId = decodeURIComponent(ackMatch[1]);
      state.acks.push({ transferId, body });
      state.inbox = state.inbox.filter((transfer) => String(transfer.transferId) !== transferId);
      return json(res, 200, { ok: true });
    }
    const fileMatch = /^\/api\/v2\/link\/transfer\/([^/]+)\/file$/.exec(pathname);
    if (fileMatch && req.method === 'GET') {
      const transferId = decodeURIComponent(fileMatch[1]);
      const index = Number(url.searchParams.get('index') || 0);
      const list = state.inboundFiles.get(transferId) || [];
      const item = list[index];
      if (!item) return json(res, 404, { error: '文件不存在' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': item.buffer.length });
      return res.end(item.buffer);
    }
    return json(res, 404, { error: `stub 未实现：${req.method} ${pathname}` });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  function pushEvent(event) {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of state.sseClients) {
      try {
        client.res.write(line);
      } catch {
        /* ignore */
      }
    }
  }

  function addInboundTransfer({ transferId = 'transfer_in_1', peerId = 'phone-1', peerName = 'Android 手机', files = [] } = {}) {
    const metas = [];
    const buffers = [];
    for (const file of files) {
      const buffer = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(String(file.buffer || ''));
      buffers.push({ name: file.name, buffer });
      metas.push({ name: file.name, size: buffer.length, sha256: file.sha256 || sha256(buffer) });
    }
    state.inbox.push({
      transferId,
      peerId,
      peerName,
      direction: 'to-desktop',
      files: metas,
      totalBytes: metas.reduce((sum, file) => sum + file.size, 0),
      createdAt: new Date().toISOString(),
    });
    state.inboundFiles.set(transferId, buffers);
    return metas;
  }

  function uploadedFile(transferId, index = 0) {
    const record = state.uploaded.get(`${transferId}#${index}`);
    if (!record) return null;
    return Buffer.concat(record.chunks.sort((a, b) => a.offset - b.offset).map((chunk) => chunk.buffer));
  }

  async function close() {
    for (const client of state.sseClients) {
      try {
        client.res.end();
      } catch {
        /* ignore */
      }
    }
    state.sseClients.clear();
    await new Promise((resolve) => server.close(resolve));
  }

  return { url, state, close, pushEvent, addInboundTransfer, uploadedFile };
}

export default { startStubHub };