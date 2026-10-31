// V5 · 路径安全统一校验（S-03 / S-04 P1 修复）
// 被 server/lib/documents/* 与 server/lib/voice/{store,diary}.js 共用：
//   - 文档 id：^[A-Za-z0-9_-]{4,80}$
//   - 语音日记 / 转写 / 屏幕文本 date：^\d{4}-\d{2}-\d{2}$ 且为真实日历日期
//   - 一切拼接后的路径必须 path.resolve 归一化，并严格位于给定根目录之下（startsWith(root + sep)）
// 只依赖 node:path，无副作用，可被任意模块安全导入。
import path from 'node:path';

/** 文档 id 白名单：与 generate.js 生成的 doc_<yyyyMMdd>_<base36> 兼容 */
export const DOC_ID_RE = /^[A-Za-z0-9_-]{4,80}$/;
/** 语音日记 / 转写 / 屏幕文本日期白名单 */
export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 文档下载格式白名单 */
export const FORMATS = ['md', 'docx', 'pdf'];

export function isValidDocId(id) {
  if (typeof id !== 'string') return false;
  if (id.length < 4 || id.length > 80) return false;
  return DOC_ID_RE.test(id);
}

/** 真实日历日期：拒绝 2026-13-40、2026-02-31 这类「格式对但不存在」的日期 */
export function isRealDay(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  if (y < 1970 || y > 9999) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function withinRoot(root, target) {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target !== root && target.startsWith(prefix);
}

/**
 * 把单个 name 安全拼到 root 之下：解析后必须严格位于 root 内部（不允许等于 root，不允许 .. 越界）。
 * 不合法返回 null（调用方负责拒绝，绝不落到 fs 调用）。
 */
export function safeChild(root, name) {
  if (typeof name !== 'string' || !name) return null;
  const base = path.resolve(root);
  let target;
  try { target = path.resolve(base, name); } catch { return null; }
  return withinRoot(base, target) ? target : null;
}

/** 多段拼接版本（调用方仍需先白名单校验各段来自不可信输入的部分） */
export function safeJoin(root, ...parts) {
  const base = path.resolve(root);
  let target;
  try { target = path.resolve(base, ...parts.map((x) => String(x == null ? '' : x))); } catch { return null; }
  return withinRoot(base, target) ? target : null;
}

export function isDownloadFormat(format) {
  return FORMATS.includes(String(format == null ? '' : format).toLowerCase());
}

export default { DOC_ID_RE, DAY_RE, FORMATS, isValidDocId, isRealDay, safeChild, safeJoin, isDownloadFormat };
