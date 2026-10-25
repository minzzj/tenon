// 企业控制面 · 动作目录与角色默认白名单
// 动作清单来源：Lead 注入的 things 模块 listActions（server/lib/things/actions.js）优先；
// 不可用时用内置清单。企业鉴权只认动作 id + risk，不写账本。
export const ROLES = Object.freeze(['admin', 'member', 'guest']);
export const ROLE_LABELS = Object.freeze({ admin: '管理员', member: '成员', guest: '访客' });

// 内置动作清单（things 模块不可用时的兜底；也补齐企业自身的 org.manage / audit.export 等动作）。
export const BUILTIN_ACTIONS = Object.freeze([
  { id: 'asset.print', name: '打印素材', risk: 'irreversible', category: 'asset' },
  { id: 'asset.showOnDesktop', name: '投屏到电脑', risk: 'reversible', category: 'asset' },
  { id: 'asset.backup', name: '备份素材到目录/NAS', risk: 'reversible', category: 'asset' },
  { id: 'asset.ingest', name: '导入素材', risk: 'reversible', category: 'asset' },
  { id: 'asset.tag', name: '素材打标签', risk: 'reversible', category: 'asset' },
  { id: 'asset.share', name: '分享素材到设备', risk: 'reversible', category: 'asset' },
  { id: 'asset.remove', name: '删除素材', risk: 'irreversible', category: 'asset' },
  { id: 'file.print', name: '打印文件', risk: 'irreversible', category: 'file' },
  { id: 'file.delete', name: '删除文件', risk: 'irreversible', category: 'file' },
  { id: 'system.open', name: '打开应用/文件', risk: 'reversible', category: 'system' },
  { id: 'system.volume', name: '调节音量', risk: 'reversible', category: 'system' },
  { id: 'system.power', name: '关机/重启', risk: 'irreversible', category: 'system' },
  { id: 'channel.notify', name: '发送通知', risk: 'reversible', category: 'channel' },
  { id: 'transfer.send', name: '发送文件到设备', risk: 'reversible', category: 'transfer' },
  { id: 'clipboard.share', name: '共享剪贴板', risk: 'reversible', category: 'clipboard' },
  { id: 'scene.run', name: '执行场景', risk: 'reversible', category: 'scene' },
  { id: 'audit.export', name: '导出审计', risk: 'reversible', category: 'audit' },
  { id: 'org.manage', name: '管理成员与策略', risk: 'irreversible', category: 'org', adminOnly: true },
]);

// 角色默认白名单：admin 全量；member 日常可逆动作 + 打印（不可逆，默认需审批）；
// guest 只读（不授予动作，管理员可用成员级 allowedActions 单独授权）。
export const ROLE_DEFAULT_ACTIONS = Object.freeze({
  admin: Object.freeze(['*']),
  member: Object.freeze([
    'asset.print',
    'asset.showOnDesktop',
    'asset.backup',
    'asset.ingest',
    'asset.tag',
    'asset.share',
    'system.open',
    'system.volume',
    'channel.notify',
    'transfer.send',
    'clipboard.share',
    'scene.run',
    'audit.export',
  ]),
  guest: Object.freeze([]),
});

function normalizeRisk(value, fallback = 'reversible') {
  const v = String(value || '').toLowerCase();
  if (v === 'irreversible' || v === '不可逆') return 'irreversible';
  if (v === 'reversible' || v === '可逆') return 'reversible';
  return fallback;
}

// things.actions[].listActions() 返回的是物模型动作，字段做兼容归一。
export function normalizeAction(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.actionId || raw.capabilityId || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(raw.name || raw.label || raw.title || id),
    risk: normalizeRisk(raw.risk || raw.riskLevel || (raw.irreversible ? 'irreversible' : 'reversible')),
    category: String(raw.category || raw.domain || raw.mode || 'things'),
    adminOnly: raw.adminOnly === true,
    source: raw.source || 'things',
    order: index,
  };
}

export function normalizeActionList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((x, i) => normalizeAction(x, i)).filter(Boolean);
}

function builtinCopy() {
  return BUILTIN_ACTIONS.map((a, i) => ({ ...a, source: 'builtin', order: i }));
}

/**
 * 动作目录（可变）：创建时用注入 listActions 或内置清单，运行时可 replaceWith() 接入 things 模块。
 * createActionCatalog({ listActions, state }) → { source, list(), get(id), has(id), isIrreversible(id), replaceWith() }
 */
export function createActionCatalog({ listActions = null, state = null } = {}) {
  let actions = builtinCopy();
  let source = 'builtin';
  let error = '';
  if (typeof listActions === 'function') {
    try {
      const normalized = normalizeActionList(listActions(state || {}));
      if (normalized.length) {
        actions = normalized;
        source = 'things';
      }
    } catch (e) {
      error = String((e && e.message) || e);
    }
  }
  const byId = new Map();
  const reindex = () => {
    byId.clear();
    for (const action of actions) byId.set(action.id, action);
  };
  reindex();

  return {
    get source() {
      return source;
    },
    get error() {
      return error;
    },
    list() {
      return actions.map((a) => ({ ...a }));
    },
    ids() {
      return actions.map((a) => a.id);
    },
    get(id) {
      const one = byId.get(String(id || ''));
      return one ? { ...one } : null;
    },
    has(id) {
      return byId.has(String(id || ''));
    },
    isIrreversible(id) {
      const one = byId.get(String(id || ''));
      return !!(one && one.risk === 'irreversible');
    },
    /**
     * things 模块运行时接入：以其动作为主，内置清单补齐缺失动作（避免企业自己的 org.manage 等动作消失）。
     * @returns {boolean} 是否接入成功
     */
    replaceWith(list, { mergeBuiltin = true, newSource = 'things' } = {}) {
      const normalized = normalizeActionList(list);
      if (!normalized.length) return false;
      const ids = new Set(normalized.map((a) => a.id));
      const extras = mergeBuiltin ? builtinCopy().filter((a) => !ids.has(a.id)) : [];
      actions = normalized.concat(extras).map((a, i) => ({ ...a, order: i }));
      source = newSource + (mergeBuiltin ? '+builtin' : '');
      error = '';
      reindex();
      return true;
    },
  };
}
