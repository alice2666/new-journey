/* 可行性探针：第五幕第二段 BGM（audio/music-ancient-s.wav）
 *
 * ⚠️ 与 test.js 的关键区别：**不传** `--autoplay-policy=no-user-gesture-required`，
 *    使用浏览器的**默认**自动播放策略（document-user-activation-required），
 *    这样测出来的「能不能播」才是真实用户看到的行为。
 *
 * 验证三件事：
 *   A. 无任何用户手势时 —— 文件能否被解码（duration/readyState）、play() 是否被拒
 *   B. 点击 START（真实用户手势）之后 —— play() 是否被允许
 *   C. 手势之后过 1.5s（模拟「幕间异步链里起播」，非直接响应手势）—— 是否仍被允许
 *
 * 退出码：0 = 三阶段均按预期；1 = 出现非预期结果
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9344;
const PAGE = 'file:///E:/new-journey/index.html';
const PROFILE = path.join(os.tmpdir(), 'nj-probe-bgm2');
const SRC = 'audio/music-ancient-s.wav';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

(async () => {
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--window-size=1200,896',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.find((t) => t.type === 'page');
      if (target && target.webSocketDebuggerUrl) break;
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  if (!target) { console.error('无法连接 Edge'); child.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const cdp = new CDP(ws);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 896, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(2500);

  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const click = async (sel) => {
    const b = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
  };

  const results = {};

  /* ---------- 0. 浏览器实际生效的自动播放策略 ---------- */
  // 页面未提供该值时，以「A 阶段是否被拒」反推
  results.hasUserActivation0 = await evaluate(`navigator.userActivation
    ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
    : null`);

  /* ---------- A. 无手势：解码 + play() ---------- */
  const decodeA = await evaluate(`new Promise((res) => {
    const a = new Audio(${JSON.stringify(SRC)});
    a.preload = 'auto'; a.load();
    window.__pa = a;
    const done = () => res({ duration: a.duration, readyState: a.readyState, networkState: a.networkState, err: a.error ? a.error.code : null });
    if (a.readyState >= 3) return done();
    a.addEventListener('canplaythrough', done, { once: true });
    a.addEventListener('error', done, { once: true });
    setTimeout(done, 8000);
  })`);
  const playA = await evaluate(`(async () => {
    const a = window.__pa;
    try { await a.play(); return { ok: true, paused: a.paused }; }
    catch (e) { return { ok: false, name: e.name, msg: String(e.message).slice(0, 120) }; }
  })()`);
  results.A = { decode: decodeA, play: playA };

  /* ---------- B. 点击 START（真实手势）后 play() ---------- */
  await evaluate(`window.__nj && window.__nj.state ? true : true`);
  await click('#btn-start').catch(() => {});
  await sleep(600);
  results.afterStart = await evaluate(`navigator.userActivation
    ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
    : null`);
  const playB = await evaluate(`(async () => {
    const a = new Audio(${JSON.stringify(SRC)});
    a.preload = 'auto'; a.volume = 0.35; a.loop = true; a.load();
    window.__pb = a;
    try { await a.play(); 
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, paused: a.paused, currentTime: +a.currentTime.toFixed(3), volume: a.volume, loop: a.loop, duration: a.duration };
    } catch (e) { return { ok: false, name: e.name, msg: String(e.message).slice(0, 120) }; }
  })()`);
  results.B = playB;
  await evaluate(`try { window.__pb.pause(); } catch (e) {} true`);

  /* ---------- C. 手势之后 1.5 s（模拟幕间异步链）再 play() ---------- */
  const playC = await evaluate(`(async () => {
    await new Promise((r) => setTimeout(r, 1500));      // 离开手势处理链
    const a = new Audio(${JSON.stringify(SRC)});
    a.preload = 'auto'; a.volume = 0.35; a.loop = true; a.load();
    window.__pc = a;
    try { await a.play();
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, paused: a.paused, currentTime: +a.currentTime.toFixed(3) };
    } catch (e) { return { ok: false, name: e.name, msg: String(e.message).slice(0, 120) }; }
  })()`);
  results.C = playC;
  await evaluate(`try { window.__pc.pause(); } catch (e) {} true`);

  /* ---------- D. 两条 BGM 同时存在（新实例不影响旧实例） ---------- */
  results.D = await evaluate(`(() => {
    const st = window.__nj.state();
    return { bgmSrc: String(st.bgm.src).split('/').pop(), bgmPaused: st.bgm.paused, bgmWanted: st.bgm.wanted };
  })()`);

  console.log('\n===== 可行性探针结果 =====');
  console.log('0) 初始 userActivation :', JSON.stringify(results.hasUserActivation0));
  console.log('A) 无手势 解码        :', JSON.stringify(results.A.decode));
  console.log('A) 无手势 play()      :', JSON.stringify(results.A.play));
  console.log('B) 点 START 后 activation:', JSON.stringify(results.afterStart));
  console.log('B) 手势后 play()      :', JSON.stringify(results.B));
  console.log('C) 手势后 1.5s play()  :', JSON.stringify(results.C));
  console.log('D) 旧实例不受影响      :', JSON.stringify(results.D));

  const decodeOk = results.A.decode.duration > 29 && results.A.decode.duration < 31 && results.A.decode.err === null;
  const bOk = results.B.ok === true;
  const cOk = results.C.ok === true;
  console.log('\n结论: 解码=' + (decodeOk ? 'OK' : 'FAIL') +
    '  手势后起播=' + (bOk ? 'OK' : 'FAIL') +
    '  手势后延迟起播=' + (cOk ? 'OK' : 'FAIL') +
    '  无手势起播=' + (results.A.play.ok ? '被允许（本机策略宽松）' : '被拒（' + results.A.play.name + '）'));

  ws.close();
  child.kill();
  process.exit(decodeOk && bOk && cOk ? 0 : 1);
})();
