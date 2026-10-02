# -*- coding: utf-8 -*-
"""validate_v214.py —— 第六幕实现计划（开发计划 v2.14）结构与数据自检。

用途：在**动手写 index.html 之前**，把「文档本身是否自洽」与「关键数值是否被
抄错」一次性验掉。第六幕有 9 张碎片 × 2 组坐标 + 24 个新坐标，靠肉眼看极易漏。

用法：
    python .workbuddy/tools/validate_v214.py

退出码 0 = 全绿；1 = 有失败项。
零依赖（只用标准库），与本项目「零依赖」约束一致。

⚠️ **本脚本守的是 v2.14 的「计划态」**（写代码之前）。第六幕已于 **v2.15** 落地实现，
此后本脚本最后两组会**必然失败**（「版本号为 v2.14」「本版不改 index.html」），
这是**预期内**的 —— 实现完成后请改跑 **`validate_v215.py`**（它守「实现与计划/需求是否对齐」）。
保留本脚本是为了守住 v2.14 当时的计划结构与 18 个坐标不被回改错。
"""
import re
import sys

PLAN = r'E:\new-journey\docs\02-开发计划.md'
REQ = r'E:\new-journey\docs\01-需求文档.md'

ok = 0
fail = []


def check(name, cond, detail=''):
    global ok
    if cond:
        ok += 1
        print('  \u2713 %s' % name)
    else:
        fail.append(name + (('  -> ' + detail) if detail else ''))
        print('  \u2717 %s  %s' % (name, detail))


def load(P):
    raw = open(P, 'rb').read()
    return raw, raw.decode('utf-8')


def headings(s):
    out = set()
    for l in s.split('\n'):
        m = re.match(r'^#{2,4}\s+(\d+(?:\.\d+)*)[\.\s]', l)
        if m:
            out.add(m.group(1))
    return out


def table_blocks(lines):
    """产出 (起始行号, [行])，跳过代码块。"""
    in_code = False
    tbl = []
    for i, l in enumerate(lines, 1):
        if l.strip().startswith('```'):
            in_code = not in_code
            continue
        if in_code:
            continue
        if l.strip().startswith('|') and l.strip().endswith('|'):
            if not tbl:
                start = i
            tbl.append(l)
        else:
            if tbl:
                yield start, tbl
            tbl = []
    if tbl:
        yield start, tbl


def section(s, start_kw, end_kw):
    """取 [start_kw, end_kw) 之间的正文。"""
    i = s.find(start_kw)
    if i < 0:
        return ''
    j = s.find(end_kw, i + len(start_kw))
    return s[i:j if j > 0 else len(s)]


