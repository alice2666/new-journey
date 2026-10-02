# -*- coding: utf-8 -*-
"""v2.20 结构校验：表格列数 / 章节完整性 / 行尾 / 占位符 / 版本号"""
import re, sys

PATHS = [r'E:\new-journey\docs\01-需求文档.md', r'E:\new-journey\docs\02-开发计划.md']
fail = 0

for P in PATHS:
    raw = open(P, 'rb').read()
    s = raw.decode('utf-8')
    lines = s.split('\n')
    name = P.split('\\')[-1]
    print('=' * 78)
    print('【%s】 %d 行 / %d 字节' % (name, len(lines), len(raw)))
    print('  CRLF=%d  lone-LF=%d' % (raw.count(b'\r\n'), len(re.findall(rb'(?<!\r)\n', raw))))

    # 1. 占位符 / 哨兵残留
    bad = []
    for pat in [r'@@§', r'\x01', r'\x02P\d+\x02', r'@@', r'<omitted>', r'TODO']:
        if re.search(pat, s):
            bad.append(pat)
    print('  占位符残留: %s' % (bad if bad else '无'))
    if bad:
        fail += 1

    # 2. 表格列数一致性（⚠️ 必须排除转义竖线 \| —— 正文里的 `\|tx\|` 会被朴素计数误判成多列）
    def ncol(l):
        return len(re.findall(r'(?<!\\)\|', l))

    mis = []
    i = 0
    while i < len(lines):
        l = lines[i]
        if l.lstrip().startswith('|') and i + 1 < len(lines) and re.match(r'^\s*\|[\s:\-|]+\|\s*$', lines[i + 1]):
            hdr = ncol(l)
            j = i + 2
            while j < len(lines) and lines[j].lstrip().startswith('|'):
                if ncol(lines[j]) != hdr:
                    mis.append((j + 1, ncol(lines[j]), hdr, lines[j][:70]))
                j += 1
            i = j
        else:
            i += 1
    print('  表格列数不一致: %d 处' % len(mis))
    for ln, c, h, txt in mis[:10]:
        print('     L%-5d 列 %d（表头 %d）%s' % (ln, c, h, txt))
    if mis:
        fail += 1

    # 3. 版本号 / 头部
    if name.startswith('01'):
        for k in ['- 文档版本：**v2.20**', '- 上一版本：v2.19', 'Q44–Q56 全部拍板，无遗留项']:
            ok = k in s
            print('  头部 %-34s : %s' % (k[:34], 'OK' if ok else '**缺失**'))
            if not ok:
                fail += 1
        # 章节完整性
        for sec in range(1, 16):
            if not re.search(r'^## %d\. ' % sec, s, re.M):
                print('  **缺章** ## %d.' % sec)
                fail += 1
        subs = re.findall(r'^### (9\.\d+) ', s, re.M)
        print('  §9 小节: %s' % ' '.join(subs))
        need = ['9.%d' % n for n in range(1, 12)]
        miss = [x for x in need if x not in subs]
        if miss:
            print('  **缺 §9 小节**: %s' % miss)
            fail += 1
        # 版本摘要行
        for v in ['**v2.16**', '**v2.17**', '**v2.18**', '**v2.19**', '**v2.20**']:
            if ('| ' + v + ' |') not in s:
                print('  **缺摘要行** %s' % v)
                fail += 1

    # 4. 关键口径核对
    if name.startswith('01'):
        checks = [
            ('AUTO_HINT_MS = 2000', '自动 2 s 常量'),
            ('MANUAL_HINT_MS = 3000', '手动 3 s 常量'),
            ('无任何遗留未结项', '结项声明'),
        ]
        for k, d in checks:
            ok = k in s
            print('  口径 %-22s : %s' % (d, 'OK' if ok else '**缺失**'))
            if not ok:
                fail += 1

print('=' * 78)
print('校验结论：%s' % ('全部通过' if fail == 0 else '存在 %d 类问题' % fail))
