# Tenon (榫卯) · Super Terminal

> A self-hosted personal super terminal connecting your PC, phone, home devices and AI into one auditable task chain: voice-controlled PC, PC automation (RPA), phone-desktop handoff, smart-home/IoT control, 24h recording & screen records, local AI summaries — all data stays on your own computer.

**Searchable aliases / keywords**: Tenon, 榫卯, super terminal, AI voice assistant, voice-controlled computer, PC automation, desktop automation, RPA, personal assistant, phone-desktop handoff, multi-device, smart home, IoT, Home Assistant, MQTT, ambient recording, 24h recorder, screen capture, screenshot OCR, speech-to-text, local-first, local LLM, DeepSeek, FunASR, Electron, Node.js, Android, open source, auditable, privacy-first, self-hosted, productivity.

[简体中文](README.zh-CN.md) · [Docs](docs/) · [Aliases & keywords](docs/项目别名与搜索关键词.md) · [Changelog](CHANGELOG.md) · [License](LICENSE) · [Security](SECURITY.md)

**Current: v0.6.12 (2026-10-31)** — portable desktop app + Android APK, in-app one-click update, fully local.

## What it is

| Scenario | How Tenon does it |
|---|---|
| Voice-controlled PC | "Open Notepad", "Set volume to 40", "Home mode" — local ASR + AI planning + a real PC executor, every step on record |
| Phone ↔ PC handoff | Phone recordings transcribed on PC; phone screen content reported to PC; phone can read PC ambient/screen records; in-app updates |
| PC automation / RPA | node-agent executor performs app launch, volume, scenes, files, printing (irreversible actions need confirmation) with evidence |
| Smart home / IoT | Home Assistant / MQTT / SSDP devices onboarding and control |
| Recording & summaries | 24h phone ambient recording; PC screen records (frame every 5s, upload only on change); per-device AI summaries as MD/DOCX/PDF |
| Privacy & audit | Data stays local; hash-chain event ledger; sensitive-content filtering; exportable audit |

## Feature names ↔ capabilities ↔ search terms

| UI name | What it does | Search terms |
|---|---|---|
| 🎙 One-tap wake | Record one utterance without wake word; PC transcribes & executes; phone speaks reply | voice assistant, voice command |
| Voice wake | Say "Tenon/榫卯" to start a command | wake word, voice wake |
| ⏺ 24h recording | Phone background ambient recording → PC transcription | ambient recording, 24h recorder |
| Screen capture | Frame every 5s, upload only on change; OCR into summaries; screenshots auto-deleted | screen records, screenshot OCR |
| Records / Documents | Notes + ambient + screen records; per-device AI summaries with merged counts | voice notes, AI summary, daily report |
| Floating ball | Single tap = one-tap wake; long-press = toggle 24h recording | floating window, quick action |
| Executor / Devices | Real PC actions; device discovery & scenes | PC automation, RPA, smart home, IoT |

## Quick start

- Desktop: `desktop/release/TenonSuperTerminal-0.6.12-portable.exe`
- Android: `public/download/tenon-android-0.6.12-debug.apk`
- Source: `npm install && npm start` (http://127.0.0.1:7410), `npm test`

## Architecture

Hub (`server/`, Node.js, port 7410, JSONL ledger) · executor (`node-agent/`) · desktop (`desktop/`, Electron) · Android (`android/`) · local FunASR Paraformer + resident transcribe/OCR workers · DeepSeek planning (configurable) · all data in local `data/`.

## Docs & license

[Aliases & keywords](docs/项目别名与搜索关键词.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md) · CC BY-NC-SA 4.0 (commercial: [COMMERCIAL.md](COMMERCIAL.md))
