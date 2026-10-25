import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { AI, hashText } from '../../server/lib/ai.js';
import { cleanupTempDirs } from './helpers.mjs';

after(cleanupTempDirs);
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

const CAPS = [
  { id: 'image.crop', name: '裁方图', risk: 'reversible', manualOnly: false },
  { id: 'file.delete', name: '删除文件', risk: 'irreversible', manualOnly: false },
  { id: 'file.hash', name: '文件指纹', risk: 'reversible', manualOnly: false },
  { id: 'printer.mock', name: '模拟打印', risk: 'irreversible', manualOnly: false },
  { id: 'channel.notify', name: '回传通道', risk: 'irreversible', manualOnly: false },
  { id: 'llm.summarize', name: '中枢摘要', risk: 'reversible', manualOnly: false },
  { id: 'video.transcode', name: '视频转码', risk: 'reversible', manualOnly: true },
];
const DEVICES = [
  { id: 'hub', name: '本机中枢', capabilities: [{ id: 'channel.notify' }, { id: 'llm.summarize' }] },
  { id: 'node-local', name: '本机工作台', capabilities: [{ id: 'image.crop' }, { id: 'file.delete' }, { id: 'video.transcode' }] },
  { id: 'dev-printer', name: '打印服务器', capabilities: [{ id: 'printer.mock' }] },
];
const ruleAI = () => new AI({ apiKey: '' });
const draftOf = (ai, text) => ai.ruleDraft({ text, capabilities: CAPS, devices: DEVICES });

function stubFetch(content, ok = true) {
  globalThis.fetch = async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
    text: async () => content,
  });
}

test('AI 规则草案：裁图匹配 image.crop，参数默认 1024 与示例目录', () => {
  const d = draftOf(ruleAI(), '把昨天的样品图裁成方图');
  assert.equal(d.capabilities[0].id, 'image.crop');
  assert.equal(d.targetDevice.id, 'node-local');
  assert.equal(d.params.size, 1024);
  assert.equal(d.params.srcDir, '示例空间/样品图');
  assert.equal(d.params.outDir, '示例空间/输出/方图');
  assert.deepEqual(d.missing, []);
  assert.equal(d.risk.level, 'reversible');
});

test('AI 规则草案：裁图指定 800 像素时参数取 800', () => {
  const d = draftOf(ruleAI(), '把样品图裁成 800 像素的方图');
  assert.equal(d.capabilities[0].id, 'image.crop');
  assert.equal(d.params.size, 800);
});

test('AI 规则草案：裁图缺输出尺寸 → missing 含「输出尺寸」', () => {
  const d = draftOf(ruleAI(), '把样品图裁成方图');
  assert.ok(Array.isArray(d.missing));
  assert.equal(d.missing.length, 0, '含默认 1024 时不应缺尺寸');
  const d2 = ruleAI().ruleDraft({ text: '裁图', capabilities: CAPS, devices: DEVICES });
  assert.ok(d2.missing.some((m) => m.includes('输出尺寸')));
});

test('AI 规则草案：发送 → channel.notify，风险不可逆且给出理由', () => {
  const d = draftOf(ruleAI(), '把交付链接发到工作群');
  assert.equal(d.capabilities[0].id, 'channel.notify');
  assert.equal(d.risk.level, 'irreversible');
  assert.ok(d.risk.reasons.some((r) => r.includes('不可逆') || r.includes('发送')));
});

test('AI 规则草案：删除 → file.delete，默认目标为过期草稿', () => {
  const d = draftOf(ruleAI(), '删除示例空间里的临时文件');
  assert.equal(d.capabilities[0].id, 'file.delete');
  assert.equal(d.params.target, '示例空间/临时/过期草稿.png');
  assert.equal(d.risk.level, 'irreversible');
  assert.equal(d.risk.reasons.length, 2);
});

test('AI 规则草案：打印 → printer.mock，默认 3 份 + 样品01', () => {
  const d = draftOf(ruleAI(), '打印三份合同');
  assert.equal(d.capabilities[0].id, 'printer.mock');
  assert.equal(d.targetDevice.id, 'dev-printer');
  assert.equal(d.params.copies, 3);
  assert.equal(d.params.file, '示例空间/样品图/样品01.png');
});

test('AI 规则草案：转码 → video.transcode，草案标 manualOnly=true', () => {
  const d = draftOf(ruleAI(), '把演示视频转码成 1080p');
  assert.equal(d.capabilities[0].id, 'video.transcode');
  assert.equal(d.capabilities[0].manualOnly, true);
  assert.equal(d.risk.level, 'reversible');
});

test('AI 规则草案：总结 → llm.summarize，参数带原文', () => {
  const d = draftOf(ruleAI(), '总结本周周报');
  assert.equal(d.capabilities[0].id, 'llm.summarize');
  assert.ok(typeof d.params.text === 'string' && d.params.text.length > 0);
});

test('AI 规则草案：无法匹配 → 能力为空、目标为空、missing 说明缺什么', () => {
  const d = draftOf(ruleAI(), '帮我倒杯水');
  assert.deepEqual(d.capabilities, []);
  assert.equal(d.targetDevice, null);
  assert.ok(d.missing.some((m) => m.includes('能力未匹配')));
});

