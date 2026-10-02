# -*- coding: utf-8 -*-
"""Q46 改动：测量第六幕收尾要用的素材（shadow / goal02 / Continue / all-picture）"""
import os
from PIL import Image
import numpy as np

BASE = r"E:\new-journey\assets"
FILES = [
    ("screen4/shadow.png",         "第四幕蒙黑层（第六幕复用）"),
    ("screen4/Continue.png",       "第四幕 Continue（第六幕复用）"),
    ("screen4/goal01.png",         "第四幕 Goal 卡（对照）"),
    ("screen7/goal02-picture.png", "第六幕 Goal 卡（新增）"),
    ("screen6/all-picture.png",    "第六幕整图"),
]

print("=" * 78)
for rel, desc in FILES:
    p = os.path.join(BASE, rel.replace("/", os.sep))
    im = Image.open(p)
    w, h = im.size
    rgba = im.convert("RGBA")
    a = np.array(rgba)[:, :, 3]
    ys, xs = np.nonzero(a > 8)
    if len(xs):
        bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    else:
        bbox = None
    # 不透明像素平均 alpha（判断蒙黑层的半透明度）
    op = a[a > 0]
    mean_a = float(op.mean()) if op.size else 0.0
    # 主色（不透明区 RGB 均值）
    arr = np.array(rgba)
    m = a > 200
    if m.any():
        rgb = arr[:, :, :3][m].mean(axis=0)
        mean_rgb = tuple(int(round(v)) for v in rgb)
    else:
        mean_rgb = None
    print("%-40s %s" % (rel, desc))
    print("   尺寸        : %d x %d" % (w, h))
    print("   alpha>8 包围: %s" % (bbox,))
    print("   平均 alpha  : %.1f / 255  (占比 %.1f%% 的像素 alpha>0)"
          % (mean_a, 100.0 * (a > 0).sum() / a.size))
    print("   主体 RGB 均值: %s" % (mean_rgb,))
    print("-" * 78)

# Continue.png 是否需要缩放：第四幕 CSS 写的是 265x31
p = os.path.join(BASE, "screen4", "Continue.png")
im = Image.open(p)
print("Continue.png 原始尺寸 = %s  ；第四幕 CSS 里写的显示尺寸 = 265 x 31" % (im.size,))
p = os.path.join(BASE, "screen7", "goal02-picture.png")
im = Image.open(p)
print("goal02-picture.png 原始尺寸 = %s ；第四幕 goal01 显示尺寸 = 758 x 579" % (im.size,))
