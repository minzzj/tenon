#!/usr/bin/env node
/**
 * Round4 稳定性 soak（零依赖）：连续 N 分钟心跳/SSE/请求（每 2s），记录账本一致性、seq 连续性、事件数、进程 RSS。
 * 用法：node test/verify/run-soak.mjs [--minutes 10] [--port 7467]
 * 证据：_internal/checker/round4/soak.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EVID = path.join(ROOT, '_internal', 'checker', 'round4');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN = path.join(ROOT, '_internal', 'checker', 'tmp', 'soak-' + STAMP);
const DATA = path.join(RUN, 'data');
const AGENT_DATA = path.join(RUN, 'agent-data');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MINUTES = Number(argOf('--minutes', '10'));
const PORT = Number(argOf('--port', '7467'));
const BASE = 'http://127.0.0.1:' + PORT;
const INTERVAL_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

function rssOf(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Process -Id ' + pid + ' -ErrorAction SilentlyContinue | Select-Object -First 1).WorkingSet64'], { encoding: 'utf8', timeout: 20000 });
  const n = Number(String(r.stdout || '').trim());
  return Number.isFinite(n) ? n : null;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(AGENT_DATA, { recursive: true });
  fs.mkdirSync(path.join(EVID, 'logs'), { recursive: true });
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo.js'), '--fresh', '--data-dir', DATA], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  const hubEnv = { ...process.env, TENON_PORT: String(PORT), TENON_HOST: '127.0.0.1', TENON_DATA_DIR: DATA, TENON_DISCOVERY_PORT: String(PORT + 50), TENON_ASSETS_OCR: '0' };
  const hubLog = fs.openSync(path.join(EVID, 'logs', 'soak-hub-' + STAMP + '.log'), 'a');
  const hub = spawn(process.execPath, [path.join(ROOT, 'server', 'start.js')], { cwd: ROOT, env: hubEnv, stdio: ['ignore', hubLog, hubLog], windowsHide: true });
  let agent = null;
  try {
    let up = false;
    for (let i = 0; i < 160; i += 1) { try { const r = await fetch(BASE + '/api/state'); if (r.ok) { up = true; break; } } catch { /* retry */ } await sleep(250); }
    if (!up) throw new Error('隔离实例未启动');
    const token = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8')).operatorToken;
    const nodeToken = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8')).nodeToken;
    // 真实 node-agent：产生心跳/注册事件流
    const agentEnv = { ...process.env, TENON_HUB_URL: BASE, TENON_DATA_DIR: AGENT_DATA, TENON_NODE_TOKEN: nodeToken, TENON_NODE_ID: 'node-soak', TENON_NODE_NAME: 'Soak 节点', TENON_V2: '1', TENON_CLIPBOARD: '0', TENON_RECEIVE_DIR: path.join(RUN, '接收') };
    const agentLog = fs.openSync(path.join(EVID, 'logs', 'soak-agent-' + STAMP + '.log'), 'a');
    agent = spawn(process.execPath, [path.join(ROOT, 'node-agent', 'agent.js')], { cwd: ROOT, env: agentEnv, stdio: ['ignore', agentLog, agentLog], windowsHide: true });
    // SSE 连接（统计事件条目数）
    let sseEvents = 0;
    let sseConnected = false;
    let sseReader = null;
    const ac = new AbortController();
    (async () => {
      try {
        const res = await fetch(BASE + '/api/stream', { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
        if (!res.ok) return;
        sseConnected = true;
        const reader = res.body.getReader();
        sseReader = reader;
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop() || '';
          for (const chunk of parts) if (/^event:|^data:/m.test(chunk)) sseEvents += 1;
        }
      } catch { /* aborted */ }
    })();
    const t0 = Date.now();
    const endAt = t0 + MINUTES * 60 * 1000;
    const samples = [];
    let reqOk = 0; let reqFail = 0; let sseStart = 0;
    let rssStart = null; let rssEnd = null;
    let lastSeq = null; let seqBreaks = 0; let seqSamples = 0;
    let lastSampleAt = 0;
    while (Date.now() < endAt) {
      try {
        const s = await fetch(BASE + '/api/state', { headers: { 'x-tenon-token': token } }).then((r) => r.json());
        reqOk += 1;
        const seq = Number(s.seq || 0);
        if (lastSeq !== null && seq < lastSeq) seqBreaks += 1;
        if (lastSeq === null) sseStart = sseEvents;
        lastSeq = seq;
        seqSamples += 1;
        const now = Date.now();
        if (now - lastSampleAt >= 30000) {
          lastSampleAt = now;
          const rss = rssOf(hub.pid);
          if (rssStart === null) rssStart = rss;
          rssEnd = rss;
          samples.push({ at: new Date().toISOString(), seq, events: Number(s.events || 0), sseEvents, hubRssMB: rss ? +(rss / 1048576).toFixed(1) : null, agentRssMB: (() => { const a = agent ? rssOf(agent.pid) : null; return a ? +(a / 1048576).toFixed(1) : null; })(), reqOk, reqFail, integrityOk: !!(s.integrity && s.integrity.ok) || s.integrity === undefined ? true : !!s.integrity.ok });
        }
      } catch { reqFail += 1; }
      await sleep(INTERVAL_MS);
    }
    const finalState = await fetch(BASE + '/api/state', { headers: { 'x-tenon-token': token } }).then((r) => r.json());
    const events = fs.readFileSync(path.join(DATA, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const result = { kind: 'soak', stamp: new Date().toISOString(), minutes: MINUTES, port: PORT, durationSec: Math.round((Date.now() - t0) / 1000), reqOk, reqFail, seqSamples, seqBreaks, lastSeq, finalSeq: finalState.seq, eventsCount: events.length, integrityOk: finalState.integrity ? finalState.integrity.ok !== false : null, sseConnected, sseEvents, rssStartMB: rssStart ? +(rssStart / 1048576).toFixed(1) : null, rssEndMB: rssEnd ? +(rssEnd / 1048576).toFixed(1) : null, rssGrowthMB: rssStart && rssEnd ? +((rssEnd - rssStart) / 1048576).toFixed(1) : null, samples };
    result.ok = reqFail === 0 && seqBreaks === 0 && result.integrityOk !== false && sseConnected && result.eventsCount > 0;
    fs.writeFileSync(path.join(EVID, 'soak.json'), JSON.stringify(result, null, 2), 'utf8');
    log('soak 结果：' + (result.ok ? 'PASS' : 'FAIL') + '；请求 ' + reqOk + '/' + (reqOk + reqFail) + '；seq 断裂 ' + seqBreaks + '；事件 ' + events.length + '；RSS ' + result.rssStartMB + '→' + result.rssEndMB + 'MB；SSE 事件 ' + sseEvents);
    log('证据：_internal/checker/round4/soak.json');
    if (!result.ok) process.exitCode = 1;
  } finally {
    try { spawnSync('taskkill', ['/PID', String(agent && agent.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { spawnSync('taskkill', ['/PID', String(hub.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    await sleep(300);
    fs.rmSync(RUN, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error('soak 失败：', e); process.exit(1); });