// 榫卯 Tenon 节点 · 能力插件（image.crop / file.hash / file.delete / printer.mock）
// 每个能力：{ id, name, risk, manualOnly, version, evidence, inputs, outputs, async run(task, ctx) }
// run 返回 { summary, items:[{name,ok,detail}], partial }；出错直接 throw（agent 会上报 task.failed）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PngError, decodePng, encodePng, cropCenter } from './lib/png.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const CAPABILITY_VERSION = '0.1.0';

function repoRootOf(ctx) {
  return ctx && ctx.repoRoot ? path.resolve(ctx.repoRoot) : REPO_ROOT;
}

function dataDirOf(ctx) {
  return ctx && ctx.dataDir ? path.resolve(ctx.dataDir) : path.join(repoRootOf(ctx), 'data');
}

// 契约约定的参数路径都是「相对仓库根」；绝对路径原样使用
function resolveFromRoot(value, ctx) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('路径参数为空');
  return path.resolve(repoRootOf(ctx), raw);
}

function displayPath(target, ctx) {
  const rel = path.relative(repoRootOf(ctx), target);
  return rel && !rel.startsWith('..') ? rel : target;
}

function paramsOf(task) {
  if (task && task.params && typeof task.params === 'object') return task.params;
  if (task && task.draft && task.draft.params && typeof task.draft.params === 'object') return task.draft.params;
  return {};
}

async function step(ctx, label, detail) {
  if (ctx && typeof ctx.step === 'function') {
    try {
      await ctx.step(label, detail);
    } catch {
      // 进度上报失败不应影响能力执行
    }
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function stamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function humanTime(date = new Date()) {
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  return `${day} ${clock}`;
}

function classifyCropError(err) {
  if (err instanceof PngError || (err && err.name === 'PngError')) {
    return err.code === 'UNSUPPORTED' ? '格式不支持' : '文件损坏';
  }
  if (err && err.code === 'ENOENT') return '文件不存在';
  if (err && err.code === 'EACCES') return '无读取权限';
  return '处理失败';
}

// ---------- 能力 1：image.crop ----------
async function runImageCrop(task, ctx) {
  const params = paramsOf(task);
  const size = Number(params.size);
  if (!Number.isInteger(size) || size < 1 || size > 8192) throw new Error(`裁剪尺寸不合法：${params.size}`);
  const srcDir = resolveFromRoot(params.srcDir || '示例空间/样品图', ctx);
  const outDir = resolveFromRoot(params.outDir || '示例空间/输出/方图', ctx);
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) throw new Error(`源目录不存在：${displayPath(srcDir, ctx)}`);
  if (path.resolve(outDir) === path.resolve(srcDir)) throw new Error('输出目录不能与源目录相同（避免覆盖原图）');
  const files = fs
    .readdirSync(srcDir)
    .filter((name) => /\.png$/i.test(name))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  await step(ctx, '扫描源目录', `发现 ${files.length} 个 PNG 文件`);
  fs.mkdirSync(outDir, { recursive: true });
  const items = [];
  const reasons = [];
  let okCount = 0;
  let failCount = 0;
  for (const name of files) {
    try {
      const decoded = decodePng(fs.readFileSync(path.join(srcDir, name)));
      const cropped = cropCenter(decoded, size);
      fs.writeFileSync(path.join(outDir, name), encodePng(cropped));
      okCount += 1;
      items.push({ name, ok: true, detail: `已居中裁剪为 ${size}×${size}` });
    } catch (err) {
      const reason = classifyCropError(err);
      failCount += 1;
      if (!reasons.includes(reason)) reasons.push(reason);
      items.push({ name, ok: false, detail: reason });
    }
  }
  if (files.length && okCount === 0) throw new Error(`全部裁剪失败：${reasons.join('、')}`);
  if (failCount > 0) {
    return {
      summary: `${okCount} 张成功，${failCount} 张失败：${reasons.join('、')}`,
      items,
      partial: true,
    };
  }
  const summary = files.length ? `${okCount} 张成功` : '0 张成功：源目录下没有 .png 文件';
  return { summary, items, partial: false };
}

// ---------- 能力 2：file.hash ----------
async function runFileHash(task, ctx) {
  const params = paramsOf(task);
  if (!params.path) throw new Error('缺少参数 path');
  const target = resolveFromRoot(params.path, ctx);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`文件不存在：${displayPath(target, ctx)}`);
  }
  if (!stat.isFile()) throw new Error(`不是普通文件：${displayPath(target, ctx)}`);
  await step(ctx, '读取文件', `${displayPath(target, ctx)}（${stat.size} 字节）`);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(target);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const digest = hash.digest('hex');
  const label = displayPath(target, ctx);
  return {
    summary: `${label} 的 SHA-256 是 ${digest}`,
    items: [{ name: label, ok: true, detail: digest }],
    partial: false,
  };
}

