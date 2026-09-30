/* 临时验证：① 正常启动不受影响 ② 兜底提示能正确触发 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9335;
const PAGE = 'file:///E:/new-journey/index.html';
const PROFILE = path.join(os.tmpdir(), 'nj-diag2-profile');
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
      } else if (m.method) (this.handlers.get(m.method) || []).forEach((h) => h(m.params));
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, h) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(h); }
}

let passed = 0, failed = 0;
const chk = (name, cond, extra) => {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
};

(async () => {
  const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, '--no-first-run', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 60; i++) { try { ver = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); break; } catch (e) { await sleep(250); } }
  const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new CDP(ws);
  const logs = [];
  cdp.on('Log.entryAdded', (p) => logs.push('[' + p.entry.level + '] ' + p.entry.text));
  cdp.on('Runtime.exceptionThrown', (p) => logs.push('[EXCEPTION] ' + (p.exceptionDetails.exception?.description || p.exceptionDetails.text)));
  cdp.on('Runtime.consoleAPICalled', (p) => logs.push('[console.' + p.type + '] ' + p.args.map((a) => a.value ?? a.description).join(' ')));
  await cdp.send('Log.enable'); await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  const ev = async (e) => (await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.value;

  /* ---- 场景 A：正常启动 ---- */
  console.log('\n【场景 A】正常启动（视口 1400×1000）');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(2500);
  chk('无控制台报错', logs.length === 0, logs.join(' | '));
  chk('#fallback 保持隐藏', (await ev("document.getElementById('fallback').hidden")) === true);
  chk('第一幕背景已淡入', (await ev("document.getElementById('bg-start').classList.contains('in')")) === true);
  chk('START 按钮已淡入且可点', (await ev("getComputedStyle(document.getElementById('btn-start')).pointerEvents")) === 'auto');
  chk('看门狗已撤销 (booted=true)', (await ev('window.__nj.state().booted')) === true);
  chk('state() 未标记 fallbackShown', (await ev('window.__nj.state().fallbackShown')) === false);
  chk('缩放比 = 1（窗口大于画布不放大）', (await ev("getComputedStyle(document.getElementById('stage')).transform")) === 'matrix(1, 0, 0, 1, 0, 0)');

  /* ---- 场景 B：小窗口 ---- */
  console.log('\n【场景 B】小窗口 900×672（应缩放 0.75）');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 672, deviceScaleFactor: 1, mobile: false });
  await ev("window.dispatchEvent(new Event('resize'))");
  await sleep(300);
  const tf = await ev("getComputedStyle(document.getElementById('stage')).transform");
  chk('缩放比 ≈ 0.75', /matrix\(0\.75/.test(tf), tf);

  /* ---- 场景 D：素材 404 —— 脚本正常跑、类名也加了，但图出不来 ---- */
  console.log('\n【场景 D】模拟素材 404：屏蔽 assets/screen1/*（脚本正常但画面全黑）');
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*assets/screen1/*'] });
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(7500);   // 等 6s 看门狗
  const dDetail = String(await ev("document.getElementById('fb-detail').textContent"));
  chk('兜底提示已显示', (await ev("document.getElementById('fallback').hidden")) === false);
  chk('标题为「素材未能加载」', (await ev("document.getElementById('fb-title').textContent")) === '素材未能加载');
  chk('列出了失败素材路径', /bg-start\.png/.test(dDetail), dDetail.slice(0, 80));
  chk('提示了目录同级要求', /assets\//.test(dDetail));
  chk('此时流程其实「已启动」（证明单查 booted 不够）', (await ev('window.__nj.state().booted')) === true);
  await cdp.send('Network.setBlockedURLs', { urls: [] });

  /* ---- 场景 C：模拟旧浏览器（移除 Promise）。
         注意：addScriptToEvaluateOnNewDocument 不可撤销，故必须排在最后。 ---- */
  console.log('\n【场景 C】模拟旧引擎：删除 Promise 后加载');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { Object.defineProperty(window, 'Promise', { get: function () { return undefined; }, configurable: true }); } catch (e) {}"
  });
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(2000);
  chk('兜底提示已显示', (await ev("document.getElementById('fallback').hidden")) === false);
  chk('标题为「浏览器版本过旧」', (await ev("document.getElementById('fb-title').textContent")) === '浏览器版本过旧');
  chk('明确列出缺失能力 Promise', /Promise/.test(String(await ev("document.getElementById('fb-missing').textContent"))));
  chk('已填出浏览器标识', String(await ev("document.getElementById('fb-ua').textContent")).length > 10);
  chk('已填出窗口尺寸', /×/.test(String(await ev("document.getElementById('fb-size').textContent"))));
  chk('第一幕确实没渲染（正是用户看到的现象）', (await ev("document.getElementById('bg-start').classList.contains('in')")) === false);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const outDir = path.join(__dirname, 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'fallback-notice.png'), Buffer.from(shot.data, 'base64'));
  console.log('  \u2713 截图已保存 shots/fallback-notice.png');

  console.log('\n=== 结果: 通过 ' + passed + ' 项, 失败 ' + failed + ' 项 ===');
  ws.close(); proc.kill();
  process.exit(failed ? 1 : 0);
})();
