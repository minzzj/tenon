// V5 · 结构化总结与文档生成：DeepSeek → {摘要,重点[],待办[],回顾[],日记} → md/docx/pdf
import fs from 'node:fs';
import path from 'node:path';
import * as docxPkg from 'docx';
import PDFDocument from 'pdfkit';
import { createNotesStore } from '../notes/store.js';
import { mergeScreens, formatScreenGroup } from './screen-merge.js';
import { createDocumentsStore } from './store.js';
import { isRealDay, isValidDocId } from './safe-path.js';

const { Document, Packer, Paragraph, HeadingLevel, TextRun } = docxPkg;
const CN_FONT = 'C:\\Windows\\Fonts\\simhei.ttf';

function pad(n) { return String(n).padStart(2, '0'); }
function localDay(iso) { const d = iso ? new Date(iso) : new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function readJsonLines(file, limit = 300) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== '{') continue;
    let depth = 0;
    for (let i = start; i < raw.length; i += 1) {
      if (raw[i] === '{') depth += 1;
      else if (raw[i] === '}') { depth -= 1; if (depth === 0) { try { return JSON.parse(raw.slice(start, i + 1)); } catch { /* next */ } } }
    }
  }
  return null;
}
function asString(v) { return v == null ? '' : String(v); }
function arrOf(v, n = 10) { return (Array.isArray(v) ? v : (v == null ? [] : [v])).map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).map((s) => s.trim()).filter(Boolean).slice(0, n); }

export const DOCUMENT_KINDS = { 'note-summary': '笔记总结', 'daily': '每日总结', 'note-set': '笔记合集' };

export function collectSources({ dataDir, date, ids = null, kind = 'note-summary', ledger = null } = {}) {
  // P1 修复（S-04 / S-18）：day 来自请求 date，必须白名单 + 真实日期，否则回落到今天，绝不拼进文件路径。
  const rawDay = String(date == null ? '' : date).trim();
  const day = isRealDay(rawDay) ? rawDay : localDay();
  const notesStore = createNotesStore({ dataDir, ledger: null });
  let notes = [];
  try {
    if (Array.isArray(ids) && ids.length) {
      notes = ids.map((id) => (isValidDocId(String(id)) ? notesStore.get(String(id)) : null)).filter(Boolean);
    } else {
      notes = notesStore.list({ date: day, limit: 100 }).items;
    }
  } catch { notes = []; }
  const transcripts = readJsonLines(path.join(dataDir, 'voice', 'transcripts', day + '.jsonl'), 200)
    .map((x) => ({ text: String(x.text || ''), source: String(x.source || ''), device: String(x.device || (x.source === 'android' || x.source === 'phone' ? 'phone' : 'pc')) }))
    .filter((x) => x.text);
  const byDevice = { pc: [], phone: [] };
  for (const t of transcripts) (byDevice[t.device === 'phone' ? 'phone' : 'pc'] || byDevice.pc).push(t.text);
  const screens = readJsonLines(path.join(dataDir, 'voice', 'screen', day + '.jsonl'), 300)
    .filter((x) => x && x.text && !x.redacted)
    .map((x) => ({ at: x.at, app: x.app, title: x.title, text: String(x.text).slice(0, 300), source: String(x.source || ''), device: String(x.device || (x.source === 'phone' ? 'phone' : 'pc')) }));
  // 5 秒一截图 → 原始条数可能上万；总结前先按相似内容合并并计数，显著降低 token
  const screenGroups = mergeScreens(screens);
  let diaryMarkdown = '';
  try { const f = path.join(dataDir, 'voice', 'diary', day + '.md'); if (fs.existsSync(f)) diaryMarkdown = fs.readFileSync(f, 'utf8'); } catch { diaryMarkdown = ''; }
  const execs = [];
  try {
    for (const ev of (ledger && ledger.events) || []) {
      if (!ev || !ev.at || localDay(ev.at) !== day) continue;
      if (ev.type === 'voice.command' || ev.type === 'agent.executed') execs.push({ type: ev.type, text: String((ev.data && (ev.data.text || '')).slice(0, 160)), ok: ev.data && ev.data.ok !== false, provider: ev.data && ev.data.provider });
    }
  } catch { /* ignore */ }
  const screenByDevice = { pc: [], phone: [] };
  for (const sc of screens) {
    const dev = String(sc.device || sc.source || '').toLowerCase() === 'phone' ? 'phone' : 'pc';
    screenByDevice[dev].push(sc);
  }
  return { day, notes, transcripts, transcriptTexts: transcripts.map((t) => t.text), byDevice, screens, screenGroups, screenByDevice, diaryMarkdown, execs: execs.slice(-40) };
}

