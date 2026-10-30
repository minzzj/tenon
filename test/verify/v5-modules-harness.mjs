// V5 后端模块自测 harness：不修改 v2/index.js，直接实例化 notes/reminders/documents/agent 服务 + 最小 HTTP 路由。
// 用法：node test/verify/v5-modules-harness.mjs [--real-ai]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../../server/lib/ledger.js';
import { replay } from '../../server/lib/state.js';
import { AI } from '../../server/lib/ai.js';
import { createNotesService } from '../../server/lib/notes/index.js';
import { createRemindersService } from '../../server/lib/reminders/index.js';
import { createDocumentsService } from '../../server/lib/documents/index.js';
import { createAgentService } from '../../server/lib/agent/index.js';
import { createDiaryGenerator } from '../../server/lib/voice/diary.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, '_internal', 'op-data', 'v5-harness-data');
const PORT = Number(process.env.V5_HARNESS_PORT || 7462);
const TOKEN = 'harness-token-' + crypto.randomBytes(4).toString('hex');
const REAL_AI = process.argv.includes('--real-ai') || process.env.V5_REAL_AI === '1';
const results = [];
function chk(name, ok, detail = '') { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) }); console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + ' | ' + String(detail).slice(0, 300)); }
function pad(n) { return String(n).padStart(2, '0'); }
function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function jsonLine(file) { try { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; } catch { return []; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const ledger = new Ledger(DATA);
ledger.load && ledger.load();
let apiKey = '';
if (REAL_AI) { try { apiKey = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'secrets.json'), 'utf8')).deepseekApiKey || ''; } catch { apiKey = ''; } }
const ai = new AI({ apiKey });
const secret = { operatorToken: TOKEN, nodeToken: 'node_harness' };
const authed = (req) => { const t = String(req.headers['x-tenon-token'] || ''); const u = new URL(req.url, 'http://x'); return t === TOKEN || u.searchParams.get('token') === TOKEN; };

const notes = await createNotesService({ root: ROOT, ledger, ai, dataDir: DATA, readOnly: false, authed, secret });
const reminders = await createRemindersService({ root: ROOT, ledger, dataDir: DATA, readOnly: false, authed, secret });
const documents = await createDocumentsService({ root: ROOT, ledger, ai, dataDir: DATA, readOnly: false, authed, secret });
const agent = await createAgentService({ root: ROOT, ledger, state: null, ai, secret, dataDir: DATA, readOnly: false, authed });

const services = { notes, reminders, documents, agent };
const routes = [];
for (const [name, svc] of Object.entries(services)) { for (const r of svc.routes || []) routes.push({ ...r, module: name }); }
routes.push({ method: 'GET', path: '/health', handler: async (req, res) => json(res, 200, { ok: true, modules: Object.keys(services), routes: routes.map((r) => r.method + ' ' + r.path) }) });

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function match(route, method, rel) {
  if (route.method && route.method !== method) return null;
  const pp = String(route.path || '').split('/').filter(Boolean); const rp = rel.split('/').filter(Boolean);
  if (pp.length !== rp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i += 1) { if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(rp[i]); else if (pp[i] !== rp[i]) return null; }
  return { params };
}
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const pathname = u.pathname;
  const rel = pathname.startsWith('/api/v2') ? (pathname.slice('/api/v2'.length) || '/') : pathname;
  for (const route of routes) {
    const m = match(route, req.method, rel);
    if (!m) continue;
    try { return await route.handler(req, res, { root: ROOT, ledger, state: null, ai, secret, dataDir: DATA, readOnly: false, authed, url: u, pathname, params: m.params, services }); }
    catch (err) { if (!res.headersSent) json(res, err.statusCode || 500, { ok: false, error: String((err && err.message) || err) }); else res.end(); return undefined; }
  }
  json(res, 404, { ok: false, error: 'unknown ' + req.method + ' ' + rel });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + PORT + '/api/v2';
async function call(method, p, body) {
  const opts = { method, headers: { 'x-tenon-token': TOKEN } };
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: Object.fromEntries(res.headers.entries()), text };
}

