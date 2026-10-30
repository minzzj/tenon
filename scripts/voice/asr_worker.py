#!/usr/bin/env python3
r"""榫卯 V3 · 常驻中文语音识别 worker（FunASR SenseVoice 优先；Windows SR 兜底）

用法：
  python asr_worker.py --file <wav> [--language zh] [--json]
      输出单行 JSON: {ok,text,confidence,provider,ms}
  python asr_worker.py --mic [--mic-device "麦克风 (Rapoo Camera)"] [--ffmpeg <path>]
      持续从麦克风采集，按 VAD 分段识别，stdout 输出 JSONL：
        {type:"ready",provider,model}
        {type:"speech_start",ts}
        {type:"final",text,ts,provider,ms}
        {type:"speech_end",ts}
  python asr_worker.py --devices       列出可用麦克风（ffmpeg dshow）
环境变量：
  TENON_FFMPEG   ffmpeg 路径（默认 PATH 或 C:\Users\Administrator\AppData\Local\ffmpeg-full\ffmpeg.exe）
  TENON_MIC      麦克风 dshow 名称（默认 "麦克风 (Rapoo Camera)"）
"""
import argparse, json, os, re, subprocess, sys, tempfile, time, wave
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
os.environ.setdefault("TQDM_DISABLE", "1")
os.environ.setdefault("FUNASR_LOG_LEVEL", "ERROR")

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
DEFAULT_FFMPEG = os.environ.get("TENON_FFMPEG") or r"C:\Users\Administrator\AppData\Local\ffmpeg-full\ffmpeg.exe"
DEFAULT_MIC = os.environ.get("TENON_MIC") or "麦克风 (Rapoo Camera)"
PSCRIBE = os.path.join(ROOT, "scripts", "voice", "transcribe.ps1")

def log(*a):
    print(*a, file=sys.stderr, flush=True)



# 2026-10-26 产品修复：唤醒词同音纠错表（专有名词「榫卯/小榫」容易被识别成同音字）
WAKE_WORD_FIXES = [
    ("孙某", "榫卯"), ("孙卯", "榫卯"), ("孙茅", "榫卯"), ("孙贸", "榫卯"),
    ("笋卯", "榫卯"), ("损卯", "榫卯"), ("孙毛", "榫卯"), ("孙茂", "榫卯"),
    ("小笋", "小榫"), ("小损", "小榫"), ("小孙", "小榫"), ("小顺", "小榫"),
]


def clean_text(text):
    """清理 SenseVoice 输出：去掉标签/重复标点，并做唤醒词同音纠错（只替换这些专有词/前缀）"""
    if not text:
        return ""
    t = re.sub(r"<\|[^>]*\|>", "", text)
    t = re.sub(r"\s+", "", t)
    for _bad, _good in WAKE_WORD_FIXES:
        t = t.replace(_bad, _good)
    t = re.sub(r"([，。！？、；：])\1+", r"\1", t)
    return t.strip()

def to_pinyin(text):
    try:
        from pypinyin import lazy_pinyin
        return " ".join(lazy_pinyin(text or ""))
    except Exception:
        return ""

def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)

_funasr_model = None
_funasr_error = None

def load_funasr(language="zh"):
    global _funasr_model, _funasr_error
    if _funasr_model is not None or _funasr_error is not None:
        return _funasr_model
    try:
        from funasr import AutoModel
        t0 = time.time()
        _funasr_model = AutoModel(model="iic/SenseVoiceSmall", disable_update=True, disable_pbar=True, device="cpu")
        log("[asr] SenseVoiceSmall loaded in %.1fs" % (time.time() - t0))
    except Exception as e:
        _funasr_error = str(e)[:500]
        log("[asr] funasr unavailable:", _funasr_error[:200])
        _funasr_model = None
    return _funasr_model

def funasr_transcribe(wav_path, language="zh"):
    model = load_funasr(language)
    if model is None:
        return None
    t0 = time.time()
    res = model.generate(input=wav_path, language=language, use_itn=True, batch_size_s=60)
    text = ""
    if isinstance(res, list) and res:
        text = res[0].get("text", "") if isinstance(res[0], dict) else str(res[0])
    text = clean_text(text)
    ms = int((time.time() - t0) * 1000)
    return {"ok": True, "text": text, "provider": "funasr-sensevoice", "ms": ms,
            "confidence": res[0].get("confidence", None) if isinstance(res, list) and res and isinstance(res[0], dict) else None}

def windows_sr_transcribe(wav_path, language="zh-CN"):
    t0 = time.time()
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PSCRIBE,
                              "-Wav", wav_path, "-Language", language],
                             capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        line = (out.stdout or "").strip().splitlines()
        obj = json.loads(line[-1]) if line else {"ok": False, "error": "no output"}
        obj["ms"] = int((time.time() - t0) * 1000)
        return obj
    except Exception as e:
        return {"ok": False, "error": "windows-sr 调用失败: %s" % str(e)[:200], "ms": int((time.time() - t0) * 1000)}

