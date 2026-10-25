// 榫卯 Tenon v2 · 场景 CRUD（只读写 data/things/scenes.json，原子写，不碰 state.js）
//
// 场景文档：{ version: 1, scenes: [ { id, name, description, steps, createdAt, updatedAt, createdBy } ] }
// 步骤结构：{ actionId, params, targetDeviceId, needsConfirm }（下标即顺序）
// 每次定义 / 更新 / 删除都会 append 契约 §3 的 scene.defined {sceneId,name,steps}，审计可导出。
import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../ledger.js';
import { getActionDef, validateActionParams } from './actions.js';
import { httpError } from './errors.js';

export const SCENES_VERSION = 1;
export const MAX_STEPS = 20;

export function scenesFileOf(dataDir) {
  return path.join(dataDir, 'things', 'scenes.json');
}

// 原子写：先写同目录临时文件，再 rename 覆盖（H: 盘网络盘也能保证不出现半截 JSON）
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function readScenesFile(file) {
  if (!fs.existsSync(file)) return { version: SCENES_VERSION, scenes: [] };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || !Array.isArray(doc.scenes)) return { version: SCENES_VERSION, scenes: [] };
    return { version: SCENES_VERSION, scenes: doc.scenes.filter((s) => s && s.id) };
  } catch {
    // 文件损坏时不让整个中枢起不来：返回空场景，写入时覆盖修复
    return { version: SCENES_VERSION, scenes: [] };
  }
}

export function publicStep(step) {
  return {
    actionId: step.actionId,
    params: step.params || {},
    targetDeviceId: step.targetDeviceId || null,
    needsConfirm: !!step.needsConfirm,
  };
}

// 场景输入校验：名称、步骤数量、动作是否存在、参数是否满足 schema；不通过直接 400
export function validateSceneInput(input = {}) {
  const errors = [];
  const name = String(input.name || '').trim();
  const description = String(input.description || '').trim();
  if (!name) errors.push('场景名称不能为空');
  else if (name.length > 40) errors.push('场景名称最多 40 字');
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push('场景至少需要 1 个步骤');
  } else if (input.steps.length > MAX_STEPS) {
    errors.push(`场景步骤最多 ${MAX_STEPS} 个`);
  } else {
    input.steps.forEach((step, index) => {
      const label = `第 ${index + 1} 步`;
      if (!step || typeof step !== 'object') {
        errors.push(`${label}：步骤必须是对象`);
        return;
      }
      const action = getActionDef(step.actionId);
      if (!action) {
        errors.push(`${label}：未知动作 ${step.actionId}`);
        return;
      }
      for (const err of validateActionParams(action, step.params || {})) errors.push(`${label}（${action.name}）：${err}`);
      if (step.targetDeviceId !== undefined && step.targetDeviceId !== null && typeof step.targetDeviceId !== 'string') {
        errors.push(`${label}：targetDeviceId 必须是字符串`);
      }
      if (step.needsConfirm !== undefined && typeof step.needsConfirm !== 'boolean') {
        errors.push(`${label}：needsConfirm 必须是布尔值`);
      }
    });
  }
  if (errors.length) throw httpError(400, errors.join('；'));
  return {
    name,
    description,
    steps: input.steps.map((step) => ({
      actionId: step.actionId,
      params: { ...(step.params || {}) },
      targetDeviceId: step.targetDeviceId || null,
      needsConfirm: !!step.needsConfirm,
    })),
  };
}

export class SceneStore {
  constructor({ ledger, dataDir }) {
    if (!ledger) throw new Error('SceneStore 需要 ledger');
    if (!dataDir) throw new Error('SceneStore 需要 dataDir');
    this.ledger = ledger;
    this.dataDir = dataDir;
    this.file = scenesFileOf(dataDir);
    this.doc = readScenesFile(this.file);
  }

  reload() {
    this.doc = readScenesFile(this.file);
    return this.doc;
  }

  save() {
    writeJsonAtomic(this.file, this.doc);
  }

  list() {
    return this.doc.scenes.slice();
  }

  get(sceneId) {
    return this.doc.scenes.find((scene) => scene.id === sceneId) || null;
  }

  requireScene(sceneId) {
    const scene = this.get(sceneId);
    if (!scene) throw httpError(404, `场景不存在：${sceneId}`);
    return scene;
  }

  appendDefined(scene) {
    this.ledger.append('scene.defined', {
      sceneId: scene.id,
      name: scene.name,
      steps: scene.steps.map(publicStep),
    }, 'hub');
  }

  create(input, by = '你') {
    const validated = validateSceneInput(input);
    const now = new Date().toISOString();
    const scene = {
      id: newId('scene'),
      name: validated.name,
      description: validated.description,
      steps: validated.steps,
      createdAt: now,
      updatedAt: now,
      createdBy: by,
    };
    this.doc.scenes.push(scene);
    this.save();
    this.appendDefined(scene);
    return scene;
  }

  update(sceneId, patch = {}, by = '你') {
    const scene = this.requireScene(sceneId);
    const validated = validateSceneInput({
      name: patch.name !== undefined ? patch.name : scene.name,
      description: patch.description !== undefined ? patch.description : scene.description,
      steps: patch.steps !== undefined ? patch.steps : scene.steps,
    });
    scene.name = validated.name;
    scene.description = validated.description;
    scene.steps = validated.steps;
    scene.updatedAt = new Date().toISOString();
    scene.updatedBy = by;
    this.save();
    this.appendDefined(scene);
    return scene;
  }

  remove(sceneId) {
    const scene = this.requireScene(sceneId);
    this.doc.scenes = this.doc.scenes.filter((s) => s.id !== sceneId);
    this.save();
    // 删除也留痕：等价于「重定义为空场景」，字段沿用契约 §3 的 scene.defined {sceneId,name,steps}
    this.ledger.append('scene.defined', { sceneId: scene.id, name: scene.name, steps: [] }, 'hub');
    return scene;
  }
}

export default { SceneStore, validateSceneInput, writeJsonAtomic, readScenesFile, scenesFileOf, publicStep, SCENES_VERSION };