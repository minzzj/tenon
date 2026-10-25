// 榫卯 Tenon v2 · 场景执行器
//
// 执行语义（复用现有任务引擎的事件契约，不重复造状态机）：
//   1) 每个步骤 = 一个任务（taskId）；不可逆动作先写 task.confirmed 再排队/执行，与 tasks.confirmTask 的字段一致；
//   2) node 动作：task.drafted →（不可逆则 task.confirmed）→ task.queued；
//      - 注入 nodeRunner（本地/测试执行器）时：追加 task.started，直接执行并写 task.succeeded / task.failed；
//      - 未注入时：留在 queued 等真实 node-agent 通过 /api/node/pull 认领（结果标记 dispatched，不假装已执行）；
//   3) hub 动作（备份 / 通知 / 降级模拟）：不写 task.queued（避免 http.js 的中枢执行订阅重复触发），
//      直接 task.started → 执行 → task.succeeded，证据（真实文件 / outbox 记录）在结果里返回；
//   4) 场景整体执行完 append scene.ran {sceneId,by,result}；未确认时**不写任何账本事件**，只返回需要确认的步骤。
import { replay } from '../state.js';
import { newId } from '../ledger.js';
import { getActionDef, requireActionDef, describeAction, validateActionParams, resolveStepTarget } from './actions.js';
import { httpError } from './errors.js';

const MAX_ERROR_LEN = 200;

function clip(text) {
  return String(text || '').slice(0, MAX_ERROR_LEN);
}

function isoNow() {
  return new Date().toISOString();
}

function normalizeResult(raw, action) {
  const r = raw || {};
  return {
    summary: String(r.summary || `${action.name}已执行`),
    items: Array.isArray(r.items) ? r.items : [],
    partial: !!r.partial,
    ...(r.simulated ? { simulated: true } : {}),
    ...(r.evidence ? { evidence: r.evidence } : {}),
  };
}

function buildDraft(action, step, target, scene, confirmRequired) {
  return {
    summary: `${action.name}：${describeAction(action, step.params)}`,
    capabilities: [{
      id: action.capabilityId,
      name: action.name,
      risk: confirmRequired ? 'irreversible' : action.risk,
      manualOnly: false,
      version: '2.0.0',
      evidence: 'confirmed',
    }],
    targetDevice: target.mode === 'node'
      ? { id: target.targetDeviceId, name: target.targetDeviceName }
      : { id: 'hub', name: '本机中枢' },
    params: { ...(step.params || {}) },
    risk: {
      level: confirmRequired ? 'irreversible' : action.risk,
      reasons: confirmRequired ? [`${action.name} 属于${action.risk === 'irreversible' ? '不可逆动作' : '需要确认的动作'}`] : [],
    },
    missing: [],
  };
}

function nodeEvidenceOf(state, target) {
  if (target.mode !== 'node') return 'certain';
  const node = (state.nodes || {})[target.targetDeviceId];
  return node && node.evidence === 'confirmed' ? 'certain' : 'possible';
}

// 场景预览：解析每个步骤的动作、风险、是否需要确认、目标设备与可用性；不写任何东西
export function previewScene({ scene, state }) {
  const steps = scene.steps.map((step, index) => {
    const info = {
      index,
      actionId: step.actionId,
      actionName: step.actionId,
      capabilityId: null,
      risk: 'unknown',
      needsConfirm: !!step.needsConfirm,
      params: step.params || {},
      targetDeviceId: step.targetDeviceId || null,
      targetDeviceName: null,
      mode: null,
      degradedReason: null,
      error: null,
    };
    try {
      const action = requireActionDef(step.actionId);
      info.actionName = action.name;
      info.capabilityId = action.capabilityId;
      info.risk = action.risk;
      const paramErrors = validateActionParams(action, step.params || {});
      if (paramErrors.length) throw httpError(400, paramErrors.join('；'));
      const target = resolveStepTarget(action, state, step);
      info.targetDeviceId = target.targetDeviceId;
      info.targetDeviceName = target.targetDeviceName;
      info.mode = target.mode;
      info.degradedReason = target.degradedReason || null;
      info.needsConfirm = action.risk === 'irreversible' || !!step.needsConfirm;
      info.requiresConfirmation = action.risk === 'irreversible';
      info.available = true;
    } catch (err) {
      info.error = String((err && err.message) || err);
    }
    return info;
  });
  const needsConfirm = steps.some((s) => s.needsConfirm);
  const blocked = steps.some((s) => s.error);
  const confirmReasons = steps.filter((s) => s.needsConfirm).map((s) => `第 ${s.index + 1} 步「${s.actionName}」需要确认（${s.risk === 'irreversible' ? '不可逆动作' : '步骤要求确认'}）`);
  return {
    ok: !blocked,
    sceneId: scene.id,
    name: scene.name,
    description: scene.description || '',
    steps,
    needsConfirm,
    confirmReasons,
    blocked,
    errors: steps.filter((s) => s.error).map((s) => `第 ${s.index + 1} 步：${s.error}`),
  };
}

