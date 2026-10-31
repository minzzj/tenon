// 屏幕文本相似合并（用于总结降低 token 消耗）：同应用/标题下内容相近的记录合并，并标注出现次数。
// 例：同一网页 5 秒截一次图 → 总结里只占 1 组「出现 N 次」，而不是 N 条原文。

export function normalizeScreenText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：“”‘’（）()\[\]【】<>《》…—\-_=+|/\\.,!?;:'"`~@#$%^&*]+/g, '')
    .toLowerCase();
}

function bigrams(s) {
  const out = new Set();
  const t = String(s || '');
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  // 短文本（1 个字）也保留自身
  if (t.length === 1) out.add(t);
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function screenSimilarity(a, b) {
  const na = normalizeScreenText(a);
  const nb = normalizeScreenText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // 包含关系（短文本被长文本整体包含）也算高相似
  const contained = na.includes(nb) || nb.includes(na);
  const lenRatio = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
  const j = jaccard(bigrams(na), bigrams(nb));
  if (contained && lenRatio >= 0.5) return Math.max(j, 0.9);
  return j;
}

/** 合并相似屏幕记录，返回 [{ app,title,text,count,firstAt,lastAt,sources,devices }]，按时间升序。 */
export function mergeScreens(screens = [], { threshold = 0.72, maxText = 260 } = {}) {
  const groups = [];
  for (const sc of Array.isArray(screens) ? screens : []) {
    const text = String((sc && sc.text) || '').trim();
    if (!text) continue;
    const norm = normalizeScreenText(text);
    if (!norm) continue;
    const tokens = bigrams(norm);
    let best = null;
    let bestSim = 0;
    for (const g of groups) {
      // 应用/标题不一致时不合并，避免把不同页面混在一起（两边都有值才比较）
      const appA = normalizeScreenText(sc.app || '');
      const appB = normalizeScreenText(g.app || '');
      if (appA && appB && appA !== appB) continue;
      const titleA = normalizeScreenText(sc.title || '');
      const titleB = normalizeScreenText(g.title || '');
      if (titleA && titleB && titleA !== titleB) continue;
      const sim = jaccard(tokens, g.tokens);
      const contained = norm.includes(g.norm) || g.norm.includes(norm);
      const j = contained ? Math.max(sim, 0.9) : sim;
      if (j > bestSim) { bestSim = j; best = g; }
    }
    const at = String(sc.at || '');
    const source = String(sc.source || '');
    const device = String(sc.device || (source === 'phone' ? 'phone' : 'pc'));
    if (best && bestSim >= threshold) {
      best.count += 1;
      if (!best.firstAt || (at && at < best.firstAt)) best.firstAt = at;
      if (!best.lastAt || (at && at > best.lastAt)) best.lastAt = at;
      if (text.length > best.text.length) best.text = text.slice(0, maxText);
      if (!best.app && sc.app) best.app = String(sc.app);
      if (!best.title && sc.title) best.title = String(sc.title);
      if (source) best.sources.add(source);
      best.devices.add(device);
      best._norm = best._norm || norm;
      best._tokens = tokens;
    } else {
      groups.push({
        app: sc.app ? String(sc.app) : '',
        title: sc.title ? String(sc.title) : '',
        text: text.slice(0, maxText),
        count: 1,
        firstAt: at,
        lastAt: at,
        sources: new Set(source ? [source] : []),
        devices: new Set([device]),
        norm, tokens,
      });
    }
  }
  return groups
    .map((g) => ({ app: g.app, title: g.title, text: g.text, count: g.count, firstAt: g.firstAt, lastAt: g.lastAt,
      sources: Array.from(g.sources), devices: Array.from(g.devices) }))
    .sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));
}

/** 生成总结用的一行（含出现次数），供 prompt/markdown 复用。 */
export function formatScreenGroup(g, { excerpt = 140 } = {}) {
  const body = String((g && g.text) || '').replace(/\s+/g, ' ').slice(0, excerpt);
  const app = g && g.app ? '[' + g.app + '] ' : '';
  const title = g && g.title ? String(g.title).slice(0, 60) + '：' : '';
  const count = (g && g.count) || 1;
  const at = g && g.lastAt ? ' ' + String(g.lastAt).slice(11, 16) : '';
  return app + title + body + '（出现 ' + count + ' 次' + at + '）';
}
