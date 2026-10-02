# -*- coding: utf-8 -*-
"""修正口径：分别处理「碎片并集 F」「静态底 M」「整图 A」，验证 M = A - F"""
import os
import numpy as np
from PIL import Image

D = r"E:\new-journey\assets\screen6"


def load(f):
    return np.asarray(Image.open(os.path.join(D, f)).convert("RGBA")).astype(np.int16)


allimg = load("all-picture.png")
many = load("piece-many.png")
H, W = allimg.shape[:2]
OX, OY = 178, 126
FINAL = {
    "picture-01-01.png": (178, 127), "picture-11-01.png": (334, 485),
    "picture-05-01.png": (438, 255), "picture-03-02.png": (577, 126),
    "picture-09-02.png": (626, 311), "picture-10-02.png": (178, 506),
    "picture-06-03.png": (581, 159), "picture-04-03.png": (178, 184),
    "picture-08-03.png": (334, 318),
}

A = allimg[:, :, 3] > 128          # 整图（all-picture）不透明区
M = many[:, :, 3] > 128            # 静态底不透明区

# 9 张碎片并集 F，并同时拼出画面
F = np.zeros((H, W), dtype=bool)
canvas = np.zeros((H, W, 3), dtype=np.int16)
canvas[:] = many[:, :, :3]
for f, (cl, ct) in FINAL.items():
    im = load(f)
    h, w = im.shape[:2]
    dx, dy = cl - OX, ct - OY
    m = im[:, :, 3] > 128
    x0, y0 = max(dx, 0), max(dy, 0)
    x1, y1 = min(dx + w, W), min(dy + h, H)
    sub = im[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    mm = m[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    canvas[y0:y1, x0:x1][mm] = sub[:, :, :3][mm]
    F[y0:y1, x0:x1] |= mm

tot = A.sum()
print("=== 三个集合的规模（以整图不透明区 A = %d px 为 100%%）===" % tot)
print("  A 整图            : %7d px" % tot)
print("  F 9 张碎片并集     : %7d px  (占 A 的 %.1f%%)" % (F.sum(), 100.0 * (F & A).sum() / tot))
print("  M 静态底不透明区   : %7d px  (占 A 的 %.1f%%)" % (M.sum(), 100.0 * (M & A).sum() / tot))
print("  F ∩ M 重叠         : %7d px  (%.2f%% of A)  ← 应接近 0" % ((F & M).sum(), 100.0 * (F & M).sum() / tot))
print("  F ∪ M 覆盖         : %7d px  (%.1f%% of A)" % ((F | M & A).sum() if False else ((F | M) & A).sum(), 100.0 * ((F | M) & A).sum() / tot))

# 核心验证：M 是否 = A - F
gap = A & (~F)                     # 整图中「碎片未覆盖」的区域
print("\n=== 核心验证：静态底是不是「整图减去 9 张碎片」 ===")
print("  整图中碎片未覆盖区 (A-F) = %7d px  (占 A 的 %.1f%%)" % (gap.sum(), 100.0 * gap.sum() / tot))
inter = (gap & M).sum()
print("  该区域被静态底覆盖       = %.1f%%" % (100.0 * inter / gap.sum()))
print("  静态底落在该区域内       = %.1f%%" % (100.0 * inter / M.sum()))
print("  IoU = %.4f" % (inter / (gap | M).sum()))
print("  该区域逐像素平均绝对差（静态底 vs 整图）= %.4f / 255"
      % np.abs(many[:, :, :3] - allimg[:, :, :3])[gap].mean())

# 拼合结果 vs all-picture
print("\n=== 拼合结果（静态底 + 9 张碎片）vs all-picture ===")
d = np.abs(canvas - allimg[:, :, :3])[A]
print("  全图口径：平均绝对差 %.4f / 255；差 >2 的像素占 %.3f%%" % (d.mean(), 100.0 * (d > 2).mean()))
d2 = np.abs(canvas - allimg[:, :, :3])[A & F]
print("  碎片覆盖区：平均绝对差 %.4f / 255" % d2.mean())
d3 = np.abs(canvas - allimg[:, :, :3])[gap]
print("  静态底负责区：平均绝对差 %.4f / 255" % d3.mean())

# 单张碎裂与整图的吻合度（用最终坐标）
print("\n=== 9 张碎片在最终坐标下与 all-picture 的吻合度 ===")
for f, (cl, ct) in FINAL.items():
    im = load(f)
    h, w = im.shape[:2]
    dx, dy = cl - OX, ct - OY
    m = im[:, :, 3] > 128
    x0, y0 = max(dx, 0), max(dy, 0)
    x1, y1 = min(dx + w, W), min(dy + h, H)
    sub = im[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    mm = m[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    ref = allimg[y0:y1, x0:x1]
    print("  %-22s left %4d / top %4d   平均绝对差 %.2f"
          % (f, cl, ct, np.abs(sub[:, :, :3] - ref[:, :, :3])[mm].mean()))
