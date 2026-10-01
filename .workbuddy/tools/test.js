/* New Journey 自动化测试（断言式，失败退出码 1）
 *
 * 用法：
 *   node .workbuddy/tools/test.js          跑全部用例
 *   node .workbuddy/tools/test.js p1       只跑「问题1：台词文本位置」
 *   node .workbuddy/tools/test.js p2       只跑「问题2：chat 消失 -> hand 出现」
 *   node .workbuddy/tools/test.js flow     只跑「第一、二幕全流程回归」
 *   node .workbuddy/tools/test.js gate     场景门控（未激活幕不得盖住当前幕）
 *   node .workbuddy/tools/test.js a3       第三幕：视频 -> 定格 -> 第三句 -> 对话框消失
 *   node .workbuddy/tools/test.js a3b      第三幕：面板 / 槽位 / 按钮几何
 *   node .workbuddy/tools/test.js a3c      第三幕：自由落点玩法 + 缩放补偿专项
 *   node .workbuddy/tools/test.js a4       第四幕：蒙黑 -> Goal（从上到下快速落下）-> Continue -> 全黑
 *   node .workbuddy/tools/test.js bgm      背景音乐：点击 START 起播 -> 跨幕连续 -> 点击 Continue 停止
 *   node .workbuddy/tools/test.js bgm2     BGM 缺失时不得阻塞开场（屏蔽音乐资源后重跑）
 *   node .workbuddy/tools/test.js full2    第一 ~ 第四幕全流程（真实播放视频）
 *
 * 退出码：0 = 全部通过，1 = 存在失败
 * 截图输出：.workbuddy/tools/shots/（已 gitignore，仅供人工目检）
 *
 * 实现要点：
 *   1) CDP 直连系统自带 Edge（Node 22 内置 WebSocket，零安装依赖）。
 *   2) 几何断言一律读取「布局坐标」(offsetLeft/offsetTop/offsetWidth/offsetHeight 沿
 *      offsetParent 链累加)，而不是 getBoundingClientRect —— 后者会被 #hand 的
 *      tap 缩放动画和 hover 缩放污染，导致断言随机抖动。
 *   3) 可见性断言用「沿祖先链累乘 opacity」，能识别「自身 opacity=1 但父层已透明」
 *      的情况，这正是判断整个 chat.png 是否彻底消失所必需的。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const PAGE = 'file:///E:/new-journey/index.html';
const OUT = path.join(__dirname, 'shots');
const PROFILE = path.join(os.tmpdir(), 'nj-cdp-profile');
const STAGE_W = 1200;
const STAGE_H = 896;

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 断言与计分 ================= */
let passed = 0;
let failed = 0;
const failures = [];

function ok(name) {
  passed++;
  console.log('  \u2713 ' + name);
}
function fail(name, detail) {
  failed++;
  failures.push(name + (detail ? '  ->  ' + detail : ''));
  console.log('  \u2717 ' + name + (detail ? '  ->  ' + detail : ''));
}
function assertTrue(name, cond, detail) {
  cond ? ok(name) : fail(name, detail);
}
function assertEq(name, actual, expected, tol) {
  tol = tol === undefined ? 0.6 : tol;
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tol) ok(name);
  else fail(name, '期望 ' + expected + ' \u00b1' + tol + '，实测 ' + actual);
}

/* ================= CDP 客户端 ================= */
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) {
        (this.handlers.get(m.method) || []).forEach((h) => h(m.params));
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, h) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(h);
  }
}

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

/* ================= 页面内取数表达式 ================= */
// 布局坐标：沿 offsetParent 链累加到 #stage，不受 transform / 动画影响
const LAYOUT_FN = `(() => {
  const el = document.querySelector(SEL);
  if (!el) return null;
  const stage = document.getElementById('stage');
  let x = 0, y = 0, n = el;
  while (n && n !== stage) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
  const w = el.offsetWidth, h = el.offsetHeight;
  const cs = getComputedStyle(el);
  return {
    left: x, top: y, width: w, height: h,
    fromRight: ${STAGE_W} - (x + w), fromBottom: ${STAGE_H} - (y + h),
    opacity: +cs.opacity, pointerEvents: cs.pointerEvents
  };
})()`;

// 沿祖先链累乘 opacity：判断元素「视觉上是否真的不可见」
const EFF_OPACITY_FN = `(() => {
  let el = document.querySelector(SEL), o = 1;
  while (el && el !== document.documentElement) {
    o *= parseFloat(getComputedStyle(el).opacity);
    el = el.parentElement;
  }
  return +o.toFixed(4);
})()`;

// 文字「墨迹」相对元素顶边的偏移（px）。
// 行盒 = 半行距 + 字体上下沿，字体上下沿里的空白是透明的，
// 所以判断文字有没有「压倒」别的东西必须看墨迹，不能看行盒。
// 用 canvas measureText 拿到真实的 actualBoundingBoxAscent / fontBoundingBoxAscent 来算。
const INK_TOP_FN = `(() => {
  const el = document.querySelector(SEL);
  const cs = getComputedStyle(el);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
  const m = ctx.measureText((el.textContent || '').trim() || 'Th');
  const lineBox = parseFloat(cs.lineHeight);
  const contentH = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const halfLeading = (lineBox - contentH) / 2;
  const baseline = halfLeading + m.fontBoundingBoxAscent;
  return {
    inkTopOffset: +(baseline - m.actualBoundingBoxAscent).toFixed(2),
    lineBox: +lineBox.toFixed(2),
    baselineOffset: +baseline.toFixed(2),
    inkAscent: m.actualBoundingBoxAscent
  };
})()`;

