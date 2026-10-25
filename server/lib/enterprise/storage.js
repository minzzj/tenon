// 企业控制面 · 持久化工具：读 JSON / 原子写 JSON
// 说明：v2 契约要求 data/enterprise/*.json 原子写；先写临时文件再 rename，避免半写坏文件。
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
