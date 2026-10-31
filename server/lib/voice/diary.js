// 榫卯 V3 · 每晚总结 / 日记生成（DeepSeek 优先，本地 Qwen / 模板降级）
// 数据来源：data/voice/transcripts/YYYY-MM-DD.jsonl（本地）+ state.voice.screenLog + 当日任务/审计事件。
// 产物：data/voice/diary/YYYY-MM-DD.md + 账本 voice.diary（kind=report/diary）；隐私过滤后只发聚合摘要给模型。
import fs from 'node:fs';
import path from 'node:path';
import { replay } from '../state.js';
import { nowIso } from '../link/util.js';
import { filterTranscript, dayKey } from './store.js';
import { resolvePrompts } from './prompts.js';
import { structuredFromMarkdown, generateDocumentFromMarkdown } from '../documents/generate.js';
import { isRealDay, safeChild } from '../documents/safe-path.js';

export const DIARY_VERSION = '3.0.0';

const TASK_EVENT_TYPES = new Set(['task.drafted', 'task.queued', 'task.started', 'task.succeeded', 'task.failed', 'task.cancelled', 'super.asked', 'super.handoff', 'scene.ran', 'device.bound', 'device.unbound', 'transfer.completed', 'clipboard.shared', 'voice.command', 'voice.reply']);

function isoDayOf(at) {
  try { return dayKey(new Date(at)); } catch { return ''; }
}

