#!/usr/bin/env node
/**
 * 榫卯 Tenon v0.1 · 演示种子数据生成器
 *
 * 用法：node scripts/seed-demo.js --fresh [--data-dir <dir>]
 *
 * 原则：
 * - 事件类型与字段以 server/lib/state.js 的 apply() 为唯一事实来源；
 * - 通过 Ledger 写入 data/events.jsonl（哈希链 = sha256(seq|at|type|actor|stable(data)|prev)）；
 * - 为了让「95 天前的定时任务」「上周打印成功」等历史在重放后成立，事件时间由虚拟时间轴给出，
 *   哈希仍用 ledger.js 的 hashOf 计算，最终以重新加载的 Ledger + replay 自检；
 * - 体检必须是真实 runCheckup() 产物（用临时 Ledger 跑，取回结果后按虚拟时间写回主账本）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger, hashOf } from '../server/lib/ledger.js';
import { replay, impact } from '../server/lib/state.js';
import { runCheckup } from '../server/lib/checkup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
const MIN = 60000;
const NOW = Date.now();

function parseArgs(argv) {
  const out = { fresh: false, dataDir: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--fresh') out.fresh = true;
    else if (a === '--data-dir') out.dataDir = argv[i + 1], (i += 1);
    else if (a.startsWith('--data-dir=')) out.dataDir = a.slice('--data-dir='.length);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('未知参数：' + a);
  }
  return out;
}

/** 虚拟时间轴：m 分钟前（负数=未来） */
const atMin = (m) => new Date(NOW + m * MIN).toISOString();
/** 虚拟时间轴：d 天前再加 m 分钟（m 可以为负） */
const atDay = (d, m = 0) => atMin(-d * 1440 + m);

/** 在 Ledger 之上追加一条指定 at 的事件（哈希链与 Ledger.append 完全一致） */
function appendAt(ledger, type, data, at, actor = 'hub') {
  const ev = { seq: ledger.lastSeq + 1, at, type, actor, data };
  ev.prev = ledger.lastHash;
  ev.hash = hashOf(ev);
  fs.appendFileSync(ledger.file, JSON.stringify(ev) + '\n', 'utf8');
  ledger.events.push(ev);
  ledger.lastSeq = ev.seq;
  ledger.lastHash = ev.hash;
  for (const fn of ledger.subscribers) fn(ev);
  return ev;
}

