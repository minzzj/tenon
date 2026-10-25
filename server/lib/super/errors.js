// 榫卯 Tenon v2.1 · 超级终端服务 · 统一 HTTP 错误
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function errorMessage(err) {
  return String((err && err.message) || err || '未知错误');
}

export function clip(text, max = 200) {
  return String(text || '').slice(0, max);
}