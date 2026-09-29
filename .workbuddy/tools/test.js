/* New Journey 自动化测试（断言式，失败退出码 1）
 *
 * 用法：
 *   node .workbuddy/tools/test.js          跑全部用例
 *   node .workbuddy/tools/test.js p1       只跑「问题1：台词文本位置」
 *   node .workbuddy/tools/test.js p2       只跑「问题2：chat 消失 -> hand 出现」
 *   node .workbuddy/tools/test.js flow     只跑「全流程回归」
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
  const cases = which.length ? which : ['p1', 'p2', 'flow'];

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

  /* ================= 用例 p1：台词文本位置 =================
     需求：整体下移 50px（bottom 120 -> 70），且「只能在浅蓝色底板上，不能压倒其他物件」。
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
    assertEq('p1 第1句 左边缘距画面左 = 380', t1.left, 380);
    assertEq('p1 第1句 右边缘距画面右 = 180', t1.fromRight, 180);
    assertEq('p1 第1句 底边距画面底 = 70（由 120 下移 50px）', t1.fromBottom, 70);
    assertEq('p1 第1句 文本区宽度 = 640', t1.width, 640);
    assertEq('p1 第1句 右边缘绝对坐标 = 1020', t1.left + t1.width, 1020, 0);
    assertOnPanelOnly('p1 第1句', edgesOf(t1), +(t1.top + ink1.inkTopOffset).toFixed(2));

    // 第 2 句更长、行数可能不同，同一组约束必须依然成立（底边用 bottom 锚定，与行数无关）
    await clickAndWaitHide('#btn-go');
    await waitFor(`document.getElementById('btn-go').classList.contains('in')`, 25000, '第 2 句打完');
    await sleep(400);
    await shot('p1-2-line2');

    assertEq('p1 第2句 文案与需求一致', await textOf('#chat-text') === LINE2 ? 1 : 0, 1, 0);

    const t2 = await box('#chat-text');
    const ink2 = await inkOf('#chat-text');
    assertEq('p1 第2句 左边缘距画面左 = 380', t2.left, 380);
    assertEq('p1 第2句 右边缘距画面右 = 180', t2.fromRight, 180);
    assertEq('p1 第2句 底边距画面底 = 70（由 120 下移 50px）', t2.fromBottom, 70);
    assertEq('p1 第2句 文本区宽度 = 640', t2.width, 640);
    assertEq('p1 第2句 文本区高度（2 行，随行数自适应）', t2.height, 76, 3);
    assertOnPanelOnly('p1 第2句', edgesOf(t2), +(t2.top + ink2.inkTopOffset).toFixed(2));
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
    assertEq('flow 台词文本 底边距画面底 = 120', (await box('#chat-text')).fromBottom, 120);

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

  const CASES = { p1: caseP1, p2: caseP2, flow: caseFlow };

  for (const name of cases) {
    console.log('\n=== 用例 ' + name + ' ===');
    if (!CASES[name]) { fail('未知用例 ' + name, '可选: p1 / p2 / flow'); continue; }
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
