# -*- coding: utf-8 -*-
"""v2.19 文档结构校验：表格列数 / 占位符 / 小节齐全 / 章齐全 / 行尾"""
import re
P = r'E:\new-journey\docs\01-需求文档.md'
raw = open(P, 'rb').read()
s = raw.decode('utf-8')
lines = s.split('\n')

print('行数 %d | 字节 %d | CRLF %d | 纯 LF（应为 %d）'
      % (len(lines), len(raw), raw.count(b'\r\n'), raw.count(b'\n')))

# 1. 残留占位符
print('\n[1] 占位符检查')
bad = 0
for pat in ['@@', '\x01', '\x02', 'TODO', 'XXX', '待填', '<omitted>']:
    c = s.count(pat)
    if c:
        print('  ⚠️ %r : %d 处' % (pat, c)); bad += 1
print('  → %s' % ('干净' if bad == 0 else '有残留'))

# 2. 表格列数一致性（逐表比较分隔行与数据行的竖线数）
print('\n[2] 表格列数一致性')
errs = []
i = 0
while i < len(lines):
    l = lines[i].strip()
    if l.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+\|$', lines[i+1].strip()):
        hdr = l.count('|')
        j = i + 1
        rows = []
        while j < len(lines) and lines[j].strip().startswith('|'):
            rows.append((j + 1, lines[j]))
            j += 1
        for ln, r in rows:
            if r.count('|') != hdr:
                errs.append((ln, hdr, r.count('|'), r[:110]))
        i = j
    else:
        i += 1
if errs:
    for ln, a, b, t in errs:
        print('  ⚠️ L%-5d 期望 %d 竖线、实为 %d：%s' % (ln, a, b, t))
else:
    print('  → 全部一致')

# 3. §9 小节齐全
print('\n[3] §9 小节')
want9 = ['### 9.1', '### 9.2', '### 9.3', '### 9.4', '### 9.5', '### 9.6',
         '### 9.7', '### 9.8', '### 9.9', '### 9.10', '### 9.11',
         '#### 9.5.1', '#### 9.5.2', '#### 9.5.3', '#### 9.5.4', '#### 9.5.5', '#### 9.5.6']
for w in want9:
    ok = any(l.startswith(w) for l in lines)
    print('  %s %s' % ('✅' if ok else '❌', w))

# 4. 章齐全 §1~§15
print('\n[4] 章齐全')
for k in range(1, 16):
    ok = any(l.startswith('## %d. ' % k) for l in lines)
    print('  %s §%d' % ('✅' if ok else '❌', k))

# 5. 版本号与关键结论落点
print('\n[5] 关键结论落点计数')
for k in ['v2.19', 'Q52', 'Q53', 'Q54', 'Q55', 'Q56',
          '幕内一切保留', '不主动熄灭', '转黑幕', '沿用第四幕', '六条硬约束']:
    print('  %-14s %d 处' % (k, s.count(k)))
