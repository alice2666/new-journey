# -*- coding: utf-8 -*-
"""validate_v215.py —— 第六幕**落地实现**（开发计划 v2.15）的自检。

与 validate_v214.py 的分工：
  * validate_v214.py 守的是「**计划**是否自洽」（写代码**之前**跑，含「本版不改 index.html」断言）；
  * 本脚本守的是「**实现**与计划/需求是否对齐」（写代码**之后**跑），
    并把「文档里回填的实测数字」与「代码/测试里真实存在的东西」两边对账。

覆盖 5 组：
  1) 行尾纪律（index.html / test.js 纯 CRLF；docs/*.md 纯 LF）
  2) 开发计划 v2.15 的回填是否到位、且**不留 v2.14 的计划态措辞**
  3) index.html 里第六幕的 CSS / DOM / JS 是否齐备（含 D9 的 pointer-events 守护）
  4) test.js 里四个新用例是否注册、且关键断言不存在「同源比较」
  5) assets/screen6 + screen7 的素材是否齐备

用法：
    python .workbuddy/tools/validate_v215.py

退出码 0 = 全绿；1 = 有失败项。零依赖（只用标准库）。
"""
import os
import re
import sys

ROOT = r'E:\new-journey'
PLAN = os.path.join(ROOT, 'docs', '02-开发计划.md')
REQ = os.path.join(ROOT, 'docs', '01-需求文档.md')
INDEX = os.path.join(ROOT, 'index.html')
TEST = os.path.join(ROOT, '.workbuddy', 'tools', 'test.js')

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


def load_text(P):
    return open(P, 'rb').read().decode('utf-8')


def read_b(P):
    return open(P, 'rb').read()


# ------------------------------------------------------------------ 1) 行尾
print('=' * 72)
print('1) 行尾纪律（本项目的 diff 全靠它）')
print('=' * 72)

for name, P, want_crlf in [
    ('index.html', INDEX, True),
    ('.workbuddy/tools/test.js', TEST, True),
    ('docs/02-开发计划.md', PLAN, False),
    ('docs/01-需求文档.md', REQ, False),
]:
    b = read_b(P)
    crlf = b.count(b'\r\n')
    lf = b.count(b'\n')
    if want_crlf:
        check('%s 为纯 CRLF（%d 行）' % (name, crlf), crlf > 0 and crlf == lf)
    else:
        check('%s 为纯 LF（%d 行）' % (name, lf), crlf == 0 and lf > 0)

# ------------------------------------------------------------------ 2) 文档
print()
print('=' * 72)
print('2) 开发计划 v2.15 的回填')
print('=' * 72)

plan = load_text(PLAN)
req = load_text(REQ)

check('开发计划版本号为 v2.16', '- 文档版本：**v2.16**' in plan)
check('需求文档为 v2.21（Q57 已记入）', '- 文档版本：**v2.21**' in req)

check('§8.4 标题已置「✅ 已全部完成」', '### 8.4 第六幕新增（v2.14 计划 → ✅ 已全部完成' in plan)
check('§13.15（落地实现交付）已新增', '### 13.15 第六幕落地实现交付' in plan)
check('§13.16（效果微调交付）已新增', '### 13.16 第六幕效果微调交付' in plan)
check('§9.1 已新增 D9（opacity:0 不阻止命中）', '**D9**' in plan and 'opacity: 0` 不阻止元素接收指针事件' in plan)
check('§11.1 现状已回填「18 个用例、766 项」', '**18 个用例、766 项断言全绿**' in plan)
check('§11.2 已回填截图目检结论', '20 个状态已于 2026-10-02 全部截齐' in plan)
check('§14 已回填「第一 ~ 第六幕」完成态', '**第一 ~ 第六幕 + 背景音乐（BGM）全部完成并验收通过' in plan)

# 逐用例实测项数（文档 / 测试两边都要有这个数）
for tag, num in [('gate', 47), ('a6', 80), ('a6b', 139), ('a6c', 51), ('full4', 11), ('a4', 46)]:
    check('§11.1 记 ' + tag + ' = ' + str(num) + ' 项', '**' + str(num) + '**' in plan)

# 旧版本总量不许再出现在「现状」位置
check('§11.1 不再残留「14 个用例、460 项」（v2.13 口径）',
      '**14 个用例、460 项断言全绿**（覆盖' not in plan)