async function executeStep({ action, step, scene, target, ledger, deps, by, state }) {
  const confirmRequired = action.risk === 'irreversible' || !!step.needsConfirm;
  const taskId = newId('task');
  const text = `${scene.name} · ${action.name}`;
  const draft = buildDraft(action, step, target, scene, confirmRequired);
  const startedMs = Date.now();

  // 1) 草案（字段与 tasks.createDraft 写出的 task.drafted 保持一致，现有 UI/时间线可直接展示）
  ledger.append('task.drafted', {
    taskId,
    text,
    draft,
    requester: by,
    source: 'scene',
    evidenceLevel: nodeEvidenceOf(state, target),
    ai: { provider: 'scene', model: 'scene-engine', tokensIn: 0, tokensOut: 0, cached: false, fallback: true },
  }, 'hub');
  // 2) 不可逆动作：确认事件（语义等价 tasks.confirmTask 的 task.confirmed 字段）
  if (confirmRequired) {
    ledger.append('task.confirmed', { taskId, confirmedBy: by, note: '场景执行：已确认不可逆动作' }, 'hub');
  }
  ledger.append('task.step', { taskId, label: '动作解析', detail: describeAction(action, step.params) }, 'hub');

  const stepBase = {
    index: step.index,
    actionId: action.id,
    actionName: action.name,
    taskId,
    risk: action.risk,
    confirmRequired,
    targetDeviceId: target.targetDeviceId,
    targetDeviceName: target.targetDeviceName,
    mode: target.mode,
    degradedReason: target.degradedReason || null,
  };

  // 3) node 动作：排队 →（有本地执行器则立即执行）→ 结果事件
  if (target.mode === 'node') {
    ledger.append('task.queued', {
      taskId,
      nodeId: target.targetDeviceId,
      note: deps.nodeRunner ? '本地节点执行器接单' : '等待节点接单（node-agent 通过 /api/node/pull 认领）',
    }, 'hub');
    if (!deps.nodeRunner) {
      return { ...stepBase, ok: true, status: 'dispatched', summary: `已派发到 ${target.targetDeviceName} 等待执行`, items: [], ms: Date.now() - startedMs };
    }
    ledger.append('task.started', { taskId, nodeId: target.targetDeviceId, nodeName: target.targetDeviceName }, 'hub');
    try {
      const raw = await deps.nodeRunner({
        task: { id: taskId, taskId, capabilityId: action.capabilityId, params: step.params || {}, draft, text },
        capabilityId: action.capabilityId,
        action,
        step,
        scene,
        target,
      });
      const result = normalizeResult(raw, action);
      ledger.append('task.succeeded', { taskId, result }, 'hub');
      return { ...stepBase, ok: true, status: 'succeeded', summary: result.summary, items: result.items, ms: Date.now() - startedMs };
    } catch (err) {
      const message = clip((err && err.message) || err);
      ledger.append('task.failed', { taskId, error: message }, 'hub');
      return { ...stepBase, ok: false, status: 'failed', summary: `「${action.name}」执行失败：${message}`, items: [], ms: Date.now() - startedMs };
    }
  }

  // 4) hub 动作：本机直接执行（备份真实拷贝 / 通知写收件箱 / 降级模拟留痕）
  ledger.append('task.started', { taskId, nodeId: 'hub', nodeName: '本机中枢' }, 'hub');
  try {
    const raw = await action.hubRun({
      root: deps.root,
      dataDir: deps.dataDir,
      ledger,
      taskId,
      params: step.params || {},
      scene,
      step,
      action,
      target,
      by,
      degradedReason: target.degradedReason || null,
      opener: deps.opener,
      nodeRunner: deps.nodeRunner,
    });
    const result = normalizeResult(raw, action);
    ledger.append('task.succeeded', { taskId, result }, 'hub');
    return { ...stepBase, ok: true, status: 'succeeded', summary: result.summary, items: result.items, simulated: !!result.simulated, ms: Date.now() - startedMs };
  } catch (err) {
    const message = clip((err && err.message) || err);
    ledger.append('task.failed', { taskId, error: message }, 'hub');
    return { ...stepBase, ok: false, status: 'failed', summary: `「${action.name}」执行失败：${message}`, items: [], ms: Date.now() - startedMs };
  }
}

