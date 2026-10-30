#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""榫卯 V6 · 唤醒与记录分离的语音引擎（双流水线，单进程持有麦克风）

设计（回应用户「把记录的和唤醒的分开」）：
  - **唤醒流水线**：常驻低延迟；只录 0.5–2.5s 短片段 → Paraformer 快速识别（hotword 偏置）→ 文本/拼音匹配唤醒词（含同音纠错）。
  - **记录流水线**：仅在唤醒后的会话内启动；完整 VAD 分段（1s 静音结束，最多 15s）→ Paraformer + 标点 + 热词 → 发出 final（命令/笔记/长句）。
  - 两条流水线逻辑、参数、模型调用完全分开；同一时刻只有一个录音任务，避免争抢麦克风。
  - 唤醒词命中后自动进入会话；会话静音超时（默认 6s）后回到唤醒待机。

协议（stdout JSONL）：
  {type:'ready',wakeProvider,recordProvider,mic}
  {type:'speech_start'} / {type:'speech_end',reason}
  {type:'wake',text,word,rest,pinyin,provider,ms}
  {type:'session_start'} / {type:'session_end',reason}
  {type:'final',text,pinyin,provider,ms}        （记录流水线的结果）
  {type:'heartbeat',level}
  {type:'error',text,code}
用法：
  python dual_worker.py --mic                         # 真实麦克风双流水线
  python dual_worker.py --simulate wake.wav cmd1.wav  # 用文件模拟（确定测试）
  python dual_worker.py --devices
