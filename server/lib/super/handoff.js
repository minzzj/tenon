// 榫卯 Tenon v2.1 · 手机 → 电脑流转（handoff，学鸿蒙超级终端「手机一倾内容滑到电脑」）
//
// 流程：校验 body → 找电脑大屏节点 → append 契约 v2.1 的 super.handoff 事件 →
//       给电脑节点派 handoff.show 任务（节点在线时；没有 handoff.show 就退到 system.open 打开中枢的 #/handoff 页）→
//       返回 {ok,handoffId,dispatched,...}。
// 只 append super.handoff（新事件）与复用现有 task.* 事件；不改 state.js。
import { newId } from '../ledger.js';
import { findComputerNode } from './catalog.js';
import { httpError, clip } from './errors.js';

export const HANDOFF_KINDS = ['page', 'photo', 'text'];
const KIND_LABEL = { page: '页面', photo: '照片', text: '文字' };
const MAX_URL = 2000;
const MAX_TEXT = 2000;

export function buildHandoffPageUrl(base, payload) {
  const params = new URLSearchParams();
  params.set('kind', payload.kind || 'text');
  if (payload.url) params.set('url', payload.url);
  if (payload.assetId) params.set('asset', payload.assetId);
  if (payload.text) params.set('text', payload.text.slice(0, 300));
  if (payload.handoffId) params.set('id', payload.handoffId);
  const root = String(base || '').replace(/\/$/, '');
  return `${root}/#/handoff?${params.toString()}`;
}

export function normalizeHandoffInput(body = {}) {
  const kind = String(body.kind || '').trim().toLowerCase();
  if (!HANDOFF_KINDS.includes(kind)) throw httpError(400, `kind 必须是 ${HANDOFF_KINDS.join(' / ')}`);
  const url = body.url ? String(body.url).trim() : '';
  const assetId = body.assetId ? String(body.assetId).trim() : '';
  const text = body.text ? String(body.text).trim().slice(0, MAX_TEXT) : '';
  if (kind === 'page' && !url) throw httpError(400, 'kind=page 时必须提供 url');
  if (kind === 'photo' && !assetId && !url) throw httpError(400, 'kind=photo 时必须提供 assetId 或 url');
  if (kind === 'text' && !text) throw httpError(400, 'kind=text 时必须提供 text');
  if (url) {
    if (url.length > MAX_URL) throw httpError(400, `url 最长 ${MAX_URL} 字符`);
    if (!/^(https?:\/\/|tenon:\/\/|blob:|data:image\/)/i.test(url)) throw httpError(400, 'url 只接受 http/https/tenon:// 地址');
  }
  const fromDevice = body.fromDevice ? String(body.fromDevice).trim().slice(0, 80) : 'phone';
  return { kind, url, assetId, text, fromDevice };
}

/**
 * 创建一次流转（手机 → 电脑）。
 * @returns {{ok:boolean, handoffId:string, dispatched:boolean, toDevice:string, taskId:string|null, say:string}}
 */
