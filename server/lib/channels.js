import { newId } from './ledger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LABELS = {
  'wechat-mock': '微信（模拟通道）',
  'email-mock': '邮件（模拟通道）',
  station: '站内',
};

export function createChannels({ ledger, state }) {
  const sends = [];
  const disabled = new Map();
  const limitPerMinute = 3;

  function recent() {
    const cutoff = Date.now() - 60000;
    while (sends.length && sends[0] < cutoff) sends.shift();
    return sends.length;
  }

  function disable(channel, reason) {
    disabled.set(channel, reason || '不可用');
  }

  async function deliver(taskId, { summary, link, sensitive }) {
    const order = ['wechat-mock', 'email-mock', 'station'];
    let fallbackNote = '';
    for (let i = 0; i < order.length; i += 1) {
      const ch = order[i];
      if (disabled.has(ch)) {
        ledger.append('task.deliveryAttempt', { taskId, channel: ch, status: 'unavailable', reason: disabled.get(ch) });
        fallbackNote = `通道不可用：${disabled.get(ch)}`;
        continue;
      }
      if (ch === 'wechat-mock' && recent() >= limitPerMinute) {
        ledger.append('task.deliveryAttempt', { taskId, channel: ch, status: 'limited', reason: '限流' });
        ledger.append('channel.retry', { taskId, channel: ch, attempt: 1, reason: '微信限流，排队重试' });
        await sleep(120);
        if (recent() >= limitPerMinute) {
          fallbackNote = '微信限流，已改邮件，延迟约 10 分钟';
          ledger.append('task.deliveryAttempt', { taskId, channel: ch, status: 'fallback', reason: fallbackNote });
          continue;
        }
      }
      const t0 = Date.now();
      const messageId = newId('msg');
      const latencyMs = Date.now() - t0;
      if (ch === 'wechat-mock') sends.push(Date.now());
      ledger.append('task.deliveryAttempt', { taskId, channel: ch, status: 'delivered', latencyMs });
      ledger.append('message.inbox', {
        messageId,
        taskId,
        channel: ch,
        channelLabel: LABELS[ch],
        title: fallbackNote ? '任务回执（已降级）' : '任务回执',
        summary: summary.slice(0, 200),
        link,
        status: 'delivered',
        sensitive: !!sensitive,
      });
      ledger.append('task.delivered', {
        taskId,
        channel: ch,
        messageId,
        summary: summary.slice(0, 200),
        link,
        latencyMs,
        status: fallbackNote ? 'degraded' : 'delivered',
        note: fallbackNote,
      });
      return { channel: ch, messageId, degraded: !!fallbackNote, note: fallbackNote };
    }
    ledger.append('task.deliveryAttempt', { taskId, channel: 'station', status: 'failed', reason: '无可用通道' });
    ledger.append('task.undelivered', { taskId, summary: summary.slice(0, 200) });
    return null;
  }

  return { deliver, disable, labels: LABELS, recent };
}