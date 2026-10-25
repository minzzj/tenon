// 榫卯 Tenon v2 · 极简路由匹配（供 Lead 在 http.js 挂载 {method,path,handler} 数组）
export function compilePattern(pattern) {
  return String(pattern || '').split('/');
}

export function matchPath(pattern, pathname) {
  const pat = compilePattern(pattern);
  const got = String(pathname || '').split('/');
  if (pat.length !== got.length) return null;
  const params = {};
  for (let i = 0; i < pat.length; i += 1) {
    const p = pat[i];
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(got[i]);
      } catch {
        params[p.slice(1)] = got[i];
      }
    } else if (p !== got[i]) {
      return null;
    }
  }
  return params;
}

/** routes: [{method,path,handler}]；匹配成功返回 {route, params}，否则 null */
export function matchRoutes(routes, method, pathname) {
  const list = Array.isArray(routes) ? routes : [];
  for (const route of list) {
    if (!route || String(route.method).toUpperCase() !== String(method || '').toUpperCase()) continue;
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}