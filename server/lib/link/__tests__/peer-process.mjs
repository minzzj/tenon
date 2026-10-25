#!/usr/bin/env node
// 两台本机进程测试用的「榫卯 v2 连接层」最小节点：
// 创建 createLinkService + 真实 HTTP 服务挂载 routes，启动真实 UDP 发现，把 READY 信息打到 stdout。
// 由 link.test.mjs 用 child_process.spawn 拉起（不是独立测试文件）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLinkService, matchRoutes } from '../index.js';
import { Ledger } from '../../ledger.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function argOf(name, fallback = '') {
  const index = process.argv.indexOf('--' + name);
  if (index >= 0 && process.argv[index + 1] != null) return process.argv[index + 1];
  return fallback;
}

const dataDir = path.resolve(argOf('data'));
const port = Number(argOf('port', '0'));
const udpPort = Number(argOf('udp', '7433'));
const token = argOf('token', 'op-peer-' + process.pid);
const name = argOf('name', 'peer-' + port);
const unicast = argOf('unicast', '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'secrets.json'), JSON.stringify({ operatorToken: token, nodeToken: 'node-' + token }, null, 2));

const ledger = new Ledger(path.join(dataDir, 'ledger'));
const service = createLinkService({
  dataDir,
  ledger,
  root: path.resolve(HERE, '../../..'),
  port,
  name,
  tokens: { operatorToken: token, nodeToken: 'node-' + token },
  discovery: true,
  discoveryPort: udpPort,
  unicastTargets: unicast,
  intervalMs: 500,
  timeoutMs: 4000,
  log: (message) => console.error('[peer-process] ' + message),
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://placeholder');
    const matched = matchRoutes(service.routes, req.method, url.pathname);
    if (!matched) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    await matched.route.handler(req, res, { link: service, params: matched.params, query: url.searchParams });
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  const info = service.pairingInfo();
  const payload = {
    name,
    deviceId: service.identity.deviceId,
    httpPort: true,
    port: server.address().port,
    udpPort,
    code: info.code,
    operatorToken: token,
    dataDir,
  };
  process.stdout.write('TENON-READY ' + JSON.stringify(payload) + '\n');
});

function shutdown() {
  try {
    server.close();
  } catch {
    /* ignore */
  }
  try {
    service.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 60);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);