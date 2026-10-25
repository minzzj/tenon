// 榫卯 Tenon v2 · 分块断点续传（1MB chunk / offset / SHA-256 / 原子 rename / 速度统计）
// 方向命名（与 Lead 约定一致）：手机 -> 电脑 = to-desktop；桌面 -> 手机 = from-desktop。
// 生命周期：
//   to-desktop：init -> PUT chunks -> finish（校验+改名，状态 ready，等待桌面 ack）-> ack（append transfer.completed）
//   from-desktop：init -> PUT chunks -> finish（校验+改名 -> completed 并直接 append transfer.completed）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteJson, readJson, sha256File, sha256Hex, sanitizeName, nowIso, httpError, fileSize } from './util.js';

export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

export function normalizeDirection(value) {
  const raw = String(value == null ? '' : value).toLowerCase().trim();
  if (['from-desktop', 'from_desktop', 'fromdesktop', 'out', 'outbound', 'send', 'desktop-to-phone'].includes(raw)) return 'from-desktop';
  return 'to-desktop';
}

export function createTransferManager({
  dataDir,
  identity,
  pairing = null,
  appendEvent = () => {},
  chunkSize = DEFAULT_CHUNK_SIZE,
  log = () => {},
} = {}) {
  const baseDir = path.join(dataDir, 'link', 'transfers');
  const recvDir = path.join(baseDir, 'received');
  fs.mkdirSync(recvDir, { recursive: true });
  const transfers = new Map();

  function dirOf(transferId) {
    return path.join(baseDir, sanitizeName(String(transferId), 'transfer'));
  }
  function metaPath(transferId) {
    return path.join(dirOf(transferId), 'meta.json');
  }
  function partPath(transferId, index) {
    return path.join(dirOf(transferId), 'f' + Number(index) + '.part');
  }

  function loadFromDisk() {
    let entries = [];
    try {
      entries = fs.readdirSync(baseDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== 'received');
    } catch {
      return;
    }
    for (const entry of entries) {
      const meta = readJson(path.join(baseDir, entry.name, 'meta.json'), null);
      if (!meta || !meta.transferId) continue;
      transfers.set(meta.transferId, meta);
    }
  }

  function save(rec) {
    rec.updatedAt = nowIso();
    atomicWriteJson(metaPath(rec.transferId), rec);
  }

  function view(rec) {
    return {
      transferId: rec.transferId,
      peerId: rec.peerId,
      peerName: rec.peerName || '',
      direction: rec.direction,
      status: rec.status,
      files: (rec.files || []).map((f) => ({
        name: f.name, size: f.size, sha256: f.sha256 || '', received: f.received || 0, ok: f.ok, finalName: f.finalName || null,
      })),
      totalBytes: rec.totalBytes,
      receivedBytes: rec.receivedBytes,
      createdAt: rec.createdAt,
      startedAt: rec.startedAt,
      completedAt: rec.completedAt || null,
      ms: rec.ms || 0,
      speedBps: rec.speedBps || 0,
      verified: !!rec.verified,
      ackedBy: rec.ackedBy || null,
    };
  }

  function getRaw(transferId) {
    return transfers.get(String(transferId || '')) || null;
  }

  function requireRaw(transferId) {
    const rec = getRaw(transferId);
    if (!rec) throw httpError(404, '传输不存在：' + transferId);
    return rec;
  }

  function requireWritable(rec) {
    if (!['active'].includes(rec.status)) throw httpError(409, '传输当前状态不可写入：' + rec.status);
  }

  function create({ peerId, peerName = '', direction, files }) {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) throw httpError(400, 'files 不能为空');
    const normalizedPeer = String(peerId || '').trim();
    if (!normalizedPeer) throw httpError(400, '缺少 peerId');
    const rec = {
      transferId: 'tr_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      peerId: normalizedPeer,
      peerName: String(peerName || ''),
      direction: normalizeDirection(direction),
      files: list.map((f) => ({
        name: sanitizeName(f && f.name),
        size: Math.max(0, Number(f && f.size) || 0),
        sha256: String((f && f.sha256) || '').toLowerCase(),
        received: 0,
        finalName: null,
        ok: null,
      })),
      totalBytes: list.reduce((sum, f) => sum + Math.max(0, Number(f && f.size) || 0), 0),
      receivedBytes: 0,
      status: 'active',
      createdAt: nowIso(),
      startedAt: Date.now(),
      completedAt: null,
      ms: 0,
      speedBps: 0,
      verified: false,
      ackedBy: null,
      chunkSize,
    };
    fs.mkdirSync(dirOf(rec.transferId), { recursive: true });
    save(rec);
    transfers.set(rec.transferId, rec);
    appendEvent('transfer.started', {
      transferId: rec.transferId,
      peerId: rec.peerId,
      direction: rec.direction,
      files: rec.files.map((f) => ({ name: f.name, size: f.size })),
      totalBytes: rec.totalBytes,
    });
    return view(rec);
  }

  function putChunk(transferId, { offset = 0, file = 0, buffer } = {}) {
    const rec = requireRaw(transferId);
    requireWritable(rec);
    const index = Number(file) || 0;
    const fileRec = rec.files[index];
    if (!fileRec) throw httpError(400, '文件序号不存在：' + index);
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
    if (!buf.length) throw httpError(400, 'chunk 为空');
    const start = Number(offset);
    if (!Number.isInteger(start) || start < 0) throw httpError(400, 'offset 不合法');
    if (start > fileRec.received) {
      const err = httpError(409, 'offset 超出已接收长度（可能是断线续传位置错误）');
      err.received = fileRec.received;
      throw err;
    }
    if (start + buf.length > fileRec.size) throw httpError(400, '写入超出文件声明大小');
    fs.mkdirSync(dirOf(rec.transferId), { recursive: true });
    const target = partPath(rec.transferId, index);
    const fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600);
    try {
      fs.writeSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    fileRec.received = Math.max(fileRec.received, start + buf.length);
    rec.receivedBytes = rec.files.reduce((sum, f) => sum + (f.received || 0), 0);
    fileRec.chunkCount = (fileRec.chunkCount || 0) + 1;
    save(rec);
    return {
      ok: true,
      transferId: rec.transferId,
      file: index,
      offset: start,
      length: buf.length,
      received: fileRec.received,
      total: fileRec.size,
      receivedBytes: rec.receivedBytes,
      totalBytes: rec.totalBytes,
      status: rec.status,
    };
  }

  async function finish(transferId, { sha256 } = {}) {
    const rec = requireRaw(transferId);
    if (rec.status === 'completed') return { ok: true, already: true, completed: true, transfer: view(rec) };
    if (rec.status === 'ready') return { ok: true, verified: true, completed: false, awaitingAck: true, transfer: view(rec) };
    if (rec.status !== 'active') throw httpError(409, '传输当前状态不可完成：' + rec.status);
    const results = [];
    for (let i = 0; i < rec.files.length; i += 1) {
      const fileRec = rec.files[i];
      const part = partPath(rec.transferId, i);
      if (!fs.existsSync(part)) throw httpError(400, '缺少分块文件（尚未上传）：' + fileRec.name);
      if (fileRec.received !== fileRec.size) {
        const err = httpError(409, '分块未传完：' + fileRec.name);
        err.received = fileRec.received;
        err.size = fileRec.size;
        throw err;
      }
      const actual = await sha256File(part);
      const expected = fileRec.sha256 || (rec.files.length === 1 ? String(sha256 || '').toLowerCase() : '');
      if (expected && actual !== expected) {
        rec.status = 'failed';
        rec.updatedAt = nowIso();
        save(rec);
        appendEvent('transfer.failed', {
          transferId: rec.transferId,
          reason: 'SHA-256 校验失败（期望 ' + expected.slice(0, 12) + '…，实际 ' + actual.slice(0, 12) + '…）',
        });
        return { ok: false, status: 422, error: 'SHA-256 校验失败', expected, actual, transfer: view(rec) };
      }
      fileRec.sha256 = expected || actual;
      fileRec.actualSha256 = actual;
      fileRec.ok = true;
      const finalName = rec.transferId + '-' + i + '-' + fileRec.name;
      fs.renameSync(part, path.join(recvDir, finalName));
      fileRec.finalName = finalName;
      results.push({ name: fileRec.name, size: fileRec.size, sha256: actual, ok: true });
    }
    rec.verified = true;
    rec.receivedBytes = rec.totalBytes;
    if (rec.direction === 'to-desktop') {
      // 等桌面端下载并 ack 后才算完成（transfer.completed 由 ack 产生）
      rec.status = 'ready';
      save(rec);
      return { ok: true, verified: true, completed: false, awaitingAck: true, files: results, transfer: view(rec) };
    }
    rec.status = 'completed';
    rec.completedAt = nowIso();
    rec.ms = Math.max(1, Date.now() - rec.startedAt);
    rec.speedBps = Math.round((rec.totalBytes * 1000) / rec.ms);
    save(rec);
    appendEvent('transfer.completed', {
      transferId: rec.transferId,
      peerId: rec.peerId,
      direction: rec.direction,
      files: results,
      bytes: rec.totalBytes,
      ms: rec.ms,
      speedBps: rec.speedBps,
    });
    return { ok: true, verified: true, completed: true, files: results, bytes: rec.totalBytes, ms: rec.ms, speedBps: rec.speedBps, transfer: view(rec) };
  }

  /** 桌面端保存完成后 ack：此时才 append transfer.completed（audit 可见） */
  function ack(transferId, { nodeId = '', saved = [], ok = true } = {}) {
    const rec = requireRaw(transferId);
    if (rec.status === 'completed') return { ok: true, already: true, transfer: view(rec) };
    if (rec.status !== 'ready') throw httpError(409, '传输尚未校验完成，当前状态：' + rec.status);
    const savedList = Array.isArray(saved) ? saved : [];
    const files = rec.files.map((f, index) => {
      const hit = savedList[index] || savedList.find((x) => x && x.name === f.name) || {};
      return {
        name: f.name,
        size: f.size,
        sha256: String(hit.sha256 || f.sha256 || ''),
        ok: ok === false ? false : hit.ok !== false,
        path: hit.path || '',
        finalName: f.finalName,
      };
    });
    rec.files.forEach((f, i) => {
      f.ok = files[i].ok;
    });
    rec.status = 'completed';
    rec.completedAt = nowIso();
    rec.ackedBy = String(nodeId || '');
    rec.ms = Math.max(1, Date.now() - rec.startedAt);
    rec.speedBps = Math.round((rec.totalBytes * 1000) / rec.ms);
    save(rec);
    appendEvent('transfer.completed', {
      transferId: rec.transferId,
      peerId: rec.peerId,
      direction: rec.direction,
      files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256, ok: f.ok })),
      bytes: rec.totalBytes,
      ms: rec.ms,
      speedBps: rec.speedBps,
    });
    return { ok: true, transfer: view(rec), bytes: rec.totalBytes, ms: rec.ms, speedBps: rec.speedBps };
  }

  /** 桌面 Agent 拉取待接收列表（默认 state=incoming → 已校验、待 ack 的 to-desktop 传输） */
  function listIncoming({ nodeId = '', state = 'incoming' } = {}) {
    const want = String(state || 'incoming');
    const out = [];
    for (const rec of transfers.values()) {
      if (rec.direction !== 'to-desktop') continue;
      if (want === 'incoming' && rec.status !== 'ready') continue;
      if (want === 'all' && rec.status === 'failed') continue;
      let peerName = rec.peerName || '';
      if (!peerName && pairing) {
        const peer = pairing.getPeer(rec.peerId);
        peerName = peer ? peer.name : '';
      }
      out.push({
        transferId: rec.transferId,
        peerId: rec.peerId,
        peerName,
        nodeId: String(nodeId || ''),
        direction: 'to-desktop',
        files: rec.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256, received: f.received })),
        totalBytes: rec.totalBytes,
        receivedBytes: rec.receivedBytes,
        status: rec.status,
        createdAt: rec.createdAt,
      });
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  function fileInfo(transferId, index = 0) {
    const rec = requireRaw(transferId);
    if (!['ready', 'completed'].includes(rec.status)) throw httpError(409, '传输尚未就绪：' + rec.status);
    const idx = Number(index) || 0;
    const fileRec = rec.files[idx];
    if (!fileRec || !fileRec.finalName) throw httpError(404, '文件不存在：index=' + idx);
    const full = path.join(recvDir, fileRec.finalName);
    if (!fs.existsSync(full)) throw httpError(404, '文件已不存在：' + fileRec.finalName);
    return { transfer: rec, file: fileRec, path: full, size: fs.statSync(full).size };
  }

  function listAll(limit = 50) {
    return [...transfers.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.max(1, Number(limit) || 50))
      .map(view);
  }
  // ---------- 出站方向（客户端）：把本地文件分块推给对端 ----------
  function targetOf(peerId, hint = {}) {
    if (hint && hint.ip && hint.port) return { ip: hint.ip, port: Number(hint.port), token: hint.token || '' };
    if (pairing) {
      const target = pairing.callTarget(peerId);
      if (target && target.ip && target.port) return target;
    }
    return null;
  }

  async function remoteJson(url, options = {}) {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeoutMs || 15000) });
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: '非 JSON 响应：' + text.slice(0, 120) };
    }
    return { status: res.status, ok: res.ok, data };
  }

  /**
   * 把本地文件分块推给对端。
   * @param {object} opts {peerId, filePath, name?, direction?, maxBytes?, resumeTransferId?, target?}
   *   maxBytes > 0 时只传前 maxBytes 字节（模拟断线），返回 {done:false, remoteTransferId, sent}
   */
  async function sendToPeer(opts = {}) {
    const peerId = String(opts.peerId || '').trim();
    const filePath = String(opts.filePath || '');
    if (!peerId) throw httpError(400, '缺少 peerId');
    if (!filePath || !fs.existsSync(filePath)) throw httpError(400, '本地文件不存在：' + filePath);
    const target = targetOf(peerId, opts.target || {});
    if (!target || !target.ip || !target.port) throw httpError(409, '对端地址未知（未配对或未发现）：' + peerId);
    const token = target.token || String(opts.token || '');
    const size = fs.statSync(filePath).size;
    const name = sanitizeName(opts.name || path.basename(filePath));
    const sha256 = await sha256File(filePath);
    const direction = normalizeDirection(opts.direction);
    const baseUrl = 'http://' + target.ip + ':' + target.port;
    const headers = { 'x-tenon-token': token };
    const startedAt = Date.now();
    let remoteTransferId = String(opts.resumeTransferId || '');
    let offset = 0;
    let remoteChunkSize = chunkSize;
    if (remoteTransferId) {
      const remote = await remoteJson(baseUrl + '/api/v2/link/transfer/' + encodeURIComponent(remoteTransferId), { headers });
      if (!remote.ok) throw httpError(remote.status || 502, '续传查询失败：' + (remote.data.error || ''));
      const file0 = (remote.data.transfer && remote.data.transfer.files && remote.data.transfer.files[0]) || {};
      offset = Number(file0.received) || 0;
    } else {
      const init = await remoteJson(baseUrl + '/api/v2/link/transfer/init', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ peerId: identity.deviceId, direction, files: [{ name, size, sha256 }] }),
      });
      if (!init.ok) throw httpError(init.status || 502, '初始化传输失败：' + (init.data.error || ''));
      remoteTransferId = init.data.transferId || (init.data.transfer && init.data.transfer.transferId) || '';
      remoteChunkSize = Number(init.data.chunkSize) || chunkSize;
      if (!remoteTransferId) throw httpError(502, '对端未返回 transferId');
    }
    const recv = {
      transferId: 'out_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
      peerId,
      peerName: opts.peerName || '',
      direction,
      files: [{ name, size, sha256, received: offset }],
      totalBytes: size,
      createdAt: nowIso(),
      startedAt,
      remoteTransferId,
    };
    const limit = Number(opts.maxBytes) > 0 ? Math.min(size, Number(opts.maxBytes)) : size;
    const fd = fs.openSync(filePath, 'r');
    try {
      while (offset < limit) {
        const want = Math.min(remoteChunkSize, limit - offset);
        const buf = Buffer.allocUnsafe(want);
        const read = fs.readSync(fd, buf, 0, want, offset);
        if (!read) break;
        const chunk = read === want ? buf : buf.subarray(0, read);
        const res = await fetch(baseUrl + '/api/v2/link/transfer/' + encodeURIComponent(remoteTransferId) + '/chunk?offset=' + offset + '&file=0', {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/octet-stream' },
          body: chunk,
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw httpError(res.status || 502, '分块上传失败：' + text.slice(0, 160));
        }
        offset += chunk.length;
      }
    } finally {
      fs.closeSync(fd);
    }
    recv.files[0].received = offset;
    if (offset < size) {
      return { ok: true, done: false, sent: offset, total: size, remoteTransferId, chunkSize: remoteChunkSize, direction };
    }
    const finishRes = await remoteJson(baseUrl + '/api/v2/link/transfer/' + encodeURIComponent(remoteTransferId) + '/finish', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha256 }),
    });
    if (!finishRes.ok || finishRes.data.ok === false) {
      throw httpError(finishRes.status || 422, '完成校验失败：' + (finishRes.data.error || ''));
    }
    const ms = Math.max(1, Date.now() - startedAt);
    const speedBps = Math.round((size * 1000) / ms);
    appendEvent('transfer.completed', {
      transferId: recv.transferId,
      peerId,
      direction,
      files: [{ name, size, sha256, ok: true }],
      bytes: size,
      ms,
      speedBps,
    });
    return {
      ok: true,
      done: true,
      remoteTransferId,
      bytes: size,
      ms,
      speedBps,
      sha256,
      direction,
      completed: !!finishRes.data.completed,
      awaitingAck: !!finishRes.data.awaitingAck,
      remote: finishRes.data,
    };
  }

  async function resumeToPeer(opts = {}) {
    if (!opts.transferId) throw httpError(400, '缺少 transferId');
    return sendToPeer({ ...opts, resumeTransferId: opts.transferId });
  }

  function stats() {
    const all = [...transfers.values()];
    return {
      total: all.length,
      active: all.filter((x) => x.status === 'active').length,
      ready: all.filter((x) => x.status === 'ready').length,
      completed: all.filter((x) => x.status === 'completed').length,
      failed: all.filter((x) => x.status === 'failed').length,
      baseDir,
    };
  }

  loadFromDisk();

  return {
    chunkSize,
    baseDir,
    recvDir,
    create,
    putChunk,
    finish,
    ack,
    listIncoming,
    listAll,
    fileInfo,
    get: (transferId) => {
      const rec = getRaw(transferId);
      return rec ? view(rec) : null;
    },
    sendToPeer,
    resumeToPeer,
    stats,
  };
}