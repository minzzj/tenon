// 榫卯 Tenon v2 · 物模型与场景控制（server/lib/things/）
//
// 对外入口：createThingsService({ ledger, state, root, dataDir, nodeRunner, opener, getState, by })
//   - ledger    ：必需，server/lib/ledger.js 的 Ledger 实例（场景定义/场景执行/任务事件都写这里）
//   - state     ：可选，初始状态快照（不传则每次从 ledger 回放，推荐不传，保证看到最新状态）
//   - root      ：仓库根（默认由本文件位置推导），用于解析「相对仓库根」的路径参数
//   - dataDir   ：数据目录（默认 <root>/data），场景与 outbox 证据写入 <dataDir>/things/
//   - nodeRunner：可选，注入的本地节点执行器 (payload) => {summary,items,partial}
//                 不注入时 node 动作只排队等真实 node-agent 认领，不假装已执行
//   - opener    ：可选，本机打开器 (absPath) => Promise<void>（投屏动作降级本机执行时调用；不注入则只留痕）
//   - getState  ：可选，自定义状态获取函数（默认 replay(ledger.events)）
//   - by        ：默认操作者（默认「你」）
//
// 返回：
//   { model(), listActions(), listScenes(), getScene(id), createScene(input), updateScene(id,patch),
//     removeScene(id), previewScene(id), runScene(id,{confirmed,by}), routes, routesAbsolute, store, dataDir, root }
//
// 集成：Lead 的 server/lib/v2/index.js 会自动 import 本文件并调用 createThingsService({...})，
// 然后挂载返回的 `routes`（path 相对 /api/v2，例如 GET /things/model、POST /scenes/:id/run）。
// 若采用整路径匹配，可用 `routesAbsolute`（path 带 /api/v2 前缀），或用 matchRoutes(routes, method, pathname) 自动兼容。
import path from 'node:path';
import { replay } from '../state.js';
import { buildThingModel } from './model.js';
import { ACTIONS, listActions, getActionDef } from './actions.js';
import { SceneStore, validateSceneInput } from './scenes.js';
import { previewScene, runScene } from './executor.js';
import { createRoutes, absoluteRoutes } from './routes.js';
import { httpError } from './errors.js';

export function createThingsService(options = {}) {
  const { ledger, state, root, dataDir, nodeRunner, opener, getState, by = '你' } = options;
  if (!ledger || typeof ledger.append !== 'function') throw new Error('createThingsService 需要 ledger 实例');
  const repoRoot = path.resolve(root || path.resolve(import.meta.dirname, '../../..'));
  const thingsDataDir = path.resolve(dataDir || path.join(repoRoot, 'data'));

  const currentState = () => {
    if (typeof getState === 'function') return getState();
    if (ledger && Array.isArray(ledger.events)) return replay(ledger.events);
    return state || { nodes: {}, tasks: {}, meta: {} };
  };
  const deps = { root: repoRoot, dataDir: thingsDataDir, nodeRunner, opener };
  const store = new SceneStore({ ledger, dataDir: thingsDataDir });

  const service = {
    root: repoRoot,
    dataDir: thingsDataDir,
    store,
    actions: ACTIONS,
    /** 物模型快照：设备属性 / 动作（含 risk 与参数 schema）/ 事件 */
    model: () => buildThingModel(currentState()),
    /** 内置动作目录（含每个动作的可用设备与降级方式） */
    listActions: () => listActions(currentState()),
    listScenes: () => store.list(),
    getScene: (sceneId) => store.get(sceneId),
    createScene: (input) => store.create(validateSceneInput(input || {}), by),
    updateScene: (sceneId, patch) => store.update(sceneId, patch || {}, by),
    removeScene: (sceneId) => store.remove(sceneId),
    /** 预览：解析动作/风险/目标设备/是否需要确认，不产生任何副作用 */
    previewScene: (sceneId) => {
      const scene = store.get(sceneId);
      if (!scene) throw httpError(404, `场景不存在：${sceneId}`);
      return previewScene({ scene, state: currentState() });
    },
    /** 执行：不可逆步骤在 confirmed !== true 时只返回 needsConfirm，不写账本、不执行 */
    runScene: (sceneId, runOptions = {}) => {
      const scene = store.get(sceneId);
      if (!scene) return Promise.reject(httpError(404, `场景不存在：${sceneId}`));
      return runScene({
        scene,
        ledger,
        deps,
        state: currentState(),
        confirmed: !!runOptions.confirmed,
        by: runOptions.by || by,
        continueOnError: !!runOptions.continueOnError,
      });
    },
    getActionDef,
  };
  service.routes = createRoutes(service);
  service.routesAbsolute = absoluteRoutes(service.routes);
  return service;
}

export { ACTIONS, listActions, buildThingModel, SceneStore, validateSceneInput, previewScene, runScene, getActionDef, httpError };
export { matchRoutes, matchPath, matchPathLoose, createRoutes, absoluteRoutes } from './routes.js';
export default createThingsService;