// 榫卯 Tenon v2 · link 工具函数（零依赖，只用 node: 内置模块）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写 JSON（先写临时文件再 rename），崩溃时不会留下半截文件 */
export function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function httpError(statusCode, message) {
  const err = new Error(message || 'HTTP ' + statusCode);
  err.statusCode = statusCode;
  return err;
}

export function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendBuffer(res, statusCode, buffer, type = 'application/octet-stream') {
  res.writeHead(statusCode, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(buffer);
}

/** 读请求体（默认上限 8MB），返回 Buffer */
export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, '请求体过大（上限 ' + Math.round(limit / 1024 / 1024) + 'MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw httpError(400, '请求体不是合法 JSON');
  }
}

/** 文件名安全化：去目录、替换非法字符、限长，防路径穿越 */
export function sanitizeName(name, fallback = 'unnamed') {
  const raw = String(name == null ? '' : name).trim();
  const base = raw.split(/[\\/]/).filter(Boolean).pop() || '';
  const safe = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '_').slice(0, 120);
  return safe || fallback;
}

export function humanSpeed(bps) {
  const n = Number(bps) || 0;
  if (n <= 0) return '0 B/s';
  if (n < 1024) return n.toFixed(0) + ' B/s';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB/s';
  return (n / 1024 / 1024).toFixed(2) + ' MB/s';
}

/** 本机首个非回环 IPv4（用于 QR payload 给手机一个可连地址） */
export function localIPv4() {
  const fallback = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
      if (item.family === 'IPv4') fallback.push(item.address);
    }
  }
  return fallback[0] || '127.0.0.1';
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}