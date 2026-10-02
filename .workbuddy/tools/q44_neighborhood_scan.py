# -*- coding: utf-8 -*-
"""对 9 张碎片在「用户给定值」与「此前实测值」附近做邻域精扫，确定每张的最终目标坐标"""
import os
import numpy as np
from PIL import Image

D = r"E:\new-journey\assets\screen6"
allimg = np.asarray(Image.open(os.path.join(D, "all-picture.png")).convert("RGBA")).astype(np.int16)
H, W = allimg.shape[:2]
OX, OY = 178, 126


def load(f):
    return np.asarray(Image.open(os.path.join(D, f)).convert("RGBA")).astype(np.int16)


def diff_at(im, relx, rely):
    h, w = im.shape[:2]
    mask = im[:, :, 3] > 128
    x0, y0 = max(relx, 0), max(rely, 0)
    x1, y1 = min(relx + w, W), min(rely + h, H)
    if x1 <= x0 or y1 <= y0:
        return None
    sub = im[y0 - rely:y1 - rely, x0 - relx:x1 - relx]
    m = mask[y0 - rely:y1 - rely, x0 - relx:x1 - relx]
    ref = allimg[y0:y1, x0:x1]
    if m.sum() == 0:
        return None
    return float(np.abs(sub[:, :, :3] - ref[:, :, :3])[m].mean())


# 文件名 -> (用户给定 画布 left/top, 此前实测 画布 left/top)
ITEMS = [
    ("picture-01-01.png", (178, 126), (178, 127)),
    ("picture-11-01.png", (334, 488), (334, 485)),
    ("picture-05-01.png", (438, 256), (438, 255)),
    ("picture-03-02.png", (578, 128), (577, 126)),
    ("picture-09-02.png", (627, 312), (626, 311)),
    ("picture-10-02.png", (178, 505), (178, 505)),
    ("picture-06-03.png", (581, 158), (582, 160)),
    ("picture-04-03.png", (178, 186), (178, 184)),
    ("picture-08-03.png", (332, 318), (334, 318)),
]

R = 6  # 邻域半径
print("邻域精扫（半径 ±%d px）：对每张碎片找「遮罩内与 all-picture 平均绝对差」最小的位子\n" % R)
print("%-22s %-16s %-16s %-16s %s" % ("碎片", "用户给定", "用户值误差", "最优位子(画布)", "最优误差"))
print("-" * 100)

final = {}
for f, user, meas in ITEMS:
    im = load(f)
    h, w = im.shape[:2]
    ux, uy = user[0] - OX, user[1] - OY
    du = diff_at(im, ux, uy)
    best = None
    for ddy in range(-R, R + 1):
        for ddx in range(-R, R + 1):
            v = diff_at(im, ux + ddx, uy + ddy)
            if v is None:
                continue
            if best is None or v < best[0]:
                best = (v, ux + ddx, uy + ddy)
    bv, bx, by = best
    cl, ct = bx + OX, by + OY
    final[f] = (cl, ct, bv)
    print("%-22s (%4d,%4d)      %6.2f          (%4d,%4d)          %6.2f   Δ=(%+d,%+d)"
          % (f, user[0], user[1], du, cl, ct, bv, cl - user[0], ct - user[1]))

print("\n=== 最终采用坐标（10 进制整数，画布 1200×896）===")
ORDER = ["picture-01-01.png", "picture-11-01.png", "picture-05-01.png",
         "picture-03-02.png", "picture-09-02.png", "picture-10-02.png",
         "picture-06-03.png", "picture-04-03.png", "picture-08-03.png"]
for f in ORDER:
    l, t, v = final[f]
    print("  %-22s left %4d / top %4d   距右 %5d / 距下 %5d   误差 %.2f"
          % (f, l, t, 1200 - l, 896 - t, v))

# 目标位两两最近距离（用于容差校核）
print("\n=== 9 个目标位中心两两距离（最近的 5 对）===")
cs = []
for f in ORDER:
    l, t, _ = final[f]
    im = load(f)
    h, w = im.shape[:2]
    cs.append((f, l + w / 2.0, t + h / 2.0))
pairs = []
for i in range(len(cs)):
    for j in range(i + 1, len(cs)):
        d = ((cs[i][1] - cs[j][1]) ** 2 + (cs[i][2] - cs[j][2]) ** 2) ** 0.5
        pairs.append((d, cs[i][0], cs[j][0]))
pairs.sort()
for d, a, b in pairs[:5]:
    print("  %-22s ↔ %-22s  %7.1f px" % (a, b, d))
print("  → 最近 %.1f px；容差 30 px %s" % (pairs[0][0], "安全（不足一半）" if pairs[0][0] > 60 else "偏松"))
