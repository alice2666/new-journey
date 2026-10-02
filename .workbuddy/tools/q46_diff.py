# -*- coding: utf-8 -*-
"""校验 goal02-picture 与 goal01 是否同模板（决定能否直接沿用 goal01 的坐标 221/120）"""
import os
from PIL import Image
import numpy as np

A = r"E:\new-journey\assets\screen4\goal01.png"
B = r"E:\new-journey\assets\screen7\goal02-picture.png"

a = np.array(Image.open(A).convert("RGBA")).astype(np.int16)
b = np.array(Image.open(B).convert("RGBA")).astype(np.int16)
print("尺寸:", a.shape, b.shape)

diff = np.abs(a - b)
rgb_d = diff[:, :, :3].max(axis=2)
a_d = diff[:, :, 3]

same_a = (a_d <= 3)          # alpha 基本一致的像素
print("alpha 通道一致(<=3)的像素占比: %.1f%%" % (100.0 * same_a.sum() / a_d.size))

# 只在两者都不透明的区域比 RGB
op = (a[:, :, 3] > 200) & (b[:, :, 3] > 200)
d = rgb_d[op]
print("两者都 alpha>200 的区域: %d px" % op.sum())
print("该区域内 RGB 最大通道差 —— 均值 %.2f / 中位 %.2f / >16 的占比 %.2f%%"
      % (d.mean(), np.median(d), 100.0 * (d > 16).sum() / d.size))
print("该区域内 RGB 逐像素完全一致(差==0)的比例: %.1f%%"
      % (100.0 * (d == 0).sum() / d.size))

# 差异集中在哪里（按行/列统计）
rowdiff = (rgb_d * op).sum(axis=1)
colsdiff = (rgb_d * op).sum(axis=0)
ys = np.nonzero(rowdiff)[0]
xs = np.nonzero(colsdiff)[0]
print("有差异的行范围: y %d ~ %d" % (ys.min(), ys.max()))
print("有差异的列范围: x %d ~ %d" % (xs.min(), xs.max()))
print("→ 若差异只集中在卡片中部的文字带，说明是同一模板、仅换文案")

# 按 y 分带统计差异密度（每 60px 一带）
print("\n按 y 分带（每 60px）差异像素占比：")
for y0 in range(0, a.shape[0], 60):
    seg = op[y0:y0 + 60]
    if seg.sum() == 0:
        continue
    sd = (rgb_d[y0:y0 + 60] > 16)[seg]
    print("  y %3d-%3d : 差异像素 %.2f%%" % (y0, y0 + 59, 100.0 * sd.sum() / seg.sum()))