export function buildPrompt(kind = 'note-summary') {
  return [
    '你是榫卯的总结助手。基于用户当天的笔记、语音转写、屏幕文本（看了什么/刷了什么视频）、已执行操作和已有的晚间日记，生成一份**真正的结构化总结**，不能空泛。',
    '只输出 JSON（不要 Markdown 代码块、不要解释），字段固定：',
    '{"摘要":"2-3 句话，具体，不要空话","重点":["3-6 条具体事项/信息，带应用或时间线索"],"待办":["0-5 条可执行待办，明确动作"],"回顾":["0-4 条今天值得回顾的片段/决定/情绪"],"日记":"第一人称 200-400 字日记，具体写到人/事/视频/工作进展"}',
    '要求：',
    '1. 有屏幕文本时，明确写出看了什么（视频标题/网页/应用），不要笼统说“使用电脑”。',
    '2. 有笔记时优先引用笔记内容；待办只来自笔记/对话/屏幕中明确要做的事。',
    '3. 不得编造不存在的事实；信息少时如实写少，但摘要要具体。',
    '4. 不输出隐私敏感原文（密码/验证码/银行卡/身份证）。',
  ].join('\n');
}

export function sanitizeStructured(parsed, fallback = {}) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  return {
    摘要: asString(p.摘要 || p.summary || fallback.摘要 || '').trim().slice(0, 800),
    重点: arrOf(p.重点 || p.highlights || fallback.重点, 8),
    待办: arrOf(p.待办 || p.todos || fallback.待办, 8),
    回顾: arrOf(p.回顾 || p.review || fallback.回顾, 8),
    日记: asString(p.日记 || p.diary || fallback.日记 || '').trim().slice(0, 2400),
  };
}

export function fallbackStructured(sources = {}, kind = 'note-summary') {
  const notes = sources.notes || [];
  const screens = sources.screenGroups || sources.screens || [];
  const transcripts = (sources.transcriptTexts || sources.transcripts || []).map((t) => (typeof t === 'string' ? t : t.text)).filter(Boolean);
  const execs = sources.execs || [];
  const noteLines = notes.map((n) => '「' + (n.title || '') + '」' + String(n.text || '').slice(0, 120));
  const rawScreenCount = (sources.screens || []).length;
  const videoLines = screens.map((s) => formatScreenGroup(s, { excerpt: 100 }));
  const 摘要 = notes.length || screens.length || transcripts.length
    ? '今天记录了 ' + notes.length + ' 条笔记、' + transcripts.length + ' 条语音转写、' + rawScreenCount + ' 条屏幕文本（相似内容合并后 ' + screens.length + ' 组）' + (videoLines.length ? '；屏幕内容包含：' + videoLines.slice(0, 3).join('；') : '') + '。'
    : '今天还没有足够的笔记/语音/屏幕数据，先记录一些内容再生成总结。';
  const 重点 = [...noteLines.slice(0, 4), ...videoLines.slice(0, 4), ...execs.slice(-3).map((e) => '执行：' + e.text)].slice(0, 6);
  const 待办 = notes.map((n) => String(n.text || '')).filter((t) => /待办|明天|要|记得|安排|需要/.test(t)).slice(0, 5).map((t) => t.slice(0, 80));
  const 回顾 = transcripts.slice(-3).map((t) => '听到：' + t.slice(0, 100));
  const 日记 = 摘要 + (重点.length ? '\n今天让我印象比较深的是：' + 重点.slice(0, 3).join('；') + '。' : '') + '\n明天先处理：' + (待办.length ? 待办.slice(0, 3).join('；') : '整理今天的记录。');
  return { 摘要, 重点, 待办, 回顾, 日记 };
}

