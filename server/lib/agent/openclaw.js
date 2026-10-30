// 榫卯 V4 · OpenClaw（小龙虾）执行器适配：检测本机 OpenClaw 网关，把开放式任务交给它执行
// 说明：通过本机 `openclaw agent` CLI（默认走 Gateway 18789）完成 agent turn；不读取/不暴露其 token。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const OPENCLAW_CONFIG = path.join(os.homedir(), '.openclaw', 'openclaw.json');

export function detectOpenClaw() {
  try {
    if (!fs.existsSync(OPENCLAW_CONFIG)) return { available: false, reason: '未安装 OpenClaw（~/.openclaw/openclaw.json 不存在）' };
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
    const port = (cfg.gateway && cfg.gateway.port) || 18789;
    return { available: true, gateway: 'http://127.0.0.1:' + port, model: (cfg.agents && cfg.agents.defaults && cfg.agents.defaults.model) || '', workspace: (cfg.agents && cfg.agents.defaults && cfg.agents.defaults.workspace) || '' };
  } catch (e) {
    return { available: false, reason: String(e && e.message || e) };
  }
}

function runCli(args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '', stderr = '', done = false;
    const finish = (obj) => { if (done) return; done = true; resolve(obj); };
    let child;
    try {
      child = spawn('openclaw.cmd', args, { windowsHide: true, shell: true, env: Object.assign({}, process.env, { OPENCLAW_NO_COLOR: '1' }) });
    } catch (e) {
      return finish({ ok: false, error: '无法启动 openclaw CLI: ' + String(e && e.message || e) });
    }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} finish({ ok: false, error: 'OpenClaw 执行超时（' + Math.round(timeoutMs / 1000) + 's）', stdout: stdout.slice(0, 500), stderr: stderr.slice(0, 500), durationMs: Date.now() - started }); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); if (stdout.length > 200000) stdout = stdout.slice(-200000); });
    child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: String(e && e.message || e) }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      let parsed = null;
      const i = out.indexOf('{'), j = out.lastIndexOf('}');
      if (i >= 0 && j > i) { try { parsed = JSON.parse(out.slice(i, j + 1)); } catch (_) {} }
      let say = '';
      const dig = (o, depth) => {
        if (!o || depth > 6 || say) return;
        if (typeof o === 'string') return;
        if (Array.isArray(o)) { o.forEach((x) => dig(x, depth + 1)); return; }
        if (typeof o === 'object') {
          for (const k of ['terminalReply', 'reply', 'text', 'message', 'content']) {
            if (typeof o[k] === 'string' && o[k].trim()) { say = o[k].trim(); return; }
            if (o[k] && typeof o[k] === 'object') dig(o[k], depth + 1);
          }
          for (const k of Object.keys(o)) { if (o[k] && typeof o[k] === 'object') dig(o[k], depth + 1); }
        }
      };
      dig(parsed, 0);
      if (!say && parsed && parsed.result) say = String(parsed.result).slice(0, 2000);
      finish({ ok: code === 0 || !!say, exitCode: code, say: say || (out ? out.slice(-800) : ''), parsed, stdout: out.slice(0, 4000), stderr: stderr.slice(0, 2000), durationMs: Date.now() - started });
    });
  });
}

export function createOpenClawService({ root, log = () => {} } = {}) {
  async function execute({ text, timeoutMs = 150000, context = {} } = {}) {
    const info = detectOpenClaw();
    if (!info.available) return { ok: false, provider: 'openclaw', available: false, error: info.reason };
    const task = String(text || '').trim();
    if (!task) return { ok: false, provider: 'openclaw', error: '命令为空' };
    const prompt = [
      '你是运行在用户 Windows 电脑上的 OpenClaw（小龙虾）智能体，已接入榫卯超级终端。',
      '用户通过语音说：' + task,
      '要求：直接开始执行任务（可使用你已有的工具/技能），完成后用不超过两句话的中文回复结果；不要反问，尽量自己完成；涉及不可逆操作时先说明再征求确认。',
      context && context.summary ? '补充上下文：' + String(context.summary).slice(0, 500) : '',
    ].filter(Boolean).join('\n');
    log('[openclaw] execute:', task.slice(0, 120));
    let msgFile = '';
    try {
      const tmpDir = path.join(root, 'data', 'agent', 'tmp');
      fs.mkdirSync(tmpDir, { recursive: true });
      msgFile = path.join(tmpDir, 'openclaw-' + Date.now() + '.txt');
      fs.writeFileSync(msgFile, prompt, 'utf8');
    } catch (e) { msgFile = ''; }
    const args = ['agent', '--json', '--timeout', String(Math.max(30, Math.round(timeoutMs / 1000)))];
    if (msgFile) args.push('--message-file', msgFile); else args.push('--message', prompt);
    const r = await runCli(args, { timeoutMs: timeoutMs + 15000 });
    try { if (msgFile && fs.existsSync(msgFile)) fs.unlinkSync(msgFile); } catch (_) {}
    return Object.assign({ provider: 'openclaw', available: true, gateway: info.gateway, model: info.model }, r);
  }
  return { detect: detectOpenClaw, execute };
}
