# -*- coding: utf-8 -*-
"""Q44 坐标精度复核 + Q48 底板布局精确换算"""
import os
import numpy as np
from PIL import Image

D = r"E:\new-journey\assets\screen6"
ALL = os.path.join(D, "all-picture.png")

allimg = np.asarray(Image.open(ALL).convert("RGBA")).astype(np.int16)
H, W = allimg.shape[:2]
print("all-picture:", W, "x", H)

# 整图在画布上的原点
OX, OY = 178, 126


def score(fname, canvas_left, canvas_top, verbose=True):
    """把碎片贴在画布 (canvas_left, canvas_top)，返回遮罩内与 all-picture 的逐像素平均绝对差"""
    p = os.path.join(D, fname)
    im = np.asarray(Image.open(p).convert("RGBA")).astype(np.int16)
    h, w = im.shape[:2]
    dx, dy = canvas_left - OX, canvas_top - OY
    mask = im[:, :, 3] > 128
    x0, y0 = max(dx, 0), max(dy, 0)
    x1, y1 = min(dx + w, W), min(dy + h, H)
    if x1 <= x0 or y1 <= y0:
        return None
    sub = im[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    m = mask[y0 - dy:y1 - dy, x0 - dx:x1 - dx]
    ref = allimg[y0:y1, x0:x1]
    if m.sum() == 0:
        return None
    diff = np.abs(sub[:, :, :3] - ref[:, :, :3])[m].mean()
    if verbose:
        print("  %-22s canvas(%d,%d) rel(%d,%d)  遮罩像素 %7d  平均绝对差 %.2f" %
              (fname, canvas_left, canvas_top, dx, dy, int(m.sum()), diff))
    return diff


print("\n=== Q44: picture-06-03 位子复核 ===")
print("候选 A = 用户新给 right381/top158 -> left %d / top 158" % (1200 - 381 - 238))
print("候选 B = 此前实测 (404,34) 相对 -> left 582 / top 160")
print("候选 C = 用户原始（误）= 332/318（与 08-03 相同）\n")
for label, l, t in [("A 用户新给", 581, 158), ("B 实测", 582, 160), ("C 原始(误)", 332, 318)]:
    print("%s:" % label)
    score("picture-06-03.png", l, t)
print("\n参照 08-03 在 334/318:")
score("picture-08-03.png", 334, 318)

print("\n=== 9 张碎片在各自实测位子的吻合度（整表复核）===")
targets = {
    "picture-01-01.png": (178, 127),
    "picture-11-01.png": (334, 485),
    "picture-05-01.png": (438, 255),
    "picture-03-02.png": (577, 126),
    "picture-09-02.png": (626, 311),
    "picture-10-02.png": (178, 505),
    "picture-04-03.png": (178, 184),
    "picture-08-03.png": (334, 318),
}
for f, (l, t) in targets.items():
    score(f, l, t)
print("  picture-06-03.png      取上面 B")

# ---------- Q48: 底板 3 等分居中布局 ----------
print("\n" + "=" * 66)
print("=== Q48: 右侧底板碎片初始位置（3 等分居中，不重叠、不越界）===")
print("=" * 66)
PANEL_L, PANEL_R = 844, 1200          # frame-picture 覆盖 x 844..1200
PANEL_W = PANEL_R - PANEL_L           # 356
MARGIN = 20
USABLE = PANEL_W - 2 * MARGIN         # 316
CX = PANEL_L + PANEL_W / 2.0          # 1022
print("底板 x %d..%d（宽 %d）；左右各留 %d 边距 → 可用宽 %d；水平中心 x = %.1f"
      % (PANEL_L, PANEL_R, PANEL_W, MARGIN, USABLE, CX))

waves = {
    "第 1 波": [("picture-01-01.png", 241, 128), ("picture-11-01.png", 291, 158), ("picture-05-01.png", 256, 134)],
    "第 2 波": [("picture-03-02.png", 241, 131), ("picture-09-02.png", 192, 207), ("picture-10-02.png", 210, 139)],
    "第 3 波": [("picture-06-03.png", 238, 201), ("picture-04-03.png", 206, 240), ("picture-08-03.png", 306, 213)],
}
SLOT_H = 896 / 3.0
print("纵向 3 等分：每格高 %.1f，格中心 y = %.1f / %.1f / %.1f\n"
      % (SLOT_H, SLOT_H * 0.5, SLOT_H * 1.5, SLOT_H * 2.5))

for wave, items in waves.items():
    print("%s：" % wave)
    boxes = []
    for i, (f, w, h) in enumerate(items):
        cy = SLOT_H * (i + 0.5)
        left = CX - w / 2.0
        top = cy - h / 2.0
        boxes.append((f, left, top, w, h))
        ok_w = left >= PANEL_L + MARGIN - 0.5 and left + w <= PANEL_R - MARGIN + 0.5
        print("  %-22s 尺寸 %3d×%3d  left %6.1f  top %6.1f  (距右 %6.1f)  %s"
              % (f, w, h, left, top, 1200 - (left + w), "宽度 OK" if ok_w else "!! 越界"))
        # 单张高度是否落在自己那一格里
        in_slot = top >= i * SLOT_H - 0.5 and top + h <= (i + 1) * SLOT_H + 0.5
        if not in_slot:
            print("     !! 该碎片高度超出自己那一格")
    # 两两不重叠校核（含 4px 间隙要求）
    print("  两两间距校核：")
    for a in range(len(boxes)):
        for b in range(a + 1, len(boxes)):
            _, la, ta, wa, ha = boxes[a]
            _, lb, tb, wb, hb = boxes[b]
            gap = max(tb - (ta + ha), ta - (tb + hb))
            print("    %s ↔ %s  纵向间隙 %.1f px  %s"
                  % (boxes[a][0][8:13], boxes[b][0][8:13], gap,
                     "OK（不重叠）" if gap > 0 else "!! 重叠"))
    print()

print("最宽碎片 = %d px，可用宽 = %d px → %s"
      % (max(w for it in waves.values() for _, w, _ in it), USABLE,
         "无需缩放，原尺寸即可" if max(w for it in waves.values() for _, w, _ in it) <= USABLE else "!! 需缩放"))