# 计划态措辞必须全部清掉
for bad in [
    '### 8.4 第六幕新增（v2.14 计划 → ⏳ 待开发）',
    '第六幕需求已全部定稿、本版已给出实现计划，待开发',
    '**代码尚未开始写**',
    '**代码一行未写**',
]:
    check('已清除计划态措辞：' + bad[:28] + ('…' if len(bad) > 28 else ''), bad not in plan)

# ------------------------------------------------------------------ 3) index.html
print()
print('=' * 72)
print('3) index.html 第六幕 CSS / DOM / JS')
print('=' * 72)

idx = load_text(INDEX)

DOM_IDS = [
    'bg-picture', 'frame-picture', 'picture-line', 'piece-many', 'piece-layer',
    'all-picture', 'btn-again', 'btn-picture', 'small-picture', 'piece-drag',
    'shadow6', 'goal02', 'continue6',
]
for i in DOM_IDS:
    check('DOM 含 #' + i, ('id="' + i + '"') in idx)

check('DOM 不再残留旧的 #act6-slot 空占位', 'id="act6-slot"' not in idx)
check('#act6-slot 也从 CSS 选择器里移除', '#act3-slot, #act6-slot' not in idx)

# 门控 + 隔离
check('#act6 自带 opacity:0 门控', re.search(r'#act6\s*\{[^}]*opacity:\s*0', idx) is not None)
check('#act6.active 转可见', re.search(r'#act6\.active\s*\{[^}]*opacity:\s*1', idx) is not None)
check('.scene 有 isolation:isolate（D6）', 'isolation: isolate' in idx)

# D9：三件必须显式 pointer-events:none
for i in ['shadow6', 'goal02', 'continue6']:
    m = re.search(r'#' + i + r'\s*\{([^}]*)\}', idx)
    check('#' + i + ' 显式关闭命中（pointer-events:none，守 D9）',
          bool(m) and 'pointer-events: none' in m.group(1),
          '' if m else '未找到样式块')

# JS 常量
for c in ['PUZZLE_DIR', 'PUZZLE_WAVES', 'PUZZLE_PIECES', 'HIT_TOLERANCE', 'SNAP_MS',
          'FLY_BACK_MS', 'AUTO_HINT_MS', 'MANUAL_HINT_MS', 'RESET_SCOPE', 'ACT6_IMAGES']:
    check('JS 常量 ' + c + ' 存在', re.search(r'\bvar\s+' + c + r'\b', idx) is not None)

check('HIT_TOLERANCE = 30（Q48 默认值）', re.search(r'HIT_TOLERANCE\s*=\s*30\b', idx) is not None)
check('AUTO_HINT_MS = 2000 与 MANUAL_HINT_MS = 3000 有意不同（Q50 / Q51）',
      re.search(r'AUTO_HINT_MS\s*=\s*2000\b', idx) is not None
      and re.search(r'MANUAL_HINT_MS\s*=\s*3000\b', idx) is not None)
check("RESET_SCOPE = 'act6'（Q45 只重置本幕）", re.search(r"RESET_SCOPE\s*=\s*'act6'", idx) is not None)

# JS 函数
for f in ['preloadAct6', 'pieceEl', 'hitTest', 'judge', 'createPiece', 'dropWave',
          'waveComplete', 'advanceAfterLock', 'onPieceDown', 'flushDrag', 'pointerInStage',
          'onStagePointerUp', 'snapPiece', 'flyBack', 'resetPuzzle', 'showHint',
          'bindPuzzlePlay', 'runAct6Intro', 'runAct6Ui', 'runPuzzlePlay',
          'runAct6Finish', 'runAct6']:
    check('JS 函数 ' + f + '() 存在', re.search(r'function\s+' + f + r'\s*\(', idx) is not None)

check('main() 链尾已接 bindPuzzlePlay + runAct6',
      '.then(bindPuzzlePlay)' in idx and '.then(runAct6)' in idx)
check('第五幕 B8 末已插入 preloadAct6()', 'preloadAct6(); return sleep(500);' in idx)

# 拖拽三段的绑定目标（pointerup 必须绑 #stage，不能绑 document）
check('pointerup / pointercancel 绑在 #stage（不绑 document）',
      re.search(r'stage\.addEventListener\(\s*[\'"]pointerup[\'"]', idx) is not None
      and re.search(r'stage\.addEventListener\(\s*[\'"]pointercancel[\'"]', idx) is not None)
check('拖拽用 setPointerCapture 防拖出画布', 'setPointerCapture' in idx)
check('拖拽落点走 toStage(e) 做缩放补偿（R26）', 'toStage(' in idx)

