// Round4 设备槽位/重名单测：个人 3 台上限、第 4 台 409 + 最久未活跃 3 台建议、家庭 8 台、重名自动后缀。
// 运行：node --test server/lib/devices/__tests__/slots.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDevicesService } from '../index.js';

function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-slots-'));
  const now = Date.now();
  const nodes = {};
  const names = ['客厅电脑', '书房电脑', '卧室电脑', '备用电脑', '平板'];
  ['node-a', 'node-b', 'node-c', 'node-d', 'node-e'].forEach((id, i) => {
    nodes[id] = {
      id,
      name: names[i],
      kind: 'node',
      platform: 'win32',
      online: true,
      lastSeen: new Date(now - (i + 1) * 3600000).toISOString(),
      capabilities: [{ id: 'app.launch', name: '打开程序' }],
    };
  });
  return createDevicesService({ root: process.cwd(), dataDir: dir, state: { nodes, meta: {} }, ledger: null });
}

test('个人版上限 3：第 4 台被拦（409）并给出最久未活跃 3 台建议', () => {
  const svc = makeService();
  assert.equal(svc.bind('node-a').ok, true);
  assert.equal(svc.bind('node-b').ok, true);
  assert.equal(svc.bind('node-c').ok, true);
  const info = svc.settingsInfo();
  assert.equal(info.mode, 'personal');
  assert.equal(info.maxDevices, 3);
  assert.equal(info.used, 3);
  assert.equal(info.atLimit, true);
  let err = null;
  try { svc.bind('node-d'); } catch (e) { err = e; }
  assert.ok(err, '第 4 台应被拦截');
  assert.equal(err.statusCode, 409);
  assert.equal(err.code, 'DEVICE_SLOT_FULL');
  assert.ok(err.payload && Array.isArray(err.payload.suggestions));
  assert.equal(err.payload.suggestions.length, 3);
  const suggested = err.payload.suggestions.map((s) => s.id);
  assert.equal(suggested[0], 'node-c', '建议按最后活跃升序：最久未活跃的排第一');
  assert.equal(suggested.length, 3, '到上限时建议 = 最久未活跃的 3 台');
});

test('解绑后可继续绑定；家庭版上限 8', () => {
  const svc = makeService();
  svc.bind('node-a'); svc.bind('node-b'); svc.bind('node-c');
  svc.unbind('node-c');
  assert.equal(svc.bind('node-d').ok, true);
  assert.equal(svc.settingsInfo().used, 3);
  const updated = svc.updateSettings({ mode: 'family' });
  assert.equal(updated.settings.mode, 'family');
  assert.equal(updated.settings.maxDevices, 8);
  assert.equal(svc.bind('node-e').ok, true);
  assert.equal(svc.settingsInfo().used, 4);
  assert.equal(svc.settingsInfo().atLimit, false);
});

test('重名自动加后缀（2）（3）…', () => {
  const svc = makeService();
  svc.bind('node-a'); svc.bind('node-b'); svc.bind('node-c');
  const r1 = svc.rename('node-b', '客厅电脑');
  assert.equal(r1.to, '客厅电脑（2）');
  assert.equal(r1.suffixed, true);
  const r2 = svc.rename('node-c', '客厅电脑');
  assert.equal(r2.to, '客厅电脑（3）');
  const r3 = svc.rename('node-c', '阳台电脑');
  assert.equal(r3.to, '阳台电脑');
  assert.equal(r3.suffixed, false);
});

test('settings 校验：非法模式/上限 400，PATCH 持久化', () => {
  const svc = makeService();
  assert.throws(() => svc.updateSettings({ mode: 'team' }), /mode 只能是/);
  assert.throws(() => svc.updateSettings({ mode: 'personal', maxDevices: 0 }), /maxDevices/);
  const r = svc.updateSettings({ mode: 'personal', maxDevices: 5 });
  assert.equal(r.settings.maxDevices, 5);
  assert.equal(svc.settingsInfo().maxDevices, 5);
  assert.equal(svc.settingsInfo().limits.personal, 3);
  assert.equal(svc.settingsInfo().limits.family, 8);
});
