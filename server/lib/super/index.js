// 榫卯 Tenon v2.1 · 超级终端服务入口（server/lib/super/）
//
// 一句话愿景：**一个小软件，调动家里所有设备与程序；手机一倾，内容滑到电脑。**
//
// createSuperService(opts) 返回：
//   { catalog(), home(), programs({probe}), ask(text,{confirmed,context,by}), handoff(body),
//     state(), previewIntent(text,{context}), routes, routesAbsolute, deps, intentExamples }
//
// opts（Lead 的 server/lib/v2/index.js 会自动传入 root/ledger/state/ai/secret/dataDir/readOnly/authed）：
//   ledger   必需，事件账本（super.asked / super.handoff + 复用 task.*）
//   ai       可选，server/lib/ai.js 的 AI 实例（有 DEEPSEEK_API_KEY 时走 DeepSeek 意图，否则规则兜底）
//   state    可选初始状态；默认每次从 ledger 回放（推荐，保证看到最新设备）
//   dataDir  可选数据目录（默认 <root>/data；本模块目前只读 catalog，不落盘）
//   nodeRunner 可选，本地节点执行器 (payload)=>{summary,items,...}（测试/单机联调用；不传则 node 任务排队等 node-agent）
//   hubUrl   可选，中枢对外地址（流转 handoff 的浏览器页地址；默认 TENON_PUBLIC_URL 或 http://127.0.0.1:<TENON_PORT||7410>）
//   getState 可选，自定义状态获取函数
// 只 append super.asked / super.handoff 两种新事件（其余复用现有 task.* 事件）；不改 state.js（Lead 已加分支）。
import path from 'node:path';
import { replay } from '../state.js';
import { newId } from '../ledger.js';
import { buildCatalog } from './catalog.js';
import { parseIntent, createIntentCache, INTENT_EXAMPLES } from './intent.js';
import { executePlan } from './executor.js';
import { createHandoff, recentHandoffs, recentAsks } from './handoff.js';
import { createRoutes, absoluteRoutes } from './routes.js';
import { getSuperAction } from './actions.js';
import { httpError } from './errors.js';
import { loadPresets, findPreset, expandPlaceholders, PRESET_VERSION } from './presets.js';

