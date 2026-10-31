// V5 · 文档中心本地存储：data/documents/<id>/summary.{json,md,docx,pdf}
// P1 修复（S-03/S-04）：id 统一白名单 + path.resolve 前缀校验；get/save/remove/pathOf 全部走同一入口，
// 越界或非法 id 一律返回 null/false（路由层返回 400），绝不把 `..`、`..\` 拼进 rmSync/readFileSync。
import fs from 'node:fs';
import path from 'node:path';
import { isValidDocId, safeChild, FORMATS } from './safe-path.js';

// documents/<id>/summary.<fmt>：md/docx/pdf 供下载，json 为元数据
const FILE_FORMATS = ['md', 'docx', 'pdf', 'json'];

function formatOf(format) {
  const fmt = String(format == null ? '' : format).toLowerCase();
  return FILE_FORMATS.includes(fmt) ? fmt : null;
}

export function createDocumentsStore({ dataDir, ledger = null } = {}) {
  const dir = path.join(dataDir, 'documents');
  fs.mkdirSync(dir, { recursive: true });
  const root = path.resolve(dir);

  // 唯一入口：id 必须命中白名单，且解析后严格位于 documents/ 之内；不满足返回 null。
  function dirOf(id) {
    const key = typeof id === 'string' ? id : String(id == null ? '' : id);
    if (!isValidDocId(key)) return null;
    return safeChild(root, key);
  }

  function fileOf(id, format) {
    const d = dirOf(id);
    const fmt = formatOf(format);
    if (!d || !fmt) return null;
    return safeChild(d, 'summary.' + fmt);
  }

  function list({ since = '', limit = 100 } = {}) {
    let ids = [];
    try { ids = fs.readdirSync(root).filter((n) => isValidDocId(n) && fs.existsSync(path.join(root, n, 'summary.json'))); } catch { ids = []; }
    const items = [];
    for (const id of ids) {
      const metaFile = fileOf(id, 'json');
      if (!metaFile) continue;
      try { items.push(JSON.parse(fs.readFileSync(metaFile, 'utf8'))); } catch { /* skip */ }
    }
    let out = items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (since) { const t = new Date(since).getTime(); if (Number.isFinite(t)) out = out.filter((x) => new Date(x.createdAt).getTime() > t); }
    const lim = Math.max(1, Math.min(200, Number(limit) || 100));
    return { items: out.slice(0, lim), total: out.length, since: since || null };
  }

  function get(id) {
    const metaFile = fileOf(id, 'json');
    if (!metaFile || !fs.existsSync(metaFile)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      const key = String(id);
      const files = {};
      for (const fmt of FORMATS) {
        const f = fileOf(key, fmt);
        if (f && fs.existsSync(f)) files[fmt] = { size: fs.statSync(f).size, file: path.relative(dataDir, f).split(path.sep).join('/') };
      }
      return { ...meta, files, downloads: { md: '/api/v2/documents/' + key + '/download?format=md', docx: '/api/v2/documents/' + key + '/download?format=docx', pdf: '/api/v2/documents/' + key + '/download?format=pdf' } };
    } catch { return null; }
  }

  function save({ id, meta = {}, markdown, docxBuffer, pdfBuffer }) {
    const d = dirOf(id);
    const metaFile = d ? fileOf(id, 'json') : null;
    if (!d || !metaFile) {
      const err = new Error('文档 id 不合法');
      err.statusCode = 400;
      err.code = 'BAD_DOCUMENT_ID';
      throw err;
    }
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(fileOf(id, 'md'), String(markdown || ''), 'utf8');
    if (docxBuffer) fs.writeFileSync(fileOf(id, 'docx'), docxBuffer);
    if (pdfBuffer) fs.writeFileSync(fileOf(id, 'pdf'), pdfBuffer);
    const files = {};
    for (const fmt of FORMATS) { const f = fileOf(id, fmt); if (f && fs.existsSync(f)) files[fmt] = { size: fs.statSync(f).size }; }
    const full = { ...meta, files, createdAt: meta.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    fs.writeFileSync(metaFile, JSON.stringify(full, null, 2), 'utf8');
    try { if (ledger && typeof ledger.append === 'function') ledger.append('document.created', { id, kind: full.kind, title: full.title, date: full.date, provider: full.provider, degraded: !!full.degraded, files: Object.keys(files), chars: String(markdown || '').length }, 'documents'); } catch { /* ignore */ }
    return full;
  }

  function remove(id) {
    const d = dirOf(id);
    if (!d) return false;
    // 双重保险：只允许删除 documents/ 下的子目录，任何越界解析结果都不落到 rmSync。
    const rel = path.relative(root, d);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    if (!fs.existsSync(d)) return false;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { return false; }
    try { if (ledger && typeof ledger.append === 'function') ledger.append('document.deleted', { id }, 'documents'); } catch { /* ignore */ }
    return true;
  }

  function pathOf(id, format) {
    const fmt = formatOf(format);
    if (!FORMATS.includes(fmt)) return null;
    const f = fileOf(id, fmt);
    if (!f) return null;
    try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
  }

  return { dir, root, list, get, save, remove, pathOf, fileOf, dirOf, isValidId: isValidDocId };
}

export default createDocumentsStore;
