// 单元测试公共工具（不带 .test 后缀，不会被 node --test 当测试文件执行）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../../server/lib/ledger.js';
import { replay } from '../../server/lib/state.js';
import { AI } from '../../server/lib/ai.js';

const dirs = [];

export function tempDir(prefix = 'tenon-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

export function cleanupTempDirs() {
  while (dirs.length) {
    const d = dirs.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ }
  }
}

export function newLedger() {
  return new Ledger(tempDir());
}

/** 每次 append 后自动把账本重放到同一个 state 对象上（模拟服务端活状态） */
export function liveState(ledger) {
  const target = replay(ledger.events);
  ledger.subscribe(() => { Object.assign(target, replay(ledger.events)); });
  return target;
}

/** 离线规则 AI（不配置 key，永不发网络请求） */
export function ruleAI() {
  return new AI({ apiKey: '' });
}

export function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
}

export function eventTypes(ledger) {
  return ledger.events.map((ev) => ev.type);
}

export { fs, os, path };
/** 把全局 Date 冻结在固定时刻，用于验证「重放确定性」（部分 step 时间戳回退到 new Date()） */
export function withFrozenTime(iso, fn) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() { return fixed; }
  }
  globalThis.Date = FakeDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}