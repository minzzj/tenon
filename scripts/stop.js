#!/usr/bin/env node
/**
 * 榫卯 Tenon · 优雅停止中枢（v0.1.0）
 *
 * 为什么需要它：直接 taskkill /F 会跳过 server/start.js 的清理（不写 system.stopped、不删 hub.lock），
 * 下次启动会被判定为「崩溃恢复」并出现 crashRecovery 提示。本脚本通过鉴权接口
 * POST /api/shutdown 让中枢自己走 shutdown 流程：追加 system.stopped → 关闭服务 → 释放锁 → 退出。
 *
 * 用法：
 *   node scripts/stop.js
 * 环境变量：
 *   TENON_DATA_DIR（默认 data，读取其中的 secrets.json）
 *   TENON_PORT（默认 7410）、TENON_HOST（默认 127.0.0.1；0.0.0.0 视为 127.0.0.1）
 *   TENON_OPERATOR_TOKEN（可选，直接指定操作令牌，不读 secrets.json）
 *   TENON_STOP_TIMEOUT_MS（默认 10000）
 * 退出码：0 = 已停止或本来没在运行；1 = 停止失败（调用方应回退强制结束）
 */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(import.meta.dirname, '..');
const env = process.env;
const dataDir = path.resolve(ROOT, env.TENON_DATA_DIR || 'data');
const port = Number(env.TENON_PORT || 7410);
const bindHost = env.TENON_HOST || '127.0.0.1';
const host = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;
const base = 'http://' + host + ':' + port;
const timeoutMs = Number(env.TENON_STOP_TIMEOUT_MS || 10000);

function readToken() {
  const fromEnv = String(env.TENON_OPERATOR_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, 'secrets.json');
  if (!fs.existsSync(file)) return '';
  try {
    const secret = JSON.parse(fs.readFileSync(file, 'utf8'));
    return String(secret.operatorToken || '');
  } catch {
    return '';
  }
}

async function alive() {
  try {
    const res = await fetch(base + '/api/state', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await alive())) {
    console.log('中枢未在运行（' + base + '），无需停止。');
    return 0;
  }
  const token = readToken();
  if (!token) {
    console.error('未找到操作令牌：' + path.join(dataDir, 'secrets.json') + '（可用 TENON_OPERATOR_TOKEN 指定）');
    return 1;
  }
  let res;
  try {
    res = await fetch(base + '/api/shutdown', {
      method: 'POST',
      headers: { 'x-tenon-token': token, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('优雅停止请求失败：' + String((err && err.message) || err));
    return 1;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('优雅停止被拒绝：HTTP ' + res.status + ' ' + text.slice(0, 160));
    return 1;
  }
  console.log('已请求优雅停止，等待中枢退出…');
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!(await alive())) {
      console.log('中枢已停止（已写入 system.stopped 并释放 data/hub.lock）。');
      return 0;
    }
    await sleep(250);
  }
  console.error('等待超时：' + timeoutMs + 'ms 内中枢仍未退出');
  return 1;
}

process.exitCode = await main();