export function createHandoff({ body, ledger, state, deps = {}, by = '你' }) {
  const input = normalizeHandoffInput(body || {});
  const handoffId = newId('handoff');
  const kindLabel = KIND_LABEL[input.kind] || '内容';
  const computer = findComputerNode(state || {});
  const node = computer ? computer.node : null;
  const dispatched = !!node;
  const toDevice = node ? node.id : 'desktop';
  const payload = {
    kind: input.kind,
    url: input.url || undefined,
    assetId: input.assetId || undefined,
    text: input.text || undefined,
    fromDevice: input.fromDevice,
    toDevice,
  };

  // 1) 先落流转事件（契约 v2.1：super.handoff）
  ledger.append('super.handoff', {
    handoffId,
    kind: input.kind,
    payload,
    fromDevice: input.fromDevice,
    toDevice,
    text: input.text,
    url: input.url,
    assetId: input.assetId,
    dispatched,
  }, 'super');

  // 2) 给电脑大屏派任务：优先 handoff.show；没有该能力就退到 system.open 打开中枢的流转页
  let taskId = null;
  if (node) {
    const capabilityId = computer.capabilityId;
    const defaultHubUrl = deps.hubUrl || process.env.TENON_PUBLIC_URL || `http://127.0.0.1:${process.env.TENON_PORT || 7410}`;
    const params = capabilityId === 'handoff.show'
      ? { kind: input.kind, url: input.url || undefined, assetId: input.assetId || undefined, text: input.text || undefined, fromDevice: input.fromDevice, handoffId }
      : { target: buildHandoffPageUrl(defaultHubUrl, { ...payload, handoffId }), handoffId };
    if (capabilityId !== 'handoff.show') params.kind = input.kind;
    taskId = newId('task');
    const draft = {
      summary: `流转到电脑：${kindLabel}`,
      capabilities: [{ id: capabilityId, name: capabilityId === 'handoff.show' ? '流转到电脑大屏' : '在电脑打开流转页', risk: 'reversible', manualOnly: false, version: '2.1.0', evidence: node.evidence || 'declared' }],
      targetDevice: { id: node.id, name: node.name },
      params,
      risk: { level: 'reversible', reasons: [] },
      missing: [],
    };
    ledger.append('task.drafted', {
      taskId,
      text: `手机流转（${kindLabel}）到 ${node.name}`,
      draft,
      requester: by,
      source: 'super',
      evidenceLevel: 'certain',
      ai: { provider: 'rule', fallback: true },
    }, 'super');
    ledger.append('task.queued', { taskId, nodeId: node.id, note: '流转到电脑，等待节点接单' }, 'super');
    if (typeof deps.nodeRunner === 'function') {
      ledger.append('task.started', { taskId, nodeId: node.id, nodeName: node.name }, 'super');
      try {
        const r = deps.nodeRunner({
          task: { id: taskId, taskId, capabilityId, params, draft, text: `流转到电脑：${kindLabel}` },
          capabilityId,
          handoff: { ...payload, handoffId },
        });
        const result = r && typeof r.then === 'function' ? null : r;
        // createHandoff 是同步函数：nodeRunner 同步返回才立即落结果；异步执行交给 node-agent 轮询（不阻塞）
        if (result && typeof result === 'object') {
          ledger.append('task.succeeded', {
            taskId,
            result: { summary: String(result.summary || '已在电脑展示流转内容'), items: Array.isArray(result.items) ? result.items : [], partial: !!result.partial },
          }, 'super');
        }
      } catch (err) {
        ledger.append('task.failed', { taskId, error: clip((err && err.message) || err, 200) }, 'super');
      }
    }
  }

  const say = dispatched
    ? `已把${kindLabel}甩到电脑（${node.name}），电脑上应该已经出现。`
    : '已记录流转；电脑端暂时不在线，回到电脑后可在「流转」里查看。';
  return { ok: true, handoffId, dispatched, toDevice, taskId, kind: input.kind, say };
}

function projectHandoffEvent(ev) {
  const d = ev.data || {};
  return {
    at: ev.at,
    handoffId: d.handoffId || '',
    kind: d.kind || 'page',
    payload: d.payload || d,
    fromDevice: d.fromDevice || d.payload && d.payload.fromDevice || 'phone',
    toDevice: d.toDevice || 'desktop',
    text: d.text || '',
    url: d.url || '',
    assetId: d.assetId || '',
    dispatched: !!d.dispatched,
  };
}

export function recentHandoffs(ledger, limit = 10) {
  const events = (ledger && ledger.events) || [];
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
    if (events[i].type === 'super.handoff') out.push(projectHandoffEvent(events[i]));
  }
  return out;
}

export function projectAskEvent(ev) {
  const d = ev.data || {};
  return {
    at: ev.at,
    text: d.text || '',
    reply: d.reply || '',
    plan: d.plan || [],
    result: d.result || null,
    needsConfirm: !!d.needsConfirm,
  };
}

export function recentAsks(ledger, limit = 10) {
  const events = (ledger && ledger.events) || [];
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
    if (events[i].type === 'super.asked') out.push(projectAskEvent(events[i]));
  }
  return out;
}

export { KIND_LABEL };

export default { HANDOFF_KINDS, normalizeHandoffInput, createHandoff, buildHandoffPageUrl, recentHandoffs, recentAsks };