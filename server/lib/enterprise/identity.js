// 企业控制面 · 身份适配器接口 + mock
// 支持类型：mock（本地联调，完整可用）/ sso-OIDC / 企业微信 / 钉钉（接口就绪，等企业凭据）/ LDAP（预留）。
// 未配置真实凭据时统一抛 IdentityNotConfiguredError（路由转 409），绝不伪造登录成功。
import crypto from 'node:crypto';

export class IdentityNotConfiguredError extends Error {
  constructor(type, detail = '') {
    super(`身份提供方「${type}」未配置真实凭据${detail ? '：' + detail : ''}。真实凭据由企业提供；本地联调请用 type="mock"。`);
    this.name = 'IdentityNotConfiguredError';
    this.code = 'identity_not_configured';
    this.type = type;
  }
}

export const IDENTITY_TYPES = Object.freeze([
  { type: 'mock', label: 'Mock 身份（本地联调）', status: 'available', requiredFields: [], note: '内置 mock：loginUrl / handleCallback / sendMessage 全链路可验证；生产由真实 SSO 替换。' },
  { type: 'sso', label: 'SSO / OIDC', status: 'needs_credentials', requiredFields: ['issuer', 'clientId', 'clientSecret', 'redirectUri'], note: '通用 OIDC 预留：企业提供 issuer/clientId/secret 后启用；P0 不实现 token 交换。' },
  { type: 'wecom', label: '企业微信', status: 'needs_credentials', requiredFields: ['corpId', 'agentId', 'secret'], note: '企业提供 corpId/agentId/secret 后启用；P0 只保留接口。' },
  { type: 'dingtalk', label: '钉钉', status: 'needs_credentials', requiredFields: ['appKey', 'appSecret', 'agentId'], note: '企业提供 appKey/appSecret 后启用；P0 只保留接口。' },
  { type: 'ldap', label: 'LDAP / AD', status: 'reserved', requiredFields: ['url', 'baseDn'], note: '预留：目录同步形态，无 Web 回调；P1 实现。' },
]);

export function listIdentityTypes() {
  return IDENTITY_TYPES.map((x) => ({ ...x, requiredFields: x.requiredFields.slice() }));
}

export function identityTypeMeta(type) {
  return IDENTITY_TYPES.find((x) => x.type === type) || null;
}

function missingFields(type, config = {}) {
  const meta = identityTypeMeta(type);
  if (!meta) return [];
  return meta.requiredFields.filter((k) => {
    const v = config[k];
    return v === undefined || v === null || String(v).trim() === '';
  });
}

function makeMessageId() {
  return 'idm_' + crypto.randomBytes(6).toString('hex');
}

function sanitizeUser(raw = {}) {
  return {
    providerId: String(raw.providerId || raw.userId || raw.id || 'mock-user-1'),
    name: String(raw.name || raw.nickname || 'Mock 用户'),
    email: String(raw.email || ''),
    role: ['admin', 'member', 'guest'].includes(raw.role) ? raw.role : 'member',
  };
}

class MockIdentityProvider {
  constructor(config = {}) {
    this.type = 'mock';
    this.label = 'Mock 身份（本地联调）';
    this.config = config;
    this.messages = [];
  }

  isConfigured() {
    return true;
  }

  describe() {
    return {
      type: this.type,
      label: this.label,
      status: 'configured',
      configured: true,
      mode: 'mock',
      requiredFields: [],
      missingFields: [],
      note: '本地联调 mock：回调校验 code 后返回固定测试用户；sendMessage 只写内存 outbox。',
    };
  }

  loginUrl(state = '') {
    const base = this.config.loginPath || '/api/v2/org/identity/mock/login';
    return `${base}?state=${encodeURIComponent(String(state || ''))}`;
  }

  handleCallback(params = {}) {
    const code = String(params.code || params.authCode || '').trim();
    if (!code) return { ok: false, code: 'missing_code', reason: '缺少 code' };
    if (this.config.expectedCode && code !== String(this.config.expectedCode)) {
      return { ok: false, code: 'invalid_code', reason: 'code 不匹配（mock 期望 expectedCode）' };
    }
    return {
      ok: true,
      provider: 'mock',
      state: String(params.state || ''),
      user: sanitizeUser(this.config.user || {}),
    };
  }

  sendMessage(to, text) {
    const message = { messageId: makeMessageId(), to: String(to || ''), text: String(text == null ? '' : text), at: new Date().toISOString() };
    this.messages.push(message);
    return { ok: true, provider: 'mock', messageId: message.messageId, to: message.to, preview: message.text.slice(0, 80) };
  }
}

class AdapterIdentityProvider {
  constructor({ type, label, config = {}, requiredFields = [] }) {
    this.type = type;
    this.label = label;
    this.config = config || {};
    this.requiredFields = requiredFields.slice();
    this.mockBridge = new MockIdentityProvider({ ...this.config, user: this.config.user });
  }

