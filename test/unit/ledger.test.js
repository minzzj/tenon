import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Ledger, newId, stable, hashOf } from '../../server/lib/ledger.js';
import { newLedger, tempDir, cleanupTempDirs, readLines } from './helpers.mjs';

after(cleanupTempDirs);

const GENESIS = '0'.repeat(64);

function makeLedger(n = 3) {
  const ledger = newLedger();
  for (let i = 1; i <= n; i += 1) ledger.append('test.event', { i }, 'tester');
  return ledger;
}

test('append：序号从 1 连续递增且事件落盘', () => {
  const ledger = makeLedger(3);
  assert.equal(ledger.events.length, 3);
  assert.deepEqual(ledger.events.map((e) => e.seq), [1, 2, 3]);
  assert.equal(ledger.lastSeq, 3);
  assert.equal(readLines(ledger.file).length, 3);
});

test('append：首条 prev 为 64 个 0，hash = hashOf(事件)', () => {
  const ledger = makeLedger(2);
  assert.equal(ledger.events[0].prev, GENESIS);
  for (const ev of ledger.events) assert.equal(ev.hash, hashOf(ev));
});

test('append：哈希链 prev 指向上一条 hash', () => {
  const ledger = makeLedger(5);
  for (let i = 1; i < ledger.events.length; i += 1) {
    assert.equal(ledger.events[i].prev, ledger.events[i - 1].hash);
  }
  assert.equal(ledger.integrity().lastHash, ledger.events[4].hash);
});

test('append：actor 默认 hub，可覆盖且必填字段齐全', () => {
  const ledger = newLedger();
  const ev1 = ledger.append('a.b', { x: 1 });
  const ev2 = ledger.append('a.b', { x: 2 }, 'phone');
  assert.equal(ev1.actor, 'hub');
  assert.equal(ev2.actor, 'phone');
  for (const ev of [ev1, ev2]) {
    assert.ok(typeof ev.seq === 'number');
    assert.ok(typeof ev.at === 'string' && !Number.isNaN(Date.parse(ev.at)));
    assert.ok(typeof ev.hash === 'string' && ev.hash.length === 64);
  }
});

test('load：重新从磁盘加载得到相同事件与完整哈希链', () => {
  const ledger = makeLedger(4);
  const reloaded = new Ledger(ledger.dir);
  assert.deepEqual(reloaded.events, ledger.events);
  assert.equal(reloaded.lastSeq, ledger.lastSeq);
  assert.equal(reloaded.lastHash, ledger.lastHash);
  assert.deepEqual(reloaded.integrity().gaps, []);
  assert.equal(reloaded.integrity().ok, true);
});

test('load 后可继续 append，序号与哈希链延续', () => {
  const ledger = makeLedger(2);
  const reloaded = new Ledger(ledger.dir);
  const ev3 = reloaded.append('test.event', { i: 3 });
  assert.equal(ev3.seq, 3);
  assert.equal(ev3.prev, ledger.events[1].hash);
  const again = new Ledger(ledger.dir);
  assert.equal(again.integrity().ok, true);
  assert.equal(again.events.length, 3);
});

test('空账本：events=0、lastSeq=0、integrity.ok=true', () => {
  const ledger = newLedger();
  assert.equal(ledger.events.length, 0);
  assert.equal(ledger.lastSeq, 0);
  assert.equal(ledger.lastHash, GENESIS);
  assert.deepEqual(ledger.integrity(), {
    events: 0, lastSeq: 0, lastHash: GENESIS, gaps: [], corruptLines: 0, ok: true,
  });
});

test('篡改检测：改动 data 不改 hash → hash-mismatch 缺口', () => {
  const ledger = makeLedger(3);
  const lines = readLines(ledger.file).map((l) => JSON.parse(l));
  lines[1].data = { i: 999 };
  fs.writeFileSync(ledger.file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const reloaded = new Ledger(ledger.dir);
  assert.equal(reloaded.integrity().ok, false);
  assert.ok(reloaded.gaps.some((g) => g.reason === 'hash-mismatch' && g.seq === 2));
});

test('篡改检测：改动前驱 hash → hash-chain-mismatch 缺口', () => {
  const ledger = makeLedger(3);
  const lines = readLines(ledger.file).map((l) => JSON.parse(l));
  lines[2].prev = 'f'.repeat(64);
  fs.writeFileSync(ledger.file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const reloaded = new Ledger(ledger.dir);
  assert.equal(reloaded.integrity().ok, false);
  assert.ok(reloaded.gaps.some((g) => g.reason === 'hash-chain-mismatch' && g.seq === 3));
});

test('缺口标记：删除中间一行 → seq-gap 缺口', () => {
  const ledger = makeLedger(4);
  const lines = readLines(ledger.file);
  fs.writeFileSync(ledger.file, [lines[0], lines[2], lines[3]].join('\n') + '\n');
  const reloaded = new Ledger(ledger.dir);
  const gaps = reloaded.integrity().gaps;
  assert.ok(gaps.some((g) => g.reason === 'seq-gap' && g.expected === 2));
  assert.equal(reloaded.integrity().ok, false);
});

test('缺口标记：损坏行 → corrupt-line 且 corruptLines 计数', () => {
  const ledger = makeLedger(3);
  const lines = readLines(ledger.file);
  lines[1] = '{这不是合法 JSON';
  fs.writeFileSync(ledger.file, lines.join('\n') + '\n');
  const reloaded = new Ledger(ledger.dir);
  assert.equal(reloaded.corruptLines, 1);
  assert.ok(reloaded.gaps.some((g) => g.reason === 'corrupt-line'));
  assert.equal(reloaded.integrity().ok, false);
});

test('integrity：正常账本 ok=true 且事件数/最后序号正确', () => {
  const ledger = makeLedger(6);
  const report = ledger.integrity();
  assert.equal(report.ok, true);
  assert.equal(report.events, 6);
  assert.equal(report.lastSeq, 6);
  assert.equal(report.corruptLines, 0);
});

test('hashOf：同样输入同 hash，data 变化则 hash 变化', () => {
  const base = { seq: 1, at: '2026-01-01T00:00:00.000Z', type: 'x', actor: 'hub', data: { a: 1, b: 2 }, prev: GENESIS };
  assert.equal(hashOf(base), hashOf({ ...base }));
  assert.notEqual(hashOf(base), hashOf({ ...base, data: { a: 1, b: 3 } }));
  assert.notEqual(hashOf(base), hashOf({ ...base, actor: 'node' }));
});

test('stable：键序无关、数组有序、嵌套稳定', () => {
  assert.equal(stable({ b: 1, a: 2 }), stable({ a: 2, b: 1 }));
  assert.notEqual(stable([1, 2]), stable([2, 1]));
  assert.equal(stable({ z: { y: [{ b: 1, a: 2 }] } }), stable({ z: { y: [{ a: 2, b: 1 }] } }));
  assert.equal(stable(null), 'null');
  assert.equal(stable('x'), '"x"');
  assert.equal(stable(3), '3');
});

test('newId：带前缀且两次不重复', () => {
  const a = newId('task');
  const b = newId('task');
  assert.match(a, /^task_[a-z0-9]+$/);
  assert.notEqual(a, b);
});

test('subscribe：追加事件回调收到，退订后不再收到', () => {
  const ledger = newLedger();
  const got = [];
  const off = ledger.subscribe((ev) => got.push(ev.type));
  ledger.append('one', {});
  ledger.append('two', {});
  off();
  ledger.append('three', {});
  assert.deepEqual(got, ['one', 'two']);
});