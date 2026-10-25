// 榫卯 Tenon v2.1 · 计划执行器
//
// 把 intent.js 产出的 plan 变成真实任务：
//   - node 动作：append task.drafted →（不可逆时 task.confirmed）→ task.queued；
//     注入 nodeRunner 时立即执行并写 task.started / task.succeeded / task.failed；未注入时保持 queued 等 node-agent 认领（dispatched）。
//   - hub 动作（handoff.show）：中枢直接执行，写 super.handoff 事件并给电脑节点派任务。
//   - simulated 动作（电视/音箱/灯等 P0 模拟设备）：明确标 simulated:true，不假装真实执行。
//   - 不可逆动作（打印）：未确认时只返回 needsConfirm + 预览，不执行、不写任务事件，但会记录一条 super.asked 便于审计。
// 最后 append super.asked {text,reply,plan,result,needsConfirm}（字段与 state.js 的 super.asked 分支一致）。
import { newId } from '../ledger.js';
import { getSuperAction, describeSuperAction, validateSuperParams, mapParamsForCapability } from './actions.js';
import { resolveActionDevice, simulatedDeviceForAction, SIMULATED_HOME_DEVICES } from './catalog.js';
import { createHandoff } from './handoff.js';
import { httpError, clip } from './errors.js';

function publicStep(step) {
  return {
    capabilityId: step.capabilityId,
    planCapabilityId: step.planCapabilityId || step.capabilityId,
    label: step.label,
    status: step.status,
    taskId: step.taskId || null,
    handoffId: step.handoffId || null,
    deviceName: step.nodeName || null,
    simulated: !!step.simulated,
    degradedReason: step.degradedReason || null,
    summary: step.summary || '',
    ms: step.ms || 0,
  };
}

// 计划步骤 → 由谁执行（node / simulated / unavailable；hub 动作在 intent 里就是 hub）
export function resolveStep(action, planStep, state) {
  const params = { ...(planStep.params || {}) };
  const base = {
    planCapabilityId: action.id,
    capabilityId: action.id,
    label: planStep.label || describeSuperAction(action, params),
    risk: action.risk,
    params,
    nodeId: null,
    nodeName: null,
    simulated: false,
    degradedReason: null,
  };
  if (action.kind === 'hub') {
    return { ...base, mode: 'hub', nodeId: 'hub', nodeName: '本机中枢' };
  }
  if (action.kind === 'simulated') {
    const wanted = params.deviceId ? SIMULATED_HOME_DEVICES.find((d) => d.deviceId === params.deviceId) : null;
    const device = wanted || simulatedDeviceForAction(action);
    return {
      ...base,
      mode: 'simulated',
      nodeId: device ? device.deviceId : 'sim-device',
      nodeName: device ? device.name : '模拟设备',
      simulated: true,
      degradedReason: device && device.note ? device.note : 'P0 模拟家庭设备（未接真机）',
    };
  }
  // node 动作
  const wantedId = planStep.nodeId;
  if (wantedId && state && state.nodes && state.nodes[wantedId]) {
    const node = state.nodes[wantedId];
    const matched = (action.capabilityChain || []).find((capId) => (node.capabilities || []).some((c) => c && c.id === capId && !c.authExpired && c.compatible !== false));
    if (matched && !node.disconnected && !node.hidden) {
      return { ...base, mode: 'node', capabilityId: matched, nodeId: node.id, nodeName: node.name };
    }
  }
  const resolved = resolveActionDevice(state || {}, action);
  if (resolved.mode === 'node') {
    return { ...base, mode: 'node', capabilityId: resolved.capabilityId, nodeId: resolved.node.id, nodeName: resolved.node.name };
  }
  if (resolved.mode === 'simulated') {
    return {
      ...base,
      mode: 'simulated',
      nodeId: resolved.node ? resolved.node.deviceId : 'sim-device',
      nodeName: resolved.node ? resolved.node.name : '模拟设备',
      simulated: true,
      degradedReason: resolved.degradedReason,
    };
  }
  return { ...base, mode: 'unavailable', degradedReason: resolved.degradedReason || `没有可用的「${action.name}」设备` };
}

function appendAsked(ledger, { text, reply, plan, result, needsConfirm }) {
  ledger.append('super.asked', {
    text,
    reply,
    plan,
    result,
    needsConfirm: !!needsConfirm,
  }, 'super');
}

function makeDraft({ step, actualCapabilityId, params, risk }) {
  return {
    summary: step.label,
    capabilities: [{
      id: actualCapabilityId,
      name: getSuperAction(step.planCapabilityId) ? getSuperAction(step.planCapabilityId).name : step.label,
      risk,
      manualOnly: false,
      version: '2.1.0',
      evidence: 'confirmed',
    }],
    targetDevice: { id: step.nodeId || 'hub', name: step.nodeName || '本机中枢' },
    params,
    risk: { level: risk, reasons: risk === 'irreversible' ? ['该动作不可逆（如打印/对外发送），需要人工确认'] : [] },
    missing: [],
  };
}

