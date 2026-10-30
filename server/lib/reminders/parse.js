// V5 · 中文提醒时间解析：提醒我 21:30 开会 / 每天 8 点提醒我吃药 / 1 分钟后提醒我喝水 / 明天 9 点…
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
export function cnToInt(s) {
  const str = String(s || '').trim();
  if (!str) return NaN;
  if (/^\d+$/.test(str)) return Number(str);
  if (str === '十') return 10;
  if (str.length === 1) return CN_NUM[str] !== undefined ? CN_NUM[str] : NaN;
  if (/^十[一二三四五六七八九]$/.test(str)) return 10 + CN_NUM[str[1]];
  if (/^[一二三四五六七八九]十$/.test(str)) return CN_NUM[str[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(str)) return CN_NUM[str[0]] * 10 + CN_NUM[str[2]];
  return NaN;
}
function pad(n) { return String(n).padStart(2, '0'); }
function atMinutes(base, h, m, dayOffset = 0) {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
}

export function parseReminder(input, now = new Date()) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: '提醒内容不能为空' };
  const base = new Date(now);
  let text = raw;
  const daily = /每天|每日|天天/.test(raw);
  let recurrence = daily ? 'daily' : 'once';
  let at = null;
  let matched = '';

  // 1) 相对时间：X 秒/分钟/小时/天 后
  const rel = raw.match(/(\d{1,4}|[一二两三四五六七八九十]+)\s*(个)?\s*(秒|秒钟|分钟|分|小时|钟头|天|日)\s*(之?后|以后|后)/);
  if (rel) {
    const n = cnToInt(rel[1]);
    const unit = rel[3];
    const mult = /秒/.test(unit) ? 1000 : /分/.test(unit) ? 60000 : /小时|钟头/.test(unit) ? 3600000 : 86400000;
    at = new Date(Date.now() + (Number.isFinite(n) ? n : 1) * mult);
    recurrence = 'once';
    matched = rel[0];
  }
  // 2) 每天 HH 点 / 每天 HH:MM
  if (!at) {
    const tm = raw.match(/(?:每天|每日|天天)?\s*(上午|早上|早晨|下午|晚上|中午|凌晨)?\s*(\d{1,2}|[一二两三四五六七八九十]+)\s*(?:[:：点时])\s*(?:(\d{1,2})\s*分?)?/);
    if (tm) {
      let h = cnToInt(tm[2]);
      let m = tm[3] ? cnToInt(tm[3]) : 0;
      const period = tm[1] || '';
      if (Number.isFinite(h) && h >= 0 && h <= 24 && Number.isFinite(m) && m >= 0 && m < 60) {
        if (h === 24) h = 0;
        if ((period === '下午' || period === '晚上') && h < 12) h += 12;
        if (period === '中午' && h < 11) h += 12;
        if (period === '凌晨' && h === 12) h = 0;
        let dayOffset = 0;
        if (/明天|明日/.test(raw)) dayOffset = 1;
        at = atMinutes(base, h, m, dayOffset);
        if (recurrence !== 'daily' && at.getTime() <= base.getTime()) at = new Date(at.getTime() + 86400000);
        if (recurrence === 'daily' && at.getTime() <= base.getTime()) at = new Date(at.getTime() + 86400000);
        matched = tm[0];
      }
    }
  }
  // 3) 清理提醒内容：去掉触发词/时间短语
  text = raw
    .replace(/^.*?(?:提醒我|提醒一下|提醒|别忘了|记得|闹钟)[:：,，\s]*/g, '')
    .replace(matched, '')
    .replace(/(每天|每日|天天|明天|今日|今天)/g, '')
    .replace(/^[\s,，:：、]+|[\s,，:：、]+$/g, '')
    .trim();
  if (!text) text = raw.replace(/^.*?(?:提醒我|提醒一下|提醒|别忘了|记得|闹钟)[:：,，\s]*/g, '').trim() || raw;
  if (!at) return { ok: false, error: '没有识别到时间：可以说「提醒我 21:30 开会」或「1 分钟后提醒我喝水」', raw, recurrence, text };
  return { ok: true, raw, text, at: at.toISOString(), recurrence, matched, human: (daily ? '每天 ' : '') + pad(at.getHours()) + ':' + pad(at.getMinutes()) };
}

export function nextDailyIso(atIso, now = new Date()) {
  const d = new Date(atIso);
  do { d.setDate(d.getDate() + 1); } while (d.getTime() <= now.getTime());
  return d.toISOString();
}

export default { parseReminder, nextDailyIso, cnToInt };