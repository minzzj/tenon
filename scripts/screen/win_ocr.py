#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""榫卯 V4 · 屏幕文字识别（超低占用：Windows 系统内置字库 OCR，非大模型）

- 主引擎：Windows.Media.Ocr（本地、离线、系统字库识别，中文已装 zh-Hans-CN）
- 可选：--font-match 时再用自研字体模板相似度引擎做字体/置信度校验
输出：{ok,engine,lines:[{text,box,confidence}],text,elapsedMs}
用法：python win_ocr.py --image shot.png [--json] [--region x,y,w,h] [--font-match]
"""
import argparse, asyncio, json, os, sys, time

def log(*a):
    print(*a, file=sys.stderr, flush=True)

async def _ocr_file(path, region=None):
    from winrt.windows.storage.streams import InMemoryRandomAccessStream, DataWriter
    from winrt.windows.graphics.imaging import BitmapDecoder
    from winrt.windows.media.ocr import OcrEngine
    data = open(path, "rb").read()
    stream = InMemoryRandomAccessStream()
    writer = DataWriter(stream.get_output_stream_at(0))
    writer.write_bytes(data)
    await writer.store_async()
    await writer.flush_async()
    stream.seek(0)
    decoder = await BitmapDecoder.create_async(stream)
    bitmap = await decoder.get_software_bitmap_async()
    engine = OcrEngine.try_create_from_language(OcrEngine.available_recognizer_languages[0])
    if engine is None:
        engine = OcrEngine.try_create_from_user_profile_languages()
    if engine is None:
        raise RuntimeError("Windows OCR 引擎不可用（缺少语言包）")
    result = await engine.recognize_async(bitmap)
    lines = []
    for line in result.lines:
        words = list(line.words)
        box = None
        if words:
            xs = [int(w.bounding_rect.x) for w in words]
            ys = [int(w.bounding_rect.y) for w in words]
            x2 = [int(w.bounding_rect.x + w.bounding_rect.width) for w in words]
            y2 = [int(w.bounding_rect.y + w.bounding_rect.height) for w in words]
            box = [min(xs), min(ys), max(x2) - min(xs), max(y2) - min(ys)]
        lines.append({"text": line.text, "box": box,
                      "words": [{"text": w.text,
                                 "box": [int(w.bounding_rect.x), int(w.bounding_rect.y),
                                         int(w.bounding_rect.width), int(w.bounding_rect.height)]} for w in words]})
    return lines

def _word_similarity(gray_arr, word):
    """渲染单个词/字（msyh/simsun）与截图词区域比较，返回 NCC 相似度"""
    try:
        import numpy as np
        from PIL import Image, ImageDraw, ImageFont
        txt = (word.get("text") or "").strip().replace(" ", "")
        box = word.get("box")
        if not txt or not box:
            return None
        x, y, w, h = box
        if w < 3 or h < 5:
            return None
        crop = gray_arr[max(0, y):y + h, max(0, x):x + w].astype(np.float32)
        if crop.size == 0:
            return None
        if crop.mean() < 110:
            crop = 255 - crop
        best = 0.0
        for fp in [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simsun.ttc"]:
            try:
                font = ImageFont.truetype(fp, max(7, int(h * 0.88)))
            except Exception:
                continue
            cache_key = (txt, w, h, fp)
            cached = _RENDER_CACHE.get(cache_key)
            if cached is not None:
                ren = cached
                a = crop - crop.mean(); b = ren - ren.mean()
                den = float((a * a).sum()) ** 0.5 * float((b * b).sum()) ** 0.5
                if den > 1e-6:
                    best = max(best, float((a * b).sum() / den))
                continue
            im = Image.new("L", (max(4, w), max(4, h)), 255)
            d = ImageDraw.Draw(im)
            bbox = font.getbbox(txt)
            d.text((1 - bbox[0], 1 - bbox[1]), txt, font=font, fill=0)
            ren = np.array(im).astype(np.float32)
            _RENDER_CACHE[cache_key] = ren
            if len(_RENDER_CACHE) > 4000:
                _RENDER_CACHE.clear()
            a = crop - crop.mean(); b = ren - ren.mean()
            den = float((a * a).sum()) ** 0.5 * float((b * b).sum()) ** 0.5
            if den < 1e-6:
                continue
            sim = float((a * b).sum() / den)
            # 微小平移搜索（±1px），避免渲染基线偏差
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    try:
                        shifted = np.roll(np.roll(ren, dy, axis=0), dx, axis=1)
                        b2 = shifted - shifted.mean()
                        den2 = float((a * a).sum()) ** 0.5 * float((b2 * b2).sum()) ** 0.5
                        if den2 > 1e-6:
                            sim = max(sim, float((a * b2).sum() / den2))
                    except Exception:
                        pass
            best = max(best, sim)
        return round(max(0.0, min(1.0, best)), 3)
    except Exception:
        return None


def _line_similarity(gray_img, line):
    import numpy as np
    try:
        arr = np.array(gray_img)
        words = line.get("words") or []
        if words:
            sims = [_word_similarity(arr, w) for w in words]
            sims = [s for s in sims if s is not None]
            return round(sum(sims) / len(sims), 3) if sims else None
        # 回退：整行
        if line.get("box"):
            return _word_similarity(arr, {"text": line.get("text", ""), "box": line["box"]})
        return None
    except Exception:
        return None

def ocr_image(path, region=None, font_match=False):
    t0 = time.time()
    # 区域裁剪（可选）
    tmp = None
    if region:
        from PIL import Image
        im = Image.open(path)
        x, y, w, h = [int(v) for v in region.split(",")]
        tmp = os.path.join(os.path.dirname(path), "crop-%d.png" % int(time.time() * 1000))
        im.crop((x, y, x + w, y + h)).save(tmp)
        src = tmp
    else:
        src = path
    try:
        lines = asyncio.run(_ocr_file(src))
    finally:
        if tmp and os.path.exists(tmp):
            try: os.remove(tmp)
            except Exception: pass
    # 字库/字体相似度校验（仅在 fontMatch 时计算，避免日常采集开销）
    out_avg = None
    if font_match:
        try:
            from PIL import Image as _Image
            _gray = _Image.open(src).convert("L")
            sims = []
            for l in lines[:40]:
                sim = _line_similarity(_gray, l)
                l["similarity"] = sim
                if sim is not None:
                    sims.append(sim)
            out_avg = round(sum(sims) / len(sims), 3) if sims else None
        except Exception:
            out_avg = None
    text = "\n".join(l["text"] for l in lines)
    out = {"ok": True, "engine": "windows-ocr", "provider": "windows.media.ocr",
           "language": "zh-Hans-CN", "lines": lines, "text": text,
           "avgSimilarity": out_avg,
           "elapsedMs": int((time.time() - t0) * 1000)}
    if font_match:
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            import font_ocr
            from PIL import Image
            import numpy as np
            g = np.array(Image.open(src).convert("L"))
            fm = font_ocr.ocr_image(g, {"threshold": 0.9})
            out["fontMatch"] = {"elapsedMs": fm.get("elapsedMs"), "chars": len(fm.get("text") or "")}
        except Exception as e:
            out["fontMatch"] = {"error": str(e)[:200]}
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="")
    ap.add_argument("--region", default="")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--font-match", action="store_true")
    ap.add_argument("--min-similarity", type=float, default=0.0)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        from PIL import Image, ImageDraw, ImageFont
        import tempfile
        samples = [("榫卯超级终端", "打开记事本，把电脑音量调到六十"),
                   ("今日总结", "今天看了 12 个视频，完成了 3 个任务"),
                   ("设备已连接", "工作台 在线 · 客厅电视 离线")]
        results = []
        for i, (title, body) in enumerate(samples):
            im = Image.new("RGB", (900, 160), "white")
            d = ImageDraw.Draw(im)
            f1 = ImageFont.truetype(r"C:\Windows\Fonts\msyhbd.ttc", 34)
            f2 = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 22)
            d.text((20, 16), title, font=f1, fill="black")
            d.text((20, 82), body, font=f2, fill="black")
            p = os.path.join(tempfile.gettempdir(), "tenon-ocr-%d.png" % i)
            im.save(p)
            out = ocr_image(p)
            got = out["text"].replace("\n", "").replace(" ", "")
            expect = (title + body).replace(" ", "")
            import difflib
            ratio = difflib.SequenceMatcher(None, expect, got).ratio()
            results.append({"expect": expect, "got": got, "ratio": round(ratio, 3)})
            print("case %d ratio=%.3f got=%s" % (i, ratio, got))
        ok = sum(1 for r in results if r["ratio"] >= 0.9)
        print("SELFTEST %d/%d >=90%%" % (ok, len(results)))
        print(json.dumps({"ok": ok == len(results), "results": results}, ensure_ascii=False))
        return 0 if ok == len(results) else 1
    if not args.image:
        print("用法: --image shot.png | --selftest", file=sys.stderr); return 1
    out = ocr_image(args.image, args.region or None, args.font_match)
    if args.min_similarity > 0:
        kept = [l for l in out.get("lines", []) if (l.get("similarity") is None or l.get("similarity") >= args.min_similarity)]
        out["lines"] = kept
        out["text"] = "\n".join(l["text"] for l in kept)
        out["filtered"] = True
        out["minSimilarity"] = args.min_similarity
    print(json.dumps(out, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
