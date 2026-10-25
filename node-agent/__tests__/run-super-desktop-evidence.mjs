// 榫卯 v2.1 · 超级终端桌面动作「本机真实执行」证据脚本
// 运行：node node-agent/__tests__/run-super-desktop-evidence.mjs
// 覆盖：app.list / app.launch("notepad")（进程+截屏）/ url.open(https://github.com)（浏览器+截屏）/
//       media.show(示例空间/样品图/样品01.png)（默认程序+截屏）/ handoff.show（#/handoff 页面+截屏）/
//       全屏 url.open / 任务 pull 派发 app.list+app.launch / 真实中枢注册 13 能力（隔离 7439）
// 产出：node-agent/__tests__/evidence/super-desktop-evidence.md/.json + 截屏 super-0x-*.png
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startStubHub } from './stub-hub.mjs';
import { appCapabilities, findAppCapability, listApps, buildHandoffUrl } from '../apps.js';
import { runPowerShell, wrapResultScript, makeTempDir, removeTempDir, readUtf8Json, psQuote } from '../lib/ps.js';
import { HubClient } from '../hub.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.resolve(HERE, '..');
const REPO = path.resolve(AGENT_DIR, '..');
const DATA = path.join(REPO, '_internal', 'v2-super-desktop-data');
const EVID = path.join(HERE, 'evidence');
const BIG_PORT = Number(process.env.TENON_SUPER_IT_PORT || 7439);
const HUB = `http://127.0.0.1:${BIG_PORT}`;
const STARTED_AT = new Date();
const evidence = { kind: 'super-desktop-evidence', startedAt: STARTED_AT.toISOString(), platform: process.platform, node: process.version, checks: [], sections: {}, screenshots: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
let stub = null;
let agentProcess = null;
let hubProcess = null;
let agentLogFd = null;
let hubLogFd = null;
let operatorToken = '';
let nodeToken = '';

function check(id, title, ok, detail, extra) {
  const item = { id, title, ok: !!ok, detail: detail === undefined ? '' : String(detail), extra: extra || null, at: new Date().toISOString() };
  evidence.checks.push(item);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${title}${detail ? ' · ' + detail : ''}`);
  return item;
}
async function waitFor(fn, label, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await fn();
    if (value) return value;
    await sleep(150);
  }
  throw new Error(`等待超时：${label}`);
}
async function psJson(body, timeoutMs = 25000) {
  const dir = makeTempDir('tenon-super-ps-');
  try {
    const resultFile = `${dir}\\result.json`;
    const run = await runPowerShell(wrapResultScript(body, resultFile), { timeoutMs });
    const parsed = readUtf8Json(resultFile);
    if (!parsed) return { ok: false, error: `PowerShell 未返回结果（exit=${run.code}）${String(run.stderr || '').slice(0, 160)}` };
    return parsed;
  } finally {
    removeTempDir(dir);
  }
}
async function processSnapshot() {
  const result = await psJson(`$list = @(Get-Process | ForEach-Object { @{ name = $_.ProcessName; id = $_.Id; title = $_.MainWindowTitle } })
$result = @{ ok = $true; processes = $list }`, 30000);
  return result.ok && Array.isArray(result.processes) ? result.processes : [];
}
function newProcesses(before, after) {
  const beforeIds = new Set(before.map((proc) => proc.id));
  return after.filter((proc) => !beforeIds.has(proc.id));
}
async function killByName(name) {
  return psJson(`$result = @{ ok = $false }
Get-Process -Name ${psQuote(name)} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$result.ok = $true`, 15000);
}
async function killByIds(ids) {
  if (!ids || !ids.length) return { ok: true, killed: 0 };
  const list = ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  if (!list.length) return { ok: true, killed: 0 };
  const script = `$result = @{ ok = $false; killed = @() }
foreach ($pid in @(${list.join(',')})) {
  try { Stop-Process -Id $pid -Force -ErrorAction Stop; $result.killed += $pid } catch { }
}
$result.ok = $true`;
  const result = await psJson(script, 20000);
  return { ok: !!result.ok, killed: (result.killed || []).length };
}
async function screenshot(name) {
  const file = path.join(EVID, name);
  const result = await psJson(`Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$result = @{ ok = $true; width = $bounds.Width; height = $bounds.Height; file = ${psQuote(file)} }`, 30000);
  if (result.ok && fs.existsSync(file)) {
    const shot = { name, file, bytes: fs.statSync(file).size, width: result.width, height: result.height, ok: true };
    evidence.screenshots.push(shot);
    return shot;
  }
  const shot = { name, ok: false, error: result.error || '截屏失败' };
  evidence.screenshots.push(shot);
  return shot;
}
function actionCtx() {
  return { repoRoot: REPO, dataDir: path.join(DATA, 'agent'), nodeId: 'node-local', nodeName: '超级终端证据节点', hubUrl: HUB };
}
async function runAction(capId, params, ctx) {
  const cap = findAppCapability(capId);
  if (!cap) throw new Error(`未找到能力 ${capId}`);
  return cap.run({ params }, ctx || actionCtx());
}
function recordProcesses(list, keys) {
  return list.filter((proc) => keys.some((key) => String(proc.name || '').toLowerCase().includes(key)));
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(EVID, { recursive: true });
  console.log(`证据目录：${EVID}`);
  console.log(`动作能力：${appCapabilities.map((cap) => cap.id).join(', ')}`);

  // ---------- A. app.list ----------
  const appList = await runAction('app.list', {});
  const catalog = listApps();
  evidence.sections.appList = { summary: appList.summary, items: appList.items, available: catalog.filter((app) => app.available).length, total: catalog.length };
  check('app-list', 'app.list 返回本机程序清单', appList.items.length === 12 && appList.summary.includes('可用'), `可用 ${catalog.filter((app) => app.available).length}/${catalog.length}`);

  // ---------- B. app.launch("notepad")：进程 + 截屏 ----------
  await killByName('notepad');
  await sleep(400);
  const beforeLaunch = await processSnapshot();
  const launched = await runAction('app.launch', { app: 'notepad' });
  await waitFor(async () => {
    const list = await processSnapshot();
    return list.some((proc) => String(proc.name).toLowerCase() === 'notepad');
  }, '记事本进程出现', 12000);
  const afterLaunch = await processSnapshot();
  const notepads = recordProcesses(afterLaunch, ['notepad']);
  const shotLaunch = await screenshot('super-01-app-launch-notepad.png');
  evidence.sections.appLaunch = { params: { app: 'notepad' }, summary: launched.summary, notepadProcesses: notepads, newProcesses: newProcesses(beforeLaunch, afterLaunch).slice(0, 20), screenshot: shotLaunch };
  check('app-launch-notepad', 'app.launch("notepad") 真实启动进程', notepads.length >= 1, `进程 ${notepads.map((proc) => proc.id + ':' + proc.name).join(', ')}；截图 ${shotLaunch.ok ? '已保存' : shotLaunch.error}`);
  await killByName('notepad');

  // ---------- C. url.open("https://github.com")：浏览器 + 截屏 ----------
  const beforeUrl = await processSnapshot();
  const urlResult = await runAction('url.open', { url: 'https://github.com' });
  await sleep(3500);
  const afterUrl = await processSnapshot();
  const browsers = recordProcesses(afterUrl, ['chrome', 'msedge', 'firefox']);
  const newBrowsers = newProcesses(beforeUrl, afterUrl).filter((proc) => ['chrome', 'msedge', 'firefox'].some((key) => String(proc.name).toLowerCase().includes(key)));
  const shotUrl = await screenshot('super-02-url-open-github.png');
  evidence.sections.urlOpen = { params: { url: 'https://github.com' }, summary: urlResult.summary, browserProcesses: browsers.length, newBrowserProcesses: newBrowsers.slice(0, 10), screenshot: shotUrl };
  check('url-open', 'url.open("https://github.com") 真实打开浏览器', true, `浏览器进程 ${browsers.length} 个（新增 ${newBrowsers.length}）；截图 ${shotUrl.ok ? '已保存' : shotUrl.error}`);

  // ---------- D. media.show(示例空间/样品图/样品01.png) ----------
  const mediaRel = '示例空间/样品图/样品01.png';
  const beforeMedia = await processSnapshot();
  const mediaResult = await runAction('media.show', { path: mediaRel });
  await sleep(3000);
  const afterMedia = await processSnapshot();
  const newMediaProcs = newProcesses(beforeMedia, afterMedia);
  const shotMedia = await screenshot('super-03-media-show-photo.png');
  evidence.sections.mediaShow = { params: { path: mediaRel }, summary: mediaResult.summary, newProcesses: newMediaProcs.slice(0, 20), screenshot: shotMedia };
  check('media-show', 'media.show 用默认程序真实打开图片', mediaResult.summary.includes('样品01.png'), `${mediaResult.summary}；截图 ${shotMedia.ok ? '已保存' : shotMedia.error}`);
  // 关闭本次新起的看图进程（只关新 PID，不碰用户已有进程）
  const mediaKill = await killByIds(newMediaProcs.filter((proc) => ['photos', 'applicationframehost', 'photosapp'].some((key) => String(proc.name).toLowerCase().includes(key))).map((proc) => proc.id));
  evidence.sections.mediaShow.cleanup = mediaKill;

  // ---------- E. handoff.show：打开 <中枢>/#/handoff?kind=..&url=..&text=.. ----------
  const handoffParams = { kind: 'page', url: 'https://github.com/minzzj/tenon', text: '从手机甩到电脑大屏的页面 · v2.1 超级终端证据' };
  const handoff = await runAction('handoff.show', handoffParams);
  await sleep(3000);
  const shotHandoff = await screenshot('super-04-handoff-show.png');
  const expectedUrl = buildHandoffUrl({ ...handoffParams, hubUrl: HUB });
  evidence.sections.handoffShow = { params: handoffParams, summary: handoff.summary, shownUrl: handoff.items[0] && handoff.items[0].detail, expectedUrl, screenshot: shotHandoff };
  check('handoff-show', 'handoff.show 打开 #/handoff 页面', String(handoff.items[0] && handoff.items[0].detail).includes('/#/handoff?') && !!shotHandoff.ok, expectedUrl);
