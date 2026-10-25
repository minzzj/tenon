// 榫卯 v2 · 节点侧中枢 HTTP 客户端
// v2 接口用 operatorToken（x-tenon-token，写操作需要）；v0.1 节点接口用 nodeToken（x-tenon-node）。
// 提供一个「真实 fetch 注入点」，方便 __tests__ 里用本地 stub 中枢跑全链路。
import fs from 'node:fs';

export class HubError extends Error {
  constructor(message, { status = 0, body = '' } = {}) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.body = body;
  }
}

// 从 data/secrets.json 读两个令牌，环境变量可覆盖（测试/联调方便）
export function loadSecrets(secretsFile, env = process.env) {
  let fileSecrets = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
    if (parsed && typeof parsed === 'object') fileSecrets = parsed;
  } catch {
    fileSecrets = {};
  }
  return {
    fileSecrets,
    nodeToken: String(env.TENON_NODE_TOKEN || fileSecrets.nodeToken || '').trim(),
    operatorToken: String(env.TENON_OPERATOR_TOKEN || fileSecrets.operatorToken || '').trim(),
  };
}

export class HubClient {
  constructor({ baseUrl = 'http://127.0.0.1:7410', nodeToken = '', operatorToken = '', timeoutMs = 8000, log } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.nodeToken = nodeToken || '';
    this.operatorToken = operatorToken || '';
    this.timeoutMs = timeoutMs;
    this.log = typeof log === 'function' ? log : () => {};
  }

  get ready() {
    return !!(this.operatorToken || this.nodeToken);
  }

  authHeaders(auth = 'v2') {
    const headers = {};
    // 两个 header 能带的都带上：v2 写接口用 x-tenon-token 鉴权，x-tenon-node 帮 link-core 认节点
    const nodeToken = this.nodeToken || (auth === 'node' ? this.operatorToken : '');
    if (nodeToken) headers['x-tenon-node'] = nodeToken;
    if (auth === 'v2') headers['x-tenon-token'] = this.operatorToken || this.nodeToken || '';
    else if (auth === 'node' && !headers['x-tenon-node']) headers['x-tenon-node'] = this.operatorToken || '';
    return headers;
  }

  async request(pathname, { method = 'GET', body, headers = {}, auth = 'v2', timeoutMs } = {}) {
    const url = this.baseUrl + pathname;
    const merged = { ...this.authHeaders(auth), ...headers };
    let payload;
    if (body === undefined || body === null) {
      payload = undefined;
    } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      payload = body;
      if (!merged['content-type']) merged['content-type'] = 'application/octet-stream';
    } else {
      payload = JSON.stringify(body);
      if (!merged['content-type']) merged['content-type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: merged,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs || this.timeoutMs),
      });
    } catch (err) {
      const cause = err && err.cause ? err.cause.code || err.cause.message || '' : '';
      throw new HubError(`无法连接中枢 ${this.baseUrl}：${cause || (err && err.message) || err}`, { status: 0 });
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new HubError(`HTTP ${res.status} ${method} ${pathname}：${String(text).slice(0, 200)}`, {
        status: res.status,
        body: text,
      });
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async requestBuffer(pathname, { method = 'GET', body, headers = {}, auth = 'v2', timeoutMs } = {}) {
    const url = this.baseUrl + pathname;
    const merged = { ...this.authHeaders(auth), ...headers };
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: merged,
        body: body === undefined || body === null ? undefined : body,
        signal: AbortSignal.timeout(timeoutMs || this.timeoutMs),
      });
    } catch (err) {
      const cause = err && err.cause ? err.cause.code || err.cause.message || '' : '';
      throw new HubError(`无法连接中枢 ${this.baseUrl}：${cause || (err && err.message) || err}`, { status: 0 });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HubError(`HTTP ${res.status} ${method} ${pathname}：${String(text).slice(0, 200)}`, {
        status: res.status,
        body: text,
      });
    }
    return Buffer.from(await res.arrayBuffer());
  }

  getJson(pathname, opts) {
    return this.request(pathname, { ...opts, method: 'GET' });
  }

  postJson(pathname, body, opts) {
    return this.request(pathname, { ...opts, method: 'POST', body });
  }

  // 上传分块（二进制 body）
  putBinary(pathname, buffer, opts = {}) {
    return this.request(pathname, {
      ...opts,
      method: opts.method || 'PUT',
      body: buffer,
      headers: { 'content-type': 'application/octet-stream', ...(opts.headers || {}) },
    });
  }

  getBuffer(pathname, opts) {
    return this.requestBuffer(pathname, { ...opts, method: 'GET' });
  }

  // SSE：GET /api/stream，逐条 yield 账本事件（自动解析 data: 行）
  async *sse({ pathname = '/api/stream', auth = 'none', signal } = {}) {
    const url = this.baseUrl + pathname;
    let res;
    try {
      res = await fetch(url, { headers: { ...this.authHeaders(auth), accept: 'text/event-stream' }, signal });
    } catch (err) {
      throw new HubError(`SSE 连接失败：${(err && err.message) || err}`, { status: 0 });
    }
    if (!res.ok || !res.body) throw new HubError(`SSE HTTP ${res.status}`, { status: res.status });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of raw.split('\n')) {
            const match = /^data:\s?(.*)$/.exec(line);
            if (!match) continue;
            try {
              yield JSON.parse(match[1]);
            } catch {
              /* 忽略非 JSON 心跳行 */
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      try {
        const cancelled = reader.cancel();
        if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }
}

// 可断线重连的事件订阅循环；返回停止函数
export function subscribeEvents({ hub, onEvent, onError, retryMs = 3000, signal } = {}) {
  const controller = new AbortController();
  let stopped = false;
  const mergedSignal = signal || controller.signal;
  const stop = () => {
    stopped = true;
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  };
  (async () => {
    while (!stopped) {
      try {
        for await (const event of hub.sse({ signal: mergedSignal })) {
          if (stopped) return;
          try {
            await onEvent(event);
          } catch (err) {
            if (onError) onError(err);
          }
        }
      } catch (err) {
        if (stopped) return;
        if (onError) onError(err);
      }
      if (stopped) return;
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  })();
  return stop;
}

export default { HubClient, HubError, loadSecrets, subscribeEvents };