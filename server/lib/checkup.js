import { newId } from './ledger.js';

const DAY = 86400000;

function daysBetween(a, b) {
  return Math.floor(Math.abs(b - a) / DAY);
}

export function runCheckup({ ledger, state, scope = 'all', integrity, aiAvailable, mode, now = Date.now() }) {
  const findings = [];
  const checked = [];
  const add = (level, title, detail, evidence) => findings.push({ level, title, detail, evidence });

  if (scope === 'all' || scope === 'devices') {
    checked.push('设备与模型');
    for (const node of Object.values(state.nodes)) {
      if (node.disconnected) continue;
      if (!node.online) {
        add('warning', `设备离线：${node.name}`, '保留上次状态，任务排队，不解绑', `lastSeen=${node.lastSeen || '未知'}`);
      }
      for (const cap of node.capabilities || []) {
        if (cap.compatible === false) {
          add('warning', `版本不兼容：${node.name} / ${cap.name}`, `需要 ${cap.required || '2.3'} 以上，当前 ${cap.current || '2.1'}`, `capability=${cap.id}`);
        }
        if (cap.authExpiresAt) {
          const exp = new Date(cap.authExpiresAt).getTime();
          if (exp < now) {
            add('warning', `授权已过期：${node.name} / ${cap.name}`, `授权已于 ${daysBetween(exp, now)} 天前到期，任务已暂停`, `authExpiresAt=${cap.authExpiresAt}`);
          } else if (exp - now < 30 * DAY) {
            add('notice', `授权将在 ${daysBetween(now, exp)} 天后到期`, `${node.name} / ${cap.name}`, `authExpiresAt=${cap.authExpiresAt}`);
          }
        }
        if (cap.authExpired) {
          add('warning', `授权已过期：${node.name} / ${cap.name}`, '授权已于 3 天前到期，任务已暂停', 'capability.authExpired');
        }
      }
    }
  }

  if (scope === 'all' || scope === 'auth') {
    checked.push('权限与角色');
    const pending = Object.values(state.tasks).filter((t) => t.status === 'pending');
    for (const t of pending) {
      const age = now - new Date(t.createdAt).getTime();
      if (age > DAY) add('warning', `待确认超过 ${daysBetween(0, age)} 小时的不可逆任务`, t.text.slice(0, 40), `task=${t.id}`);
    }
  }

  if (scope === 'all' || scope === 'channels') {
    checked.push('通道可用');
    const attempts = Object.values(state.tasks).flatMap((t) => t.deliveryAttempts || []);
    const limited = attempts.filter((a) => a.status === 'limited');
    if (limited.length) add('notice', '微信通道因限流被降级到邮件', `最近 ${limited.length} 次限流记录`, 'task.deliveryAttempt');
    const unavailable = attempts.filter((a) => a.status === 'unavailable');
    if (unavailable.length) add('warning', '通道不可用：账号异常', `最近 ${unavailable.length} 次失败记录`, 'task.deliveryAttempt');
  }

  if (scope === 'all') {
    checked.push('账本完整性');
    if (integrity && integrity.gaps && integrity.gaps.length) {
      add('blocked', '事件账本存在缺口', `检测到 ${integrity.gaps.length} 处缺口，已标记`, JSON.stringify(integrity.gaps.slice(0, 2)));
    }
    checked.push('任务健康');
    const undelivered = Object.values(state.tasks).filter((t) => t.status === 'succeeded' && !t.delivery);
    for (const t of undelivered.slice(0, 5)) {
      add('notice', '任务完成但未回传', t.text.slice(0, 40), `task=${t.id}`);
    }
    checked.push('AI 与外部依赖');
    if (!aiAvailable) add('notice', '未配置 AI API key', '草案走规则引擎；界面显示「未知」而不是猜测', 'env DEEPSEEK_API_KEY');
    if (mode === 'solo' && state.meta && state.meta.degraded) {
      add('notice', `降级模式：${state.meta.degraded.mode}`, state.meta.degraded.reason || '', 'system.degraded');
    }
    checked.push('数据与审计');
    if (state.meta && state.meta.diskFull) add('warning', '空间不足，摘要暂停，事件已保留', '磁盘写入失败时进入停写摘要模式', 'system.diskFull');
    const booted = state.boots && state.boots.length ? state.boots[state.boots.length - 1] : null;
    if (booted && !booted.stoppedAt) {
      add('notice', '检测到上次异常退出', `已按账本重放恢复，缺口事件已标记`, `boot@${booted.at}`);
    }
  }

  const checkupId = newId('chk');
  const verdict = findings.length ? 'findings' : 'none';
  const summary = verdict === 'none' ? `未发现问题，已检查 ${checked.length} 项` : `发现 ${findings.length} 项，按影响排序如下`;
  ledger.append('checkup.ran', {
    checkupId,
    scope,
    findings,
    verdict,
    checked: checked.length,
    items: checked,
    summary,
  });
  return { checkupId, verdict, findings, checked: checked.length, items: checked, summary };
}