// 执行场景：先预览；需要确认而未确认时直接返回（不写账本）；否则逐步执行并写 scene.ran
export async function runScene({ scene, ledger, deps = {}, state, confirmed = false, by = '你', continueOnError = false }) {
  if (!scene) throw httpError(404, '场景不存在');
  const preview = previewScene({ scene, state });
  if (preview.blocked) {
    return { ok: false, needsConfirm: false, confirmed: false, sceneId: scene.id, name: scene.name, preview, error: preview.errors.join('；'), steps: [], taskIds: [] };
  }
  if (preview.needsConfirm && !confirmed) {
    return {
      ok: false,
      needsConfirm: true,
      confirmed: false,
      sceneId: scene.id,
      name: scene.name,
      preview,
      confirmReasons: preview.confirmReasons,
      steps: [],
      taskIds: [],
    };
  }

  const startedAt = isoNow();
  const results = [];
  for (const stepInfo of preview.steps) {
    const step = scene.steps[stepInfo.index];
    let result;
    try {
      const action = getActionDef(step.actionId);
      // 每一步执行前重新回放状态：设备在线/授权可能在执行期间变化
      const freshState = replay(ledger.events);
      const target = resolveStepTarget(action, freshState, step);
      result = await executeStep({ action, step: { ...step, index: stepInfo.index }, scene, target, ledger, deps, by, state: freshState });
    } catch (err) {
      result = {
        index: stepInfo.index,
        actionId: step.actionId,
        actionName: stepInfo.actionName,
        taskId: null,
        risk: stepInfo.risk,
        confirmRequired: !!stepInfo.needsConfirm,
        targetDeviceId: stepInfo.targetDeviceId,
        targetDeviceName: stepInfo.targetDeviceName,
        mode: stepInfo.mode,
        ok: false,
        status: 'failed',
        summary: `「${stepInfo.actionName}」执行失败：${clip((err && err.message) || err)}`,
        items: [],
        ms: 0,
      };
    }
    results.push(result);
    if (!result.ok && !continueOnError) break;
  }

  const finishedAt = isoNow();
  const ok = results.length === preview.steps.length && results.every((r) => r.ok);
  const taskIds = results.map((r) => r.taskId).filter(Boolean);
  const dispatched = results.filter((r) => r.status === 'dispatched').length;
  const summary = ok
    ? dispatched > 0
      ? `${scene.name}：${results.length} 个步骤已派发（${dispatched} 个等待目标设备执行）`
      : `${scene.name}：${results.length} 个步骤执行完成`
    : `${scene.name}：${results.filter((r) => r.ok).length}/${results.length} 个步骤成功，执行中止`;
  const result = {
    ok,
    sceneId: scene.id,
    name: scene.name,
    by,
    startedAt,
    finishedAt,
    ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    confirmRequired: preview.needsConfirm,
    taskIds,
    steps: results,
    summary,
  };
  // 契约 §3 字段 {sceneId,by,result} 全部保留；额外带顶层 ok 供 state.js 的 scene.ran 分支（读 d.ok）正确记录失败场景
  ledger.append('scene.ran', { sceneId: scene.id, by, ok, result }, 'hub');
  return { needsConfirm: false, confirmed: true, ...result };
}

export default { previewScene, runScene };