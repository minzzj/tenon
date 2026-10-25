#!/usr/bin/env node
/**
 * 榫卯 Tenon v2.2 · Windows 节点一键安装包生成器（Round 1，零依赖）
 *
 * 用法：
 *   node scripts/build-install-package.js [--hub-url http://192.168.1.10:7410] [--data-dir data]
 *                                        [--out public/download/tenon-node-win.zip] [--version 0.2.0]
 *
 * 产物：
 *   public/download/tenon-node-win.zip   安装包（node-agent/ + install-node.ps1 + 启动节点.cmd + 卸载节点.cmd + README.txt + install-meta.json）
 *   public/download/install-meta.json    不含令牌的公开元信息（供设备页展示大小/版本/中枢地址）
 *
 * 说明：安装包内嵌当前中枢 LAN 地址与节点令牌（本机私用演示），README 内注明「勿外传」；仅在本机生成。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { hubUrl: '', dataDir: path.join(ROOT, 'data'), out: '', version: '', quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--hub-url') { out.hubUrl = next || ''; i += 1; }
    else if (a === '--data-dir') { out.dataDir = next || ''; i += 1; }
    else if (a === '--out') { out.out = next || ''; i += 1; }
    else if (a === '--version') { out.version = next || ''; i += 1; }
    else if (a === '--quiet') out.quiet = true;
    else throw new Error('未知参数：' + a);
  }
  return out;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function localIPv4() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) candidates.push({ name, address: item.address, netmask: item.netmask });
    }
  }
  const virtual = /(vmware|virtualbox|vbox|vethernet|hyper-v|wsl|docker|loopback|bluetooth|tap|tun|npcap|zerotier|tailscale)/i;
  const score = (c) => {
    let s = 0;
    if (virtual.test(c.name)) s -= 100;
    if (/^192\.168\./.test(c.address)) s += 20;
    if (/^10\./.test(c.address)) s += 10;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(c.address)) s += 5;
    if (/\.1$/.test(c.address)) s -= 3; // 常见虚拟网卡网关地址
    if (c.netmask === '255.255.255.0') s += 2;
    return s;
  };
  candidates.sort((a, b) => score(b) - score(a));
  return candidates.length ? candidates[0].address : '127.0.0.1';
}

function pkgVersion() {
  return (readJson(path.join(ROOT, 'package.json'), {}) || {}).version || '0.0.0';
}

// ---------------- 最小 ZIP 写入器（store，无压缩；UTF-8 文件名；CRC32） ----------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const day = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, day };
}

/**
 * @param {Array<{name:string,data:Buffer,mtime?:Date}>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const { time, day } = dosDateTime(entry.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// ---------------- 收集 node-agent 文件（排除 node_modules / data / __tests__/evidence） ----------------
function collectFiles(dir, base = dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (item.name === 'node_modules') continue;
    if (item.name === 'data') continue;
    // P3 修复：整个 __tests__/ 目录都不进安装包（含 evidence），瘦身并避免携带测试数据
    if (item.name === '__tests__') continue;
    if (/^__tests__\/evidence(\/|$)/.test(rel)) continue;
    if (item.isDirectory()) collectFiles(full, base, out);
    else if (item.isFile()) out.push({ rel, full });
  }
  return out;
}
// ---------------- 包内文本文件模板 ----------------
const LAUNCH_CMD = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'cd /d "%~dp0"',
  'if not exist "config.json" (',
  '  echo [Tenon] config.json not found. Run install-node.ps1 first.',
  '  pause',
  '  exit /b 1',
  ')',
  'echo [Tenon] starting node agent...',
  'node -e "var fs=require(\'fs\'),path=require(\'path\'),cp=require(\'child_process\');var c=JSON.parse(fs.readFileSync(\'config.json\',\'utf8\'));var env=Object.assign({},process.env,{TENON_HUB_URL:c.hubUrl,TENON_NODE_TOKEN:c.nodeToken,TENON_NODE_ID:c.nodeId,TENON_DATA_DIR:c.dataDir?c.dataDir:path.join(process.cwd(),\'data\')});cp.spawn(process.execPath,[path.join(process.cwd(),\'node-agent\',\'agent.js\')],{env:env,stdio:\'inherit\'}).on(\'exit\',function(code){process.exit(code===null?1:code);});"',
  'echo [Tenon] node agent exited.',
  'pause',
  '',
].join('\r\n');

const UNINSTALL_CMD = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-node.ps1" -Uninstall',
  'pause',
  '',
].join('\r\n');

function readmeText(meta) {
  return [
    '榫卯 Tenon · Windows 节点安装包（v' + meta.version + '）',
    '生成时间：' + meta.createdAt,
    '内置中枢地址：' + meta.hubUrl,
    '',
    '三步安装：',
    '1) 把本压缩包解压到任意目录（例如 D:\\Tenon\\install）。',
    '2) 右键 install-node.ps1 → 使用 PowerShell 运行；或在解压目录执行：',
    '   powershell -ExecutionPolicy Bypass -File .\\install-node.ps1',
    '   脚本会写入中枢地址与节点令牌、创建登录自启计划任务 TenonNode，并隐藏启动节点；',
    '   安装目录默认 %LOCALAPPDATA%\\Tenon\\node，可用 -InstallDir 指定。',
    '3) 回到榫卯网页「我的设备」→ 刷新 → 点「一键绑定」，即加入你的超级终端。',
    '',
    '常用参数：',
    '  -HubUrl http://<中枢IP>:<端口>   指定中枢地址（默认使用包内 install-meta.json 的内置地址）',
    '  -InstallDir <目录>               自定义安装目录',
    '  -NoStartup                       不创建登录自启（测试用；仍会启动一次节点）',
    '  -Uninstall                       一键卸载（停止进程、删除计划任务、删除安装目录）',
    '',
    '一键卸载：双击「卸载节点.cmd」，或 powershell -ExecutionPolicy Bypass -File .\\install-node.ps1 -Uninstall',
    '',
    '环境要求：Windows 10/11 + Node.js 22 及以上（https://nodejs.org/）。',
    '安全提示：安装包内嵌本机节点令牌（nodeToken），仅用于本机/局域网私有演示，请勿外传或上传公网。',
    '',
  ].join('\r\n');
}

function withBom(text) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(String(text), 'utf8')]);
}

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------------- main ----------------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(args.dataDir || path.join(ROOT, 'data'));
  const secrets = readJson(path.join(dataDir, 'secrets.json'), null) || {};
  const nodeToken = process.env.TENON_NODE_TOKEN || secrets.nodeToken || '';
  if (!nodeToken) {
    console.error('找不到节点令牌：请先启动一次中枢（生成 data/secrets.json），或用 TENON_NODE_TOKEN 指定');
    return 2;
  }
  let hubUrl = args.hubUrl || process.env.TENON_HUB_URL || '';
  if (!hubUrl) {
    const port = Number(process.env.TENON_PORT || 7410);
    hubUrl = 'http://' + localIPv4() + ':' + port;
  }
  if (!/^https?:\/\//.test(hubUrl)) {
    console.error('hubUrl 不合法（需 http:// 或 https://）：' + hubUrl);
    return 2;
  }
  const version = args.version || pkgVersion();
  const createdAt = new Date().toISOString();
  const outFile = path.resolve(args.out || path.join(ROOT, 'public', 'download', 'tenon-node-win.zip'));
  const sidecarFile = path.join(path.dirname(outFile), 'install-meta.json');
  const installMeta = { version, createdAt, hubUrl, nodeToken, generator: 'tenon-build-install-package', node: process.version };

  const agentDir = path.join(ROOT, 'node-agent');
  if (!fs.existsSync(agentDir)) {
    console.error('找不到 node-agent/ 目录');
    return 2;
  }
  const agentFiles = collectFiles(agentDir);
  const installScriptSrc = path.join(ROOT, 'scripts', 'install-node.ps1');
  if (!fs.existsSync(installScriptSrc)) {
    console.error('找不到 scripts/install-node.ps1');
    return 2;
  }
  const installBufRaw = fs.readFileSync(installScriptSrc);
  const installBuf = installBufRaw.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? installBufRaw
    : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), installBufRaw]);

  const entries = [];
  for (const file of agentFiles) {
    entries.push({ name: 'node-agent/' + file.rel, data: fs.readFileSync(file.full), mtime: fs.statSync(file.full).mtime });
  }
  entries.push({ name: 'install-node.ps1', data: installBuf, mtime: new Date() });
  entries.push({ name: '启动节点.cmd', data: Buffer.from(LAUNCH_CMD, 'utf8'), mtime: new Date() });
  entries.push({ name: '卸载节点.cmd', data: Buffer.from(UNINSTALL_CMD, 'utf8'), mtime: new Date() });
  entries.push({ name: 'README.txt', data: withBom(readmeText(installMeta)), mtime: new Date() });
  entries.push({ name: 'install-meta.json', data: Buffer.from(JSON.stringify(installMeta, null, 2), 'utf8'), mtime: new Date() });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const zip = buildZip(entries);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, zip);
  const sidecar = {
    version,
    createdAt,
    fileName: path.basename(outFile),
    sizeBytes: zip.length,
    hubUrl,
    nodeAgentFiles: agentFiles.length,
    packageFiles: entries.length,
    note: '不含令牌的公开元信息；安装包本身才会内嵌 nodeToken',
  };
  fs.writeFileSync(sidecarFile, JSON.stringify(sidecar, null, 2), 'utf8');

  if (!args.quiet) {
    console.log('[build-install-package] 中枢地址：' + hubUrl);
    console.log('[build-install-package] node-agent 文件 ' + agentFiles.length + ' 个，包内文件 ' + entries.length + ' 个');
    console.log('[build-install-package] 安装包：' + outFile + '（' + humanBytes(zip.length) + '）');
    console.log('[build-install-package] 公开元信息：' + sidecarFile);
    console.log('[build-install-package] 安全提示：安装包内嵌节点令牌，仅供本机/局域网使用，勿外传');
  }
  console.log('BUILD_RESULT ' + JSON.stringify({
    ok: true,
    outFile,
    sidecarFile,
    sizeBytes: zip.length,
    version,
    hubUrl,
    nodeAgentFiles: agentFiles.length,
    packageFiles: entries.length,
  }));
  return 0;
}

process.exitCode = main();