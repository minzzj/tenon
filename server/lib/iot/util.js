// 榫卯 V5 · IoT 模块公共工具
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function httpError(statusCode, message, code) {
  const err = new Error(message || `HTTP ${statusCode}`);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

export function nowIso() {
  return new Date().toISOString();
}

export function newIotId(prefix = 'iot') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

// token / password 脱敏：只保留末 4 位
export function maskSecret(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 4) return '••••';
  return `••••${raw.slice(-4)}`;
}

export function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function pickString(value, max = 200) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  return raw.slice(0, max);
}

export function shortHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 10);
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export default { readJson, atomicWriteJson, httpError, nowIso, newIotId, maskSecret, clampInt, pickString, shortHash, safeJsonParse };