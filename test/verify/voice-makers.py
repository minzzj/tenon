#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Round5 语音验收音频生成器：Windows SAPI Microsoft Huihui Desktop（zh-CN）
生成 11 条 16kHz 单声道 16-bit WAV（5 唤醒 + 6 命令），附参考文本 manifest。
用法：python test/verify/voice-makers.py
输出：_internal/checker/round5/audio/*.wav + manifest.json
"""
import json
import os
import subprocess
import sys
import wave

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT_DIR = os.path.join(ROOT, "_internal", "checker", "round5", "audio")
TOOLS = os.path.join(ROOT, "_internal", "checker", "round5", "tools")
SAPI = os.path.join(TOOLS, "sapi-gen.ps1")
FFMPEG_CANDIDATES = [
    os.path.join(os.environ.get("LOCALAPPDATA", r"C:\Users\Administrator\AppData\Local"), "ffmpeg-full", "ffmpeg.exe"),
    r"C:\Users\Administrator\AppData\Local\ffmpeg-full\ffmpeg.exe",
    "ffmpeg",
]
WAKES = [
    ("wake-01", "榫卯"),
    ("wake-02", "小榫"),
    ("wake-03", "你好榫卯"),
    ("wake-04", "榫卯在吗"),
    ("wake-05", "榫卯，打开记事本"),
]
COMMANDS = [
    ("cmd-01", "打开记事本"),
    ("cmd-02", "把音量调到六十"),
    ("cmd-03", "打开Chrome浏览器"),
    ("cmd-04", "把这张照片甩到电脑"),
    ("cmd-05", "回家模式"),
    ("cmd-06", "今天做了什么都记下来"),
]


def find_ffmpeg():
    for c in FFMPEG_CANDIDATES:
        if os.path.isabs(c) and os.path.exists(c):
            return c
        if not os.path.isabs(c):
            return c
    raise RuntimeError("找不到 ffmpeg")


def synthesize(text, raw_wav):
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SAPI, "-Text", text, "-OutFile", raw_wav],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if r.returncode != 0 or not os.path.exists(raw_wav):
        raise RuntimeError("SAPI 合成失败：" + (r.stdout or "") + (r.stderr or ""))
    return (r.stdout or "").strip()


def to_16k_mono(src, dst):
    ff = find_ffmpeg()
    r = subprocess.run([ff, "-y", "-loglevel", "error", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dst],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if r.returncode != 0 or not os.path.exists(dst):
        raise RuntimeError("ffmpeg 转换失败：" + (r.stderr or "")[:300])


def wav_info(path):
    with wave.open(path, "rb") as w:
        frames = w.getnframes()
        rate = w.getframerate()
        return {"frames": frames, "sampleRate": rate, "channels": w.getnchannels(), "sampWidth": w.getsampwidth(),
                "durationSec": round(frames / float(rate), 3)}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(TOOLS, exist_ok=True)
    if not os.path.exists(SAPI):
        raise RuntimeError("缺少 sapi-gen.ps1：" + SAPI)
    entries = []
    all_items = [("wake", i, t) for i, t in WAKES] + [("command", i, t) for i, t in COMMANDS]
    for kind, ident, text in all_items:
        raw = os.path.join(OUT_DIR, ident + ".raw.wav")
        out = os.path.join(OUT_DIR, ident + ".wav")
        try:
            info_line = synthesize(text, raw)
            to_16k_mono(raw, out)
            os.remove(raw)
            info = wav_info(out)
            entries.append({"id": ident, "kind": kind, "text": text, "file": os.path.relpath(out, ROOT).replace("\\", "/"),
                            "sizeBytes": os.path.getsize(out), **info, "voice": info_line[:120]})
            print("[" + kind + "] " + ident + " '" + text + "' -> " + str(info["durationSec"]) + "s " + str(info["sampleRate"]) + "Hz/" + str(info["channels"]) + "ch")
        except Exception as e:
            print("FAIL " + ident + "：" + str(e)[:200])
            entries.append({"id": ident, "kind": kind, "text": text, "error": str(e)[:300]})
    manifest = {"kind": "voice-test-audio", "generatedAt": __import__("datetime").datetime.now().isoformat(),
                "voice": "Microsoft Huihui Desktop (zh-CN)", "format": "16kHz mono 16-bit PCM",
                "total": len(entries), "wakeCount": len(WAKES), "commandCount": len(COMMANDS), "entries": entries}
    path = os.path.join(OUT_DIR, "manifest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    ok = all("error" not in e for e in entries)
    print("结果：" + ("PASS" if ok else "FAIL") + "，共 " + str(len(entries)) + " 条；manifest=" + path)
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()