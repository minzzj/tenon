// 榫卯 Tenon v2 · 配对（6 位配对码 + QR payload）与信任设备持久化（data/link/trust.json）
import crypto from 'node:crypto';
import path from 'node:path';
import { readJson, atomicWriteJson, sha256Hex, nowIso, httpError, localIPv4 } from './util.js';

export const PAIR_CODE_TTL_MS = 120000;

/** P0-3 配对成功页的 3 个一键动作（移动端/桌面端共用，随配对响应下发） */
export const PAIR_ACTIONS = [
  { id: 'send-file', label: '发一个文件', detail: '从本机选文件，分块传到对方，SHA-256 校验后落盘；数据只走局域网。', endpoint: '/api/v2/link/transfers' },
  { id: 'clipboard-sync', label: '同步剪贴板', detail: '把当前剪贴板文本/链接发给对方，对方点一下即可粘贴；不经过公网。', endpoint: '/api/v2/link/clipboard' },
  { id: 'handoff-page', label: '把当前页面甩过去', detail: '把正在看的网页地址流转到对方屏幕打开（只传摘要与链接）。', endpoint: '/api/v2/super/handoff' },
];
export const PAIR_CAPABILITIES = ['files', 'clipboard', 'notify', 'handoff'];

function constantEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * 配对模型：
 * - 本机展示 6 位码 + QR（GET /pair/qr）；
 * - 发起方把码和自己的信息 POST 到对端 /api/v2/link/pair（本模块 provide acceptInbound/initiate）；
 * - 双方交换两个方向的一次性 peerToken：outboundToken（我方调对端时带）+ inboundTokenHash（校验对端调我方）；
 * - 信任设备落盘 data/link/trust.json，可撤销。
 */
