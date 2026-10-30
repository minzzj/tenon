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
    link: { peers: {}, trusted: {}, transfers: {}, clipboard: null, notifications: [] },
    assets: { items: {}, shares: [], basket: [] },
    scenes: { items: {}, runs: [] },
    org: { users: {}, policy: {}, approvals: [], denied: [] },
    super: { asks: [], handoffs: [] },
    devices: { bindings: {} },
    voice: { transcripts: [], wake: null, commands: [], replies: [], diary: [] },
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
        pushStep(t, '待确认', d.reason || '断开被引用的设备后，相关任务降级为待确认');
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
      if (d.mode === 'normal' || d.mode === null) delete s.meta.degraded;
      else s.meta.degraded = { mode: d.mode, reason: d.reason, at: ev.at };
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
    case 'link.peer.seen': {
      s.link.peers[d.deviceId] = { ...d, seenAt: ev.at };
      break;
    }
    case 'link.paired': {
      s.link.trusted[d.peerId] = { peerId: d.peerId, name: d.name, platform: d.platform, fingerprint: d.fingerprint, by: d.by || '你', pairedAt: ev.at };
      break;
    }
    case 'link.revoked': {
      delete s.link.trusted[d.peerId];
      break;
    }
    case 'transfer.started': {
      s.link.transfers[d.transferId] = { id: d.transferId, transferId: d.transferId, peerId: d.peerId, direction: d.direction, files: d.files || [], totalBytes: d.totalBytes || 0, status: 'running', startedAt: ev.at };
      break;
    }
    case 'transfer.completed': {
      const t = s.link.transfers[d.transferId] || { id: d.transferId, transferId: d.transferId };
      Object.assign(t, { status: 'done', files: d.files || t.files, bytes: d.bytes || 0, ms: d.ms || 0, speedBps: d.speedBps || 0, completedAt: ev.at });
      s.link.transfers[d.transferId] = t;
      break;
    }
    case 'transfer.failed': {
      const tf = s.link.transfers[d.transferId] || { id: d.transferId, transferId: d.transferId };
      Object.assign(tf, { status: 'failed', reason: d.reason || '', failedAt: ev.at });
      s.link.transfers[d.transferId] = tf;
      break;
    }
    case 'clipboard.shared': {
      s.link.clipboard = { at: ev.at, from: d.from || '', to: d.to || '', kind: d.kind || 'text', preview: d.preview || '', text: d.text || '' };
      break;
    }
    case 'notification.relayed': {
      s.link.notifications.push({ at: ev.at, from: d.from || '', app: d.app || '', title: d.title || '', text: d.text || '' });
      if (s.link.notifications.length > 100) s.link.notifications = s.link.notifications.slice(-100);
      break;
    }
    case 'asset.ingested': {
      s.assets.items[d.assetId] = { assetId: d.assetId, sha256: d.sha256, kind: d.kind, name: d.name, size: d.size, source: d.source || null, tags: [], ocrText: d.ocrText || '', at: ev.at };
      break;
    }
    case 'asset.tagged': {
      const a = s.assets.items[d.assetId];
      if (a) a.tags = [...new Set([...(a.tags || []), ...(d.tags || [])])];
      break;
    }
    case 'asset.shared': {
      s.assets.shares.push({ at: ev.at, assetId: d.assetId, to: d.to, kind: d.kind || 'link' });
      break;
    }
    case 'asset.removed': {
      const ar = s.assets.items[d.assetId];
      if (ar) { ar.removed = true; ar.removedAt = ev.at; }
      break;
    }
    case 'basket.updated': {
      s.assets.basket = Array.isArray(d.items) ? d.items : [];
      break;
    }
    case 'scene.defined': {
      s.scenes.items[d.sceneId] = { sceneId: d.sceneId, name: d.name, steps: d.steps || [], at: ev.at };
      break;
    }
    case 'scene.ran': {
      s.scenes.runs.push({ at: ev.at, sceneId: d.sceneId, by: d.by || '你', ok: d.ok !== false, result: d.result || '' });
      if (s.scenes.runs.length > 100) s.scenes.runs = s.scenes.runs.slice(-100);
      break;
    }
    case 'org.user.changed': {
      s.org.users[d.userId] = { userId: d.userId, name: d.name || d.userId, role: d.role || 'member', at: ev.at };
      break;
    }
    case 'voice.transcript': {
      s.voice.transcripts.push({ at: ev.at, text: d.text || '', source: d.source || 'mic', wake: !!d.wake, sensitive: !!d.sensitive });
      if (s.voice.transcripts.length > 500) s.voice.transcripts = s.voice.transcripts.slice(-500);
      break;
    }
    case 'voice.wake': {
      s.voice.wake = { at: ev.at, word: d.word || '', text: d.text || '' };
      break;
    }
    case 'voice.command': {
      s.voice.commands.push({ at: ev.at, text: d.text || '', reply: d.reply || '', actions: d.actions || [], ok: d.ok !== false, provider: d.provider || '' });
      if (s.voice.commands.length > 200) s.voice.commands = s.voice.commands.slice(-200);
      break;
    }
    case 'voice.reply': {
      s.voice.replies.push({ at: ev.at, text: d.text || '', tts: !!d.tts });
      if (s.voice.replies.length > 200) s.voice.replies = s.voice.replies.slice(-200);
      break;
    }
    case 'voice.diary': {
      s.voice.diary.push({ at: ev.at, date: d.date || '', kind: d.kind || 'diary', path: d.path || '', summary: d.summary || '' });
      if (s.voice.diary.length > 100) s.voice.diary = s.voice.diary.slice(-100);
      break;
    }
    case 'voice.screen': {
      // 24/7 屏幕/窗口文本记录（仅保留最近 300 条在内存态，全文在 data/voice/transcripts）
      if (!s.voice.screenLog) s.voice.screenLog = [];
      s.voice.screenLog.push({ at: ev.at, kind: d.kind || 'screen', text: (d.text || '').slice(0, 500), app: d.app || '' });
      if (s.voice.screenLog.length > 300) s.voice.screenLog = s.voice.screenLog.slice(-300);
      break;
    }
    case 'device.bound': {
      s.devices.bindings[d.deviceId] = { deviceId: d.deviceId, name: d.name || d.deviceId, by: d.by || '你', at: ev.at };
      break;
    }
    case 'device.unbound': {
      delete s.devices.bindings[d.deviceId];
      break;
    }
    case 'device.action': {
      // 一键操作审计（仅记录，供 UI 展示最近动作）
      s.devices.lastAction = { at: ev.at, deviceId: d.deviceId || '', action: d.action || '', result: d.result || '' };
      break;
    }
    case 'super.asked': {
      s.super.asks.push({ at: ev.at, text: d.text || '', reply: d.reply || '', plan: d.plan || [], result: d.result || null, needsConfirm: !!d.needsConfirm });
      if (s.super.asks.length > 100) s.super.asks = s.super.asks.slice(-100);
      break;
    }
    case 'super.handoff': {
      s.super.handoffs.push({ at: ev.at, handoffId: d.handoffId || '', kind: d.kind || 'page', payload: d.payload || d, from: d.fromDevice || '', to: d.toDevice || 'desktop', text: d.text || '', url: d.url || '', assetId: d.assetId || '', dispatched: !!d.dispatched });
      if (s.super.handoffs.length > 100) s.super.handoffs = s.super.handoffs.slice(-100);
      break;
    }
    case 'enterprise.role.changed': {
      s.org.users[d.userId] = { userId: d.userId, name: d.name || (s.org.users[d.userId] && s.org.users[d.userId].name) || d.userId, role: d.role || 'member', at: ev.at };
      break;
    }
    case 'org.policy.changed': {
      Object.assign(s.org.policy, d.policy || {});
      break;
    }
    case 'approval.requested': {
      s.org.approvals.push({ at: ev.at, requestId: d.requestId, action: d.action, by: d.by || '', status: 'pending' });
      break;
    }
    case 'approval.decided': {
      const ap = s.org.approvals.find((x) => x.requestId === d.requestId);
      if (ap) { ap.status = d.ok ? 'approved' : 'rejected'; ap.decidedBy = d.by; ap.decidedAt = ev.at; }
      break;
    }
    case 'enterprise.denied': {
      s.org.denied.push({ at: ev.at, userId: d.userId || '', action: d.action || '', reason: d.reason || '' });
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
  const link = state.link || { peers: {}, trusted: {}, transfers: {}, clipboard: null, notifications: [] };
  const assets = state.assets || { items: {}, shares: [], basket: [] };
  const scenes = state.scenes || { items: {}, runs: [] };
  const org = state.org || { users: {}, policy: {}, approvals: [], denied: [] };
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
    v2: {
      link: {
        peers: Object.values(link.peers || {}),
        trusted: Object.values(link.trusted || {}),
        transfers: Object.values(link.transfers || {}).slice(-20).reverse(),
        clipboard: link.clipboard,
        notifications: (link.notifications || []).slice(-20).reverse(),
      },
      assets: {
        count: Object.values(assets.items || {}).filter((a) => !a.removed).length,
        recent: Object.values(assets.items || {}).filter((a) => !a.removed).slice(-12).reverse(),
        shares: (assets.shares || []).slice(-10).reverse(),
        basket: assets.basket || [],
      },
      scenes: { items: Object.values(scenes.items || {}), runs: (scenes.runs || []).slice(-10).reverse() },
      voice: {
        transcripts: ((state.voice && state.voice.transcripts) || []).slice(-20).reverse(),
        screenLog: ((state.voice && state.voice.screenLog) || []).slice(-10).reverse(),
        wake: (state.voice && state.voice.wake) || null,
        commands: ((state.voice && state.voice.commands) || []).slice(-10).reverse(),
        replies: ((state.voice && state.voice.replies) || []).slice(-10).reverse(),
        diary: ((state.voice && state.voice.diary) || []).slice(-5).reverse(),
      },
      devices: {
        bindings: Object.values((state.devices && state.devices.bindings) || {}),
        lastAction: (state.devices && state.devices.lastAction) || null,
      },
      super: {
        asks: (state.super && state.super.asks ? state.super.asks : []).slice(-10).reverse(),
        handoffs: (state.super && state.super.handoffs ? state.super.handoffs : []).slice(-10).reverse(),
      },
      org: {
        users: Object.values(org.users || {}),
        policy: org.policy || {},
        approvals: (org.approvals || []).slice(-20).reverse(),
        denied: (org.denied || []).slice(-20).reverse(),
      },
    },
    meta: state.meta,
    seq: state.seq,
    ...extra,
  };
}

export { stable };
