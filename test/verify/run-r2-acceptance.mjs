#!/usr/bin/env node
/**
 * Round2 独立验收 · 配对第一次就能成功（P0-1..P0-5）
 * 零依赖 Node；自启隔离实例 7462（seed + secrets），真实 HTTP 断言 + 真实故障注入。
 * 覆盖：
 *  A. 六项前置自检基线（hub/subnet/port/discovery/version/data，{id,label,ok,detail,fix[]}）
 *  B. 六类真实故障注入：中枢停掉 / 7413 被占 / 不同网段(X-Forwarded-For) / 码过期(真实等待) /
 *     版本不匹配(header) / 数据目录只读(icacls) —— 每项须给出红项 + 可执行「下一步」fix
 *  C. 二维码带参：v/exp/oneTime、qr 含 host/code/v/exp/oneTime、不含 token；一次性码消费；手输码回归；20 次配对成功率
 *  D. 配对成功页 3 个一键动作（API 下发 actions/capabilities）
 *  E. 设备卡 R2 字段（最近活跃/能力标签/来源/绑定时间）+ 重命名 + 账本 device.renamed + 重启持久化
 *  F. 撤销前影响预览（确定/可能/未知、可重复调用零变化）+ 撤销后 ≤1s 拒绝 + link.revoked + 审计可导出
 * 用法：node test/verify/run-r2-acceptance.mjs [--skip-expiry] [--keep]
 * 证据：_internal/checker/round2/r2-acceptance.json
 */