// ---------- 能力 3：file.delete（不可逆，真删） ----------
async function runFileDelete(task, ctx) {
  const params = paramsOf(task);
  if (!params.target) throw new Error('缺少参数 target');
  const target = resolveFromRoot(params.target, ctx);
  const root = repoRootOf(ctx);
  if (path.resolve(target) === path.resolve(root)) throw new Error('拒绝删除仓库根目录');
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    throw new Error(`文件不存在：${displayPath(target, ctx)}`);
  }
  if (stat.isDirectory()) throw new Error(`暂不支持删除目录：${displayPath(target, ctx)}`);
  const label = displayPath(target, ctx);
  const size = stat.size;
  await step(ctx, '确认目标文件', `${label}（${size} 字节），删除后不可撤销`);
  fs.rmSync(target, { force: false });
  if (fs.existsSync(target)) throw new Error(`删除失败：${label}`);
  return {
    summary: `已永久删除 ${label}（${size} 字节，不可撤销）`,
    items: [{ name: label, ok: true, detail: `已删除 ${size} 字节，不可恢复` }],
    partial: false,
  };
}

// ---------- 能力 4：printer.mock（模拟打印，写本地 outbox） ----------
async function runPrinterMock(task, ctx) {
  const params = paramsOf(task);
  if (!params.file) throw new Error('缺少参数 file');
  const copies = params.copies === undefined || params.copies === null ? 1 : Number(params.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > 99) throw new Error(`份数不合法：${params.copies}`);
  const outbox = path.join(dataDirOf(ctx), 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  const now = new Date();
  let outFile = path.join(outbox, `打印-${stamp(now)}.txt`);
  for (let i = 2; fs.existsSync(outFile); i += 1) {
    outFile = path.join(outbox, `打印-${stamp(now)}-${i}.txt`);
  }
  const fileLabel = String(params.file);
  const nodeName = (ctx && ctx.nodeName) || '工作台';
  const taskId = (task && (task.id || task.taskId)) || '未知任务';
  const lines = [
    '榫卯 Tenon · 模拟打印单',
    '==============================',
    `时间：${humanTime(now)}`,
    `节点：${nodeName}`,
    `文件：${fileLabel}`,
    `份数：${copies}`,
    `任务：${taskId}`,
    '说明：本文件由节点模拟生成，未连接真实打印机；保留它是为了审计与演示。',
    '',
  ];
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  await step(ctx, '写入模拟打印单', displayPath(outFile, ctx));
  return {
    summary: `已模拟打印 ${copies} 份：${fileLabel}（未连接真实打印机）`,
    items: Array.from({ length: copies }, (_, i) => ({
      name: `第 ${i + 1} 份`,
      ok: true,
      detail: `${fileLabel} → ${displayPath(outFile, ctx)}`,
    })),
    partial: false,
  };
}

export const capabilities = [
  {
    id: 'image.crop',
    name: '图片居中裁剪',
    risk: 'reversible',
    manualOnly: false,
    version: CAPABILITY_VERSION,
    evidence: 'confirmed',
    inputs: ['srcDir（源目录，相对仓库根）', 'outDir（输出目录，相对仓库根）', 'size（输出边长 px）'],
    outputs: ['outDir 下同名 size×size PNG 文件'],
    run: runImageCrop,
  },
  {
    id: 'file.hash',
    name: '文件 SHA-256 校验',
    risk: 'reversible',
    manualOnly: false,
    version: CAPABILITY_VERSION,
    evidence: 'confirmed',
    inputs: ['path（文件路径，相对仓库根）'],
    outputs: ['sha256 摘要'],
    run: runFileHash,
  },
  {
    id: 'file.delete',
    name: '删除文件',
    risk: 'irreversible',
    manualOnly: false,
    version: CAPABILITY_VERSION,
    evidence: 'confirmed',
    inputs: ['target（要删除的文件，相对仓库根）'],
    outputs: ['文件被永久删除（不可恢复）'],
    run: runFileDelete,
  },
  {
    id: 'printer.mock',
    name: '模拟打印',
    risk: 'irreversible',
    manualOnly: false,
    version: CAPABILITY_VERSION,
    evidence: 'confirmed',
    inputs: ['file（打印文件标识）', 'copies（份数，1-99）'],
    outputs: ['data/outbox/打印-<时间>.txt'],
    run: runPrinterMock,
  },
];

function manifestOf(cap) {
  const out = {
    id: cap.id,
    name: cap.name,
    risk: cap.risk,
    manualOnly: !!cap.manualOnly,
    version: cap.version,
    evidence: cap.evidence,
    inputs: cap.inputs,
    outputs: cap.outputs,
  };
  if (cap.authExpiresAt) out.authExpiresAt = cap.authExpiresAt;
  return out;
}

// 注册时上报给中枢的能力清单（契约 §6 的 manifest 字段，不含 run）
export const manifest = capabilities.map(manifestOf);

export function findCapability(id) {
  return capabilities.find((cap) => cap.id === id) || null;
}

export async function executeCapability(task, ctx) {
  const capabilityId = (task && (task.capabilityId || task.capability)) || null;
  const cap = findCapability(capabilityId);
  if (!cap) throw new Error(`节点不支持该能力：${capabilityId || '未知'}`);
  return cap.run(task, ctx);
}

export default { REPO_ROOT, CAPABILITY_VERSION, capabilities, manifest, findCapability, executeCapability };