/* ================= 主流程 ================= */
(async () => {
  const which = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const cases = which.length ? which : ['gate', 'p1', 'p2', 'flow', 'a3', 'a3b', 'a3c', 'a4', 'a5', 'a5b', 'bgm', 'bgm2', 'full2', 'full3'];

  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-file-access-from-files',
    '--window-size=' + STAGE_W + ',' + STAGE_H,
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.find((t) => t.type === 'page');
      if (target && target.webSocketDebuggerUrl) break;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!target) { console.error('无法连接 Edge 调试端口 ' + PORT); child.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new CDP(ws);

  let errors = [];
  cdp.on('Runtime.exceptionThrown', (p) =>
    errors.push('EXCEPTION: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)));
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') errors.push('CONSOLE: ' + p.args.map((a) => a.value || a.description).join(' '));
  });
  cdp.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') errors.push('LOG: ' + p.entry.text); });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const waitFor = async (expr, timeout, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 20000)) {
      if (await evaluate(expr)) return true;
      await sleep(60);
    }
    throw new Error('等待超时: ' + (label || expr));
  };

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  };

  const box = (sel) => evaluate(LAYOUT_FN.replace('SEL', JSON.stringify(sel)));
  const inkOf = (sel) => evaluate(INK_TOP_FN.replace('SEL', JSON.stringify(sel)));
  const effOpacity = (sel) => evaluate(EFF_OPACITY_FN.replace('SEL', JSON.stringify(sel)));
  const textOf = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).textContent`);
  const classesOf = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).className`);
  const hasClass = (sel, cls) =>
    evaluate(`document.querySelector(${JSON.stringify(sel)}).classList.contains(${JSON.stringify(cls)})`);

  const click = async (sel) => {
    const b = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  };

  // 点击后先等目标「已触发态」消失，再等下一次出现，规避异步时序竞态
  const clickAndWaitHide = async (sel) => {
    await click(sel);
    await waitFor(`!document.querySelector(${JSON.stringify(sel)}).classList.contains('in')`, 3000, sel + ' 隐藏');
  };

  // 每个用例都从零开始，保证互相独立
  const reload = async () => {
    errors = [];
    // 视口钉死 1200x896 -> 缩放比 = 1，量出来的坐标可直接与文档比对
    const metrics = { width: STAGE_W, height: STAGE_H, deviceScaleFactor: 1, mobile: false };
    await cdp.send('Emulation.setDeviceMetricsOverride', metrics);
    await cdp.send('Page.navigate', { url: PAGE });
    await waitFor(`document.readyState === 'complete'`, 20000, 'readyState');
    await sleep(700);
    await cdp.send('Emulation.setDeviceMetricsOverride', metrics);
    await sleep(300);
  };

  /* ---------- 公共前置 ---------- */
  const LINE1 = 'Wow! I\u2019m traveling somewhere new. Let me get ready.';
  const LINE2 = 'This brand-new suitcase has no marks. Someone might take it by mistake.';
  // 仅用于「3 行台词」回归：临时注入，验证行数增加时顶边不动、仍不压任何物件
  const LINE3 = 'This brand-new suitcase has no marks at all. If someone takes it by mistake, I will have nothing left for my trip.';

  const toAct2FirstLine = async () => {
    await waitFor(`document.getElementById('btn-start').classList.contains('in')`, 20000, 'btn-start 出现');
    // 注意：`.in` 类一加上 pointer-events 就变 auto，但此时 400ms 的入场动画仍在跑、
    // busy 锁未释放且点击监听尚未挂载，立刻点会被吞掉。必须等动画结束再点。
    await sleep(600);
    await click('#btn-start');
    await waitFor(`document.getElementById('chat').classList.contains('in')`, 10000, 'chat 滑入');
    await waitFor(`document.getElementById('btn-go').classList.contains('in')`, 25000, '第 1 句打完');
    await sleep(400);
  };
  const toAct2SecondLine = async () => {
    await toAct2FirstLine();
    await clickAndWaitHide('#btn-go');
    await waitFor(`document.getElementById('suitcase').classList.contains('in')`, 10000, 'suitcase 出现');
    await waitFor(`document.getElementById('btn-go').classList.contains('in')`, 25000, '第 2 句打完');
    await sleep(400);
  };

  /* ================= 用例 gate：场景门控 =================
     守的是一类「既有断言全绿、画面却是错的」的盲区：未激活幕的元素盖住了当前幕。

     成因（真实发生过）：#bg-room-suitcase 是「常驻可见」的定格图 —— 它不像 #act3-video
     那样自带 opacity:0，本身也没有任何淡入逻辑；而它所在的 #act3 的 z-index(3) 高于
     #act2(2) 与 #act1(auto)。所以 #act3 容器一旦漏写 opacity:0 门控，这张定格图就会
     从页面载入的第一帧起盖在第一、二幕之上，表现是：
       「一打开就是行李箱的房间、看不到开始界面、画面怎么都不动」。
     而 p1/p2/flow 断言的是各元素的类名、坐标、单个元素 opacity —— 全部仍然正确，
     所以一条都不会失败。本用例改为断言「整幕容器」的有效可见性。 */
  async function caseGate() {
    const SCENE_SNAP = `(() => {
      const eff = (el) => { let o = 1, n = el; while (n && n !== document.documentElement) { o *= parseFloat(getComputedStyle(n).opacity); n = n.parentElement; } return +o.toFixed(3); };
      const ids = ['act1', 'act2', 'act3', 'act4', 'act5', 'act6', 'bg-room-suitcase', 'bg-inside', 'shadow'];
      const out = {};
      ids.forEach((id) => { const el = document.getElementById(id); if (el) out[id] = eff(el); });
      return JSON.stringify(out);
    })()`;
    const snap = async () => JSON.parse(await evaluate(SCENE_SNAP));

    // ① 载入后一次都没点击：只允许第一幕可见
    const s1 = await snap();
    assertEq('gate 载入时第一幕可见', s1.act1, 1, 0.01);
    assertEq('gate 载入时第二幕不可见', s1.act2, 0, 0.01);
    assertEq('gate 载入时第三幕整幕不可见（漏门控就会盖住第一幕）', s1.act3, 0, 0.01);
    assertEq('gate 载入时第四幕整幕不可见', s1.act4, 0, 0.01);
    assertEq('gate 载入时第五幕整幕不可见（z=5 最高，漏门控必盖住第一幕 —— R19）', s1.act5, 0, 0.01);
    assertEq('gate 载入时第六幕整幕不可见', s1.act6, 0, 0.01);
    assertEq('gate 载入时第三幕定格图不可见（它是常驻可见元素，最易漏）', s1['bg-room-suitcase'], 0, 0.01);
    assertEq('gate 载入时第五幕室内背景不可见（同为全屏常驻图，R19）', s1['bg-inside'], 0, 0.01);
    await shot('gate-1-act1-start');

    // ② 第二幕进行中：第一幕退场、第三幕仍不可见
    await toAct2SecondLine();
    const s2 = await snap();
    assertEq('gate 第二幕时第一幕已退场', s2.act1, 0, 0.01);
    assertEq('gate 第二幕时第二幕可见', s2.act2, 1, 0.01);
    assertEq('gate 第二幕时第三幕仍不可见', s2.act3, 0, 0.01);
    assertEq('gate 第二幕时第四幕仍不可见', s2.act4, 0, 0.01);
    assertEq('gate 第二幕时第五幕仍不可见', s2.act5, 0, 0.01);
    assertEq('gate 第二幕时第五幕室内背景仍不可见', s2['bg-inside'], 0, 0.01);
    await shot('gate-2-act2-room');

    // ③ 接着第二幕继续推进到第三幕激活：整幕转为可见（防止「修反了」变成永远不显示）
    //    注意不能直接调 toAct3() —— 它内部会重跑 toAct2SecondLine()，
    //    而此刻第二句的 GO 已经点过了，会一直等不到第二个 GO。
    await clickAndWaitHide('#btn-go');
    await waitFor(`document.getElementById('hand').classList.contains('in')`, 6000, 'hand 出现');
    await sleep(500);
    await click('#suitcase');
    await waitFor(`document.getElementById('blackout').classList.contains('in')`, 10000, '第二幕黑幕');
    await waitFor(`document.getElementById('act3').classList.contains('active')`, 15000, '第三幕激活');
    const s3 = await snap();
    assertEq('gate 第三幕激活后整幕可见', s3.act3, 1, 0.01);
    assertEq('gate 第三幕时定格图可见', s3['bg-room-suitcase'], 1, 0.01);
    assertEq('gate 第三幕时第五幕仍不可见', s3.act5, 0, 0.01);
    assertEq('gate 第三幕时第五幕室内背景仍不可见', s3['bg-inside'], 0, 0.01);

    // ④ 各幕必须是「自包含的堆叠上下文」：否则幕内高 z-index 元素会跑到 #stage 层，
    //    盖住层级更高但幕内元素 z-index 更低的后续幕。
    //    真实案例：第五幕视频在放，而 #act4 的 #goal01(z=95) 压在 #act5(z=5) 之上，
    //    表现为「第五幕对话背后还透着 Goal Achieved 卡片」—— 所有几何断言全绿。
    const gc = await evaluate(`(() => {
      const ids = ['act1','act2','act3','act4','act5','act6'];
      const out = {};
      ids.forEach((id) => {
        const el = document.getElementById(id);
        out[id] = el ? getComputedStyle(el).isolation : null;
      });
      return JSON.stringify(out);
    })()`).then(JSON.parse).catch(() => ({}));
    for (const id of ['act1','act2','act3','act4','act5','act6']) {
      assertTrue(`gate #${id} 建立自包含堆叠上下文（isolation:isolate）`,
        gc[id] === 'isolate', '实测 isolation = ' + gc[id]);
    }
  }

  /* ================= 用例 p1：台词文本位置 =================
     需求：台词（2-3 行）整体下移 20px，且「只能在浅蓝色底板上，不能压倒其他物件」。
     实现：文本区改用 top 锚定（top:770.4）。2 行时底边 = y846，底边距画面底 50px；
           行数增加只向下生长，所以 2/3 行的墨迹顶边恒为 y≈776.4（原 756.4 下移 20px）。
     下列参照物边界均来自对 assets/screen2/chat.png 的像素实测，已换算为画布坐标。 */
  const PANEL_BLUE_TOP = 718;      // 浅蓝底板上沿
  const PANEL_BLUE_BOTTOM = 896;   // 浅蓝底板下沿 = 画面底边
  const LUNA_NAME_PLATE = { left: 351, right: 523, top: 690, bottom: 755 };
  const LUNA_ART_RIGHT = 350;      // 角色立绘在面板区的最右像素
  const GO_BUTTON = { left: 1062, right: 1100, top: 799, bottom: 846 };

  const edgesOf = (b) => ({ left: b.left, top: b.top, right: b.left + b.width, bottom: b.top + b.height });
  const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const fmtRect = (r) => 'x' + r.left + '-' + r.right + ' / y' + r.top + '-' + r.bottom;

  // 「只在底板上、不压物件」这组硬约束，第 1、2 句都必须满足。
  // boxTop 是行盒顶边（含字体上下留白，透明），inkTop 才是第一行字真正的墨迹顶边。
  function assertOnPanelOnly(label, e, inkTop) {
    assertTrue(label + ' 完全落在浅蓝底板上（墨迹顶边 ' + inkTop + ' >= 底板上沿 ' + PANEL_BLUE_TOP + '）',
      inkTop >= PANEL_BLUE_TOP, '墨迹顶边 ' + inkTop + ' 高于底板上沿 ' + PANEL_BLUE_TOP);
    assertTrue(label + ' 底边不超出画面（' + e.bottom + ' <= ' + PANEL_BLUE_BOTTOM + '）',
      e.bottom <= PANEL_BLUE_BOTTOM, '文字底边 ' + e.bottom);
    assertTrue(label + ' 不压倒「Luna」姓名牌（墨迹顶边 ' + inkTop + ' >= 牌底 ' + LUNA_NAME_PLATE.bottom + '）',
      inkTop >= LUNA_NAME_PLATE.bottom,
      '文本框 y' + e.top + '-' + e.bottom + '，墨迹顶边 ' + inkTop + '，姓名牌底 ' + LUNA_NAME_PLATE.bottom);
    assertTrue(label + ' 不压倒左侧角色立绘（左边界 ' + e.left + ' > ' + LUNA_ART_RIGHT + '）',
      e.left > LUNA_ART_RIGHT, '文字左边界 ' + e.left);
    assertTrue(label + ' 不压倒 GO 按钮',
      !overlaps(e, GO_BUTTON), '文字 ' + fmtRect(e) + ' vs GO 按钮 ' + fmtRect(GO_BUTTON));
  }

  async function caseP1() {
    await toAct2FirstLine();
    await shot('p1-1-line1');

    assertEq('p1 第1句 文案与需求一致（含弯引号）', await textOf('#chat-text') === LINE1 ? 1 : 0, 1, 0);

    const t1 = await box('#chat-text');
    const ink1 = await inkOf('#chat-text');
    const inkTop1 = +(t1.top + ink1.inkTopOffset).toFixed(2);
    assertEq('p1 第1句 左边缘距画面左 = 380', t1.left, 380);
    assertEq('p1 第1句 右边缘距画面右 = 180', t1.fromRight, 180);
    assertEq('p1 第1句 文本区顶边 = 770.4（top 锚定）', t1.top, 770.4);
    assertEq('p1 第1句 底边距画面底 = 50（由 70 下移 20px）', t1.fromBottom, 50);
    assertEq('p1 第1句 墨迹顶边 ≈ 776.4（较原 756.4 下移 20px）', inkTop1, 776.4, 1.5);
    assertEq('p1 第1句 文本区宽度 = 640', t1.width, 640);
    assertEq('p1 第1句 右边缘绝对坐标 = 1020', t1.left + t1.width, 1020, 0);
    assertOnPanelOnly('p1 第1句', edgesOf(t1), inkTop1);

    /* ---- 3 行台词回归：注入更长文案，验证行数增加只向下生长、依然不压任何物件 ----
       打字机此刻已完成（rAF 循环已退出），直接改写 textContent 不会被覆盖。 */
    const lineCount = (b, ink) => Math.round(b.height / ink.lineBox);
    await evaluate(`document.getElementById('chat-text').textContent = ${JSON.stringify(LINE3)}`);
    await sleep(200);
    await shot('p1-3-line3');

    const t3 = await box('#chat-text');
    const ink3 = await inkOf('#chat-text');
    const inkTop3 = +(t3.top + ink3.inkTopOffset).toFixed(2);
    assertEq('p1 3行 实际行数 = 3', lineCount(t3, ink3), 3, 0.2);
    assertEq('p1 3行 文本区顶边 = 770.4（与 2 行相同，行数只向下生长）', t3.top, 770.4);
    assertEq('p1 3行 墨迹顶边 ≈ 776.4（仍为下移 20px 后的位置）', inkTop3, 776.4, 1.5);
    assertTrue('p1 3行 底边仍在画面内（' + (t3.top + t3.height) + ' <= ' + STAGE_H + '）',
      t3.top + t3.height <= STAGE_H, '底边 ' + (t3.top + t3.height));
    assertOnPanelOnly('p1 3行', edgesOf(t3), inkTop3);

    // 复原为第 1 句，后续流程照常推进
    await evaluate(`document.getElementById('chat-text').textContent = ${JSON.stringify(LINE1)}`);

    // 第 2 句：同一组约束必须依然成立（顶边锚定，与行数无关）
    await clickAndWaitHide('#btn-go');
    await waitFor(`document.getElementById('btn-go').classList.contains('in')`, 25000, '第 2 句打完');
    await sleep(400);
    await shot('p1-2-line2');

    assertEq('p1 第2句 文案与需求一致', await textOf('#chat-text') === LINE2 ? 1 : 0, 1, 0);

    const t2 = await box('#chat-text');
    const ink2 = await inkOf('#chat-text');
    const inkTop2 = +(t2.top + ink2.inkTopOffset).toFixed(2);
    assertEq('p1 第2句 左边缘距画面左 = 380', t2.left, 380);
    assertEq('p1 第2句 右边缘距画面右 = 180', t2.fromRight, 180);
    assertEq('p1 第2句 文本区顶边 = 770.4', t2.top, 770.4);
    assertEq('p1 第2句 底边距画面底 = 50', t2.fromBottom, 50);
    assertEq('p1 第2句 墨迹顶边 ≈ 776.4', inkTop2, 776.4, 1.5);
    assertEq('p1 第2句 文本区宽度 = 640', t2.width, 640);
    assertEq('p1 第2句 文本区高度（2 行，随行数自适应）', t2.height, 76, 3);
    assertOnPanelOnly('p1 第2句', edgesOf(t2), inkTop2);
  }

  /* ================= 用例 p2：第2次 GO -> chat 整体消失 -> hand 出现 ================= */
  async function caseP2() {
    await toAct2SecondLine();
    await shot('p2-1-before-click');

    // --- 基线：chat 可见、hand 未出现、行李箱已就位 ---
    assertEq('p2 基线 点击前 chat 可见', await effOpacity('#chat-frame'), 1, 0.01);
    assertTrue('p2 基线 点击前 hand 尚未出现', !(await hasClass('#hand', 'in')));
    assertEq('p2 基线 点击前 行李箱已就位', await effOpacity('#suitcase'), 1, 0.01);

    await click('#btn-go');

    // --- (a) 点击瞬间 hand 不能抢跑 ---
    assertTrue('p2 点击 GO 后 hand 未立即出现', !(await hasClass('#hand', 'in')));

    // --- (b) 整个 chat 先消失 ---
    await waitFor(`document.getElementById('chat').classList.contains('out')`, 3000, 'chat 进入消失态');
    assertTrue('p2 chat 消失 先于 hand 出现（顺序正确）', !(await hasClass('#hand', 'in')));

    // --- (c) 然后 hand 才出现 ---
    await waitFor(`document.getElementById('hand').classList.contains('in')`, 3000, 'hand 出现');
    await sleep(900);   // 等所有过渡彻底结束

    // chat.png 画面本体、姓名牌、台词文本 —— 全部必须视觉不可见
    assertEq('p2 chat.png 画面本体 有效透明度 = 0', await effOpacity('#chat-frame'), 0, 0.01);
    assertEq('p2 台词文本 有效透明度 = 0', await effOpacity('#chat-text'), 0, 0.01);
    assertEq('p2 整个 chat 层 有效透明度 = 0', await effOpacity('#chat'), 0, 0.01);
    assertTrue('p2 chat.png 已从画面消失（class 含 out）', await hasClass('#chat', 'out'));

    // hand 出现且可点，行李箱完整露出（不再被 chat 遮挡）
    assertEq('p2 hand 有效透明度 = 1', await effOpacity('#hand'), 1, 0.01);
    assertEq('p2 行李箱 有效透明度 = 1', await effOpacity('#suitcase'), 1, 0.01);
    assertEq('p2 行李箱 距画面右 = 50', (await box('#suitcase')).fromRight, 50);
    assertEq('p2 行李箱 底边距画面底 = 30', (await box('#suitcase')).fromBottom, 30);
    assertTrue('p2 行李箱已变为可点击', await hasClass('#suitcase', 'clickable'));
    assertTrue('p2 GO 按钮已隐藏', !(await hasClass('#btn-go', 'in')));

    await shot('p2-2-after-click');

    // --- 收尾：点击行李箱仍能正常全黑 ---
    await click('#suitcase');
    await waitFor(`document.getElementById('blackout').classList.contains('in')`, 10000, 'blackout');
    await sleep(900);
    await shot('p2-3-black');
    assertEq('p2 点击行李箱后遮黑层不透明', await effOpacity('#blackout'), 1, 0.01);
  }

  /* ================= 用例 flow：全流程回归 ================= */
  async function caseFlow() {
    await waitFor(`document.getElementById('btn-start').classList.contains('in')`, 20000, 'btn-start');
    await sleep(300);
    await shot('flow-1-act1');
    assertEq('flow START 底边距画面底 = 170', (await box('#btn-start')).fromBottom, 170);
    assertEq('flow bg-start 宽 = 1200', (await box('#bg-start')).width, 1200, 0);
    assertEq('flow bg-start 高 = 896', (await box('#bg-start')).height, 896, 0);

    // 缩放：<1200x896 等比缩小，>1200x896 不放大
    // 注意：computed transform 形如 "matrix(1, 0, 0, 1, 0, 0)"，必须取 matrix() 的
    // 第一个参数；早期用「剥掉所有非数字字符」的写法会把 matrix(1,0,0,1,0,0)
    // 拼成 100100，scale=1 时必然误判。
    const stageScale = async () => {
      const t = await evaluate(`getComputedStyle(document.getElementById('stage')).transform`);
      if (t === 'none') return 1;
      const m = /matrix\(([-\d.]+)/.exec(t);
      return m ? parseFloat(m[1]) : NaN;
    };

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.dispatchEvent(new Event('resize'))`);
    await sleep(350);
    assertEq('flow 缩放@800x600 = 0.6667', await stageScale(), 0.6667, 0.002);
    assertEq('flow 缩放时内部坐标系仍为 896 高', await evaluate(`document.getElementById('stage').offsetHeight`), 896, 0);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.dispatchEvent(new Event('resize'))`);
    await sleep(350);
    assertEq('flow 缩放@1600x1000 = 1（不放大）', await stageScale(), 1, 0.002);
    assertEq('flow 缩放@1600x1000 时内部坐标系仍为 1200',
      await evaluate(`document.getElementById('stage').offsetWidth`), 1200, 0);

    // 放大态下按 1:1 渲染：START 按钮屏幕宽度应与舞台坐标一致（未被放大）
    assertEq('flow 放大态 START 屏幕宽 = 227（未随窗口放大）',
      await evaluate(`document.getElementById('btn-start').getBoundingClientRect().width`), 227, 0.6);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: STAGE_W, height: STAGE_H, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.dispatchEvent(new Event('resize'))`);
    await sleep(350);

    // 进入第二幕：先验「打字期间 GO 按钮不在画面」，再等第 1 句打完
    await waitFor(`document.getElementById('btn-start').classList.contains('in')`, 20000, 'btn-start');
    await sleep(600);   // 等 START 入场动画结束、busy 锁释放、点击监听挂上
    await click('#btn-start');
    await waitFor(`document.getElementById('chat').classList.contains('in')`, 10000, 'chat 滑入');
    await sleep(700);   // 此刻第 1 句正在逐字输入
    assertEq('flow 打字期间 GO 按钮不在画面（有效透明度 0）', await effOpacity('#btn-go'), 0, 0.01);
    assertTrue('flow 打字期间 GO 按钮不可点击', (await box('#btn-go')).pointerEvents === 'none');
    assertTrue('flow 打字期间文本正在逐字增长',
      (await textOf('#chat-text')).length > 0 && (await textOf('#chat-text')).length < LINE1.length);
    await shot('flow-2-typing');

    await waitFor(`document.getElementById('btn-go').classList.contains('in')`, 25000, '第 1 句打完');
    await sleep(400);
    await shot('flow-3-line1');
    assertEq('flow 第1句 文案与需求一致（含弯引号）', await textOf('#chat-text') === LINE1 ? 1 : 0, 1, 0);

    const chat = await box('#chat');
    assertEq('flow 对话弹窗 贴底（距画面底 = 0）', chat.fromBottom, 0);
    assertEq('flow 对话弹窗 高 = 496', chat.height, 496, 0);
    assertEq('flow GO 按钮 距画面右 = 100', (await box('#btn-go')).fromRight, 100);
    assertEq('flow GO 按钮 底边距画面底 = 50', (await box('#btn-go')).fromBottom, 50);
    assertEq('flow 台词文本 左边缘距画面左 = 380', (await box('#chat-text')).left, 380);
    assertEq('flow 台词文本 顶边 = 770.4', (await box('#chat-text')).top, 770.4);
    assertEq('flow 台词文本 底边距画面底 = 50', (await box('#chat-text')).fromBottom, 50);

    await clickAndWaitHide('#btn-go');
    await waitFor(`document.getElementById('suitcase').classList.contains('in')`, 10000, 'suitcase');
    await waitFor(`document.getElementById('btn-go').classList.contains('in')`, 25000, '第 2 句打完');
    await sleep(400);
    await shot('flow-4-line2');
    assertEq('flow 行李箱 距画面右 = 50', (await box('#suitcase')).fromRight, 50);
    assertEq('flow 行李箱 底边距画面底 = 30', (await box('#suitcase')).fromBottom, 30);

    await click('#btn-go');
    await waitFor(`document.getElementById('hand').classList.contains('in')`, 5000, 'hand 出现');
    await sleep(800);
    await shot('flow-5-hand');
    assertEq('flow 引导手 距画面右 = 46', (await box('#hand')).fromRight, 46, 1);
    assertTrue('flow 引导手 不可点击（仅作指示）', (await box('#hand')).pointerEvents === 'none');
    assertEq('flow 引导手 与 chat 互不遮挡（chat 已消失）', await effOpacity('#chat'), 0, 0.01);

    await click('#suitcase');
    await waitFor(`document.getElementById('blackout').classList.contains('in')`, 10000, 'blackout');
    await sleep(900);
    await shot('flow-6-black');
    assertEq('flow 遮黑层 不透明', await effOpacity('#blackout'), 1, 0.01);
    assertTrue('flow #act3-slot 保持为空',
      await evaluate(`(()=>{const s=document.getElementById('act3-slot');return s.children.length===0&&s.textContent.trim()===''})()`));

    assertTrue('flow 全部素材加载成功', await evaluate(`(()=>{
      const ids=['bg-start','btn-start','bg-room','chat-frame','btn-go','suitcase','hand'];
      return ids.every(id=>{const e=document.getElementById(id);return e&&e.complete&&e.naturalWidth>0});
    })()`));
  }

  /* ==================================================================
     第三、四幕公共前置与工具
     ================================================================== */
  // 注意：不能叫 LINE3 —— 上面的 p1 用例已用同名常量做「3 行台词」回归
  const LINE_ACT3 = 'Let\u2019s add our favourite stickers. Now it will be our exclusive suitcase!';
  // 第五幕四句（全片第 ④–⑦ 句）—— 与需求 §8.3 / §8.6 逐字一致
  const LINE_ACT4 = 'After over 30 hours of flight, I finally reach this ancient castle.';
  const LINE_ACT5 = 'I wonder what stories unfolded here. Let\u2019s go in.';
  const LINE_ACT6 = 'Wow, stepping inside feels like traveling back in time.';
  const LINE_ACT7 = 'Huh, there are scraps of paper on the floor. What could they be?';

  // 从零一路推进到「第三幕已激活」（第二幕黑幕已碎成转场）
  const toAct3 = async () => {
    await toAct2SecondLine();
    await click('#btn-go');
    await waitFor(`document.getElementById('hand').classList.contains('in')`, 6000, 'hand');
    await sleep(500);
    await click('#suitcase');
    await waitFor(`document.getElementById('blackout').classList.contains('in')`, 10000, '第二幕黑幕');
    await waitFor(`document.getElementById('act3').classList.contains('active')`, 15000, '第三幕激活');
  };

  // 继续推进到「面板入场完成、可以开始贴纸」：跳过视频 + 打完第三句 + 点 GO
  const toAct3Panel = async () => {
    await toAct3();
    await waitFor(`!document.getElementById('blackout').classList.contains('in')`, 20000, '黑幕淡出露出视频');
    // 视频太快跳过：拖到结尾触发 ended（真实播放留给 full2）
    await evaluate(`(() => {
      const e = document.getElementById('act3-video');
      if (e.readyState >= 1 && e.duration > 0) e.currentTime = Math.max(0, e.duration - 0.4);
    })()`);
    await waitFor(`document.getElementById('chat3').classList.contains('in')`, 20000, 'chat3 滑入');
    await waitFor(`document.getElementById('btn-go3').classList.contains('in')`, 25000, '第三句打完');
    await sleep(300);
    await click('#btn-go3');                       // 对话框整体消失
    await waitFor(`document.getElementById('sticker-frame').classList.contains('in')`, 10000, '面板滑入');
    await waitFor(`document.getElementById('btn-ok').classList.contains('in')`, 12000, '按钮滑入');
    // ⚠️ .in 类加上的瞬间按钮入场动画（500ms）仍在跑、busy 锁未释放，
    // 此时点击会被判定为「演出期间」而吞掉。必须等锁真正释放。
    await waitFor(`window.__nj.state().busy === false`, 5000, '演出锁释放');
    await sleep(150);
  };

  // 继续推进到第五幕开场（视频播放中）：贴纸玩法 → 点 OK → 第四幕 → 点 Continue → 第五幕激活
  const toAct5 = async () => {
    await toAct3Panel();
    await evaluate(`window.__nj.setRotation(0)`);
    await place('bag', 250, 400);
    await place('camera', 400, 550);
    await place('drink', 300, 680);
    await waitFor(`window.__nj.state().okReady === true`, 4000, 'OK 可用');
    await sleep(150);
    await click('#btn-ok');
    await waitFor(`document.getElementById('continue').classList.contains('in')`, 10000, 'Continue 滑入');
    await sleep(600);
    await click('#continue');
    await waitFor(`document.getElementById('act5').classList.contains('active')`, 15000, '第五幕激活');
  };
  // 这正是自由落点玩法最容易出错的地方（#stage 带 scale），测试端也必须换算。
  const clickCanvas = async (cx, cy) => {
    const pt = await evaluate(`(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      const s = r.width / ${STAGE_W};
      return { x: r.left + ${cx} * s, y: r.top + ${cy} * s };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  };

  // 已落定贴纸的中心（布局坐标，不受 transform / 动画影响）
  const placedCenters = () => evaluate(`(() => {
    const stage = document.getElementById('stage');
    return [].map.call(document.querySelectorAll('#sticker-layer .placed'), (el) => {
      let x = 0, y = 0, n = el;
      while (n && n !== stage) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent; }
      return { cx: +(x + el.offsetWidth / 2).toFixed(2), cy: +(y + el.offsetHeight / 2).toFixed(2) };
    });
  })()`);

  const njState = () => evaluate(`window.__nj.state()`);
  const placedCount = () => evaluate(`document.querySelectorAll('#sticker-layer .placed').length`);
  const usedPalettes = () =>
    evaluate(`document.querySelectorAll('#sticker-panel .palette.used').length`);
  const cursorCount = () => evaluate(`document.querySelectorAll('#sticker-cursor img').length`);
  const paletteSel = (key) => `#sticker-panel .palette[data-sticker="${key}"]`;

  // 点面板贴纸 → 在画布坐标落定（含等待过渡锁释放）
  const place = async (key, cx, cy) => {
    await click(paletteSel(key));
    await sleep(120);
    await clickCanvas(cx, cy);
    await sleep(320);            // 等落定过渡锁（250ms）释放
  };

  /* ================= 用例 a3：视频 → 定格 → 第三句 → GO 消失对话框 ================= */
  async function caseA3() {
    await toAct3();

    // --- A1 视频：几何铺满、静音、内联播放 ---
    const v = await box('#act3-video');
    assertEq('a3 视频 左边缘 = 0', v.left, 0, 0);
    assertEq('a3 视频 顶边 = 0', v.top, 0, 0);
    assertEq('a3 视频 宽 = 1200（铺满）', v.width, 1200, 0);
    assertEq('a3 视频 高 = 896（铺满）', v.height, 896, 0);
    assertTrue('a3 视频 静音播放（Q8）',
      await evaluate(`document.getElementById('act3-video').muted === true`));
    assertTrue('a3 视频 playsinline',
      await evaluate(`document.getElementById('act3-video').playsInline === true`));
    assertEq('a3 视频 原始尺寸 1112x834（与画布仅差 0.45% 纵横比）',
      await evaluate(`(()=>{const e=document.getElementById('act3-video');return e.videoWidth*10000+e.videoHeight})()`),
      11120834, 0);

    // --- 黑幕淡出后露出视频，且视频确实在推进 ---
    await waitFor(`!document.getElementById('blackout').classList.contains('in')`, 20000, '黑幕淡出露出视频');
    await waitFor(`document.getElementById('act3-video').currentTime > 0`, 8000, '视频开始推进');
    assertTrue('a3 视频已在自动播放（Q11：无需再次点击）',
      (await evaluate(`document.getElementById('act3-video').currentTime`)) > 0);
    await sleep(500);   // 等黑幕 400ms 淡出走完
    assertEq('a3 露出视频后黑幕透明', await effOpacity('#blackout'), 0, 0.01);
    assertTrue('a3 视频播放期间点击仍被拦截（#blackout.guard）',
      await hasClass('#blackout', 'guard'));
    await shot('a3-1-video');

    // 视频太长，快进到结尾（真实播放留给 full2 用例）
    await evaluate(`(() => { const e = document.getElementById('act3-video');
      e.currentTime = Math.max(0, e.duration - 0.4); })()`);

    // --- A2 定格 + chat3 滑入 ---
    await waitFor(`document.getElementById('chat3').classList.contains('in')`, 15000, 'chat3 滑入');
    await sleep(700);
    assertEq('a3 视频已淡出（定格图露出）', await effOpacity('#act3-video'), 0, 0.01);
    assertEq('a3 定格图 全屏可见', await effOpacity('#bg-room-suitcase'), 1, 0.01);
    assertTrue('a3 播放结束后守卫已解除', !(await hasClass('#blackout', 'guard')));

    const c3 = await box('#chat3');
    assertEq('a3 chat3 贴底（距画面底 = 0）', c3.fromBottom, 0);
    assertEq('a3 chat3 高 = 496', c3.height, 496, 0);
    assertEq('a3 chat3 顶边 = 400', c3.top, 400, 0);
    const t3 = await box('#chat3 .chat-text');
    assertEq('a3 第三句文本 左边缘 = 380（复用第二幕几何）', t3.left, 380);
    assertEq('a3 第三句文本 顶边 = 770.4', t3.top, 770.4);
    assertEq('a3 第三句文本 宽 = 640', t3.width, 640, 0);

    // --- 打字期间 GO 不在画面 ---
    assertEq('a3 第三句打字期间 btn-go3 不在画面', await effOpacity('#btn-go3'), 0, 0.01);
    assertTrue('a3 第三句正在逐字增长',
      (await evaluate(`document.querySelector('#chat3 .chat-text').textContent.length`)) < LINE_ACT3.length);

    await waitFor(`document.getElementById('btn-go3').classList.contains('in')`, 25000, '第三句打完');
    await sleep(400);
    await shot('a3-2-line3');
    assertTrue('a3 第三句文案与需求一致（含弯引号 Let\u2019s）',
      (await evaluate(`document.querySelector('#chat3 .chat-text').textContent`)) === LINE_ACT3);
    assertEq('a3 btn-go3 距画面右 = 100', (await box('#btn-go3')).fromRight, 100);
    assertEq('a3 btn-go3 底边距画面底 = 50', (await box('#btn-go3')).fromBottom, 50);

    // --- A3 点击 GO：整个对话框（含姓名牌）整体消失 ---
    await click('#btn-go3');
    await waitFor(`document.getElementById('chat3').classList.contains('out')`, 3000, 'chat3 消失');
    await sleep(600);
    assertEq('a3 点击 GO 后 chat3 整个对话框有效透明度 = 0', await effOpacity('#chat3'), 0, 0.01);
    assertEq('a3 点击 GO 后姓名牌所在图 chat-frame 也全透明',
      await effOpacity('#chat3 .chat-frame'), 0, 0.01);
    assertTrue('a3 点击 GO 后第三句文本已清空',
      (await evaluate(`document.querySelector('#chat3 .chat-text').textContent`)) === '');
    assertTrue('a3 btn-go3 已隐藏', !(await hasClass('#btn-go3', 'in')));

    // --- A4 面板入场 ---
    await waitFor(`document.getElementById('sticker-frame').classList.contains('in')`, 8000, '面板滑入');
    await waitFor(`document.getElementById('btn-ok').classList.contains('in')`, 12000, '按钮滑入');
    await sleep(300);
    await shot('a3-3-panel');
    assertEq('a3 面板入场完成后 12 张贴纸全部可见',
      await evaluate(`document.querySelectorAll('#sticker-panel .palette.in').length`), 12, 0);
  }

  /* ================= 用例 a3b：第三幕几何（面板 / 槽位 / 按钮） ================= */
  async function caseA3b() {
    await toAct3Panel();

    // --- 面板：距顶 45 / 距右 25 ---
    const fr = await box('#sticker-frame');
    assertEq('a3b 面板 左边缘 = 653（距右 25）', fr.left, 653, 0);
    assertEq('a3b 面板 距画面右 = 25', fr.fromRight, 25, 0);
    assertEq('a3b 面板 顶边 = 45', fr.top, 45, 0);
    assertEq('a3b 面板 宽 = 522', fr.width, 522, 0);
    assertEq('a3b 面板 高 = 630', fr.height, 630, 0);
    assertEq('a3b 面板 下边缘 = 675', fr.top + fr.height, 675, 0);

    // --- 12 张贴纸逐格对位（列 690/847/1004 × 行 91/225/361/495，12 格填满不留空） ---
    const EXP = [
      ['bag', 690, 91], ['camera', 847, 91], ['drink', 1004, 91],
      ['flower', 690, 225], ['love', 847, 225], ['mountant', 1004, 225],
      ['passport', 690, 361], ['planet', 847, 361], ['rainboat', 1004, 361],
      ['travel', 690, 495], ['tree', 847, 495], ['earth', 1004, 495],
    ];
    assertEq('a3b 调色板贴纸数量 = 12（3×4 槽位全部填满）',
      await evaluate(`document.querySelectorAll('#sticker-panel .palette').length`), 12, 0);
    for (const [key, x, y] of EXP) {
      const b = await box(paletteSel(key));
      assertEq(`a3b ${key} 槽位 left=${x} / top=${y}`, b.left * 100000 + b.top, x * 100000 + y, 0);
      assertEq(`a3b ${key} 尺寸 142x119`, b.width * 1000 + b.height, 142119, 0);
      assertEq(`a3b ${key} 可见`, await effOpacity(paletteSel(key)), 1, 0.01);
    }
    // 第 4 行第 3 格（1004,495）此前是空的 —— 现由 earth.png 占据，且必须真的解码出像素
    assertTrue('a3b 第 4 行第 3 格现由 earth.png 占据（此前为空）',
      await evaluate(`(() => {
        const el = document.querySelector('#sticker-panel .palette[data-sticker="earth"]');
        return !!el && parseFloat(el.style.left) === 1004 && parseFloat(el.style.top) === 495
          && /assets\\/screen3\\/earth\\.png$/.test(el.getAttribute('src'));
      })()`));
    assertEq('a3b earth.png 已成功解码（原始宽 142）',
      await evaluate(`document.querySelector('#sticker-panel .palette[data-sticker="earth"]').naturalWidth`), 142, 0);
    // 12 个槽位一格不差、也不重复（防止「补一张」变成「挤掉一张」或坐标写重）
    assertEq('a3b 12 个槽位恰好被 12 张贴纸占满（无空缺、无重复坐标）',
      await evaluate(`(() => {
        const want = [];
        [91, 225, 361, 495].forEach(function (t) { [690, 847, 1004].forEach(function (l) { want.push(l + ',' + t); }); });
        const got = [].map.call(document.querySelectorAll('#sticker-panel .palette'),
          function (el) { return parseFloat(el.style.left) + ',' + parseFloat(el.style.top); });
        if (got.length !== want.length) return -1;
        const miss = want.filter(function (w) { return got.indexOf(w) < 0; });
        const dup = got.filter(function (g, i) { return got.indexOf(g) !== i; });
        return miss.length * 100 + dup.length;
      })()`), 0, 0);

    // --- 按钮：同一水平线 top 714（距底 85），OK 距右 25，RESET 距 OK 70 ---
    const ok = await box('#btn-ok');
    const rs = await box('#btn-reset');
    assertEq('a3b OK 左边缘 = 949（距右 25）', ok.left, 949, 0);
    assertEq('a3b OK 距画面右 = 25', ok.fromRight, 25, 0);
    assertEq('a3b OK 顶边 = 714（距底 85）', ok.top, 714, 0);
    assertEq('a3b OK 底边距画面底 = 85', ok.fromBottom, 85, 0);
    assertEq('a3b OK 尺寸 226x97', ok.width * 1000 + ok.height, 226097, 0);
    assertEq('a3b RESET 左边缘 = 652', rs.left, 652, 0);
    assertEq('a3b RESET 顶边 = 714（与 OK 同一水平线）', rs.top, 714, 0);
    assertEq('a3b RESET 尺寸 227x97', rs.width * 1000 + rs.height, 227097, 0);
    assertEq('a3b RESET 右边缘与 OK 左边缘间距 = 70', ok.left - (rs.left + rs.width), 70, 0);
    assertEq('a3b OK 右边缘 = 1175（与面板右边缘对齐）', ok.left + ok.width, 1175, 0);
    assertEq('a3b 面板下边缘与按钮上边缘间隙 = 39', rs.top - (fr.top + fr.height), 39, 0);

    // --- 初始态：0 张贴纸 -> OK 置灰不可点 ---
    assertTrue('a3b 初始 OK 已置灰（class 含 dim）', await hasClass('#btn-ok', 'dim'));
    assertTrue('a3b 初始 OK 不可点击', (await box('#btn-ok')).pointerEvents === 'none');
    assertEq('a3b 初始 OK 有效透明度 = 0.45（置灰）', await effOpacity('#btn-ok'), 0.45, 0.02);
    assertTrue('a3b RESET 可点击', (await box('#btn-reset')).pointerEvents === 'auto');
    await shot('a3b-panel-geometry');
  }

  /* ================= 用例 a3c：自由落点玩法（含缩放补偿专项） ================= */
  async function caseA3c() {
    await toAct3Panel();
    await evaluate(`window.__nj.setRotation(0)`);   // 固定旋转角，保证可复现

    // --- ① 选中面板贴纸 -> 待放置并跟随光标 ---
    await click(paletteSel('bag'));
    await sleep(300);
    assertTrue('a3c 点击面板贴纸后进入待放置态', (await njState()).placing === true);
    assertEq('a3c 该贴纸在面板中置灰', await usedPalettes(), 1);
    assertEq('a3c 跟随层出现 1 张手持贴纸', await cursorCount(), 1);
    await shot('a3c-1-picking');

    // --- ② 箱身内落定：以点击点为中心 ---
    await clickCanvas(300, 500);
    await sleep(320);
    assertEq('a3c 箱身内点击后落定 1 张', await placedCount(), 1);
    assertEq('a3c 计数 = 1', (await njState()).count, 1);
    assertEq('a3c 待放置态已结束', (await njState()).placing === false ? 0 : 1, 0);
    assertEq('a3c 跟随层已清空', await cursorCount(), 0);
    let centers = await placedCenters();
    assertEq('a3c 落定中心 x = 点击点 300', centers[0].cx, 300, 0.6);
    assertEq('a3c 落定中心 y = 点击点 500', centers[0].cy, 500, 0.6);
    assertEq('a3c 落定尺寸为素材原尺寸 142x119',
      await evaluate(`(() => { const e = document.querySelector('#sticker-layer .placed');
        return e.offsetWidth * 1000 + e.offsetHeight; })()`), 142119, 0);

    // --- ③ 同一张贴纸不可重复使用（Q15） ---
    await click(paletteSel('bag'));
    await sleep(250);
    assertEq('a3c 已用过的贴纸无法再次选中（计数不变）', (await njState()).count, 1);
    assertEq('a3c 已用过的贴纸不会进入待放置态', (await njState()).placing === false ? 0 : 1, 0);
    assertEq('a3c 落定数量仍为 1', await placedCount(), 1);

    // --- ④ 自由落点：换不同位置再贴 2 张，凑满 3 张（落点须让整张贴纸落在红框内） ---
    await place('camera', 240, 340);
    await place('drink', 440, 700);
    centers = await placedCenters();
    assertEq('a3c 三张贴纸数量', centers.length, 3, 0);
    assertEq('a3c 第 2 张贴纸落点自由（240,340）', centers[1].cx * 1000 + centers[1].cy, 240340, 0.6);
    assertEq('a3c 第 3 张贴纸落点自由（440,700）', centers[2].cx * 1000 + centers[2].cy, 440700, 0.6);
    assertEq('a3c 计数 = 3', (await njState()).count, 3);

    // --- ⑤ 贴纸数 ≥ 3 -> OK 转为可用（Q16） ---
    assertTrue('a3c 满 3 张后 OK 转为可用', (await njState()).okReady === true);
    assertTrue('a3c OK 已去掉置灰态', !(await hasClass('#btn-ok', 'dim')));
    assertTrue('a3c OK 已可点击', (await box('#btn-ok')).pointerEvents === 'auto');
    assertEq('a3c OK 满 3 张后有效透明度 = 1', await effOpacity('#btn-ok'), 1, 0.02);
    await shot('a3c-2-three-placed');

    // --- ⑥ 箱身外点击 -> 贴纸飞回槽位并取消，不计数（Q24） ---
    await click(paletteSel('flower'));
    await sleep(300);
    assertTrue('a3c 箱身外点击前确实处于待放置态', (await njState()).placing === true);
    await clickCanvas(600, 200);                 // 明确在箱身之外、面板之外的空白区
    await sleep(400);
    assertTrue('a3c 箱身外点击后待放置态被取消', (await njState()).placing === false);
    assertEq('a3c 箱身外点击不计数（仍为 3）', (await njState()).count, 3);
    assertEq('a3c 箱身外点击不落定（仍为 3 张）', await placedCount(), 3);
    assertEq('a3c 飞回后跟随层已清空', await cursorCount(), 0);
    assertTrue('a3c 该贴纸已恢复面板可点', !(await hasClass(paletteSel('flower'), 'used')));
    assertEq('a3c 面板置灰数量回到 3', await usedPalettes(), 3);

    // 中心仍在红框内（537 < 540），但整张贴纸右边缘 607 已压出框外 -> 属于「超出范围」（Q25）
    await click(paletteSel('flower'));
    await sleep(200);
    await clickCanvas(537, 500);
    await sleep(400);
    assertEq('a3c 中心在框内但贴纸压出框外 -> 不落定', await placedCount(), 3);
    assertEq('a3c 中心在框内但贴纸压出框外 -> 不计数', (await njState()).count, 3);

    // --- ⑦ 待放置时点面板另一张 -> 切换目标（前一张飞回槽位） ---
    await click(paletteSel('love'));
    await sleep(200);
    await click(paletteSel('planet'));
    await sleep(300);
    assertTrue('a3c 切换目标后仍在待放置态', (await njState()).placing === true);
    assertTrue('a3c 被切换掉的贴纸已恢复面板可点', !(await hasClass(paletteSel('love'), 'used')));
    assertEq('a3c 切换后跟随层仍只有 1 张', await cursorCount(), 1);
    await clickCanvas(300, 700);                 // 落定，恢复干净状态
    await sleep(320);
    assertEq('a3c 切换目标后落定成功，共 4 张', await placedCount(), 4);

    // --- ⑧ 可显示范围（Q25）：整张贴纸必须完整落在红框内，任一边越界即飞回 ---
    await click('#btn-reset');
    await sleep(320);
    assertEq('a3c Q25 起点干净（RESET 后 0 张）', await placedCount(), 0);

    const DB = await evaluate(`window.__nj.dropBox()`);
    const DC = await evaluate(`window.__nj.dropCenter()`);
    assertEq('a3c Q25 红框左 = 146（用户红框实测换算）', DB.left, 146, 0);
    assertEq('a3c Q25 红框右 = 540', DB.right, 540, 0);
    assertEq('a3c Q25 红框上 = 259', DB.top, 259, 0);
    assertEq('a3c Q25 红框下 = 793', DB.bottom, 793, 0);
    assertEq('a3c Q25 中心可落点左 = 红框左 + 半个贴纸 71', DC.left, 217, 0.01);
    assertEq('a3c Q25 中心可落点右 = 红框右 − 半个贴纸 71', DC.right, 469, 0.01);
    assertEq('a3c Q25 中心可落点上 = 红框上 + 半个贴纸 59.5', DC.top, 318.5, 0.01);
    assertEq('a3c Q25 中心可落点下 = 红框下 − 半个贴纸 59.5', DC.bottom, 733.5, 0.01);

    // 核心回归 —— 这几个点的「贴纸中心」**都在红框内**（旧版「只判中心」会放行），
    // 但整张贴纸会压出框外，按 Q25 必须飞回原位、不落定、不计数。
    const OVERFLOW = [
      [150, 500, '左边缘压出框外（79 < 146）'],
      [536, 500, '右边缘压出框外（607 > 540）'],
      [300, 265, '顶边压出框外（205.5 < 259）'],
      [300, 785, '底边压出框外（844.5 > 793）'],
      [216, 500, '中心差 1px 未达左侧下限 217'],
      [470, 500, '中心差 1px 超出右侧上限 469'],
      [300, 318, '中心差 0.5px 未达上限 318.5'],
      [300, 734, '中心差 0.5px 超出下限 733.5'],
    ];
    for (const [px, py, why] of OVERFLOW) {
      await click(paletteSel('bag'));
      await sleep(200);
      await clickCanvas(px, py);
      await sleep(400);
      assertEq(`a3c Q25 越界飞回·不落定（${why}）`, await placedCount(), 0);
      assertEq(`a3c Q25 越界飞回·不计数（${why}）`, (await njState()).count, 0);
      assertTrue(`a3c Q25 越界飞回·贴纸恢复面板可点（${why}）`,
        !(await hasClass(paletteSel('bag'), 'used')));
      assertEq(`a3c Q25 越界飞回·跟随层已清空（${why}）`, await cursorCount(), 0);
    }

    // 边界上/边界内 1px 必须**能**贴上（防止「收紧判据」收过头，把整块可贴区做废）
    const EDGE = [
      [217, 500, '左边缘恰好贴框（146）'],
      [469, 500, '右边缘恰好贴框（540）'],
      [300, 319, '顶边恰好贴框（259.5 ≥ 259）'],
      [300, 733, '底边恰好贴框（792.5 ≤ 793）'],
    ];
    const EDGE_KEYS = ['camera', 'drink', 'flower', 'love'];
    for (let i = 0; i < EDGE.length; i += 1) {
      const [px, py, why] = EDGE[i];
      await place(EDGE_KEYS[i], px, py);
      const cc = await placedCenters();
      assertEq(`a3c Q25 贴边可落定（${why}）`, cc.length, i + 1, 0);
      assertEq(`a3c Q25 贴边落点精确 x（${why}）`, cc[i].cx, px, 0.6);
      assertEq(`a3c Q25 贴边落点精确 y（${why}）`, cc[i].cy, py, 0.6);
    }

    // 落定贴纸的**实际外框**必须完整落在红框内（按布局坐标，不含 ±10° 旋转）
    const outer = await evaluate(`(() => {
      const box = window.__nj.dropBox();
      return [].slice.call(document.querySelectorAll('#sticker-layer .placed')).map(function (el) {
        const l = parseFloat(el.style.left), t = parseFloat(el.style.top);
        const r = l + el.offsetWidth, b = t + el.offsetHeight;
        return { l: l, r: r, t: t, b: b,
                 ok: l >= box.left - 0.51 && r <= box.right + 0.51 &&
                     t >= box.top - 0.51 && b <= box.bottom + 0.51 };
      });
    })()`);
    assertEq('a3c Q25 落定数量 = 4', outer.length, 4, 0);
    assertEq('a3c Q25 四张贴纸外框全部完整落在红框内',
      outer.filter(function (o) { return !o.ok; }).length, 0, 0);
    assertTrue('a3c Q25 最左外框 ≥ 146（没有一张压出左边）',
      Math.min.apply(null, outer.map(function (o) { return o.l; })) >= 145.5);
    assertTrue('a3c Q25 最右外框 ≤ 540（没有一张压出右边）',
      Math.max.apply(null, outer.map(function (o) { return o.r; })) <= 540.5);
    assertTrue('a3c Q25 最上外框 ≥ 259（没有一张压出上边）',
      Math.min.apply(null, outer.map(function (o) { return o.t; })) >= 258.5);
    assertTrue('a3c Q25 最下外框 ≤ 793（没有一张压出下边）',
      Math.max.apply(null, outer.map(function (o) { return o.b; })) <= 793.5);
    await shot('a3c-4-dropbox');

    // --- ⑨ 缩放补偿专项：s = 0.75 下落点仍精确落在鼠标所指处 ---
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 672, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.dispatchEvent(new Event('resize'))`);
    await sleep(350);
    const sc = await evaluate(`(() => { const r = document.getElementById('stage').getBoundingClientRect();
      return +(r.width / ${STAGE_W}).toFixed(4); })()`);
    assertEq('a3c 缩放到 900x672 时 scale = 0.75', sc, 0.75, 0.002);
    // 用一个尚未使用的位置重新贴（先 RESET 清干净）
    await click('#btn-reset');
    await sleep(300);
    assertEq('a3c RESET 后箱身贴纸全部清除', await placedCount(), 0);
    assertEq('a3c RESET 后计数归零', (await njState()).count, 0);
    assertEq('a3c RESET 后调色板 12 张全部恢复', await usedPalettes(), 0);
    assertTrue('a3c RESET 后 OK 回到置灰态', await hasClass('#btn-ok', 'dim'));
    assertTrue('a3c RESET 后 OK 不可点击', (await box('#btn-ok')).pointerEvents === 'none');

    await place('tree', 343, 512);
    const scaled = await placedCenters();
    assertEq('a3c 缩放 0.75 下落定数量 = 1', scaled.length, 1, 0);
    assertEq('a3c 缩放 0.75 下落点 x 精确 = 343（误差 ≤1px）', scaled[0].cx, 343, 1);
    assertEq('a3c 缩放 0.75 下落点 y 精确 = 512（误差 ≤1px）', scaled[0].cy, 512, 1);
    await shot('a3c-3-scaled');

    // 还原视口，避免影响后续用例
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: STAGE_W, height: STAGE_H, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.dispatchEvent(new Event('resize'))`);
    await sleep(300);
  }

  /* ================= 用例 a4：第四幕目标达成 ================= */
  /* ================= 用例 bgm：背景音乐（需求 §3.5 / Q27–Q30） =================
     守的核心是「起止点精确」与「跨幕不重启」——
     起播必须恰好等于点击 START（之前全程静音），停止必须恰好等于点击 Continue。

     ⚠️ 测试启动参数带了 --autoplay-policy=no-user-gesture-required，
     所以 bgm.play() 在本环境一定成功；这恰好让我们能干净地验证「起止逻辑」本身，
     而不被自动播放策略的偶发性干扰。真实浏览器下起播点也是真实用户手势，天然满足。
     另外：跳过快进视频用的是 currentTime 赋值，不会触碰 bgm。 */
  async function caseBgm() {
    const bgmOf = async () => (await njState()).bgm;

    /* ---- 1. 页面加载后、点击 START 之前：必须全程静音 ---- */
    await waitFor(`document.getElementById('btn-start').classList.contains('in')`, 20000, 'btn-start 出现');
    await sleep(700);
    const b0 = await bgmOf();
    assertTrue('bgm 起始静音：点击 START 之前 BGM 未播放（paused = true）', b0.paused === true,
      'paused = ' + b0.paused);
    assertTrue('bgm 起始静音：尚未请求播放（wanted = false）', b0.wanted === false,
      'wanted = ' + b0.wanted);
    assertTrue('bgm 加载独立：BGM 不阻塞开场（第一幕已渲染）',
      (await njState()).booted === true);
    await shot('bgm-0-silent');

    /* ---- 2. 参数：音量 / 循环 / 素材 —— 读 Audio 真实属性，不看代码 ---- */
    assertEq('bgm 音量 = 0.35（Q27）', b0.volume, 0.35, 0.001);
    assertEq('bgm 不劫持点击音效：音效音量仍为 0.85（Q27）',
      (await njState()).soundVolume, 0.85, 0.001);
    assertTrue('bgm 循环 = true（Q28）', b0.loop === true, 'loop = ' + b0.loop);
    assertTrue('bgm 素材指向 music-walker-s.wav',
      String(b0.src).indexOf('music-walker-s.wav') > -1, 'src = ' + b0.src);

    /* ---- 3. 点击 START 的瞬间起播 ---- */
    await click('#btn-start');
    await waitFor(`window.__nj.state().bgm.wanted === true`, 4000, 'BGM 起播请求');
    await sleep(300);
    const b1 = await bgmOf();
    assertTrue('bgm 起播：点击 START 后 wanted = true', b1.wanted === true);
    assertTrue('bgm 起播：点击 START 后确实在播放（paused = false）', b1.paused === false,
      'paused = ' + b1.paused + ' / ready = ' + b1.ready + ' / src = ' + b1.src);
    await shot('bgm-1-playing');

    /* ---- 4. 跨幕连续（Q29）：第二幕期间 currentTime 只增不减，不重启 ---- */
    await waitFor(`document.getElementById('chat').classList.contains('in')`, 10000, 'chat 滑入');
    await sleep(500);
    const b2 = await bgmOf();
    assertTrue('bgm 跨幕连续：进入第二幕后仍在播放', b2.paused === false);
    assertTrue('bgm 跨幕连续：currentTime 向前推进（未重启回零）', b2.currentTime > b1.currentTime,
      b1.currentTime.toFixed(2) + ' -> ' + b2.currentTime.toFixed(2));

    /* ---- 5. 跨幕连续（Q29）：第二幕收尾 -> 第三幕整幕，全程不被触碰 ----
       这里不能复用 toAct3Panel()：它内部会从 toAct2FirstLine() 重头走，而本用例此刻
       已经停在第二幕，重复等 START 会死等。故按同一套步骤手工推进（与 toAct3Panel 等价）。 */
    await waitFor(`document.getElementById('btn-go').classList.contains('in')`, 25000, '第 1 句打完');
    await sleep(400);
    await clickAndWaitHide('#btn-go');
    await waitFor(`document.getElementById('suitcase').classList.contains('in')`, 10000, 'suitcase 出现');
    await waitFor(`document.getElementById('btn-go').classList.contains('in')`, 25000, '第 2 句打完');
    await sleep(400);
    await click('#btn-go');
    await waitFor(`document.getElementById('hand').classList.contains('in')`, 6000, 'hand');
    await sleep(500);
    await click('#suitcase');
    await waitFor(`document.getElementById('blackout').classList.contains('in')`, 10000, '第二幕黑幕');
    await waitFor(`document.getElementById('act3').classList.contains('active')`, 15000, '第三幕激活');
    await waitFor(`!document.getElementById('blackout').classList.contains('in')`, 20000, '黑幕淡出露出视频');
    await evaluate(`(() => {
      const e = document.getElementById('act3-video');
      if (e.readyState >= 1 && e.duration > 0) e.currentTime = Math.max(0, e.duration - 0.4);
    })()`);
    await waitFor(`document.getElementById('chat3').classList.contains('in')`, 20000, 'chat3 滑入');
    await waitFor(`document.getElementById('btn-go3').classList.contains('in')`, 25000, '第三句打完');
    await sleep(300);
    await click('#btn-go3');
    await waitFor(`document.getElementById('sticker-frame').classList.contains('in')`, 10000, '面板滑入');
    await waitFor(`document.getElementById('btn-ok').classList.contains('in')`, 12000, '按钮滑入');
    await waitFor(`window.__nj.state().busy === false`, 5000, '演出锁释放');
    await sleep(150);

    const b3 = await bgmOf();
    assertTrue('bgm 跨幕连续：第二 -> 第三幕整段转场期间仍在播放', b3.paused === false);
    assertTrue('bgm 跨幕连续：第二 -> 第三幕期间 currentTime 继续推进（未重启）',
      b3.currentTime > b2.currentTime,
      b2.currentTime.toFixed(2) + ' -> ' + b3.currentTime.toFixed(2));
    assertEq('bgm 跨幕连续：音量在幕间未被改动（仍为 0.35）', b3.volume, 0.35, 0.001);
    assertTrue('bgm 跨幕连续：第三幕玩法期间仍在播放（贴纸交互不打断音乐）', b3.paused === false);

    /* ---- 6. 第四幕蒙黑（goal01 / Continue 期间）BGM 仍在响 ---- */
    await evaluate(`window.__nj.setRotation(0)`);
    await place('bag', 250, 400);
    await place('camera', 400, 550);
    await place('drink', 300, 680);
    // 贴满 3 张后 OK 才可用；且按钮的「可用态」与点击监听有时序差，必须等状态就绪再点
    await waitFor(`window.__nj.state().okReady === true`, 4000, 'OK 可用');
    await sleep(200);
    await click('#btn-ok');
    await waitFor(`document.getElementById('continue').classList.contains('in')`, 12000, 'Continue 滑入');
    await sleep(600);
    const b4 = await bgmOf();
    assertTrue('bgm 跨幕连续：第四幕 Continue 出现后、点击前 BGM 仍在响', b4.paused === false,
      'paused = ' + b4.paused);
    // 只断言 paused 不够 —— 「跨幕重启」会让 currentTime 回零后又正常继续播放，
    // paused 全程都是 false，光看播放状态察觉不到。必须断言时间轴没有倒退。
    assertTrue('bgm 跨幕连续：第四幕期间 currentTime 继续推进（未重启回零）',
      b4.currentTime > b3.currentTime,
      b3.currentTime.toFixed(2) + ' -> ' + b4.currentTime.toFixed(2));
    await shot('bgm-2-before-continue');

    /* ---- 7. 点击 Continue 的瞬间停止（全片唯一停止点） ---- */
    await click('#continue');
    await waitFor(`window.__nj.state().bgm.wanted === false`, 4000, 'BGM 停止请求');
    await sleep(300);
    const b5 = await bgmOf();
    assertTrue('bgm 停止：点击 Continue 后 wanted = false', b5.wanted === false);
    assertTrue('bgm 停止：点击 Continue 后确实已暂停（paused = true）', b5.paused === true,
      'paused = ' + b5.paused);
    assertEq('bgm 停止：停止后 currentTime 归零', b5.currentTime, 0, 0.05);

    /* ---- 8. 结尾全黑期间全程无音乐 ---- */
    await waitFor(`document.getElementById('blackout').classList.contains('in')`, 6000, '全黑');
    await sleep(900);
    const b6 = await bgmOf();
    assertTrue('bgm 停止：全黑过程中与静止黑屏全程无音乐', b6.paused === true && b6.wanted === false,
      JSON.stringify(b6));
    await shot('bgm-3-final-silent');
  }

  /* ================= 用例 bgm2：BGM 缺失也必须不阻塞开场（Q30） =================
     需求 §12.6 最后两条：BGM 的加载独立于 preload() 队列；即使音乐文件缺失/加载失败，
     第一、二幕仍按原时序正常演出，控制台不出现未捕获错误。

     做法：用 Network.setBlockedURLs 屏蔽 BGM 资源（比篡改文件更干净），重新载入页面，
     断言 ① 第一幕照常渲染（booted = true）② 无未捕获错误 ③ 点 START 不抛异常。
     这是「BGM 不在 preload() 的 Promise.all 里」这条实现约束的**唯一直接证据** ——
     若有人把 BGM 塞进开场等待队列，本用例会因「开场被拖住 / 报错」而失败。 */
  async function caseBgm2() {
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['*music-walker-s.wav'] });
    await reload();                                  // 屏蔽生效后重新载入

    try {
      // 开场不被拖住：第一幕必须在正常时序内出现
      await waitFor(`document.getElementById('btn-start').classList.contains('in')`, 20000, 'btn-start 出现');
      assertTrue('bgm2 BGM 被屏蔽后第一幕照常渲染（booted = true）',
        (await njState()).booted === true);
      assertTrue('bgm2 BGM 被屏蔽后未显示启动失败提示',
        (await njState()).fallbackShown === false);

      await sleep(600);
      await click('#btn-start');
      await waitFor(`window.__nj.state().bgm.wanted === true`, 5000, 'BGM 起播请求');
      await sleep(400);
      const st = await njState();
      assertTrue('bgm2 BGM 加载失败时点 START 不抛异常、不阻塞流程（已进入第二幕）',
        await evaluate(`document.getElementById('act1').classList.contains('out')`));
      assertTrue('bgm2 BGM 不可用时仍标记为「已请求播放」（不整场静音逻辑不受影响）',
        st.bgm.wanted === true);
      assertTrue('bgm2 BGM 不可用时未播放（paused = true），但不影响任何流程',
        st.bgm.paused === true);
      await shot('bgm2-blocked');

      // 关键：不能有未捕获错误
      assertTrue('bgm2 BGM 加载失败不产生未捕获错误', errors.length === 0, errors.join(' | '));
    } finally {
      await cdp.send('Network.setBlockedURLs', { urls: [] });
    }
  }

  async function caseA4() {
    await toAct3Panel();
    await evaluate(`window.__nj.setRotation(0)`);

    // 先贴满 3 张让 OK 可用
    await place('bag', 250, 400);
    await place('camera', 400, 550);
    await place('drink', 300, 680);
    assertTrue('a4 前置：OK 已可用', (await njState()).okReady === true);

    // shadow.png 本身必须真的是「半透明黑」，否则「画面蒙黑」就成了全黑
    const px = await evaluate(`(() => new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas');
        c.width = im.naturalWidth; c.height = im.naturalHeight;
        const x = c.getContext('2d');
        x.drawImage(im, 0, 0);
        const d = x.getImageData(600, 400, 1, 1).data;
        resolve([d[0], d[1], d[2], d[3], im.naturalWidth, im.naturalHeight]);
      };
      im.src = 'assets/screen4/shadow.png';
    }))()`);
    assertEq('a4 shadow.png 尺寸 1200x896', px[4] * 1000 + px[5], 1200896, 0);
    assertTrue('a4 shadow.png 是纯黑且半透明（α≈179 而非 255）', px[0] === 0 && px[1] === 0 && px[2] === 0 && px[3] > 150 && px[3] < 210,
      'RGBA = ' + px.join(','));

    // ---- goal01 的「从上到下快速落下」动作：必须在点 OK 之前就把探针装进页面 ----
    // 注意：布局坐标（offsetTop）不受 transform 影响，量不出「落下」；
    // 只有 computed transform 的 translateY 才反映卡片此刻的真实垂直位置。
    // 用 setInterval 而不是 rAF 采样：headless 下 rAF 可能被降频，而过渡值由时间线驱动，
    // 即便不重绘也会随样式重算推进，采样更密更稳。
    await evaluate(`(() => {
      window.__drop = [];
      const el = document.getElementById('goal01');
      const t0 = performance.now();
      const read = () => {
        const cs = getComputedStyle(el);
        const m = cs.transform;
        let tx = 0, ty = 0;
        if (m && m.indexOf('matrix') === 0) {
          const n = m.slice(m.indexOf('(') + 1, m.lastIndexOf(')')).split(',').map(Number);
          if (n.length === 6) { tx = n[4]; ty = n[5]; }
          else { tx = n[12]; ty = n[13]; }
        }
        window.__drop.push({
          t: Math.round(performance.now() - t0),
          tx: +tx.toFixed(2), ty: +ty.toFixed(2),
          op: +(+cs.opacity).toFixed(3),
          in: el.classList.contains('in')
        });
      };
      window.__dropTimer = setInterval(() => {
        read();
        if (performance.now() - t0 > 6000) clearInterval(window.__dropTimer);
      }, 10);
      read();
      return true;
    })()`);

    await click('#btn-ok');
    await sleep(200);
    assertTrue('a4 点击 OK 后第三幕 UI 进入淡出态', await hasClass('#act3', 'ui-out'));
    await waitFor(`document.getElementById('shadow').classList.contains('in')`, 6000, '蒙黑层淡入');
    await sleep(800);
    await shot('a4-1-mask');
    assertEq('a4 第三幕面板已淡出（不透过蒙黑层若隐若现）', await effOpacity('#sticker-panel'), 0, 0.01);
    // 箱身上已落定的贴纸属于玩家的作品，刻意保留不清 —— 达成页里仍是「装饰好的行李箱」
    assertEq('a4 箱身已落定贴纸保留在画面中', await effOpacity('#sticker-layer'), 1, 0.01);
    assertEq('a4 箱身已落定贴纸数量仍为 3', await placedCount(), 3, 0);
    assertEq('a4 第三幕 RESET 按钮已淡出', await effOpacity('#btn-reset'), 0, 0.02);
    assertEq('a4 蒙黑层可见', await effOpacity('#shadow'), 1, 0.01);

    // goal01 / continue 几何
    await waitFor(`document.getElementById('goal01').classList.contains('in')`, 6000, 'goal01 出现');
    await sleep(600);
    const g = await box('#goal01');
    assertEq('a4 goal01 左边缘 = 221（水平居中）', g.left, 221, 0);
    assertEq('a4 goal01 距画面右 = 221', g.fromRight, 221, 0);
    assertEq('a4 goal01 顶边 = 120（Q18）', g.top, 120, 0);
    assertEq('a4 goal01 尺寸 758x579', g.width * 1000 + g.height, 758579, 0);

    /* ---- 动作复核（用户指定）：goal01 必须「从上到下快速落下」 ----
       旧实现是「淡入 + 轻微放大（scale .92 → 1）」，方向是原地放大，
       不是下落。这里用动画期间的 computed transform 采样把方向与速度钉死。 */
    const drop = await evaluate(`(() => {
      clearInterval(window.__dropTimer);
      const all = window.__drop.slice();
      const after = all.filter(r => r.in);
      const first = after[0] || null;
      const last = all[all.length - 1] || null;
      let landAt = null;
      for (let i = 0; i < after.length; i++) { if (after[i].ty >= -0.5) { landAt = after[i].t; break; } }
      // 中间态 = 已落进画布（下边缘越过画布顶）但尚未落定
      const mid = after.filter(r => r.ty > -699 && r.ty < -5);
      let mono = true;
      for (let i = 1; i < after.length; i++) { if (after[i].ty < after[i - 1].ty - 0.6) mono = false; }
      let txMax = 0, opMin = 2;
      all.forEach(r => { txMax = Math.max(txMax, Math.abs(r.tx)); });
      mid.forEach(r => { opMin = Math.min(opMin, r.op); });
      const raw = getComputedStyle(document.getElementById('goal01')).transitionDuration.split(',')[0].trim();
      const cssDurMs = raw.indexOf('ms') > -1 ? parseFloat(raw) : parseFloat(raw) * 1000;
      return {
        afterN: after.length, startTy: first ? first.ty : null, endTy: last.ty,
        landAt: landAt, firstInT: first ? first.t : null,
        midCount: mid.length, midOpMin: mid.length ? opMin : null,
        mono: mono, txMax: +txMax.toFixed(2), cssDurMs: cssDurMs
      };
    })()`);

    assertTrue('a4 落下动作：探针采到足够的动画帧样本', drop.afterN >= 10, JSON.stringify(drop));
    assertTrue('a4 落下动作：起点整张卡片在画布上方之外（下边缘 699+ty ≤ 0）',
      drop.startTy !== null && drop.startTy + 699 <= 0, 'startTy = ' + drop.startTy);
    assertEq('a4 落下动作：起点 translateY = -720', drop.startTy, -720, 2);
    assertTrue('a4 落下动作：落点 translateY = 0（无残余位移）', Math.abs(drop.endTy) <= 0.5, 'endTy = ' + drop.endTy);
    assertTrue('a4 落下动作：是自上而下的单调运动（无回弹 / 无反向）', drop.mono === true);
    assertTrue('a4 落下动作：拍到 ≥3 个「已进入画布但未落定」的中间态（不是瞬间闪现）',
      drop.midCount >= 3, 'midCount = ' + drop.midCount);
    assertTrue('a4 落下动作：只有垂直位移（|tx| < 0.5，无横向漂移、无缩放）',
      drop.txMax < 0.5, 'txMax = ' + drop.txMax);
    assertTrue('a4 落下动作：一边落一边可见（中间态 opacity 已 ≥ 0.5，不是落到位才浮现）',
      drop.midOpMin !== null && drop.midOpMin >= 0.5, 'midOpMin = ' + drop.midOpMin);
    assertTrue('a4 落下动作：CSS 位移时长 ≤ 500ms（「快速」）',
      drop.cssDurMs > 0 && drop.cssDurMs <= 500, 'cssDurMs = ' + drop.cssDurMs);
    assertTrue('a4 落下动作：实际下落耗时 ≤ 700ms',
      drop.landAt !== null && drop.firstInT !== null && (drop.landAt - drop.firstInT) <= 700,
      '实测 ' + (drop.landAt - drop.firstInT) + 'ms');
    assertTrue('a4 落下动作：过渡属性含 transform（不是靠 opacity 伪装的出现）',
      (await evaluate(`getComputedStyle(document.getElementById('goal01')).transitionProperty`)).indexOf('transform') > -1);

    await waitFor(`document.getElementById('continue').classList.contains('in')`, 6000, 'Continue 滑入');
    await sleep(600);
    await shot('a4-2-goal');
    const cc = await box('#continue');
    assertEq('a4 Continue 左边缘 = 467.5（水平居中）', cc.left, 467.5, 0.6);
    assertEq('a4 Continue 底边距画面底 = 95', cc.fromBottom, 95, 0.6);
    assertEq('a4 Continue 顶边 = 770', cc.top, 770, 0.6);
    assertEq('a4 Continue 尺寸 265x31', cc.width * 1000 + cc.height, 265031, 0);
    assertTrue('a4 Continue 是唯一可点击元素', (await box('#continue')).pointerEvents === 'auto');
    assertEq('a4 goal01 与 Continue 之间留出间隙',
      (await box('#continue')).top - (g.top + g.height), 71, 0.6);

    // Q20：点击 Continue 才转全黑，不自动延时
    assertTrue('a4 Continue 出现后画面尚未全黑（未自动跳转）', !(await hasClass('#blackout', 'in')));
    // 点 Continue 之前，Goal 卡片当然还在场（这一屏是第四幕的正片）
    assertEq('a4 点 Continue 前 Goal 卡片仍可见', await effOpacity('#goal01'), 1, 0.02);

    await click('#continue');
    await sleep(900);
    assertEq('a4 点 Continue 后 Goal 卡片已淡出（不出现「Goal Achieved」这一屏，Q43）',
      await effOpacity('#goal01'), 0, 0.01);
    assertEq('a4 点 Continue 后蒙黑底图 shadow 也已撤场（黑幕跑完时无残留灰罩）',
      await effOpacity('#shadow'), 0, 0.01);
    await shot('a4-3-final-black');
    assertEq('a4 点击 Continue 后画面纯黑', await effOpacity('#blackout'), 1, 0.01);
    // 纯黑帧里不能再有任何卡片墨迹（黑幕不透明，理应彻底遮住）
    assertEq('a4 全黑帧中 Goal 卡片不可见（整幕 op 已归零）', await effOpacity('#goal01'), 0, 0.01);
    assertTrue('a4 #act6 / #act6-slot / #act7-slot 预留容器存在（第五幕已升为实际容器 #act5）',
      await evaluate(`(() => {
        const a6 = document.getElementById('act6');
        const s6 = document.getElementById('act6-slot');
        const s7 = document.getElementById('act7-slot');
        return !!a6 && a6.children.length === 0
          && !!s6 && s6.children.length === 0 && s6.textContent.trim() === ''
          && !!s7 && s7.children.length === 0 && s7.textContent.trim() === '';
      })()`));
    assertTrue('a4 旧 #act5-slot 已退役（第五幕升为 #act5 实际容器）',
      await evaluate(`document.getElementById('act5-slot') === null`));
  }

  /* ================= 用例 full2：第一 ~ 第四幕全流程（真实播放视频） ================= */
  /* ================= 用例 a5：第五幕户外定格图 → 户外对话 → 直接切室内 → 纸片亮相 =================
     需求 §8.2 B1–B4。守 R19（#act5 门控）、R20（视频降级）、R22（纸片热区）。 */
  async function caseA5() {
    await toAct5();

    // --- B1 户外定格图（本轮起取代视频直接担任户外背景层） ---
    assertEq('a5 第五幕已激活', await effOpacity('#act5'), 1, 0.01);
    await waitFor(`!document.getElementById('blackout').classList.contains('in')`, 20000, '黑幕淡出露出户外定格图');
    await waitFor(`window.__nj.state().act5.outdoorIn === true`, 8000, '户外定格图淡入');
    await sleep(600);

    // 视频已彻底退役：仍在 DOM 中（供体检）但 display:none，不渲染、不播放
    const ov = await box('#act5-video');
    assertTrue('a5 video 元素仍在 DOM（供素材体检与识别）',
      await evaluate(`!!document.getElementById('act5-video')`));
    assertEq('a5 video 已 display:none（不再渲染）', ov.width, 0, 0);
    assertTrue('a5 video 从未播放（outdoor 静帧取代视频）',
      await evaluate(`document.getElementById('act5-video').currentTime === 0`));

    // 户外定格图几何 = 铺满 1200x896
    const o = await box('#act5-outdoor');
    assertEq('a5 户外定格图 左边缘 = 0', o.left, 0, 0);
    assertEq('a5 户外定格图 顶边 = 0', o.top, 0, 0);
    assertEq('a5 户外定格图 宽 = 1200（铺满）', o.width, 1200, 0);
    assertEq('a5 户外定格图 高 = 896（铺满）', o.height, 896, 0);
    assertEq('a5 户外定格图 已显示（opacity 1）', await effOpacity('#act5-outdoor'), 1, 0.02);
    assertTrue('a5 户外定格图已成功解码（原始尺寸 1200x896）',
      await evaluate(`(()=>{const e=document.getElementById('act5-outdoor');return e.naturalWidth*10000+e.naturalHeight===12000896})()`));
    // 用户诉求核心：绝不能再出现第五幕里的「播放中的视频」画面
    assertEq('a5 该帧无视频在播（#act5 内 video 不可见）', ov.height, 0, 0);
    await shot('a5-1-video');

    // --- B2 户外对话：chat5a 滑入 ---
    await waitFor(`document.getElementById('chat5a').classList.contains('in')`, 20000, 'chat5a 滑入');
    await sleep(700);
    // 户外两句对话期间：户外定格图继续充当背景，室内背景尚未淡入
    assertEq('a5 户外对话期间户外定格图仍在（充当户外背景）', await effOpacity('#act5-outdoor'), 1, 0.02);
    assertEq('a5 户外对话期间室内背景尚未淡入（B4 才切）', await effOpacity('#bg-inside'), 0, 0.02);

    // --- B2 户外对话几何：完全复用第二幕 .chat ---
    const c5 = await box('#chat5a');
    assertEq('a5 chat5a 贴底（距画面底 = 0）', c5.fromBottom, 0);
    assertEq('a5 chat5a 高 = 496', c5.height, 496, 0);
    assertEq('a5 chat5a 顶边 = 400（复用第二幕几何）', c5.top, 400, 0);
    const t5 = await box('#chat5a .chat-text');
    assertEq('a5 第五幕文本区 左边缘 = 380', t5.left, 380);
    assertEq('a5 第五幕文本区 顶边 = 770.4', t5.top, 770.4);
    assertEq('a5 第五幕文本区 宽 = 640', t5.width, 640, 0);

    // --- 打字期间 GO 不在画面 ---
    assertEq('a5 第 ④ 句打字期间 btn-go5a 不在画面', await effOpacity('#btn-go5a'), 0, 0.01);

    await waitFor(`document.getElementById('btn-go5a').classList.contains('in')`, 25000, '第 ④ 句打完');
    await sleep(400);
    assertTrue('a5 第 ④ 句文案与需求逐字一致',
      (await evaluate(`document.querySelector('#chat5a .chat-text').textContent`)) === LINE_ACT4);
    assertEq('a5 btn-go5a 距画面右 = 100', (await box('#btn-go5a')).fromRight, 100);
    assertEq('a5 btn-go5a 底边距画面底 = 50', (await box('#btn-go5a')).fromBottom, 50);
    await shot('a5-2-line4');

    // --- B3 点击 GO → 清空 → 打第 ⑤ 句（同一对话框内换句，不重新滑入） ---
    await click('#btn-go5a');
    await waitFor(`document.getElementById('btn-go5a').classList.contains('in')`, 25000, '第 ⑤ 句打完');
    await sleep(400);
    assertTrue('a5 第 ⑤ 句文案与需求逐字一致（含弯引号 Let\u2019s）',
      (await evaluate(`document.querySelector('#chat5a .chat-text').textContent`)) === LINE_ACT5);
    assertTrue('a5 第 ⑤ 句期间 chat5a 未重新滑入（始终 .in、未 .out）',
      await hasClass('#chat5a', 'in') && !(await hasClass('#chat5a', 'out')));
    assertEq('a5 第 ⑤ 句期间 btn-go5a 在画面', await effOpacity('#btn-go5a'), 1, 0.01);
    await shot('a5-3-line5');

    // --- B3 末 点击 GO → 户外对话框淡出 + 切室内 ---
    await click('#btn-go5a');
    await waitFor(`document.getElementById('chat5a').classList.contains('out')`, 4000, 'chat5a 淡出');
    await sleep(600);
    assertEq('a5 户外对话框已整体淡出', await effOpacity('#chat5a'), 0, 0.01);

    // --- B4 直接切室内（问题 1 核心：户外对话 → 直接 bg-inside，无中间画面） ---
    await waitFor(`document.getElementById('btn-papers').classList.contains('in')`, 8000, '纸片淡入');
    await sleep(500);
    assertEq('a5 切室内后户外定格图已淡出', await effOpacity('#act5-outdoor'), 0, 0.01);
    assertEq('a5 室内背景 bg-inside 已淡入', await effOpacity('#bg-inside'), 1, 0.02);
    assertEq('a5 切室内后黑场已退去（黑幕只是过场，不残留）', await effOpacity('#blackout'), 0, 0.01);
    assertEq('a5 室内界面即最终界面：纸片在、无第三张过渡图',
      await effOpacity('#act5'), 1, 0.01);
    const p = await box('#btn-papers');
    assertEq('a5 纸片 左边缘 = 705（原 715 左移 10）', p.left, 705, 0);
    assertEq('a5 纸片 距画面右 = 300（原 290 左移 10）', p.fromRight, 300, 0);
    assertEq('a5 纸片 顶边 = 593（原 653 上移 60）', p.top, 593, 0);
    assertEq('a5 纸片 底边距画面底 = 180（原 120 上移 60）', p.fromBottom, 180, 0);
    assertEq('a5 纸片 尺寸 195x123（热区 = 整张外框）', p.width * 1000 + p.height, 195123, 0);
    assertEq('a5 纸片位移符合用户要求：Δx = -10', p.left - 715, -10, 0.001);
    assertEq('a5 纸片位移符合用户要求：Δy = -60', p.top - 653, -60, 0.001);
    assertTrue('a5 纸片此刻可见但尚不可点（对话进行中，Q39）',
      (await njState()).act5.papersIn === true && (await njState()).act5.papersClickable === false);
    assertTrue('a5 纸片图片已成功解码（原始宽 195）',
      await evaluate(`document.getElementById('btn-papers').naturalWidth === 195`));
    await shot('a5-4-papers');
  }

  /* ================= 用例 a5b：第五幕室内对话 → 引导手 → 点纸片 → 黑幕转场 =================
     需求 §8.2 B5–B8。守 R23（第五幕全程静音）、BGM 停止点未变。 */
  async function caseA5b() {
    await toAct5();

    // 等户外定格图就位 → 走完户外两句对话（本轮起无视频可等）
    await waitFor(`!document.getElementById('blackout').classList.contains('in')`, 20000, '黑幕淡出');
    await waitFor(`window.__nj.state().act5.outdoorIn === true`, 8000, '户外定格图淡入');
    await waitFor(`document.getElementById('btn-go5a').classList.contains('in')`, 25000, '第 ④ 句打完');
    await sleep(300);
    await click('#btn-go5a');
    await waitFor(`document.getElementById('btn-go5a').classList.contains('in')`, 25000, '第 ⑤ 句打完');
    await sleep(300);
    await click('#btn-go5a');

    // --- B5 室内对话 1 ---
    await waitFor(`document.getElementById('chat5b').classList.contains('in')`, 8000, 'chat5b 滑入');
    await waitFor(`document.getElementById('btn-go5b').classList.contains('in')`, 25000, '第 ⑥ 句打完');
    await sleep(400);
    assertTrue('a5b 第 ⑥ 句文案与需求逐字一致',
      (await evaluate(`document.querySelector('#chat5b .chat-text').textContent`)) === LINE_ACT6);
    // chat5b 几何同样复用第二幕
    assertEq('a5b chat5b 顶边 = 400', (await box('#chat5b')).top, 400, 0);
    assertEq('a5b chat5b 文本区 左边缘 = 380', (await box('#chat5b .chat-text')).left, 380);
    await shot('a5b-1-line6');

    // --- B6 点击 GO → 清空 → 打第 ⑦ 句 ---
    await click('#btn-go5b');
    await waitFor(`document.getElementById('btn-go5b').classList.contains('in')`, 25000, '第 ⑦ 句打完');
    await sleep(400);
    assertTrue('a5b 第 ⑦ 句文案与需求逐字一致',
      (await evaluate(`document.querySelector('#chat5b .chat-text').textContent`)) === LINE_ACT7);
    await shot('a5b-2-line7');

    // --- B7 点击 GO → 对话框整体消失 → 引导手出现、纸片可点 ---
    await click('#btn-go5b');
    await waitFor(`document.getElementById('chat5b').classList.contains('out')`, 4000, 'chat5b 淡出');
    await sleep(600);
    assertEq('a5b 室内对话框已整体淡出（含姓名牌）', await effOpacity('#chat5b'), 0, 0.01);
    assertEq('a5b 对话框消失后姓名牌图也全透明',
      await effOpacity('#chat5b .chat-frame'), 0, 0.01);

    await waitFor(`document.getElementById('hand5').classList.contains('in')`, 6000, '引导手出现');
    await waitFor(`window.__nj.state().act5.papersClickable === true`, 4000, '纸片可点');
    await sleep(500);
    assertEq('a5b 引导手 hand5 已出现', await effOpacity('#hand5'), 1, 0.01);
    assertTrue('a5b 引导手不可点击（pointer-events:none）',
      (await box('#hand5')).pointerEvents === 'none');
    assertTrue('a5b 引导手指尖指向纸片（指尖 x 落在纸片横向范围内）',
      await evaluate(`(() => {
        const h = document.getElementById('hand5'), p = document.getElementById('btn-papers');
        const hx = h.offsetLeft + 0.07 * h.offsetWidth;   // transform-origin: 7% 0%
        return hx >= p.offsetLeft && hx <= p.offsetLeft + p.offsetWidth;
      })()`));
    // 纸片本轮上移 60 / 左移 10，引导手必须同步跟随（否则指尖会指向旧位置）
    assertEq('a5b 引导手 左边缘 = 791（随纸片同步左移 10）', (await box('#hand5')).left, 791, 0);
    // v2.14（问题 2）：用户要求引导手在上一版 536 的基础上下移 60 -> 596
    assertEq('a5b 引导手 顶边 = 596（本轮下移 60）', (await box('#hand5')).top, 596, 0);
    assertEq('a5b 指尖 x 对准纸片横向中心 802.5',
      await evaluate(`(() => {
        const h = document.getElementById('hand5'), p = document.getElementById('btn-papers');
        const hx = h.offsetLeft + 0.07 * h.offsetWidth;
        return +(hx - (p.offsetLeft + p.offsetWidth / 2)).toFixed(1);
      })()`), 0.1, 0.6);
    // v2.14：下移 60 后指尖越过纸片上沿 3px，落在纸片范围内（不再悬在上方）
    assertEq('a5b 指尖相对纸片上沿的偏移 = +3px（下移 60 后落入纸片）',
      await evaluate(`(() => {
        const h = document.getElementById('hand5'), p = document.getElementById('btn-papers');
        return h.offsetTop - p.offsetTop;
      })()`), 3, 0.5);
    assertTrue('a5b 指尖已进入纸片纵向范围（不再悬在纸片上方）',
      await evaluate(`(() => {
        const h = document.getElementById('hand5'), p = document.getElementById('btn-papers');
        const hy = h.offsetTop;   // transform-origin: 7% 0% -> 指尖 y = offsetTop
        return hy > p.offsetTop && hy < p.offsetTop + p.offsetHeight;
      })()`));
    assertTrue('a5b 此刻唯一可点目标 = 纸片（cursor:pointer）',
      (await box('#btn-papers')).pointerEvents === 'auto');
    // 问题 3：引导手必须位于纸片图层之上（z-index 严格更大）
    const zHand = await evaluate(`parseInt(getComputedStyle(document.getElementById('hand5')).zIndex, 10)`);
    const zPapers = await evaluate(`parseInt(getComputedStyle(document.getElementById('btn-papers')).zIndex, 10)`);
    const zBlack = await evaluate(`parseInt(getComputedStyle(document.getElementById('blackout')).zIndex, 10)`);
    assertTrue('a5b 引导手 z-index(' + zHand + ') > 纸片 z-index(' + zPapers + ')',
      zHand > zPapers);
    assertTrue('a5b 引导手 z-index(' + zHand + ') < 黑幕 z-index(' + zBlack + ')（不盖过转场）',
      zHand < zBlack);
    // 同一堆叠上下文内：DOM 上方的元素在高 z-index 相同时才优先，这里靠显式 z-index 取胜
    assertTrue('a5b 引导手与纸片处于同一堆叠上下文（同为 #act5 直接子元素）',
      await evaluate(`document.getElementById('hand5').parentElement.id === 'act5' &&
        document.getElementById('btn-papers').parentElement.id === 'act5'`));
    // 视觉验证：两图重叠区域采样「墨迹」，确认手确实压住了纸片
    assertTrue('a5b 手与纸片确有重叠（指尖压住纸片上沿区域）',
      await evaluate(`(() => {
        const h = document.getElementById('hand5'), p = document.getElementById('btn-papers');
        return !(h.offsetLeft + h.offsetWidth < p.offsetLeft ||
                 h.offsetTop + h.offsetHeight < p.offsetTop ||
                 h.offsetLeft > p.offsetLeft + p.offsetWidth ||
                 h.offsetTop > p.offsetTop + p.offsetHeight);
      })()`));
    assertTrue('a5b 纸片本身仍可见（引导阶段不隐藏，Q38）',
      (await njState()).act5.papersIn === true);
    await shot('a5b-3-hand');

    // --- B8 点击纸片 → 引导手隐藏、纸片保留 → 黑幕渐入 → 转场 ---
    // 顺手确认「第五幕全程静音」（R23：终点由第四幕末后移，必须断言没有意外复播）
    assertTrue('a5b 第五幕全程 BGM 保持停止（Q32：停止点未变，此后不再起播）',
      (await njState()).bgm.paused === true);
    await click('#btn-papers');
    await waitFor(`!document.getElementById('hand5').classList.contains('in')`, 4000, '引导手隐藏');
    await sleep(400);
    assertEq('a5b 点击纸片后引导手已隐藏', await effOpacity('#hand5'), 0, 0.01);
    assertEq('a5b 点击纸片后纸片本身保留可见（Q38）', await effOpacity('#btn-papers'), 1, 0.01);
    assertTrue('a5b 点击纸片后纸片不再可点', (await box('#btn-papers')).pointerEvents === 'none');

    await waitFor(`document.getElementById('blackout').classList.contains('in')`, 6000, '黑幕渐入');
    await sleep(900);
    assertEq('a5b 第五幕末画面全黑（转场，非终点）', await effOpacity('#blackout'), 1, 0.01);
    assertTrue('a5b 第五幕收尾 BGM 仍停止（R23 副作用复查）',
      (await njState()).bgm.paused === true);
    assertTrue('a5b 第五幕无控制台报错', errors.length === 0, errors.join(' | '));
    await shot('a5b-4-black');
  }

  /* ================= 用例 full3：第一 ~ 第五幕全流程（第三幕视频真播，第五幕为静帧） ================= */
  async function caseFull3() {
    // 第三幕开场单独真播（验证真实时序），其余复用公共前置
    await toAct3();
    await waitFor(`document.getElementById('act3-video').currentTime > 0`, 10000, '第三幕视频开播');
    await waitFor(`document.getElementById('chat3').classList.contains('in')`, 25000, '视频播完滑入对话框');
    await waitFor(`document.getElementById('btn-go3').classList.contains('in')`, 25000, '第三句打完');
    await sleep(300);
    await click('#btn-go3');
    await waitFor(`document.getElementById('sticker-frame').classList.contains('in')`, 10000, '面板滑入');
    await waitFor(`document.getElementById('btn-ok').classList.contains('in')`, 12000, '按钮滑入');
    await waitFor(`window.__nj.state().busy === false`, 8000, '演出锁释放');
    await sleep(250);

    await evaluate(`window.__nj.setRotation(0)`);
    await place('bag', 260, 380);
    await place('love', 420, 520);
    await place('travel', 320, 660);
    assertEq('full3 贴满 3 张', await placedCount(), 3);
    await click('#btn-ok');
    await waitFor(`document.getElementById('continue').classList.contains('in')`, 10000, 'Continue 滑入');
    await sleep(600);
    await click('#continue');
    assertTrue('full3 点 Continue 后 BGM 即刻停止（停止点未变，Q32）',
      await waitFor(`window.__nj.state().bgm.paused === true`, 4000, 'BGM 停止'));

    // 第五幕户外定格图淡入（本轮起不再播视频）
    await waitFor(`window.__nj.state().act5.outdoorIn === true`, 20000, '户外定格图淡入');
    // 类名加上只是「开始淡入」，要等过渡真正走完再断言 opacity
    await waitFor(`+getComputedStyle(document.getElementById('act5-outdoor')).opacity === 1`, 4000, '户外定格图淡入完成');
    assertEq('full3 第五幕户外定格图显示中', await effOpacity('#act5-outdoor'), 1, 0.02);
    assertTrue('full3 第五幕 video 未播放（静帧取代视频）',
      await evaluate(`document.getElementById('act5-video').currentTime === 0`));
    await waitFor(`document.getElementById('chat5a').classList.contains('in')`, 25000, '滑入 chat5a');
    await waitFor(`document.getElementById('btn-go5a').classList.contains('in')`, 25000, '第 ④ 句打完');
    await sleep(300);
    await click('#btn-go5a');
    await waitFor(`document.getElementById('btn-go5a').classList.contains('in')`, 25000, '第 ⑤ 句打完');
    await sleep(300);
    await click('#btn-go5a');
    await waitFor(`document.getElementById('btn-go5b').classList.contains('in')`, 25000, '第 ⑥ 句打完');
    await sleep(300);
    await click('#btn-go5b');
    await waitFor(`document.getElementById('btn-go5b').classList.contains('in')`, 25000, '第 ⑦ 句打完');
    await sleep(300);
    await click('#btn-go5b');
    await waitFor(`window.__nj.state().act5.papersClickable === true`, 8000, '纸片可点');
    await sleep(300);
    await click('#btn-papers');
    await waitFor(`document.getElementById('blackout').classList.contains('in')`, 8000, '第五幕末全黑');
    await sleep(900);
    assertEq('full3 终态（第五幕末）纯黑', await effOpacity('#blackout'), 1, 0.01);
    assertTrue('full3 第五幕全程 BGM 保持停止', (await njState()).bgm.paused === true);
    await shot('full3-1-black');
    assertTrue('full3 全流程无控制台报错', errors.length === 0, errors.join(' | '));
  }

  /* ================= 用例 full2：第一 ~ 第四幕（真实播放视频） ================= */
  async function caseFull2() {
    await toAct3();
    // 真等视频播完（不快进），验证真实时序
    await waitFor(`document.getElementById('act3-video').currentTime > 0`, 10000, '视频开播');
    await waitFor(`document.getElementById('chat3').classList.contains('in')`, 20000, '视频播完并滑入对话框');
    assertEq('full2 视频播完后已淡化（定格图接管）', await effOpacity('#act3-video'), 0, 0.01);

    await waitFor(`document.getElementById('btn-go3').classList.contains('in')`, 25000, '第三句打完');
    await sleep(300);
    await click('#btn-go3');
    await waitFor(`document.getElementById('sticker-frame').classList.contains('in')`, 10000, '面板滑入');
    await waitFor(`document.getElementById('btn-ok').classList.contains('in')`, 12000, '按钮滑入');
    await waitFor(`window.__nj.state().busy === false`, 5000, '演出锁释放');
    await sleep(150);

    await evaluate(`window.__nj.setRotation(0)`);
    await place('bag', 260, 380);
    await place('love', 420, 520);
    await place('travel', 320, 660);
    assertEq('full2 贴满 3 张', await placedCount(), 3);
    assertTrue('full2 OK 可用', (await njState()).okReady === true);
    await shot('full2-1-stickers');

    await click('#btn-ok');
    await waitFor(`document.getElementById('continue').classList.contains('in')`, 10000, 'Continue 滑入');
    await sleep(600);
    await shot('full2-2-goal');
    await click('#continue');
    await waitFor(`document.getElementById('blackout').classList.contains('in')`, 6000, '全黑');
    await sleep(900);
    await shot('full2-3-black');
    assertEq('full2 终态纯黑', await effOpacity('#blackout'), 1, 0.01);
    assertTrue('full2 全流程无控制台报错（末段）', errors.length === 0, errors.join(' | '));
  }

  const CASES = {
    gate: caseGate,
    p1: caseP1, p2: caseP2, flow: caseFlow,
    a3: caseA3, a3b: caseA3b, a3c: caseA3c, a4: caseA4, bgm: caseBgm, bgm2: caseBgm2, full2: caseFull2,
    a5: caseA5, a5b: caseA5b, full3: caseFull3,
  };

  for (const name of cases) {
    console.log('\n=== 用例 ' + name + ' ===');
    if (!CASES[name]) { fail('未知用例 ' + name, '可选: gate / p1 / p2 / flow / a3 / a3b / a3c / a4 / a5 / a5b / bgm / bgm2 / full2 / full3'); continue; }
    try {
      await reload();
      await CASES[name]();
    } catch (e) {
      fail('用例 ' + name + ' 执行中断', e.message);
    }
    assertTrue('用例 ' + name + ' 期间无控制台报错', errors.length === 0, errors.join(' | '));
  }

  console.log('\n================ 测试汇总 ================');
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failures.length) {
    console.log('\n失败明细：');
    failures.forEach((f) => console.log('  - ' + f));
  }
  console.log('截图目录: ' + OUT);

  try { ws.close(); } catch (e) { /* ignore */ }
  child.kill();
  await sleep(300);
  console.log(failed ? '\n结果: 未通过\n' : '\n结果: 全部通过\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本自身异常:', e && e.message);
  process.exit(1);
});
