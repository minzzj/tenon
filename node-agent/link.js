// 榫卯 v2 · 节点侧连接层对接（文件收发）
// 入站（手机→电脑）：
//   GET /api/v2/link/transfers?nodeId=&state=incoming → {transfers:[{transferId,...,files:[{name,size,sha256}]}]}
//   GET /api/v2/link/transfer/:id/file?index=<i> → 二进制
//   落盘到接收目录（默认 示例空间/接收/）→ 校验 sha256 → POST /api/v2/link/transfer/:id/ack
// 出站（电脑→手机）：
//   POST /api/v2/link/transfer/init {peerId,direction:'from-desktop',files}
//   PUT /api/v2/link/transfer/:id/chunk?offset=（二进制分块）→ POST .../finish
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_CHUNK = 1024 * 1024;

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'file').replace(/\\/g, '/')).replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim();
  return base && base !== '.' && base !== '..' ? base : `file-${Date.now()}`;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}-${i}${ext}`);
    i += 1;
  }
  return candidate;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// 按 chunkSize 顺序读文件并回调（用于分块 PUT，不一次性读入大文件）
async function forEachChunk(filePath, chunkSize, onChunk) {
  const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
  let pending = Buffer.alloc(0);
  let offset = 0;
  for await (const piece of stream) {
    pending = pending.length ? Buffer.concat([pending, piece]) : piece;
    while (pending.length >= chunkSize) {
      const chunk = pending.subarray(0, chunkSize);
      await onChunk(chunk, offset);
      offset += chunk.length;
      pending = pending.subarray(chunkSize);
    }
  }
  if (pending.length) {
    await onChunk(pending, offset);
    offset += pending.length;
  }
  return offset;
}

export function createLinkService({
  hub,
  deviceId = 'node-local',
  nodeName = '工作台',
  receiveDir,
  stateFile = null,
  log = console,
  pollMs = 1500,
  chunkSizeFallback = DEFAULT_CHUNK,
} = {}) {
  const status = {
    available: !!hub,
    running: false,
    inboundReady: null,
    lastInboundCheckAt: null,
    lastError: null,
    receivedTransfers: 0,
    receivedFiles: 0,
    receivedBytes: 0,
    sentTransfers: 0,
  };
  let timer = null;
  let busy = false;
  let inboxDown = false;
  const state = loadState();

  function loadState() {
    if (!stateFile) return { received: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return parsed && typeof parsed === 'object' && parsed.received ? parsed : { received: {} };
    } catch {
      return { received: {} };
    }
  }

  function persistState() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      log(`[传输] 写接收状态失败：${err.message}`);
    }
  }

  function targetDir() {
    return path.resolve(receiveDir || path.join(process.cwd(), '示例空间', '接收'));
  }

  // ---- 出站：电脑 → 手机/其他设备 ----
  async function sendFiles({ peerId, files = [], onProgress = null } = {}) {
    if (!hub) throw new Error('未配置中枢客户端，无法发送');
    if (!peerId) throw new Error('缺少 peerId（目标设备）');
    const list = [];
    for (const item of files) {
      const filePath = path.resolve(typeof item === 'string' ? item : item.path);
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        throw new Error(`文件不存在：${filePath}`);
      }
      if (!stat.isFile()) throw new Error(`不是普通文件：${filePath}`);
      list.push({ filePath, name: (item && item.name) || path.basename(filePath), size: stat.size });
    }
    // 预哈希：init 时带上 sha256，finish 时 link-core 会逐文件校验（真实实现会用它做完整性校验）
    for (const file of list) file.sha256 = await sha256File(file.filePath);
    if (!list.length) throw new Error('没有要发送的文件');
    const startedAt = Date.now();
    const init = await hub.postJson('/api/v2/link/transfer/init', {
      peerId,
      direction: 'from-desktop',
      files: list.map((file) => ({ name: file.name, size: file.size, sha256: file.sha256 })),
    });
    const transferId = init && (init.transferId || init.id || (init.transfer && init.transfer.transferId));
    if (!transferId) throw new Error(`传输初始化未返回 transferId：${JSON.stringify(init).slice(0, 200)}`);
    const chunkSize = Number(init.chunkSize) > 0 ? Number(init.chunkSize) : chunkSizeFallback;
    let sentBytes = 0;
    const finished = [];
    for (let index = 0; index < list.length; index += 1) {
      const file = list[index];
      const digest = crypto.createHash('sha256');
      const readStream = fs.createReadStream(file.filePath);
      let pending = Buffer.alloc(0);
      let offset = 0;
      const flush = async (chunk, at) => {
        // link-core 真实实现用 ?file=<序号>&offset=<偏移>；index/name 为兼容附加参数
        await hub.putBinary(
          `/api/v2/link/transfer/${encodeURIComponent(transferId)}/chunk?offset=${at}&file=${index}&index=${index}&name=${encodeURIComponent(file.name)}`,
          chunk,
        );
        sentBytes += chunk.length;
        if (typeof onProgress === 'function') onProgress({ file: file.name, index, offset: at + chunk.length, size: file.size, sentBytes });
      };
      for await (const piece of readStream) {
        digest.update(piece);
        pending = pending.length ? Buffer.concat([pending, piece]) : piece;
        while (pending.length >= chunkSize) {
          const chunk = pending.subarray(0, chunkSize);
          await flush(chunk, offset);
          offset += chunk.length;
          pending = pending.subarray(chunkSize);
        }
      }
      if (pending.length) await flush(pending, offset);
      finished.push({ name: file.name, size: file.size, sha256: digest.digest('hex') });
    }
    const totalBytes = finished.reduce((sum, file) => sum + file.size, 0);
    const finish = await hub.postJson(`/api/v2/link/transfer/${encodeURIComponent(transferId)}/finish`, {
      nodeId: deviceId,
      direction: 'from-desktop',
      files: finished,
      totalBytes,
      // link-core 的 finish 对「单文件」从顶层 sha256 取期望值；多文件用 init 时带的逐文件 sha256
      sha256: finished.length === 1 ? finished[0].sha256 : undefined,
    });
    const ms = Date.now() - startedAt;
    status.sentTransfers += 1;
    return {
      ok: true,
      transferId,
      peerId,
      direction: 'from-desktop',
      files: finished,
      bytes: totalBytes,
      ms,
      speedBps: ms > 0 ? Math.round((totalBytes / ms) * 1000) : totalBytes,
      response: finish,
    };
  }

  // ---- 入站：拉取待接收传输 ----
  async function listIncoming() {
    const query = `nodeId=${encodeURIComponent(deviceId)}&state=incoming`;
    const payload = await hub.getJson(`/api/v2/link/transfers?${query}`);
    const transfers = Array.isArray(payload && payload.transfers)
      ? payload.transfers
      : Array.isArray(payload && payload.items)
        ? payload.items
        : [];
    status.inboundReady = true;
    return transfers;
  }

  function transferKey(transfer) {
    return String(transfer.transferId || transfer.id || '');
  }

  async function ack(transferId, saved, ok) {
    try {
      await hub.postJson(`/api/v2/link/transfer/${encodeURIComponent(transferId)}/ack`, {
        nodeId: deviceId,
        saved,
        ok,
      });
      return { ok: true };
    } catch (err) {
      // ack 失败也保留状态，下一轮会重试 ack（文件不会重复下载）
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }

  async function receiveTransfer(transfer) {
    const transferId = transferKey(transfer);
    if (!transferId) return { ok: false, error: '缺少 transferId' };
    const existing = state.received[transferId];
    if (existing && existing.acked) return { ok: true, skipped: true };
    const dir = targetDir();
    fs.mkdirSync(dir, { recursive: true });
    const files = Array.isArray(transfer.files) && transfer.files.length ? transfer.files : [{ name: `transfer-${transferId}.bin`, size: null }];
    const saved = [];
    let allOk = true;
    for (let index = 0; index < files.length; index += 1) {
      const meta = files[index] || {};
      const name = sanitizeFileName(meta.name || `file-${index}`);
      try {
        const buffer = await hub.getBuffer(`/api/v2/link/transfer/${encodeURIComponent(transferId)}/file?index=${index}`);
        const actualSha = sha256Buffer(buffer);
        const target = uniquePath(dir, name);
        fs.writeFileSync(target, buffer);
        const expected = meta.sha256 ? String(meta.sha256).toLowerCase() : null;
        const shaOk = !expected || expected === actualSha;
        if (!shaOk) {
          allOk = false;
          log(`[传输] ${name} sha256 不匹配（期望 ${expected.slice(0, 12)}…，实际 ${actualSha.slice(0, 12)}…），已保存待人工核对`);
        }
        saved.push({
          name,
          path: target,
          bytes: buffer.length,
          sha256: actualSha,
          expectedSha256: expected,
          ok: shaOk,
        });
        status.receivedFiles += 1;
        status.receivedBytes += buffer.length;
        log(`[传输] 已接收 ${name}（${buffer.length} 字节）→ ${target}`);
      } catch (err) {
        allOk = false;
        saved.push({ name, path: null, ok: false, error: String(err && err.message ? err.message : err) });
        log(`[传输] 接收 ${name} 失败：${err && err.message ? err.message : err}`);
      }
    }
    const acked = await ack(transferId, saved, allOk);
    state.received[transferId] = {
      at: new Date().toISOString(),
      peerId: transfer.peerId || null,
      peerName: transfer.peerName || null,
      files: saved,
      ok: allOk,
      acked: acked.ok,
      ackError: acked.ok ? null : acked.error,
    };
    persistState();
    status.receivedTransfers += 1;
    return { ok: allOk, transferId, peerId: transfer.peerId || null, files: saved, acked: acked.ok };
  }

  async function receiveOnce() {
    if (!hub) return { ok: false, error: '未配置中枢客户端' };
    let transfers;
    try {
      transfers = await listIncoming();
      status.lastInboundCheckAt = new Date().toISOString();
      if (inboxDown) {
        log('[传输] 入站查询恢复');
        inboxDown = false;
      }
    } catch (err) {
      status.lastError = { at: new Date().toISOString(), where: 'inbox', message: String(err && err.message ? err.message : err) };
      if (!inboxDown) {
        inboxDown = true;
        log(`[传输] 查询入站传输失败：${err.message}（link-core 路由就绪后恢复）`);
      }
      return { ok: false, error: status.lastError.message, status: err && err.status };
    }
    const results = [];
    for (const transfer of transfers) {
      const transferId = transferKey(transfer);
      if (!transferId) continue;
      if (state.received[transferId] && state.received[transferId].acked) {
        // 已收过但中枢可能还没清列表：补发 ack
        const saved = state.received[transferId].files || [];
        await ack(transferId, saved, !!state.received[transferId].ok);
        continue;
      }
      results.push(await receiveTransfer(transfer));
    }
    return { ok: true, incoming: transfers.length, results };
  }

  function start() {
    if (!hub) {
      log('[传输] 未配置中枢客户端，文件收发未启用');
      return false;
    }
    if (status.running) return true;
    status.running = true;
    log(`[传输] 已启动：每 ${pollMs / 1000} 秒查询入站传输，接收目录 ${targetDir()}`);
    const tick = async () => {
      if (!status.running) return;
      if (!busy) {
        busy = true;
        try {
          await receiveOnce();
        } catch (err) {
          status.lastError = { at: new Date().toISOString(), where: 'tick', message: String(err && err.message ? err.message : err) };
        } finally {
          busy = false;
        }
      }
      if (status.running) timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, 600);
    return true;
  }

  function stop() {
    status.running = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    status: () => ({ ...status, receiveDir: targetDir(), state }),
    sendFiles,
    receiveOnce,
    listIncoming,
    receiveTransfer,
    start,
    stop,
    targetDir,
    get hub() {
      return hub;
    },
    nodeName,
  };
}

export default { createLinkService, sha256File, sha256Buffer, sanitizeFileName };