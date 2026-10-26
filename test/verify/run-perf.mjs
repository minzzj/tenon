#!/usr/bin/env node
/**
 * Round4 性能基线（零依赖）：隔离实例 + seed 数据，4 个关键 API 各 50 次，记录 P50/P95/max。
 * 用法：node test/verify/run-perf.mjs
 * 证据：_internal/checker/round4/perf.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EVID = path.join(ROOT, '_internal', 'checker', 'round4');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN = path.join(ROOT, '_internal', 'checker', 'tmp', 'perf-' + STAMP);
const DATA = path.join(RUN, 'data');
const PORT = Number(process.env.PERF_PORT || 7462);
const BASE = 'http://127.0.0.1:' + PORT;
const N = Number(process.env.PERF_N || 50);
const ENDPOINTS = [
  { name: 'GET /api/state', path: '/api/state' },
  { name: 'GET /api/v2/devices', path: '/api/v2/devices' },
  { name: 'GET /api/v2/assets?q=', path: '/api/v2/assets?q=%E6%A0%B7%E5%93%81' },
  { name: 'GET /api/v2/super/home', path: '/api/v2/super/home' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

function pct(arr, p) {
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1));
  return a[i];
}

async function get(p, token) {
  const t0 = performance.now();
  const res = await fetch(BASE + p, { headers: token ? { 'x-tenon-token': token } : {} });
  const text = await res.text();
  return { ms: performance.now() - t0, status: res.status, bytes: text.length };
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(EVID, { recursive: true });
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo.js'), '--fresh', '--data-dir', DATA], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const env = { ...process.env, TENON_PORT: String(PORT), TENON_HOST: '127.0.0.1', TENON_DATA_DIR: DATA, TENON_DISCOVERY_PORT: String(PORT + 50), TENON_ASSETS_OCR: '0' };
  const logf = fs.openSync(path.join(EVID, 'logs', 'perf-hub-' + STAMP + '.log'), 'a');
  const hub = spawn(process.execPath, [path.join(ROOT, 'server', 'start.js')], { cwd: ROOT, env, stdio: ['ignore', logf, logf], windowsHide: true });
  try {
    let up = false;
    for (let i = 0; i < 120; i += 1) { try { const r = await fetch(BASE + '/api/state'); if (r.ok) { up = true; break; } } catch { /* retry */ } await sleep(250); }
    if (!up) throw new Error('隔离实例未启动');
    const token = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8')).operatorToken;
    for (const ep of ENDPOINTS) { for (let i = 0; i < 5; i += 1) await get(ep.path, token); } // warmup
    const result = { kind: 'perf', stamp: new Date().toISOString(), port: PORT, n: N, endpoints: {} };
    for (const ep of ENDPOINTS) {
      const samples = [];
      const statuses = new Set();
      for (let i = 0; i < N; i += 1) {
        const r = await get(ep.path, token);
        statuses.add(r.status);
        samples.push(r.ms);
      }
      const item = { name: ep.name, path: ep.path, n: samples.length, statuses: [...statuses], p50: +pct(samples, 50).toFixed(2), p95: +pct(samples, 95).toFixed(2), max: +Math.max(...samples).toFixed(2), min: +Math.min(...samples).toFixed(2), avg: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2) };
      result.endpoints[ep.name] = item;
      log(item.name + ' → p50=' + item.p50 + 'ms p95=' + item.p95 + 'ms max=' + item.max + 'ms status=' + item.statuses.join('/'));
    }
    result.ok = Object.values(result.endpoints).every((e) => e.statuses.length === 1 && e.statuses[0] === 200);
    fs.writeFileSync(path.join(EVID, 'perf.json'), JSON.stringify(result, null, 2), 'utf8');
    log('结果：' + (result.ok ? 'PASS' : 'FAIL') + '；证据 _internal/checker/round4/perf.json');
    if (!result.ok) process.exitCode = 1;
  } finally {
    try { spawnSync('taskkill', ['/PID', String(hub.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(300);
    fs.rmSync(RUN, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error('perf 失败：', e); process.exit(1); });