export function createPairing({
  dataDir,
  identity,
  getHttpPort,
  host = '127.0.0.1',
  codeTtlMs = PAIR_CODE_TTL_MS,
  appendEvent = () => {},
  onPaired = () => {},
  log = () => {},
} = {}) {
  const dir = path.join(dataDir, 'link');
  const trustFile = path.join(dir, 'trust.json');
  const saved = readJson(trustFile, null);
  const peers = saved && saved.peers && typeof saved.peers === 'object' ? saved.peers : {};
  let currentCode = null;
  let lastPairedAt = '';

  function ensureCode(force = false) {
    // 一次性码：被成功配对消费或过期后自动换新码（P0-2）
    if (!force && currentCode && !currentCode.used && Date.now() < currentCode.expiresAt) return currentCode;
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    currentCode = { code, expiresAt: Date.now() + Math.max(1, Number(codeTtlMs) || PAIR_CODE_TTL_MS), createdAt: Date.now(), used: false };
    return currentCode;
  }

  /** 标记当前码已使用（一次性） */
  function consumeCode() {
    if (currentCode) currentCode.used = true;
  }

  function saveTrust() {
    atomicWriteJson(trustFile, { version: 2, peers, updatedAt: nowIso() });
  }

  function qrHost() {
    if (host && host !== '0.0.0.0' && host !== '::') return host;
    return localIPv4();
  }

  function qrPayload() {
    const code = ensureCode();
    return 'tenon://pair?host=' + qrHost() + ':' + getHttpPort() + '&code=' + code.code + '&v=2&exp=' + code.expiresAt + '&oneTime=1&fp=' + encodeURIComponent(identity.fingerprint);
  }

  function pairingInfo() {
    const code = ensureCode();
    return {
      deviceId: identity.deviceId,
      name: identity.name,
      platform: identity.platform,
      host: qrHost(),
      port: getHttpPort(),
      version: 2,
      code: code.code,
      v: 2,
      exp: code.expiresAt,
      expiresAt: new Date(code.expiresAt).toISOString(),
      oneTime: true,
      qr: qrPayload(),
      ttlMs: codeTtlMs,
    };
  }

  function regenerateCode() {
    const code = ensureCode(true);
    return { code: code.code, v: 2, exp: code.expiresAt, expiresAt: new Date(code.expiresAt).toISOString(), oneTime: true, qr: qrPayload() };
  }

  function verifyCode(code) {
    // 校验的是「当前展示过的码」，过期/已用/从未展示过一律拒绝（不能在这里静默重新生成）
    if (!currentCode) return false;
    if (currentCode.used) return false;
    if (Date.now() > currentCode.expiresAt) return false;
    const given = String(code == null ? '' : code).trim();
    if (!/^\d{6}$/.test(given)) return false;
    return constantEqual(given, currentCode.code);
  }

  function publicPeer(rec) {
    return {
      peerId: rec.peerId,
      name: rec.name,
      platform: rec.platform,
      fingerprint: rec.fingerprint,
      ip: rec.ip || '',
      port: Number(rec.port) || 0,
      pairedAt: rec.pairedAt,
      lastSeen: rec.lastSeen,
      by: rec.by || 'code',
      version: 2,
    };
  }

  function listTrusted() {
    return Object.values(peers).map(publicPeer);
  }

  function isTrusted(peerId) {
    return !!peers[String(peerId || '')];
  }

  function getPeer(peerId) {
    return peers[String(peerId || '')] || null;
  }

  /** 给「调用对端」用：返回 { ip, port, outboundToken }（不含任何展示字段） */
  function callTarget(peerId) {
    const rec = peers[String(peerId || '')];
    if (!rec) return null;
    return { peerId: rec.peerId, ip: rec.ip || '', port: Number(rec.port) || 0, token: rec.outboundToken || '' };
  }

  function trustPeer({ peerId, name, platform, fingerprint, ip, port, outboundToken, inboundTokenHash, by }) {
    const id = String(peerId || '');
    if (!id) throw httpError(400, '缺少对端 deviceId');
    const old = peers[id] || null;
    const rec = {
      peerId: id,
      name: name || (old && old.name) || id,
      platform: platform || (old && old.platform) || 'unknown',
      fingerprint: fingerprint || (old && old.fingerprint) || '',
      ip: ip || (old && old.ip) || '',
      port: Number(port) || (old && old.port) || 0,
      pairedAt: (old && old.pairedAt) || nowIso(),
      lastSeen: nowIso(),
      outboundToken: outboundToken !== undefined ? String(outboundToken || '') : (old && old.outboundToken) || '',
      inboundTokenHash: inboundTokenHash !== undefined ? String(inboundTokenHash || '') : (old && old.inboundTokenHash) || '',
      by: by || (old && old.by) || 'code',
    };
    peers[id] = rec;
    lastPairedAt = nowIso();
    saveTrust();
    appendEvent('link.paired', {
      peerId: rec.peerId,
      name: rec.name,
      platform: rec.platform,
      fingerprint: rec.fingerprint,
      by: rec.by,
    });
    try {
      onPaired(rec);
    } catch (err) {
      log('onPaired 回调失败：' + err.message);
    }
    return rec;
  }

  /** 收到别人的配对请求（他扫了/输入了我们的码） */
  function acceptInbound({ code, from, ip, by = 'code' }) {
    if (!from || !from.deviceId) return { ok: false, status: 400, error: '缺少配对发起方信息 from.deviceId' };
    if (String(from.deviceId) === identity.deviceId) return { ok: false, status: 400, error: '不能与自己配对' };
    if (!verifyCode(code)) return { ok: false, status: 403, error: '配对码不正确或已过期' };
    consumeCode(); // 一次性码：配对成功后立即失效，需要重新展示新码
    // 双向 token：
    // - callerToken：发起方（手机/Android）调本机时带的 token（未提供则本机生成并返回）
    // - tokenOut：本机回调发起方时用的 token（正常双向配对时由 initiate 写回对方）
    const suppliedIn = from.peerToken ? String(from.peerToken) : '';
    const callerToken = suppliedIn || 'pt_' + crypto.randomBytes(18).toString('hex');
    const tokenOut = 'pt_' + crypto.randomBytes(18).toString('hex');
    const rec = trustPeer({
      peerId: from.deviceId,
      name: from.name,
      platform: from.platform,
      fingerprint: from.fingerprint,
      ip,
      port: from.port,
      outboundToken: tokenOut,
      inboundTokenHash: sha256Hex(callerToken),
      by,
    });
    return {
      ok: true,
      paired: true,
      // 对发起方而言，它配对到的是「本机」；这里的 peerId 是应答方（本机）的 deviceId
      peerId: identity.deviceId,
      token: callerToken,
      peerToken: tokenOut,
      peer: { peerId: rec.peerId, name: rec.name, platform: rec.platform, fingerprint: rec.fingerprint },
      self: { deviceId: identity.deviceId, name: identity.name, platform: identity.platform, fingerprint: identity.fingerprint, port: getHttpPort() },
      // P0-3 配对成功页：能力清单 + 3 个一键动作（UI 直接渲染，移动端/桌面端共用）
      actions: PAIR_ACTIONS,
      capabilities: PAIR_CAPABILITIES,
    };
  }

  /** 主动配对：向对端 POST 我们的码 + 信息，成功后双方互相持有 peerToken */
  async function initiate({ code, host: peerHost, port: peerPort, by = 'code' }) {
    if (!peerHost) return { ok: false, status: 400, error: '需要 host' };
    if (!peerPort) return { ok: false, status: 400, error: '需要 port' };
    const tokenOut = 'pt_' + crypto.randomBytes(18).toString('hex');
    const body = JSON.stringify({
      code: String(code == null ? '' : code).trim(),
      from: {
        deviceId: identity.deviceId,
        name: identity.name,
        platform: identity.platform,
        fingerprint: identity.fingerprint,
        port: getHttpPort(),
        peerToken: tokenOut,
      },
    });
    let res;
    let text = '';
    const target = 'http://' + peerHost + ':' + Number(peerPort);
    try {
      res = await fetch(target + '/api/v2/link/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(8000),
      });
      text = await res.text();
    } catch (err) {
      return { ok: false, status: 502, error: '连接对端失败：' + err.message, target };
    }
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* 非 JSON 响应按失败处理 */
    }
    if (!res.ok || !data.ok) {
      return { ok: false, status: res.status || 502, error: data.error || '配对失败 HTTP ' + res.status, target };
    }
    const responder = data.self || data.peer || {};
    const peerId = responder.deviceId || data.peerId || '';
    if (!peerId) return { ok: false, status: 502, error: '对端未返回 deviceId', target };
    const rec = trustPeer({
      peerId,
      name: responder.name || data.name,
      platform: responder.platform || data.platform,
      fingerprint: responder.fingerprint || data.fingerprint,
      ip: peerHost,
      port: peerPort,
      outboundToken: tokenOut,
      inboundTokenHash: data.peerToken ? sha256Hex(data.peerToken) : '',
      by,
    });
    return { ok: true, peerId: rec.peerId, peer: publicPeer(rec) };
  }

  /** 校验对端请求携带的 token（对端调我方） */
  function authPeerToken(token) {
    const raw = String(token || '');
    if (!raw) return null;
    const hash = sha256Hex(raw);
    for (const rec of Object.values(peers)) {
      if (rec.inboundTokenHash && constantEqual(rec.inboundTokenHash, hash)) {
        return { peerId: rec.peerId, name: rec.name };
      }
    }
    return null;
  }

  /**
   * 撤销信任：本地移除 + append link.revoked；
   * 若对端可达，再尽力通知对端把本机也移除（对端用我们配对时给的 token 鉴权），失败不影响本地撤销。
   */
  async function revoke(peerId, reason = '用户撤销') {
    const id = String(peerId || '');
    const rec = peers[id];
    if (!rec) return { ok: false, status: 404, error: '未找到信任设备' };
    const target = { ip: rec.ip || '', port: Number(rec.port) || 0, token: rec.outboundToken || '' };
    const why = String(reason || '用户撤销');
    delete peers[id];
    saveTrust();
    appendEvent('link.revoked', { peerId: id, reason: why });
    let remoteRevoked = false;
    if (target.ip && target.port && target.token) {
      try {
        const res = await fetch('http://' + target.ip + ':' + target.port + '/api/v2/link/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenon-token': target.token },
          body: JSON.stringify({ peerId: identity.deviceId, reason: why }),
          signal: AbortSignal.timeout(2500),
        });
        remoteRevoked = res.ok;
      } catch {
        remoteRevoked = false;
      }
    }
    return { ok: true, peerId: id, reason: why, remoteRevoked };
  }

  /** 发现到新地址/端口时更新对端 endpoint（不触发配对事件） */
  function touchPeer(peerId, patch = {}) {
    const rec = peers[String(peerId || '')];
    if (!rec) return null;
    if (patch.ip) rec.ip = patch.ip;
    if (patch.port) rec.port = Number(patch.port) || rec.port;
    if (patch.name) rec.name = patch.name;
    rec.lastSeen = nowIso();
    saveTrust();
    return rec;
  }

  return {
    ensureCode,
    regenerateCode,
    pairingInfo,
    qrPayload,
    verifyCode,
    listTrusted,
    isTrusted,
    getPeer,
    callTarget,
    trustPeer,
    acceptInbound,
    initiate,
    authPeerToken,
    revoke,
    touchPeer,
    trustFile,
    consumeCode,
    stats: () => ({
      trusted: Object.keys(peers).length,
      codeExpiresAt: currentCode ? new Date(currentCode.expiresAt).toISOString() : null,
      codeUsed: currentCode ? !!currentCode.used : false,
      oneTime: true,
      lastPairedAt: lastPairedAt || null,
    }),
  };
}