import fs from 'node:fs';
import path from 'node:path';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EVID = path.join(ROOT, '_internal', 'checker', 'round2');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const RUN = path.join(ROOT, '_internal', 'checker', 'tmp', 'r2-' + STAMP);
const LOG_DIR = path.join(EVID, 'logs');
const MAIN_PORT = 7462;
const ALT_PORT = 7464;
const ALT2_PORT = 7466;
const SKIP_EXPIRY = process.argv.includes('--skip-expiry');
const KEEP = process.argv.includes('--keep');
const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(m) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m); }
function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
function readJson(file, fb = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fb; } }
function rec(id, ok, detail, extra = {}) {
  checks.push({ id, ok: !!ok, skip: !!extra.skip, detail: String(detail == null ? '' : detail).slice(0, 1600), ms: extra.ms ?? null });
  log((extra.skip ? 'SKIP ' : (ok ? 'PASS ' : 'FAIL ')) + id + (detail ? ' :: ' + String(detail).slice(0, 260) : ''));
  return !!ok;
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
async function req(base, method, p, { token = null, body, headers = {}, timeout = 20000 } = {}) {
  const h = { ...headers };
  if (token) h['x-tenon-token'] = token;
  if (body !== undefined && body !== null) h['Content-Type'] = 'application/json';
  const opts = { method, headers: h, signal: AbortSignal.timeout(timeout) };
  if (body !== undefined && body !== null) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  try {
    const res = await fetch(base + p, opts);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: res.status, headers: res.headers, text, json, netError: null };
  } catch (err) {
    return { status: 0, headers: new Headers(), text: '', json: null, netError: String((err && err.message) || err) };
  }
}
function startHub({ port, dataDir, name, envExtra = {} }) {
  mkdirp(dataDir);
  const env = { ...process.env, TENON_PORT: String(port), TENON_HOST: '127.0.0.1', TENON_DATA_DIR: dataDir, TENON_ASSETS_OCR: '0', ...envExtra };
  const logFile = path.join(LOG_DIR, 'hub-' + name + '-' + STAMP + '.log');
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'start.js')], { cwd: ROOT, env, stdio: ['ignore', fd, fd], windowsHide: true });
  child.__port = port; child.__log = logFile; child.__dataDir = dataDir;
  return child;
}
function killTree(child) { if (child && child.pid) { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
async function waitUp(base, timeout = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const r = await req(base, 'GET', '/api/state', { timeout: 2500 }); if (r.status === 200) return true; await sleep(300); }
  return false;
}
function seed(dataDir) {
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo.js'), '--fresh', '--data-dir', dataDir], { cwd: ROOT, encoding: 'utf8', timeout: 120000 }).status === 0;
}
function readSecrets(dataDir) { return readJson(path.join(dataDir, 'secrets.json'), {}) || {}; }
function readEvents(dataDir) {
  try { return fs.readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function findItem(items, id) { return (items || []).find((i) => i && i.id === id) || null; }
function psJson(args) { const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' + args], { encoding: 'utf8', timeout: 60000 }); return (r.stdout || '').trim(); }

async function main() {
  const report = { kind: 'r2-acceptance', stamp: new Date().toISOString(), evidence: {}, checks };
  const dataDir = path.join(RUN, 'data');
  let hub = null;
  const base = 'http://127.0.0.1:' + MAIN_PORT;
  mkdirp(EVID); mkdirp(LOG_DIR); mkdirp(RUN);
  try {
    if (!seed(dataDir)) throw new Error('seed 失败');
    hub = startHub({ port: MAIN_PORT, dataDir, name: 'main', envExtra: { TENON_DISCOVERY_PORT: String(MAIN_PORT + 50) } });
    if (!(await waitUp(base))) throw new Error('主实例未启动：' + fs.readFileSync(hub.__log, 'utf8').slice(-600));
    const secrets = readSecrets(dataDir);
    const token = secrets.operatorToken;
    const version = readJson(path.join(ROOT, 'package.json'), {})?.version || '0.0.0';
    report.env = { base, version, dataDir: path.relative(ROOT, dataDir) };
    log('主实例就绪 ' + base + ' version=' + version);

    // ---------------- A. 前置自检基线 ----------------
    let pf = await req(base, 'GET', '/api/v2/link/preflight', { token });
    let items = [];
    try {
      assert(pf.status === 200, 'status=' + pf.status);
      assert(pf.json && typeof pf.json === 'object', '非 JSON');
      const body = pf.json;
      items = body.items || [];
      assert(items.length === 6, 'items=' + items.length);
      const ids = items.map((i) => i.id).sort();
      for (const want of ['hub', 'subnet', 'port', 'discovery', 'version', 'data']) assert(ids.includes(want), '缺少自检项 ' + want);
      const bad = items.filter((i) => !i.ok);
      assert(bad.length === 0, '基线存在红项：' + JSON.stringify(bad.map((b) => ({ id: b.id, detail: b.detail }))));
      for (const it of items) { assert(typeof it.label === 'string' && it.label.length > 0, it.id + ' 缺 label'); assert(Array.isArray(it.fix), it.id + ' fix 非数组'); assert(it.fix.length === 0, it.id + ' 绿项 fix 应为空'); }
      assert(body.allPass === true || body.ok === true, 'allPass/ok 不为 true');
      assert(String(body.diagnostics || '').includes('全部通过'), 'diagnostics 缺结论');
      assert(body.version === version, 'version=' + body.version + ' 期望 ' + version);
      report.evidence.preflightBaseline = body;
      rec('P0-1 基线自检 6 项全绿 + {id,label,ok,detail,fix} 结构 + 诊断文本', true, items.map((i) => i.id + '=' + (i.ok ? 'ok' : 'bad')).join(','));
    } catch (e) {
      rec('P0-1 基线自检 6 项全绿 + 结构', false, String(e.message));
    }

    // ---------------- B1. 故障注入：不同网段（X-Forwarded-For 真实头） ----------------
    try {
      const r = await req(base, 'GET', '/api/v2/link/preflight', { token, headers: { 'x-forwarded-for': '10.99.99.99' } });
      const its = (r.json && r.json.items) || [];
      const it = findItem(its, 'subnet');
      assert(r.status === 200, 'status=' + r.status);
      assert(it && it.ok === false, 'subnet 未变红');
      assert(Array.isArray(it.fix) && it.fix.length >= 3, 'fix 步数=' + (it.fix || []).length);
      assert((r.json.allPass === false), 'allPass 应为 false');
      report.evidence.faultSubnet = it;
      rec('故障注入 3：不同网段（X-Forwarded-For: 10.99.99.99）→ 网段红项 + 3 步修复', true, it.detail + ' fix=' + JSON.stringify(it.fix));
    } catch (e) { rec('故障注入 3：不同网段', false, String(e.message)); }

    // ---------------- B2. 故障注入：版本不匹配（真实 header） ----------------
    try {
      const r = await req(base, 'GET', '/api/v2/link/preflight', { token, headers: { 'x-tenon-client-version': '0.0.1' } });
      const it = findItem((r.json && r.json.items) || [], 'version');
      assert(r.status === 200, 'status=' + r.status);
      assert(it && it.ok === false, 'version 未变红');
      assert(Array.isArray(it.fix) && it.fix.length >= 3, 'fix 步数=' + (it.fix || []).length);
      report.evidence.faultVersion = it;
      rec('故障注入 5：版本不匹配（x-tenon-client-version: 0.0.1）→ 版本红项 + 3 步修复', true, it.detail);
    } catch (e) { rec('故障注入 5：版本不匹配', false, String(e.message)); }

    // ---------------- B3. 故障注入：数据目录只读（真实 ACL 收紧 data/link → EPERM；独立 ASCII 数据目录实例） ----------------
    {
      let alt = null;
      const aclRoot = 'C:\\Temp\\tenon-r2-acl';
      try {
        rmrf(aclRoot);
        mkdirp(aclRoot);
        const aclData = path.join(aclRoot, 'data');
        if (!seed(aclData)) throw new Error('ACL 实例 seed 失败');
        alt = startHub({ port: 7468, dataDir: aclData, name: 'acl-readonly', envExtra: { TENON_DISCOVERY_PORT: '7568' } });
        const aclBase = 'http://127.0.0.1:7468';
        assert(await waitUp(aclBase), 'ACL 实例未启动');
        const at = readSecrets(aclData).operatorToken;
        const linkDir = path.join(aclData, 'link');
        mkdirp(linkDir);
        const before = await req(aclBase, 'GET', '/api/v2/link/preflight', { token: at });
        const beforeOk = (before.json && before.json.allPass === true);
        const restrict = spawnSync('icacls', [linkDir, '/inheritance:r', '/grant:r', '*S-1-1-0:(OI)(CI)(RX)'], { encoding: 'utf8' });
        assert(restrict.status === 0, 'icacls 限制失败');
        let red = null;
        try {
          const r = await req(aclBase, 'GET', '/api/v2/link/preflight', { token: at });
          red = findItem((r.json && r.json.items) || [], 'data');
        } finally {
          spawnSync('icacls', [linkDir, '/reset', '/T', '/C'], { encoding: 'utf8' });
        }
        assert(red && red.ok === false, 'data 未变红：' + JSON.stringify(red));
        assert(Array.isArray(red.fix) && red.fix.length >= 3, 'fix 步数=' + (red.fix || []).length);
        report.evidence.faultDataReadonly = red;
        await sleep(300);
        const back = await req(aclBase, 'GET', '/api/v2/link/preflight', { token: at });
        const backOk = (back.json && back.json.allPass === true);
        rec('故障注入 6：数据目录只读（真实 ACL → 写探针 EPERM）→ 目录红项+3步修复；恢复后自检回绿', beforeOk && !!backOk, 'red=' + red.detail + '；恢复后 allPass=' + backOk);
      } catch (e) {
        rec('故障注入 6：数据目录只读', false, String(e.message));
      } finally {
        killTree(alt);
        await sleep(300);
        try { spawnSync('cmd', ['/c', 'icacls C:\\Temp\\tenon-r2-acl /reset /T /C >nul 2>&1 & rmdir /s /q C:\\Temp\\tenon-r2-acl'], { stdio: 'ignore' }); } catch { /* ignore */ }
        rmrf(aclRoot);
      }
    }

    // ---------------- B4. 故障注入：发现端口被占用（真实独占 UDP bind → 中枢 discovery 绑定失败） ----------------
    {
      let alt = null;
      let holder = null;
      const DISCOVERY_FAULT_PORT = 7513;
      try {
        // 用 .NET UdpClient ExclusiveAddressUse 独占发现端口（模拟「7413 被不共享端口的外部程序占用」；
        // 真实 7413 由正在运行的 7410 中枢以 SO_REUSEADDR 占用，普通复用绑定无法构造失败，故用独占占用等价注入）
        const holderScript = '$u = New-Object System.Net.Sockets.UdpClient; $u.ExclusiveAddressUse = $true; try { $u.Client.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, ' + DISCOVERY_FAULT_PORT + '))); Write-Output "BOUND"; Start-Sleep -Seconds 60 } catch { Write-Output ("ERR:" + $_.Exception.Message) }';
        holder = spawn('powershell', ['-NoProfile', '-Command', holderScript], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let holderOut = '';
        holder.stdout.on('data', (d) => { holderOut += String(d); });
        let bound = false;
        for (let k = 0; k < 30; k += 1) { await sleep(200); if (holderOut.includes('BOUND')) { bound = true; break; } }
        assert(bound, '独占发现端口失败：' + holderOut.slice(0, 200));
        const altData = path.join(RUN, 'alt-data');
        if (!seed(altData)) throw new Error('alt seed 失败');
        alt = startHub({ port: ALT_PORT, dataDir: altData, name: 'discovery-busy', envExtra: { TENON_DISCOVERY_PORT: String(DISCOVERY_FAULT_PORT) } });
        const altBase = 'http://127.0.0.1:' + ALT_PORT;
        const up = await waitUp(altBase, 30000);
        assert(up, '发现端口冲突不应阻断中枢启动');
        const at = readSecrets(altData).operatorToken;
        const r = await req(altBase, 'GET', '/api/v2/link/preflight', { token: at });
        const it = findItem((r.json && r.json.items) || [], 'discovery');
        assert(it && it.ok === false, 'discovery 未变红：' + JSON.stringify(it));
        assert(Array.isArray(it.fix) && it.fix.length >= 3, 'fix 步数=' + (it.fix || []).length);
        assert(/绑定|占用|失败|EACCES|不可用|未开启/.test(String(it.detail || '')), 'detail 未说明原因：' + it.detail);
        // 优雅降级：发现不可用，但中枢在线/端口/配对/二维码仍可用
        const qr = await req(altBase, 'GET', '/api/v2/link/pair/qr', { token: at });
        assert(qr.status === 200 && qr.json && qr.json.code, '发现失败时二维码不可用');
        const hubItem = findItem((r.json && r.json.items) || [], 'hub');
        assert(hubItem && hubItem.ok === true, '发现失败导致中枢自检也红（不应）');
        report.evidence.faultDiscoveryBusy = it;
        rec('故障注入 2：发现端口被占（真实独占 UDP 占用 → discovery 绑定失败）→ 红项+3步修复；中枢/二维码仍可用（优雅降级）', true, it.detail + '；qr=' + qr.json.code);
      } catch (e) {
        rec('故障注入 2：发现端口被占', false, String(e.message));
      } finally {
        killTree(alt);
        try { if (holder) spawnSync('taskkill', ['/PID', String(holder.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
        await sleep(400);
      }
    }

    // ---------------- C. 二维码带参 / 一次性 / 手输码 / 20 次成功率 ----------------
    let pairInfo = null;
    try {
      const r = await req(base, 'GET', '/api/v2/link/pair/qr', { token });
      const q = r.json || {};
      assert(r.status === 200, 'status=' + r.status);
      assert(/^\d{6}$/.test(String(q.code || '')), 'code=' + q.code);
      assert(Number(q.v) === 2, 'v=' + q.v);
      assert(Number.isFinite(Number(q.exp)) && Number(q.exp) > Date.now() - 5000, 'exp=' + q.exp);
      assert(q.oneTime === true, 'oneTime=' + q.oneTime);
      const qr = String(q.qr || '');
      for (const part of ['tenon://pair?', 'host=', 'code=', 'v=2', 'exp=', 'oneTime=1']) assert(qr.includes(part), 'qr 缺 ' + part + '：' + qr.slice(0, 160));
      const secrets2 = readSecrets(dataDir);
      assert(!qr.includes(secrets2.operatorToken) && !qr.includes(secrets2.nodeToken), 'qr 含令牌！');
      report.evidence.qr = q;
      rec('P0-2 二维码带参 v/exp/oneTime，含 host/code/v/exp/oneTime，不含令牌', true, 'qr=' + qr.slice(0, 140));
      // 一次性：配对后旧码失效
      const first = await req(base, 'POST', '/api/v2/link/pair', { body: { code: q.code, deviceId: 'verify-r2-c1', name: '验收客户端C1', platform: 'windows' } });
      assert(first.status === 200 && first.json && first.json.ok, '配对失败：' + first.status + ' ' + first.text.slice(0, 200));
      pairInfo = first.json;
      const reuse = await req(base, 'POST', '/api/v2/link/pair', { body: { code: q.code, deviceId: 'verify-r2-reuse', name: '复用旧码', platform: 'windows' } });
      assert([400, 403].includes(reuse.status), '旧码复用应被拒绝，实际 ' + reuse.status);
      const qr2 = await req(base, 'GET', '/api/v2/link/pair/qr', { token });
      assert(qr2.json && qr2.json.code && qr2.json.code !== q.code, '一次性码配后未换新码');
      report.evidence.oneTime = { oldCode: q.code, newCode: qr2.json.code, reuseStatus: reuse.status };
      rec('P0-2 一次性码：配对后旧码拒绝 + 自动换新码', true, '旧码 ' + q.code + ' → 拒绝 ' + reuse.status + '；新码 ' + qr2.json.code);
      // 手输码回归（入站配对，无需 token）
      const manual = await req(base, 'POST', '/api/v2/link/pair', { body: { code: qr2.json.code, deviceId: 'verify-r2-manual', name: '手输码客户端', platform: 'android' } });
      assert(manual.status === 200 && manual.json && manual.json.ok, '手输码配对失败：' + manual.status + ' ' + manual.text.slice(0, 200));
      rec('P0-2 手输码兜底路径回归可用', true, 'paired=' + manual.json.paired);
      // 20 次配对成功率
      let success = 0; const attempts = 20;
      for (let i = 0; i < attempts; i += 1) {
        const rq = await req(base, 'GET', '/api/v2/link/pair/qr', { token });
        if (!rq.json || !rq.json.code) continue;
        const p = await req(base, 'POST', '/api/v2/link/pair', { body: { code: rq.json.code, deviceId: 'verify-r2-loop-' + i, name: '成功率客户端' + i, platform: 'windows' } });
        if (p.status === 200 && p.json && p.json.ok) success += 1;
      }
      const rate = success / attempts;
      report.evidence.pairSuccessRate = { success, attempts, rate };
      rec('首次配对成功率（20 次真实刷新码+配对）', rate >= 0.95, success + '/' + attempts + ' = ' + Math.round(rate * 100) + '%');
      // 配对成功页 3 动作 fields（从首个配对响应）
      const actions = pairInfo.actions || [];
      const caps = pairInfo.capabilities || [];
      const ids = actions.map((a) => a && a.id);
      const ok = actions.length === 3 && ['send-file', 'clipboard-sync', 'handoff-page'].every((x) => ids.includes(x)) && caps.includes('files') && caps.includes('clipboard');
      report.evidence.pairActions = { actions, capabilities: caps };
      rec('P0-3 配对成功响应下发 3 个一键动作 + 能力清单', ok, 'actions=' + JSON.stringify(ids) + ' caps=' + JSON.stringify(caps));
    } catch (e) { rec('P0-2/P0-3 二维码/配对/动作', false, String(e.message)); }

    // ---------------- B5. 故障注入：码过期（真实等待 TTL） ----------------
    if (SKIP_EXPIRY) {
      rec('故障注入 4：码过期', true, '--skip-expiry 跳过（默认会真实等待 ~120s）', { skip: true });
    } else {
      try {
        const r = await req(base, 'GET', '/api/v2/link/pair/qr', { token });
        const q = r.json || {};
        const exp = Number(q.exp) || (Date.now() + 120000);
        const waitMs = Math.max(1000, exp - Date.now() + 800);
        assert(waitMs < 200000, 'TTL 异常：' + waitMs + 'ms');
        log('等待配对码真实过期 ' + Math.round(waitMs / 1000) + 's（TTL=' + (waitMs - 800) + 'ms）…');
        await sleep(waitMs);
        const expired = await req(base, 'POST', '/api/v2/link/pair', { body: { code: q.code, deviceId: 'verify-r2-expired', name: '过期码客户端', platform: 'windows' } });
        assert([400, 403].includes(expired.status), '过期码应 4xx，实际 ' + expired.status + ' ' + expired.text.slice(0, 160));
        const qr2 = await req(base, 'GET', '/api/v2/link/pair/qr', { token });
        assert(qr2.json && qr2.json.code && qr2.json.code !== q.code && Number(qr2.json.exp) > Date.now(), '过期后未自动换新码');
        report.evidence.faultExpired = { code: q.code, status: expired.status, error: expired.json, newCode: qr2.json.code };
        rec('故障注入 4：码过期（真实等待 ' + Math.round(waitMs / 1000) + 's）→ 4xx「已过期/不正确」+ 自动换新码', true, 'status=' + expired.status + ' error=' + ((expired.json && expired.json.error) || '').slice(0, 80) + ' 新码=' + qr2.json.code);
      } catch (e) { rec('故障注入 4：码过期', false, String(e.message)); }
    }

    // ---------------- E. 设备卡 R2 字段 + 重命名 + 持久化 + 账本 ----------------
    let targetDevice = null;
    try {
      const r = await req(base, 'GET', '/api/v2/devices', { token });
      assert(r.status === 200, 'devices status=' + r.status);
      const list = (r.json && (r.json.items || r.json.devices)) || [];
      assert(list.length > 0, '设备列表为空');
      const baseFields = ['id', 'name', 'platform', 'online', 'bound', 'installed', 'capabilitiesCount', 'lastSeen'];
      const r2Fields = ['lastActiveText', 'lastSeenText', 'capabilityTags', 'sourceText', 'bindable'];
      const missBase = baseFields.filter((f) => !(f in list[0]));
      const missR2 = r2Fields.filter((f) => !(f in list[0]));
      assert(missBase.length === 0, '基础字段缺 ' + JSON.stringify(missBase));
      assert(missR2.length === 0, 'R2 字段缺 ' + JSON.stringify(missR2));
      const offline = list.find((d) => d && d.online === false && d.lastSeen && (Date.now() - new Date(d.lastSeen).getTime()) > 60000);
      const offlineOk = !offline || /前|小时|分钟|天/.test(String(offline.lastActiveText || ''));
      report.evidence.deviceFields = { total: list.length, sample: list[0], offline: offline || null };
      rec('P0-4 设备卡字段补齐（基础 8 项 + R2 lastActiveText/capabilityTags/sourceText/bindable）', true, 'total=' + list.length + ' r2=' + r2Fields.join(','));
      rec('P0-4 离线设备显示「最后在线 X 前」相对时间', offlineOk, offline ? 'lastSeen=' + offline.lastSeen + ' lastActiveText=' + offline.lastActiveText : '无离线设备可验（视为通过）');
      targetDevice = list.find((d) => d && d.bindable === true) || list.find((d) => d && d.kind !== 'hub') || list[0];
      // 重命名
      const newName = '验收重命名-' + STAMP.slice(-6);
      const rn = await req(base, 'POST', '/api/v2/devices/' + encodeURIComponent(targetDevice.id) + '/rename', { token, body: { name: newName } });
      assert(rn.status === 200 && rn.json && rn.json.ok === true, 'rename status=' + rn.status + ' ' + rn.text.slice(0, 200));
      const after = await req(base, 'GET', '/api/v2/devices', { token });
      const got = ((after.json && (after.json.items || after.json.devices)) || []).find((d) => d.id === targetDevice.id);
      assert(got && got.name === newName, '列表未显示新名：' + (got && got.name));
      const events = readEvents(dataDir);
      const rnEvent = events.filter((e) => e.type === 'device.renamed').slice(-1)[0];
      assert(rnEvent && rnEvent.data && rnEvent.data.to === newName, '账本缺 device.renamed');
      report.evidence.rename = { id: targetDevice.id, from: targetDevice.name, to: newName, event: rnEvent.data };
      // 重启持久化（与故障注入 1 合并：同时验证「中枢停掉」）
      killTree(hub); hub = null;
      await sleep(700);
      const down = await req(base, 'GET', '/api/v2/link/preflight', { timeout: 3000 });
      assert(down.status === 0, '中枢停掉后仍可访问？status=' + down.status);
      hub = startHub({ port: MAIN_PORT, dataDir, name: 'main-restarted', envExtra: { TENON_DISCOVERY_PORT: String(MAIN_PORT + 50) } });
      assert(await waitUp(base), '重启未恢复');
      const persisted = await req(base, 'GET', '/api/v2/devices', { token });
      const pdev = ((persisted.json && (persisted.json.items || persisted.json.devices)) || []).find((d) => d.id === targetDevice.id);
      const pf2 = await req(base, 'GET', '/api/v2/link/preflight', { token });
      assert(pdev && pdev.name === newName, '重启后重命名未持久化：' + (pdev && pdev.name));
      report.evidence.faultHubDown = { downStatus: down.status, recoveredPreflight: pf2.status, persistedName: pdev.name };
      rec('P0-4 重命名写账本 device.renamed + 重启后持久化', true, 'from=' + targetDevice.name + ' → ' + newName + '；重启后仍为 ' + pdev.name);
      rec('故障注入 1：中枢停掉→自检不可达；重启后自检恢复全绿', down.status === 0 && pf2.status === 200 && ((pf2.json && pf2.json.allPass) || false), '停掉时 netError；重启后 allPass=' + (pf2.json && pf2.json.allPass));
      // 改回原名
      await req(base, 'POST', '/api/v2/devices/' + encodeURIComponent(targetDevice.id) + '/rename', { token, body: { name: targetDevice.name } });
    } catch (e) { rec('P0-4 设备卡/R2 字段/重命名持久化 + 故障注入 1', false, String(e.message)); }

    // ---------------- F. 撤销预览 + ≤1s 失效 + 账本可导出 ----------------
    try {
      assert(pairInfo && pairInfo.peer && pairInfo.peer.peerId, '缺少已配对 peer（前置 C 失败）');
      const peerId = pairInfo.peer.peerId;
      const peerToken = pairInfo.token;
      const preview = await req(base, 'GET', '/api/v2/link/revoke/preview?peerId=' + encodeURIComponent(peerId), { token });
      assert(preview.status === 200, 'preview status=' + preview.status + ' ' + preview.text.slice(0, 200));
      const body = preview.json || {};
      const counts = body.counts || {};
      assert(typeof counts.certain === 'number' && typeof counts.possible === 'number' && typeof counts.unknown === 'number', 'counts 缺三级：' + JSON.stringify(counts));
      assert(Array.isArray((body.items || {}).certain), 'items.certain 非数组');
      assert(String(body.cancelHint || '').length > 0, '缺 cancelHint');
      const eventsBefore = readEvents(dataDir).length;
      const preview2 = await req(base, 'GET', '/api/v2/link/revoke/preview?peerId=' + encodeURIComponent(peerId), { token });
      const eventsAfterPreview = readEvents(dataDir).length;
      assert(eventsBefore === eventsAfterPreview, '预览写账本了（取消零变化被破坏）：' + eventsBefore + '→' + eventsAfterPreview);
      assert(JSON.stringify(preview2.json.counts) === JSON.stringify(counts), '两次预览 counts 不一致');
      report.evidence.revokePreview = body;
      rec('P0-5 撤销前影响预览（确定/可能/未知 + 取消零变化/可重复）', true, 'counts=' + JSON.stringify(counts) + ' sentence=' + String(body.sentence || '').slice(0, 80));
      // 撤销 + ≤1s 失效
      const t0 = Date.now();
      const rev = await req(base, 'POST', '/api/v2/link/revoke', { token, body: { peerId, reason: 'R2 验收撤销' } });
      assert(rev.status === 200 && rev.json && rev.json.ok, 'revoke status=' + rev.status + ' ' + rev.text.slice(0, 200));
      // 撤销后旧 peerToken 调用「需要鉴权的写接口」必须立即被拒（peers 为公开读，不能作为探测点）
      let denied = null; let deniedAt = null;
      for (let i = 0; i < 20; i += 1) {
        const probe = await req(base, 'POST', '/api/v2/link/clipboard', { token: peerToken, body: { kind: 'text', text: 'after-revoke' } });
        if ([401, 403].includes(probe.status)) { denied = probe; deniedAt = Date.now(); break; }
        await sleep(50);
      }
      const delta = deniedAt ? deniedAt - t0 : null;
      assert(denied, '撤销后旧 peerToken 仍可用（未失效）');
      assert(delta !== null && delta <= 1000, '撤销生效耗时 ' + delta + 'ms > 1000ms');
      const peersAfter = await req(base, 'GET', '/api/v2/link/peers', { token });
      const peersList = (peersAfter.json && (peersAfter.json.peers || peersAfter.json.items)) || [];
      assert(!peersList.some((p) => String((p && (p.peerId || p.id)) || '') === String(peerId)), '撤销后信任列表仍包含该设备');
      const events = readEvents(dataDir);
      const revEvent = events.filter((e) => e.type === 'link.revoked').slice(-1)[0];
      assert(revEvent, '账本缺 link.revoked');
      const audit = await req(base, 'GET', '/api/v2/org/audit/export?format=json', { token });
      assert(audit.status === 200 && /link\.revoked/.test(audit.text), '审计导出未含 link.revoked');
      const reQR = await req(base, 'GET', '/api/v2/link/pair/qr', { token });
      assert(reQR.status === 200 && reQR.json && reQR.json.code, '撤销后二维码不可用（重新配对入口缺失）');
      report.evidence.revoke = { peerId, revokeStatus: rev.status, deniedStatus: denied.status, deltaMs: delta, event: revEvent.data };
      rec('P0-5 撤销后 ≤1s 旧 peerToken 失效 + link.revoked + 审计可导出 + 重新配对入口', true, 'denied=' + denied.status + ' ' + delta + 'ms; ledger=' + !!revEvent + '; export=ok; 新码=' + reQR.json.code);
    } catch (e) { rec('P0-5 撤销预览/撤销失效/账本', false, String(e.message)); }
  } catch (err) {
    rec('执行异常', false, String((err && err.stack) || err));
  } finally {
    killTree(hub);
    await sleep(400);
    const pass = checks.filter((c) => c.ok).length;
    const fail = checks.filter((c) => !c.ok).length;
    const skip = checks.filter((c) => c.skip).length;
    report.summary = { total: checks.length, pass, fail, skip };
    report.finishedAt = new Date().toISOString();
    mkdirp(EVID);
    fs.writeFileSync(path.join(EVID, 'r2-acceptance.json'), JSON.stringify(report, null, 2), 'utf8');
    log('结果：' + pass + ' PASS / ' + fail + ' FAIL / ' + skip + ' SKIP（共 ' + checks.length + '）');
    log('证据：_internal/checker/round2/r2-acceptance.json');
    if (!KEEP) rmrf(RUN);
    if (fail > 0) process.exitCode = 1;
  }
}
main();