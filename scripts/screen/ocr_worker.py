#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""榫卯 · 常驻屏幕 OCR worker（避免每 5 秒截图都 spawn python + winrt，降低 CPU/内存抖动）

stdin 每行 JSON {"id":1,"file":"shot.png"} → stdout 每行 JSON
{"id":1,"ok":true,"text":"...","engine":"windows-ocr","ocrMs":123}
"""
import sys, os, json, time

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    import win_ocr
except Exception as e:
    print(json.dumps({"type": "error", "error": "导入 win_ocr 失败：" + str(e)[:300]}, ensure_ascii=False), flush=True)
    raise

# 预加载 winrt 模块（真正 OCR 时不再付导入开销）
try:
    import winrt.windows.media.ocr  # noqa: F401
    import winrt.windows.graphics.imaging  # noqa: F401
    import winrt.windows.storage.streams  # noqa: F401
except Exception:
    pass

print(json.dumps({"type": "ready", "provider": "windows-ocr"}, ensure_ascii=False), flush=True)

for line in sys.stdin:
    line = (line or "").strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        continue
    rid = req.get("id")
    path = str(req.get("file") or "")
    t0 = time.time()
    try:
        if not path or not os.path.exists(path):
            raise RuntimeError("图片不存在：" + path)
        out = win_ocr.ocr_image(path, upscale=True)
        print(json.dumps({"id": rid, "ok": True, "text": out.get("text", ""),
                          "lines": out.get("lines", []), "engine": out.get("engine", "windows-ocr"),
                          "ocrMs": out.get("elapsedMs") or int((time.time() - t0) * 1000)},
                         ensure_ascii=False), flush=True)
    except Exception as e:
        print(json.dumps({"id": rid, "ok": False, "error": str(e)[:300]}, ensure_ascii=False), flush=True)
