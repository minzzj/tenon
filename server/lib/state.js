import { stable } from './ledger.js';

export function replay(events) {
  const s = {
    nodes: {},
    tasks: {},
    messages: [],
    checkups: [],
    impacts: [],
    audit: [],
    recovery: [],
    boots: [],
    aiUsage: { calls: 0, tokensIn: 0, tokensOut: 0, cached: 0, places: {} },
    meta: { mode: 'solo', domain: 'studio', domainLabel: '工作室数据域', startedAt: null },
    loops: [],
    drills: [],
    seq: 0,
    dataAsOf: null,
    startedAt: null,
  };
  for (const ev of events) apply(ev, s);
  s.seq = events.length ? events[events.length - 1].seq : 0;
  s.dataAsOf = events.length ? events[events.length - 1].at : null;
  return s;
}

function task(s, id) {
  return s.tasks[id];
}

let currentAt = null;

function pushStep(t, label, detail, at) {
  t.steps.push({ at: at || currentAt || new Date().toISOString(), label, detail: detail || '' });
}

function apply(ev, s) {
  const d = ev.data || {};
  currentAt = ev.at;
  switch (ev.type) {
    case 'node.registered': {
      const old = s.nodes[d.nodeId];
      s.nodes[d.nodeId] = {
        ...(old || {}),
        id: d.nodeId,
        name: d.name,
        platform: d.platform,
        fingerprint: d.fingerprint,
        capabilities: JSON.parse(JSON.stringify(d.capabilities || [])),
        online: true,
        lastSeen: ev.at,
        registeredAt: ev.at,
        evidence: 'confirmed',
        hidden: old ? old.hidden : false,
        disconnected: false,
        domain: d.domain || s.meta.domain,
        kind: 'node',
      };
      break;
    }
    case 'device.imported': {
      s.nodes[d.nodeId] = {
        id: d.nodeId,
        name: d.name,
        platform: d.platform || 'simulated',
        fingerprint: d.fingerprint,
        capabilities: JSON.parse(JSON.stringify(d.capabilities || [])),
        online: d.online !== false,
        lastSeen: ev.at,
        registeredAt: ev.at,
        evidence: d.evidence || 'declared',
        hidden: false,
        disconnected: false,
        domain: d.domain || s.meta.domain,
        kind: 'imported',
      };
      break;
    }
    case 'node.heartbeat': {
      const n = s.nodes[d.nodeId];
      if (n) {
        n.online = true;
        n.lastSeen = ev.at;
      }
      break;
    }
    case 'node.offline': {
      const n = s.nodes[d.nodeId];
      if (n) {
        n.online = false;
        n.offlineSince = d.since || ev.at;
      }
      break;
    }
    case 'device.renamed': {
      const n = s.nodes[d.nodeId];
      if (n) {
        n.aliases = n.aliases || [];
        n.aliases.push(d.from);
        n.name = d.to;
      }
      break;
    }
    case 'device.hidden': {
      const n = s.nodes[d.nodeId];
      if (n) n.hidden = !!d.hidden;
      break;
    }
    case 'device.disconnected': {
      const n = s.nodes[d.nodeId];
      if (n) {
        n.disconnected = true;
        n.online = false;
        n.tombstoneAt = ev.at;
      }
      break;
    }
    case 'device.movedOutOfDomain': {
      const n = s.nodes[d.nodeId];
      if (n) {
        n.domain = 'outside';
        n.readOnly = true;
      }
      break;
    }
    case 'capability.registered': {
      break;
    }
    case 'capability.authExpired': {
      const n = s.nodes[d.nodeId];
      if (n) {
        for (const c of n.capabilities) if (c.id === d.capabilityId) c.authExpired = true;
      }
      break;
    }
    case 'capability.versionMismatch': {
      const n = s.nodes[d.nodeId];
      if (n) {
        for (const c of n.capabilities) if (c.id === d.capabilityId) {
          c.compatible = false;
          c.required = d.required;
          c.current = d.current;
        }
      }
      break;
    }
    case 'task.drafted': {
      s.tasks[d.taskId] = {
        id: d.taskId,
        text: d.text,
        status: d.draft && d.draft.risk && d.draft.risk.level === 'irreversible' ? 'pending' : 'draft',
        draft: d.draft,
        risk: d.draft ? d.draft.risk : null,
        requester: d.requester || '你',
        source: d.source || 'desktop',
        capabilityId: d.draft && d.draft.capabilities && d.draft.capabilities[0] ? d.draft.capabilities[0].id : null,
        nodeId: d.draft && d.draft.targetDevice ? d.draft.targetDevice.id : null,
        createdAt: ev.at,
        updatedAt: ev.at,
        steps: [{ at: ev.at, label: '草案已生成', detail: d.draft ? d.draft.summary : '' }],
        result: null,
        delivery: null,
        evidenceLevel: d.evidenceLevel || 'possible',
        ai: d.ai || null,
        missing: d.draft ? d.draft.missing || [] : [],
        rejectReason: null,
        manualOnly: !!(d.draft && d.draft.capabilities && d.draft.capabilities[0] && d.draft.capabilities[0].manualOnly),
      };
      break;
    }
    case 'task.confirmed': {
      const t = task(s, d.taskId);
      if (t) {
        t.confirmedAt = ev.at;
        t.confirmedBy = d.confirmedBy || '你';
        t.updatedAt = ev.at;
        pushStep(t, '已确认', d.note || '由发起人确认');
      }
      break;
    }
    case 'task.rejected': {
      const t = task(s, d.taskId);
      if (t) {
        t.status = 'cancelled';
        t.rejectReason = d.reason || '未填写';
        t.updatedAt = ev.at;
        pushStep(t, '已拒绝', '原因：' + t.rejectReason);
      }
      break;
    }
    case 'task.queued': {
      const t = task(s, d.taskId);
      if (t) {
        t.status = 'queued';
        t.nodeId = d.nodeId || t.nodeId;
        t.updatedAt = ev.at;
        pushStep(t, '已排队', d.note || '等待目标设备接单');
      }
      break;
    }
    case 'task.started': {
      const t = task(s, d.taskId);
      if (t) {
        t.status = 'running';
        t.startedAt = ev.at;
        t.updatedAt = ev.at;
        pushStep(t, '开始执行', (d.nodeName || d.nodeId || '') + ' 接单');
      }
      break;
    }
    case 'task.step': {
      const t = task(s, d.taskId);
      if (t) {
        pushStep(t, d.label, d.detail, ev.at);
        t.updatedAt = ev.at;
      }
      break;
    }
    case 'task.succeeded': {
      const t = task(s, d.taskId);
      if (t) {
        t.status = 'succeeded';
        t.result = d.result || null;
        t.updatedAt = ev.at;
        pushStep(t, d.result && d.result.partial ? '部分成功' : '执行完成', d.result ? d.result.summary : '');
      }
      break;
    }
    case 'task.failed': {
      const t = task(s, d.taskId);
      if (t) {
        t.status = 'failed';
        t.error = d.error;
        t.updatedAt = ev.at;
        pushStep(t, '执行失败', d.error || '');
      }
      break;
    }
    case 'task.timeout': {
      const t = task(s, d.taskId);
      if (t) {
        t.status = 'timeout';
        t.updatedAt = ev.at;
        pushStep(t, '执行超时', (d.durationMs ? Math.round(d.durationMs / 1000) + ' 秒' : '') + '，现场已保留');
      }
      break;
    }
    case 'task.cancelled': {
      const t = task(s, d.taskId);
      if (t) {
        t.status = 'cancelled';
        t.updatedAt = ev.at;
        pushStep(t, '已取消', '前 ' + (d.completedSteps || 0) + ' 步已完成，不回滚');
      }
      break;
    }
    case 'task.retry': {
      const t = task(s, d.taskId);
      if (t) {
        t.status = 'queued';
        t.retries = (t.retries || 0) + 1;
        t.updatedAt = ev.at;
        pushStep(t, '重试', '第 ' + t.retries + ' 次重试');
      }
      break;
    }
    case 'task.needsConfirm': {
      const t = task(s, d.taskId);
      if (t) {
        t.status = 'pending';
        t.needsReview = true;
        t.updatedAt = ev.at;
        pushStep(t, '待确认：设备已断开', d.reason || '断开被引用的设备后，相关任务降级为待确认');
      }
      break;
    }
    case 'task.deliveryAttempt': {
      const t = task(s, d.taskId);
      if (t) {
        t.deliveryAttempts = t.deliveryAttempts || [];
        t.deliveryAttempts.push({ at: ev.at, channel: d.channel, status: d.status, reason: d.reason || '', latencyMs: d.latencyMs || 0 });
        pushStep(t, '回传尝试', `${d.channel} · ${d.status}${d.reason ? ' · ' + d.reason : ''}`);
      }
      break;
    }
    case 'task.delivered': {
      const t = task(s, d.taskId);
      if (t) {
        t.delivery = { channel: d.channel, messageId: d.messageId, summary: d.summary, link: d.link, latencyMs: d.latencyMs, status: d.status || 'delivered' };
        t.deliveredAt = ev.at;
        t.updatedAt = ev.at;
        pushStep(t, '已回传', d.channel + ' · ' + (d.status || 'delivered'));
      }
      break;
    }
    case 'task.undelivered': {
      const t = task(s, d.taskId);
      if (t) {
        t.delivery = { channel: d.channel || null, status: 'undelivered', summary: d.summary || '' };
        t.updatedAt = ev.at;
        pushStep(t, '未送达', '站内可查');
      }
      break;
    }
    case 'message.inbox': {
      s.messages.push({
        id: d.messageId,
        taskId: d.taskId,
        channel: d.channel,
        channelLabel: d.channelLabel || d.channel,
        title: d.title || '任务回执',
        summary: d.summary,
        link: d.link,
        status: d.status || 'delivered',
        at: ev.at,
        sensitive: !!d.sensitive,
      });
      break;
    }
    case 'checkup.ran': {
      s.checkups.push({
        id: d.checkupId,
        at: ev.at,
        scope: d.scope,
        findings: d.findings || [],
        verdict: d.verdict,
        checked: d.checked,
        summary: d.summary,
      });
      break;
    }
    case 'impact.previewed': {
      s.impacts.push({ at: ev.at, deviceId: d.deviceId, counts: d.counts, sentence: d.sentence });
      break;
    }
    case 'ai.called': {
      s.aiUsage.calls += 1;
      s.aiUsage.tokensIn += d.tokensIn || 0;
      s.aiUsage.tokensOut += d.tokensOut || 0;
      if (d.cached) s.aiUsage.cached += 1;
      s.aiUsage.places[d.place] = (s.aiUsage.places[d.place] || 0) + (d.tokensIn || 0) + (d.tokensOut || 0);
      s.aiUsage.last = { at: ev.at, place: d.place, provider: d.provider, model: d.model, tokens: (d.tokensIn || 0) + (d.tokensOut || 0), cached: !!d.cached };
      break;
    }
    case 'system.boot': {
      s.boots.push({ at: ev.at, seq: ev.seq, pid: d.pid, mode: d.mode, recovered: !!d.recovered });
      if (!s.startedAt) s.startedAt = ev.at;
      s.meta.mode = d.mode || s.meta.mode;
      break;
    }
    case 'system.stopped': {
      if (s.boots.length) s.boots[s.boots.length - 1].stoppedAt = ev.at;
      break;
    }
    case 'system.modeChanged': {
      s.meta.mode = d.mode;
      s.meta.domainLabel = d.domainLabel || s.meta.domainLabel;
      break;
    }
    case 'system.crashRecovery': {
      s.recovery.push({ at: ev.at, gapMs: d.gapMs || 0, tasksResumed: d.tasksResumed || [], note: d.note });
      break;
    }
    case 'system.degraded': {
      s.meta.degraded = { mode: d.mode, reason: d.reason, at: ev.at };
      break;
    }
    case 'system.diskFull': {
      s.meta.diskFull = d.full !== false;
      break;
    }
    case 'loop.blocked': {
      s.loops.push({ at: ev.at, chain: d.chain, message: d.message });
      break;
    }
    case 'drill.ran': {
      s.drills.push({ at: ev.at, kind: d.kind, detail: d.detail || '' });
      break;
    }
    case 'audit.exported': {
      s.audit.push({ at: ev.at, format: d.format, count: d.count, by: d.by || '你' });
      break;
    }
    case 'role.insufficient': {
      s.meta.lastRoleError = { at: ev.at, need: d.need, message: d.message };
      break;
    }
    default:
      break;
  }
}