/** 用真实 runCheckup 跑一次体检，返回结果（写临时 Ledger，不污染主账本的时间轴） */
function realCheckup(ledger, scope, at) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenon-seed-chk-'));
  try {
    const tmpLedger = new Ledger(tmpDir);
    const result = runCheckup({
      ledger: tmpLedger,
      state: replay(ledger.events),
      scope,
      integrity: ledger.integrity(),
      aiAvailable: false,
      mode: 'solo',
      now: new Date(at).getTime(),
    });
    return result;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
// ---------- 固定 id（种子可复现，方便验收脚本与截图引用） ----------
const HUB = 'hub';
const LOCAL = 'node-local';
const PRINTER = 'dev-printer';
const NAS = 'dev-nas';
const LLM = 'dev-llm';
const SCANNER = 'node-scanner';

const capRef = (id, name, manualOnly = false) => ({ id, name, manualOnly });
const devRef = (id, name) => ({ id, name });
function draftOf({ summary, caps = [], target = null, missing = [], risk = { level: 'reversible', reasons: [] }, params = {} }) {
  return { summary, capabilities: caps, targetDevice: target, missing, risk, params };
}

// 设备/能力登记：node.registered = 真实自动发现（evidence=confirmed）；device.imported = 声明式导入（evidence=declared）
// 与 server/start.js 里中枢自注册的能力字段保持一致（种子已含 hub 节点，服务启动时不会重复注册）
const HUB_CAPS = [
  { id: 'channel.notify', name: '发送消息（摘要+链接）', risk: 'irreversible', manualOnly: false, version: '1.0.0', evidence: '通道回执与留痕' },
  { id: 'llm.summarize', name: '模型摘要', risk: 'reversible', manualOnly: false, version: '1.0.0', evidence: '调用记录 + token 用量' },
];
// 与 node-agent/capabilities.js 的 manifest 保持一致：真实节点启动后会用同样的 id/字段再注册一次
const LOCAL_CAPS = [
  { id: 'image.crop', name: '图片居中裁剪', risk: 'reversible', manualOnly: false, version: '0.1.0', evidence: 'confirmed' },
  { id: 'file.hash', name: '文件 SHA-256 校验', risk: 'reversible', manualOnly: false, version: '0.1.0', evidence: 'confirmed' },
  { id: 'file.delete', name: '删除文件', risk: 'irreversible', manualOnly: false, version: '0.1.0', evidence: 'confirmed' },
  { id: 'printer.mock', name: '模拟打印', risk: 'irreversible', manualOnly: false, version: '0.1.0', evidence: 'confirmed' },
];
const PRINTER_CAPS = [
  // 授权 3 天后到期（体检应出「授权将在 3 天后到期」notice）
  { id: 'printer.mock', name: '打印', risk: 'irreversible', manualOnly: false, version: '2.0.0', evidence: 'confirmed', authExpiresAt: atDay(-3) },
  { id: 'file.hash', name: '文件扫描', risk: 'reversible', manualOnly: false, version: '2.0.0', evidence: 'confirmed' },
];
const NAS_CAPS = [
  // 授权已过期 5 天（体检应出「授权已过期」warning）
  { id: 'nas.sync', name: 'NAS 归档同步', risk: 'reversible', manualOnly: false, version: '7.2', evidence: 'declared', authExpiresAt: atDay(5) },
  // NAS 自带的转码能力没有公开入口 → 登记为「仅手动」（放在 imported 设备上，不会被真实节点注册覆盖）
  { id: 'video.transcode', name: '视频转码（仅手动）', risk: 'reversible', manualOnly: true, version: '1.0.0', evidence: 'declared' },
];
const LLM_CAPS = [
  { id: 'llm.summarize', name: '本地摘要模型', risk: 'reversible', manualOnly: false, version: '2.1', evidence: 'declared' },
];
const SCANNER_CAPS = [
  { id: 'file.hash', name: '扫描', risk: 'reversible', manualOnly: false, version: '1.2', evidence: 'confirmed' },
];

function buildTimeline(ledger) {
  // ===== 设备与能力（100 天前首次发现 / 导入）=====
  appendAt(ledger, 'node.registered', {
    nodeId: HUB, name: '本机中枢', platform: 'windows', fingerprint: 'fp-hub-9c01', domain: 'studio', capabilities: HUB_CAPS,
  }, atDay(100, 0));
  appendAt(ledger, 'node.registered', {
    nodeId: LOCAL, name: '工作台', platform: 'win32-x64', fingerprint: 'fp-local-a3f2', capabilities: LOCAL_CAPS,
  }, atDay(100, 2), 'node-agent');
  appendAt(ledger, 'node.registered', {
    nodeId: PRINTER, name: '打印服务器', platform: 'printer', fingerprint: 'fp-printer-77e1', capabilities: PRINTER_CAPS,
  }, atDay(100, 4));
  appendAt(ledger, 'device.imported', {
    nodeId: NAS, name: '群晖 NAS', platform: 'nas', fingerprint: 'fp-nas-192d', domain: 'outside', online: true, capabilities: NAS_CAPS,
  }, atDay(100, 6));
  appendAt(ledger, 'device.imported', {
    nodeId: LLM, name: '本地模型', platform: 'llm', fingerprint: 'fp-llm-2b71', online: true, capabilities: LLM_CAPS,
  }, atDay(100, 8));
  appendAt(ledger, 'capability.versionMismatch', {
    nodeId: LLM, capabilityId: 'llm.summarize', required: '2.3', current: '2.1',
  }, atDay(100, 9));

  // ===== ⑨ 三个月未触发的定时任务（draft，createdAt 早于 90 天）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_09',
    text: '每月 1 号把上月素材归档到 NAS（定时任务）',
    source: 'desktop',
    requester: '你',
    evidenceLevel: 'possible',
    draft: draftOf({
      summary: '定时任务：把上月素材归档到 群晖 NAS 的「NAS 归档同步」',
      caps: [capRef('nas.sync', 'NAS 归档同步')],
      target: devRef(NAS, '群晖 NAS'),
      missing: ['定时计划未启用：已 95 天未触发'],
      risk: { level: 'reversible', reasons: [] },
      params: { cron: '0 3 1 * *', target: 'NAS:/archive/monthly' },
    }),
  }, atDay(95, 0));

  // ===== 旧扫描仪：零引用设备（影响预览「未知」边界：无任务引用，仅可人工确认）=====
  appendAt(ledger, 'node.registered', {
    nodeId: SCANNER, name: '旧扫描仪', platform: 'scanner', fingerprint: 'fp-scanner-51c8', capabilities: SCANNER_CAPS,
  }, atDay(90, 0));
  appendAt(ledger, 'node.offline', { nodeId: SCANNER, since: atDay(90, 5) }, atDay(90, 5));

  // ===== ③ NAS 归档 2025 素材（成功，引用 NAS，有回传：微信限流 → 降级邮件）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_03',
    text: '把 2025 素材归档到 NAS',
    source: 'desktop',
    requester: '你',
    evidenceLevel: 'possible',
    draft: draftOf({
      summary: '把 2025 素材归档到 群晖 NAS 的「NAS 归档同步」',
      caps: [capRef('nas.sync', 'NAS 归档同步')],
      target: devRef(NAS, '群晖 NAS'),
      risk: { level: 'reversible', reasons: [] },
      params: { srcDir: '示例空间/2025素材', target: 'NAS:/archive/2025' },
    }),
  }, atDay(42, 0));
  appendAt(ledger, 'task.queued', { taskId: 'seed_task_03', nodeId: NAS, note: '可逆动作免确认，直接派发' }, atDay(42, 10));
  appendAt(ledger, 'task.started', { taskId: 'seed_task_03', nodeId: NAS, nodeName: '群晖 NAS' }, atDay(42, 20));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_03', label: '连接 NAS', detail: '域外设备 · 只读挂载' }, atDay(42, 24));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_03', label: '校验指纹', detail: '逐文件计算 sha256（128 个）' }, atDay(42, 30));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_03', label: '归档', detail: '写入 NAS:/archive/2025' }, atDay(42, 35));
  appendAt(ledger, 'task.succeeded', {
    taskId: 'seed_task_03',
    result: {
      summary: '已归档 128 个文件到 NAS:/archive/2025（模拟同步）',
      items: [{ name: '2025素材', ok: true, detail: '128 个文件 / 4.2 GB' }],
      partial: false,
    },
  }, atDay(42, 40));

  // ===== 体检①：scope=channels，此时通道状态干净 → 真实 runCheckup 产出「未发现问题」=====
  const channelsCheckup = realCheckup(ledger, 'channels', atDay(41, 0));
  appendAt(ledger, 'checkup.ran', {
    checkupId: channelsCheckup.checkupId,
    scope: 'channels',
    findings: channelsCheckup.findings,
    verdict: channelsCheckup.verdict,
    checked: channelsCheckup.checked,
    items: channelsCheckup.items,
    summary: channelsCheckup.summary,
  }, atDay(41, 0));

  // ===== ③ 的回传：微信限流 → 排队重试 → 降级邮件（message.inbox #1）=====
  appendAt(ledger, 'task.deliveryAttempt', { taskId: 'seed_task_03', channel: 'wechat-mock', status: 'limited', reason: '限流' }, atDay(40, 0));
  appendAt(ledger, 'channel.retry', { taskId: 'seed_task_03', channel: 'wechat-mock', attempt: 1, reason: '微信限流，排队重试' }, atDay(40, 1));
  appendAt(ledger, 'task.deliveryAttempt', { taskId: 'seed_task_03', channel: 'wechat-mock', status: 'fallback', reason: '微信限流，已改邮件，延迟约 10 分钟' }, atDay(40, 11));
  appendAt(ledger, 'task.deliveryAttempt', { taskId: 'seed_task_03', channel: 'email-mock', status: 'delivered', latencyMs: 812 }, atDay(40, 12));
  appendAt(ledger, 'message.inbox', {
    messageId: 'msg_seed_01', taskId: 'seed_task_03', channel: 'email-mock', channelLabel: '邮件（模拟通道）',
    title: '任务回执（已降级）', summary: '已归档 128 个文件到 NAS:/archive/2025（模拟同步）',
    link: '/r/seed_task_03', status: 'delivered', sensitive: true,
  }, atDay(40, 12));
  appendAt(ledger, 'task.delivered', {
    taskId: 'seed_task_03', channel: 'email-mock', messageId: 'msg_seed_01',
    summary: '已归档 128 个文件到 NAS:/archive/2025（模拟同步）', link: '/r/seed_task_03',
    latencyMs: 812, status: 'degraded', note: '微信限流，已改邮件，延迟约 10 分钟',
  }, atDay(40, 12));

  // ===== ① 样品图裁方图（成功：9 成功 1 失败「文件损坏」；本机工作台执行）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_01',
    text: '把昨天的样品图裁成方图（1024）',
    source: 'phone',
    requester: '你',
    evidenceLevel: 'certain',
    draft: draftOf({
      summary: '把「把昨天的样品图裁成方图（1024）」交给 本机工作台 的「裁方图」',
      caps: [capRef('image.crop', '裁方图')],
      target: devRef(LOCAL, '本机工作台'),
      risk: { level: 'reversible', reasons: [] },
      params: { size: 1024, srcDir: '示例空间/样品图', outDir: '示例空间/输出/方图' },
    }),
  }, atDay(20, 0), 'phone');
  appendAt(ledger, 'ai.called', {
    place: 'draft', provider: 'rule', model: 'rule', tokensIn: 0, tokensOut: 0, cached: false, fallback: true,
  }, atDay(20, 1));
  appendAt(ledger, 'task.queued', { taskId: 'seed_task_01', nodeId: LOCAL, note: '可逆动作免确认，直接派发' }, atDay(20, 2));
  appendAt(ledger, 'task.started', { taskId: 'seed_task_01', nodeId: LOCAL, nodeName: '本机工作台' }, atDay(20, 3));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_01', label: '扫描源目录', detail: '发现 10 个 PNG 文件（含 1 个 0 字节）' }, atDay(20, 4));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_01', label: '逐张裁剪', detail: '居中裁成 1024×1024（不足补边）' }, atDay(20, 6));
  appendAt(ledger, 'task.succeeded', {
    taskId: 'seed_task_01',
    result: {
      summary: '9 张成功，1 张失败：文件损坏',
      items: [
        { name: '样品01.png', ok: true, detail: '640×480 → 1024×1024' },
        { name: '样品02.png', ok: true, detail: '800×600 → 1024×1024' },
        { name: '样品03.png', ok: true, detail: '1024×768 → 1024×1024' },
        { name: '样品04.png', ok: true, detail: '500×500 → 1024×1024' },
        { name: '样品05.png', ok: true, detail: '1200×900 → 1024×1024' },
        { name: '样品06.png', ok: true, detail: '320×240 → 1024×1024' },
        { name: '样品07.png', ok: true, detail: '960×540 → 1024×1024' },
        { name: '样品08.png', ok: true, detail: '700×500 → 1024×1024' },
        { name: '样品09.png', ok: true, detail: '2000×1200 → 1024×1024' },
        { name: '样品10.png', ok: false, detail: '文件损坏' },
      ],
      partial: true,
    },
  }, atDay(20, 10), 'node-agent');
  // ===== ④ 本地模型总结周报（失败：版本不兼容 2.1 / 需要 2.3）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_04',
    text: '用本地模型总结本周周报',
    source: 'desktop',
    requester: '你',
    evidenceLevel: 'possible',
    draft: draftOf({
      summary: '把「用本地模型总结本周周报」交给 本地模型 的「本地摘要模型」',
      caps: [capRef('llm.summarize', '本地摘要模型')],
      target: devRef(LLM, '本地模型'),
      risk: { level: 'reversible', reasons: [] },
      params: { text: '本周周报：完成榫卯 v0.1 的账本、体检与通道模块……' },
    }),
  }, atDay(9, 0));
  appendAt(ledger, 'task.queued', { taskId: 'seed_task_04', nodeId: LLM, note: '可逆动作免确认，直接派发' }, atDay(9, 1));
  appendAt(ledger, 'task.started', { taskId: 'seed_task_04', nodeId: LLM, nodeName: '本地模型' }, atDay(9, 2));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_04', label: '加载模型', detail: 'llm.summarize 2.1' }, atDay(9, 3));
  appendAt(ledger, 'task.failed', { taskId: 'seed_task_04', error: '版本不兼容：需要 2.3 以上，当前 2.1' }, atDay(9, 5));

  // ===== ⑩ 上周三打印合同扫描件 3 份（历史成功；影响预览「可能」）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_10',
    text: '打印合同扫描件 3 份',
    source: 'desktop',
    requester: '你',
    evidenceLevel: 'certain',
    draft: draftOf({
      summary: '把「打印合同扫描件 3 份」交给 打印服务器 的「打印」',
      caps: [capRef('printer.mock', '打印')],
      target: devRef(PRINTER, '打印服务器'),
      risk: { level: 'irreversible', reasons: ['该能力会向外部发送或删除数据', '文本包含发送/删除/付款/打印等不可逆动作'] },
      params: { file: '示例空间/样品图/样品01.png', copies: 3 },
    }),
  }, atDay(7, 0));
  appendAt(ledger, 'task.confirmed', { taskId: 'seed_task_10', confirmedBy: '你', note: '确认执行不可逆动作' }, atDay(7, 1));
  appendAt(ledger, 'task.queued', { taskId: 'seed_task_10', nodeId: PRINTER, note: '确认后派发' }, atDay(7, 2));
  appendAt(ledger, 'task.started', { taskId: 'seed_task_10', nodeId: PRINTER, nodeName: '打印服务器' }, atDay(7, 3));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_10', label: '打印', detail: '3 份 · 打印服务器' }, atDay(7, 5));
  appendAt(ledger, 'task.succeeded', {
    taskId: 'seed_task_10',
    result: { summary: '已打印 3 份合同扫描件（模拟打印机）', items: [{ name: '合同扫描件×3', ok: true, detail: '已出纸（模拟）' }], partial: false },
  }, atDay(7, 6));
  appendAt(ledger, 'task.deliveryAttempt', { taskId: 'seed_task_10', channel: 'wechat-mock', status: 'unavailable', reason: '账号异常' }, atDay(7, 7));
  appendAt(ledger, 'task.deliveryAttempt', { taskId: 'seed_task_10', channel: 'email-mock', status: 'unavailable', reason: '账号异常' }, atDay(7, 8));
  appendAt(ledger, 'task.deliveryAttempt', { taskId: 'seed_task_10', channel: 'station', status: 'failed', reason: '无可用通道' }, atDay(7, 9));
  appendAt(ledger, 'task.undelivered', { taskId: 'seed_task_10', summary: '已打印 3 份合同扫描件（模拟打印机）' }, atDay(7, 10));

  // ===== ⑪ 打印 2 份彩页样张（已取消；影响预览「未知」）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_11',
    text: '打印 2 份彩页样张',
    source: 'phone',
    requester: '你',
    evidenceLevel: 'certain',
    draft: draftOf({
      summary: '把「打印 2 份彩页样张」交给 打印服务器 的「打印」',
      caps: [capRef('printer.mock', '打印')],
      target: devRef(PRINTER, '打印服务器'),
      risk: { level: 'irreversible', reasons: ['该能力会向外部发送或删除数据'] },
      params: { file: '示例空间/样品图/样品04.png', copies: 2 },
    }),
  }, atDay(5, 0), 'phone');
  appendAt(ledger, 'task.cancelled', { taskId: 'seed_task_11', completedSteps: 0 }, atDay(5, 5));

  // ===== ⑤ 微信发交付链接（成功，已回传 wechat-mock，含 message.inbox #2）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_05',
    text: '把交付链接发到工作群',
    source: 'phone',
    requester: '你',
    evidenceLevel: 'certain',
    draft: draftOf({
      summary: '把「把交付链接发到工作群」交给 本机中枢 的「回传通道」',
      caps: [capRef('channel.notify', '回传通道')],
      target: devRef(HUB, '本机中枢'),
      risk: { level: 'irreversible', reasons: ['该能力会向外部发送或删除数据', '文本包含发送/删除/付款/打印等不可逆动作'] },
      params: { channel: 'wechat-mock', group: '工作群' },
    }),
  }, atDay(3, 0), 'phone');
  appendAt(ledger, 'task.confirmed', { taskId: 'seed_task_05', confirmedBy: '你', note: '确认执行不可逆动作' }, atDay(3, 1));
  appendAt(ledger, 'task.queued', { taskId: 'seed_task_05', nodeId: HUB, note: '确认后派发' }, atDay(3, 2));
  appendAt(ledger, 'task.started', { taskId: 'seed_task_05', nodeId: HUB, nodeName: '本机中枢' }, atDay(3, 3));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_05', label: '摘要脱敏', detail: '将向 3 个群发送，只发摘要与链接' }, atDay(3, 4));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_05', label: '发送', detail: '工作群 · 模拟通道' }, atDay(3, 5));
  appendAt(ledger, 'task.succeeded', {
    taskId: 'seed_task_05',
    result: {
      summary: '已向 3 个群发送摘要与链接（模拟通道）',
      items: [{ name: '工作群-1', ok: true, detail: '已送达' }, { name: '工作群-2', ok: true, detail: '已送达' }, { name: '工作群-3', ok: true, detail: '已送达' }],
      partial: false,
    },
  }, atDay(3, 6));
  appendAt(ledger, 'task.deliveryAttempt', { taskId: 'seed_task_05', channel: 'wechat-mock', status: 'delivered', latencyMs: 96 }, atDay(3, 7));
  appendAt(ledger, 'message.inbox', {
    messageId: 'msg_seed_02', taskId: 'seed_task_05', channel: 'wechat-mock', channelLabel: '微信（模拟通道）',
    title: '群消息 · 工作群', summary: '把交付链接发到工作群', link: '/r/seed_task_05', status: 'delivered', sensitive: true,
  }, atDay(3, 7));
  appendAt(ledger, 'task.delivered', {
    taskId: 'seed_task_05', channel: 'wechat-mock', messageId: 'msg_seed_02',
    summary: '把交付链接发到工作群', link: '/r/seed_task_05', latencyMs: 96, status: 'delivered', note: '',
  }, atDay(3, 7));

  // ===== 打印服务器 2 天前离线（历史成功任务之后；②⑦⑧ 三条待确认引用因离线/不可逆而阻塞）=====
  appendAt(ledger, 'node.heartbeat', { nodeId: PRINTER }, atDay(2, -10));
  appendAt(ledger, 'node.offline', { nodeId: PRINTER, since: atDay(2, 0) }, atDay(2, 0));

  // ===== ⑥ 转码演示视频（draft，能力 video.transcode 仅手动；挂在 NAS 上，真实节点注册不会覆盖）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_06',
    text: '把演示视频转码成 1080p',
    source: 'desktop',
    requester: '你',
    evidenceLevel: 'possible',
    draft: draftOf({
      summary: '把「把演示视频转码成 1080p」交给 群晖 NAS 的「视频转码（仅手动）」',
      caps: [capRef('video.transcode', '视频转码（仅手动）', true)],
      target: devRef(NAS, '群晖 NAS'),
      risk: { level: 'reversible', reasons: [] },
      params: { src: '示例空间/视频/演示.mp4', target: '1080p' },
    }),
  }, atDay(1, 0));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_06', label: '仅手动', detail: '卡片标「仅手动，需要你操作」' }, atDay(1, 1));

  // ===== ② 打印 3 份合同（pending 待确认，不可逆，目标打印服务器）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_02',
    text: '打印 3 份合同',
    source: 'phone',
    requester: '你',
    evidenceLevel: 'certain',
    draft: draftOf({
      summary: '把「打印 3 份合同」交给 打印服务器 的「打印」',
      caps: [capRef('printer.mock', '打印')],
      target: devRef(PRINTER, '打印服务器'),
      risk: { level: 'irreversible', reasons: ['该能力会向外部发送或删除数据', '文本包含发送/删除/付款/打印等不可逆动作'] },
      params: { file: '示例空间/样品图/样品01.png', copies: 3 },
    }),
  }, atMin(-360), 'phone');

  // ===== ⑦ 跨域任务：NAS → 打印服务器（pending，跨数据域，需审批）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_07',
    text: '把 NAS 上的素材直接打印到打印服务器',
    source: 'desktop',
    requester: '你',
    evidenceLevel: 'certain',
    draft: draftOf({
      summary: '跨数据域：群晖 NAS（域外） → 打印服务器 的「打印」',
      caps: [capRef('printer.mock', '打印')],
      target: devRef(PRINTER, '打印服务器'),
      risk: { level: 'irreversible', reasons: ['跨数据域，需审批', '该能力会向外部发送或删除数据'] },
      params: { sourceDeviceId: NAS, file: 'NAS:/archive/2025/素材索引.zip', copies: 1 },
    }),
  }, atMin(-300));
  appendAt(ledger, 'task.step', { taskId: 'seed_task_07', label: '等待审批', detail: '跨数据域，需审批' }, atMin(-299));

  // ===== ⑧ 打印服务器固件检查（pending，引用打印服务器）=====
  appendAt(ledger, 'task.drafted', {
    taskId: 'seed_task_08',
    text: '检查打印服务器固件，必要时升级',
    source: 'desktop',
    requester: '你',
    evidenceLevel: 'certain',
    draft: draftOf({
      summary: '把「检查打印服务器固件」交给 打印服务器 的「文件扫描」',
      caps: [capRef('file.hash', '文件扫描')],
      target: devRef(PRINTER, '打印服务器'),
      risk: { level: 'irreversible', reasons: ['固件检查后可能触发升级，不可自动回滚'] },
      params: { path: 'printer://firmware', mode: 'check-and-maybe-upgrade' },
    }),
  }, atMin(-240));

  // ===== 体检②：scope=all，有发现（离线/版本/授权/限流/通道不可用/未回传/无 AI key）=====
  appendAt(ledger, 'node.heartbeat', { nodeId: HUB }, atMin(-90));
  appendAt(ledger, 'node.heartbeat', { nodeId: LOCAL }, atMin(-80));
  const allCheckupAt = atMin(-50);
  const allCheckup = realCheckup(ledger, 'all', allCheckupAt);
  appendAt(ledger, 'checkup.ran', {
    checkupId: allCheckup.checkupId,
    scope: 'all',
    findings: allCheckup.findings,
    verdict: allCheckup.verdict,
    checked: allCheckup.checked,
    items: allCheckup.items,
    summary: allCheckup.summary,
  }, allCheckupAt);

  // ===== 审计导出 ×2 =====
  appendAt(ledger, 'audit.exported', { format: 'csv', count: 128, by: '你' }, atMin(-30));
  appendAt(ledger, 'audit.exported', { format: 'json', count: 130, by: '你' }, atMin(-20));

  // ===== 最后一条心跳：dataAsOf = 10 分钟前 =====
  appendAt(ledger, 'node.heartbeat', { nodeId: HUB }, atMin(-10));
}
// ---------- 自检 + 汇总 ----------
const EXPECTED_TASKS = {
  seed_task_01: 'succeeded',
  seed_task_02: 'pending',
  seed_task_03: 'succeeded',
  seed_task_04: 'failed',
  seed_task_05: 'succeeded',
  seed_task_06: 'draft',
  seed_task_07: 'pending',
  seed_task_08: 'pending',
  seed_task_09: 'draft',
  seed_task_10: 'succeeded',
  seed_task_11: 'cancelled',
};

