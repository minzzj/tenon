// 企业控制面 · 策略（不可逆动作审批开关 / 审计保留 7|30|180 天 / 数据域标记）
import path from 'node:path';
import { readJson, writeJsonAtomic } from './storage.js';

export const RETENTION_OPTIONS = Object.freeze([7, 30, 180]);

export const DEFAULT_POLICY = Object.freeze({
  approvalRequiredForIrreversible: true,
  auditRetentionDays: 7,
  dataDomain: '企业数据域',
  crossDomainRequiresApproval: true,
  approvalTtlHours: 24,
});

export function validatePolicyPatch(patch) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: ['策略必须是对象'] };
  }
  const allowed = new Set(Object.keys(DEFAULT_POLICY));
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) errors.push(`未知策略字段：${key}`);
  }
  if ('approvalRequiredForIrreversible' in patch && typeof patch.approvalRequiredForIrreversible !== 'boolean') {
    errors.push('approvalRequiredForIrreversible 必须是布尔值');
  }
  if ('auditRetentionDays' in patch) {
    const n = Number(patch.auditRetentionDays);
    if (!RETENTION_OPTIONS.includes(n)) errors.push(`auditRetentionDays 只能是 ${RETENTION_OPTIONS.join('/')} 之一`);
    else patch.auditRetentionDays = n;
  }
  if ('dataDomain' in patch) {
    const s = String(patch.dataDomain == null ? '' : patch.dataDomain).trim();
    if (!s || s.length > 40) errors.push('dataDomain 必须是 1-40 字符');
    else patch.dataDomain = s;
  }
  if ('crossDomainRequiresApproval' in patch && typeof patch.crossDomainRequiresApproval !== 'boolean') {
    errors.push('crossDomainRequiresApproval 必须是布尔值');
  }
  if ('approvalTtlHours' in patch) {
    const n = Number(patch.approvalTtlHours);
    if (!Number.isInteger(n) || n < 1 || n > 720) errors.push('approvalTtlHours 必须是 1-720 的整数');
    else patch.approvalTtlHours = n;
  }
  return { ok: errors.length === 0, errors };
}

export class PolicyStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'policy.json');
    const patch = readJson(this.file, {}) || {};
    this.policy = { ...DEFAULT_POLICY };
    const check = validatePolicyPatch(patch);
    if (check.ok) Object.assign(this.policy, patch);
  }

  get() {
    return { ...this.policy, retentionOptions: RETENTION_OPTIONS.slice() };
  }

  update(patch = {}) {
    const check = validatePolicyPatch(patch);
    if (!check.ok) return { ok: false, errors: check.errors };
    this.policy = { ...this.policy, ...patch };
    writeJsonAtomic(this.file, this.policy);
    return { ok: true, policy: this.get() };
  }

  auditRetentionDays() {
    return this.policy.auditRetentionDays;
  }
}

export { DEFAULT_POLICY as POLICY_DEFAULTS };
