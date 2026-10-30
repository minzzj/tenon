// 榫卯 V5 · node-agent system.notify 能力单测（真实弹一次 Windows 通知）
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyCapabilities, notifyManifest, findNotifyCapability, NOTIFY_VERSION, sendWindowsNotification } from '../notifier.js';

const WIN = process.platform === 'win32';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-notify-test-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
const ctx = { repoRoot: path.resolve(import.meta.dirname, '..'), dataDir: DATA, nodeId: 'node-local', taskId: 'task_notify_test' };
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('system.notify：manifest 字段齐全（risk=reversible、manualOnly=false）', () => {
  assert.equal(NOTIFY_VERSION, '5.0.0');
  assert.equal(notifyCapabilities.length, 1);
  assert.equal(notifyManifest.length, 1);
  const manifest = notifyManifest[0];
  assert.equal(manifest.id, 'system.notify');
  for (const key of ['id', 'name', 'risk', 'manualOnly', 'version', 'evidence', 'inputs', 'outputs']) {
    assert.ok(key in manifest, `缺字段 ${key}`);
  }
  assert.equal(manifest.risk, 'reversible');
  assert.equal(manifest.manualOnly, false);
  assert.equal(JSON.stringify(notifyManifest).includes('run'), false);
  assert.ok(findNotifyCapability('system.notify'));
});

test('system.notify：缺参时用默认标题/正文也能发（真实通知）', { skip: !WIN }, async () => {
  const cap = findNotifyCapability('system.notify');
  const result = await cap.run({ params: {} }, ctx);
  assert.equal(typeof result.summary, 'string');
  assert.ok(result.summary.includes('系统通知'));
  assert.ok(result.data && typeof result.data.method === 'string');
  assert.ok(['winrt', 'burnttoast', 'notifyicon', 'msg', 'log'].includes(result.data.method));
});

test('system.notify：真实弹一次通知并写审计（data/exec-audit.log）', { skip: !WIN }, async () => {
  const cap = findNotifyCapability('system.notify');
  const title = `榫卯 V5 通知测试-${Date.now().toString(36)}`;
  const body = '这是一条真实 Windows 系统通知（node-agent system.notify 能力自测）';
  const result = await cap.run({ params: { title, body } }, ctx);
  assert.equal(result.partial, false);
  assert.ok(result.summary.includes(title));
  assert.equal(typeof result.method, 'string');
  const auditFile = path.join(DATA, 'exec-audit.log');
  assert.ok(fs.existsSync(auditFile), '审计文件应存在');
  const lines = fs.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const hit = lines.find((line) => line.action === 'system.notify' && String(line.title).includes('通知测试'));
  assert.ok(hit, '审计中应有 system.notify 记录');
  assert.equal(hit.ok, true);
  // 直接调用一次 sendWindowsNotification 也应有结果（方法可读）
  const direct = await sendWindowsNotification({ title: '榫卯 V5 直接通知', body: 'sendWindowsNotification 直调' });
  assert.equal(typeof direct.method, 'string');
});