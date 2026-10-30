// 榫卯 V4 · 执行器动作执行：super 任务队列（app/volume/场景/甩屏/打印）+ node-agent 任务（shell.exec/window/screen/input）
import { replay } from '../state.js';
import { newId } from '../ledger.js';
import { createSuperService, executePlan } from '../super/index.js';
import { createNotesStore } from '../notes/store.js';
import { createRemindersStore } from '../reminders/store.js';
import { parseReminder } from '../reminders/parse.js';
import { generateDocument } from '../documents/generate.js';

const NODE_ONLINE_MS = 180000;
const INPUT_CAPS = { 'input.mouse': 'input.mouse', 'input.key': 'input.key', 'input.media': 'input.media' };

function now() { return new Date().toISOString(); }

export function createAgentExecutor({ root, ledger, dataDir, ai = null, getState, config = {} }) {
  let notesStore = null;
  let remindersStore = null;
  function notes() { if (!notesStore) notesStore = createNotesStore({ dataDir, ledger }); return notesStore; }
  function reminders() { if (!remindersStore) remindersStore = createRemindersStore({ dataDir, ledger }); return remindersStore; }
  let superService = null;
  function sup() {
    if (!superService) {
      superService = createSuperService({ root, ledger, dataDir, ai, getState });
    }
    return superService;
  }

  // V5：物联设备控制（IoT 适配层由 node-agent-dev 的 /api/v2/iot 提供；语音/执行器通过内部 HTTP 调用）
  function hubBaseUrl() {
    const envBase = String(process.env.TENON_PUBLIC_URL || '').trim();
    if (envBase) return envBase.replace(/\/+$/, '');
    return 'http://127.0.0.1:' + String(process.env.TENON_PORT || '7410');
  }
  function operatorTokenOf() {
    const envTok = String(process.env.TENON_OPERATOR_TOKEN || '').trim();
    if (envTok) return envTok;
    try { const s = JSON.parse(fs.readFileSync(path.join(dataDir, 'secrets.json'), 'utf8')); return String(s.operatorToken || ''); } catch { return ''; }
  }
  function mapIotCommand(params = {}) {
    const p = { ...params };
    let command = String(p.command || p.action || '').trim();
    delete p.command; delete p.action;
    if (/打开|开启|启动|开灯/.test(command)) command = 'turn_on';
    else if (/关闭|关灯|关掉/.test(command)) command = 'turn_off';
    else if (/亮度|brightness/i.test(command)) { command = 'brightness'; if (p.brightness === undefined) p.brightness = Number(p.value || p.level || 50); }
    else if (/切换|toggle/i.test(command)) command = 'toggle';
    if (!command) command = 'turn_on';
    return { command, params: p };
  }
  async function callIotControl(deviceId, rawParams = {}) {
    const { command, params } = mapIotCommand(rawParams);
    const base = hubBaseUrl();
    const token = operatorTokenOf();
    const url = base + '/api/v2/iot/devices/' + encodeURIComponent(deviceId) + '/control';
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'x-tenon-token': token } : {}) }, body: JSON.stringify({ command, params }), signal: AbortSignal.timeout(15000) });
      const text = await res.text().catch(() => '');
      let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
      const ok = res.ok && !(data && data.ok === false);
      return { ok, status: res.status, command, params, summary: ok ? ('已控制物联设备 ' + deviceId + '（' + command + '）' + (data && data.say ? '：' + data.say : '')) : ('物联设备控制失败 HTTP ' + res.status + '：' + String((data && data.error) || text).slice(0, 160)), data };
    } catch (err) {
      return { ok: false, status: 0, command, params, summary: '物联设备控制失败：' + String((err && err.message) || err).slice(0, 160) };
    }
  }

  function nodesWith(capabilityId) {
    const st = getState ? getState() : replay(ledger.events);
    const nodes = Object.values((st && st.nodes) || {});
    return nodes.filter((n) => n && n.id !== 'hub' && !n.disconnected && !n.hidden)
      .filter((n) => (n.capabilities || []).some((c) => c && c.id === capabilityId && !c.authExpired && c.compatible !== false))
      .filter((n) => {
        const last = n.lastSeen ? new Date(n.lastSeen).getTime() : 0;
        return !!n.online || (last && Date.now() - last < NODE_ONLINE_MS);
      });
  }

  function pickNode(capabilityId, deviceId = null) {
    const list = nodesWith(capabilityId);
    if (deviceId) {
      const exact = list.find((n) => String(n.id) === String(deviceId));
      if (exact) return exact;
    }
    return list[0] || null;
  }

  function clientNodeId() {
    const st = getState ? getState() : replay(ledger.events);
    const nodes = Object.values((st && st.nodes) || {}).filter((n) => n && n.id !== 'hub' && (n.online || (n.lastSeen && Date.now() - new Date(n.lastSeen).getTime() < NODE_ONLINE_MS)));
    const preferred = nodes.find((n) => (n.capabilities || []).some((c) => ['app.launch', 'system.volume', 'input.key', 'system.exec', 'screen.capture'].includes(c && c.id)));
    return preferred || nodes[0] || null;
  }

  async function waitTask(taskId, timeoutMs = 25000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const st = replay(ledger.events);
      const t = st.tasks && st.tasks[taskId];
      if (t && ['succeeded', 'failed', 'cancelled', 'timeout', 'rejected'].includes(t.status)) return t;
      await new Promise((r) => setTimeout(r, 400));
    }
    const st = replay(ledger.events);
    return (st.tasks && st.tasks[taskId]) || null;
  }

  function makeDraft({ capabilityId, label, params, node, risk = 'reversible', summary }) {
    return {
      summary: summary || label,
      capabilities: [{ id: capabilityId, name: label, risk, manualOnly: false, version: '4.0.0', evidence: 'confirmed' }],
      targetDevice: node ? { id: node.id, name: node.name || node.id } : { id: 'hub', name: '本机中枢' },
      params: params || {},
      risk: { level: risk, reasons: risk === 'irreversible' ? ['该动作不可逆，需要确认'] : [] },
      missing: [],
    };
  }

  async function dispatchNode({ capabilityId, params = {}, label, text = '', deviceId = null, timeoutMs = 25000, risk = 'reversible', agentId = 'agent' }) {
    const node = pickNode(capabilityId, deviceId);
    if (!node) return { label, status: 'failed', taskId: null, summary: label + '失败：没有可用的「' + capabilityId + '」设备（请确认 node-agent 已启动并注册该能力）', code: 'NO_CAPABILITY', missingCapability: capabilityId };
    const taskId = newId('task');
    ledger.append('task.drafted', { taskId, text: '执行器：' + text, draft: makeDraft({ capabilityId, label, params, node, risk }), requester: agentId, source: 'agent', evidenceLevel: 'certain', ai: { provider: 'agent', fallback: false } }, 'agent');
    ledger.append('task.queued', { taskId, nodeId: node.id, note: '执行器派发，等待节点接单' }, 'agent');
    const task = await waitTask(taskId, timeoutMs);
    if (!task) return { label, status: 'dispatched', taskId, summary: '已派发给 ' + (node.name || node.id) + '（等待节点执行）' };
    const result = task.result || {};
    const items = Array.isArray(result.items) ? result.items : [];
    const detail = items.map((it) => (it && (it.detail || it.name)) || '').filter(Boolean).join('；');
    return {
      label,
      status: task.status === 'succeeded' ? 'succeeded' : 'failed',
      taskId,
      summary: result.summary || detail || (label + '：' + task.status),
      result,
      items,
      nodeId: node.id,
      nodeName: node.name || node.id,
    };
  }

  function toPlanStep(action) {
    const params = { ...(action.params || {}) };
    if (action.action === 'device.control') {
      return { capabilityId: 'app.launch', label: '在设备上打开 ' + (params.app || ''), params: { app: params.app }, nodeId: action.deviceId || params.deviceId || undefined };
    }
    if (action.action === 'agent.message') {
      return { capabilityId: 'handoff.show', label: '发消息到 ' + (params.to || '电脑'), params: { kind: 'text', text: params.text || '' } };
    }
    if (action.action === 'file.print') {
      return { capabilityId: 'file.print', label: '打印文件', params: { path: params.path || params.file, file: params.file || params.path, copies: params.copies || 1 } };
    }
    const labels = {
      'app.launch': '打开 ' + (params.app || '程序'),
      'url.open': '打开网页 ' + (params.url || ''),
      'system.volume': params.level != null ? '把音量调到 ' + params.level + '%' : (params.action === 'mute' ? '静音' : '音量' + (params.action === 'down' ? '调小' : '调大')),
      'media.show': '播放/展示素材',
      'handoff.show': '甩到电脑大屏',
    };
    return { capabilityId: action.action, label: labels[action.action] || action.label || action.action, params };
  }

  async function executeSuperAction(action, { text, by }) {
    const step = toPlanStep(action);
    try {
      const res = await executePlan({
        text: text || step.label,
        intent: { say: '', plan: [step], ai: { provider: 'agent', fallback: false } },
        ledger,
        state: getState(),
        deps: {},
        by,
        confirmed: true,
      });
      const s = (res.steps || [])[0] || { label: step.label, status: 'failed', summary: '未执行' };
      return { label: s.label || step.label, status: s.status === 'succeeded' || s.status === 'dispatched' ? 'succeeded' : s.status, taskId: s.taskId || null, summary: s.summary || '', simulated: !!s.simulated };
    } catch (err) {
      return { label: step.label, status: 'failed', taskId: null, summary: step.label + '失败：' + String((err && err.message) || err) };
    }
  }

  async function executeActions(actions, { text = '', agentId = 'agent', confirmed = false, by = '执行器' } = {}) {
    const started = Date.now();
    const steps = [];
    const taskIds = [];
    let ok = true;
    for (const action of actions || []) {
      let step = null;
      const a = action.action;
      if (a === 'note.create') {
        try {
          const note = notes().create({ text: action.params.text || '', title: action.params.title || '', tags: action.params.tags || [], source: action.params.source === 'voice' ? 'voice' : 'text' });
          step = { label: '记笔记', status: 'succeeded', taskId: null, summary: '已记录「' + note.title + '」', result: { noteId: note.id, md: note.md } };
        } catch (err) { ok = false; step = { label: '记笔记', status: 'failed', summary: '记笔记失败：' + String((err && err.message) || err) }; }
        steps.push(step); continue;
      }
      if (a === 'reminder.create') {
        try {
          const parsed = parseReminder(action.params.raw || action.params.text || '');
          if (!parsed.ok && !action.params.at) throw new Error(parsed.error || '没有识别到提醒时间');
          const at = action.params.at || parsed.at || new Date(Date.now() + 3600000).toISOString();
          const item = reminders().create({ text: action.params.text && !/提醒|分钟|点/.test(action.params.text) ? action.params.text : (parsed.text || action.params.text || '提醒'), at, recurrence: action.params.recurrence === 'daily' ? 'daily' : (parsed.recurrence || 'once'), source: 'agent' });
          step = { label: '创建提醒', status: 'succeeded', summary: '提醒已设置：' + new Date(item.at).toLocaleString('zh-CN', { hour12: false }) + ' · ' + item.text, result: { reminderId: item.id, at: item.at, recurrence: item.recurrence } };
        } catch (err) { ok = false; step = { label: '创建提醒', status: 'failed', summary: '创建提醒失败：' + String((err && err.message) || err) }; }
        steps.push(step); continue;
      }
      if (a === 'note.summarize' || a === 'document.generate') {
        try {
          const kind = a === 'note.summarize' ? 'note-summary' : (action.params.kind || 'daily');
          const doc = await generateDocument({ ai, dataDir, ledger, kind, date: action.params.date || '', ids: action.params.ids && action.params.ids.length ? action.params.ids : null, title: action.params.title || '' });
          step = { label: '生成文档', status: 'succeeded', summary: '文档已生成：' + doc.title, result: { documentId: doc.id, provider: doc.provider, degraded: !!doc.degraded, download: '/api/v2/documents/' + doc.id + '/download?format=docx' } };
        } catch (err) { ok = false; step = { label: '生成文档', status: 'failed', summary: '生成文档失败：' + String((err && err.message) || err) }; }
        steps.push(step); continue;
      }      if (a === 'device.control') {
        const iotId = String(action.deviceId || action.params.deviceId || '');
        if (iotId.startsWith('iot:') || action.params.iot === true) {
          const r = await callIotControl(iotId, { ...(action.params || {}), deviceId: undefined });
          step = { label: '控制物联设备', status: r.ok ? 'succeeded' : 'failed', taskId: null, summary: r.summary, result: { deviceId: iotId, command: r.command, params: r.params, status: r.status, data: r.data } };
          steps.push(step); if (!r.ok) ok = false; continue;
        }
      }
      if (a === 'scene.run') {
        try {
          const res = await sup().presetRun(action.params.presetId || 'home', { by });
          ok = ok && !!res.ok;
          for (const s of (res.steps || [])) steps.push({ label: s.label, status: s.status === 'succeeded' || s.status === 'dispatched' ? 'succeeded' : s.status, taskId: s.taskId || null, summary: s.summary || '' });
          if (res.taskIds) taskIds.push(...res.taskIds);
        } catch (err) { ok = false; steps.push({ label: '执行场景', status: 'failed', summary: String((err && err.message) || err) }); }
        continue;
      }
      if (a === 'shell.exec') {
        const cmd = String(action.params.command || '').trim();
        step = await dispatchNode({ capabilityId: 'system.exec', params: { command: cmd, cwd: action.params.cwd || root, timeoutMs: action.params.timeoutMs || 15000 }, label: '执行命令：' + cmd, text, timeoutMs: 30000, risk: 'irreversible', agentId });
        ledger.append('agent.shell', { agentId, command: cmd, taskId: step.taskId || null, ok: step.status === 'succeeded', summary: step.summary, stdout: (step.result && step.result.stdout) || null, at: now() }, 'agent');
      } else if (a === 'window.list' || a === 'window.focus' || a === 'screen.capture') {
        const capId = a;
        const labelMap = { 'window.list': '列出窗口', 'window.focus': '激活窗口', 'screen.capture': '截取屏幕' };
        step = await dispatchNode({ capabilityId: capId, params: action.params || {}, label: labelMap[a], text, timeoutMs: a === 'screen.capture' ? 30000 : 15000, agentId });
      } else if (a.startsWith('input.')) {
        const payload = { ...action.params };
        step = await dispatchNode({ capabilityId: a, params: payload, label: action.label || a, text, timeoutMs: 15000, agentId });
      } else {
        step = await executeSuperAction(action, { text, by });
      }
      if (step) {
        steps.push(step);
        if (step.taskId) taskIds.push(step.taskId);
        if (step.status !== 'succeeded') ok = false;
      }
    }
    return { ok, steps, taskIds, latencyMs: Date.now() - started };
  }

  return { executeActions, dispatchNode, nodesWith, pickNode, clientNodeId, waitTask, getSuper: sup };
}

export default createAgentExecutor;
