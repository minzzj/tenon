// 榫卯 Tenon v2 · 物模型与场景 · 统一 HTTP 错误（routes 只捕获 status/message）
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function errorMessage(err) {
  return String((err && err.message) || err || '未知错误');
}