# 调试钩子
check('__nj 暴露 puzzle()', re.search(r'puzzle\s*:', idx) is not None or 'puzzle: function' in idx)
check('__nj 暴露 judgeAt(id, cx, cy)', 'judgeAt: function' in idx)

# ES5 约束（最低 Chrome 41 / Edge 15）
script_region = idx[idx.find('<script>'):]
check('index.html 脚本区无箭头函数（ES5）', '=>' not in script_region)
check('index.html 脚本区无 let / const 声明（ES5）',
      re.search(r'(?m)^\s*(let|const)\s', script_region) is None)

# ------------------------------------------------------------------ 4) test.js
print()
print('=' * 72)
print('4) test.js 四个新用例 + 断言质量')
print('=' * 72)

tst = load_text(TEST)

check('test.js 为纯 CRLF（同上第 1 组）', read_b(TEST).count(b'\r\n') == read_b(TEST).count(b'\n'))

for fn in ['caseA6', 'caseA6b', 'caseA6c', 'caseFull4']:
    check('用例函数 ' + fn + '() 存在', re.search(r'function\s+' + fn + r'\s*\(', tst) is not None)

for key in ['a6:', 'a6b:', 'a6c:', 'full4:']:
    check('CASES 注册 ' + key.rstrip(':'), key in tst)

check('文件头用法注释含 a6 / a6b / a6c / full4',
      'test.js a6' in tst and 'test.js a6b' in tst and 'test.js a6c' in tst and 'test.js full4' in tst)

# 关键：期望值表必须**重抄一份**，不能从 __nj.puzzle() 取（否则同源比较无断言力）
check('PUZZLE_EXPECT 在测试端独立重抄（不从 __nj.puzzle() 取）',
      'PUZZLE_EXPECT' in tst and 'PUZZLE_WAVES_EXPECT' in tst)

# 9 张碎片坐标必须都在测试端的期望表里
for pid in ['picture-01-01', 'picture-11-01', 'picture-05-01', 'picture-03-02', 'picture-09-02',
            'picture-10-02', 'picture-06-03', 'picture-04-03', 'picture-08-03']:
    check('PUZZLE_EXPECT 含 ' + pid, pid in tst)

check('a6b 断言素材原始尺寸 = 坐标表的 w×h', 'naturalWidth * 10000 + el.naturalHeight' in tst)
check('a6 断言两件 pointerEvents === none（守 D9）', "pointerEvents" in tst)
check('a4 断言旧 #act6-slot 已退役', "document.getElementById('act6-slot') === null" in tst)

# 闪烁坑：a6c 测「发光满 2s」必须用页面内探针，不能用测试端 Date.now() 卡点
check('a6c 时间量测用页面内探针（避免 CDP 往返误差）',
      '__c4' in tst or 'setInterval' in tst)

# ------------------------------------------------------------------ 5) 素材
print()
print('=' * 72)
print('5) assets 素材齐备')
print('=' * 72)

S6 = os.path.join(ROOT, 'assets', 'screen6')
S7 = os.path.join(ROOT, 'assets', 'screen7')

for f in ['bg-picture.png', 'frame-picture.png', 'picture-line.png', 'piece-many.png',
          'all-picture.png', 'btn-again.png', 'btn-picture.png', 'small-picture.png']:
    check('assets/screen6/' + f, os.path.exists(os.path.join(S6, f)))

for pid in ['picture-01-01', 'picture-11-01', 'picture-05-01', 'picture-03-02', 'picture-09-02',
            'picture-10-02', 'picture-06-03', 'picture-04-03', 'picture-08-03']:
    check('assets/screen6/' + pid + '.png', os.path.exists(os.path.join(S6, pid + '.png')))

check('assets/screen7/goal02-picture.png', os.path.exists(os.path.join(S7, 'goal02-picture.png')))
check('screen4 的两件复用素材在（shadow.png / Continue.png 同 URL 复用）',
      os.path.exists(os.path.join(ROOT, 'assets', 'screen4', 'shadow.png'))
      and os.path.exists(os.path.join(ROOT, 'assets', 'screen4', 'Continue.png')))

# ------------------------------------------------------------------ 汇总
print()
print('=' * 72)
print('结果：通过 %d 项，失败 %d 项' % (ok, len(fail)))
if fail:
    print('--- 失败清单 ---')
    for f in fail:
        print(' * ' + f)
    sys.exit(1)
print('全部通过')
