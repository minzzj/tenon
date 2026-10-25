// 榫卯 v2 · 文件能力：扫描入库 / 打开文件 / 打开文件夹 / 打印
// 入库走中枢 v2：POST /api/v2/assets/ingest {deviceId, path}；打开类动作用 PowerShell Start-Process。
import fs from 'node:fs';
import path from 'node:path';
import { isWindows, psQuote, runPowerShell, makeTempDir, removeTempDir, readUtf8Json, wrapResultScript } from './lib/ps.js';

const KIND_MAP = [
  ['image', ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.svg']],
  ['video', ['.mp4', '.mov', '.mkv', '.avi', '.wmv', '.flv', '.webm', '.m4v']],
  ['audio', ['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.wma']],
  ['document', ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.rtf', '.csv']],
  ['archive', ['.zip', '.7z', '.rar', '.tar', '.gz', '.bz2']],
  ['code', ['.js', '.mjs', '.ts', '.py', '.java', '.kt', '.html', '.css', '.json', '.xml', '.yml', '.yaml', '.sh', '.ps1']],
];
const EXT_TO_KIND = new Map();
for (const [kind, exts] of KIND_MAP) for (const ext of exts) EXT_TO_KIND.set(ext, kind);

export function classifyFileKind(name) {
  return EXT_TO_KIND.get(path.extname(String(name || '')).toLowerCase()) || 'other';
}

function isHiddenName(name) {
  return String(name || '').startsWith('.') || /^(desktop\.ini|thumbs\.db|\$recycle\.bin)$/i.test(name);
}

// 递归扫描目录；返回文件清单（不读内容，只 stat）
export function scanDirectory(root, { recursive = true, maxFiles = 2000, includeHidden = false, extensions = null } = {}) {
  const base = path.resolve(String(root));
  const allowed = extensions ? new Set(extensions.map((e) => String(e).toLowerCase())) : null;
  const files = [];
  let truncated = false;
  const stack = [base];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    for (const entry of entries) {
      if (!includeHidden && isHiddenName(entry.name)) continue;
      const full = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      if (!stat.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (allowed && !allowed.has(ext)) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        return { root: base, files, truncated: true };
      }
      files.push({
        path: full,
        relPath: path.relative(base, full).split(path.sep).join('/'),
        name: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ext,
        kind: classifyFileKind(entry.name),
      });
    }
  }
  return { root: base, files, truncated };
}

// 批量入库：逐个 POST /api/v2/assets/ingest；中枢未就绪（404/401/连接失败）时快速失败并给可读原因
export async function ingestFiles({ hub, deviceId = 'node-local', files = [], log = console, fatalStatuses = [401, 404, 503, 0] } = {}) {
  const result = { ok: true, total: files.length, ingested: 0, failed: 0, fatal: null, items: [] };
  if (!hub || typeof hub.postJson !== 'function') {
    return { ...result, ok: false, fatal: { reason: '未配置中枢客户端' } };
  }
  for (const file of files) {
    const filePath = typeof file === 'string' ? file : file && file.path;
    if (!filePath) {
      result.failed += 1;
      result.items.push({ path: '', ok: false, error: '缺少文件路径' });
      continue;
    }
    try {
      const response = await hub.postJson('/api/v2/assets/ingest', { deviceId, path: filePath });
      const item = response && Array.isArray(response.items) ? response.items[0] : null;
      const assetId = (item && item.asset && item.asset.id)
        || (response && (response.assetId || (response.asset && response.asset.id) || response.id))
        || null;
      result.ingested += 1;
      result.items.push({ path: filePath, ok: true, assetId });
    } catch (err) {
      result.failed += 1;
      const status = err && typeof err.status === 'number' ? err.status : 0;
      result.items.push({ path: filePath, ok: false, status, error: String(err && err.message ? err.message : err) });
      if (fatalStatuses.includes(status)) {
        result.ok = false;
        result.fatal = {
          status,
          reason: status === 404
            ? '中枢素材接口 /api/v2/assets/ingest 未就绪（HTTP 404），请先启动含 assets-core 的 v2 服务'
            : `中枢素材接口不可用（${status === 0 ? '连接失败' : 'HTTP ' + status}）`,
        };
        log(`[素材] 入库中止：${result.fatal.reason}`);
        break;
      }
    }
  }
  if (result.failed > 0 && !result.fatal) result.ok = false;
  return result;
}

// 扫描 + 入库
export async function scanAndIngest({ hub, deviceId = 'node-local', dir, recursive = true, maxFiles = 500, log = console } = {}) {
  const scan = scanDirectory(dir, { recursive, maxFiles });
  const ingest = await ingestFiles({ hub, deviceId, files: scan.files, log });
  return { scan: { root: scan.root, total: scan.files.length, truncated: scan.truncated }, ingest };
}

function runPsBody(body, opts = {}) {
  const dir = makeTempDir('tenon-files-');
  const promise = (async () => {
    try {
      const resultFile = `${dir}\\result.json`;
      const script = wrapResultScript(body, resultFile);
      const run = await runPowerShell(script, { timeoutMs: opts.timeoutMs || 20000, powershellPath: opts.powershellPath });
      const parsed = readUtf8Json(resultFile);
      if (!parsed) return { ok: false, error: `PowerShell 未返回结果（exit=${run.code}）${run.stderr.slice(0, 140)}`, raw: run };
      return parsed;
    } finally {
      removeTempDir(dir);
    }
  })();
  return promise;
}

// 打开文件/文件夹/URL（受控动作：只允许存在的路径或 http(s) 链接）
export async function openPath(target, { platform = process.platform, app = null, timeoutMs = 15000 } = {}) {
  const value = String(target || '').trim();
  if (!value) return { ok: false, error: '缺少打开目标' };
  if (!isWindows(platform)) return { ok: false, unsupported: true, error: '仅 Windows 支持本机打开动作' };
  const isUrl = /^https?:\/\//i.test(value);
  if (!isUrl) {
    const abs = path.resolve(value);
    if (!fs.existsSync(abs)) return { ok: false, error: `目标不存在：${abs}` };
  }
  const body = `$target = ${psQuote(value)}
$app = ${app ? psQuote(app) : '$null'}
$result = @{ ok = $false; error = $null; kind = 'file'; target = $target }
if ($target -match '^(?i)https?://') {
  Start-Process -FilePath $target
  $result.kind = 'url'
}
elseif (Test-Path -LiteralPath $target) {
  $item = Get-Item -LiteralPath $target -Force
  if ($app) {
    Start-Process -FilePath $app -ArgumentList ('"' + $target + '"')
    $result.kind = 'with-app'
  }
  elseif ($item.PSIsContainer) {
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $target + '"')
    $result.kind = 'folder'
  }
  else {
    Start-Process -FilePath $target
    $result.kind = 'file'
  }
}
else { throw ('目标不存在：' + $target) }
$result.ok = $true`;
  return runPsBody(body, { timeoutMs });
}

export async function openFolder(target, opts = {}) {
  const value = String(target || '').trim();
  if (!value) return { ok: false, error: '缺少文件夹路径' };
  return openPath(value, opts);
}

// 打开文件所在文件夹并选中它（Windows explorer /select）
export async function revealInFolder(target, { platform = process.platform, timeoutMs = 15000 } = {}) {
  const abs = path.resolve(String(target || ''));
  if (!fs.existsSync(abs)) return { ok: false, error: `目标不存在：${abs}` };
  if (!isWindows(platform)) return { ok: false, unsupported: true, error: '仅 Windows 支持' };
  const body = `$target = ${psQuote(abs)}
$result = @{ ok = $false; error = $null }
if (-not (Test-Path -LiteralPath $target)) { throw ('目标不存在：' + $target) }
Start-Process -FilePath 'explorer.exe' -ArgumentList ('/select,"' + $target + '"')
$result.ok = $true`;
  return runPsBody(body, { timeoutMs });
}

// 真实打印：调用 Windows 外壳的 Print 动词（等同于右键→打印）；返回是否成功发起打印任务
export async function printFile(target, { copies = 1, platform = process.platform, timeoutMs = 30000 } = {}) {
  const abs = path.resolve(String(target || ''));
  const count = Number(copies) || 1;
  if (!fs.existsSync(abs)) return { ok: false, error: `文件不存在：${abs}` };
  if (!isWindows(platform)) return { ok: false, unsupported: true, error: '仅 Windows 支持本机打印' };
  const body = `$target = ${psQuote(abs)}
$copies = ${Math.max(1, Math.min(99, Math.floor(count)))}
$result = @{ ok = $false; error = $null; jobs = @(); target = $target; copies = $copies }
for ($i = 0; $i -lt $copies; $i++) {
  try {
    Start-Process -FilePath $target -Verb Print -ErrorAction Stop
    $result.jobs += @{ ok = $true; index = $i + 1 }
  } catch {
    $result.jobs += @{ ok = $false; index = $i + 1; error = $_.Exception.Message }
  }
}
$okCount = @($result.jobs | Where-Object { $_.ok }).Count
if ($okCount -eq 0) { throw ($result.jobs[0].error) }
$result.ok = $true`;
  return runPsBody(body, { timeoutMs });
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default { classifyFileKind, scanDirectory, ingestFiles, scanAndIngest, openPath, openFolder, revealInFolder, printFile, formatBytes };