  isConfigured() {
    return missingFields(this.type, this.config).length === 0;
  }

  describe() {
    const missing = missingFields(this.type, this.config);
    const meta = identityTypeMeta(this.type);
    return {
      type: this.type,
      label: this.label,
      status: missing.length === 0 ? 'configured' : ((meta && meta.status) || 'needs_credentials'),
      configured: missing.length === 0,
      mode: this.config.mock ? 'mock-bridge' : (missing.length === 0 ? 'live' : 'needs_credentials'),
      requiredFields: this.requiredFields.slice(),
      missingFields: missing,
      note: (meta && meta.note) || '',
    };
  }

  loginUrl(state = '') {
    if (this.type === 'ldap') throw new IdentityNotConfiguredError('ldap', 'LDAP 为目录同步形态，无 Web 登录回调');
    if (!this.isConfigured()) {
      if (this.config.mock) return this.mockBridge.loginUrl(state);
      throw new IdentityNotConfiguredError(this.type, `缺少字段 ${missingFields(this.type, this.config).join(', ')}`);
    }
    const redirectUri = encodeURIComponent(String(this.config.redirectUri || '/api/v2/org/identity/' + this.type + '/callback'));
    const stateStr = encodeURIComponent(String(state || ''));
    if (this.type === 'sso') {
      const issuer = String(this.config.issuer).replace(/\/+$/, '');
      const authorizeUrl = this.config.authorizeUrl || issuer + '/authorize';
      const q = [`response_type=code`, `client_id=${encodeURIComponent(this.config.clientId)}`, `redirect_uri=${redirectUri}`, `scope=openid`, `state=${stateStr}`];
      return `${authorizeUrl}?${q.join('&')}`;
    }
    if (this.type === 'wecom') {
      return `https://open.weixin.qq.com/connect/oauth2/authorize?appid=${encodeURIComponent(this.config.corpId)}&redirect_uri=${redirectUri}&response_type=code&scope=snsapi_base&state=${stateStr}#wechat_redirect`;
    }
    if (this.type === 'dingtalk') {
      return `https://login.dingtalk.com/oauth2/auth?redirect_uri=${redirectUri}&response_type=code&client_id=${encodeURIComponent(this.config.appKey)}&scope=openid&state=${stateStr}`;
    }
    throw new IdentityNotConfiguredError(this.type, '未知协议');
  }

  handleCallback(params = {}) {
    if (this.config.mock) return this.mockBridge.handleCallback(params);
    if (!this.isConfigured()) throw new IdentityNotConfiguredError(this.type, `缺少字段 ${missingFields(this.type, this.config).join(', ')}`);
    throw new IdentityNotConfiguredError(this.type, 'P0 未实现真实 token 交换与用户同步，等企业凭据与联调环境');
  }

  sendMessage(to, text) {
    if (this.config.mock) return this.mockBridge.sendMessage(to, text);
    if (!this.isConfigured()) throw new IdentityNotConfiguredError(this.type, `缺少字段 ${missingFields(this.type, this.config).join(', ')}`);
    throw new IdentityNotConfiguredError(this.type, 'P0 未实现真实消息发送（需企业凭据/SDK）');
  }
}

export function createIdentityProvider({ type = 'mock', config = {} } = {}) {
  const meta = identityTypeMeta(type);
  if (!meta) {
    const err = new Error(`未知身份提供方类型：${type}`);
    err.code = 'unknown_identity_type';
    throw err;
  }
  if (type === 'mock') return new MockIdentityProvider(config);
  return new AdapterIdentityProvider({ type, label: meta.label, config, requiredFields: meta.requiredFields });
}

export class IdentityRegistry {
  constructor(configs = {}) {
    this.configs = configs || {};
    this.providers = new Map();
    this.ensure('mock');
    for (const type of Object.keys(this.configs)) {
      try {
        this.ensure(type);
      } catch {
        /* 未知类型配置忽略，describe 里仍会列出 */
      }
    }
  }

  ensure(type) {
    if (this.providers.has(type)) return this.providers.get(type);
    const config = (this.configs && this.configs[type]) || {};
    const provider = createIdentityProvider({ type, config });
    this.providers.set(type, provider);
    return provider;
  }

  get(type) {
    return this.ensure(type);
  }

  describe() {
    const list = listIdentityTypes();
    return list.map((meta) => {
      const provider = this.providers.get(meta.type);
      if (provider) return provider.describe();
      return {
        type: meta.type,
        label: meta.label,
        status: meta.status,
        configured: false,
        mode: 'needs_credentials',
        requiredFields: meta.requiredFields.slice(),
        missingFields: meta.requiredFields.slice(),
        note: meta.note,
      };
    });
  }

  sendMessage(type, to, text) {
    return this.get(type).sendMessage(to, text);
  }
}
