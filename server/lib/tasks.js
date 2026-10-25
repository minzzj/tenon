import { newId } from './ledger.js';

const HUB_CAPS = new Set(['channel.notify', 'llm.summarize']);

export function listCapabilities(state) {
  const out = [];
  for (const node of Object.values(state.nodes)) {
    if (node.disconnected) continue;
    for (const cap of node.capabilities || []) {
      out.push({
        ...cap,
        nodeId: node.id,
        nodeName: node.name,
        online: !!node.online,
        evidence: node.evidence,
        authExpired: !!cap.authExpired || (cap.authExpiresAt ? new Date(cap.authExpiresAt) < new Date() : false),
        compatible: cap.compatible !== false,
      });
    }
  }
  return out;
}

export function devicesForDraft(state) {
  return Object.values(state.nodes).filter((n) => !n.disconnected && !n.hidden);
}

export function classifyRisk(state, capId, text) {
  const caps = listCapabilities(state).filter((c) => c.id === capId);
  const cap = caps[0];
  const irreversible = (cap && cap.risk === 'irreversible') || /发送|发到|发群|删除|付款|打印|发布|转账/.test(String(text || ''));
  return { level: irreversible ? 'irreversible' : 'reversible', reasons: irreversible ? ['动作会向外部发送或删除数据，不能自动撤销'] : [] };
}

export function wouldCycle(edges, from, to) {
  const adj = new Map();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  }
  if (!adj.has(from)) adj.set(from, []);
  adj.get(from).push(to);
  const seen = new Set();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) || []) stack.push(nxt);
  }
  return false;
}

export function taskLink(taskId) {
  return `/r/${taskId}`;
}

export async function createDraft({ ledger, ai, state, text, source = 'desktop', requester = '你' }) {
  const caps = listCapabilities(state).filter((c) => c.compatible && !c.authExpired);
  const devices = devicesForDraft(state);
  const { draft, ai: aiInfo } = await ai.draft({ text, capabilities: caps, devices });
  const node = draft.targetDevice ? state.nodes[draft.targetDevice.id] : null;
  const cap = draft.capabilities[0] || null;
  const evidenceLevel = node ? (node.evidence === 'confirmed' ? 'certain' : 'possible') : 'unknown';
  const taskId = newId('task');
  ledger.append('task.drafted', {
    taskId,
    text,
    draft,
    requester,
    source,
    evidenceLevel,
    ai: aiInfo,
  }, source === 'phone' ? 'phone' : 'hub');
  ledger.append('ai.called', {
    place: 'draft',
    provider: aiInfo.provider || 'rule',
    model: aiInfo.model || 'rule',
    tokensIn: aiInfo.tokensIn || 0,
    tokensOut: aiInfo.tokensOut || 0,
    cached: !!aiInfo.cached,
    fallback: !!aiInfo.fallback,
  });
  const needsConfirm = !!(draft.risk && draft.risk.level === 'irreversible');
  const blocked = (draft.missing || []).length > 0;
  const manualOnly = (draft.capabilities || []).some((c) => c.manualOnly);
  if (manualOnly) {
    ledger.append('task.step', { taskId, label: '仅手动', detail: '卡片标「仅手动，需要你操作」' });
  }
  return { taskId, draft, ai: aiInfo, needsConfirm, blocked, manualOnly };
}

export function confirmTask({ ledger, state, taskId, note }) {
  const t = state.tasks[taskId];
  if (!t) throw new Error('任务不存在');
  if (t.status !== 'pending') throw new Error('该任务不在待确认状态');
  ledger.append('task.confirmed', { taskId, confirmedBy: '你', note: note || '确认执行不可逆动作' });
  ledger.append('task.queued', { taskId, nodeId: t.nodeId, note: '确认后派发' });
  return state.tasks[taskId];
}

export function rejectTask({ ledger, taskId, reason }) {
  ledger.append('task.rejected', { taskId, reason: reason || '未填写' });
}

