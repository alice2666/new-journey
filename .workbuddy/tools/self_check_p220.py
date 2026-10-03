# -*- coding: utf-8 -*-
"""批次 F 后自检：行尾/BOM、占位符、章节齐全、表格列数、§ 引用可解析性。"""
import re

PLAN = 'docs/02-开发计划.md'
REQ = 'docs/01-需求文档.md'

raw = open(PLAN, 'rb').read()
txt = raw.decode('utf-8')
lines = txt.split('\n')

print('===== 1) 行尾 / BOM =====')
print('CRLF 数:', raw.count(b'\r\n'), '| BOM:', raw.startswith(b'\xef\xbb\xbf'), '| 行数:', len(lines))
print('末尾换行:', lines[-1] == '' and '是' or '否')

print('===== 1b) 占位符残留 =====')
flag = False
for pat in ['@@', 'TODO', 'FIXME', 'XXX', '<<<', '>>>', '待补', '待填', '？？？', 'xxxx']:
    hits = [i + 1 for i, l in enumerate(lines) if pat in l]
    if hits:
        flag = True
        print(' ', pat, '->', hits[:20])
if not flag:
    print('  （无）')

print('===== 2) 计划文档一级标题（## ）=====')
lv2 = [(i + 1, l) for i, l in enumerate(lines) if l.startswith('## ')]
for n, l in lv2:
    print(' ', n, l)

print('===== 2b) 本轮应存在的关键子节 =====')
need = ['### 5.6 ', '### 5.7 ', '### 6.27 ', '### 6.28 ', '### 8.6 ', '### 9.5 ',
        '### 10.9 ', '### 10.10 ', '### 12.1.4 ', '### 13.20 ', '### 13.21 ',
        '### 12.1.2 ', '### 12.1.3 ']
for k in need:
    print(' ', 'OK ' if k in txt else 'MISS', k)

print('===== 2c) 版本号必须落在「已知集合」内 =====')
# v2.21 教训：8 处写成不存在的 v2.28（两文档都不存在该号）→ 关键词 grep 抓不到，
# 必须把每处 v2.x 与「需求文档 ∪ 计划文档的已有版本集合」比对。
_req_raw = open(REQ, 'rb').read().decode('utf-8')
_known = set(re.findall(r'v(\d+\.\d+)', _req_raw))
_known |= set(re.findall(r'v(\d+\.\d+)', txt))
# 文档自身的版本号（文档版本：**vX.Y**）也可能高于正文里的历史引用，属于已知
for _m in re.finditer(r'文档版本：\*\*v(\d+\.\d+)\*\*', txt):
    _known.add(_m.group(1))
for _m in re.finditer(r'文档版本：\*\*v(\d+\.\d+)\*\*', _req_raw):
    _known.add(_m.group(1))
_unknown = []
for _i, _l in enumerate(lines):
    for _m in re.finditer(r'v(\d+\.\d+)', _l):
        if _m.group(1) not in _known:
            _unknown.append((_i + 1, _m.group(0)))
if _unknown:
    for _n, _v in _unknown[:40]:
        print('  ⚠️ 行', _n, '::', _v, '（不在已知版本集合内）')
else:
    print('  （全部可解析）')

print('===== 3) 表格列数一致性 =====')


def is_tbl(l):
    return re.match(r'^\s*(?:>\s*)?\|', l) is not None


def ncols(l):
    s = re.sub(r'^\s*(?:>\s*)?', '', l)
    s = s.replace('\\|', '\x00')
    return s.count('|')


i = 0
blocks = 0
bad = []
while i < len(lines):
    if is_tbl(lines[i]):
        start = i
        blk = []
        while i < len(lines) and is_tbl(lines[i]):
            blk.append((i + 1, lines[i]))
            i += 1
        blocks += 1
        base = ncols(blk[0][1])
        for n, s in blk:
            if ncols(s) != base:
                bad.append((n, ncols(s), base, blk[0][0]))
    else:
        i += 1
print('表格块数:', blocks)
if bad:
    for n, c, b, s0 in bad:
        print('  ⚠️ 行', n, '列数', c, '≠ 表首(行', s0, ')', b)
else:
    print('  （全部一致）')

print('===== 4) § 引用可解析性 =====')
req_ids = set()
for l in open(REQ, encoding='utf-8'):
    m = re.match(r'^#{2,4}\s+(\d+(?:\.\d+)*)', l)
    if m:
        req_ids.add(m.group(1))
plan_ids = set()
for l in lines:
    m = re.match(r'^#{2,4}\s+(\d+(?:\.\d+)*)', l)
    if m:
        plan_ids.add(m.group(1))
all_ids = req_ids | plan_ids

tok = re.compile(r'§\s*(\d+(?:\.\d+)*)')
unres = {}
WL = {80}  # 行 80 是本版「原编号 → 新编号」的对照说明，其中的旧编号是有意保留的
for i, l in enumerate(lines):
    if (i + 1) in WL:
        continue
    for m in tok.finditer(l):
        t = m.group(1)
        if t not in all_ids:
            unres.setdefault(t, []).append(i + 1)
if unres:
    for t, ns in sorted(unres.items()):
        print('  ⚠️ 未解析 §%s -> 行 %s' % (t, ns[:12]))
else:
    print('  （全部可解析）')

print('===== 4b) 计划文档引用的「需求 §N」清单 =====')
for i, l in enumerate(lines):
    for m in re.finditer(r'需求[^\n]{0,14}?§\s*\d+(?:\.\d+)*', l):
        print('  行', i + 1, '::', m.group(0).replace('\n', ' '))

print('===== 5) 旧表述探雷（须落在「历史/已作废」语境）=====')
probes = ['全黑滞留', '全片终', '四次后移', '第五次后移', '点 `Continue` 后的全黑滞留']
for p in probes:
    hits = [i + 1 for i, l in enumerate(lines) if p in l]
    print(' ', p, '->', hits)
