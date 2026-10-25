import crypto from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hashText(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

const IRREVERSIBLE_CAPS = new Set(['file.delete', 'printer.mock', 'channel.notify']);
const IRREVERSIBLE_WORDS = /发送|发到|发群|删除|付款|打印|发布|归档后删|转账/;

export class AI {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || process.env.DEEPSEEK_API_KEY || '';
    this.baseUrl = opts.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
    this.model = opts.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
    this.cache = new Map();
    this.cacheMax = 64;
    this.limits = { maxCalls: 20, maxTokens: 40000 };
    this.usage = { calls: 0, tokensIn: 0, tokensOut: 0, cached: 0, fallback: 0 };
    this.available = !!this.apiKey;
  }

  budgetLeft() {
    return this.usage.calls < this.limits.maxCalls && (this.usage.tokensIn + this.usage.tokensOut) < this.limits.maxTokens;
  }

  async chat(messages, { maxTokens = 500, temperature = 0.5, place = 'draft' } = {}) {
    const body = JSON.stringify({ model: this.model, messages, max_tokens: maxTokens, temperature, stream: false });
    const res = await fetch(this.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.apiKey },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const out = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    const u = data.usage || {};
    this.usage.calls += 1;
    this.usage.tokensIn += u.prompt_tokens || 0;
    this.usage.tokensOut += u.completion_tokens || 0;
    return { text: out, tokensIn: u.prompt_tokens || 0, tokensOut: u.completion_tokens || 0, place };
  }

  ruleDraft({ text, capabilities, devices }) {
    const t = String(text || '');
    const pick = (id) => capabilities.find((c) => c.id === id) || null;
    const deviceOf = (capId) => devices.find((d) => (d.capabilities || []).some((c) => c.id === capId)) || null;
    let cap = null;
    if (/裁|方图|crop|抠图/.test(t)) cap = pick('image.crop');
    else if (/总结|摘要|周报|summar|提炼/.test(t)) cap = pick('llm.summarize');
    else if (/打印|印一份|打印三份/.test(t)) cap = pick('printer.mock');
    else if (/发送|发到|发群|通知|微信|邮件/.test(t)) cap = pick('channel.notify');
    else if (/删除|清理|删掉/.test(t)) cap = pick('file.delete');
    else if (/转码|视频|压缩视频/.test(t)) cap = pick('video.transcode');
    const missing = [];
    if (!cap) missing.push('能力未匹配：请补充要操作的软件或能力名称');
    const dev = cap ? deviceOf(cap.id) : null;
    if (cap && !dev) missing.push('目标设备未注册或不在线');
    if (cap && cap.id === 'image.crop' && !/方图|尺寸|像素|1024|800/.test(t)) missing.push('输出尺寸');
    if (cap && cap.id === 'file.delete' && !/样品|临时|文件|\.png|\.jpg/.test(t)) missing.push('目标文件');
    const irreversible = cap ? IRREVERSIBLE_CAPS.has(cap.id) || IRREVERSIBLE_WORDS.test(t) : false;
    const reasons = [];
    if (cap && IRREVERSIBLE_CAPS.has(cap.id)) reasons.push('该能力会向外部发送或删除数据');
    if (IRREVERSIBLE_WORDS.test(t)) reasons.push('文本包含发送/删除/付款/打印等不可逆动作');
    return {
      summary: cap ? `把「${t}」交给 ${dev ? dev.name : '合适设备'} 的「${cap.name}」` : `理解「${t}」`,
      capabilities: cap ? [{ id: cap.id, name: cap.name, manualOnly: !!cap.manualOnly }] : [],
      targetDevice: dev ? { id: dev.id, name: dev.name } : null,
      missing,
      risk: { level: irreversible ? 'irreversible' : 'reversible', reasons },
      params: this.deriveParams(cap ? cap.id : null, t),
    };
  }

  deriveParams(capId, text) {
    if (capId === 'image.crop') {
      const m = String(text).match(/(\d{2,4})\s*(px|像素)?/);
      return { size: m ? Number(m[1]) : 1024, srcDir: '示例空间/样品图', outDir: '示例空间/输出/方图' };
    }
    if (capId === 'file.delete') return { target: '示例空间/临时/过期草稿.png' };
    if (capId === 'channel.notify') return { channel: 'wechat-mock', group: '工作群' };
    if (capId === 'printer.mock') return { file: '示例空间/样品图/样品01.png', copies: 3 };
    if (capId === 'llm.summarize') return { text: String(text).slice(0, 200) };
    return {};
  }

  mergeParams(draft) {
    const capId = draft.capabilities && draft.capabilities[0] ? draft.capabilities[0].id : null;
    draft.params = { ...(draft.params || {}), ...this.deriveParams(capId, draft.summary || '') };
    if (!draft.params.srcDir && capId === 'image.crop') draft.params.srcDir = '示例空间/样品图';
    return draft;
  }

  async draft({ text, capabilities, devices, context }) {
    const rule = this.ruleDraft({ text, capabilities, devices });
    const key = hashText(JSON.stringify([text, capabilities.map((c) => c.id).sort(), devices.map((d) => d.id).sort()]));
    if (this.cache.has(key)) {
      this.usage.cached += 1;
      this.usage.calls += 1 > 0 ? 0 : 1;
      return { draft: this.mergeParams(JSON.parse(JSON.stringify(this.cache.get(key)))), ai: { provider: 'cache', tokensIn: 0, tokensOut: 0, cached: true } };
    }
    if (!this.available || !this.budgetLeft()) {
      this.usage.fallback += 1;
      return { draft: this.mergeParams(rule), ai: { provider: 'rule', fallback: true, reason: this.available ? 'token 预算已用尽' : '未配置 API key' } };
    }
    const sys = '你是任务规划器。只输出 JSON，不要输出解释、不要用 Markdown 代码块。';
    const user = [
      '把用户的一句话转成任务草案。可用能力：',
      capabilities.map((c) => `- ${c.id}（${c.name}）风险:${c.risk}`).join('\n'),
      '可用设备：',
      devices.map((d) => `- ${d.id}（${d.name}）能力:${(d.capabilities || []).map((c) => c.id).join(',')}`).join('\n'),
      `用户说：${text}`,
      '只输出如下 JSON：{"summary":"一句话","capabilities":[{"id":"能力id","name":"名称"}],"targetDevice":{"id":"设备id","name":"名称"},"missing":[],"risk":{"level":"reversible|irreversible","reasons":[]}}',
      '不确定的字段写 null 或 "未知"，并把缺什么写进 missing。不要编造能力 id。',
    ].join('\n');
    try {
      const r = await this.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: 500, place: 'draft' });
      const cleaned = r.text.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const ids = new Set(capabilities.map((c) => c.id));
      const caps = (parsed.capabilities || []).filter((c) => c && ids.has(c.id));
      const merged = {
        summary: String(parsed.summary || rule.summary).slice(0, 200),
        capabilities: caps.length ? caps : rule.capabilities,
        targetDevice: parsed.targetDevice && parsed.targetDevice.id ? parsed.targetDevice : rule.targetDevice,
        missing: Array.isArray(parsed.missing) ? parsed.missing : [],
        risk: parsed.risk && parsed.risk.level ? { level: parsed.risk.level === 'irreversible' ? 'irreversible' : 'reversible', reasons: parsed.risk.reasons || [] } : rule.risk,
        params: {},
      };
      merged.params = this.deriveParams(merged.capabilities[0] ? merged.capabilities[0].id : null, text);
      if (this.cache.size >= this.cacheMax) this.cache.clear();
      this.cache.set(key, JSON.parse(JSON.stringify(merged)));
      return { draft: merged, ai: { provider: 'deepseek', model: this.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, cached: false } };
    } catch (err) {
      this.usage.fallback += 1;
      return { draft: this.mergeParams(rule), ai: { provider: 'rule', fallback: true, reason: String(err.message || err).slice(0, 120) } };
    }
  }

  async explain({ text }) {
    if (!this.available || !this.budgetLeft()) {
      return { text: '离线解释：这条任务由草案、确认、排队、执行、回传五段组成；每一步都能在账本里找到证据。', ai: { provider: 'rule' } };
    }
    try {
      const r = await this.chat([
        { role: 'system', content: '你是解释器。用 60 字以内中文解释这条任务链路，不编造事实。' },
        { role: 'user', content: text.slice(0, 400) },
      ], { maxTokens: 160, place: 'explain' });
      return { text: r.text.trim().slice(0, 200), ai: { provider: 'deepseek', tokensIn: r.tokensIn, tokensOut: r.tokensOut } };
    } catch {
      return { text: '解释服务不可用，已降级为规则解释。', ai: { provider: 'rule', fallback: true } };
    }
  }

  async summarize({ text }) {
    const src = String(text || '');
    if (!this.available || !this.budgetLeft()) {
      return { text: src.slice(0, 120) + (src.length > 120 ? '…' : '') + '（离线摘要）', ai: { provider: 'rule' } };
    }
    try {
      const r = await this.chat([
        { role: 'system', content: '你是摘要器。用不超过 80 字中文概括，只输出摘要本身。' },
        { role: 'user', content: src.slice(0, 800) },
      ], { maxTokens: 200, place: 'summarize' });
      return { text: r.text.trim().slice(0, 200), ai: { provider: 'deepseek', tokensIn: r.tokensIn, tokensOut: r.tokensOut } };
    } catch {
      return { text: src.slice(0, 100) + '（降级摘要）', ai: { provider: 'rule', fallback: true } };
    }
  }
}

export { sleep };