async function executeNodeStep({ step, ledger, deps, by }) {
  const action = getSuperAction(step.planCapabilityId);
  const taskId = newId('task');
  const params = mapParamsForCapability(action, step.params, step.capabilityId);
  const draft = makeDraft({ step, actualCapabilityId: step.capabilityId, params, risk: step.risk });
  const startedMs = Date.now();
  ledger.append('task.drafted', {
    taskId,
    text: `超级终端：${step.label}`,
    draft,
    requester: by,
    source: 'super',
    evidenceLevel: 'certain',
    ai: { provider: 'rule', fallback: true },
  }, 'super');
  if (step.risk === 'irreversible') {
    ledger.append('task.confirmed', { taskId, confirmedBy: by, note: '超级终端：用户已确认不可逆动作' }, 'super');
  }
  ledger.append('task.queued', { taskId, nodeId: step.nodeId, note: '超级终端派发，等待节点接单' }, 'super');
  if (typeof deps.nodeRunner !== 'function') {
    return {
      ...step,
      status: 'dispatched',
      taskId,
      summary: `已派发给 ${step.nodeName} 执行（node-agent 接单后完成）`,
      ms: Date.now() - startedMs,
    };
  }
  ledger.append('task.started', { taskId, nodeId: step.nodeId, nodeName: step.nodeName }, 'super');
  try {
    const raw = await deps.nodeRunner({
      task: { id: taskId, taskId, capabilityId: step.capabilityId, params, draft, text: `超级终端：${step.label}` },
      capabilityId: step.capabilityId,
      action,
      step,
    });
    const result = {
      summary: String((raw && raw.summary) || `${step.label}已执行`),
      items: Array.isArray(raw && raw.items) ? raw.items : [],
      partial: !!(raw && raw.partial),
      ...(raw && raw.evidence ? { evidence: raw.evidence } : {}),
    };
    ledger.append('task.succeeded', { taskId, result }, 'super');
    return { ...step, status: 'succeeded', taskId, summary: result.summary, items: result.items, ms: Date.now() - startedMs };
  } catch (err) {
    const message = clip((err && err.message) || err, 200);
    ledger.append('task.failed', { taskId, error: message }, 'super');
    return { ...step, status: 'failed', taskId, summary: `${step.label}失败：${message}`, ms: Date.now() - startedMs };
  }
}

function executeSimulatedStep(step, ledger) {
  const action = getSuperAction(step.planCapabilityId);
  const taskId = newId('task');
  const draft = makeDraft({ step, actualCapabilityId: step.capabilityId, params: step.params, risk: 'reversible' });
  draft.capabilities[0].evidence = 'simulated';
  ledger.append('task.drafted', { taskId, text: `超级终端（模拟设备）：${step.label}`, draft, requester: '你', source: 'super', evidenceLevel: 'declared', ai: { provider: 'rule', fallback: true } }, 'super');
  ledger.append('task.started', { taskId, nodeId: 'hub', nodeName: '本机中枢（模拟设备）' }, 'super');
  ledger.append('task.step', { taskId, label: '模拟执行', detail: `${step.nodeName}：P0 未接真实设备，结果已标注模拟` }, 'super');
  const summary = action && typeof action.simulatedSummary === 'function'
    ? action.simulatedSummary(step.params)
    : `（模拟）已执行：${step.label}`;
  ledger.append('task.succeeded', { taskId, result: { summary, items: [{ name: step.nodeName || '模拟设备', ok: true, detail: 'simulated' }], partial: false, simulated: true } }, 'super');
  return { ...step, status: 'succeeded', taskId, simulated: true, summary, ms: 0 };
}

/**
 * 执行一份计划并记录 super.asked。
 * @returns {{ok:boolean, needsConfirm:boolean, say:string, plan:Array, steps:Array, taskIds:Array, ai:object}}
 */
