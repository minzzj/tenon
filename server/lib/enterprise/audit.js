// 企业控制面 · 审计导出（复用现有 ledger 事件，按保留期过滤；csv/json/md 三种格式）
// 导出本身是只读动作：不 append 账本事件（与 v0.1 /api/audit/export 不同，避免 GET 写账本）。
export const AUDIT_FORMATS = Object.freeze(['csv', 'json', 'md']);

export function retentionCutoff(retentionDays, now = new Date()) {
  const days = Number(retentionDays);
  const safeDays = Number.isFinite(days) && days > 0 ? days : 7;
  return new Date(now.getTime() - safeDays * 86400000);
}

export function filterByRetention(events, { retentionDays = 7, now = new Date() } = {}) {
  const list = Array.isArray(events) ? events : [];
  const cutoff = retentionCutoff(retentionDays, now).getTime();
  return list.filter((ev) => {
    const t = Date.parse(ev && ev.at);
    if (!Number.isFinite(t)) return true; // 时间不可解析时保留，避免静默丢审计
    return t >= cutoff;
  });
}

export function collectAuditEvents(ledger, { retentionDays = 7, now = new Date() } = {}) {
  const events = ledger && Array.isArray(ledger.events) ? ledger.events : (Array.isArray(ledger) ? ledger : []);
  return filterByRetention(events, { retentionDays, now });
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return '"' + s.replace(/"/g, '""') + '"';
}

export function toCsv(events) {
  const lines = ['seq,at,type,actor,data'];
  for (const ev of events) {
    lines.push([ev.seq, ev.at, ev.type, ev.actor, JSON.stringify(ev.data == null ? {} : ev.data)].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

export function toJson(events, meta = {}) {
  return JSON.stringify({
    exportedAt: meta.exportedAt || new Date().toISOString(),
    retentionDays: meta.retentionDays,
    dataDomain: meta.dataDomain || '',
    count: events.length,
    events,
  }, null, 2) + '\n';
}

export function toMarkdown(events, meta = {}) {
  const lines = [
    '# 企业审计导出',
    '',
    `- 导出时间：${meta.exportedAt || new Date().toISOString()}`,
    `- 审计保留期：${meta.retentionDays} 天`,
    `- 数据域：${meta.dataDomain || '未标记'}`,
    `- 事件数：${events.length}`,
    '',
    '| seq | 时间 | 类型 | 执行者 | 数据摘要 |',
    '|---|---|---|---|---|',
  ];
  const shown = events.slice(-500);
  for (const ev of shown) {
    const summary = JSON.stringify(ev.data == null ? {} : ev.data).slice(0, 100).replace(/\|/g, '/');
    lines.push(`| ${ev.seq} | ${ev.at} | ${ev.type} | ${ev.actor} | ${summary} |`);
  }
  if (events.length > shown.length) lines.push('', `> 仅展示最近 ${shown.length} 条（共 ${events.length} 条）；完整数据请导出 JSON/CSV。`);
  return lines.join('\n') + '\n';
}

/**
 * 组装导出结果（不落盘、不写账本）。
 * @returns {{ok:true,format:string,contentType:string,filename:string,body:string,count:number,retentionDays:number,generatedAt:string}}
 */
export function exportAudit({ events = [], format = 'json', retentionDays = 7, dataDomain = '', now = new Date() } = {}) {
  const fmt = String(format || 'json').toLowerCase();
  if (!AUDIT_FORMATS.includes(fmt)) {
    return { ok: false, code: 'invalid_format', errors: [`format 只能是 ${AUDIT_FORMATS.join('/')}`] };
  }
  const filtered = filterByRetention(events, { retentionDays, now });
  const generatedAt = now.toISOString();
  const meta = { exportedAt: generatedAt, retentionDays, dataDomain };
  const stamp = generatedAt.replace(/[:]/g, '-').slice(0, 19);
  if (fmt === 'csv') {
    return { ok: true, format: fmt, contentType: 'text/csv; charset=utf-8', filename: `tenon-enterprise-audit-${stamp}.csv`, body: toCsv(filtered), count: filtered.length, retentionDays, generatedAt };
  }
  if (fmt === 'md') {
    return { ok: true, format: fmt, contentType: 'text/markdown; charset=utf-8', filename: `tenon-enterprise-audit-${stamp}.md`, body: toMarkdown(filtered, meta), count: filtered.length, retentionDays, generatedAt };
  }
  return { ok: true, format: 'json', contentType: 'application/json; charset=utf-8', filename: `tenon-enterprise-audit-${stamp}.json`, body: toJson(filtered, meta), count: filtered.length, retentionDays, generatedAt };
}

export const DENIED_EVENT = 'enterprise.denied';
