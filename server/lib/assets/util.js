// 榫卯 v2 · 素材中心 · 基础工具
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写 JSON：临时文件 + rename（Windows 上带回退），失败重试 3 次。 */
export function writeJsonAtomic(file, value, { pretty = false } = {}) {
  ensureDir(path.dirname(file));
  const body = JSON.stringify(value, null, pretty ? 2 : 0) + '\n';
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  fs.writeFileSync(tmp, body, 'utf8');
  let lastErr = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      lastErr = err;
    }
  }
  // 回退：直接覆盖写（极端情况下 rename 被安全软件占用）
  try {
    fs.writeFileSync(file, body, 'utf8');
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return true;
  } catch (err) {
    lastErr = err;
  }
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  throw lastErr || new Error('原子写失败：' + file);
}

export function toPosix(p) {
  return String(p || '').split(path.sep).join('/');
}

export function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

export function newId(prefix = 'asset', now = Date.now()) {
  return prefix + '_' + now.toString(36) + Math.random().toString(36).slice(2, 8);
}

const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/g;

export function safeFileName(name) {
  const cleaned = String(name || 'file').replace(BAD_NAME, '_').trim();
  return (cleaned || 'file').slice(0, 120);
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}