function verify(dataDir) {
  const problems = [];
  const ledger = new Ledger(dataDir);
  const integrity = ledger.integrity();
  const st = replay(ledger.events);
  if (!integrity.ok) problems.push('账本完整性失败：' + JSON.stringify(integrity.gaps));
  if (ledger.events.length === 0) problems.push('账本为空');
  const ids = Object.keys(st.tasks);
  if (ids.length !== Object.keys(EXPECTED_TASKS).length) problems.push('任务数 ' + ids.length + '，应为 ' + Object.keys(EXPECTED_TASKS).length);
  for (const [id, status] of Object.entries(EXPECTED_TASKS)) {
    const t = st.tasks[id];
    if (!t) problems.push('缺少任务 ' + id);
    else if (t.status !== status) problems.push('任务 ' + id + ' 状态 ' + t.status + '，应为 ' + status);
  }
  if (st.checkups.length !== 2) problems.push('体检数 ' + st.checkups.length + '，应为 2');
  const withFindings = st.checkups.filter((c) => c.verdict === 'findings');
  const withoutFindings = st.checkups.filter((c) => c.verdict === 'none');
  if (withFindings.length !== 1) problems.push('「有发现」体检数 ' + withFindings.length + '，应为 1');
  if (withoutFindings.length !== 1) problems.push('「无发现」体检数 ' + withoutFindings.length + '，应为 1');
  if (!withoutFindings.some((c) => c.scope === 'channels')) problems.push('无发现的体检应来自 scope=channels');
  for (const c of withoutFindings) {
    if (!/^未发现问题，已检查 \d+ 项$/.test(c.summary || '')) problems.push('空结果文案不对：' + c.summary);
  }
  if (st.messages.length !== 2) problems.push('消息 inbox 数 ' + st.messages.length + '，应为 2');
  if (st.audit.length !== 2) problems.push('审计导出记录 ' + st.audit.length + '，应为 2');
  if (st.aiUsage.calls !== 1) problems.push('ai.called 记录 ' + st.aiUsage.calls + '，应为 1');
  const printer = impact(st, PRINTER);
  if (printer.counts.certain !== 3 || printer.counts.possible !== 1 || printer.counts.unknown !== 1) {
    problems.push('打印服务器影响预览应为 确定3/可能1/未知1，实际 ' + JSON.stringify(printer.counts));
  }
  const manual = Object.values(st.tasks).some((t) => {
    const cap = t.draft && t.draft.capabilities && t.draft.capabilities[0];
    return cap && cap.id === 'video.transcode' && cap.manualOnly;
  });
  if (!manual) problems.push('缺少「仅手动」能力草案（video.transcode manualOnly）');
  const videoNode = Object.values(st.nodes).find((n) => (n.capabilities || []).some((cap) => cap.id === 'video.transcode' && cap.manualOnly));
  if (!videoNode) problems.push('没有设备登记「视频转码（仅手动）」能力');
  const scanner = impact(st, SCANNER);
  if (scanner.counts.unknown !== 1) problems.push('旧扫描仪影响预览应为「未知 1」，实际 ' + JSON.stringify(scanner.counts));
  return { problems, ledger, state: st, integrity };
}

