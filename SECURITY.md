# Security policy / 安全策略

## Reporting

Please report vulnerabilities **privately** via GitHub Security Advisories on the repository (Security → Report a vulnerability), or by opening an issue that contains no exploit details and asking for a private channel. Do not publish a working exploit before a fix is available.

## Design commitments（设计承诺）

- **Local by default**: the hub listens on `127.0.0.1` unless the operator explicitly enables LAN mode. No vendor cloud, no telemetry.
- **Write protection**: state-changing HTTP calls require an operator token; the token is generated locally on first run and never committed.
- **Shortest data path**: message callbacks carry a summary and a link only; the body of results stays on the local ledger and requires login to read.
- **No secrets in the repository**: API keys are read from environment variables or a local, git-ignored config file. CI runs a secret scan.
- **Honest degradation**: when a capability, channel or model is unavailable, the UI shows the degraded state; it never silently pretends success.

## Supported versions

v0.1.x receives security fixes while it is the current milestone.

---

## 中文

**报告**：请通过仓库的 GitHub Security Advisories（Security → Report a vulnerability）私下报告，或开一个不含利用细节的 Issue 申请私下渠道。修复发布前请勿公开可用利用。

**设计承诺**：默认只监听 `127.0.0.1`，不开遥测；写操作要求本地生成的令牌；回传只发摘要+链接，正文留在本地账本且需登录查看；密钥只从环境变量/本地忽略文件读取；能力/通道/模型不可用时界面显式降级，绝不静默假装成功。v0.1.x 为当前维护版本。