try {
  const health = await call('GET', '/health');
  chk('harness 服务启动 + 模块挂载', health.status === 200 && (health.data.modules || []).join(',').includes('notes'), JSON.stringify(health.data.modules));
  // ---------- A 笔记 ----------
  const created = await call('POST', '/notes', { text: '明天带合同，下午三点和客户对一下付款节点', title: '合同', tags: ['工作'], source: 'voice' });
  chk('POST /notes 创建笔记', created.status === 201 && created.data.ok && created.data.id, 'id=' + (created.data.id || '') + ' md=' + (created.data.md || ''));
  const note = created.data.note;
  const noteMdFile = path.join(DATA, 'notes', 'md', path.basename(String(note.md || '')));
  chk('笔记 Markdown 文件存在（YAML front matter）', fs.existsSync(noteMdFile) && fs.readFileSync(noteMdFile, 'utf8').includes('---'), note.md);
  const list = await call('GET', '/notes?date=' + today() + '&q=合同');
  chk('GET /notes 搜索命中', list.status === 200 && (list.data.items || []).some((x) => x.id === note.id), 'total=' + (list.data.total || 0));
  const got = await call('GET', '/notes/' + note.id);
  chk('GET /notes/:id', got.status === 200 && got.data.note.text.includes('合同'));
  const patched = await call('PATCH', '/notes/' + note.id, { text: '明天带合同，下午三点和客户对付款节点；记得带公章', tags: ['工作', '合同'] });
  chk('PATCH /notes/:id', patched.status === 200 && patched.data.note.text.includes('公章'), 'updatedAt=' + patched.data.note.updatedAt);
  const exp = await call('GET', '/notes/export?date=' + today() + '&format=md');
  chk('GET /notes/export?format=md', exp.status === 200 && String(exp.data).includes('合同'), 'chars=' + String(exp.data).length);
  const note2 = await call('POST', '/notes', { text: '临时笔记待删除' });
  const del = await call('DELETE', '/notes/' + note2.data.id);
  chk('DELETE /notes/:id', del.status === 200 && del.data.deleted);
  const noteEvents = ledger.events.filter((e) => String(e.type).startsWith('note.'));
  chk('账本 note.created/updated/deleted', ['note.created', 'note.updated', 'note.deleted'].every((t) => noteEvents.some((e) => e.type === t)), 'events=' + noteEvents.length);

  // ---------- D(部分) agent 动作：记一下 ----------
  const agentNote = await call('POST', '/agent/execute', { text: '记一下：明天带合同', agentId: 'harness' });
  chk('agent「记一下」→ note.create 成功', agentNote.status === 200 && agentNote.data.ok && (agentNote.data.steps || []).some((s) => s.status === 'succeeded'), 'say=' + agentNote.data.say + ' steps=' + JSON.stringify((agentNote.data.steps || []).map((s) => s.label)));
  const notesAfterAgent = await call('GET', '/notes?q=明天带合同');
  chk('agent 动作后 /notes 可查到新笔记', (notesAfterAgent.data.items || []).length >= 1, 'total=' + (notesAfterAgent.data.total || 0));

  // ---------- B 提醒 ----------
  const sseEvents = [];
  const ssePromise = (async () => {
    const res = await fetch(BASE + '/reminders/stream', { headers: { 'x-tenon-token': TOKEN } });
    const reader = res.body.getReader();
    let buf = '';
    const stopAt = Date.now() + 12000;
    while (Date.now() < stopAt) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += Buffer.from(value).toString('utf8');
      for (const block of buf.split('\n\n')) {
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try { const ev = JSON.parse(line.slice(6)); if (['reminder'].includes(ev.type)) sseEvents.push(ev); } catch { /* ignore */ }
      }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      if (sseEvents.length) break;
    }
    try { reader.cancel(); } catch { /* ignore */ }
  })();
  await sleep(300);
  const rp = await call('POST', '/reminders', { text: '提醒我 1 分钟后喝水' });
  chk('POST /reminders 中文解析（1 分钟后）', rp.status === 201 && rp.data.item && rp.data.item.recurrence === 'once', 'at=' + (rp.data.item && rp.data.item.at) + ' parsed=' + JSON.stringify(rp.data.parsed));
  const quick = await call('POST', '/reminders', { text: '测试即时提醒', at: new Date(Date.now() + 1200).toISOString() });
  chk('POST /reminders 指定时间', quick.status === 201 && quick.data.item.id);
  const pending = await call('GET', '/reminders/pending');
  chk('GET /reminders/pending', pending.status === 200 && (pending.data.items || []).length >= 2, 'pending=' + (pending.data.items || []).length);
  await sleep(1400);
  const tick = await call('POST', '/reminders/tick', {});
  chk('15s 调度器 tick 触发（手动 tick 等价）', tick.status === 200 && (tick.data.fired || []).length >= 1, 'fired=' + JSON.stringify(tick.data.fired));
  await sleep(1200);
  await ssePromise.catch(() => {});
  chk('SSE reminder 事件收到', sseEvents.length >= 1, 'events=' + JSON.stringify(sseEvents.map((e) => e.text)));
  const firedEvents = ledger.events.filter((e) => e.type === 'reminder.fired');
  chk('账本 reminder.fired', firedEvents.length >= 1, 'count=' + firedEvents.length + ' notify=' + JSON.stringify(firedEvents[0] && firedEvents[0].data.notify));
  await sleep(2500);
  const ttsFiles = (() => { try { return fs.readdirSync(path.join(DATA, 'reminders', 'tts')).filter((n) => n.endsWith('.wav')).map((n) => ({ n, size: fs.statSync(path.join(DATA, 'reminders', 'tts', n)).size })); } catch { return []; } })();
  chk('提醒 TTS WAV 已生成', ttsFiles.length >= 1 && ttsFiles[0].size > 1000, JSON.stringify(ttsFiles[0] || null));
  const doneRem = await call('POST', '/reminders/' + rp.data.item.id + '/done');
  chk('POST /reminders/:id/done', doneRem.status === 200 && doneRem.data.item.done);
  const agentRem = await call('POST', '/agent/execute', { text: '提醒我 1 分钟后喝水', agentId: 'harness' });
  chk('agent「提醒我」→ reminder.create', agentRem.status === 200 && (agentRem.data.steps || []).some((s) => s.status === 'succeeded'), 'steps=' + JSON.stringify((agentRem.data.steps || []).map((s) => s.label + '=' + s.status)));

  // ---------- C 文档中心 ----------
  // 造一条屏幕文本 + 语音转写，用于总结内容
  fs.mkdirSync(path.join(DATA, 'voice', 'screen'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'voice', 'transcripts'), { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(DATA, 'voice', 'screen', today() + '.jsonl'), JSON.stringify({ at, app: 'Chrome', title: 'B站', text: '看了一个 25 分钟的红烧肉教程', confidence: 0.93 }) + '\n', 'utf8');
  fs.writeFileSync(path.join(DATA, 'voice', 'transcripts', today() + '.jsonl'), JSON.stringify({ at, text: '记一下明天带合同', source: 'mic' }) + '\n', 'utf8');
  const dg = await call('POST', '/documents/generate', { kind: 'note-summary', date: today(), title: '今日笔记总结' });
  const docId = dg.data && dg.data.id;
  chk('POST /documents/generate 结构化总结', dg.status === 201 && docId && dg.data.structured && dg.data.structured.摘要, 'id=' + docId + ' provider=' + (dg.data.provider) + ' degraded=' + dg.data.degraded + ' keys=' + Object.keys((dg.data.structured) || {}).join('/'));
  const docMeta = documents.get(docId);
  const magic = (fmt) => { const f = documents.store.pathOf(docId, fmt); if (!f) return null; const b = fs.readFileSync(f); return { size: b.length, magic: fmt === 'docx' ? b.slice(0, 2).toString('latin1') : fmt === 'pdf' ? b.slice(0, 4).toString('latin1') : b.slice(0, 20).toString('utf8') }; };
  const mdM = magic('md'); const docxM = magic('docx'); const pdfM = magic('pdf');
  chk('文档 md/docx/pdf 文件生成', mdM && mdM.size > 50 && docxM && docxM.size > 500 && pdfM && pdfM.size > 500, JSON.stringify({ md: mdM && mdM.size, docx: docxM && docxM.size, pdf: pdfM && pdfM.size }));
  chk('docx/pdf magic bytes（PK / %PDF）', docxM && docxM.magic === 'PK' && pdfM && pdfM.magic === '%PDF', JSON.stringify({ docx: docxM && docxM.magic, pdf: pdfM && pdfM.magic }));
  for (const fmt of ['md', 'docx', 'pdf']) {
    const dl = await fetch(BASE + '/documents/' + docId + '/download?format=' + fmt, { headers: { 'x-tenon-token': TOKEN } });
    const buf = Buffer.from(await dl.arrayBuffer());
    const ct = dl.headers.get('content-type') || '';
    const want = fmt === 'md' ? 'text/markdown' : fmt === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf';
    chk('下载 ' + fmt + ' Content-Type/内容', dl.status === 200 && ct.includes(want) && buf.length > 100, 'ct=' + ct + ' bytes=' + buf.length);
  }
  const docList = await call('GET', '/documents?since=' + encodeURIComponent(new Date(Date.now() - 60000).toISOString()));
  chk('GET /documents 列表（since 轮询）', docList.status === 200 && (docList.data.items || []).some((x) => x.id === docId), 'total=' + (docList.data.total || 0));
  const docGet = await call('GET', '/documents/' + docId);
  chk('GET /documents/:id', docGet.status === 200 && String(docGet.data.markdown || '').includes('摘要'));
  // ---------- C2 diary 结构化 + 文档 ----------
  const diary = createDiaryGenerator({ root: ROOT, dataDir: DATA, ledger, getState: () => replay(ledger.events), workers: null, ai: null, getConfig: () => ({ diary: { enabled: true, time: '23:00' }, prompts: {} }), appendEvent: (t, d) => ledger.append(t, d, 'voice'), log: () => {} });
  const diaryRes = await diary.generate({ date: today(), by: 'harness', force: true });
  const diaryDoc = diaryRes.documentId ? documents.get(diaryRes.documentId) : null;
  chk('diary 结构化输出（摘要/重点/待办/回顾/日记）', diaryRes.ok && diaryRes.structured && diaryRes.structured.摘要 !== undefined && Array.isArray(diaryRes.structured.重点) && diaryRes.structured.日记, 'provider=' + diaryRes.provider + ' structKeys=' + Object.keys(diaryRes.structured || {}).join('/'));
  chk('diary 同时生成文档（docx/pdf）', !!diaryDoc && Object.keys(diaryDoc.files || {}).includes('docx') && Object.keys(diaryDoc.files || {}).includes('pdf'), 'documentId=' + diaryRes.documentId + ' files=' + JSON.stringify(diaryDoc && Object.keys(diaryDoc.files || {})));
  // ---------- D agent 总结动作 ----------
  const agentDoc = await call('POST', '/agent/execute', { text: '总结今天的记录', agentId: 'harness' });
  chk('agent「总结今天」→ document.generate', agentDoc.status === 200 && (agentDoc.data.steps || []).some((s) => s.status === 'succeeded' && /文档/.test(s.label)), 'provider=' + agentDoc.data.provider + ' steps=' + JSON.stringify((agentDoc.data.steps || []).map((s) => s.label + '=' + s.status)));
  chk('DeepSeek 调用统计（真实模式下 ≤3）', !REAL_AI || (ai.usage.calls <= 3), 'calls=' + ai.usage.calls + ' tokensIn=' + ai.usage.tokensIn + ' tokensOut=' + ai.usage.tokensOut);
} catch (err) {
  chk('harness 未抛异常', false, String(err && err.stack || err));
} finally {
  await new Promise((r) => server.close(r));
  reminders.stopScheduler();
  const failed = results.filter((r) => !r.ok);
  const summary = { ok: failed.length === 0, total: results.length, pass: results.length - failed.length, fail: failed.length, realAi: REAL_AI, dataDir: DATA, results, aiUsage: { calls: ai.usage.calls, tokensIn: ai.usage.tokensIn, tokensOut: ai.usage.tokensOut } };
  fs.mkdirSync(path.join(ROOT, '_internal', 'op-data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '_internal', 'op-data', 'v5-harness-result.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('RESULT ' + (summary.ok ? 'ALL PASS' : 'FAIL: ' + failed.map((f) => f.name).join(',')) + ' (' + summary.pass + '/' + summary.total + ') dataDir=' + DATA);
  process.exit(summary.ok ? 0 : 1);
}
