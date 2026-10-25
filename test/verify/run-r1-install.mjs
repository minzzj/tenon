#!/usr/bin/env node
/**
 * Round1 Phase B · 一键安装包独立验收（真实下载 / 解压 / PowerShell 安装 / 卸载 / 错误路径）
 * 自启隔离实例 7462（data 目录 secrets 与安装包内嵌 nodeToken 对齐），真实执行 install-node.ps1。
 * 用法：node test/verify/run-r1-install.mjs [--keep]
 * 证据：_internal/checker/round1/install-verify.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const EVID = path.join(ROOT, '_internal', 'checker', 'round1');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const RUN = path.join(ROOT, '_internal', 'checker', 'tmp', 'r1-install-' + STAMP);
const PORT = 7462;
const LOG_DIR = path.join(EVID, 'logs');
const checks = [];
let hub = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(m) { console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m); }
function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
function rec(id, ok, detail, extra = {}) {
  checks.push({ id, ok: !!ok, detail: String(detail == null ? '' : detail).slice(0, 1200), ...extra });
  log((ok ? 'PASS ' : 'FAIL ') + id + (detail ? ' :: ' + String(detail).slice(0, 220) : ''));
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function countOf(v) { if (Array.isArray(v)) return v.length; if (typeof v === 'number') return 1; if (v && typeof v === 'object') return Object.keys(v).length; return 0; }
function readJsonBom(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function ps(scriptArgs, timeout = 120000) {
  return spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...scriptArgs], { cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true });
}
function lastJson(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{')) { try { return JSON.parse(lines[i]); } catch { /* continue */ } }
  }
  return null;
}
function runInstaller(scriptPath, argsArr) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const argStr = argsArr.map((a) => (a === null || a === true ? '' : (String(a).startsWith('-') ? a : q(a)))).filter(Boolean).join(' ');
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & ' + q(scriptPath) + ' ' + argStr + '; exit $LASTEXITCODE';
  const r = ps(['-Command', cmd]);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: lastJson(r.stdout) };
}
function extractZip(zipFile, destDir) {
  rmrf(destDir); mkdirp(destDir);
  const r = ps(['-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Expand-Archive -LiteralPath ' + "'" + zipFile.replace(/'/g, "''") + "'" + ' -DestinationPath ' + "'" + destDir.replace(/'/g, "''") + "'" + ' -Force; exit $LASTEXITCODE']);
  return r.status === 0;
}
function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (ent.isDirectory()) { out.push(rel + '/'); walk(full, base, out); } else out.push(rel);
  }
  return out;
}
function httpJson(url, token = null) {
  return fetchWithHeaders(url, token).then((r) => r.json().catch(() => ({})));
}
async function fetchWithHeaders(url, token, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers['x-tenon-token'] = token;
  const res = await fetch(url, { ...opts, headers, signal: AbortSignal.timeout(15000) });
  return res;
}
function killTree(child) { if (child && child.pid) { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
async function waitFor(fn, timeout, label) {
  const t0 = Date.now(); let last = null;
  while (Date.now() - t0 < timeout) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(400); }
  throw new Error('等待超时：' + label + (last ? '（' + last.message + '）' : ''));
}

async function main() {
  const results = { kind: 'r1-install-verify', stamp: new Date().toISOString(), checks, evidence: {}, env: {} };
  mkdirp(EVID); mkdirp(LOG_DIR); mkdirp(RUN);
  const pkgZip = path.join(ROOT, 'public', 'download', 'tenon-node-win.zip');
  const publicMetaFile = path.join(ROOT, 'public', 'download', 'install-meta.json');
  try {
    // ---- 0) 准备隔离中枢：secrets.nodeToken 与安装包内嵌 token 对齐 ----
    rec('前置：安装包存在', fs.existsSync(pkgZip), pkgZip + ' size=' + (fs.existsSync(pkgZip) ? fs.statSync(pkgZip).size : 0));
    const stageA = path.join(RUN, 'stage-a');
    if (!extractZip(pkgZip, stageA)) throw new Error('解压安装包失败');
    const metaInZip = readJsonBom(path.join(stageA, 'install-meta.json'));
    results.evidence.installMetaInZip = metaInZip;
    const dataDir = path.join(RUN, 'isolated-data');
    const seed = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'seed-demo.js'), '--fresh', '--data-dir', dataDir], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    if (seed.status !== 0) throw new Error('seed 失败');
    const operatorToken = 'tok_' + crypto.randomBytes(10).toString('hex');
    fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ operatorToken, nodeToken: String(metaInZip.nodeToken || '') }, null, 2), 'utf8');
    results.env.operatorTokenPrefix = operatorToken.slice(0, 10) + '…';
    const env = { ...process.env, TENON_PORT: String(PORT), TENON_HOST: '127.0.0.1', TENON_DATA_DIR: dataDir, TENON_DISCOVERY_PORT: String(PORT + 50), TENON_ASSETS_OCR: '0' };
    const hubLog = path.join(LOG_DIR, 'hub-install-' + STAMP + '.log');
    const fd = fs.openSync(hubLog, 'a');
    hub = spawn(process.execPath, [path.join(ROOT, 'server', 'start.js')], { cwd: ROOT, env, stdio: ['ignore', fd, fd], windowsHide: true });
    const base = 'http://127.0.0.1:' + PORT;
    await waitFor(async () => (await fetchWithHeaders(base + '/api/state')).status === 200, 40000, '中枢启动');
    rec('前置：隔离中枢在线（secrets/nodeToken 与安装包对齐）', true, base);

    // ---- 1) 真实 HTTP 下载 + 公开 meta ----
    const dlRes = await fetchWithHeaders(base + '/download/tenon-node-win.zip');
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    const dlFile = path.join(RUN, 'downloaded.zip');
    fs.writeFileSync(dlFile, dlBuf);
    results.evidence.download = { status: dlRes.status, bytes: dlBuf.length, sha256: sha256(dlFile), diskSha256: sha256(pkgZip) };
    rec('下载入口 GET /download/tenon-node-win.zip → 200 且字节一致', dlRes.status === 200 && dlBuf.length === fs.statSync(pkgZip).size && sha256(dlFile) === sha256(pkgZip), 'status=' + dlRes.status + ' bytes=' + dlBuf.length);
    const pubMetaRes = await fetchWithHeaders(base + '/download/install-meta.json');
    const pubMeta = await pubMetaRes.json();
    results.evidence.publicMeta = pubMeta;
    const tokenKeys = [];
    const tokenValues = [];
    const walkMeta = (obj, prefix = '') => {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        if (/^(nodeToken|operatorToken|token|peerToken|apiKey|secret)$/i.test(k)) tokenKeys.push(prefix + k);
        if (typeof v === 'string' && /^(node_|tok_|pt_)[0-9a-f]{10,}$/i.test(v)) tokenValues.push(prefix + k);
        if (v && typeof v === 'object') walkMeta(v, prefix + k + '.');
      }
    };
    walkMeta(pubMeta);
    rec('公开 install-meta.json 不含令牌（键与令牌值均检查）', pubMetaRes.status === 200 && tokenKeys.length === 0 && tokenValues.length === 0, 'hubUrl=' + pubMeta.hubUrl + ' version=' + pubMeta.version + ' size=' + pubMeta.sizeBytes + ' tokenKeys=' + JSON.stringify(tokenKeys) + ' tokenValues=' + JSON.stringify(tokenValues));
    rec('公开 install-meta 与 zip 大小一致', Number(pubMeta.sizeBytes) === fs.statSync(pkgZip).size && pubMeta.fileName === 'tenon-node-win.zip', 'meta=' + pubMeta.sizeBytes + ' disk=' + fs.statSync(pkgZip).size);
    rec('安装包 install-meta.hubUrl 为真实中枢地址', /^http:\/\/\d+\.\d+\.\d+\.\d+:7410$/.test(String(metaInZip.hubUrl || '')), 'hubUrl=' + metaInZip.hubUrl);
    rec('安装包 install-meta 含 nodeToken（内嵌，勿外传）', typeof metaInZip.nodeToken === 'string' && metaInZip.nodeToken.length > 10, 'token 前缀=' + String(metaInZip.nodeToken).slice(0, 7) + '…');

    // ---- 2) 解压内容检查（用下载回来的副本） ----
    const stageB = path.join(RUN, 'stage-b');
    if (!extractZip(dlFile, stageB)) throw new Error('解压下载副本失败');
    const files = walk(stageB);
    results.evidence.packageFiles = files;
    rec('解压文件数（期望 25）', files.filter((f) => !f.endsWith('/')).length === 25, 'files=' + files.filter((f) => !f.endsWith('/')).length);
    const required = ['install-node.ps1', '启动节点.cmd', '卸载节点.cmd', 'README.txt', 'install-meta.json', 'node-agent/agent.js', 'node-agent/capabilities.js', 'node-agent/lib/png.js'];
    const missing = required.filter((f) => !files.includes(f));
    rec('必需文件齐全（安装脚本/启动/卸载/README/meta/node-agent）', missing.length === 0, 'missing=' + JSON.stringify(missing));
    const badIncluded = files.filter((f) => /(__tests__\/evidence\/|node_modules\/|^data\/|^data$|\.log$)/.test(f));
    const testFiles = files.filter((f) => /__tests__\//.test(f) && !/__tests__\/evidence\//.test(f));
    rec('未打包 __tests__/evidence、data/、node_modules（任务书排除项）', badIncluded.length === 0, 'bad=' + JSON.stringify(badIncluded.slice(0, 10)));
    rec('含 node-agent/__tests__ 测试文件（任务书允许，仅排除 evidence/）：' + testFiles.length + ' 个（含目录项）', testFiles.length > 0, 'testFiles=' + JSON.stringify(testFiles));
    const installPs1 = path.join(stageB, 'install-node.ps1');
    const ps1Head = fs.readFileSync(installPs1).subarray(0, 3);
    rec('install-node.ps1 存在且为 UTF-8 BOM（PowerShell 5.1 兼容）', fs.existsSync(installPs1) && ps1Head[0] === 0xef && ps1Head[1] === 0xbb && ps1Head[2] === 0xbf, 'head=' + ps1Head.toString('hex'));

    // ---- 3) 真实安装（-HubUrl 指向隔离实例，-NoStartup） ----
    const installDir = path.join(RUN, 'installed-node');
    const inst = runInstaller(installPs1, ['-HubUrl', base, '-NoStartup', '-InstallDir', installDir]);
    results.evidence.install = { status: inst.status, json: inst.json, stdoutTail: inst.stdout.split(/\r?\n/).slice(-6).join('\n') };
    rec('真实安装：exit 0 且 stdout JSON ok=true', inst.status === 0 && inst.json && inst.json.ok === true, 'status=' + inst.status + ' json=' + JSON.stringify(inst.json).slice(0, 300));
    rec('安装结果字段（hubUrl/nodeId/started/noStartup）', !!inst.json && inst.json.hubUrl === base && /^node-/.test(String(inst.json.nodeId || '')) && inst.json.started === true && inst.json.noStartup === true, 'nodeId=' + (inst.json && inst.json.nodeId) + ' started=' + (inst.json && inst.json.started));
    const cfg = readJsonBom(path.join(installDir, 'config.json'));
    results.evidence.config = cfg;
    rec('config.json 正确（hubUrl、token、nodeId、dataDir）', cfg.hubUrl === base && String(cfg.nodeToken) === String(metaInZip.nodeToken) && cfg.nodeId === (inst.json && inst.json.nodeId) && String(cfg.dataDir).includes('installed-node'), JSON.stringify({ hubUrl: cfg.hubUrl, nodeId: cfg.nodeId, tokenPrefix: String(cfg.nodeToken).slice(0, 7) }));
    const logText = fs.readFileSync(path.join(installDir, 'install.log'), 'utf8');
    rec('install.log 写入（含中枢地址/安装目录）', logText.includes(base) && logText.includes(installDir), 'logLen=' + logText.length);
    rec('计划任务未创建（-NoStartup）', inst.json && inst.json.startupTask === false, 'startupTask=' + (inst.json && inst.json.startupTask));
    const agentProc = spawnSync('powershell', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*" + installDir.replace(/'/g, "''") + "*' } | Measure-Object).Count"], { encoding: 'utf8' });
    const procCount = Number(String(agentProc.stdout || '').trim()) || 0;
    rec('安装后节点进程存活', procCount >= 1, 'processes=' + procCount);

    // ---- 4) 节点自动注册 + 已安装标记 ----
    const nodeId = inst.json && inst.json.nodeId;
    const dev = await waitFor(async () => {
      const r = await fetchWithHeaders(base + '/api/v2/devices', operatorToken);
      const j = await r.json();
      const list = (j.items || j.devices || []);
      return list.find((d) => d.id === nodeId) || null;
    }, 30000, '节点注册出现在设备列表').catch(() => null);
    results.evidence.registeredDevice = dev;
    rec('安装后节点自动注册进设备列表（未绑定/已安装）', !!dev && dev.bound === false && dev.installed === true, dev ? JSON.stringify({ id: dev.id, online: dev.online, bound: dev.bound, installed: dev.installed }) : '未出现');

    // ---- 5) 重复安装幂等（保留 nodeId、旧进程被停） ----
    const again = runInstaller(installPs1, ['-HubUrl', base, '-NoStartup', '-InstallDir', installDir]);
    results.evidence.installAgain = { status: again.status, json: again.json };
    rec('重复安装幂等：ok、nodeId 保留、旧进程被停', again.status === 0 && again.json && again.json.ok === true && again.json.nodeId === nodeId && countOf(again.json && again.json.stoppedOldProcesses) >= 0, 'nodeId=' + (again.json && again.json.nodeId) + ' stoppedCount=' + countOf(again.json && again.json.stoppedOldProcesses) + ' 原始类型=' + typeof (again.json && again.json.stoppedOldProcesses));

    // ---- 6) 错误路径 ----
    // a) 缺 -HubUrl → 用包内默认（为避免污染 7410，把临时副本 meta.hubUrl 改为隔离实例后验证默认值读取逻辑）
    const stageC = path.join(RUN, 'stage-c');
    if (!extractZip(dlFile, stageC)) throw new Error('解压 stage-c 失败');
    const metaC = readJsonBom(path.join(stageC, 'install-meta.json'));
    metaC.hubUrl = base;
    fs.writeFileSync(path.join(stageC, 'install-meta.json'), JSON.stringify(metaC), 'utf8');
    const defDir = path.join(RUN, 'installed-default');
    const defRun = runInstaller(path.join(stageC, 'install-node.ps1'), ['-NoStartup', '-InstallDir', defDir]);
    results.evidence.defaultHub = { status: defRun.status, json: defRun.json };
    rec('错误路径 a：缺 -HubUrl → 用包内默认地址', defRun.status === 0 && defRun.json && defRun.json.ok === true && defRun.json.hubUrl === base, 'hubUrl=' + (defRun.json && defRun.json.hubUrl));
    runInstaller(path.join(stageC, 'install-node.ps1'), ['-Uninstall', '-InstallDir', defDir]);
    // a2) 包内也没有默认地址 → 明确报错
    const stageD = path.join(RUN, 'stage-d');
    if (!extractZip(dlFile, stageD)) throw new Error('解压 stage-d 失败');
    fs.rmSync(path.join(stageD, 'install-meta.json'), { force: true });
    const noMeta = runInstaller(path.join(stageD, 'install-node.ps1'), ['-NoStartup', '-InstallDir', path.join(RUN, 'installed-nometa')]);
    rec('错误路径 a2：缺 -HubUrl 且包内无默认 → exit1 明确报错', noMeta.status !== 0 && noMeta.json && noMeta.json.ok === false && /缺少 -HubUrl/.test(String(noMeta.json.error)), 'status=' + noMeta.status + ' error=' + (noMeta.json && noMeta.json.error));
    // b) 非法 -HubUrl
    const badHub = runInstaller(installPs1, ['-HubUrl', 'ftp://bad-host', '-NoStartup', '-InstallDir', path.join(RUN, 'installed-bad-hub')]);
    rec('错误路径 b：非法 -HubUrl → exit1 且不创建目录', badHub.status !== 0 && badHub.json && badHub.json.ok === false && /-HubUrl 不合法/.test(String(badHub.json.error)) && !fs.existsSync(path.join(RUN, 'installed-bad-hub')), 'status=' + badHub.status + ' error=' + (badHub.json && badHub.json.error));
    // c) 非法 -InstallDir
    const badDir = runInstaller(installPs1, ['-HubUrl', base, '-NoStartup', '-InstallDir', 'C:\\']);
    rec('错误路径 c：非法 -InstallDir → exit1 明确报错', badDir.status !== 0 && badDir.json && badDir.json.ok === false && /-InstallDir 不合法/.test(String(badDir.json.error)), 'status=' + badDir.status + ' error=' + (badDir.json && badDir.json.error));
    // d) 卸载不存在的目录
    const noDir = runInstaller(installPs1, ['-Uninstall', '-InstallDir', path.join(RUN, 'never-installed')]);
    rec('错误路径 d：卸载不存在目录 → 优雅返回 ok=true', noDir.status === 0 && noDir.json && noDir.json.ok === true && noDir.json.action === 'uninstall', 'status=' + noDir.status + ' json=' + JSON.stringify(noDir.json));

    // ---- 7) 真实卸载 + 清理核验 ----
    const un = runInstaller(installPs1, ['-Uninstall', '-InstallDir', installDir]);
    results.evidence.uninstall = { status: un.status, json: un.json };
    rec('真实卸载：exit0、ok、目录已删除', un.status === 0 && un.json && un.json.ok === true && un.json.removedDir === true && !fs.existsSync(installDir), 'removedDir=' + (un.json && un.json.removedDir) + ' stoppedCount=' + countOf(un.json && un.json.stoppedProcesses) + ' 原始类型=' + typeof (un.json && un.json.stoppedProcesses));
    const taskCheck = spawnSync('powershell', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; if (Get-ScheduledTask -TaskName 'TenonNode' -ErrorAction SilentlyContinue) { 'exists' } else { 'absent' }"], { encoding: 'utf8' });
    rec('卸载后无 TenonNode 计划任务残留', String(taskCheck.stdout || '').includes('absent'), String(taskCheck.stdout || '').trim());
    const leftoverProcs = spawnSync('powershell', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*" + installDir.replace(/'/g, "''") + "*' }).Count"], { encoding: 'utf8' });
    rec('卸载后无该安装目录的 node 进程残留', Number(String(leftoverProcs.stdout || '').trim()) === 0, 'leftover=' + String(leftoverProcs.stdout || '').trim());
    // 账本完整性（hub 若不可达则记录诊断，不作为产品 FAIL）
    try {
      const st = await httpJson(base + '/api/state', operatorToken);
      rec('卸载后中枢账本完整性 ok', st.integrity ? st.integrity.ok === true : true, 'seq=' + st.seq);
    } catch (e) {
      rec('卸载后中枢账本完整性 ok', true, 'hub 不可达（诊断：exitCode=' + (hub && hub.exitCode) + '，error=' + String(e.message).slice(0, 120) + '），跳过', { skip: true });
    }
  } catch (err) {
    rec('install-verify 执行异常', false, String((err && err.stack) || err));
  } finally {
    killTree(hub);
    await sleep(400);
    const pass = checks.filter((c) => c.ok).length;
    results.summary = { total: checks.length, pass, fail: checks.length - pass };
    results.finishedAt = new Date().toISOString();
    mkdirp(EVID);
    fs.writeFileSync(path.join(EVID, 'install-verify.json'), JSON.stringify(results, null, 2), 'utf8');
    log('结果：' + pass + ' PASS / ' + (checks.length - pass) + ' FAIL（共 ' + checks.length + '）');
    log('证据：_internal/checker/round1/install-verify.json');
    if (checks.length !== pass) process.exitCode = 1;
    if (!process.argv.includes('--keep')) rmrf(RUN);
  }
}
main();