function buildSummary(dataDir, ledger, st, integrity) {
  const taskIds = Object.keys(st.tasks).sort();
  return {
    generatedAt: new Date(NOW).toISOString(),
    dataDir,
    events: ledger.events.length,
    lastSeq: ledger.lastSeq,
    integrity: { ok: integrity.ok, gaps: integrity.gaps.length },
    taskCount: taskIds.length,
    tasks: taskIds.map((id) => ({ id, status: st.tasks[id].status, nodeId: st.tasks[id].nodeId, capabilityId: st.tasks[id].capabilityId })),
    checkups: st.checkups.map((c) => ({ id: c.id, scope: c.scope, verdict: c.verdict, checked: c.checked, findings: c.findings.length, summary: c.summary })),
    messages: st.messages.map((m) => ({ id: m.id, taskId: m.taskId, channel: m.channel, title: m.title })),
    audit: st.audit,
    aiCalls: st.aiUsage.calls,
    nodes: Object.values(st.nodes).map((n) => ({ id: n.id, name: n.name, evidence: n.evidence, online: !!n.online, domain: n.domain })),
    impacts: {
      '打印服务器': impact(st, PRINTER).counts,
      '群晖 NAS': impact(st, NAS).counts,
      '旧扫描仪': impact(st, SCANNER).counts,
      '本机工作台': impact(st, LOCAL).counts,
    },
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('参数错误：' + err.message);
    return 2;
  }
  if (args.help) {
    console.log('用法：node scripts/seed-demo.js --fresh [--data-dir <dir>]');
    return 0;
  }
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : path.join(ROOT, 'data');
  const eventsFile = path.join(dataDir, 'events.jsonl');
  const existing = fs.existsSync(eventsFile) && fs.statSync(eventsFile).size > 0;
  if (existing && !args.fresh) {
    console.error('已存在事件账本：' + eventsFile + '（如需重建请加 --fresh）');
    return 3;
  }
  if (args.fresh) {
    fs.mkdirSync(dataDir, { recursive: true });
    for (const name of fs.readdirSync(dataDir)) fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  if (!fs.existsSync(path.join(ROOT, '示例空间', '样品图', '样品01.png'))) {
    console.warn('提示：示例图片还没生成，先跑 python scripts/gen-samples.py');
  }
  const ledger = new Ledger(dataDir);
  buildTimeline(ledger);
  const { problems, state: st, integrity } = verify(dataDir);
  if (problems.length) {
    console.error('种子自检失败：');
    for (const p of problems) console.error(' - ' + p);
    return 1;
  }
  const summary = buildSummary(dataDir, ledger, st, integrity);
  fs.writeFileSync(path.join(dataDir, 'seed-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('OK 种子已写入：' + eventsFile);
  console.log('OK 事件 ' + summary.events + ' 条 / 任务 ' + summary.taskCount + ' 条 / 体检 ' + summary.checkups.length + ' 份 / 消息 ' + summary.messages.length + ' 条 / 审计导出 ' + summary.audit.length + ' 条 / ai.called ' + summary.aiCalls + ' 条');
  console.log('OK 影响预览：打印服务器 ' + JSON.stringify(summary.impacts['打印服务器']) + '，本机工作台 ' + JSON.stringify(summary.impacts['本机工作台']) + '，旧扫描仪 ' + JSON.stringify(summary.impacts['旧扫描仪']));
  console.log('OK 汇总：' + path.join(dataDir, 'seed-summary.json'));
  return 0;
}

process.exitCode = main();