"""
import argparse, json, os, re, subprocess, sys, tempfile, time, wave, threading, queue

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
TMP_DIR = os.path.join(ROOT, "data", "voice", "tmp")
WAKE_ALIASES = ["榫卯", "小榫", "你好榫卯", "榫卯在吗", "小助手"]
WAKE_PINYIN = ["sun mao", "xiao sun", "sun mao zai", "ni hao sun mao", "xiao zhu shou", "sun mao zai ma"]
WAKE_FIX = {"孙某": "榫卯", "孙卯": "榫卯", "孙茅": "榫卯", "孙贸": "榫卯", "笋卯": "榫卯",
            "损卯": "榫卯", "孙毛": "榫卯", "孙茂": "榫卯", "小笋": "小榫", "小损": "小榫",
            "小孙": "小榫", "小顺": "小榫", "孙某": "榫卯"}

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)

def clean_text(t):
    t = re.sub(r"<\|[^>]*\|>", "", t or "")
    t = re.sub(r"\s+", "", t)
    t = re.sub(r"([，。！？、；：])\1+", r"\1", t)
    return t.strip()

def to_pinyin(text):
    try:
        from pypinyin import lazy_pinyin
        return " ".join(lazy_pinyin(clean_text(text)))
    except Exception:
        return ""

def normalize_wake(text):
    t = clean_text(text)
    for k, v in WAKE_FIX.items():
        t = t.replace(k, v)
    return t

def detect_wake(text, pinyin=""):
    t = normalize_wake(text)
    py = (pinyin or to_pinyin(t)).lower()
    for alias in WAKE_ALIASES:
        idx = t.find(alias)
        if idx >= 0:
            return {"wake": True, "word": alias, "via": "text", "rest": t[idx + len(alias):]}
    for pat in WAKE_PINYIN:
        idx = py.find(pat)
        if idx >= 0:
            # 用原文去掉开头若干字作为 rest（拼音定位不精确，保守返回空 rest）
            return {"wake": True, "word": pat, "via": "pinyin", "rest": ""}
    return {"wake": False, "word": "", "via": "", "rest": t}

class ParaformerEngine:
    def __init__(self, provider="paraformer", punc=True):
        self.provider = provider
        self.model = None
        self.punc = punc
        self.lock = threading.Lock()
        self._load()

    def _load(self):
        t0 = time.time()
        from funasr import AutoModel
        if self.provider == "sensevoice":
            self.model = AutoModel(model="iic/SenseVoiceSmall", disable_update=True, disable_pbar=True, device="cpu")
        else:
            self.model = AutoModel(model="paraformer-zh", vad_model="fsmn-vad",
                                   punc_model="ct-punc" if self.punc else None,
                                   disable_update=True, disable_pbar=True, device="cpu")
        self.load_ms = int((time.time() - t0) * 1000)
        log("[dual] %s model loaded %dms" % (self.provider, self.load_ms))

    def transcribe(self, wav_path, hotword="", use_punc=True):
        with self.lock:
            t0 = time.time()
            kw = {"input": wav_path, "batch_size_s": 60}
            if hotword:
                kw["hotword"] = hotword
            res = self.model.generate(**kw)
        text = ""
        if isinstance(res, list) and res:
            text = res[0].get("text", "") if isinstance(res[0], dict) else str(res[0])
        text = clean_text(text)
        return {"ok": True, "text": text, "provider": self.provider, "ms": int((time.time() - t0) * 1000),
                "pinyin": to_pinyin(text)}

def agc_bytes(data, target_rms=1400, max_gain=10.0):
    """软件自动增益：把片段音量拉到目标 RMS 附近（远场/小音量麦克风提升识别率）"""
    try:
        import array
        a = array.array("h")
        a.frombytes(bytes(data[: len(data) // 2 * 2]))
        if not a:
            return bytes(data)
        s = 0
        for v in a:
            s += int(v) * int(v)
        rms = (s / len(a)) ** 0.5
        if rms <= 1:
            return bytes(data)
        gain = min(max_gain, max(1.0, target_rms / rms))
        out = array.array("h", (max(-32768, min(32767, int(v * gain))) for v in a))
        return out.tobytes()
    except Exception:
        return bytes(data)


def write_wav(path, data, sr=16000):
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(bytes(data))

class DualEngine:
    def __init__(self, args):
        self.args = args
        os.makedirs(TMP_DIR, exist_ok=True)
        self.ctrl = queue.Queue()  # stdin 控制：start_session / stop_session（快捷录音用）
        self.wake_engine = ParaformerEngine(provider=args.wake_provider, punc=False)
        self.record_engine = ParaformerEngine(provider=args.record_provider, punc=True) if args.record_provider != args.wake_provider else self.wake_engine
        self.hotword = " ".join([w for w in (args.hotwords or "").split() if w])
        self.wake_words = [w for w in (args.wake_words or "").split(",") if w] or WAKE_ALIASES
        self.silent = False

    # ---------- 文件模拟（确定性测试） ----------
    def simulate(self, wavs):
        emit({"type": "ready", "wakeProvider": self.args.wake_provider, "recordProvider": self.args.record_provider, "mic": None, "simulate": True})
        # 第一个文件当作唤醒片段，其余当作记录片段
        for i, wav in enumerate(wavs):
            r = self.wake_engine.transcribe(wav, hotword=self.hotword, use_punc=False)
            emit({"type": "speech_start"})
            emit({"type": "speech_end", "reason": "simulate"})
            if i == 0:
                w = detect_wake(r["text"], r["pinyin"])
                if w["wake"]:
                    emit({"type": "wake", "text": r["text"], "word": w["word"], "via": w["via"], "rest": w["rest"], "pinyin": r["pinyin"], "provider": r["provider"], "ms": r["ms"]})
                    emit({"type": "session_start"})
                else:
                    emit({"type": "error", "text": "模拟唤醒失败：" + r["text"], "code": "SIM_WAKE_FAIL"})
                    return 1
            else:
                rr = self.record_engine.transcribe(wav, hotword=self.hotword, use_punc=True)
                emit({"type": "final", "text": rr["text"], "pinyin": rr["pinyin"], "provider": rr["provider"], "ms": rr["ms"]})
        emit({"type": "session_end", "reason": "simulate-done"})
        return 0

    def simulate_quick(self, wavs):
        """模拟：点击悬浮按钮 → 立即记录会话（无需唤醒词）→ 每个文件出 partial/final"""
        emit({"type": "ready", "wakeProvider": self.args.wake_provider, "recordProvider": self.args.record_provider, "mic": None, "simulate": True})
        emit({"type": "session_start", "reason": "quick"})
        for wav in wavs:
            r = self.record_engine.transcribe(wav, hotword=self.hotword, use_punc=False)
            if r.get("text"):
                emit({"type": "partial", "text": r["text"], "provider": r["provider"], "ms": r["ms"]})
            rr = self.record_engine.transcribe(wav, hotword=self.hotword, use_punc=True)
            emit({"type": "final", "text": rr["text"], "pinyin": rr["pinyin"], "provider": rr["provider"], "ms": rr["ms"]})
        emit({"type": "session_end", "reason": "quick-done"})
        return 0

    # ---------- 真实麦克风 ----------
    def mic_loop(self):
        ff = DEFAULT_FFMPEG if os.path.exists(DEFAULT_FFMPEG) else "ffmpeg"
        mic = self.args.mic_device or DEFAULT_MIC
        cmd = [ff, "-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", "audio=" + mic,
               "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]
        log("[dual] mic:", mic)
        emit({"type": "ready", "wakeProvider": self.args.wake_provider, "recordProvider": self.args.record_provider, "mic": mic})

        # stdin 控制线程：快捷录音按钮/耳机按键可在任意时刻强制进入「立即记录」会话（无需唤醒词）
        def _stdin_reader():
            try:
                for line in sys.stdin:
                    line = (line or "").strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except Exception:
                        continue
                    self.ctrl.put(obj)
            except Exception:
                pass
        try:
            threading.Thread(target=_stdin_reader, daemon=True).start()
        except Exception:
            pass

        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        frame_ms = 100
        bpf = 16000 * 2 * frame_ms // 1000
        thr = int(self.args.threshold)
        wake_end_frames = max(3, int(self.args.wake_silence_ms / frame_ms))
        rec_end_frames = max(5, int(self.args.record_silence_ms / frame_ms))
        wake_max_frames = int(self.args.wake_max_ms / frame_ms)
        rec_max_frames = int(self.args.record_max_ms / frame_ms)
        session_timeout = self.args.session_timeout_ms / 1000.0
        buf = bytearray()
        # 状态：wake 等待 / record 会话
        mode = "wake"
        seg = bytearray(); speech = False; silent = 0; frame_no = 0
        session_last = time.time()
        last_partial_at = 0.0

        def maybe_partial():
            nonlocal last_partial_at
            if mode != "session" or not speech:
                return
            now = time.time()
            if now - last_partial_at < 1.2:
                return
            if len(seg) < bpf * 6:
                return
            last_partial_at = now
            path = os.path.join(TMP_DIR, "dual-partial-%d.wav" % int(now * 1000))
            try:
                write_wav(path, agc_bytes(seg))
                rr = self.record_engine.transcribe(path, hotword=self.hotword, use_punc=False)
                if rr.get("text"):
                    emit({"type": "partial", "text": rr["text"], "provider": rr["provider"], "ms": rr["ms"]})
            except Exception:
                pass
            finally:
                try: os.remove(path)
                except Exception: pass

        def flush(reason):
            nonlocal seg, speech, silent
            if len(seg) < bpf * 3:
                seg = bytearray(); speech = False; silent = 0; return
            path = os.path.join(TMP_DIR, "dual-%d.wav" % int(time.time() * 1000))
            write_wav(path, agc_bytes(seg))
            raw = bytes(seg); seg = bytearray(); speech = False; silent = 0
            try:
                if mode == "wake":
                    r = self.wake_engine.transcribe(path, hotword=self.hotword, use_punc=False)
                    emit({"type": "speech_start"})
                    emit({"type": "speech_end", "reason": reason})
                    w = detect_wake(r["text"], r["pinyin"])
                    if w["wake"]:
                        emit({"type": "wake", "text": r["text"], "word": w["word"], "via": w["via"], "rest": w["rest"], "pinyin": r["pinyin"], "provider": r["provider"], "ms": r["ms"]})
                        return "session"
                    return "wake"
                else:
                    emit({"type": "speech_start"})
                    emit({"type": "speech_end", "reason": reason})
                    rr = self.record_engine.transcribe(path, hotword=self.hotword, use_punc=True)
                    emit({"type": "final", "text": rr["text"], "pinyin": rr["pinyin"], "provider": rr["provider"], "ms": rr["ms"]})
                    return "record"
            except Exception as e:
                emit({"type": "error", "text": "识别失败：" + str(e)[:200], "code": "ASR_FAIL"})
                return mode
            finally:
                try: os.remove(path)
                except Exception: pass
        def enter_session():
            nonlocal mode, session_last
            if mode == "wake":
                mode = "session"; session_last = time.time()
                emit({"type": "session_start"})
        def leave_session(reason):
            nonlocal mode
            if mode == "session":
                mode = "wake"
                emit({"type": "session_end", "reason": reason})
        while True:
            chunk = proc.stdout.read(bpf)
            if not chunk:
                break
            # 处理外部控制（快捷录音：立即开会话 / 结束会话）
            while True:
                try:
                    ctl = self.ctrl.get_nowait()
                except queue.Empty:
                    break
                cname = str((ctl or {}).get("cmd") or "")
                if cname == "start_session":
                    if mode != "session":
                        mode = "session"
                        session_last = time.time()
                        emit({"type": "session_start", "reason": "quick"})
                elif cname == "stop_session":
                    if mode == "session":
                        leave_session("remote-stop")
            buf.extend(chunk)
            while len(buf) >= bpf:
                frame = bytes(buf[:bpf]); del buf[:bpf]
                frame_no += 1
                level = rms16(frame)
                if mode == "session" and time.time() - session_last > session_timeout and not speech:
                    leave_session("silence-timeout"); continue
                if level >= thr:
                    if not speech:
                        speech = True; silent = 0
                    seg.extend(frame); silent = 0
                    if mode == "session":
                        session_last = time.time()
                        maybe_partial()
                else:
                    if speech:
                        silent += 1; seg.extend(frame)
                        end_frames = wake_end_frames if mode == "wake" else rec_end_frames
                        max_frames = wake_max_frames if mode == "wake" else rec_max_frames
                        if silent >= end_frames:
                            newmode = flush("silence")
                            if newmode == "session": enter_session()
                        elif len(seg) >= bpf * max_frames:
                            newmode = flush("max_len")
                            if newmode == "session": enter_session()
                    elif mode == "wake":
                        # 空闲时也维护会话超时（无语音则返回待机）
                        pass
                if mode == "session" and time.time() - session_last > session_timeout and not speech:
                    leave_session("silence-timeout")
                if frame_no % 50 == 0:
                    emit({"type": "heartbeat", "level": int(level), "mode": mode})
        proc.terminate()
        return 0

def rms16(buf):
    if not buf:
        return 0.0
    import array
    a = array.array("h"); a.frombytes(buf[: len(buf) // 2 * 2])
    if not a: return 0.0
    s = 0
    for v in a: s += v * v
    return (s / len(a)) ** 0.5

def list_devices():
    ff = DEFAULT_FFMPEG if os.path.exists(DEFAULT_FFMPEG) else "ffmpeg"
    p = subprocess.run([ff, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (p.stdout or "") + (p.stderr or "")
    return [m.group(1) for m in re.finditer(r'"([^"]+)" \(audio\)', out)]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mic", action="store_true")
    ap.add_argument("--simulate", nargs="*", default=None)
    ap.add_argument("--simulate-quick", nargs="*", default=None)
    ap.add_argument("--devices", action="store_true")
    ap.add_argument("--mic-device", default="")
    ap.add_argument("--wake-provider", default="paraformer")
    ap.add_argument("--record-provider", default="paraformer")
    ap.add_argument("--hotwords", default="")
    ap.add_argument("--wake-words", default="")
    ap.add_argument("--threshold", type=int, default=200)
    ap.add_argument("--wake-silence-ms", type=int, default=500)
    ap.add_argument("--wake-max-ms", type=int, default=2500)
    ap.add_argument("--record-silence-ms", type=int, default=1000)
    ap.add_argument("--record-max-ms", type=int, default=15000)
    ap.add_argument("--session-timeout-ms", type=int, default=6000)
    args = ap.parse_args()
    if args.devices:
        for d in list_devices(): print(d)
        return 0
    if args.simulate_quick is not None:
        return DualEngine(args).simulate_quick(args.simulate_quick)
    if args.simulate is not None:
        return DualEngine(args).simulate(args.simulate)
    if args.mic:
        return DualEngine(args).mic_loop()
    print("用法: --mic | --simulate wake.wav cmd.wav... | --devices", file=sys.stderr)
    return 1

if __name__ == "__main__":
    sys.exit(main())
