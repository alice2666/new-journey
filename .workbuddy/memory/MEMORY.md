# New Journey 项目长期约定

## 项目本体

- 单文件纯静态叙事小游戏，交付物只有 `E:\new-journey\index.html`（原生 HTML/CSS/JS，零依赖、零构建、零网络请求，双击即用）。
- 画布固定 **1200×896**，内部坐标永不变；窗口小于画布时由 `#stage` 的 `transform: scale()` 等比缩放（上限 1，不放大）。
- 素材全部在 `assets/screen1..4`，路径统一用**正斜杠**（`file://` 双击可用）。

## 文档分工（重要）

- `docs/01-需求文档.md` —— 写**做成什么样**（流程、坐标、验收标准、待确认项 Q 系列）。
- `docs/02-开发计划.md` —— 写**怎么做**（实现方案、里程碑 M 系列、风险 R 系列、测试）。
- 两份文档**不重复数值**：开发计划凡涉及具体数值都标注需求文档章节号。修改任一份后必须检查另一份是否需同步。

## 协作流程

- 用户的工作节奏是**分轮推进**：先给一段需求描述 → 要求「整理需求 / 更新文档」→ **明确说「不要开发」时不写代码** → 逐轮回答待确认项（每轮只答复 1–3 个问题）→ 最后才说「开工」。
- 每轮文档改动后：追加工作日志到 `.workbuddy/memory/YYYY-MM-DD.md`，并用 `present_files` 给出文档预览。

## 测试约定

- 验收脚本：`.workbuddy/tools/test.js`（CDP 直连系统 Edge，零安装）。用例可按名单独跑：`node test.js a3c`。
- 启动兜底回归：`.workbuddy/tools/boot-check.js`（**4 场景 19 项**）。场景 C 用 `Page.addScriptToEvaluateOnNewDocument` 抹掉 `Promise` 模拟旧引擎（**注入不可撤销，必须排最后**），场景 D 用 `Network.setBlockedURLs` 模拟素材 404。
- 断言前必须把视口钉成 **1200×896** 使 `s = 1`，否则量到的是缩放后的值。
- 几何断言统一读**布局坐标**（`offsetParent` 链累加 `offsetLeft/offsetTop`），不要用 `getBoundingClientRect()`（会被动画 transform 污染）。
- 判「有没有压倒物件」看**墨迹**不看行盒（用 canvas `measureText` 的 `actualBoundingBoxAscent`）。
- **等应用内的锁、不要猜 sleep**：入场类名 `.in` 出现的瞬间动画才开始、`busy` 锁未释放，此时点击会被吞。用 `waitFor(window.__nj.state().busy === false)`。
- 页面暴露只读调试钩子 `window.__nj`（`setRotation` / `body` / `state()`）供测试使用，对产品表现零影响；`state()` 含 `count/okReady/placing/act3Done/busy/animLock`。
- **`gate` 用例（v2.3 起）专测「整幕可见性」**：沿祖先链累乘 `opacity`，断言任一时刻只有当前幕整体可见。**`document.elementFromPoint` 测不出这类问题** —— 未激活幕设了 `pointer-events:none`，命中测试会跳过它、返回下面那一层，看起来「一切正常」。
- **判两张截图是否同一画面，要看构图特征**（有无某个物件、元素的归一化位置），**不要只看平均像素差** —— 截图工具的色彩配置差异会让「同一张图」也有 ~40/765 的平均差、19% 像素差 >60。
- 用 CDP 派发鼠标事件时，画布坐标要换算成视口坐标（`rect.left + cx * s`）再发三连事件。
- 像素级结论（素材是否半透明等）用页面内 canvas + `getImageData` 断言，需要 `--allow-file-access-from-files`。

## 实现约定

- **分幕预加载**：首屏只加载第一、二幕；`<video>` 的 `src` 由 JS 在幕间注入（HTML 用 `preload="none"` 且不带 src），避免 4.54MB 视频拖慢开场。
- **锁模型三层**：`busy`（演出，动画/打字期间屏蔽一切点击）/ `animLock`（贴纸落定·飞回 250ms，只锁贴纸）/ `placing`（待放置标志）。进入事件驱动的玩法循环前必须把 `busy` 置回 `false`。
- **层叠模型**：场景用 wrapper（`#act1` auto / `#act2` 2 / `#act3` 3 / `#act4` 4 / `#blackout` 100 / slot 110），wrapper 内再按相对 z-index 排。`#blackout.guard` = 透明但仍拦截点击。
- **幕的显隐门控（硬约束，勿违反）**：**任一时刻只能有一幕整体可见**。每个 `.scene` 容器必须自带 `opacity:0` + 一个激活类，否则该幕里**任何常驻可见的元素**都会连同它的 `z-index` 一起盖住当前幕。现状：`#act1` 初始就可见（`opacity:1`）；`#act2` 加 `.in`；`#act3`/`#act4` 加 `.active`。**新增幕时务必补门控并让 `gate` 用例覆盖。**（v2.3 修复的 D4：`#act3` 漏门控 → 定格图 `#bg-room-suitcase` 从载入第一帧起盖住第一、二幕 → 玩家看到「一打开就是行李箱房间、看不到开始界面、画面不动」，而当时 241 项断言全绿 —— 因为被遮住的那些元素自身的类名/opacity/坐标**全都是对的**。）
- `#chat` 系列样式抽为 `.chat/.chat-frame/.chat-text` 公共类，**id 保留**（测试依赖）。
- **浏览器最低要求**：Chrome 41+ / Edge 15+ / Firefox 44+（依赖 `Promise`、`classList`、`requestAnimationFrame`、`Element.closest`）。脚本保持 **ES5 写法**（不用 `let`/`const`、箭头函数、模板字面量、`?.`、`await`），兼容性风险只可能来自运行时能力 —— **新增运行时依赖时务必同步加进页面内的能力自检**。IE11 缺 `Promise` 与 `Element.closest`，必然黑屏。
- **启动健壮性（v2.2 起）**：本页所有元素默认 `opacity:0`、靠脚本加 `.in` 才显示，所以「脚本没跑起来 = 全黑 + 点不动 + 零提示」，是最难排查的状态。页面内已建四层兜底（`<noscript>` / 引擎能力自检 / 6s 启动看门狗 / `main().catch` 与启动 `try` 的 `reportFailure()` 可见报错）。**改动第一幕路径时，务必确认不会引入新的静默失败点**；不要用裸 `console.error` 吞掉致命错误。
- **排障顺序**（用户报「黑屏/点不动」时）：① **先认画面** —— 拿用户截图与 `assets/` 逐一比对，确定它到底停在哪一幕（看构图特征，别只看像素差）；② 看兜底面板上的缺失能力与打开方式；③ 若**没有**兜底面板、脚本显然在跑，就查**幕的显隐门控**（这就是 D4 那类 bug，且断言全绿）；④ 核对资源路径大小写（Windows 本地不区分、换 HTTP 服务就 404）；⑤ 用探针开 **Network 域 `loadingFailed`**（`Log.entryAdded` 不给 URL）。

## Git

- 仓库**保持无远程**（不推送）。
- 修复类改动每完成一项提交一次。
