# 榫卯 Tenon

> A self-hostable hub that connects your devices, software and AI into **one auditable task chain**.

[简体中文](README.zh-CN.md) · [Docs](docs/) · [License](LICENSE) · [Commercial use](COMMERCIAL.md) · [Security](SECURITY.md)

**Status: v0.1.0 under construction.** The foundation — license, docs skeleton, repository — is in place. The runnable hub, node agent, web console and the real-browser test suite land with the v0.1.0 milestone (see [CHANGELOG.md](CHANGELOG.md)).

---

## The three questions

Tenon exists to answer exactly three questions for a person — or a 3–20 person studio, or a team behind an intranet and a compliance officer:

| Question | What you see |
|---|---|
| **What can this machine do?** | A device card: which capabilities it offers, who may use them, evidence for each relation, when authorisations expire |
| **Where is this task now?** | One timeline: drafted, confirmed, queued, running, done/failed, delivered — with evidence for every step |
| **Where did the data go?** | Data-domain labels and an exportable audit trail: which device, which capability, which model, which channel |

Adjacent products optimise *how to connect*. Tenon is about **who approved, how far it got, and where the data went** after the connection. Protocol solves connectivity; a ledger solves responsibility.

## Six capabilities (v0.1.0 scope)

| # | Capability | What you get |
|---|---|---|
| 1 | **Auto-discovery** | A node appears on the network and its capabilities are listed; rescan, hide, read-only join; failures say which step was blocked |
| 2 | **Capability view** | Provider, allowed users, last three calls, authorisation expiry; every relation opens its evidence; no evidence is shown as *unknown* |
| 3 | **Task delegation** | One sentence on a phone becomes a five-part draft on the desktop; irreversible actions need confirmation one by one; cancel and retry |
| 4 | **Impact preview** | Before disconnecting a device or revoking an authorisation: the tasks that would break, graded *certain / possible / unknown*; cancel changes nothing |
| 5 | **Message callback** | Summary + link only, body never leaves the intranet; rate-limit → queue/retry → fallback channel → marked undelivered |
| 6 | **Deploy & health check** | One page: blocked / warning / notice / undeterminable; empty result lists what was checked; audit export |

## Design principles

- **Local-first.** Everything runs on your machine or your LAN. No vendor cloud in the middle; public relay is optional, off by default.
- **Evidence over guessing.** Relation strength is *certain / possible / unknown*; a relationship without evidence is shown as unknown, never inferred into a fact.
- **Append-only ledger.** Events are hash-chained and replayed into an index at start-up — crash recovery, audit, export and migration all read the same source of truth.
- **Zero runtime dependencies.** Node.js built-in modules only; the UI is plain HTML/CSS/JS with no CDN and no external fonts, so the product keeps working with the network unplugged.
- **Plugin boundaries.** AI providers, capabilities, delivery channels and an MCP-style capability bridge are interfaces, not hard-coded integrations. Swap DeepSeek for a local model, or WeChat for email, without touching the core.

## Architecture (planned v0.1.0)

```text
[phone web /m]   [desktop web /]   [CLI]
        \           |            /
                Hub (Node.js)
   ledger · index · capability registry · task engine
   impact preview · channels · health check · AI providers
                  |
              Node agent  ── registers capabilities, pulls tasks, reports events
                  |
   capabilities/*  image.crop · file.hash · llm.summarize · channel.notify · ...
```

## Quick start (ships with v0.1.0)

```bash
git clone https://github.com/minzzj/tenon.git
cd tenon
node server/start.js        # requires Node.js >= 22
# open http://127.0.0.1:7410
```

The repository is kept honest: **commands above are wired when the v0.1.0 code lands**, not before. This foundation commit only contains the repository, licenses and documentation skeleton.

## Testing promise

Testing is done the way a user uses it: **real Chrome, real clicks, real files, real process kills** — not API calls dressed up as tests. Evidence (screenshots, assertions, logs) is archived under `docs/测试证据/`; numbers in this README will match the evidence of the v0.1.0 run. Unit tests run with `node --test`.

## Repository layout

```text
server/        hub: HTTP API, ledger, index, task engine, checks
node-agent/    node agent: capability registry, task runner, heartbeat
public/        desktop console + phone remote page (no CDN, offline)
plugins/       capability / channel / AI provider interfaces
test/          unit tests + real-browser E2E scripts
docs/           manual, test method, assumptions, evidence, images
scripts/       install / start / stop helpers
```

## Non-goals

Tenon does **not** implement Matter/Thread pairing, is **not** a cloud automation SaaS, **not** a file-sync or chat product, and **not** a GUI click robot. It sits above those: a task-and-responsibility layer for the devices, software and models you already own.

## License

[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International](LICENSE) — free to download, run, modify and share **for non-commercial purposes**. If you distribute a modified version, it must stay under the same license (or a compatible one). **Commercial use is not permitted** — see [COMMERCIAL.md](COMMERCIAL.md).

This is not an OSI-approved open-source license, so GitHub shows "Other". The legal text in [LICENSE](LICENSE) is authoritative; [LICENSE.zh-CN.md](LICENSE.zh-CN.md) is the official Chinese translation for reference.