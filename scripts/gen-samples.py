#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""榫卯 Tenon v0.1 · 示例素材生成器

用 PIL 生成演示/测试用 PNG：
  示例空间/样品图/样品01.png .. 样品09.png   —— 尺寸各异、内容可辨识（色块 + 编号 + 尺寸）
  示例空间/样品图/样品10.png                —— 0 字节，模拟「文件损坏」样本
  示例空间/临时/过期草稿.png                —— file.delete 默认目标（供删除演练用）

约定：统一 8bit RGB、非隔行，node-agent/lib/png.js 可直接解码。
运行：python scripts/gen-samples.py
"""
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print('ERROR: 需要 Pillow（pip install pillow）', file=sys.stderr)
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAMPLES_DIR = os.path.join(ROOT, '示例空间', '样品图')
TEMP_DIR = os.path.join(ROOT, '示例空间', '临时')

# (文件名, 宽, 高, 背景色, 主色) —— 9 张，尺寸全部不同
SAMPLES = [
    ('样品01.png', 640, 480, (22, 34, 56), (102, 227, 210)),
    ('样品02.png', 800, 600, (52, 24, 40), (255, 180, 92)),
    ('样品03.png', 1024, 768, (18, 46, 38), (233, 241, 250)),
    ('样品04.png', 500, 500, (44, 30, 20), (255, 120, 120)),
    ('样品05.png', 1200, 900, (16, 24, 40), (120, 170, 255)),
    ('样品06.png', 320, 240, (60, 60, 28), (240, 240, 160)),
    ('样品07.png', 960, 540, (30, 20, 50), (200, 140, 255)),
    ('样品08.png', 700, 500, (20, 44, 44), (255, 210, 120)),
    ('样品09.png', 2000, 1200, (12, 18, 30), (102, 227, 210)),
]


def load_font(size):
    """尽力加载一个可显示中文的粗体字体，失败则退回默认字体。"""
    candidates = [
        r'C:\Windows\Fonts\msyhbd.ttc',
        r'C:\Windows\Fonts\msyh.ttc',
        r'C:\Windows\Fonts\simhei.ttf',
        r'C:\Windows\Fonts\arialbd.ttf',
        r'C:\Windows\Fonts\arial.ttf',
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    try:
        return ImageFont.load_default(size)
    except Exception:
        return ImageFont.load_default()


def centered(draw, xy, text, font, fill):
    """在矩形区域中心绘制一行字。"""
    box = draw.textbbox((0, 0), text, font=font)
    w = box[2] - box[0]
    h = box[3] - box[1]
    draw.text((xy[0] - w / 2 - box[0], xy[1] - h / 2 - box[1]), text, font=font, fill=fill)


def make_sample(path, index, width, height, bg, accent):
    img = Image.new('RGB', (width, height), bg)
    draw = ImageDraw.Draw(img)
    pad = max(8, min(width, height) // 24)
    # 外框 + 内框，方便肉眼确认裁剪是否居中
    draw.rectangle([pad, pad, width - 1 - pad, height - 1 - pad], outline=accent, width=max(2, pad // 4))
    inner = [pad * 2, pad * 2, width - 1 - pad * 2, height - 1 - pad * 2]
    draw.rectangle(inner, outline=tuple(int(c * 0.55) for c in accent), width=2)
    # 居中色块：正方形，作为「裁方图」的视觉锚点
    side = int(min(width, height) * 0.42)
    cx, cy = width // 2, height // 2
    box = [cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2]
    draw.rectangle(box, fill=accent, outline=(10, 14, 22), width=3)
    # 色块内：大编号
    big = load_font(max(24, side // 2))
    label = '%02d' % index
    centered(draw, (cx, cy), label, big, (12, 18, 30))
    # 左上角：中文标题 + 尺寸
    title_font = load_font(max(16, width // 32))
    draw.text((pad * 2 + 6, pad * 2 + 4), '榫卯样品 %s' % label, font=title_font, fill=accent)
    size_font = load_font(max(12, width // 64))
    draw.text((pad * 2 + 6, pad * 2 + 4 + title_font.size + 8), '%d x %d' % (width, height), font=size_font, fill=(200, 210, 225))
    # 四角小刻度，便于验证居中裁剪
    tick = max(10, pad)
    for (x0, y0, x1, y1) in (
        (cx - tick, cy - side // 2 - tick, cx + tick, cy - side // 2 - tick // 2),
        (cx - tick, cy + side // 2 + tick // 2, cx + tick, cy + side // 2 + tick),
        (cx - side // 2 - tick, cy - tick, cx - side // 2 - tick // 2, cy + tick),
        (cx + side // 2 + tick // 2, cy - tick, cx + side // 2 + tick, cy + tick),
    ):
        draw.rectangle([x0, y0, x1, y1], fill=accent)
    img.save(path, 'PNG')
    return img.size


def main():
    os.makedirs(SAMPLES_DIR, exist_ok=True)
    os.makedirs(TEMP_DIR, exist_ok=True)
    made = []
    for index, (name, width, height, bg, accent) in enumerate(SAMPLES, start=1):
        path = os.path.join(SAMPLES_DIR, name)
        size = make_sample(path, index, width, height, bg, accent)
        made.append((name, size, os.path.getsize(path)))
    # 样品10：0 字节损坏样本（不要用 PIL 写，直接写空文件）
    broken = os.path.join(SAMPLES_DIR, '样品10.png')
    with open(broken, 'wb') as fh:
        fh.write(b'')
    made.append(('样品10.png', (0, 0), 0))
    # file.delete 默认目标：一张小图，供「删除」演练真实可删
    draft_path = os.path.join(TEMP_DIR, '过期草稿.png')
    tmp = Image.new('RGB', (256, 192), (40, 32, 24))
    d = ImageDraw.Draw(tmp)
    d.rectangle([16, 16, 239, 175], outline=(255, 180, 92), width=3)
    centered(d, (128, 96), '过期草稿', load_font(28), (255, 180, 92))
    tmp.save(draft_path, 'PNG')
    print('OK 示例空间/样品图: %d 张（含 0 字节坏样本 样品10.png）' % len(made))
    print('OK 示例空间/临时/过期草稿.png: %d bytes' % os.path.getsize(draft_path))
    for name, size, nbytes in made:
        print('  - %s %dx%d %d bytes' % (name, size[0], size[1], nbytes))
    return 0


if __name__ == '__main__':
    sys.exit(main())