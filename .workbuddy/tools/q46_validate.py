# -*- coding: utf-8 -*-
"""v2.18 文档结构校验：表格列数一致性 / 残留占位符 / 关键小节齐全"""
import re
P = r"E:\new-journey\docs\01-需求文档.md"
lines = open(P, "rb").read().decode("utf-8").split("\n")

print("== 1) 表格列数一致性 ==")
bad = 0
i = 0
while i < len(lines):
    l = lines[i]
    if l.lstrip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s\-:|]+\|\s*$", lines[i + 1]):
        ncol = len(l.strip().strip("|").split("|"))
        j = i + 2
        while j < len(lines) and lines[j].lstrip().startswith("|"):
            c = len(lines[j].strip().strip("|").split("|"))
            if c != ncol:
                print("  L%-5d 列数 %d != 表头 %d : %s" % (j + 1, c, ncol, lines[j][:110]))
                bad += 1
            j += 1
        i = j
    else:
        i += 1
print("  列数不一致的表格行: %d" % bad)

print("\n== 2) 残留占位符 / 哨兵 ==")
for k in ["@@", "\x01", "\x02", "TODO", "待填", "XXX", "REPLACE"]:
    n = sum(1 for l in lines if k in l)
    print("  %-8s: %d" % (repr(k), n))

print("\n== 3) §9 小节齐全性 ==")
want = ["### 9.1 ", "### 9.2 ", "### 9.3 ", "### 9.4 ", "### 9.5 ", "### 9.6 ", "### 9.7 ", "### 9.8 ", "### 9.9 ", "### 9.10 ", "### 9.11 ",
        "#### 9.5.1 ", "#### 9.5.2 ", "#### 9.5.3 ", "#### 9.5.4 ", "#### 9.5.5 ", "#### 9.5.6 ",
        "#### 3.7.1 ", "#### 3.7.2 ", "#### 3.7.3 "]
for w in want:
    print("  %-14s: %s" % (w.strip(), "OK" if any(l.startswith(w) for l in lines) else "!!! 缺失"))

print("\n== 4) 顶层章节顺序 ==")
for l in lines:
    if re.match(r"^## \d+\.", l):
        print("  " + l[:60])

print("\n== 5) 全文引用完整性（§9.x 引用目标是否存在）==")
heads = set()
for l in lines:
    m = re.match(r"^#{2,4} (\d+(?:\.\d+)*) ", l)
    if m:
        heads.add(m.group(1))
refs = set()
for l in lines:
    for m in re.finditer(r"§(\d+(?:\.\d+)*)", l):
        refs.add(m.group(1))
missing = sorted(r for r in refs if r not in heads and not any(h.startswith(r + ".") or h == r for h in heads))
for r in missing:
    print("  引用 §%s 但找不到对应标题" % r)
if not missing:
    print("  全部引用均可解析")
