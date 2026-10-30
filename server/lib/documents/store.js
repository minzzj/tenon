// V5 · 文档中心本地存储：data/documents/<id>/summary.{json,md,docx,pdf}
import fs from 'node:fs';
import path from 'node:path';

export function createDocumentsStore({ dataDir, ledger = null } = {}) {
  const dir = path.join(dataDir, 'documents');
  fs.mkdirSync(dir, { recursive: true });
  const dirOf = (id) => path.join(dir, String(id));
  const fileOf = (id, format) => path.join(dirOf(id), 'summary.' + format);

  function list({ since = '', limit = 100 } = {}) {
    let ids = [];
    try { ids = fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'summary.json'))); } catch { ids = []; }
    const items = [];
    for (const id of ids) {
      try { items.push(JSON.parse(fs.readFileSync(fileOf(id, 'json'), 'utf8'))); } catch { /* skip */ }
    }
    let out = items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (since) { const t = new Date(since).getTime(); if (Number.isFinite(t)) out = out.filter((x) => new Date(x.createdAt).getTime() > t); }
    const lim = Math.max(1, Math.min(200, Number(limit) || 100));
    return { items: out.slice(0, lim), total: out.length, since: since || null };
  }

  function get(id) {
    if (!id || !/^[A-Za-z0-9_-]+$/.test(String(id))) return null;
    const metaFile = fileOf(id, 'json');
    if (!fs.existsSync(metaFile)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      const files = {};
      for (const fmt of ['md', 'docx', 'pdf']) { const f = fileOf(id, fmt); if (fs.existsSync(f)) files[fmt] = { size: fs.statSync(f).size, file: path.relative(dataDir, f).split(path.sep).join('/') }; }
      return { ...meta, files, downloads: { md: '/api/v2/documents/' + id + '/download?format=md', docx: '/api/v2/documents/' + id + '/download?format=docx', pdf: '/api/v2/documents/' + id + '/download?format=pdf' } };
    } catch { return null; }
  }

  function save({ id, meta, markdown, docxBuffer, pdfBuffer }) {
    const d = dirOf(id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(fileOf(id, 'md'), String(markdown || ''), 'utf8');
    if (docxBuffer) fs.writeFileSync(fileOf(id, 'docx'), docxBuffer);
    if (pdfBuffer) fs.writeFileSync(fileOf(id, 'pdf'), pdfBuffer);
    const files = {};
    for (const fmt of ['md', 'docx', 'pdf']) { const f = fileOf(id, fmt); if (fs.existsSync(f)) files[fmt] = { size: fs.statSync(f).size }; }
    const full = { ...meta, files, createdAt: meta.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    fs.writeFileSync(fileOf(id, 'json'), JSON.stringify(full, null, 2), 'utf8');
    try { if (ledger && typeof ledger.append === 'function') ledger.append('document.created', { id, kind: full.kind, title: full.title, date: full.date, provider: full.provider, degraded: !!full.degraded, files: Object.keys(files), chars: String(markdown || '').length }, 'documents'); } catch { /* ignore */ }
    return full;
  }

  function remove(id) {
    const d = dirOf(id);
    if (!fs.existsSync(d)) return false;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { return false; }
    try { if (ledger && typeof ledger.append === 'function') ledger.append('document.deleted', { id }, 'documents'); } catch { /* ignore */ }
    return true;
  }

  function pathOf(id, format) {
    const fmt = ['md', 'docx', 'pdf'].includes(String(format)) ? String(format) : null;
    if (!fmt) return null;
    const f = fileOf(id, fmt);
    return fs.existsSync(f) ? f : null;
  }

  return { dir, list, get, save, remove, pathOf, fileOf, dirOf };
}

export default createDocumentsStore;