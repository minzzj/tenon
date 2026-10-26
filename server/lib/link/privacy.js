// 榫卯 Tenon v2 · 剪贴板隐私过滤（Round4）
// 目标：密码/验证码/银行卡号/身份证/长数字串/token/超长文本 → 不落盘、不同步、不进账本原文。
// 契约：detectSensitive(text) 返回 { sensitive, type, label, length, matchLength }（绝不在事件/账本里记原文）。
export const PRIVACY_VERSION = '1.0.0';

export const SENSITIVE_LABELS = {
  password: '密码/口令',
  otp: '验证码/动态码',
  idcard: '身份证号',
  bankcard: '银行卡号',
  token: '密钥/令牌',
  'long-digits': '超长数字串',
  'too-long': '超长文本',
};

export const DEFAULT_PRIVACY = {
  enabled: true,
  longDigitsThreshold: 12, // 连续数字 ≥12 位视为敏感（银行卡/身份证之外的订单号等也保护）
  maxSyncChars: 8000, // 超过此长度不落盘/不同步（防刷爆账本 + 隐私）
};

function stripSpaces(value) {
  return String(value || '').replace(/[\s-]/g, '');
}

/** 银行卡 Luhn 校验（避免把普通长数字误判为卡号） */
export function luhnValid(digits) {
  const s = String(digits || '').replace(/\D/g, '');
  if (s.length < 12 || s.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = s.length - 1; i >= 0; i -= 1) {
    let n = Number(s[i]);
    if (Number.isNaN(n)) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** 中国身份证校验（18 位，含校验位；15 位老身份证也覆盖） */
export function idCardValid(value) {
  const v = String(value || '').trim();
  if (/^\d{15}$/.test(v)) return true;
  if (!/^\d{17}[\dXx]$/.test(v)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const check = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(v[i]) * weights[i];
  return check[sum % 11] === v[17].toUpperCase();
}

const PATTERNS = [
  {
    type: 'password',
    label: SENSITIVE_LABELS.password,
    test: (text) => /(?:密码|口令|password|passwd|pwd)\s*(?:是|为|[:：=])\s*\S{3,}/i.test(text),
  },
  {
    type: 'otp',
    label: SENSITIVE_LABELS.otp,
    test: (text) => /(?:验证码|校验码|动态码|verification\s*code|one[- ]?time\s*code|\botp\b)[^0-9]{0,12}\d{4,8}/i.test(text),
  },
  {
    type: 'idcard',
    label: SENSITIVE_LABELS.idcard,
    test: (text) => {
      const m = String(text).match(/(?:^|[^\d])(\d{17}[\dXx]|\d{15})(?![\d])/);
      if (!m) return false;
      if (idCardValid(m[1])) return true;
      // 假证号/测试号：18 位且含合法出生日期段（19xx/20xx + 月日）也按身份证保护
      return /^\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(m[1]);
    },
  },
  {
    type: 'bankcard',
    label: SENSITIVE_LABELS.bankcard,
    test: (text) => {
      const matches = String(text).match(/(?:^|[^\d])((?:\d[ -]?){15,19})(?![\d])/g) || [];
      const context = /(?:银行卡|卡号|bank\s*card|card\s*number)/i.test(text);
      return matches.some((raw) => {
        const digits = stripSpaces(raw);
        if (digits.length < 15 || digits.length > 19) return false;
        const grouped = /(?:\d{4}[ -]){3}\d{4}/.test(String(raw).trim());
        return context || grouped || luhnValid(digits);
      });
    },
  },
  {
    type: 'token',
    label: SENSITIVE_LABELS.token,
    test: (text) => /(?:sk-[A-Za-z0-9_-]{16,}|tok_[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{20,}|api[_-]?key\s*[:=]\s*[A-Za-z0-9]{16,})/i.test(text),
  },
];

/**
 * 检测敏感文本。
 * @returns {{sensitive:boolean,type:string|null,label:string|null,length:number,redactedPreview:string}}
 */
export function detectSensitive(text, options = {}) {
  const opts = { ...DEFAULT_PRIVACY, ...(options || {}) };
  const value = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text);
  const base = { sensitive: false, type: null, label: null, length: value.length, redactedPreview: '' };
  if (!value) return base;
  if (value.length > opts.maxSyncChars) {
    return { ...base, sensitive: true, type: 'too-long', label: SENSITIVE_LABELS['too-long'], redactedPreview: `[已过滤：超长文本 · ${value.length} 字]` };
  }
  for (const pattern of PATTERNS) {
    if (pattern.test(value)) {
      return { ...base, sensitive: true, type: pattern.type, label: pattern.label, redactedPreview: `[已过滤：${pattern.label}]` };
    }
  }
  const longDigits = value.match(/(?:^|[^\d])(\d{12,})(?![\d])/);
  if (longDigits && longDigits[1].length >= opts.longDigitsThreshold) {
    return { ...base, sensitive: true, type: 'long-digits', label: SENSITIVE_LABELS['long-digits'], redactedPreview: `[已过滤：超长数字串]` };
  }
  return base;
}

/** 发送/写入前的净化：敏感则返回 {ok:false,...}，调用方禁止落盘/同步。 */
export function sanitizeForSync(text, options = {}) {
  const hit = detectSensitive(text, options);
  if (hit.sensitive) return { ok: false, redacted: true, type: hit.type, label: hit.label, length: hit.length, preview: hit.redactedPreview };
  return { ok: true, redacted: false, text: typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text), length: hit.length };
}

export default { PRIVACY_VERSION, SENSITIVE_LABELS, DEFAULT_PRIVACY, luhnValid, idCardValid, detectSensitive, sanitizeForSync };