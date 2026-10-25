// 榫卯 Tenon v2 · link 模块 append 的账本事件类型（契约 v2-P0 §3 子集，字段固定）
// 说明：本模块只 append 下列事件；state.js 的二级状态分支由 Lead 统一添加。
export const LINK_EVENT_TYPES = [
  'link.peer.seen',      // {deviceId,name,platform,ip,port,at}
  'link.paired',         // {peerId,name,platform,fingerprint,by}
  'link.revoked',        // {peerId,reason}
  'transfer.started',    // {transferId,peerId,direction,files:[{name,size}],totalBytes}
  'transfer.completed',  // {transferId,peerId,direction,files:[{name,size,sha256,ok}],bytes,ms,speedBps}
  'transfer.failed',     // {transferId,reason}
  'clipboard.shared',    // {from,kind,preview,to?}
  'notification.relayed', // {from,app,title,preview}
];

export const LINK_EVENT_FIELDS = {
  'link.peer.seen': ['deviceId', 'name', 'platform', 'ip', 'port', 'at'],
  'link.paired': ['peerId', 'name', 'platform', 'fingerprint', 'by'],
  'link.revoked': ['peerId', 'reason'],
  'transfer.started': ['transferId', 'peerId', 'direction', 'files', 'totalBytes'],
  'transfer.completed': ['transferId', 'peerId', 'direction', 'files', 'bytes', 'ms', 'speedBps'],
  'transfer.failed': ['transferId', 'reason'],
  'clipboard.shared': ['from', 'kind', 'preview', 'to'],
  'notification.relayed': ['from', 'app', 'title', 'preview'],
};