def transcribe_file(wav, language="zh"):
    t0 = time.time()
    r = funasr_transcribe(wav, language)
    if r is None:
        r = windows_sr_transcribe(wav, "zh-CN" if language.startswith("zh") else language)
    r["totalMs"] = int((time.time() - t0) * 1000)
    r["pinyin"] = to_pinyin(r.get("text") or "")
    return r

def ffmpeg_path():
    if os.path.exists(DEFAULT_FFMPEG):
        return DEFAULT_FFMPEG
    return "ffmpeg"

def list_devices():
    p = subprocess.run([ffmpeg_path(), "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (p.stdout or "") + (p.stderr or "")
    devices = []
    for m in re.finditer(r'"([^"]+)" \(audio\)', out):
        devices.append(m.group(1))
    return devices

def rms16(buf):
    if not buf:
        return 0.0
    import array
    a = array.array("h")
    a.frombytes(buf[: len(buf) // 2 * 2])
    if not a:
        return 0.0
    s = 0
    for v in a:
        s += v * v
    return (s / len(a)) ** 0.5

def run_mic(args):
    ensure = os.path.join(ROOT, "data", "voice", "tmp")
    os.makedirs(ensure, exist_ok=True)
    mic = args.mic_device or DEFAULT_MIC
    ff = ffmpeg_path()
    log("[asr] mic:", mic, "| ffmpeg:", ff)
    cmd = [ff, "-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", "audio=" + mic,
           "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]
    emit({"type": "ready", "provider": "funasr" if load_funasr() is not None else "windows-sr", "mic": mic, "ts": int(time.time() * 1000)})
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_ms = 100
    bytes_per_frame = 16000 * 2 * frame_ms // 1000
    speech_threshold = int(args.threshold)
    silence_frames_to_end = int(args.silence_ms / frame_ms)
    min_speech_frames = int(args.min_speech_ms / frame_ms)
    max_segment_frames = int(args.max_segment_ms / frame_ms)
    buf = bytearray()
    seg = bytearray()
    speech = False
    silent = 0
    frame_no = 0
    def flush_segment(reason=""):
        nonlocal seg, speech, silent
        if len(seg) < bytes_per_frame * min_speech_frames:
            seg = bytearray(); speech = False; silent = 0; return
        path = os.path.join(ensure, "seg-%d.wav" % int(time.time() * 1000))
        with wave.open(path, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            w.writeframes(bytes(seg))
        seg = bytearray(); speech = False; silent = 0
        res = transcribe_file(path, args.language)
        try: os.remove(path)
        except Exception: pass
        txt = (res.get("text") or "").strip()
        if txt:
            emit({"type": "final", "text": txt, "pinyin": to_pinyin(txt), "provider": res.get("provider"), "ms": res.get("ms"),
                  "ts": int(time.time() * 1000), "reason": reason})
    while True:
        chunk = proc.stdout.read(bytes_per_frame)
        if not chunk:
            break
        buf.extend(chunk)
        while len(buf) >= bytes_per_frame:
            frame = bytes(buf[:bytes_per_frame]); del buf[:bytes_per_frame]
            frame_no += 1
            level = rms16(frame)
            if level >= speech_threshold:
                if not speech:
                    speech = True; silent = 0
                    emit({"type": "speech_start", "level": int(level), "ts": int(time.time() * 1000)})
                seg.extend(frame); silent = 0
            else:
                if speech:
                    silent += 1
                    seg.extend(frame)
                    if silent >= silence_frames_to_end:
                        emit({"type": "speech_end", "ts": int(time.time() * 1000)})
                        flush_segment("silence")
                elif len(seg) > 0:
                    seg = bytearray()
            if speech and len(seg) >= bytes_per_frame * max_segment_frames:
                emit({"type": "speech_end", "ts": int(time.time() * 1000), "reason": "max_len"})
                flush_segment("max_len")
            if frame_no % 50 == 0:
                emit({"type": "heartbeat", "level": int(level), "ts": int(time.time() * 1000)})
    proc.terminate()
    return 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="")
    ap.add_argument("--mic", action="store_true")
    ap.add_argument("--devices", action="store_true")
    ap.add_argument("--language", default="zh")
    ap.add_argument("--mic-device", default="")
    ap.add_argument("--threshold", type=int, default=350)
    ap.add_argument("--silence-ms", type=int, default=900)
    ap.add_argument("--min-speech-ms", type=int, default=300)
    ap.add_argument("--max-segment-ms", type=int, default=12000)
    args = ap.parse_args()
    if args.devices:
        for d in list_devices():
            print(d)
        return 0
    if args.file:
        if not os.path.exists(args.file):
            emit({"ok": False, "error": "文件不存在: " + args.file}); return 1
        emit(transcribe_file(args.file, args.language))
        try:
            sys.stdout.flush(); sys.stderr.flush()
        except Exception:
            pass
        os._exit(0)
    if args.mic:
        return run_mic(args)
    emit({"ok": False, "error": "用法: --file <wav> | --mic | --devices"}); return 1

if __name__ == "__main__":
    sys.exit(main())
