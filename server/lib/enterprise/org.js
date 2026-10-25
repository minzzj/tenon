// 企业控制面 · 成员 / 角色 / 动作白名单 / 越权留痕
// 持久化：data/enterprise/org.json（原子写）；账本只 append 契约 §3 的 enterprise.role.changed，
// 越权尝试额外 append enterprise.denied（任务卡要求；Lead 需在 state.js 补分支，未知事件当前 replay 会忽略）。
import crypto from 'node:crypto';
import path from 'node:path';
import { newId } from '../ledger.js';
import { readJson, writeJsonAtomic, clone } from './storage.js';
import { ROLES, ROLE_LABELS, ROLE_DEFAULT_ACTIONS } from './actions.js';

const USER_ALIASES = new Set(['operator', '你', 'admin', '管理员', 'root']);
const MEMBER_STATUSES = Object.freeze(['active', 'invited', 'disabled']);

function makeInviteCode() {
  return 'INV-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

function normalizeOverride(input) {
  if (input == null) return null;
  if (Array.isArray(input)) return { allow: input.map(String), deny: [] };
  if (typeof input === 'object') {
    return {
      allow: Array.isArray(input.allow) ? input.allow.map(String) : [],
      deny: Array.isArray(input.deny) ? input.deny.map(String) : [],
    };
  }
  return null;
}

export class OrgStore {
  constructor({ dir, ledger, policy, catalog, now = () => new Date(), defaultUserId = 'u_admin' }) {
    this.dir = dir;
    this.file = path.join(dir, 'org.json');
    this.ledger = ledger;
    this.policy = policy;
    this.catalog = catalog;
    this.now = now;
    this.defaultUserId = defaultUserId;
    const data = readJson(this.file, null);
    this.users = data && Array.isArray(data.users) ? data.users : [];
    this.seedIfNeeded();
  }

  seedIfNeeded() {
    const hasAdmin = this.users.some((u) => u.role === 'admin' && u.status === 'active');
    if (hasAdmin) return;
    const existed = this.users.find((u) => u.userId === this.defaultUserId);
    if (existed) {
      existed.role = 'admin';
      existed.status = 'active';
      existed.updatedAt = this.now().toISOString();
    } else {
      this.users.push({
        userId: this.defaultUserId,
        name: '系统管理员',
        role: 'admin',
        status: 'active',
        email: '',
        allowedActions: null,
        inviteCode: null,
        createdAt: this.now().toISOString(),
        createdBy: 'system',
      });
    }
    this.save();
  }

  save() {
    writeJsonAtomic(this.file, { users: this.users, updatedAt: this.now().toISOString() });
    return this;
  }

  listUsers() {
    return clone(this.users);
  }

  getUser(userId) {
    const one = this.users.find((u) => u.userId === String(userId || ''));
    return one ? clone(one) : null;
  }

  defaultAdminId() {
    const admin = this.users.find((u) => u.role === 'admin' && u.status === 'active');
    return admin ? admin.userId : this.defaultUserId;
  }

  /** 解析请求方：支持用户 id / 名称 / operator 别名；找不到返回 null。 */
  resolveActor(raw) {
    const key = String(raw == null ? '' : raw).trim();
    if (!key) return this.getUser(this.defaultAdminId());
    if (USER_ALIASES.has(key.toLowerCase())) return this.getUser(this.defaultAdminId());
    const byId = this.users.find((u) => u.userId === key);
    if (byId) return clone(byId);
    const byName = this.users.find((u) => u.name === key);
    return byName ? clone(byName) : null;
  }

  effectiveAllowed(member) {
    if (!member) return [];
    if (member.role === 'admin') return ['*'];
    const set = new Set(ROLE_DEFAULT_ACTIONS[member.role] || []);
    const override = member.allowedActions || null;
    if (override) {
      for (const id of override.allow || []) set.add(id);
      for (const id of override.deny || []) set.delete(id);
    }
    return [...set];
  }

  isAllowed(member, actionId) {
    if (!member || member.status !== 'active') return false;
    const action = this.catalog.get(actionId);
    if (!action) return false;
    if (member.role === 'admin') return true;
    if (action.adminOnly) return false;
    const allowed = this.effectiveAllowed(member);
    return allowed.includes('*') || allowed.includes(action.id);
  }

  /** 动作级鉴权：返回 {ok, code, reason, member, action}。 */
  checkAction(userId, actionId) {
    const member = this.resolveActor(userId);
    if (!member) return { ok: false, code: 'unknown_user', reason: '成员不存在，无法鉴权', member: null, action: null };
    if (member.status !== 'active') {
      return { ok: false, code: 'inactive_user', reason: `成员状态为 ${member.status}，无操作权限`, member, action: this.catalog.get(actionId) };
    }
    const action = this.catalog.get(actionId);
    if (!action) return { ok: false, code: 'unknown_action', reason: `未知动作：${actionId}`, member, action: null };
    if (!this.isAllowed(member, action.id)) {
      return { ok: false, code: 'forbidden', reason: `角色「${ROLE_LABELS[member.role] || member.role}」不被允许执行动作「${action.name}」(${action.id})`, member, action };
    }
    return { ok: true, code: 'allowed', reason: '', member, action };
  }

  appendRoleChanged(member, by) {
    const actor = by ? 'user:' + by : 'system';
    // 契约字段 {userId, role}；额外携带 name 供 state.js 企业成员快照展示（state 分支用 d.name 兜底）
    this.ledger.append('enterprise.role.changed', { userId: member.userId, role: member.role, name: member.name }, actor);
  }

  /** 越权留痕：任务卡要求 enterprise.denied（契约 §3 之外的第 4 个企业事件，需 Lead 注册 state 分支）。 */
  appendDenied({ userId, action, role, reason, route = 'internal' }) {
    const data = {
      userId: String(userId == null ? 'unknown' : userId),
      action: String(action == null ? '' : action),
      role: String(role == null ? 'unknown' : role),
      reason: String(reason == null ? '' : reason),
      route: String(route),
    };
    return this.ledger.append('enterprise.denied', data, 'user:' + data.userId);
  }

  validateMemberInput({ name, role, email }) {
    const errors = [];
    const n = String(name == null ? '' : name).trim();
    if (!n || n.length > 40) errors.push('name 必须是 1-40 字符');
    if (!ROLES.includes(role)) errors.push(`role 只能是 ${ROLES.join('/')}`);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) errors.push('email 格式不正确');
    return { ok: errors.length === 0, errors };
  }

  createMember({ name, role = 'member', email = '', allowedActions = null, createdBy = 'u_admin' }) {
    const check = this.validateMemberInput({ name, role, email });
    if (!check.ok) return { ok: false, code: 'invalid', errors: check.errors };
    const creator = this.resolveActor(createdBy);
    const by = creator ? creator.userId : this.defaultAdminId();
    const member = {
      userId: newId('u'),
      name: String(name).trim(),
      role,
      status: 'invited',
      email: String(email || '').trim(),
      allowedActions: normalizeOverride(allowedActions),
      inviteCode: makeInviteCode(),
      createdAt: this.now().toISOString(),
      createdBy: by,
    };
    this.users.push(member);
    this.save();
    this.appendRoleChanged(member, by);
    return { ok: true, user: clone(member) };
  }

  updateMember({ userId, patch = {}, by = 'u_admin' }) {
    const member = this.users.find((u) => u.userId === String(userId || ''));
    if (!member) return { ok: false, code: 'not_found', reason: '成员不存在' };
    const actor = this.resolveActor(by);
    if (!actor || actor.role !== 'admin') return { ok: false, code: 'forbidden', reason: '只有管理员可以修改成员' };
    const next = { ...member };
    if ('name' in patch) {
      const n = String(patch.name == null ? '' : patch.name).trim();
      if (!n || n.length > 40) return { ok: false, code: 'invalid', errors: ['name 必须是 1-40 字符'] };
      next.name = n;
    }
    if ('role' in patch) {
      if (!ROLES.includes(patch.role)) return { ok: false, code: 'invalid', errors: [`role 只能是 ${ROLES.join('/')}`] };
      next.role = patch.role;
    }
    if ('email' in patch) {
      const e = String(patch.email == null ? '' : patch.email).trim();
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, code: 'invalid', errors: ['email 格式不正确'] };
      next.email = e;
    }
    if ('status' in patch) {
      if (!MEMBER_STATUSES.includes(patch.status)) return { ok: false, code: 'invalid', errors: [`status 只能是 ${MEMBER_STATUSES.join('/')}`] };
      next.status = patch.status;
    }
    if ('allowedActions' in patch) next.allowedActions = normalizeOverride(patch.allowedActions);
    next.updatedAt = this.now().toISOString();
    const roleChanged = next.role !== member.role;
    Object.assign(member, next);
    this.save();
    if (roleChanged) this.appendRoleChanged(member, actor.userId);
    return { ok: true, user: clone(member) };
  }

  updateRole(userId, role, by) {
    return this.updateMember({ userId, patch: { role }, by });
  }

  createInvite({ role = 'member', name = '待加入成员', createdBy = 'u_admin' }) {
    return this.createMember({ name, role, createdBy });
  }

  acceptInvite(code, { name = '', userId = '' } = {}) {
    const key = String(code || '').trim().toUpperCase();
    const member = this.users.find((u) => u.inviteCode && String(u.inviteCode).toUpperCase() === key);
    if (!member) return { ok: false, code: 'invalid_invite', reason: '邀请码不存在' };
    if (member.status !== 'invited') return { ok: false, code: 'invite_used', reason: `邀请码状态为 ${member.status}` };
    member.status = 'active';
    member.inviteCode = null;
    if (name) member.name = String(name).trim().slice(0, 40);
    if (userId) {
      const clash = this.users.find((u) => u.userId === userId && u.userId !== member.userId);
      if (clash) return { ok: false, code: 'user_exists', reason: '用户 id 已存在' };
      member.userId = String(userId);
    }
    member.updatedAt = this.now().toISOString();
    this.save();
    return { ok: true, user: clone(member) };
  }

  sanitizeUser(member, { withInvite = false } = {}) {
    if (!member) return null;
    return {
      userId: member.userId,
      name: member.name,
      role: member.role,
      roleLabel: ROLE_LABELS[member.role] || member.role,
      status: member.status,
      email: member.email || '',
      allowedActions: member.allowedActions || null,
      effectiveActions: this.effectiveAllowed(member),
      inviteCode: withInvite ? (member.inviteCode || null) : undefined,
      createdAt: member.createdAt || null,
      updatedAt: member.updatedAt || null,
    };
  }
}
