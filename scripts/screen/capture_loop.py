#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""榫卯 V4 · PC 屏幕内容采集循环（超低占用）

- 定时截图（默认 60s，变化才 OCR）；Windows 系统 OCR（本地字库，非大模型）
- 识别文字（含视频标题/字幕/聊天内容等）→ POST 中枢 /api/v2/voice/screen
- 本地备份 data/screen/YYYY-MM-DD.jsonl；支持黑名单应用；暂停标志文件 data/voice/screen.pause
用法：
  python capture_loop.py --hub http://127.0.0.1:7410 --token <operatorToken> [--interval 60] [--once] [--duration 60]
"""
import argparse, ctypes, ctypes.wintypes as w, json, os, sys, time, hashlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SCREEN_DIR = os.path.join(ROOT, "data", "screen")
VOICE_DIR = os.path.join(ROOT, "data", "voice")
CFG_FILE = os.path.join(VOICE_DIR, "screen-config.json")
PAUSE_FILE = os.path.join(VOICE_DIR, "screen.pause")

def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, file=sys.stderr, flush=True)

def load_cfg():
    default = {"enabled": True, "intervalSec": 60, "changeThreshold": 0.015, "blacklistApps": [],
               "region": None, "maxLines": 60, "forceEverySec": 600, "minChars": 2, "minSimilarity": 0}
    try:
        if os.path.exists(CFG_FILE):
            c = json.load(open(CFG_FILE, encoding="utf-8"))
            default.update(c)
    except Exception as e:
        log("配置读取失败，用默认:", e)
    return default

def save_cfg(cfg):
    os.makedirs(VOICE_DIR, exist_ok=True)
    json.dump(cfg, open(CFG_FILE, "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=2)

def foreground():
    try:
        u = ctypes.windll.user32
        hwnd = u.GetForegroundWindow()
        if not hwnd:
            return {"app": "", "title": ""}
        length = u.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 2)
        u.GetWindowTextW(hwnd, buf, length + 2)
        pid = w.DWORD()
        u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        name = ""
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if h:
            size = w.DWORD(1024)
            pbuf = ctypes.create_unicode_buffer(1024)
            if k.QueryFullProcessImageNameW(h, 0, pbuf, ctypes.byref(size)):
                name = os.path.basename(pbuf.value)
            k.CloseHandle(h)
        return {"app": name, "title": buf.value}
    except Exception as e:
        return {"app": "", "title": "", "error": str(e)[:120]}

def grab(path, region=None):
    from PIL import Image
    from PIL import ImageGrab
    im = ImageGrab.grab()
    if region:
        x, y, w_, h_ = region
        im = im.crop((x, y, x + w_, y + h_))
    im.save(path, "PNG")
    return im.size

def thumb_hash(im):
    g = im.convert("L").resize((64, 36))
    data = list(g.getdata())
    return hashlib.sha256(bytes(data)).hexdigest(), data

def diff_ratio(prev, cur):
    if not prev or len(prev) != len(cur):
        return 1.0
    n = len(cur)
    changed = sum(1 for a, b in zip(prev, cur) if abs(a - b) > 12)
    return changed / n

def post_screen(hub, token, payload, timeout=8):
    try:
        import urllib.request
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(hub.rstrip("/") + "/api/v2/voice/screen", data=body, method="POST",
                                     headers={"Content-Type": "application/json", "x-tenon-token": token})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(400).decode("utf-8", "replace")
    except Exception as e:
        return -1, str(e)[:200]

def append_local(payload):
    os.makedirs(SCREEN_DIR, exist_ok=True)
    day = time.strftime("%Y-%m-%d")
    p = os.path.join(SCREEN_DIR, day + ".jsonl")
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")

def run(args):
    cfg = load_cfg()
    interval = args.interval or int(cfg["intervalSec"])
    token = args.token or ""
    if not token:
        try:
            import json as _json
            token = _json.load(open(os.path.join(ROOT, "data", "secrets.json"), encoding="utf-8")).get("operatorToken", "")
        except Exception:
            pass
    os.makedirs(SCREEN_DIR, exist_ok=True)
    os.makedirs(VOICE_DIR, exist_ok=True)
    log("启动屏幕采集: interval=%ss hub=%s" % (interval, args.hub))
    prev = None
    last_force = 0
    n = 0
    t_end = time.time() + args.duration if args.duration else None
    tmp = os.path.join(SCREEN_DIR, "last-shot.png")
    while True:
        if t_end and time.time() > t_end:
            log("时长到，退出")
            return 0
        if os.path.exists(PAUSE_FILE):
            log("已暂停（删除 %s 恢复）" % PAUSE_FILE)
            if args.once:
                return 0
            time.sleep(min(5, interval))
            continue
        try:
            from ocr_win import ocr_image  # 同目录
        except Exception:
            try:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                from win_ocr import ocr_image
            except Exception as e:
                log("OCR 模块不可用:", e); return 2
        try:
            t0 = time.time()
            size = grab(tmp, cfg.get("region"))
            from PIL import Image
            im = Image.open(tmp)
            h, data = thumb_hash(im)
            ratio = diff_ratio(prev, data)
            force = (time.time() - last_force) >= int(cfg.get("forceEverySec", 600))
            should = (h != (prev_h if 'prev_h' in dir() else None)) and (ratio >= float(cfg["changeThreshold"]) or force)
            if args.once or should:
                fg = foreground()
                app = (fg.get("app") or "").lower()
                black = [str(x).lower() for x in (cfg.get("blacklistApps") or [])]
                if black and any(b and b in app for b in black):
                    text = ""
                    ocr_ms = 0
                else:
                    use_fm = float(cfg.get("minSimilarity") or 0) > 0
                    r = ocr_image(tmp, cfg.get("region"), use_fm)
                    lines_ = r.get("lines") or []
                    min_sim = float(cfg.get("minSimilarity") or 0)
                    if min_sim > 0:
                        lines_ = [l for l in lines_ if (l.get("similarity") is None or l["similarity"] >= min_sim)]
                    text = "\n".join(l.get("text", "") for l in lines_)
                    ocr_ms = r.get("elapsedMs") or 0
                text = text.strip()
                chars = len(text.replace("\n", ""))
                if chars >= int(cfg.get("minChars", 2)):
                    payload = {"app": fg.get("app") or "", "title": fg.get("title") or "",
                               "text": text, "confidence": 1.0, "ts": int(time.time() * 1000),
                               "source": "pc", "ocrMs": ocr_ms, "avgSimilarity": (r.get("avgSimilarity") if 'r' in dir() else None), "shot": "last-shot.png"}
                    append_local(payload)
                    if args.no_post:
                        code, msg = 0, "local-only"
                    else:
                        code, msg = post_screen(args.hub, token, payload)
                    n += 1
                    log("OCR %d 字 %sms 应用=%s 标题=%s → hub=%s" % (chars, ocr_ms, fg.get("app"), (fg.get("title") or "")[:30], code))
                prev_h = h
            prev = data
            last_force = time.time() if should else last_force
            if args.once:
                return 0
        except Exception as e:
            log("采集异常:", str(e)[:300])
        time.sleep(interval)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub", default="http://127.0.0.1:7410")
    ap.add_argument("--token", default="")
    ap.add_argument("--interval", type=int, default=0)
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--no-post", action="store_true")
    ap.add_argument("--duration", type=int, default=0)
    ap.add_argument("--init-config", action="store_true")
    args = ap.parse_args()
    if args.init_config:
        cfg = load_cfg(); save_cfg(cfg)
        print(json.dumps(cfg, ensure_ascii=False, indent=2)); return 0
    return run(args)

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