test('AI 规则草案：有能力但无设备 → missing 含目标设备', () => {
  const d = ruleAI().ruleDraft({ text: '把样品图裁成方图 1024', capabilities: CAPS, devices: [] });
  assert.ok(d.missing.some((m) => m.includes('目标设备')));
});

test('AI 规则草案：可逆能力 + 危险动词 → 风险升级为不可逆', () => {
  const d = draftOf(ruleAI(), '把样品图裁成方图后发送到群里');
  assert.equal(d.capabilities[0].id, 'image.crop');
  assert.equal(d.risk.level, 'irreversible');
});

test('AI 参数推导：mergeParams 补齐 image.crop 的默认源目录', () => {
  const ai = ruleAI();
  const draft = ai.mergeParams({ capabilities: [{ id: 'image.crop', name: '裁方图' }], params: {} });
  assert.equal(draft.params.srcDir, '示例空间/样品图');
  assert.equal(draft.params.size, 1024);
});

test('hashText：sha256 十六进制、确定且区分输入', () => {
  assert.match(hashText('abc'), /^[0-9a-f]{64}$/);
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
});

test('AI.draft：无 key → rule 降级，reason 说明未配置 API key', async () => {
  const r = await ruleAI().draft({ text: '把样品图裁成方图', capabilities: CAPS, devices: DEVICES });
  assert.equal(r.ai.provider, 'rule');
  assert.equal(r.ai.fallback, true);
  assert.match(r.ai.reason, /未配置 API key/);
  assert.equal(r.draft.capabilities[0].id, 'image.crop');
});

test('AI.draft：真实模型返回 JSON → provider=deepseek 并计入 tokens', async () => {
  const ai = new AI({ apiKey: 'test-key' });
  stubFetch('```json\n{"summary":"裁方图","capabilities":[{"id":"image.crop","name":"裁方图"}],"targetDevice":{"id":"node-local","name":"本机工作台"},"missing":[],"risk":{"level":"reversible","reasons":[]}}\n```');
  const r = await ai.draft({ text: '把样品图裁成方图 1024', capabilities: CAPS, devices: DEVICES });
  assert.equal(r.ai.provider, 'deepseek');
  assert.equal(r.ai.tokensIn, 11);
  assert.equal(r.ai.tokensOut, 7);
  assert.equal(r.draft.capabilities[0].id, 'image.crop');
  assert.equal(ai.usage.calls, 1);
});

test('AI.draft：相同输入第二次命中缓存（provider=cache, cached=true）', async () => {
  const ai = new AI({ apiKey: 'test-key' });
  stubFetch('{"summary":"裁方图","capabilities":[{"id":"image.crop","name":"裁方图"}],"targetDevice":null,"missing":[],"risk":{"level":"reversible","reasons":[]}}');
  const args = { text: '把样品图裁成方图 1024', capabilities: CAPS, devices: DEVICES };
  const first = await ai.draft(args);
  const second = await ai.draft(args);
  assert.equal(first.ai.provider, 'deepseek');
  assert.equal(second.ai.provider, 'cache');
  assert.equal(second.ai.cached, true);
});

test('AI.draft：模型返回非法 JSON → 降级为规则草案', async () => {
  const ai = new AI({ apiKey: 'test-key' });
  stubFetch('这不是 JSON');
  const r = await ai.draft({ text: '把样品图裁成方图 1024', capabilities: CAPS, devices: DEVICES });
  assert.equal(r.ai.provider, 'rule');
  assert.equal(r.ai.fallback, true);
  assert.ok(r.draft.capabilities.length >= 1);
});

test('AI.draft：HTTP 失败 → 降级为规则草案', async () => {
  const ai = new AI({ apiKey: 'test-key' });
  stubFetch('boom', false);
  const r = await ai.draft({ text: '打印三份合同', capabilities: CAPS, devices: DEVICES });
  assert.equal(r.ai.provider, 'rule');
  assert.equal(r.ai.fallback, true);
  assert.equal(r.draft.capabilities[0].id, 'printer.mock');
});

test('AI.draft：token 预算用尽 → 降级并说明原因', async () => {
  const ai = new AI({ apiKey: 'test-key' });
  ai.limits.maxCalls = 0;
  const r = await ai.draft({ text: '把样品图裁成方图 1024', capabilities: CAPS, devices: DEVICES });
  assert.equal(r.ai.provider, 'rule');
  assert.match(r.ai.reason, /token 预算已用尽/);
});

test('AI.explain：离线返回规则解释文案', async () => {
  const r = await ruleAI().explain({ text: '把样品图裁成方图' });
  assert.equal(r.ai.provider, 'rule');
  assert.match(r.text, /离线解释|账本/);
});

test('AI.summarize：离线摘要截断并标注', async () => {
  const ai = ruleAI();
  const raw = '这是一段很长的正文'.repeat(30);
  const r = await ai.summarize({ text: raw });
  assert.match(r.text, /（离线摘要）$/);
  assert.ok(r.text.length < raw.length + 20);
});