export async function executePlan({ text, intent, ledger, state, deps = {}, by = '你', confirmed = false }) {
  const plan = Array.isArray(intent.plan) ? intent.plan : [];
  const say = String(intent.say || '').trim();
  const aiInfo = intent.ai || { provider: 'rule', fallback: true };

  // 纯问答：没有计划，直接记录并返回
  if (!plan.length) {
    const result = { ok: true, needsConfirm: false, steps: [], taskIds: [], ai: aiInfo };
    appendAsked(ledger, { text, reply: say, plan: [], result, needsConfirm: false });
    return { ok: true, needsConfirm: false, say, plan: [], steps: [], taskIds: [], ai: aiInfo };
  }

  // 1) 逐步骤解析执行者；参数不合法/不可执行的步骤提前标出
  const resolved = plan.map((planStep) => {
    const action = getSuperAction(planStep.capabilityId);
    if (!action) return { planCapabilityId: planStep.capabilityId, capabilityId: planStep.capabilityId, label: planStep.label || planStep.capabilityId, risk: 'reversible', params: planStep.params || {}, mode: 'unavailable', nodeId: null, nodeName: null, simulated: false, degradedReason: `未知动作 ${planStep.capabilityId}` };
    const paramErrors = validateSuperParams(action, planStep.params || {});
    const step = resolveStep(action, planStep, state);
    if (paramErrors.length) return { ...step, mode: 'unavailable', degradedReason: `参数不合法：${paramErrors.join('；')}` };
    return step;
  });

  const needConfirmSteps = resolved.filter((s) => s.risk === 'irreversible');
  // 2) 不可逆动作：未确认 → 只返回预览（不执行、不写 task.*）
  if (needConfirmSteps.length && !confirmed) {
    const previewSteps = resolved.map((s) => publicStep({ ...s, status: s.mode === 'unavailable' ? 'failed' : 'pending', summary: s.mode === 'unavailable' ? s.degradedReason : '' }));
    const reply = `${say || '这个动作不可逆，需要你确认。'}（需要确认后执行：${needConfirmSteps.map((s) => s.label).join('、')}）`;
    const result = { ok: false, needsConfirm: true, steps: previewSteps, taskIds: [], ai: aiInfo };
    appendAsked(ledger, { text, reply, plan, result, needsConfirm: true });
    return { ok: false, needsConfirm: true, say: reply, plan, steps: previewSteps, taskIds: [], ai: aiInfo };
  }

  // 3) 顺序执行
  const steps = [];
  for (const step of resolved) {
    if (step.mode === 'unavailable') {
      const taskId = newId('task');
      const draft = makeDraft({ step, actualCapabilityId: step.capabilityId, params: step.params, risk: 'reversible' });
      ledger.append('task.drafted', { taskId, text: `超级终端：${step.label}`, draft, requester: by, source: 'super', evidenceLevel: 'none', ai: { provider: 'rule', fallback: true } }, 'super');
      ledger.append('task.failed', { taskId, error: step.degradedReason }, 'super');
      steps.push({ ...step, status: 'failed', taskId, summary: `${step.label}失败：${step.degradedReason}` });
      continue;
    }
    if (step.mode === 'hub') {
      const action = getSuperAction(step.planCapabilityId);
      if (action.id === 'handoff.show') {
        const result = createHandoff({
          body: {
            kind: step.params.kind || 'page',
            url: step.params.url,
            assetId: step.params.assetId,
            text: step.params.text,
            fromDevice: step.params.fromDevice || 'phone',
          },
          ledger,
          state,
          deps,
          by,
        });
        steps.push({ ...step, status: 'succeeded', taskId: result.taskId, handoffId: result.handoffId, summary: result.say });
        continue;
      }
      const taskId = newId('task');
      ledger.append('task.drafted', { taskId, text: `超级终端：${step.label}`, draft: makeDraft({ step, actualCapabilityId: step.capabilityId, params: step.params, risk: 'reversible' }), requester: by, source: 'super', evidenceLevel: 'certain', ai: { provider: 'rule', fallback: true } }, 'super');
      ledger.append('task.started', { taskId, nodeId: 'hub', nodeName: '本机中枢' }, 'super');
      ledger.append('task.succeeded', { taskId, result: { summary: `已执行：${step.label}`, items: [], partial: false } }, 'super');
      steps.push({ ...step, status: 'succeeded', taskId, summary: `已执行：${step.label}` });
      continue;
    }
    if (step.mode === 'simulated') {
      steps.push(executeSimulatedStep(step, ledger));
      continue;
    }
    steps.push(await executeNodeStep({ step, ledger, deps, by }));
  }

  const ok = steps.every((s) => s.status === 'succeeded' || s.status === 'dispatched');
  const failed = steps.filter((s) => s.status === 'failed');
  const finalSay = ok
    ? (say || steps.map((s) => s.summary).join('；'))
    : `${say ? say + ' ' : ''}有 ${failed.length} 步没成功：${failed.map((s) => s.summary).join('；')}`;
  const publicSteps = steps.map(publicStep);
  const taskIds = steps.map((s) => s.taskId).filter(Boolean);
  const result = { ok, needsConfirm: false, steps: publicSteps, taskIds, ai: aiInfo };
  appendAsked(ledger, { text, reply: finalSay, plan, result, needsConfirm: false });
  return { ok, needsConfirm: false, say: finalSay, plan, steps: publicSteps, taskIds, ai: aiInfo };
}

export default { executePlan, resolveStep };