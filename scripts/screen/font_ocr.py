#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""榫卯 V4 · 超低占用字库模板 OCR（标准字体相似度匹配，不用大模型）

思路：
  截图 → 灰度/二值（自动深色/浅色主题） → 文本行检测（形态学+轮廓）
       → 行内逐字切分（连通域 + 投影） → 用系统标准字体（msyh/simsun/consola）渲染同高模板
       → 归一化相似度（NCC）匹配 → 阈值过滤 → 拼接文本行
特点：模板缓存到 data/screen/templates.npz；无网络；单次截图 OCR 目标 <1.5s。

用法：
  python font_ocr.py --image shot.png [--json] [--region x,y,w,h] [--threshold 0.86] [--max-lines 60]
  python font_ocr.py --selftest          # 生成标准字体测试图并测准确率
"""
import argparse, json, os, sys, time, hashlib, math

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
CACHE_DIR = os.path.join(ROOT, "data", "screen")
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simsun.ttc",
    r"C:\Windows\Fonts\consola.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]
CJK = ("的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞")
CHARSET = "".join(dict.fromkeys(CJK + "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,:;!?()[]{}<>+-=/%*\"'`~@#$&_|\\，。！？、；：“”‘’（）《》【】—…· "))

def log(*a):
    print(*a, file=sys.stderr, flush=True)

def _np():
    import numpy as np
    return np

def load_gray(path):
    from PIL import Image
    im = Image.open(path).convert("L")
    np = _np()
    return np.array(im)

def _prepare_binary(arr):
    np = _np()
    import cv2
    # 自动判断深色/浅色主题：边缘像素均值
    border = np.concatenate([arr[0, :], arr[-1, :], arr[:, 0], arr[:, -1]])
    dark_theme = border.mean() < 110
    if dark_theme:
        arr = 255 - arr
    # Otsu 二值，文字为白
    _, bw = cv2.threshold(arr, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # 若白像素过多，反转
    if bw.mean() > 127:
        bw = 255 - bw
    return arr, bw, dark_theme

def find_lines(bw):
    np = _np()
    import cv2
    H, W = bw.shape[:2]
    # 水平膨胀把同一行字符连起来
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, W // 200), 1))
    merged = cv2.dilate(bw, k, iterations=1)
    merged = cv2.erode(merged, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 1)))
    contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if h < 9 or w < 6:
            continue
        if w * h < 40:
            continue
        if h > H * 0.5:
            continue
        boxes.append((x, y, w, h))
    boxes.sort(key=lambda b: (b[1] // max(8, b[3] // 2), b[0]))
    return boxes

def segment_chars(bw, box):
    np = _np()
    import cv2
    x, y, w, h = box
    roi = bw[y:y + h, x:x + w]
    # 连通域切字；小连通域（点、偏旁）并入附近字
    n, labels, stats, cents = cv2.connectedComponentsWithStats(roi, connectivity=8)
    comps = []
    for i in range(1, n):
        cx, cy, cw, ch, area = stats[i]
        if area < max(3, h * 0.5) or ch < h * 0.25:
            continue
        comps.append([cx, cy, cw, ch])
    if not comps:
        return []
    comps.sort(key=lambda c: c[0])
    # 合并间距过小的相邻连通域（同一字）
    merged = []
    for c in comps:
        if merged and c[0] - (merged[-1][0] + merged[-1][2]) < max(1, h * 0.16) and abs(c[1] - merged[-1][1]) < h * 0.6:
            m = merged[-1]
            x2 = max(m[0] + m[2], c[0] + c[2])
            y2 = min(m[1], c[1]); y3 = max(m[1] + m[3], c[1] + c[3])
            m[0] = min(m[0], c[0]); m[1] = y2; m[2] = x2 - m[0]; m[3] = y3 - y2
        else:
            merged.append(list(c))
    # 过滤窄条（可能是竖线/噪声）但保留 i l 1 等
    out = []
    for c in merged:
        if c[3] < h * 0.35 and c[2] > h * 0.25:
            continue
        out.append((x + c[0], y + c[1], c[2], c[3]))
    return out

def render_glyph(ch, font_path, size):
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype(font_path, size)
    except Exception:
        return None
    bbox = font.getbbox(ch)
    w = max(1, bbox[2] - bbox[0]); h = max(1, bbox[3] - bbox[1])
    im = Image.new("L", (max(size, w + 4), max(size, h + 4)), 0)
    d = ImageDraw.Draw(im)
    d.text((2 - bbox[0], 2 - bbox[1]), ch, fill=255, font=font)
    return im

_TEMPLATE_CACHE = {}

def _norm_vec(patch):
    np = _np()
    import cv2
    if patch is None or patch.size == 0:
        return None
    p = patch.astype(np.float32)
    # 归一化到固定 20x20，去均值后单位化（NCC）
    p = cv2.resize(p, (20, 20), interpolation=cv2.INTER_AREA)
    p = p - p.mean()
    n = float((p * p).sum()) ** 0.5
    if n < 1e-6:
        return None
    return (p / n).reshape(-1)

def build_templates(height, fonts=None):
    np = _np()
    key = (height, tuple(fonts or []))
    if key in _TEMPLATE_CACHE:
        return _TEMPLATE_CACHE[key]
    fonts = fonts or [f for f in FONT_CANDIDATES if os.path.exists(f)]
    chars = list(CHARSET)
    vecs = []
    labels = []
    for fp in fonts[:2]:  # 最多两种字体，控制模板量
        for ch in chars:
            im = render_glyph(ch, fp, height)
            v = _norm_vec(np.array(im)) if im is not None else None
            if v is not None:
                vecs.append(v); labels.append(ch)
    if not vecs:
        _TEMPLATE_CACHE[key] = (None, None)
        return _TEMPLATE_CACHE[key]
    T = np.vstack(vecs)
    _TEMPLATE_CACHE[key] = (T, labels)
    log("[font_ocr] templates built: h=%d chars=%d fonts=%d" % (height, len(labels), min(2, len(fonts))))
    return _TEMPLATE_CACHE[key]

def ocr_image(gray, opts=None):
    opts = opts or {}
    np = _np()
    import cv2
    threshold = float(opts.get("threshold", 0.86))
    t0 = time.time()
    arr, bw, dark = _prepare_binary(gray)
    boxes = find_lines(bw)
    if len(boxes) > int(opts.get("max_lines", 80)):
        boxes = boxes[: int(opts.get("max_lines", 80))]
    lines = []
    for (x, y, w, h) in boxes:
        height = max(10, int(round(h * 0.92)))
        T, labels = build_templates(height)
        if T is None:
            continue
        segs = segment_chars(bw, (x, y, w, h))
        text = []; scores = []
        for (sx, sy, sw, sh) in segs:
            patch = bw[sy:sy + sh, sx:sx + sw]
            v = _norm_vec(patch)
            if v is None:
                continue
            sims = T @ v
            idx = int(np.argmax(sims))
            best = float(sims[idx])
            if best >= threshold:
                text.append(labels[idx]); scores.append(best)
        if text:
            line = "".join(text).strip()
            if line:
                lines.append({"text": line, "box": [int(x), int(y), int(w), int(h)],
                              "confidence": round(sum(scores) / len(scores), 3)})
    ms = int((time.time() - t0) * 1000)
    return {"ok": True, "lines": lines, "text": "\n".join(l["text"] for l in lines),
            "elapsedMs": ms, "darkTheme": bool(dark), "engine": "font-template"}

def selftest():
    from PIL import Image, ImageDraw, ImageFont
    np = _np()
    import cv2
    os.makedirs(CACHE_DIR, exist_ok=True)
    samples = [
        ("榫卯超级终端", "打开记事本，把电脑音量调到六十"),
        ("今日总结", "今天看了 12 个视频，完成了 3 个任务"),
        ("设备已连接", "工作台 在线 · 客厅电视 离线"),
    ]
    results = []
    for i, (title, body) in enumerate(samples):
        im = Image.new("L", (900, 160), 255)
        d = ImageDraw.Draw(im)
        f1 = ImageFont.truetype(r"C:\Windows\Fonts\msyhbd.ttc", 34)
        f2 = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 22)
        d.text((20, 16), title, font=f1, fill=0)
        d.text((20, 82), body, font=f2, fill=0)
        path = os.path.join(CACHE_DIR, "selftest-%d.png" % i)
        im.save(path)
        out = ocr_image(np.array(im))
        joined = out["text"].replace("\n", "")
        expect = (title + body).replace(" ", "")
        got = joined.replace(" ", "")
        # 字符级命中率
        import difflib
        ratio = difflib.SequenceMatcher(None, expect, got).ratio()
        results.append({"expect": expect, "got": got, "ratio": round(ratio, 3), "path": path})
        print("case %d ratio=%.3f got=%s" % (i, ratio, got))
    ok = sum(1 for r in results if r["ratio"] >= 0.9)
    print("SELFTEST %d/%d >=90%%" % (ok, len(results)))
    return {"ok": ok == len(results), "results": results}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="")
    ap.add_argument("--region", default="")
    ap.add_argument("--threshold", type=float, default=0.86)
    ap.add_argument("--max-lines", type=int, default=80)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        out = selftest()
        print(json.dumps({"ok": out["ok"]}, ensure_ascii=False))
        return 0 if out["ok"] else 1
    if not args.image:
        print("用法: --image shot.png | --selftest", file=sys.stderr); return 1
    from PIL import Image
    im = Image.open(args.image).convert("L")
    np = _np()
    arr = np.array(im)
    if args.region:
        x, y, w, h = [int(v) for v in args.region.split(",")]
        arr = arr[y:y + h, x:x + w]
    out = ocr_image(arr, {"threshold": args.threshold, "max_lines": args.max_lines})
    print(json.dumps(out, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
