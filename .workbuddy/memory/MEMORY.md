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
- 断言前必须把视口钉成 **1200×896** 使 `s = 1`，否则量到的是缩放后的值。
- 几何断言统一读**布局坐标**（`offsetParent` 链累加 `offsetLeft/offsetTop`），不要用 `getBoundingClientRect()`（会被动画 transform 污染）。
- 判「有没有压倒物件」看**墨迹**不看行盒（用 canvas `measureText` 的 `actualBoundingBoxAscent`）。
- **等应用内的锁、不要猜 sleep**：入场类名 `.in` 出现的瞬间动画才开始、`busy` 锁未释放，此时点击会被吞。用 `waitFor(window.__nj.state().busy === false)`。
- 页面暴露只读调试钩子 `window.__nj`（`setRotation` / `body` / `state()`）供测试使用，对产品表现零影响；`state()` 含 `count/okReady/placing/act3Done/busy/animLock`。
- 用 CDP 派发鼠标事件时，画布坐标要换算成视口坐标（`rect.left + cx * s`）再发三连事件。
- 像素级结论（素材是否半透明等）用页面内 canvas + `getImageData` 断言，需要 `--allow-file-access-from-files`。

## 实现约定

- **分幕预加载**：首屏只加载第一、二幕；`<video>` 的 `src` 由 JS 在幕间注入（HTML 用 `preload="none"` 且不带 src），避免 4.54MB 视频拖慢开场。
- **锁模型三层**：`busy`（演出，动画/打字期间屏蔽一切点击）/ `animLock`（贴纸落定·飞回 250ms，只锁贴纸）/ `placing`（待放置标志）。进入事件驱动的玩法循环前必须把 `busy` 置回 `false`。
- **层叠模型**：场景用 wrapper（`#act1` auto / `#act2` 2 / `#act3` 3 / `#act4` 4 / `#blackout` 100 / slot 110），wrapper 内再按相对 z-index 排。`#blackout.guard` = 透明但仍拦截点击。
- `#chat` 系列样式抽为 `.chat/.chat-frame/.chat-text` 公共类，**id 保留**（测试依赖）。

## Git

- 仓库**保持无远程**（不推送）。
- 修复类改动每完成一项提交一次。