export function relations(state) {
  const out = [];
  for (const t of Object.values(state.tasks)) {
    if (!t.capabilityId) continue;
    const node = state.nodes[t.nodeId] || null;
    const cap = node && node.capabilities ? node.capabilities.find((c) => c.id === t.capabilityId) : null;
    out.push({
      taskId: t.id,
      task: t,
      capabilityId: t.capabilityId,
      capability: cap,
      nodeId: t.nodeId,
      nodeName: node ? node.name : '未知设备',
      evidenceLevel: t.evidenceLevel || (node && node.evidence === 'confirmed' ? 'certain' : 'possible'),
      evidence: [
        `task.drafted @ ${t.createdAt}`,
        ...(t.steps || []).slice(-2).map((x) => `${x.label} @ ${x.at}`),
      ],
    });
  }
  return out;
}

export function recentCalls(state, capabilityId, n = 3) {
  return Object.values(state.tasks)
    .filter((t) => t.capabilityId === capabilityId && ['succeeded', 'failed', 'timeout'].includes(t.status))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, n);
}

export function onlineNodes(state) {
  return Object.values(state.nodes).filter((n) => n.online && !n.disconnected && !n.hidden);
}

export function impact(state, deviceId) {
  const node = state.nodes[deviceId];
  const deviceName = node ? node.name : deviceId;
  const rels = relations(state).filter((r) => r.nodeId === deviceId);
  const certain = [];
  const possible = [];
  const unknown = [];
  for (const r of rels) {
    const st = r.task.status;
    if (['pending', 'queued', 'running', 'draft'].includes(st)) {
      if (r.evidenceLevel === 'certain' && node && node.evidence === 'confirmed') certain.push(r.taskId);
      else possible.push(r.taskId);
    } else if (['succeeded', 'failed', 'timeout'].includes(st)) {
      possible.push(r.taskId);
    } else {
      unknown.push(r.taskId);
    }
  }
  if (!rels.length) unknown.push('（该设备的能力关系无证据，仅可人工确认）');
  const sentence = `确定 ${certain.length} 条、可能 ${possible.length} 条、未知 ${unknown.length} 条`;
  return {
    deviceId,
    deviceName,
    counts: { certain: certain.length, possible: possible.length, unknown: unknown.length },
    certain,
    possible,
    unknown,
    sentence,
    note: '没有记录不等于没有引用：无记录时只能人工确认。',
  };
}

export function snapshot(state, extra = {}) {
  return {
    mode: state.meta.mode,
    domainLabel: state.meta.domainLabel,
    dataAsOf: state.dataAsOf,
    nodes: Object.values(state.nodes),
    tasks: Object.values(state.tasks).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
    messages: state.messages.slice().reverse(),
    checkups: state.checkups.slice().reverse(),
    aiUsage: state.aiUsage,
    recovery: state.recovery,
    drills: state.drills,
    loops: state.loops,
    audit: state.audit,
    impacts: state.impacts.slice(-5).reverse(),
    meta: state.meta,
    seq: state.seq,
    ...extra,
  };
}

export { stable };
