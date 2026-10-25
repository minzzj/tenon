// 榫卯 v2 · PowerShell 桥（Windows 剪贴板/通知/动作共用）
// 用 -EncodedCommand（UTF-16LE base64）传脚本，彻底避开中文/引号/编码问题；
// 脚本结果通过临时 JSON 文件回传（UTF-8 无 BOM），stdout 只做兜底。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export function isWindows(platform = process.platform) {
  return platform === 'win32';
}

export function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

export function runPowerShell(script, { timeoutMs = 20000, powershellPath } = {}) {
  const exe = powershellPath || process.env.TENON_POWERSHELL || 'powershell.exe';
  const encoded = encodeCommand(script);
  return new Promise((resolve) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut: !!(error && error.killed),
        });
      },
    );
  });
}

// 生成一次性临时目录并清理（用 try/finally 包住脚本执行）
export function makeTempDir(prefix = 'tenon-ps-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function readUtf8Json(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 常用：把一段 PowerShell 脚本包成「写结果 JSON 到文件 + 失败也落盘」的形式
// body: PowerShell 脚本正文，应把最终结果赋给 $result（hashtable 或对象）
export function wrapResultScript(body, resultFile) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$__resultFile = ${psQuote(resultFile)}`,
    'try {',
    body,
    '} catch {',
    '  $result = @{ ok = $false; error = $_.Exception.Message }',
    '}',
    '$__json = $result | ConvertTo-Json -Compress -Depth 6',
    '[System.IO.File]::WriteAllText($__resultFile, $__json, (New-Object System.Text.UTF8Encoding($false)))',
  ].join('\n');
}

export { crypto };
export default { isWindows, psQuote, runPowerShell, makeTempDir, removeTempDir, readUtf8Json, wrapResultScript };