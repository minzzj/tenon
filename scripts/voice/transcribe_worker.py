#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""榫卯 · 常驻转写 worker（供 /api/v2/voice/transcribe 手机录音使用）

启动时加载一次 Paraformer-large（VAD+标点），之后每行 JSON {"id":n,"file":"x.wav"} 返回
{"id":n,"ok":true,"text":"...","pinyin":"...","provider":"paraformer","ms":123}。
避免旧实现「每次请求重新加载模型 30-45 秒」导致手机 30s 超时。
"""
import sys, os, json, time, re

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
os.environ.setdefault("TQDM_DISABLE", "1")
os.environ.setdefault("FUNASR_LOG_LEVEL", "ERROR")

def clean(t):
    t = re.sub(r"<\|[^>]*\|>", "", t or "")
    return re.sub(r"\s+", "", t).strip()

def to_pinyin(text):
    try:
        from pypinyin import lazy_pinyin
        return " ".join(lazy_pinyin(clean(text)))
    except Exception:
        return ""

_model = None
def load_model():
    global _model
    if _model is not None:
        return _model
    t0 = time.time()
    from funasr import AutoModel
    _model = AutoModel(model="paraformer-zh", vad_model="fsmn-vad", punc_model="ct-punc",
                       disable_update=True, disable_pbar=True, device="cpu")
    print("[transcribe] model loaded in %.1fs" % (time.time() - t0), file=sys.stderr, flush=True)
    return _model

def main():
    model = load_model()
    print(json.dumps({"type": "ready", "provider": "paraformer"}, ensure_ascii=False), flush=True)
    for line in sys.stdin:
        line = (line or "").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        wav = str(req.get("file") or "")
        hotword = str(req.get("hotword") or "")
        if not wav or not os.path.exists(wav):
            print(json.dumps({"id": rid, "ok": False, "error": "WAV 不存在"}, ensure_ascii=False), flush=True)
            continue
        t0 = time.time()
        try:
            kw = {"input": wav, "batch_size_s": 60}
            if hotword:
                kw["hotword"] = hotword
            res = model.generate(**kw)
            text = ""
            if isinstance(res, list) and res and isinstance(res[0], dict):
                text = res[0].get("text", "")
            text = clean(text)
            print(json.dumps({"id": rid, "ok": True, "text": text, "pinyin": to_pinyin(text),
                              "provider": "paraformer", "ms": int((time.time() - t0) * 1000)},
                             ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({"id": rid, "ok": False, "error": str(e)[:300]}, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