def main():
    plan_raw, plan = load(PLAN)
    req_raw, req = load(REQ)

    print('=' * 72)
    print('1) 文件基本形态')
    print('=' * 72)
    check('开发计划为纯 LF 行尾', plan_raw.count(b'\r\n') == 0,
          'CRLF=%d' % plan_raw.count(b'\r\n'))
    check('需求文档为纯 LF 行尾', req_raw.count(b'\r\n') == 0,
          'CRLF=%d' % req_raw.count(b'\r\n'))
    check('开发计划版本号为 v2.14', '- \u6587\u6863\u7248\u672c\uff1a**v2.14**' in plan)

    ph, rh = headings(plan), headings(req)
    for tag, s in (('开发计划', plan), ('需求文档', req)):
        import collections
        hs = [l for l in s.split('\n') if re.match(r'^#{2,4} ', l)]
        dup = [h for h, c in collections.Counter(hs).items() if c > 1]
        check('%s 无重复标题' % tag, not dup, str(dup))
        n = sum(1 for l in s.split('\n') if l.strip().startswith('```'))
        check('%s 代码块闭合（栅栏偶数）' % tag, n % 2 == 0, 'fence=%d' % n)

    print()
    print('=' * 72)
    print('2) 表格列数一致（转义竖线 | 不计）')
    print('=' * 72)
    for tag, s in (('开发计划', plan), ('需求文档', req)):
        bad = []
        for st, blk in table_blocks(s.split('\n')):
            if len(blk) < 2:
                continue
            cols = {len(re.findall(r'(?<!\\)\|', l)) for l in blk}
            if len(cols) != 1:
                bad.append((st, sorted(cols)))
        check('%s 表格列数全部一致' % tag, not bad, str(bad[:3]))

    print()
    print('=' * 72)
    print('3) 交叉引用可解析（§x.y 要么在开发计划、要么在需求文档）')
    print('=' * 72)
    NEW_SECTIONS = [
        ('### 6.20 ', '\n## 7. '),        # §6.20–§6.26
        ('### 5.5 ', '\n## 6. '),         # §5.5 坐标总表
        ('### 8.4 ', '\n## 9. '),         # §8.4 里程碑
        ('### 9.3 ', '\n## 10. '),        # §9.3 风险
        ('### 10.7 ', '\n## 11. '),       # §10.7 自测
        ('### 12.1.2 ', '\n### 12.2 '),   # §12.1.2 决议
        ('### 13.14 ', '\n## 14. '),      # §13.14 交付记录
    ]
    body = ''.join(section(plan, a, b) for a, b in NEW_SECTIONS)
    refs = set(re.findall(r'§\s?(\d+(?:\.\d+){0,3})', body))
    unresolved = []
    for r in refs:
        if r in ph or r in rh:
            continue
        if '.'.join(r.split('.')[:2]) in ph or '.'.join(r.split('.')[:2]) in rh:
            continue
        unresolved.append(r)
    check('第六幕新增正文里的 § 引用全部可解析', not unresolved,
          '未解析: ' + ', '.join(sorted(unresolved)))
    check('第六幕新增正文引用了足够多章节（参考 60+）', len(refs) >= 40,
          'refs=%d' % len(refs))

    print()
    print('=' * 72)
    print('4) 第六幕坐标数据（§5.5 B / C 表）')
    print('=' * 72)

    # --- B 表：9 张碎片的目标坐标 + 目标中心，逐张核对 ---
    B_EXPECT = {
        '01-01': (178, 127, 298.5, 191.0),
        '11-01': (334, 485, 479.5, 564.0),
        '05-01': (438, 255, 566.0, 322.0),
        '03-02': (577, 126, 697.5, 191.5),
        '09-02': (626, 311, 722.0, 414.5),
        '10-02': (178, 506, 283.0, 575.5),
        '06-03': (581, 159, 700.0, 259.5),
        '04-03': (178, 184, 281.0, 304.0),
        '08-03': (334, 318, 487.0, 424.5),
    }
    SIZE = {'01-01': (241, 128), '11-01': (291, 158), '05-01': (256, 134),
            '03-02': (241, 131), '09-02': (192, 207), '10-02': (210, 139),
            '06-03': (238, 201), '04-03': (206, 240), '08-03': (306, 213)}

    secB = section(plan, '**B. 9 张碎片的目标位置', '**C. 3 张碎片')
    rows = [l for l in secB.split('\n')
            if re.match(r'^\|\s*`picture-\d\d-\d\d`', l)]
    check('B 表恰好 9 行', len(rows) == 9, 'rows=%d' % len(rows))

    b_bad = []
    for l in rows:
        m = re.match(r'^\|\s*`picture-(\d\d-\d\d)`\uff08(\d)\uff09\s*\|\s*(\d+)\u00d7(\d+)\s*'
                     r'\|\s*\*\*(\d+(?:\.\d+)?) / (\d+(?:\.\d+)?)\*\*\s*'
                     r'\|\s*\((\d+(?:\.\d+)?), (\d+(?:\.\d+)?)\)', l)
        if not m:
            b_bad.append('解析失败: ' + l[:60])
            continue
        k, wave, w, h, L, T, cx, cy = m.groups()
        ew, eh = SIZE[k]
        eL, eT, ecx, ecy = B_EXPECT[k]
        if (int(w), int(h)) != (ew, eh):
            b_bad.append('%s 尺寸 %sx%s != %dx%d' % (k, w, h, ew, eh))
        if (float(L), float(T)) != (float(eL), float(eT)):
            b_bad.append('%s 坐标 %s/%s != %s/%s' % (k, L, T, eL, eT))
        # 目标中心必须等于 left+w/2, top+h/2
        if abs(float(cx) - (float(L) + ew / 2.0)) > 1e-6 or \
           abs(float(cy) - (float(T) + eh / 2.0)) > 1e-6:
            b_bad.append('%s 目标中心 %s,%s != (%s,%s)' % (k, cx, cy, ecx, ecy))
        if abs(float(cx) - ecx) > 1e-6 or abs(float(cy) - ecy) > 1e-6:
            b_bad.append('%s 目标中心与预期不一致' % k)
    check('B 表 9 张尺寸 / 目标坐标 / 目标中心逐张一致', not b_bad, str(b_bad))

    # 「最近两目标中心 68.0 px」——用表内数据反算，防止抄错
    pts = [(v[2], v[3]) for v in B_EXPECT.values()]
    best = min(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
               for i, a in enumerate(pts) for b in pts[i + 1:])
    check('9 个目标中心两两最近 ≈ 68.0 px（容差 30 px 不足其半）',
          abs(best - 68.0) < 0.2, '实测 %.2f' % best)
    check('§5.5 正文标注了「两两最近 68.0 px」',
          '两两最近 68.0 px' in secB or '68.0 px' in plan)

    # --- C 表：3 张碎片底板初始位置，逐张核对（= 1022 − w/2 ；= 格中心 − h/2）---
    C_EXPECT = {
        '01-01': (901.5, 85.3), '11-01': (876.5, 369.0), '05-01': (894.0, 679.7),
        '03-02': (901.5, 83.8), '09-02': (926.0, 344.5), '10-02': (917.0, 677.2),
        '06-03': (903.0, 48.8), '04-03': (919.0, 328.0), '08-03': (869.0, 640.2),
    }
    secC = section(plan, '**C. 3 张碎片', '\n---\n\n## 6. ')
    crows = [l for l in secC.split('\n')
             if re.match(r'^\|\s*\u7b2c\s*\d\s*\u6ce2\s*\|', l)]
    check('C 表恰好 9 行', len(crows) == 9, 'rows=%d' % len(crows))
    c_bad = []
    for l in crows:
        m = re.match(r'^\|\s*\u7b2c\s*\d\s*\u6ce2\s*\|\s*`(\d\d-\d\d)`\s*\|\s*(\d+)\u00d7(\d+)\s*'
                     r'\|\s*\*\*(\d+(?:\.\d+)?) / (\d+(?:\.\d+)?)\*\*\s*\|', l)
        if not m:
            c_bad.append('解析失败: ' + l[:60])
            continue
        k, w, h, L, T = m.groups()
        eL, eT = C_EXPECT[k]
        if (float(L), float(T)) != (float(eL), float(eT)):
            c_bad.append('%s %s/%s != %s/%s' % (k, L, T, eL, eT))
        # 水平居中于底板 x=1022
        if abs(float(L) + int(w) / 2.0 - 1022) > 1e-6:
            c_bad.append('%s 未水平居中于 1022' % k)
    check('C 表 9 张初始坐标逐张一致、且均水平居中于底板 x=1022', not c_bad, str(c_bad))

    # 最宽碎片 306 ≤ 可用宽 316；距左右缘最少 25 px
    widest = max(SIZE[k][0] for k in SIZE)
    check('最宽碎片 306 ≤ 可用宽 316', widest == 306)
    check('§5.5 正文标注「原尺寸摆放、无需缩放」', '原尺寸摆放' in secC or '原尺寸' in secC)

    print()
    print('=' * 72)
    print('5) 关键常量 / 函数 / 用例 / 风险 / 里程碑')
    print('=' * 72)
    sec620 = section(plan, '### 6.20 ', '\n### 6.21 ')
    sec622 = section(plan, '### 6.22 ', '\n### 6.23 ')
    sec623 = section(plan, '### 6.23 ', '\n### 6.24 ')
    sec626 = section(plan, '### 6.26 ', '\n---\n\n## 7. ')
    sec984 = section(plan, '### 9.3 ', '\n---\n\n## 10. ')
    sec84 = section(plan, '### 8.4 ', '\n---\n\n## 9. ')
    sec1212 = section(plan, '### 12.1.2 ', '\n### 12.2 ')
    sec7 = section(plan, '## 7. ', '\n## 8. ')

    for fn in ['runAct6', 'runAct6Intro', 'runAct6Ui', 'runPuzzlePlay', 'runAct6Finish']:
        check('§6.20 声明分幕函数 %s' % fn, fn in sec620)

    check('§6.22 自动参考图常量 AUTO_HINT_MS = 2000（Q50）',
          'AUTO_HINT_MS   = 2000' in sec622 or 'AUTO_HINT_MS = 2000' in sec622)
    check('§6.22 手动参考图常量 MANUAL_HINT_MS = 3000（Q51）',
          'MANUAL_HINT_MS = 3000' in sec622)
    check('§6.22 明确「不要顺手统一」两个时长',
          '顺手统一' in sec622)

    check('§6.23 命中容差 HIT_TOLERANCE = 30', 'HIT_TOLERANCE = 30' in sec623)
    check('§6.23 明确「必须走 toStage」（缩放补偿）', 'toStage(e)' in sec623)
    check('§6.23 明确「绝不旋转」', '绝不旋转' in sec623)
    check('§6.23 记录 RESET_SCOPE = \'act6\'（Q45 重置本幕）',
          "RESET_SCOPE = 'act6'" in sec623)
    check('§6.23 记录 lockedIds / dragging / hintTimer 三个新锁',
          all(k in sec623 or k in sec626 for k in ['lockedIds', 'dragging', 'hintTimer']))
    check('三波组成与需求一致',
          all(k in sec623 for k in ['picture-01-01', 'picture-11-01', 'picture-05-01',
                                    'picture-03-02', 'picture-09-02', 'picture-10-02',
                                    'picture-06-03', 'picture-04-03', 'picture-08-03']))

    check('§6.26 预加载体积 ≈ 3.1 MB', '3.1 MB' in sec626)
    check('§6.26 声明 preloadAct6()', 'preloadAct6()' in sec626)
    check('§6.26 明确不重复预取 screen4 两件',
          'shadow.png' in sec626 and 'Continue.png' in sec626)
    check('§6.26 起播点定在第五幕 B8 的 500 ms 停留',
          'B8' in sec626 and '500 ms' in sec626)

    check('§6.25 记录了「同帧撤场」与三件',
          all(k in section(plan, '### 6.25 ', '\n### 6.26 ')
              for k in ['goal02', 'shadow6', 'btnContinue6']))
    check('§6.25 明确「不写 ui-out」（Q55）',
          'ui-out' in section(plan, '### 6.25 ', '\n### 6.26 '))

    for r in ['R24', 'R25', 'R26', 'R27', 'R28', 'R29']:
        check('§9.3 登记风险 %s' % r, r in sec984)
    for m in ['M17', 'M18', 'M19', 'M20']:
        check('§8.4 登记里程碑 %s' % m, m in sec84)

    for case in ['`a6`', '`a6b`', '`a6c`', '`full4`']:
        check('§11.1 规划用例 %s' % case, case in section(plan, '### 11.1 ', '\n### 11.2 '))

    for q in ['Q44', 'Q45', 'Q46', 'Q47', 'Q48', 'Q49', 'Q50',
              'Q51', 'Q52', 'Q53', 'Q54', 'Q55', 'Q56']:
        check('§12.1.2 记录决议 %s' % q, ('**%s**' % q) in sec1212)

    check('§7 时间轴含步骤 50–65', all(('| %d |' % i) in sec7 for i in (50, 65)))
    check('§7 净时长表含第六幕 ≈ 11.9s', '11.9s' in sec7)

    print()
    print('=' * 72)
    print('6) index.html / assets 未被本版改动（「先不要开发」）')
    print('=' * 72)
    import os
    check('开发计划声明本版不改 index.html',
          '本版仍不改动 `index.html`' in plan or '本版仍不改动' in plan)
    # 仅作文档自检提示：由 git 判断是否真有改动（此处只报文件是否存在）
    check('index.html 存在且可读', os.path.isfile(r'E:\new-journey\index.html'))

    print()
    print('=' * 72)
    print('结果：通过 %d 项，失败 %d 项' % (ok, len(fail)))
    if fail:
        print('--- 失败清单 ---')
        for f in fail:
            print(' * ' + f)
        print('=' * 72)
        return 1
    print('全绿 ✅')
    print('=' * 72)
    return 0


if __name__ == '__main__':
    sys.exit(main())
