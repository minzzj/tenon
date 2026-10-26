// Round4 剪贴板隐私单测：敏感 5 类 + 普通放行 + 不落盘/事件 redacted + 删除/清空/开关。
// 运行：node --test server/lib/link/__tests__/privacy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSensitive, sanitizeForSync } from '../privacy.js';
import { createClipboardStore } from '../clipboard.js';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-privacy-'));
  const events = [];
  const store = createClipboardStore({ dataDir: dir, appendEvent: (type, data) => events.push({ type, data }) });
  return { dir, events, store };
}

test('敏感类型 1：密码/口令', () => {
  for (const text of ['密码：Abc12345', 'password: S3cret!', 'wifi 口令是 hello123']) {
    const hit = detectSensitive(text);
    assert.equal(hit.sensitive, true, text);
    assert.equal(hit.type, 'password');
  }
});

test('敏感类型 2：验证码/动态码', () => {
  for (const text of ['验证码：123456', '您的动态码 654321，5 分钟内有效', 'OTP code 8848']) {
    const hit = detectSensitive(text);
    assert.equal(hit.sensitive, true, text);
    assert.equal(hit.type, 'otp');
  }
});

test('敏感类型 3：银行卡号（分组/Luhn/上下文）', () => {
  for (const text of ['6222 0212 3456 7890', '4111111111111111', '银行卡 6222021234567890123']) {
    const hit = detectSensitive(text);
    assert.equal(hit.sensitive, true, text);
    assert.equal(hit.type, 'bankcard');
  }
});

test('敏感类型 4：身份证号（真/假证号都保护）', () => {
  for (const text of ['110101199003071234', '身份证 11010519491231002X']) {
    const hit = detectSensitive(text);
    assert.equal(hit.sensitive, true, text);
    assert.equal(hit.type, 'idcard');
  }
});

test('敏感类型 5：长数字串（长度阈值 ≥12）', () => {
  for (const text of ['123456789012', '订单号 2024102612345678', '1 23456789012345']) {
    const hit = detectSensitive(text);
    assert.equal(hit.sensitive, true, text);
  }
  assert.equal(detectSensitive('电话 13800138000').sensitive, false); // 11 位手机号低于阈值放行
  assert.equal(detectSensitive('金额 12345678901').sensitive, false); // 11 位放行
});

test('普通文本放行（不误杀）', () => {
  for (const text of ['你好，这是一段普通文本', 'https://example.com/a?b=1', '订单 2024-10-26 已发货']) {
    const hit = detectSensitive(text);
    assert.equal(hit.sensitive, false, text);
    assert.equal(sanitizeForSync(text).ok, true);
  }
});

test('长文本超过阈值 → too-long 过滤', () => {
  const hit = detectSensitive('a'.repeat(9000));
  assert.equal(hit.sensitive, true);
  assert.equal(hit.type, 'too-long');
});

test('剪贴板 store：敏感内容不落盘，事件只记 redacted+类型', () => {
  const { store, events } = makeStore();
  const result = store.share({ from: 'phone', kind: 'text', text: '密码：SuperSecret123' });
  assert.equal(result.redacted, true);
  assert.equal(result.item, null);
  assert.equal(store.stats().items, 0);
  assert.equal(store.history().length, 0);
  const ev = events.find((e) => e.type === 'clipboard.shared');
  assert.ok(ev);
  assert.equal(ev.data.redacted, true);
  assert.equal(ev.data.sensitiveType, 'password');
  assert.ok(!JSON.stringify(ev.data).includes('SuperSecret123'), '事件里不能出现原文');
  assert.ok(!JSON.stringify(store.stats()).includes('SuperSecret'), '状态里不能出现原文');
  // 落盘文件里也不能出现原文
  const rawFiles = fs.readdirSync(path.join(store.file.replace(/clipboard\.json$/, '')), { withFileTypes: true });
  assert.ok(rawFiles.length >= 0);
  assert.ok(!fs.existsSync(store.file) || !fs.readFileSync(store.file, 'utf8').includes('SuperSecret123'));
});

test('剪贴板 store：普通内容入库、history 只回 preview、删除/清空写账本', () => {
  const { store, events } = makeStore();
  const item = store.share({ from: 'phone', kind: 'text', text: '这是一段普通文本' });
  assert.ok(item && item.id);
  assert.equal(store.latest().text, '这是一段普通文本');
  const hist = store.history();
  assert.equal(hist.length, 1);
  assert.equal(hist[0].id, item.id);
  assert.ok(!('text' in hist[0]));
  const del = store.deleteItem(item.id, 'tester');
  assert.equal(del.remaining, 0);
  const delEv = events.find((e) => e.type === 'clipboard.deleted');
  assert.ok(delEv && delEv.data.count === 1);
  store.share({ from: 'phone', kind: 'text', text: '再来一条' });
  const cleared = store.clear('tester');
  assert.equal(cleared.cleared, 1);
  assert.equal(store.history().length, 0);
});

test('开关关闭后 share 拒绝（node-agent 10s 内停采由 settings 轮询保证）', () => {
  const { store, events } = makeStore();
  store.setEnabled(false, 'tester');
  assert.equal(store.settings().enabled, false);
  assert.throws(() => store.share({ from: 'phone', kind: 'text', text: '普通文本' }), /剪贴板同步已关闭/);
  const ev = events.find((e) => e.type === 'clipboard.privacy.changed');
  assert.ok(ev && ev.data.enabled === false);
  store.setEnabled(true, 'tester');
  const item = store.share({ from: 'phone', kind: 'text', text: '重新开启后的文本' });
  assert.ok(item && item.id);
});