export async function generateStructured({ ai = null, kind = 'note-summary', date, title = '', ids = null, dataDir, ledger = null } = {}) {
  const sources = collectSources({ dataDir, date, ids, kind, ledger });
  const day = sources.day;
  const baseTitle = String(title || '').trim() || ((DOCUMENT_KINDS[kind] || '总结') + ' · ' + day);
  const fallback = fallbackStructured(sources, kind);
  if (ai && ai.available) {
    try {
      const sourceText = [
        '日期：' + day,
        '【笔记】\n' + (sources.notes.length ? sources.notes.map((n, i) => (i + 1) + '. ' + (n.title || '') + '（' + (n.source === 'voice' ? '语音' : '文字') + '）：' + String(n.text || '').slice(0, 600)).join('\n') : '（无）'),
        '【电脑端记录】\n' + (((sources.byDevice || {}).pc || []).length ? (sources.byDevice.pc.slice(-40).map((t) => '- ' + t).join('\n')) : '（无）'),
        '【手机端记录】\n' + (((sources.byDevice || {}).phone || []).length ? (sources.byDevice.phone.slice(-40).map((t) => '- ' + t).join('\n')) : '（无）'),
        '【屏幕文本（已按相似内容合并，计数为出现次数；原始 ' + ((sources.screens || []).length) + ' 条 → 合并 ' + ((sources.screenGroups || []).length) + ' 组）】\n' + (((sources.screenGroups || []).length) ? sources.screenGroups.slice(-60).map((g) => '- ' + formatScreenGroup(g, { excerpt: 160 })).join('\n') : '（无）'),
        '【已执行操作】\n' + (sources.execs.length ? sources.execs.map((e) => '- ' + (e.ok ? '✓' : '✗') + ' ' + e.text).join('\n') : '（无）'),
        sources.diaryMarkdown ? '【已有晚间日记】\n' + sources.diaryMarkdown.slice(0, 2500) : '',
      ].filter(Boolean).join('\n\n');
      const res = await ai.chat([
        { role: 'system', content: buildPrompt(kind) },
        { role: 'user', content: sourceText.slice(0, 12000) },
      ], { maxTokens: 1600, temperature: 0.3, place: 'document' });
      const parsed = extractJson(res && res.text);
      if (parsed) {
        const structured = sanitizeStructured(parsed, fallback);
        if (structured.摘要 || structured.日记) return { structured, provider: 'deepseek', degraded: false, sources, title: baseTitle, day };
      }
    } catch (err) { /* 降级 */ }
  }
  return { structured: fallback, provider: 'template', degraded: true, sources, title: baseTitle, day };
}

function markdownOf({ title, day, kind, provider, degraded, structured, sources }) {
  const lines = ['# ' + title, '', '> ' + day + ' · ' + (DOCUMENT_KINDS[kind] || '总结') + ' · 生成模型：' + provider + (degraded ? '（无 AI key/降级模板，仅供占位）' : ''), ''];
  lines.push('## 摘要', '', structured.摘要 || '（无）', '');
  const sec = (name, arr) => { lines.push('## ' + name, ''); if (arr && arr.length) for (const x of arr) lines.push('- ' + x); else lines.push('- （无）'); lines.push(''); };
  sec('重点', structured.重点);
  sec('待办', structured.待办);
  sec('回顾', structured.回顾);
  lines.push('## 日记', '', structured.日记 || '（无）', '');
  const dev = sources.byDevice || { pc: [], phone: [] };
  lines.push('## 设备记录', '', '- 电脑端语音：' + ((dev.pc || []).length) + ' 条', '- 手机端语音：' + ((dev.phone || []).length) + ' 条', '');
  if ((dev.pc || []).length) { lines.push('### 🖥 电脑端记录', ''); for (const t of dev.pc.slice(-25)) lines.push('- ' + String(t).slice(0, 160)); lines.push(''); }
  if ((dev.phone || []).length) { lines.push('### 📱 手机端记录', ''); for (const t of dev.phone.slice(-25)) lines.push('- ' + String(t).slice(0, 160)); lines.push(''); }
  const sg = sources.screenGroups || [];
  lines.push('## 屏幕记录（相似内容已合并，共 ' + sg.length + ' 组 / 原始 ' + ((sources.screens || []).length) + ' 条）', '');
  if (sg.length) { for (const g of sg.slice(0, 80)) lines.push('- ' + formatScreenGroup(g)); } else { lines.push('- （无）'); }
  lines.push('');
  lines.push('## 今日数据', '', '- 笔记：' + ((sources.notes || []).length) + ' 条', '- 语音转写：' + ((sources.transcripts || []).length) + ' 条', '- 屏幕文本：' + ((sources.screens || []).length) + ' 条', '- 执行操作：' + ((sources.execs || []).length) + ' 条', '');
  return lines.join('\n');
}

