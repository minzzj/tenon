# Contributing to Tenon / 参与贡献

Thanks for helping. The project is at v0.1.0 milestone; the most useful contributions right now are bug reports from **real usage** (real device, real browser), boundary cases from the product spec, and translations.

## Ground rules

- **Every claim needs evidence.** "It works" is not a test result: attach the command, the log line or the screenshot.
- **Unknown is a valid answer.** If a parser cannot prove a relationship, the UI must show *unknown* — never guess.
- **No regressions in the boundary table.** Edge cases in `docs/假设与未覆盖清单.md` are part of the product, not optional extras.
- **Keep it local-first.** No CDN, no external fonts, no telemetry, no vendor cloud by default.

## Workflow

1. Open an issue describing the user-visible problem (what you did, what happened, what you expected).
2. For code: fork → branch (`fix/<topic>` / `feat/<topic>`) → keep changes small and scoped.
3. Run `node --test` (unit) and the real-browser E2E suite before opening a pull request.
4. Pull requests must state: what changed, how it was tested (real steps), what is **not** covered.
5. By contributing you agree your contribution is licensed under CC BY-NC-SA 4.0.

---

## 中文

欢迎参与。当前阶段最有价值的贡献：**真实使用**中发现的 bug（真设备、真浏览器）、来自产品说明的边界情形、以及翻译。

- **每个结论都要证据**：「能用」不是测试结果，附上命令、日志或截图。
- **「未知」是合法答案**：解析器无法证明的关系，界面必须显示「未知」，不许猜。
- **边界表不是可选项**：`docs/假设与未覆盖清单.md` 里的边界属于产品本身。
- **保持本地优先**：不加 CDN、外链字体、遥测或厂商云。

流程：Issue 描述用户可见问题 → fork/分支 → 小步提交 → 跑 `node --test` 与真实浏览器 E2E → PR 写清「改了什么/怎么真实测的/没覆盖什么」。贡献按 CC BY-NC-SA 4.0 授权。