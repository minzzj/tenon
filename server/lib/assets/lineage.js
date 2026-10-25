// 榫卯 v2 · 素材中心 · 谱系事件（只 append 契约 §3 的 asset.* 事件）
// 查询「来源 / 引用 / 被使用」：来自账本事件 + 现有 state.tasks + transfer 事件。
export const ASSET_EVENT_TYPES = ['asset.ingested', 'asset.tagged', 'asset.shared', 'asset.removed'];

export function createLineage({ ledger, getState = () => ({ tasks: {} }), actor = 'hub' } = {}) {
  if (!ledger || typeof ledger.append !== 'function') throw new Error('createLineage 需要 ledger');

  function append(type, data) {
    return ledger.append(type, data, actor);
  }

  function safeEvents() {
    return Array.isArray(ledger.events) ? ledger.events : [];
  }

  const api = {
    /** 契约 §3：asset.ingested {assetId,sha256,kind,name,size,source:{deviceId,path},at} */
    recordIngest(asset, at) {
      return append('asset.ingested', {
        assetId: asset.id,
        sha256: asset.sha256,
        kind: asset.kind,
        name: asset.name,
        size: asset.size,
        source: {
          deviceId: (asset.source && asset.source.deviceId) || 'hub',
          path: (asset.source && asset.source.path) || '',
        },
        at: at || asset.createdAt || new Date().toISOString(),
      });
    },

    /** 契约 §3：asset.tagged {assetId,tags,by:'ai'|'user'} */
    recordTag(assetId, tags, by = 'user') {
      return append('asset.tagged', {
        assetId,
        tags: Array.isArray(tags) ? [...tags] : [String(tags)],
        by: by === 'ai' ? 'ai' : 'user',
      });
    },

    /** 契约 §3：asset.shared {assetId,to,kind} */
    recordShare(assetId, to, kind = 'link') {
      return append('asset.shared', {
        assetId,
        to: String(to == null ? '' : to),
        kind: String(kind || 'link'),
      });
    },

    /** 契约 §3：asset.removed {assetId,reason} */
    recordRemove(assetId, reason = '') {
      return append('asset.removed', { assetId, reason: String(reason || '') });
    },
    /** 中转站变更（批量移除/清空后剩余条目）；state.js 的 basket.updated 分支消费 data.items。 */
    recordBasketUpdated(items) {
      return append('basket.updated', { items: Array.isArray(items) ? items : [] });
    },

    /** 某素材的全部谱系事件（按 seq 升序）。 */
    eventsFor(assetId) {
      return safeEvents()
        .filter((ev) => ev && ev.data && ev.data.assetId === assetId && ASSET_EVENT_TYPES.includes(ev.type))
        .map((ev) => ({ seq: ev.seq, type: ev.type, at: ev.at, actor: ev.actor, data: ev.data }));
    },

    /**
     * 引用/被使用：命中 state.tasks 中提及该素材（文件名/哈希/来源路径）的任务，
     * 以及 transfer.completed 中同 sha256 的文件条目。返回 { tasks, transfers }。
     */
    references(asset) {
      if (!asset) return { tasks: [], transfers: [] };
      const needles = [asset.sha256, asset.name, asset.source && asset.source.path]
        .filter((v) => typeof v === 'string' && v.length > 2)
        .map((v) => v.toLowerCase());
      const state = getState() || {};
      const tasks = [];
      for (const task of Object.values(state.tasks || {})) {
        if (!task) continue;
        let hay = '';
        try {
          hay = JSON.stringify({
            text: task.text,
            draft: task.draft,
            steps: task.steps,
            result: task.result,
            delivery: task.delivery,
          }).toLowerCase();
        } catch {
          hay = '';
        }
        if (needles.some((needle) => hay.includes(needle))) {
          tasks.push({ id: task.id, status: task.status, text: task.text, createdAt: task.createdAt || null });
        }
      }
      const transfers = [];
      for (const ev of safeEvents()) {
        if (!ev || ev.type !== 'transfer.completed' || !ev.data || !Array.isArray(ev.data.files)) continue;
        const hit = ev.data.files.filter((f) => f && f.sha256 && f.sha256 === asset.sha256);
        if (hit.length) {
          transfers.push({
            seq: ev.seq,
            at: ev.at,
            transferId: ev.data.transferId,
            peerId: ev.data.peerId,
            direction: ev.data.direction,
            files: hit.map((f) => ({ name: f.name, size: f.size })),
          });
        }
      }
      return { tasks, transfers };
    },

    /** 账本里所有素材事件（可选按时间/类型过滤，供审计导出的素材视图）。 */
    recent(limit = 100) {
      return safeEvents()
        .filter((ev) => ev && ASSET_EVENT_TYPES.includes(ev.type))
        .slice(-Math.max(1, Number(limit) || 100))
        .map((ev) => ({ seq: ev.seq, type: ev.type, at: ev.at, actor: ev.actor, data: ev.data }));
    },
  };

  return api;
}