function docxOf({ title, day, kind, provider, degraded, structured, screenGroups = [] }) {
  const children = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    new Paragraph({ children: [new TextRun({ text: day + ' · ' + (DOCUMENT_KINDS[kind] || '总结') + ' · ' + provider + (degraded ? '（降级模板）' : ''), size: 18, color: '666666' })], spacing: { after: 240 } }),
  ];
  const section = (name, arr, bullets = true) => {
    children.push(new Paragraph({ text: name, heading: HeadingLevel.HEADING_1 }));
    if (!arr || !arr.length) children.push(new Paragraph({ text: '（无）', spacing: { after: 120 } }));
    else if (bullets) for (const x of arr) children.push(new Paragraph({ text: '• ' + x, bullet: { level: 0 }, spacing: { after: 60 } }));
    else children.push(new Paragraph({ text: arr, spacing: { after: 120 } }));
  };
  children.push(new Paragraph({ text: '摘要', heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: structured.摘要 || '（无）', spacing: { after: 200 } }));
  section('重点', structured.重点);
  section('待办', structured.待办);
  section('回顾', structured.回顾);
  children.push(new Paragraph({ text: '日记', heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph({ text: structured.日记 || '（无）', spacing: { after: 200 } }));
  children.push(new Paragraph({ text: '屏幕记录（相似内容已合并）', heading: HeadingLevel.HEADING_1 }));
  if (!screenGroups.length) children.push(new Paragraph({ text: '（无）', spacing: { after: 120 } }));
  else for (const g of screenGroups.slice(0, 80)) children.push(new Paragraph({ text: '• ' + formatScreenGroup(g), bullet: { level: 0 }, spacing: { after: 60 } }));
  return Packer.toBuffer(new Document({ creator: '榫卯 Tenon', title, description: '榫卯结构化总结', sections: [{ children }] }));
}

function pdfOf({ title, day, kind, provider, degraded, structured, screenGroups = [] }) {
  return new Promise((resolve) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: title, Creator: '榫卯 Tenon' } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', () => resolve(null));
      let fontName = 'Helvetica';
      try { if (fs.existsSync(CN_FONT)) { doc.registerFont('CN', CN_FONT); fontName = 'CN'; } } catch { fontName = 'Helvetica'; }
      doc.font(fontName);
      doc.fontSize(20).text(title, { align: 'left' });
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor('#666666').text(day + ' · ' + (DOCUMENT_KINDS[kind] || '总结') + ' · ' + provider + (degraded ? '（降级模板）' : ''));
      doc.fillColor('#000000').moveDown(0.8);
      const writeList = (name, arr, bullets = true) => {
        doc.fontSize(13).text(name);
        doc.moveDown(0.2);
        doc.fontSize(10.5);
        if (!arr || !arr.length) doc.text('（无）');
        else if (bullets) for (const x of arr) doc.text('• ' + x, { indent: 10 });
        else doc.text(String(arr));
        doc.moveDown(0.6);
      };
      doc.fontSize(13).text('摘要'); doc.moveDown(0.2); doc.fontSize(10.5).text(structured.摘要 || '（无）'); doc.moveDown(0.6);
      writeList('重点', structured.重点);
      writeList('待办', structured.待办);
      writeList('回顾', structured.回顾);
      doc.fontSize(13).text('日记'); doc.moveDown(0.2); doc.fontSize(10.5).text(structured.日记 || '（无）');
      doc.moveDown(0.6);
      doc.fontSize(13).text('屏幕记录（相似内容已合并）'); doc.moveDown(0.2); doc.fontSize(10.5);
      if (!screenGroups.length) doc.text('（无）');
      else for (const g of screenGroups.slice(0, 80)) doc.text('• ' + formatScreenGroup(g), { indent: 10 });
      doc.end();
    } catch { resolve(null); }
  });
}

