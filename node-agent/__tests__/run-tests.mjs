// 本地测试运行器：等价 `node --test node-agent/__tests__/*.test.mjs`
// 完整日志写入 evidence/test-run.log（便于取证），终端只打印摘要；--test-force-exit 防止 GUI 子进程句柄拖住进程。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVID = path.join(HERE, 'evidence');
fs.mkdirSync(EVID, { recursive: true });
const files = fs.readdirSync(HERE).filter((name) => /\.test\.mjs$/.test(name)).sort().map((name) => path.join(HERE, name));
const started = Date.now();
const result = spawnSync(process.execPath, ['--test', '--test-force-exit', ...files], {
  encoding: 'utf8',
  timeout: Number(process.env.TENON_TEST_TIMEOUT_MS || 300000),
  stdio: ['ignore', 'pipe', 'pipe'],
});
const output = `${result.stdout || ''}\n${result.stderr || ''}`;
fs.writeFileSync(path.join(EVID, 'test-run.log'), output, 'utf8');
const pass = (output.match(/^# pass (\d+)$/m) || output.match(/ℹ pass (\d+)/) || [])[1] || '?';
const fail = (output.match(/^# fail (\d+)$/m) || output.match(/ℹ fail (\d+)/) || [])[1] || '?';
const filesLine = files.map((file) => path.basename(file)).join(', ');
console.log(`TEST_FILES=${filesLine}`);
console.log(`TEST_EXIT=${result.status} PASS=${pass} FAIL=${fail} SIGNAL=${result.signal || 'none'} TIME=${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`TEST_LOG=${path.join(EVID, 'test-run.log')}`);
if (result.status !== 0) process.exitCode = result.status || 1;