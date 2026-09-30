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
 *   node .workbuddy/tools/test.js a4       第四幕：蒙黑 -> Goal -> Continue -> 全黑
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
  const cases = which.length ? which : ['gate', 'p1', 'p2', 'flow', 'a3', 'a3b', 'a3c', 'a4', 'full2'];

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
      const ids = ['act1', 'act2', 'act3', 'act4', 'bg-room-suitcase', 'shadow'];
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
    assertEq('gate 载入时第三幕定格图不可见（它是常驻可见元素，最易漏）', s1['bg-room-suitcase'], 0, 0.01);
    await shot('gate-1-act1-start');

    // ② 第二幕进行中：第一幕退场、第三幕仍不可见
    await toAct2SecondLine();
    const s2 = await snap();
    assertEq('gate 第二幕时第一幕已退场', s2.act1, 0, 0.01);
    assertEq('gate 第二幕时第二幕可见', s2.act2, 1, 0.01);
    assertEq('gate 第二幕时第三幕仍不可见', s2.act3, 0, 0.01);
    assertEq('gate 第二幕时第四幕仍不可见', s2.act4, 0, 0.01);
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

  // 在「画布坐标」处点击：先把画布坐标换算成视口坐标，再派发真实鼠标事件。
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
    assertEq('a3 面板入场完成后 11 张贴纸全部可见',
      await evaluate(`document.querySelectorAll('#sticker-panel .palette.in').length`), 11, 0);
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

    // --- 11 张贴纸逐格对位（列 690/847/1004 × 行 91/225/361/495，第 12 格留空） ---
    const EXP = [
      ['bag', 690, 91], ['camera', 847, 91], ['drink', 1004, 91],
      ['flower', 690, 225], ['love', 847, 225], ['mountant', 1004, 225],
      ['passport', 690, 361], ['planet', 847, 361], ['rainboat', 1004, 361],
      ['travel', 690, 495], ['tree', 847, 495],
    ];
    assertEq('a3b 调色板贴纸数量 = 11', await evaluate(`document.querySelectorAll('#sticker-panel .palette').length`), 11, 0);
    for (const [key, x, y] of EXP) {
      const b = await box(paletteSel(key));
      assertEq(`a3b ${key} 槽位 left=${x} / top=${y}`, b.left * 100000 + b.top, x * 100000 + y, 0);
      assertEq(`a3b ${key} 尺寸 142x119`, b.width * 1000 + b.height, 142119, 0);
      assertEq(`a3b ${key} 可见`, await effOpacity(paletteSel(key)), 1, 0.01);
    }
    // 第 4 行第 3 格（1004, 495）必须留空
    assertEq('a3b 第 12 格（1004,495）留空无贴纸',
      await evaluate(`(() => {
        const hit = [].filter.call(document.querySelectorAll('#sticker-panel .palette'), (el) =>
          parseFloat(el.style.left) === 1004 && parseFloat(el.style.top) === 495);
        return hit.length;
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

    // --- ④ 自由落点：换不同位置再贴 2 张，凑满 3 张 ---
    await place('camera', 220, 300);
    await place('drink', 480, 700);
    centers = await placedCenters();
    assertEq('a3c 三张贴纸数量', centers.length, 3, 0);
    assertEq('a3c 第 2 张贴纸落点自由（220,300）', centers[1].cx * 1000 + centers[1].cy, 220300, 0.6);
    assertEq('a3c 第 3 张贴纸落点自由（480,700）', centers[2].cx * 1000 + centers[2].cy, 480700, 0.6);
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

    // 贴纸框右边缘外 1px 也属于「箱身之外」
    await click(paletteSel('flower'));
    await sleep(200);
    await clickCanvas(537, 500);
    await sleep(400);
    assertEq('a3c 箱身右边界外 1px -> 不落定', await placedCount(), 3);
    assertEq('a3c 箱身右边界外 1px -> 不计数', (await njState()).count, 3);

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

    // --- ⑧ 缩放补偿专项：s = 0.75 下落点仍精确落在鼠标所指处 ---
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
    assertEq('a3c RESET 后调色板 11 张全部恢复', await usedPalettes(), 0);
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
    await click('#continue');
    await waitFor(`document.getElementById('blackout').classList.contains('in')`, 6000, '全黑');
    await sleep(900);
    await shot('a4-3-final-black');
    assertEq('a4 点击 Continue 后画面纯黑', await effOpacity('#blackout'), 1, 0.01);
    assertTrue('a4 #act5-slot 预留容器存在且为空',
      await evaluate(`(() => { const s = document.getElementById('act5-slot');
        return !!s && s.children.length === 0 && s.textContent.trim() === ''; })()`));
  }

  /* ================= 用例 full2：第一 ~ 第四幕全流程（真实播放视频） ================= */
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
    a3: caseA3, a3b: caseA3b, a3c: caseA3c, a4: caseA4, full2: caseFull2,
  };

  for (const name of cases) {
    console.log('\n=== 用例 ' + name + ' ===');
    if (!CASES[name]) { fail('未知用例 ' + name, '可选: gate / p1 / p2 / flow / a3 / a3b / a3c / a4 / full2'); continue; }
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