export function cancelTask({ ledger, state, taskId }) {
  const t = state.tasks[taskId];
  if (!t) throw new Error('任务不存在');
  const completed = (t.steps || []).filter((s) => ['执行完成', '部分成功'].includes(s.label)).length;
  ledger.append('task.cancelled', { taskId, completedSteps: completed });
}

export function retryTask({ ledger, state, taskId }) {
  const t = state.tasks[taskId];
  if (!t) throw new Error('任务不存在');
  ledger.append('task.retry', { taskId });
}

export function downgradeTasks({ ledger, state, deviceId, reason }) {
  const affected = [];
  for (const t of Object.values(state.tasks)) {
    if (t.nodeId !== deviceId) continue;
    if (!['queued', 'running', 'pending', 'draft'].includes(t.status)) continue;
    ledger.append('task.needsConfirm', { taskId: t.id, reason: reason || '设备已断开，任务降级为待确认' });
    affected.push(t.id);
  }
  return affected;
}

export async function executeHubTask({ ledger, state, ai, channels, taskId }) {
  const t = state.tasks[taskId];
  if (!t || !t.capabilityId || !HUB_CAPS.has(t.capabilityId)) return false;
  if (t.status !== 'queued') return false;
  const params = (t.draft && t.draft.params) || {};
  ledger.append('task.started', { taskId, nodeId: 'hub', nodeName: '本机中枢' });
  try {
    if (t.capabilityId === 'llm.summarize') {
      ledger.append('task.step', { taskId, label: '调用模型', detail: '摘要不超过 200 字，正文不出内网' });
      const r = await ai.summarize({ text: params.text || t.text });
      ledger.append('ai.called', { place: 'summarize', provider: (r.ai && r.ai.provider) || 'rule', model: ai.model, tokensIn: (r.ai && r.ai.tokensIn) || 0, tokensOut: (r.ai && r.ai.tokensOut) || 0, cached: false, fallback: !!(r.ai && r.ai.fallback) });
      ledger.append('task.step', { taskId, label: '生成摘要', detail: '长度 ' + r.text.length + ' 字' });
      ledger.append('task.succeeded', {
        taskId,
        result: { summary: r.text, items: [{ name: '摘要', ok: true, detail: r.text.slice(0, 60) }], partial: false },
      });
    } else if (t.capabilityId === 'channel.notify') {
      const group = params.group || '工作群';
      const recipients = 3;
      ledger.append('task.step', { taskId, label: '摘要脱敏', detail: `将向 ${recipients} 个群发送，只发摘要与链接` });
      ledger.append('task.step', { taskId, label: '发送', detail: `${group} · 模拟通道` });
      const messageId = newId('msg');
      ledger.append('message.inbox', {
        messageId,
        taskId,
        channel: 'wechat-mock',
        channelLabel: '微信（模拟通道）',
        title: `群消息 · ${group}`,
        summary: t.text.slice(0, 200),
        link: taskLink(taskId),
        status: 'delivered',
        sensitive: true,
      });
      ledger.append('task.succeeded', {
        taskId,
        result: { summary: `已向 ${recipients} 个群发送摘要与链接（模拟通道）`, items: Array.from({ length: recipients }, (_, i) => ({ name: `${group}-${i + 1}`, ok: true, detail: '已送达' })), partial: false },
      });
    }
  } catch (err) {
    ledger.append('task.failed', { taskId, error: String(err.message || err).slice(0, 200) });
  }
  return true;
}

export async function deliverReceipt({ ledger, state, channels, taskId }) {
  const t = state.tasks[taskId];
  if (!t) return;
  if (!['succeeded', 'failed', 'timeout'].includes(t.status)) return;
  if (t.delivery) return;
  const summary = (t.result && t.result.summary ? t.result.summary : t.error || '任务已结束').slice(0, 200);
  const link = taskLink(taskId);
  await channels.deliver(taskId, { summary, link, sensitive: true });
}