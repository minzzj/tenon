# server/lib/enterprise/ · v2-P0 企业控制面

只写本目录；路由由 Lead 在 `server/lib/v2/index.js` 统一挂载（与 `server/lib/things/` 约定一致）。

## 集成（Lead）

```js
// server/lib/v2/index.js 已按此工厂调用（createEnterpriseService 在 MODULES 里）
const enterprise = await createEnterpriseService({
  root, ledger, state, ai, secret, readOnly, dataDir, authed,
});
const rs = enterprise.routes;              // route.path 相对 /api/v2（createV2 会剥前缀匹配）
// 若挂载方不剥 /api/v2 前缀：const rs = enterprise.absoluteRoutes;
for (const r of rs) mount(r.method, r.path, r.handler);
```

工厂兼容字段：

| 字段 | 说明 |
|---|---|
| `ledger` | 必填，`server/lib/ledger.js` 的 Ledger 实例 |
| `root` / `dataDir` | 数据写 `<dataDir>/enterprise/`（默认 `<root>/data/enterprise/`） |
| `state` | 可选，replay 后的状态；也用于自动接入 things 动作清单 |
| `secret` / `operatorToken` | 二选一；传入后本模块自校验 `x-tenon-token`。Lead 传 `secret`（含 operatorToken） |
| `authed` | 可选函数 `req => boolean`；Lead 传入后企业管理读接口与审计导出都要求令牌（fail-closed） |
| `readOnly` | 只读实例：企业写操作返回 423 |
| `listActions` | 可选，显式注入动作清单；不传时自动尝试 `../things/actions.js` 的 `listActions`（失败回落内置） |
| `identity` | 可选，身份适配器配置；默认只有 mock 可用 |

模块服务对象还导出：`gate()/requestApproval()/decideApproval()/listAuditEvents()/exportAudit()/describe()`，
供任务/场景引擎在执行前做企业鉴权（`gate` 返回 `allowed` / `approval_required` / `forbidden`）。

## 路由（路径相对 /api/v2）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/org/users` | 成员列表（不含邀请码；接线鉴权后需令牌） |
| POST | `/org/users` | 管理员建成员（返回 inviteCode）；带 inviteCode 为自助激活 |
| PATCH | `/org/users/:id` | 管理员改成员（角色/状态/成员级动作白名单） |
| GET | `/org/policy` | 读取策略（审批开关/保留 7-30-180/数据域） |
| PATCH | `/org/policy` | 管理员改策略（落盘 policy.json） |
| GET | `/approvals` | 审批列表（?status=pending/approved/rejected/all） |
| POST | `/approvals` | 发起审批请求 |
| POST | `/approvals/:id/decide` | 管理员通过/拒绝（不能自批） |
| GET | `/org/audit/export?format=csv\|json\|md` | 按保留期过滤的审计导出（始终需令牌） |
| GET | `/org/identity/providers` | 身份适配器清单（mock 可用；SSO/企业微信/钉钉待企业凭据） |
| GET | `/org/identity/:type/login-url` | 登录地址（mock 可用；真实类型未配置返回 409） |
| POST | `/org/identity/:type/callback` | 身份回调（mock 可验证） |
| GET | `/org/actions?userId=` | 动作白名单与角色权限（企业控制台 UI 用） |
| POST | `/org/actions/check` | 执行前检查（任务/场景引擎复用） |

## 账本事件

- 契约 §3：`enterprise.role.changed {userId,role}`、`approval.requested {requestId,action,by}`、`approval.decided {requestId,ok,by}`
- 任务卡要求的越权留痕：`enterprise.denied {userId,action,role,reason,route}` —— **契约 §3 之外的第 4 个企业事件，需 Lead 在 state.js 的 apply() 注册分支**（未注册也不会破坏 replay：state.js default 忽略未知事件）

## 数据文件（原子写）

- `data/enterprise/org.json`：成员/角色/邀请码（创建服务时自动种子管理员 u_admin）
- `data/enterprise/approvals.json`：审批请求（首次审批时生成）
- `data/enterprise/policy.json`：策略（首次 PATCH 时生成；未改过则用默认值）

## 角色默认动作

- admin：全部动作
- member：日常可逆动作 + 打印（不可逆，默认需审批）
- guest：只读，不授予动作（管理员可用成员级 `allowedActions.allow` 单独授权）

## 自测

```bash
node --test server/lib/enterprise/__tests__/enterprise.test.mjs   # 16 条
node server/lib/enterprise/__tests__/http-e2e.mjs                # 端口 7435，29 项检查
node server/lib/enterprise/__tests__/integration-v2.mjs          # 端口 7436，与 Lead createV2 真实挂载
```