export function createDiaryGenerator({ root, dataDir, ledger, getState, workers, ai, getConfig, appendEvent, log = console }) {
  const dir = path.join(dataDir, 'voice', 'diary');
  fs.mkdirSync(dir, { recursive: true });

  // P1 修复（S-04）：date 必须 ^\d{4}-\d{2}-\d{2}$ 且是真实日历日期（用 UTC 判定，避免本地时区把合法日期判成非法）。
  function isValidDay(v) { return isRealDay(String(v == null ? '' : v)); }
  function assertDay(v) {
    if (!isValidDay(v)) { const e = new Error('非法日期格式（应为 YYYY-MM-DD 且真实日期）'); e.statusCode = 400; e.code = 'BAD_DATE'; throw e; }
    return String(v);
  }
  // 拼接后再做前缀校验：解析结果必须仍在 voice/diary 之下。
  function fileOf(date) {
    const day = assertDay(date);
    return safeChild(path.resolve(dir), day + '.md');
  }

  function transcriptDigest(date) {
    assertDay(date);
    const file = safeChild(path.resolve(dataDir, 'voice', 'transcripts'), String(date) + '.jsonl');
    if (!file) return [];
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    const items = [];
    for (const line of lines.slice(-400)) {
      try {
        const it = JSON.parse(line);
        const text = String(it.text || '').trim();
        if (!text) continue;
        // 二次隐私过滤（防御：历史文件被手工加过敏感内容）
        const safe = filterTranscript(text).redacted ? '（敏感内容已过滤）' : text;
        items.push({ at: it.at || '', text: safe, wake: !!it.wake, source: it.source || 'mic' });
      } catch { /* skip */ }
    }
    return items;
  }

  function screenDigest(date) {
    assertDay(date);
    // V4：优先读 data/voice/screen/YYYY-MM-DD.jsonl（字库 OCR 采集全文），回退 state.voice.screenLog
    const out = [];
    try {
      const file = safeChild(path.resolve(dataDir, 'voice', 'screen'), String(date) + '.jsonl');
      if (file && fs.existsSync(file)) {
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-600);
        for (const line of lines) {
          try {
            const it = JSON.parse(line);
            const text = String(it.text || '').trim();
            if (!text) continue;
            const safe = filterTranscript(text).redacted ? '（敏感内容已过滤）' : text;
            out.push({ at: it.at || '', hour: String(it.at || '').slice(11, 13), app: String(it.app || '').slice(0, 40), title: String(it.title || '').slice(0, 100), text: safe.slice(0, 200), confidence: it.confidence || null });
          } catch { /* skip */ }
        }
      }
      if (out.length) return out;
      const st = getState ? getState() : replay(ledger.events);
      const list = (st && st.voice && st.voice.screenLog) || [];
      return list.filter((x) => isoDayOf(x.at) === date).slice(-60).map((x) => ({ at: x.at, hour: String(x.at || '').slice(11, 13), app: x.app || '', title: '', text: filterTranscript(String(x.text || '')).redacted ? '（敏感内容已过滤）' : String(x.text || '').slice(0, 200) }));
    } catch {
      return out;
    }
  }

  function screenSummaryLines(items) {
    // 按小时聚合「今天看了什么」：每小时列出 app + 标题/文本片段（供 DeepSeek 总结视频/网页内容）
    const byHour = new Map();
    for (const it of items) {
      const hour = it.hour || String(it.at || '').slice(11, 13) || '--';
      if (!byHour.has(hour)) byHour.set(hour, []);
      const line = '[' + (it.app || '屏幕') + '] ' + (it.title ? it.title + '：' : '') + String(it.text || '').slice(0, 120);
      const arr = byHour.get(hour);
      if (arr.length < 6) arr.push(line);
    }
    const out = [];
    for (const [hour, lines] of Array.from(byHour.entries()).sort()) out.push('- ' + hour + ' 时：' + lines.join('；'));
    return out;
  }

  function eventsDigest(date) {
    const out = [];
    try {
      for (const ev of (ledger && ledger.events) || []) {
        if (!TASK_EVENT_TYPES.has(ev.type)) continue;
        if (isoDayOf(ev.at) !== date) continue;
        const d = ev.data || {};
        let line = ev.type;
        if (ev.type === 'voice.command') line += '：' + String(d.text || '').slice(0, 120) + ' → ' + String(d.reply || '').slice(0, 120) + '（provider=' + (d.provider || '') + '）';
        else if (ev.type === 'task.succeeded' || ev.type === 'task.failed') line += '：' + String((d.result && d.result.summary) || d.error || d.taskId || '').slice(0, 160);
        else if (ev.type === 'super.asked') line += '：' + String(d.text || '').slice(0, 120);
        else if (ev.type === 'scene.ran') line += '：' + String(d.sceneId || '') + ' ok=' + (d.ok !== false);
        else if (ev.type === 'device.bound' || ev.type === 'device.unbound') line += '：' + String(d.deviceId || '') + ' ' + String(d.name || '');
        else line += '：' + String(d.summary || d.taskId || '').slice(0, 120);
        out.push({ at: ev.at, line });
      }
    } catch { /* ignore */ }
    return out.slice(-120);
  }

  function buildDigest(date) {
    const tr = transcriptDigest(date);
    const sc = screenDigest(date);
    const ev = eventsDigest(date);
    const parts = [];
    parts.push('日期：' + date);
    parts.push('语音转写（' + tr.length + ' 条）：');
    for (const t of tr.slice(-120)) parts.push('- ' + String(t.at).slice(11, 19) + ' [' + t.source + (t.wake ? '/唤醒' : '') + '] ' + t.text);
    parts.push('屏幕文本（今天看了什么，按小时，共 ' + sc.length + ' 条）：');
    for (const line of screenSummaryLines(sc)) parts.push(line);
    parts.push('屏幕文本明细（最近 40 条）：');
    for (const s of sc.slice(-40)) parts.push('- ' + String(s.at).slice(11, 19) + ' ' + (s.app ? '[' + s.app + '] ' : '') + (s.title ? s.title + '：' : '') + s.text);
    parts.push('任务与审计事件（' + ev.length + ' 条）：');
    for (const e of ev.slice(-100)) parts.push('- ' + String(e.at).slice(11, 19) + ' ' + e.line);
    parts.push('设备状态：' + JSON.stringify((() => { try { const st = getState ? getState() : replay(ledger.events); return Object.values((st && st.nodes) || {}).map((n) => ({ name: n.name, online: !!n.online, bound: !!(n.id && (st.devices || {}).bindings && st.devices.bindings[n.id]) })); } catch { return []; } })()).slice(0, 1500));
    const digest = parts.join('\n');
    return digest.length > 6000 ? digest.slice(0, 6000) + '\n（数据截断）' : digest;
  }

  function renderTemplate(date, digest, reason) {
    const lines = [];
    lines.push('# 今日报告 · ' + date);
    lines.push('');
    lines.push('## 一句话总结');
    lines.push('今天的语音与设备活动已按本地记录整理（模型不可用，使用模板记录，原因：' + reason + '）。');
    lines.push('');
    lines.push('## 今天做了什么');
    const summaryLines = digest.split('\n').filter((l) => l.startsWith('- ')).slice(0, 6);
    if (summaryLines.length) lines.push(...summaryLines); else lines.push('- 未记录');
    lines.push('');
    lines.push('## 重要事件与决定');
    lines.push('无');
    lines.push('');
    lines.push('## 未完成与风险');
    lines.push('- 未记录');
    lines.push('');
    lines.push('## 明天要做什么');
    lines.push('1. 优先处理昨天未完成的语音命令');
    lines.push('2. 检查设备在线与语音服务状态');
    lines.push('3. 需要时重新生成今日总结');
    lines.push('');
    lines.push('## 日记');
    lines.push('今天我把听到的、做的事都记在了本机。数据不多的时候，安静地记下一条也算数。');
    lines.push('');
    lines.push('## 给用户的建议');
    lines.push('有空时说一声「榫卯」，让我把今天发生的事讲给你听。');
    return lines.join('\n');
  }

  async function generate({ date = dayKey(), by = 'scheduler', force = false } = {}) {
    // 非法 date 返回错误对象（路由层转 400），不抛异常，避免 v2 分发层把 400 吞成 500。
    const targetDate = String(date == null || date === '' ? dayKey() : date);
    if (!isValidDay(targetDate)) return { ok: false, date: targetDate, error: 'date 必须是 YYYY-MM-DD 且为真实日期', code: 'BAD_DATE' };
    const file = fileOf(targetDate);
    if (!file) return { ok: false, date: targetDate, error: 'date 必须是 YYYY-MM-DD 且为真实日期', code: 'BAD_DATE' };
    if (!force && fs.existsSync(file) && fs.statSync(file).size > 0) {
      const existingMd = fs.readFileSync(file, 'utf8');
      return { ok: true, already: true, date: targetDate, path: path.relative(root, file).split(path.sep).join('/'), provider: 'existing', structured: structuredFromMarkdown(existingMd) };
    }
    const cfg = typeof getConfig === 'function' ? getConfig() : {};
    const prompts = resolvePrompts(cfg);
    const digest = buildDigest(targetDate);
    let markdown = '';
    let provider = 'template';
    let error = null;
    let latencyMs = 0;
    const started = Date.now();
    // 1) DeepSeek（云端只接收聚合摘要，不接收原始转写全量外发之外的敏感内容；已过滤）
    if (ai && typeof ai.chat === 'function' && ai.available) {
      try {
        const res = await ai.chat([
          { role: 'system', content: prompts.nightly },
          { role: 'user', content: '以下是 ' + targetDate + ' 的当日数据：\n' + digest },
        ], { maxTokens: 1400, temperature: 0.4, place: 'voice-diary' });
        if (res && res.text && res.text.trim().length > 80) { markdown = res.text.trim(); provider = 'deepseek'; }
      } catch (err) {
        error = String((err && err.message) || err).slice(0, 200);
      }
    }
    // 2) 本地 Qwen（降级）
    if (!markdown && workers && workers.state && workers.state.llm.state === 'running') {
      try {
        const res = await workers.chat([
          { role: 'system', content: prompts.nightly },
          { role: 'user', content: '以下是当日数据（可能不完整）：\n' + digest.slice(0, 2500) },
        ], { maxTokens: 900, timeoutMs: 120000 });
        if (res && res.text && res.text.trim().length > 60) { markdown = res.text.trim(); provider = 'local'; }
      } catch (err) {
        error = (error ? error + '；' : '') + 'local: ' + String((err && err.message) || err).slice(0, 160);
      }
    }
    // 3) 模板
    if (!markdown) { markdown = renderTemplate(targetDate, digest, error || '无可用模型'); provider = 'template'; }
    latencyMs = Date.now() - started;
    const header = markdown.startsWith('#') ? markdown : '# 今日报告 · ' + targetDate + '\n\n' + markdown;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, header + '\n\n<!-- provider=' + provider + ' generatedAt=' + nowIso() + ' -->\n', 'utf8');
    const summary = (header.split('\n').find((l) => l.trim().length > 8) || '今日总结').replace(/^#+\s*/, '').slice(0, 160);
    const relPath = path.relative(root, file).split(path.sep).join('/');
    appendEvent('voice.diary', { date: targetDate, kind: 'report', path: relPath, summary, provider, latencyMs, by });
    // 日记段单独一条事件（kind=diary），便于 UI/验收查
    const diaryMatch = header.match(/## 日记\s*\n([\s\S]*?)(?=\n## |$)/);
    const diaryText = diaryMatch ? diaryMatch[1].trim() : '';
    appendEvent('voice.diary', { date: targetDate, kind: 'diary', path: relPath, summary: (diaryText || summary).slice(0, 200), provider, latencyMs, by });
    // V5 结构化总结：解析摘要/重点/待办/回顾/日记，并同时生成文档（md/docx/pdf）
    const structured = structuredFromMarkdown(header);
    let documentInfo = null;
    let documentError = null;
    try {
      const doc = await generateDocumentFromMarkdown({ dataDir, ledger, kind: 'daily', date: targetDate, title: '每日总结 · ' + targetDate, markdown: header, provider, degraded: provider === 'template' });
      documentInfo = { id: doc.id, title: doc.title, provider: doc.provider, degraded: !!doc.degraded, downloads: doc.downloads || { md: '/api/v2/documents/' + doc.id + '/download?format=md', docx: '/api/v2/documents/' + doc.id + '/download?format=docx', pdf: '/api/v2/documents/' + doc.id + '/download?format=pdf' }, files: Object.keys(doc.files || {}) };
      appendEvent('voice.diary', { date: targetDate, kind: 'document', path: relPath, summary: ('结构化文档：' + doc.title).slice(0, 200), provider: doc.provider, latencyMs, by, documentId: doc.id, structuredSummary: structured.摘要 || '' });
    } catch (err) {
      documentError = String((err && err.message) || err).slice(0, 200);
    }
    appendEvent('voice.diary', { date: targetDate, kind: 'structured', path: relPath, summary: (structured.摘要 || summary).slice(0, 200), provider, latencyMs, by, structured: { 摘要: structured.摘要, 重点: (structured.重点 || []).slice(0, 8), 待办: (structured.待办 || []).slice(0, 8), 回顾: (structured.回顾 || []).slice(0, 8), 日记: (structured.日记 || '').slice(0, 2400) }, documentId: documentInfo ? documentInfo.id : null });
    log('[voice] 日报/日记已生成 ' + targetDate + ' provider=' + provider + ' chars=' + header.length + (documentInfo ? ' document=' + documentInfo.id : '') + (error ? ' fallbackReason=' + error : ''));
    return { ok: true, already: false, date: targetDate, path: relPath, provider, chars: header.length, latencyMs, summary, fallbackReason: error, structured, degraded: provider !== 'deepseek', documentId: documentInfo ? documentInfo.id : null, document: documentInfo, downloads: documentInfo ? documentInfo.downloads : null, documentError };
  }

  function read(date = dayKey()) {
    // 非法 date 不触碰文件系统，直接返回错误对象（路由层转 400），不再向上抛异常。
    const day = String(date == null || date === '' ? dayKey() : date);
    if (!isValidDay(day)) return { ok: false, date: day, error: 'date 必须是 YYYY-MM-DD 且为真实日期', code: 'BAD_DATE' };
    const file = fileOf(day);
    if (!file) return { ok: false, date: day, error: 'date 必须是 YYYY-MM-DD 且为真实日期', code: 'BAD_DATE' };
    if (!fs.existsSync(file)) return { ok: true, date: day, exists: false, markdown: '', path: path.relative(root, file).split(path.sep).join('/') };
    return { ok: true, date: day, exists: true, markdown: fs.readFileSync(file, 'utf8'), path: path.relative(root, file).split(path.sep).join('/'), updatedAt: fs.statSync(file).mtime.toISOString() };
  }

  function list(limit = 14) {
    try {
      return fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)).sort().reverse().slice(0, Math.max(1, Number(limit) || 14)).map((n) => ({ date: n.replace(/\.md$/, ''), path: path.relative(root, path.join(dir, n)).split(path.sep).join('/') }));
    } catch { return []; }
  }

  function diaryTimeOf(cfg = {}) {
    const raw = String((cfg.diary && cfg.diary.time) || '23:00');
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    return { raw: m ? raw : '23:00', minutes: m ? Number(m[1]) * 60 + Number(m[2]) : 23 * 60 };
  }

  function dueNow(now = new Date()) {
    const cfg = typeof getConfig === 'function' ? getConfig() : {};
    if (!(cfg.diary && cfg.diary.enabled !== false)) return false;
    const t = diaryTimeOf(cfg);
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return nowMin >= t.minutes;
  }

  function shouldGenerateToday(now = new Date()) {
    const cfg = typeof getConfig === 'function' ? getConfig() : {};
    if (!(cfg.diary && cfg.diary.enabled !== false)) return false;
    const date = dayKey(now);
    const file = fileOf(date);
    if (file && fs.existsSync(file) && fs.statSync(file).size > 0) return false;
    return dueNow(now);
  }

  return { dir, fileOf, generate, read, list, buildDigest, dueNow, shouldGenerateToday, diaryTimeOf };
}

export default createDiaryGenerator;