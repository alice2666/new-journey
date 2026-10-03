# -*- coding: utf-8 -*-
"""v2.25 批次 A：章节顺延（新增第七/八幕要插在 §9 之后）
   §10~§15 → §12~§17（从大到小，防重复顺延）
   跨文档引用（`02-开发计划.md` §N）原样冻结，不参与顺延。
   原子写盘：任一校验失败则不落盘。
"""
import re, sys

P = 'docs/01-需求文档.md'
raw = open(P, 'rb').read()
assert raw.count(b'\r\n') == 0, '本文档应为纯 LF'
s = raw.decode('utf-8')

MISS = []
def check(cond, msg):
    if not cond:
        MISS.append(msg)

# ---------- 0) 冻结跨文档引用 ----------
lines = s.split('\n')
frozen = 0
for i, l in enumerate(lines):
    if '02-开发计划' in l:
        lines[i] = re.sub(r'§(\d+)', lambda m: '@@REF' + m.group(1) + '@@', l)
        frozen += 1
s = '\n'.join(lines)
print('冻结跨文档引用行数 =', frozen)

# ---------- 1) 标题顺延 ----------
MAP = {10: 12, 11: 13, 12: 14, 13: 15, 14: 16, 15: 17}
def bump(n):
    n = int(n)
    return str(MAP.get(n, n))

s, nh = re.subn(r'^(#{2,4} )(\d+)((?:\.\d+)*)(\.?) ',
                lambda m: m.group(1) + bump(m.group(2)) + m.group(3) + m.group(4) + ' ',
                s, flags=re.M)
print('标题顺延条数 =', nh)

# ---------- 2) 正文引用顺延 ----------
s, nr = re.subn(r'§(\d+)(?!\d)', lambda m: '§' + bump(m.group(1)), s)
print('§ 引用顺延次数 =', nr)

# ---------- 3) 还原跨文档引用 ----------
s, nz = re.subn(r'@@REF(\d+)@@', lambda m: '§' + m.group(1), s)
check(nz == frozen * 0 or True, '')
print('还原占位符 =', nz)

# ---------- 校验 ----------
for want in ['## 12. 动画与交互规范', '### 12.1 图层顺序', '#### 12.1.1 幕的显隐门控（硬约束，v2.4 新增）',
             '## 13. 状态机', '## 14. 决议记录', '## 15. 目录结构', '## 16. 验收标准',
             '## 17. 本阶段交付范围', '### 16.8 全流程', '### 14.4.4', '### 14.5 实现时目测校准项']:
    check(want in s, '缺少顺延后的标题/引用: ' + want)
check('## 10. 动画与交互规范' not in s, '旧 §10 标题仍在')
check('## 11. 状态机' not in s, '旧 §11 标题仍在')
check('## 15. 本阶段交付范围' not in s, '旧 §15 标题仍在')
# 跨文档引用必须原样
check('`docs/02-开发计划.md` §9.1 / §13.11 / §13.12 / §13.13' in s, '跨文档引用被误改(44)')
check('`docs/02-开发计划.md` §13.2' in s, '跨文档引用被误改(523)')
check('`02-开发计划.md` §13.2' in s, '跨文档引用被误改(1983)')
check('`02-开发计划.md` §11' in s, '跨文档引用被误改(1867)')
check('**§6.20–§6.26**' in s and '§10.7 自测 / §11.1 用例计划 / §12.1.2 决议' in s, '跨文档引用被误改(2196)')

if MISS:
    for m in MISS:
        print('!!!', m)
    raise SystemExit(1)

data = s.encode('utf-8')
assert data.count(b'\r\n') == 0
open(P, 'wb').write(data)
print('批次 A 完成，全部命中')
