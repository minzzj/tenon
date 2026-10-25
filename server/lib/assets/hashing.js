// 榫卯 v2 · 素材中心 · 流式 SHA-256 与去重键
import fs from 'node:fs';
import crypto from 'node:crypto';

/** 对 Buffer 直接算 sha256。 */
export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 流式哈希一个文件（不会整文件读入内存），返回 { sha256, size }。
 * @param {string} filePath
 * @param {{highWaterMark?: number}} [opts]
 */
export function sha256Stream(filePath, opts = {}) {
  const hash = crypto.createHash('sha256');
  return new Promise((resolve, reject) => {
    let size = 0;
    const stream = fs.createReadStream(filePath, opts.highWaterMark ? { highWaterMark: opts.highWaterMark } : undefined);
    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.once('error', reject);
    stream.once('end', () => resolve({ sha256: hash.digest('hex'), size }));
  });
}

/** 哈希文件 + stat（mtime 用于记录来源时光）。 */
export async function hashFile(filePath) {
  const stat = await fs.promises.stat(filePath);
  const { sha256, size } = await sha256Stream(filePath);
  return { sha256, size: size || stat.size, mtimeMs: stat.mtimeMs, statSize: stat.size };
}

/** 去重键：内容哈希一致 = 同一素材（大小写归一）。 */
export function dedupeKey(sha256) {
  return 'sha256:' + String(sha256 || '').toLowerCase();
}