export function createSuperService(options = {}) {
  const { ledger, state, root, dataDir, ai = null, nodeRunner = null, hubUrl = null, getState = null, by = '你' } = options;
  if (!ledger || typeof ledger.append !== 'function') throw new Error('createSuperService 需要 ledger 实例');
  const repoRoot = path.resolve(root || path.resolve(import.meta.dirname, '../../..'));
  const resolvedDataDir = path.resolve(dataDir || path.join(repoRoot, 'data'));
  const deps = {
    root: repoRoot,
    dataDir: resolvedDataDir,
    nodeRunner,
    hubUrl: hubUrl || process.env.TENON_PUBLIC_URL || `http://127.0.0.1:${process.env.TENON_PORT || 7410}`,
  };
  const currentState = () => {
    if (typeof getState === 'function') return getState();
    if (ledger && Array.isArray(ledger.events)) return replay(ledger.events);
    return state || { nodes: {}, meta: {} };
  };
  const intentCache = createIntentCache();
  const appListCache = new Map();

  async function probeAppList() {
    const st = currentState();
    const nodes = Object.values(st.nodes || {}).filter((n) => n && !n.disconnected && !n.hidden
      && (n.capabilities || []).some((c) => c && c.id === 'app.list'));
    const probed = [];
    if (!nodes.length) return { probes: probed, skipped: '没有注册 app.list 能力的电脑' };
    if (typeof deps.nodeRunner !== 'function') return { probes: probed, skipped: '未注入 nodeRunner（真实部署由 node-agent 认领任务）' };
    for (const node of nodes) {
      try {
        const taskId = newId('task');
        const raw = await deps.nodeRunner({
          task: {
            id: taskId,
            taskId,
            capabilityId: 'app.list',
            params: {},
            draft: { summary: '读取电脑程序清单', capabilities: [{ id: 'app.list', name: '读取电脑程序清单', risk: 'reversible', version: '2.1.0' }], targetDevice: { id: node.id, name: node.name }, params: {}, risk: { level: 'reversible', reasons: [] }, missing: [] },
          },
          capabilityId: 'app.list',
          action: getSuperAction('app.list'),
          step: { label: '读取电脑程序清单', capabilityId: 'app.list' },
        });
        const items = Array.isArray(raw && raw.items) ? raw.items : [];
        const apps = items
          .map((item) => (typeof item === 'string' ? { name: item } : { name: String((item && (item.name || item.app)) || '').trim() }))
          .filter((app) => app.name);
        if (apps.length) appListCache.set(node.id, apps);
        probed.push({ deviceId: node.id, name: node.name, count: apps.length, summary: raw && raw.summary });
      } catch (err) {
        probed.push({ deviceId: node.id, name: node.name, error: String((err && err.message) || err).slice(0, 160) });
      }
    }
    return { probes: probed, skipped: null };
  }

  const service = {
    root: repoRoot,
    dataDir: resolvedDataDir,
    deps,
    intentExamples: INTENT_EXAMPLES.slice(),
    intentCache,
    /** 设备 + 程序目录（可注入 app.list 探测结果） */
    catalog: () => buildCatalog({ state: currentState(), appsByNode: Object.fromEntries(appListCache) }),
    /** 首页数据：目录 + 最近流转/对话 + 建议话术 + 一键场景预设 */
    home: () => ({
      ok: true,
      catalog: service.catalog(),
      recent: { asks: recentAsks(ledger, 5), handoffs: recentHandoffs(ledger, 5) },
      suggestions: INTENT_EXAMPLES.slice(0, 8),
      presets: service.presets().presets,
    }),
    /** 一键场景预设（回家/工作/睡前；来自 data/super/presets.json 或内置） */
    presets: () => {
      const doc = loadPresets(resolvedDataDir);
      return {
        ok: true,
        version: PRESET_VERSION,
        source: doc.source,
        file: path.relative(repoRoot, doc.file).split(path.sep).join('/'),
        presets: doc.presets.map((preset) => ({
          id: preset.id,
          name: preset.name,
          icon: preset.icon,
          description: preset.description,
          steps: preset.steps.map((step) => ({ capabilityId: step.capabilityId, label: step.label })),
          stepCount: preset.steps.length,
        })),
      };
    },
    /** 执行一个场景预设：真实 plan → executor → node 队列；append scene.ran 供审计/界面读取 */
    presetRun: async (presetId, { confirmed = false, by: opBy = by } = {}) => {
      const { preset } = findPreset(resolvedDataDir, presetId);
      if (!preset) throw httpError(404, '场景预设不存在：' + presetId);
      const ctxVars = { hubUrl: deps.hubUrl, root: repoRoot };
      const plan = preset.steps.map((step) => ({
        capabilityId: step.capabilityId,
        label: step.label,
        params: expandPlaceholders(step.params || {}, ctxVars),
      }));
      const text = '场景：' + preset.name;
      const result = await executePlan({
        text,
        intent: { plan, say: preset.description || preset.name },
        ledger,
        state: currentState(),
        deps,
        by: opBy,
        confirmed: !!confirmed,
      });
      const ok = !!(result.ok && !result.needsConfirm);
      const sceneResult = {
        say: result.say || '',
        steps: result.steps || [],
        taskIds: result.taskIds || [],
        needsConfirm: !!result.needsConfirm,
        presetId: preset.id,
        presetName: preset.name,
      };
      try {
        ledger.append('scene.ran', {
          sceneId: preset.id,
          name: preset.name,
          by: opBy,
          ok,
          result: sceneResult,
        }, 'super');
      } catch {
        /* 审计事件失败不影响已派发的任务 */
      }
      return {
        ok,
        needsConfirm: !!result.needsConfirm,
        say: result.say || '',
        preset: { id: preset.id, name: preset.name, icon: preset.icon, description: preset.description },
        steps: result.steps || [],
        taskIds: result.taskIds || [],
        ai: result.ai || null,
      };
    },
    /** 程序清单；probe=true 时尝试实时读取电脑端 app.list（需要 nodeRunner，P0 不落账本） */
    programs: async ({ probe = false } = {}) => {
      const probeInfo = probe ? await probeAppList() : null;
      const catalog = service.catalog();
      return { ok: true, programs: catalog.programs, appListNodes: catalog.appListNodes, simulatedDevices: catalog.devices.filter((d) => d.simulated), probe: probeInfo };
    },
    /** 只解析意图、不执行（给 UI 预览/测试用） */
    previewIntent: async (text, { context = {} } = {}) => {
      const input = String(text || '').trim();
      if (!input) throw httpError(400, '请先说一句话');
      return parseIntent({ text: input, ai, catalog: service.catalog(), context, cache: intentCache });
    },
    /** 一句话 → 意图 → 计划 → 执行（不可逆动作未确认时返回 needsConfirm） */
    ask: async (text, { confirmed = false, context = {}, by: opBy = by } = {}) => {
      const input = String(text || '').trim();
      if (!input) throw httpError(400, '请先说一句话');
      const catalog = service.catalog();
      const intent = await parseIntent({ text: input, ai, catalog, context, cache: intentCache });
      const result = await executePlan({
        text: input,
        intent,
        ledger,
        state: currentState(),
        deps,
        by: opBy,
        confirmed: !!confirmed,
      });
      return {
        ...result,
        intent: { source: intent.source, ai: intent.ai, intent: intent.intent },
      };
    },
    /** 手机 → 电脑流转 */
    handoff: (body) => createHandoff({ body: body || {}, ledger, state: currentState(), deps, by }),
    /** 最近 asks / handoffs（账本投影；state.js v2.super 也可用） */
    state: () => ({ ok: true, asks: recentAsks(ledger, 10), handoffs: recentHandoffs(ledger, 10) }),
  };
  service.routes = createRoutes(service);
  service.routesAbsolute = absoluteRoutes(service.routes);
  return service;
}

export { buildCatalog } from './catalog.js';
export { parseIntent, parseRuleIntent, INTENT_EXAMPLES } from './intent.js';
export { executePlan } from './executor.js';
export { createHandoff, normalizeHandoffInput, recentAsks, recentHandoffs } from './handoff.js';
export { SUPER_ACTIONS, getSuperAction } from './actions.js';
export { DEFAULT_PRESETS, loadPresets, findPreset, expandPlaceholders, PRESET_VERSION } from './presets.js';
export { matchRoutes, matchPath, matchPathLoose, createRoutes, absoluteRoutes } from './routes.js';
export default createSuperService;