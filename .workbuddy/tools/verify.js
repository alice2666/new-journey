/* 本地验收脚本：CDP 直连系统 Edge，跑完整流程并截图核对坐标。
   仅用于开发验收，不属于交付物。 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const PAGE = 'file:///E:/new-journey/index.html';
const OUT = path.join(__dirname, 'shots');
const PROFILE = path.join(os.tmpdir(), 'nj-cdp-profile');

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

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
        (this.handlers.get(m.method) || []).forEach(h => h(m.params));
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

(async () => {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    '--allow-file-access-from-files',
    '--window-size=1200,896',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank'
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
      target = list.find(t => t.type === 'page');
      if (target && target.webSocketDebuggerUrl) break;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!target) { console.error('无法连接 Edge 调试端口'); child.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new CDP(ws);

  const errors = [];
  cdp.on('Runtime.exceptionThrown', p => errors.push('EXCEPTION: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)));
  cdp.on('Runtime.consoleAPICalled', p => {
    if (p.type === 'error') errors.push('CONSOLE: ' + p.args.map(a => a.value || a.description).join(' '));
  });
  cdp.on('Log.entryAdded', p => { if (p.entry.level === 'error') errors.push('LOG: ' + p.entry.text); });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const waitFor = async (expr, timeout = 20000, label = expr) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await evaluate(expr)) return true;
      await sleep(80);
    }
    throw new Error('等待超时: ' + label);
  };

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  };

  const rectOf = (sel) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1),
             width: +r.width.toFixed(1), height: +r.height.toFixed(1),
             fromRight: +(1200 - r.right).toFixed(1), fromBottom: +(896 - r.bottom).toFixed(1),
             opacity: cs.opacity, pointerEvents: cs.pointerEvents, display: cs.display };
  })()`);

  const click = async (sel) => {
    const b = await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(sel)}); const r=el.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  };

  const report = [];
  const add = (k, v) => report.push(k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v));

  // ---------- 加载 ----------
  // 强制视口为精确 1200x896，使缩放比 = 1，getBoundingClientRect 可直接与文档坐标比对
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1200, height: 896, deviceScaleFactor: 1, mobile: false
  });
  await cdp.send('Page.navigate', { url: PAGE });
  await waitFor(`document.readyState === 'complete'`, 20000, 'readyState');
  await sleep(600);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1200, height: 896, deviceScaleFactor: 1, mobile: false
  });
  await sleep(300);

  add('viewport', await evaluate(`({ innerWidth, innerHeight, dpr: devicePixelRatio })`));
  add('stage 缩放', await evaluate(`getComputedStyle(document.getElementById('stage')).transform`));
  add('stage 内部坐标系(应为 1200x896)', await evaluate(`(()=>{const s=document.getElementById('stage');return s.offsetWidth+' x '+s.offsetHeight})()`));

  // ---------- 状态 1：第一幕 ----------
  await waitFor(`document.getElementById('btn-start').classList.contains('in')`, 20000, 'btn-start 出现');
  await sleep(500);
  await shot('1-act1-start');
  add('1) btn-start', await rectOf('#btn-start'));
  add('1) bg-start', await rectOf('#bg-start'));

  // 窗口缩放验证（趁第一幕可见时拍，截图才有信息量）
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await sleep(400);
  add('1b) 缩放@800x600 (应≈0.6667)', await evaluate(`getComputedStyle(document.getElementById('stage')).transform`));
  add('    该状态下 stage 内部坐标系(应仍为 1200x896)', await evaluate(`(()=>{const s=document.getElementById('stage');return s.offsetWidth+' x '+s.offsetHeight})()`));
  await shot('1b-act1-800x600');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await sleep(400);
  add('1c) 缩放@1600x1000 (应=1，不放大)', await evaluate(`getComputedStyle(document.getElementById('stage')).transform`));
  await shot('1c-act1-1600x1000');

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 896, deviceScaleFactor: 1, mobile: false });
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await sleep(400);
  add('1d) 恢复 1200x896', await evaluate(`getComputedStyle(document.getElementById('stage')).transform`));

  // ---------- 进入第二幕 ----------
  await click('#btn-start');

  // 打字进行中：GO 必须不存在
  await waitFor(`document.getElementById('chat').classList.contains('in')`, 10000, 'chat 滑入');
  await sleep(900);
  add('2) [打字中] btn-go 可见性', await evaluate(`(()=>{const e=document.getElementById('btn-go');const c=getComputedStyle(e);return {hasIn:e.classList.contains('in'), opacity:c.opacity, pointerEvents:c.pointerEvents}})()`));
  add('2) [打字中] chat-text 内容', await evaluate(`document.getElementById('chat-text').textContent`));
  await shot('2-act2-typing');

  // 第一句打完 -> GO 出现
  await waitFor(`document.getElementById('btn-go').classList.contains('in')`, 15000, '第1次 btn-go');
  await sleep(450);
  await shot('3-act2-line1');
  add('3) chat', await rectOf('#chat'));
  add('3) chat-text', await rectOf('#chat-text'));
  add('3) btn-go', await rectOf('#btn-go'));
  add('3) 第一句全文', await evaluate(`document.getElementById('chat-text').textContent`));

  // ---------- 第 1 次 GO ----------
  await click('#btn-go');
  await sleep(120);
  add('4) 点击后 chat-text 是否清空', await evaluate(`document.getElementById('chat-text').textContent === ''`));
  add('4) 点击后 btn-go 是否隐藏', await evaluate(`!document.getElementById('btn-go').classList.contains('in')`));

  // 行李箱出现 + 第二句打完
  await waitFor(`document.getElementById('suitcase').classList.contains('in')`, 10000, 'suitcase 出现');
  await waitFor(`document.getElementById('btn-go').classList.contains('in')`, 15000, '第2次 btn-go');
  await sleep(450);
  await shot('4-act2-line2');
  add('5) suitcase', await rectOf('#suitcase'));
  add('5) 第二句全文', await evaluate(`document.getElementById('chat-text').textContent`));

  // ---------- 第 2 次 GO ----------
  await click('#btn-go');
  await waitFor(`document.getElementById('hand').classList.contains('in')`, 10000, 'hand 出现');
  await sleep(500);
  await shot('5-act2-hand');
  add('6) hand', await rectOf('#hand'));
  add('6) btn-go 是否已隐藏', await evaluate(`!document.getElementById('btn-go').classList.contains('in')`));
  add('6) suitcase 可点击', await evaluate(`document.getElementById('suitcase').classList.contains('clickable')`));

  // ---------- 点击行李箱 ----------
  await click('#suitcase');
  await waitFor(`document.getElementById('blackout').classList.contains('in')`, 10000, 'blackout');
  await sleep(1000);
  await shot('6-black');
  add('7) blackout', await rectOf('#blackout'));
  add('7) act3-slot 是否为空', await evaluate(`document.getElementById('act3-slot').children.length === 0 && document.getElementById('act3-slot').textContent.trim() === ''`));

  // ---------- 复核 ----------
  add('console 错误', errors.length ? errors : '无');

  // 素材是否全部加载成功
  add('图片加载检查', await evaluate(`(()=>{const ids=['bg-start','btn-start','bg-room','chat-frame','btn-go','suitcase','hand'];const bad=ids.filter(id=>{const e=document.getElementById(id);return !e||!e.complete||e.naturalWidth===0});return bad.length?bad:'全部正常'})()`));

  console.log('\n================ 验收结果 ================');
  report.forEach(l => console.log(l));
  console.log('==========================================\n');
  console.log('截图目录:', OUT);

  try { ws.close(); } catch (e) {}
  child.kill();
  await sleep(300);
  process.exit(errors.length ? 2 : 0);
})().catch(async (e) => {
  console.error('验收脚本失败:', e.message);
  process.exit(1);
});
