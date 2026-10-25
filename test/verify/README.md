# test/verify · 独立验收装置（Checker 专用，勿改产品代码）

> 榫卯 Tenon 通宵优化循环的「独立检查智能体」验收装置。
> 所有结论来自真实执行：真实隔离实例 / 真实 HTTP / 真实 Chrome（python playwright channel=chrome）/ 真实电脑操作（安装脚本、第二个 node-agent）。
> 输出证据统一在 `_internal/checker/`，不写产品目录、不占 7410/7411。

## 0. 一键清单

| 装置 | 命令 | 覆盖 | 输出 |
|---|---|---|---|
| API 矩阵 | `node test/verify/run-api-matrix.js` | 自启隔离实例 7462 + 只读实例 7463；自动遍历 /api/v2 全部路由（当前 65 条）：GET 存活、写路由未登录 401、只读实例 423 且账本不变、未知 404、核心业务 happy/400/404 | `_internal/checker/api-matrix.json` |
| UI 全页巡检 | `python test/verify/run-ui-sweep.py [--phase B]` | 真实 Chrome：桌面 11 页（super/devices/assets/link/basket/scenes/enterprise×3/overview/audit）+ 手机 3 页（/m、/m/link、/m/assets）：渲染、JS 错误、console.error、关键 testid、v2 降级条、截图 | `_internal/checker/ui-sweep.json` + `_internal/checker/ui/<stamp>/*.png` |
| R2 验收（骨架→实现后直接跑） | `node test/verify/run-r2-acceptance.mjs` | 6 种故障注入（中枢停/7413 被占/跨网段 XFF/码过期/版本 header/数据目录只读）、二维码带参 v/exp/oneTime、手输码回归、20 次配对成功率、设备卡字段/重命名持久化、撤销预览+≤1s 失效+审计导出 | `_internal/checker/r2-acceptance.json` |
| R1 安装包验收 | `node test/verify/run-r1-install.mjs` | 真实 HTTP 下载/解压/内容校验（25 文件、install-meta、公开 meta 无令牌）/真实 PowerShell 安装（stdout JSON、config.json、install.log、自动注册）/重复安装幂等/5 种错误路径/真实卸载清理 | `_internal/checker/round1/install-verify.json` |
| R1 绑定 UI 验收 | `python test/verify/run-r1-bind-ui.py` | 真实第二 node-agent（独立 nodeId/数据目录）+ 真实 Chrome `#/devices`：安装区块/下载按钮/一键绑定（二次确认）/已绑定徽标/账本 device.bound/bindings.json/重复绑定幂等/一键解绑/device.unbound/权限矩阵（401/423/404/400） | `_internal/checker/round1/bind-ui.json` + `screenshots/` |
| R2 UI（骨架） | `python test/verify/run-r2-ui.py` | 真实 Chrome：#/link 先自检后二维码、手输码兜底、扫码自动配对→成功页 3 动作（发文件 ≤3 次点击）、设备卡字段/离线相对时间/重命名、撤销预览三级 | `_internal/checker/r2-ui.json` + `_internal/checker/r2-ui/<stamp>/*.png` |
| v2 基线（证据重定向副本） | `TENON_V2_PORT=7462 node test/verify/run-verify-v2-baseline.mjs` | 产品 `scripts/verify-v2.js` 同源副本（仅把证据目录改到 `_internal/checker/v2-baseline/`，避免覆盖仓库已提交证据） | 控制台 9/9 + `_internal/checker/v2-baseline/*.json` |
| v1 E2E 基线（证据重定向副本） | `TENON_E2E_PORT=7462 TENON_E2E_RO_PORT=7463 node test/verify/run-v1-e2e-baseline.mjs` | 产品 `test/e2e/run-real-browser.js` 同源副本（仅证据目录重定向），真实 Chrome/CDP 9 项 | 控制台 9/9 + `_internal/checker/e2e-baseline/` |

其余基线（由 Checker 记录真实结果）：
- `npm test`（146）
- v2 模块测试：`node --test server/lib/*/__tests__/*.test.mjs`（当前 65）
- `python _internal/tools/super_ui_test.py`（对运行中的 7410，14 项；该脚本末尾 print 在 GBK 控制台会崩，但 `_internal/ui-shots/ui-super.json` 已写入真实结果）
- 安装包/绑定/权限验收：见 `_internal/checker-round1.md`（Round1 Phase B）

## 1. 设计约定
- **隔离优先**：所有脚本自启 `TENON_PORT=7462`（只读 7463）+ `_internal/checker/tmp/...` 临时数据目录；结束 `taskkill /T /F` 清理。端口可用 env 覆盖（`TENON_VERIFY_PORT` 等）。
- **产物不进产品目录**：证据 JSON/截图/日志只写 `_internal/checker/`；产品脚本的「证据重定向副本」只改输出目录，不复制/修改产品逻辑。
- **SKIP 语义**：某轮功能未实现时，对应用例记 `SKIP` 并说明缺失路由/选择器，装置本身保持可用；只有断言失败记 `FAIL`。
- **退出码**：有 FAIL → 1；仅 SKIP/PASS → 0，便于 Lead 判定「有效果才提交」。
- **真实浏览器**：python playwright `p.chromium.launch(channel="chrome", headless=True)`（本机真实 Chrome），不使用 dsh 浏览器工具。

## 2. 目录
```
test/verify/
  run-api-matrix.js             # /api/v2 全量矩阵
  run-ui-sweep.py               # 桌面+手机真实浏览器巡检
  run-r2-acceptance.mjs         # Round2 验收骨架（故障注入/配对/设备/撤销）
  run-r2-ui.py                  # Round2 真实浏览器骨架
  run-verify-v2-baseline.mjs    # verify-v2.js 证据重定向副本
  run-v1-e2e-baseline.mjs       # v1 E2E 证据重定向副本
  README.md
_internal/checker/              # 运行产出的证据（gitignored 的 _internal 下）
```