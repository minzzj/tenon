// 榫卯 v2.2 · devices 小工具（零依赖，只做 HTTP 帮助函数）
export function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function sendText(res, statusCode, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

export function jsonError(res, statusCode, message) {
  sendJson(res, statusCode, { ok: false, error: message });
}

export function getHeader(req, name) {
  if (!req || !req.headers) return '';
  const value = req.headers[String(name).toLowerCase()];
  return value == null ? '' : String(value);
}

export function parseCookie(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

export function operatorTokenOf(req) {
  const header = getHeader(req, 'x-tenon-token');
  if (header) return header;
  return parseCookie(getHeader(req, 'cookie')).tenon_token || '';
}

export function isOperator(service, token) {
  const expected = service && service.tokens && service.tokens.operatorToken;
  return !!(expected && token && String(token) === String(expected));
}

export function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        return resolve(JSON.parse(raw));
      } catch {
        return reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}