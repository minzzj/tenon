// 企业控制面 · 审批流：请求 / 通过 / 拒绝 / 执行前检查
// 账本事件严格使用契约 §3 字段：approval.requested {requestId,action,by}、approval.decided {requestId,ok,by}。
import path from 'node:path';
import { newId } from '../ledger.js';
import { readJson, writeJsonAtomic, clone } from './storage.js';

export const APPROVAL_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);

export class ApprovalStore {
  constructor({ dir, ledger, org, policy, now = () => new Date() }) {
    this.dir = dir;
    this.file = path.join(dir, 'approvals.json');
    this.ledger = ledger;
    this.org = org;
    this.policy = policy;
    this.now = now;
    const data = readJson(this.file, null);
    this.requests = data && Array.isArray(data.requests) ? data.requests : [];
  }

  save() {
    writeJsonAtomic(this.file, { requests: this.requests, updatedAt: this.now().toISOString() });
  }

  find(requestId) {
    return this.requests.find((r) => r.requestId === String(requestId || '')) || null;
  }

  get(requestId) {
    const one = this.find(requestId);
    return one ? clone(one) : null;
  }

  list({ status = 'all', by = '', limit = 50 } = {}) {
    let list = this.requests.slice();
    if (status && status !== 'all') list = list.filter((r) => r.status === status);
    if (by) list = list.filter((r) => r.by === by);
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const max = Math.max(1, Math.min(200, Number(limit) || 50));
    return clone(list.slice(0, max));
  }

  create({ action, by, context = {} }) {
    const check = this.org.checkAction(by, action);
    if (!check.ok) return { ok: false, code: check.code, reason: check.reason };
    const member = check.member;
    const request = {
      requestId: newId('apr'),
      action: check.action.id,
      actionName: check.action.name,
      risk: check.action.risk,
      by: member.userId,
      byName: member.name,
      role: member.role,
      status: 'pending',
      context: clone(context || {}),
      createdAt: this.now().toISOString(),
      decidedAt: null,
      decidedBy: null,
      decidedByName: null,
      reason: '',
      consumedAt: null,
    };
    this.requests.push(request);
    this.save();
    this.ledger.append('approval.requested', { requestId: request.requestId, action: request.action, by: request.by }, 'user:' + request.by);
    return { ok: true, request: clone(request) };
  }

  decide({ requestId, ok, by, reason = '' }) {
    const request = this.find(requestId);
    if (!request) return { ok: false, code: 'not_found', reason: '审批请求不存在' };
    if (request.status !== 'pending') return { ok: false, code: 'not_pending', reason: `审批已是 ${request.status} 状态` };
    const approver = this.org.resolveActor(by);
    if (!approver) return { ok: false, code: 'unknown_user', reason: '审批人不存在' };
    if (approver.status !== 'active' || approver.role !== 'admin') {
      return { ok: false, code: 'forbidden', reason: '只有管理员可以审批', approver };
    }
    if (approver.userId === request.by) {
      return { ok: false, code: 'self_approval', reason: '不能审批自己发起的请求', approver };
    }
    request.status = ok ? 'approved' : 'rejected';
    request.decidedBy = approver.userId;
    request.decidedByName = approver.name;
    request.decidedAt = this.now().toISOString();
    request.reason = String(reason == null ? '' : reason).slice(0, 200);
    this.save();
    this.ledger.append('approval.decided', { requestId: request.requestId, ok: !!ok, by: approver.userId }, 'user:' + approver.userId);
    return { ok: true, request: clone(request), approver };
  }

  ttlHours() {
    const n = Number(this.policy.get().approvalTtlHours);
    return Number.isFinite(n) && n > 0 ? n : 24;
  }

  isExpired(request) {
    const at = Date.parse(request.decidedAt);
    if (!Number.isFinite(at)) return true;
    return at + this.ttlHours() * 3600 * 1000 < this.now().getTime();
  }

  /** 执行前检查：审批必须 approved / 动作与执行人一致 / 未过期 / 未使用过；通过后标记 consumed。 */
  findUsable({ requestId, action, by }) {
    const request = this.find(requestId);
    if (!request) return { ok: false, code: 'not_found', reason: '审批请求不存在' };
    if (request.status !== 'approved') return { ok: false, code: 'not_approved', reason: `审批状态为 ${request.status}` };
    if (request.action !== String(action)) return { ok: false, code: 'action_mismatch', reason: '审批动作与本次要执行的动作不一致' };
    if (request.by !== String(by)) return { ok: false, code: 'by_mismatch', reason: '审批请求与执行人不是同一成员' };
    if (request.consumedAt) return { ok: false, code: 'already_consumed', reason: '审批已使用，不可重复使用' };
    if (this.isExpired(request)) return { ok: false, code: 'expired', reason: '审批已过期（超过 approvalTtlHours）' };
    request.consumedAt = this.now().toISOString();
    this.save();
    return { ok: true, request: clone(request) };
  }
}
