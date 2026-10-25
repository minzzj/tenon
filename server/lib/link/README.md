# 榫卯 Tenon v2 · 连接层（link-core）

零依赖（只用 `node:` 内置模块）的手机 ↔ 电脑连接层：UDP 局域网发现、6 位配对码 + QR、信任设备、分块断点续传（SHA-256 校验）、剪贴板与通知转发。

## 1. 快速集成（Lead 在 `server/lib/http.js` 挂载）

```js
import { createLinkService, routes, matchRoutes } from './link/index.js';

const link = createLinkService({ ledger, state, root, dataDir, port, host, tokens: secret });

// 在 handleApi 里（或 createV2Router 中）：
const matched = matchRoutes(routes, req.method, pathname);
if (matched) {
  return matched.route.handler(req, res, {
    link,                       // 必填：handler 从这里拿服务实例
    params: matched.params,     // 必填：/transfer/:id/chunk 的 :id
    query: url.searchParams,    // 可选：handler 会自己从 req.url 兜底
  });
}
```

- `createLinkService(opts)` 返回的服务包含 `routes`（已绑定实例，可直接 `service.routes`）、`pairing`、`transfer`、`clipboard`、`notifier`、`discovery`、`authorize(req)`、`info()`、`peersInfo()`、`close()`。
- 只读实例（v0.1 的 `readOnly`）建议整体不挂载写路由或统一 423；本层写操作都要求令牌。
- UDP 发现默认绑定 7413；测试/同机联调用 `unicastTargets: ['127.0.0.1:7434']`。
- 不传 `ledger` 时不写账本（dry-run/单测用）；传了才 append 契约 §3 事件。

## 2. 导出的 routes（最终清单）

| method | path | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v2/link/info` | 匿名 | 本机身份/端口/发现状态（`deviceId/name/platform/version/port/discovery/pairing`） |
| GET | `/api/v2/link/peers` | 匿名 | 发现到的 + 已信任的设备（合并视图） |
| GET | `/api/v2/link/pair/qr` | operator | 当前配对码 + QR payload（`tenon://pair?host=IP:PORT&code=XXXX&fp=...`） |
| POST | `/api/v2/link/pair/regenerate` | operator | 重新生成配对码 |
| POST | `/api/v2/link/pair` | 入站匿名 / 出站 operator | 入站：body `{code, from:{deviceId,...}}` 或 Android 只带 `{code, deviceId?, name?, platform?}`；成功响应含 `{ok, peerId(=hub), name, platform, token}`；出站：body `{code, host, port}`（operator，本机主动调对端） |
| POST | `/api/v2/link/revoke` | operator / peer（仅自己） | 撤销信任（会尽力通知对端一起移除） |
| POST | `/api/v2/link/transfer/init` | peer / operator | body `{peerId,direction:'to-desktop'\|'from-desktop',files:[{name,size,sha256}]}` → `{transferId,chunkSize}` |
| PUT | `/api/v2/link/transfer/:id/chunk?offset=&file=` | peer / operator | 二进制分块，写 `<data>/link/transfers/<id>/fN.part` |
| GET | `/api/v2/link/transfer/:id` | peer / operator | 传输状态/已接收字节/速度 |
| POST | `/api/v2/link/transfer/:id/finish` | peer / operator | 校验 SHA-256 + 原子改名；`from-desktop` 直接完成，`to-desktop` 变 ready 等 ack |
| GET | `/api/v2/link/transfers?nodeId=&state=incoming` | operator | 桌面 Agent 拉取待接收列表（`incoming` = 已校验待 ack） |
| GET | `/api/v2/link/transfer/:id/file?index=` | operator（或该传输的 peer） | 二进制下载（Content-Type/Content-Length/Content-Disposition） |
| GET | `/api/v2/link/transfer/:id/download?index=` | 同上 | **Android 兼容别名**：同 file（完整文件二进制） |
| GET | `/api/v2/link/transfer/:id/chunk?offset=0` | 同上 | **Android 兼容别名**：GET 同一路径返回完整文件二进制（上传仍是 PUT） |
| POST | `/api/v2/link/transfer/:id/ack` | operator | 桌面保存后 ack：body `{nodeId,saved:[{name,path,sha256,ok}],ok}` → **append transfer.completed** |
| POST | `/api/v2/link/transfer/send` | operator | 本机把本地文件分块推给对端：`{peerId,path,name?,direction?,maxBytes?}` |
| POST | `/api/v2/link/transfer/resume` | operator | 断点续传：`{peerId,transferId,path,...}` |
| POST | `/api/v2/link/clipboard` | peer / operator | body `{kind:'text'\|'link'\|'files', text?, from?, to?}` → `clipboard.shared` |
| GET | `/api/v2/link/clipboard/latest?for=` | peer / operator | `{ok, clipboard:{at,from,kind,preview,text}\|null}` |
| POST | `/api/v2/link/notification` | peer / operator | body `{from,app,title,text}` → `notification.relayed` |
| POST | `/api/v2/link/notify` | peer / operator | **Android 兼容别名**：同 notification |
| GET | `/api/v2/link/notifications?limit=` | peer / operator | 最近通知镜像列表 |

鉴权：`x-tenon-token` 头（或 `tenon_token` cookie）。operator 令牌来自 `data/secrets.json` 的 `operatorToken`；配对后双方各持一个 peerToken（对端调用本机时用），无需暴露给前端。

## 3. 账本事件（只 append，契约 §3）

`link.peer.seen`、`link.paired`、`link.revoked`、`transfer.started`、`transfer.completed`、`transfer.failed`、`clipboard.shared`、`notification.relayed`。
字段见 `events.js`；`state.js` 的二级状态分支由 Lead 统一添加（本层不改 state.js）。

## 4. 数据落盘

```
<dataDir>/link/device.json       本机设备身份（deviceId / name / platform / fingerprint）
<dataDir>/link/trust.json        信任设备（含双向 peerToken，勿外传；revoke 后删除）
<dataDir>/link/transfers/<id>/   meta.json + fN.part（断点续传临时文件）
<dataDir>/link/transfers/received/  校验通过后原子 rename 的正式文件
<dataDir>/link/clipboard.json    最近 50 条剪贴板
<dataDir>/link/notifications.json 最近 50 条通知镜像
```

## 5. 自测

```bash
node --test "server/lib/link/__tests__/link.test.mjs"
```

覆盖配对码/QR、入站配对+持久化、撤销（双向）、分块传输+SHA-256+速度、断点续传、校验失败、`to-desktop` 的 incoming 列表/文件下载/ack 完成事件、剪贴板、通知、UDP 发现，以及**两台本机进程真实 UDP + HTTP 8MB 传输**（报告速度）。测试只用 7431/7432（HTTP）与 7433/7434（UDP），不占用 7410/7411。