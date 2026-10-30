// 榫卯 V3 · 语音动作执行器：规划器 {action,params} → 真实任务
// 两种模式：
//  - local（生产默认）：在 hub 进程内用 super 服务/执行器，与 node-agent 走同一任务队列（真实执行 + 账本审计）
//  - hub：独立运行/自测时，通过本机中枢 HTTP 执行（app.launch/url.open/handoff/preset 等）
// device.control 统一映射为 app.launch + nodeId（全权限设备控制走 agent 任务队列）。
import { createSuperService, executePlan } from '../super/index.js';
import { createNotesStore } from '../notes/store.js';
import { createRemindersStore } from '../reminders/store.js';
import { parseReminder } from '../reminders/parse.js';
import { generateDocument } from '../documents/generate.js';

export const EXEC_VERSION = '3.0.0';

function stepOf(label, status, summary, extra = {}) {
  return { label, status, summary: String(summary || '').slice(0, 240), ...extra };
}

async function hubFetch(baseUrl, token, path, body) {
  const url = String(baseUrl || '').replace(/\/$/, '') + path;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'x-tenon-token': token } : {}) },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

export function createExecutor({ root, ledger, dataDir, ai = null, getState, config }) {
  let notesStore = null;
  let remindersStore = null;
  function notes() { if (!notesStore) notesStore = createNotesStore({ dataDir, ledger }); return notesStore; }
  function reminders() { if (!remindersStore) remindersStore = createRemindersStore({ dataDir, ledger }); return remindersStore; }
  let superService = null;
  function sup() {
    if (!superService) {
      superService = createSuperService({
        root,
        ledger,
        dataDir,
        ai,
        getState,
        hubUrl: process.env.TENON_PUBLIC_URL || 'http://127.0.0.1:' + (process.env.TENON_PORT || 7410),
      });
    }
    return superService;
  }

  // V5：物联设备控制（iot: 设备走中枢 /api/v2/iot/devices/:id/control）
  function hubBaseUrl() { const e = String(process.env.TENON_PUBLIC_URL || '').trim(); return e ? e.replace(/\/+$/, '') : 'http://127.0.0.1:' + String(process.env.TENON_PORT || '7410'); }
  function operatorTokenOf() { const t = String(process.env.TENON_OPERATOR_TOKEN || '').trim(); if (t) return t; try { return String(JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')).operatorToken || ''); } catch { return ''; } }
  async function callIotControl(deviceId, rawParams = {}) {
    const p = { ...rawParams }; let command = String(p.command || p.action || '').trim(); delete p.command; delete p.action;
    if (/打开|开启|启动|开灯/.test(command)) command = 'turn_on';
    else if (/关闭|关灯|关掉/.test(command)) command = 'turn_off';
    else if (/亮度|brightness/i.test(command)) { command = 'brightness'; if (p.brightness === undefined) p.brightness = Number(p.value || p.level || 50); }
    else if (/切换|toggle/i.test(command)) command = 'toggle';
    if (!command) command = 'turn_on';
    try {
      const res = await fetch(hubBaseUrl() + '/api/v2/iot/devices/' + encodeURIComponent(deviceId) + '/control', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(operatorTokenOf() ? { 'x-tenon-token': operatorTokenOf() } : {}) }, body: JSON.stringify({ command, params: p }), signal: AbortSignal.timeout(15000) });
      const text = await res.text().catch(() => ''); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      const ok = res.ok && !(data && data.ok === false);
      return { ok, status: res.status, command, params: p, summary: ok ? ('已控制物联设备 ' + deviceId) : ('物联设备控制失败 HTTP ' + res.status + '：' + String((data && data.error) || text).slice(0, 160)) };
    } catch (err) { return { ok: false, status: 0, command, params: p, summary: '物联设备控制失败：' + String((err && err.message) || err).slice(0, 160) }; }
  }

  function mapToPlanStep(action) {
    const params = { ...(action.params || {}) };
    if (action.action === 'device.control') {
      const nodeId = action.deviceId || params.deviceId || null;
      params.app = params.app || '';
      if (!params.app) return null;
      return { capabilityId: 'app.launch', label: '在设备上打开 ' + params.app, params: { app: params.app }, nodeId };
    }
    if (action.action === 'file.print') { params.path = params.path || params.file; params.file = params.file || params.path; }
    const labelMap = {
      'app.launch': '打开 ' + (params.app || '程序'),
      'url.open': '打开网页 ' + (params.url || ''),
      'system.volume': params.level != null ? '把电脑音量调到 ' + params.level + '%' : (params.action === 'mute' ? '电脑静音' : '电脑音量' + (params.action === 'down' ? '调小' : '调大')),
      'media.show': '播放/展示素材',
      'handoff.show': '甩到电脑大屏',
      'file.print': '打印文件',
      'agent.message': '把消息发到 ' + (params.to || '电脑'),
      'voice.reply': '口头回复',
    };
    const step = { capabilityId: action.action, label: labelMap[action.action] || action.label || action.action, params };
    if (action.deviceId) step.nodeId = action.deviceId;
    return step;
  }

  async function executeLocal(actions, { text, by = '你' } = {}) {
    const started = Date.now();
    const steps = [];
    const taskIds = [];
    let say = '';
    let ok = true;
    for (const action of actions) {
      if (action.action === 'voice.reply') {
        steps.push(stepOf('口头回复', 'succeeded', action.params.text || ''));
        say = action.params.text || say;
        continue;
      }
      if (action.action === 'agent.message') {
        const step = { capabilityId: 'handoff.show', label: '把消息甩到 ' + (action.params.to || '电脑'), params: { kind: 'text', text: action.params.text || '' } };
        try {
          const res = await executePlan({ text: action.params.text || '消息', intent: { say: '', plan: [step], ai: { provider: 'voice', fallback: false } }, ledger, state: getState(), deps: {}, by, confirmed: true });
          ok = ok && !!res.ok;
          for (const s of (res.steps || [])) steps.push(stepOf(s.label, s.status, s.summary, { taskId: s.taskId || null }));
          if (res.taskIds) taskIds.push(...res.taskIds);
        } catch (err) {
          ok = false;
          steps.push(stepOf('发送消息', 'failed', String(err.message || err)));
        }
        continue;
      }
      if (action.action === 'device.control') {
        const iotId = String(action.deviceId || action.params.deviceId || '');
        if (iotId.startsWith('iot:') || action.params.iot === true) {
          const r = await callIotControl(iotId, { ...(action.params || {}), deviceId: undefined });
          ok = ok && r.ok;
          steps.push(stepOf('控制物联设备', r.ok ? 'succeeded' : 'failed', r.summary, { deviceId: iotId, command: r.command }));
          say = say || r.summary;
          continue;
        }
      }
      if (action.action === 'scene.run') {
        try {
          const presetId = action.params.presetId || action.params.sceneId || 'home';
          const res = await sup().presetRun(presetId, { by });
          ok = ok && !!res.ok;
          for (const s of (res.steps || [])) steps.push(stepOf(s.label, s.status === 'succeeded' || s.status === 'dispatched' ? 'succeeded' : s.status, s.summary, { taskId: s.taskId || null, sceneId: presetId }));
          if (res.taskIds) taskIds.push(...res.taskIds);
          say = say || res.say || '';
        } catch (err) {
          ok = false;
          steps.push(stepOf('执行' + presetId + '场景', 'failed', String(err.message || err)));
        }
        continue;
      }
      if (action.action === 'super.ask') {
        try {
          const res = await sup().ask(action.params.text || text, { by });
          ok = ok && !!res.ok;
          for (const s of (res.steps || [])) steps.push(stepOf(s.label, s.status, s.summary, { taskId: s.taskId || null }));
          if (res.taskIds) taskIds.push(...res.taskIds);
          say = say || res.say || '';
        } catch (err) {
          ok = false;
          steps.push(stepOf('超级终端处理', 'failed', String(err.message || err)));
        }
        continue;
      }
      if (action.action === 'note.create') {
        try {
          const note = notes().create({ text: action.params.text || '', title: action.params.title || '', tags: action.params.tags || [], source: 'voice' });
          ok = ok && true;
          steps.push(stepOf('记笔记', 'succeeded', '已记录「' + note.title + '」', { noteId: note.id, md: note.md, taskId: null }));
          say = say || ('好，记下了：' + note.title);
        } catch (err) {
          ok = false;
          steps.push(stepOf('记笔记', 'failed', String((err && err.message) || err)));
        }
        continue;
      }
      if (action.action === 'reminder.create') {
        try {
          let parsed = null;
          let at = action.params.at || '';
          let recurrence = action.params.recurrence === 'daily' ? 'daily' : '';
          let text = String(action.params.text || '').trim();
          if (!at || !text || /提醒|分钟|小时|点/.test(text) && !/^\d{4}-/.test(at)) {
            parsed = parseReminder(action.params.raw || action.params.text || text || '');
            if (!parsed.ok && !at) { ok = false; steps.push(stepOf('创建提醒', 'failed', parsed.error || '没有识别到时间')); continue; }
            if (parsed.ok) { text = text && !/^\d/.test(text) ? text : parsed.text; at = at || parsed.at; if (!recurrence) recurrence = parsed.recurrence; }
          }
          if (action.params.inMinutes && !at) at = new Date(Date.now() + Number(action.params.inMinutes) * 60000).toISOString();
          const item = reminders().create({ text: text || '提醒', at: at || new Date(Date.now() + 3600000).toISOString(), recurrence: recurrence || 'once', source: 'voice' });
          steps.push(stepOf('创建提醒', 'succeeded', '提醒已设置：' + new Date(item.at).toLocaleString('zh-CN', { hour12: false }) + ' · ' + item.text, { reminderId: item.id, at: item.at, recurrence: item.recurrence }));
          say = say || ('好，提醒已设置：' + item.text);
          ok = ok && true;
        } catch (err) {
          ok = false;
          steps.push(stepOf('创建提醒', 'failed', String((err && err.message) || err)));
        }
        continue;
      }
      if (action.action === 'note.summarize' || action.action === 'document.generate') {
        try {
          const kind = action.action === 'note.summarize' ? 'note-summary' : (action.params.kind || 'daily');
          const doc = await generateDocument({ ai, dataDir, ledger, kind, date: action.params.date || '', ids: action.params.ids && action.params.ids.length ? action.params.ids : null, title: action.params.title || '' });
          steps.push(stepOf('生成文档', 'succeeded', '文档已生成：' + doc.title, { documentId: doc.id, provider: doc.provider, degraded: !!doc.degraded, download: '/api/v2/documents/' + doc.id + '/download?format=docx' }));
          say = say || ('好，总结文档已生成：' + doc.title);
          ok = ok && true;
        } catch (err) {
          ok = false;
          steps.push(stepOf('生成文档', 'failed', String((err && err.message) || err)));
        }
        continue;
      }      const planStep = mapToPlanStep(action);
      if (!planStep) {
        ok = false;
        steps.push(stepOf(action.label || action.action, 'failed', '动作参数不完整（' + action.action + '）'));
        continue;
      }
      try {
        const res = await executePlan({
          text: text || planStep.label,
          intent: { say: '', plan: [planStep], ai: { provider: 'voice', fallback: false } },
          ledger,
          state: getState(),
          deps: {},
          by,
          confirmed: true,
        });
        ok = ok && !!res.ok;
        for (const s of (res.steps || [])) steps.push(stepOf(s.label, s.status, s.summary, { taskId: s.taskId || null, simulated: !!s.simulated }));
        if (res.taskIds) taskIds.push(...res.taskIds);
      } catch (err) {
        ok = false;
        steps.push(stepOf(planStep.label, 'failed', String(err.message || err)));
      }
    }
    return { ok, say, steps, taskIds, mode: 'local', ms: Date.now() - started };
  }

  async function executeHub(actions, { text, by = '你' } = {}) {
    const started = Date.now();
    const steps = [];
    const taskIds = [];
    const base = config.executor.baseUrl;
    const token = config.executor.token;
    if (!base) return { ok: false, say: '', steps: [stepOf('执行', 'failed', 'hub 模式缺少 baseUrl')], taskIds, mode: 'hub', ms: 0 };
    let ok = true;
    let say = '';
    for (const action of actions) {
      try {
        let r = null;
        if (action.action === 'device.control') {
        const iotId = String(action.deviceId || action.params.deviceId || '');
        if (iotId.startsWith('iot:') || action.params.iot === true) {
          const r = await callIotControl(iotId, { ...(action.params || {}), deviceId: undefined });
          ok = ok && r.ok;
          steps.push(stepOf('控制物联设备', r.ok ? 'succeeded' : 'failed', r.summary, { deviceId: iotId, command: r.command }));
          say = say || r.summary;
          continue;
        }
      }
      if (action.action === 'scene.run') {
          r = await hubFetch(base, token, '/api/v2/super/presets/' + encodeURIComponent(action.params.presetId || 'home') + '/run', {});
        } else if (action.action === 'handoff.show') {
          r = await hubFetch(base, token, '/api/v2/super/handoff', action.params);
        } else {
          const texts = {
            'app.launch': '打开 ' + (action.params.app || ''),
            'url.open': '打开 ' + (action.params.url || ''),
            'system.volume': action.params.level != null ? '把音量调到 ' + action.params.level + '%' : (action.params.action === 'mute' ? '静音' : '音量' + (action.params.action === 'down' ? '调小' : '调大')),
            'media.show': '播放 ' + (action.params.path || ''),
            'super.ask': action.params.text || text,
            'device.control': '',
          };
          if (!texts[action.action]) {
            ok = false;
            steps.push(stepOf(action.label || action.action, 'failed', 'hub 模式暂不支持 ' + action.action));
            continue;
          }
          r = await hubFetch(base, token, '/api/v2/super/ask', { text: texts[action.action], confirmed: true });
        }
        if (!r || !r.ok || !r.data) {
          ok = false;
          steps.push(stepOf(action.label || action.action, 'failed', (r && r.data && (r.data.error || r.data.message)) || ('HTTP ' + (r && r.status))));
          continue;
        }
        const d = r.data;
        const list = d.steps || (d.preset && d.preset.steps) || [];
        for (const s of list) steps.push(stepOf(s.label || action.label || action.action, s.status === 'succeeded' || s.status === 'dispatched' ? 'succeeded' : s.status, s.summary || '', { taskId: s.taskId || null }));
        if (!list.length) steps.push(stepOf(action.label || action.action, d.ok === false ? 'failed' : 'succeeded', d.say || '已执行'));
        if (Array.isArray(d.taskIds)) taskIds.push(...d.taskIds);
        say = say || d.say || '';
        ok = ok && d.ok !== false;
      } catch (err) {
        ok = false;
        steps.push(stepOf(action.label || action.action, 'failed', '中枢执行失败：' + String(err.message || err)));
      }
    }
    return { ok, say, steps, taskIds, mode: 'hub', ms: Date.now() - started };
  }

  async function executeActions(actions, meta = {}) {
    const list = Array.isArray(actions) ? actions.filter(Boolean) : [];
    if (!list.length) return { ok: true, say: '', steps: [], taskIds: [], mode: config.executor.mode, ms: 0 };
    if (config.executor.mode === 'hub') return executeHub(list, meta);
    return executeLocal(list, meta);
  }

  async function fallbackAsk(text, { by = '你' } = {}) {
    if (config.executor.mode === 'hub') {
      const r = await hubFetch(config.executor.baseUrl, config.executor.token, '/api/v2/super/ask', { text, confirmed: true });
      if (!r.ok || !r.data) throw new Error((r.data && r.data.error) || '中枢 ask 失败');
      return { say: r.data.say || '', steps: r.data.steps || [], taskIds: r.data.taskIds || [], ok: r.data.ok !== false, provider: 'rule' };
    }
    const res = await sup().ask(text, { by });
    return { say: res.say || '', steps: res.steps || [], taskIds: res.taskIds || [], ok: !!res.ok, provider: 'rule' };
  }

  return { executeActions, fallbackAsk, getSuper: sup };
}

export default { createExecutor, EXEC_VERSION };