export async function writeDocument({ dataDir, ledger = null, kind = 'note-summary', date, title = '', provider = 'template', degraded = true, structured = null, sources = null } = {}) {
  const store = createDocumentsStore({ dataDir, ledger });
  // P1 修复（S-04）：date 同时决定文档 id 与落盘目录，非法 date 一律回落今天（路由层已在入口返回 400）。
  const rawDay = String(date == null || date === '' ? (sources && sources.day) || '' : date).trim();
  const day = isRealDay(rawDay) ? rawDay : localDay();
  const finalTitle = String(title || '').trim() || ((DOCUMENT_KINDS[kind] || '总结') + ' · ' + day);
  const structuredObj = sanitizeStructured(structured || fallbackStructured(sources || {}, kind));
  const md = markdownOf({ title: finalTitle, day, kind, provider, degraded, structured: structuredObj, sources: sources || { notes: [], transcripts: [], screens: [], execs: [] } });
  const id = 'doc_' + day.replace(/-/g, '') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let docxBuffer = null; let pdfBuffer = null; let errors = [];
  const screenGroups = (sources && sources.screenGroups) || [];
  try { docxBuffer = await docxOf({ title: finalTitle, day, kind, provider, degraded, structured: structuredObj, screenGroups }); } catch (err) { errors.push('docx: ' + String((err && err.message) || err)); }
  try { pdfBuffer = await pdfOf({ title: finalTitle, day, kind, provider, degraded, structured: structuredObj, screenGroups }); } catch (err) { errors.push('pdf: ' + String((err && err.message) || err)); }
  const meta = {
    id, title: finalTitle, date: day, kind, kindLabel: DOCUMENT_KINDS[kind] || '总结', provider, degraded,
    structured: structuredObj, summary: structuredObj.摘要, chars: md.length,
    sourceStats: { notes: (sources && sources.notes ? sources.notes.length : 0), transcripts: (sources && sources.transcripts ? sources.transcripts.length : 0), screens: (sources && sources.screens ? sources.screens.length : 0), screenGroups: screenGroups.length, execs: (sources && sources.execs ? sources.execs.length : 0) },
    errors,
  };
  const saved = store.save({ id, meta, markdown: md, docxBuffer, pdfBuffer });
  return saved;
}

export async function generateDocument({ ai = null, dataDir, ledger = null, kind = 'note-summary', date, ids = null, title = '' } = {}) {
  const g = await generateStructured({ ai, kind, date, title, ids, dataDir, ledger });
  const saved = await writeDocument({ dataDir, ledger, kind, date: g.day, title: g.title, provider: g.provider, degraded: g.degraded, structured: g.structured, sources: g.sources });
  return saved;
}

export function structuredFromMarkdown(markdown = '') {
  const md = String(markdown || '');
  const section = (name) => {
    const re = new RegExp('##\\s*' + name + '[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)');
    const m = re.exec(md);
    return m ? m[1].trim() : '';
  };
  const bullets = (name) => section(name).split('\n').map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter((l) => l && !/^（无）$/.test(l));
  const summary = section('一句话总结') || section('摘要') || '';
  return {
    摘要: summary.replace(/^[-*]\s*/, '').slice(0, 800),
    重点: bullets('今天做了什么').slice(0, 8),
    待办: bullets('明天要做什么').slice(0, 8),
    回顾: bullets('重要事件与决定').concat(bullets('未完成与风险')).slice(0, 8),
    日记: section('日记').slice(0, 2400),
  };
}

export async function generateDocumentFromMarkdown({ dataDir, ledger = null, kind = 'daily', date, title = '', markdown = '', provider = 'deepseek', degraded = false, sources = null } = {}) {
  const structured = structuredFromMarkdown(markdown);
  return writeDocument({ dataDir, ledger, kind, date, title, provider, degraded, structured, sources });
}

export default { DOCUMENT_KINDS, collectSources, generateStructured, generateDocument, generateDocumentFromMarkdown, structuredFromMarkdown, sanitizeStructured, fallbackStructured, writeDocument };