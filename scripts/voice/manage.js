#!/usr/bin/env node
// 榫卯 V3 · 语音 worker 管理 CLI（可选工具）
// 用法：
//   node scripts/voice/manage.js status                     # 读取 data/voice 状态（有中枢时顺带请求 /api/v2/voice/status）
//   node scripts/voice/manage.js asr --file a.wav           # 调用 asr_worker.py --file（JSON）
//   node scripts/voice/manage.js asr --devices              # 列出麦克风
//   node scripts/voice/manage.js llm --prompt "打开记事本"    # 启动 llm_worker.py，发一行 JSON，收一行 JSON
//   node scripts/voice/manage.js speak --text "你好" [--out x.wav]   # SAPI 朗读/写 WAV
//   node scripts/voice/manage.js transcribe --wav a.wav     # Windows SR 兜底
// 环境变量：TENON_HUB_URL（默认 http://127.0.0.1:7410）、TENON_TOKEN（operatorToken，可选）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..', '..');
const dataDir = path.resolve(process.env.TENON_DATA_DIR || path.join(root, 'data'));
const python = process.env.TENON_PYTHON || 'python';
const voiceDir = path.join(root, 'scripts', 'voice');

function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i += 1; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function run(cmd, args, { timeoutMs = 120000, input = null, env = null } = {}) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(cmd, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: env || { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String((err && err.message) || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += String(b); });
    child.stderr.on('data', (b) => { stderr += String(b); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String((err && err.message) || err) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout, stderr }); });
    if (input != null) { try { child.stdin.write(input); child.stdin.end(); } catch { /* ignore */ } }
  });
}

async function readHubStatus() {
  const base = String(process.env.TENON_HUB_URL || '').replace(/\/$/, '');
  if (!base) return null;
  try {
    const res = await fetch(base + '/api/v2/voice/status', { headers: { Accept: 'application/json' } });
    if (!res.ok) return { http: res.status };
    return await res.json();
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

function printJson(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }

async function main() {
  const cmd = process.argv[2] || 'status';
  const a = argsOf(process.argv.slice(3));
  if (cmd === 'status') {
    const cfgFile = path.join(dataDir, 'voice', 'config.json');
    const transcriptsDir = path.join(dataDir, 'voice', 'transcripts');
    const configured = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : null;
    const days = fs.existsSync(transcriptsDir) ? fs.readdirSync(transcriptsDir).filter((n) => n.endsWith('.jsonl')).length : 0;
    const hub = await readHubStatus();
    printJson({ ok: true, dataDir, configured, transcriptsDays: days, hub });
    return 0;
  }
  if (cmd === 'asr') {
    if (a.devices) { const r = await run(python, [path.join(voiceDir, 'asr_worker.py'), '--devices']); process.stdout.write(r.stdout + r.stderr); return r.code; }
    if (!a.file) { printJson({ ok: false, error: '需要 --file <wav> 或 --devices' }); return 2; }
    const r = await run(python, [path.join(voiceDir, 'asr_worker.py'), '--file', path.resolve(String(a.file))], { timeoutMs: 180000 });
    process.stdout.write(r.stdout.trim() + '\n');
    if (r.code !== 0) process.stderr.write(r.stderr);
    return r.code;
  }
  if (cmd === 'llm') {
    const prompt = String(a.prompt || a.text || '用一句中文回答：你好');
    const input = JSON.stringify({ messages: [{ role: 'system', content: '你只输出 JSON。' }, { role: 'user', content: prompt }], max_tokens: Number(a.tokens || 200) }) + '\n';
    const r = await run(python, [path.join(voiceDir, 'llm_worker.py')], { input, timeoutMs: 180000 });
    process.stdout.write(r.stdout.trim() + '\n');
    if (r.code !== 0) process.stderr.write(r.stderr);
    return r.code;
  }
  if (cmd === 'speak') {
    const text = String(a.text || '你好，我是榫卯语音管家');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(voiceDir, 'speak.ps1'), '-Text', text];
    if (a.out) args.push('-OutFile', path.resolve(String(a.out)));
    const r = await run('powershell', args, { timeoutMs: 60000 });
    process.stdout.write(r.stdout.trim() + '\n');
    if (r.code !== 0) process.stderr.write(r.stderr);
    return r.code;
  }
  if (cmd === 'transcribe') {
    if (!a.wav) { printJson({ ok: false, error: '需要 --wav <path>' }); return 2; }
    const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(voiceDir, 'transcribe.ps1'), '-Wav', path.resolve(String(a.wav))], { timeoutMs: 120000 });
    process.stdout.write(r.stdout.trim() + '\n');
    if (r.code !== 0) process.stderr.write(r.stderr);
    return r.code;
  }
  printJson({ ok: false, error: '未知命令：' + cmd, commands: ['status', 'asr', 'llm', 'speak', 'transcribe'] });
  return 2;
}

main().then((code) => process.exit(code)).catch((err) => { console.error(String((err && err.stack) || err)); process.exit(1); });