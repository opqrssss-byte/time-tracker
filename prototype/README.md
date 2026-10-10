# 手机端"拖环旋转"交互原型

> 用途：验证手机端该怎么做时间追踪的**分类切换** —— 在真机/浏览器上摸手感，拍板后再落进 `miniprogram/`。
> 同时它是**参考实现**：几何与手势数学已经是可搬迁的形态（见文末映射清单）。
> 这是开发工具，不是产品文件，**不参与发布**。

## 跑起来

```bash
python -m http.server 8899          # 在仓库根目录执行（脚本相对路径要用）
# 浏览器（桌面调试）：http://localhost:8899/prototype/index.html
# 真机（同一网络）：http://<电脑局域网IP>:8899/prototype/index.html
```

- 桌面浏览器里会自动收成一个 375×812 的手机框，方便截图评审；真机上铺满全屏。
- Windows 上手机访问不了多半是防火墙拦了入站 8899（首次监听时会弹授权框）。
- 右下角「手感调试」里所有参数**改完立即生效**，用来自摸手感；`重置参数` 回到默认。

## 这一版的核心判断

桌面的"旋转表圈"输入源是滚轮。手机没有滚轮，但手机有滚轮没有的东西：**松手事件**。
所以桌面用来兜底的"停顿 900ms 自动确认"在手机上应当退役，改成**拖到哪、松手就是哪**：

| | 桌面 | 手机（本原型） |
|---|---|---|
| 移动选中 | 滚轮（累积 100px 走一格） | 绕圆心拖动（累积 **40°** 走一格） |
| 确认 | 停 900ms 或 点击 | **松手** 或 轻点扇区 |
| 取消 | Esc | 拖不足一格就松手 / touchcancel |
| 停止 | 有（边缘操作） | **没有**（贴合 24h 连续记录的产品终局） |

好处：既保住桌面那层"先选定再提交"的防误触，又比桌面少一步等待。

## 手势状态机

```
IDLE ──按下(盘内)──► PRESSED ──跨过 STEP_DEG──► DRAGGING
                       │                          │
                       ├─位移<容差且够快，抬起─► TAP：立即确认按下点所在扇区
                       ├─容差≤位移<一格，抬起─► ABORT：不提交，回到按下前的选中态
                       └────────────────────────┴─抬起─► 提交当前选中（松手即确认）
```

取数规则（`stepId`）**逐行移植桌面的 `stepFocus`**：已选中则沿环走一格、首尾循环；
还没选中时，若正在计时就从**它的下一格**起跳，否则从 12 点（顺时针）/末段（逆时针）进入。

确认语义（`commit`）：空闲 → 开始；不同 → 原子切换（旧段计入今日累计）；**与运行中相同 → 无操作**（防误停，镜像桌面 `viaWheel`）。

## 参数表

| 参数 | 默认 | 含义 |
|---|---|---|
| `scale` | 1.6 | 几何总缩放：桌面常量（R=54/SW=11/gap=4/盘=152）× scale |
| `ringCy` | 330 | 环心距页面顶部（px），落在单手拇指舒展区 |
| `stepDeg` | 40 | 拖动多少度走一格 |
| `jitterDeg` | 1.5 | 小于它的角度变化忽略（滤触摸抖动） |
| `maxStepsPerMove` | 3 | 单次 touchmove 最多跳几格（快速甩动不越整环） |
| `stepCooldownMs` | 0 | 步进冷却；默认关（手指位移天然受控，桌面那套时间锁是为滚轮惯性设的） |
| `tapMoveTolDeg` | 8 | 旋转量小于它、且时长短，才算"轻点" |
| `tapMaxMs` | 350 | 同上，超时不算轻点 |
| `touchPad` | 16 | 环带命中相对视觉环拓宽（px）；视觉环带只有 ~18px，手指压不准 |
| `centerHole` | 34 | 环心孔半径：不参与旋转（手指压圆心时角度抖得厉害），留给"点按清除选中" |
| `outPush` | 1.35 | 选中扇区**线宽**倍率（外推的 canvas 替身） |
| `detentDeg` / `detentMs` | 3.5 / 160 | 档位回弹角度与时长 |
| `glow` | 7 | 辉光基准强度（实际还会乘主题系数，浅色 0.55 / 深色 1.0） |
| `ghostDeg` | 4.5 | 幽灵扇区角度（= `site/app.js` 的代码值；`DESIGN.md` §3.1 写的 6° 是过期的） |
| `maxSectors` | 7 | 环上扇区上限，超出合并「其他分类」 |
| `breathe` / `haptic` / `toastOnSwitch` | 开 | 呼吸动画 / 触感震动 / 切换提示 |

## 与桌面几何的奇偶校验

**已实测逐值相等**（不是"按设计应该相等"）：把真桌面页 `site/index.html?widget=1&demo=1` 塞进隐藏 iframe，
直接调它的 `widgetSectors()`，用同一份样例数据与本原型的 `RingModel.sectors()` 逐项对比：

```
d4 168.48 / d1 84.24 / d5 56.16 / d2 42.12 / d3 4.5(幽灵) / d6 4.5(幽灵)   ← 两者完全一致
```

复现方式：在原型页控制台跑 `prototype/` 里那段 iframe 对比（见 git 历史/会话记录），或直接信这条。
角度、幽灵标记全部相同；唯一**有意的差异**是幽灵标记的修正（见下）。

## 搬迁到微信小程序

几何层是唯一真正要"搬走"的资产。两端差异只有三处：

| 本原型 | 小程序 | 说明 |
|---|---|---|
| `ring-geometry.js` | `utils/ring.js` | **原样拷**。已写成 UMD，小程序走 `module.exports` 分支即可；零 canvas、零 DOM |
| `ring-canvas.js` 的 `layoutCanvas()` | `wx.createSelectorQuery().select('#ring').fields({node:true,size:true})` + `wx.getWindowInfo().pixelRatio` | 取尺寸与 dpr 的方式不同，算法（`canvas.width = cssW*dpr`）相同 |
| `ring-canvas.js` 的 `bind()` | `<canvas type="2d" bindtouchstart catchtouchmove bindtouchend>` | **必须用 `catchtouchmove`**（`bind` 不吞滚动，页面会跟着滚）；无 Pointer Events |
| `navigator.vibrate` | `wx.vibrateShort({ type: 'light' })` | |
| `prototype.css` 的 px | ×2 写成 rpx | 设计基准 375px 宽；750rpx = 屏宽 |
| `<canvas>` + HTML 覆盖层 | `<canvas type="2d">` + 同样用 WXML 叠读数 | 文字不建议画进 canvas：DOM/WXML 的省略号与字重更省事 |

### 两条定标结论（已实测，别再猜）

1. **`shadowBlur` 会随 `ctx.scale(dpr, dpr)` 一起缩放** —— 也就是按 **CSS 像素**给值就行，
   **不要**再乘 dpr。乘了之后同一个值在 2x/3x 屏上辉光会成倍变糊（我在 dpr 1/2/3 下截同尺寸对比图验证过）。
2. 呼吸动画目前是"60fps 的 rAF + 25fps 的重绘节流"。小程序里建议改用 `setInterval`（比如 120ms 一帧）
   并在 `onHide` 里停掉 —— 手机上常驻 rAF 费电。

### 一处**有意的差异**（比桌面更正确）

桌面的 `widgetSectors()` 把"今日 0 秒"的分类一律标成幽灵（灰色）—— 于是"刚点下开始"的那一瞬间，
正在计时的那个扇区会被画成灰的，而 `tickRing()` 只在形状变化时才重建 DOM，这个灰会一直留着
（真实事故，2026-10-10 用户报的）。桌面是在渲染层补的补丁；本原型**在数据层直接修正**：
`ghost = sec <= 0 && !active`。**`deg` 的计算仍然逐值与桌面一致**，所以奇偶校验照样过。

搬进小程序时请带上这个修正（即 `sectors()` 里那一行 `withDeg.forEach`）。

### 另一处**有意的偏离**（视觉）

`DESIGN.md` 禁止给盘加投影，理由是"Electron 透明窗口会把投影裁成方形硬边"——**那是桌面壳的约束**。
手机上不成立，所以浅色主题给白盘留了一层极弱投影（`0 10px 30px rgba(31,41,55,.09)`），
否则白盘压在 `#f5f7fb` 上几乎看不见。深色主题里自动归零。

## 自测

```bash
playwright-cli open "http://localhost:8899/prototype/index.html"
playwright-cli resize 375 812
playwright-cli eval "fetch('/prototype/selftest.js').then(r=>r.text()).then(t=>eval(t))"
```

`selftest.js` 覆盖 32 项：几何分角与合计、span 无死区、命中分区（环带/环心孔/盘外）、
拖 45° 走一格、连续拖不超上限、逆时针、抖动过滤、方向翻转归零、**松手即确认**、
**弱拖动不提交**、**拖到运行中分类松手不停止**、轻点扇区切换、轻点环心清选中、
拖动时页面不滚动、空数据 4 等分、开始瞬间不是幽灵、超 7 类合并、DPR 后备缓冲、无元素溢出。

⚠️ **不幂等**：跑完页面上会留下"正在计时"的状态，重跑前先 reload。

真鼠标事件端到端（证明接线，不只是核心函数对）：
```bash
playwright-cli mousemove 188 244; playwright-cli mousedown
playwright-cli mousemove 210 246; playwright-cli mousemove 231 255; playwright-cli mousemove 249 269
playwright-cli mouseup      # 应看到"生活"开始计时
```

## 本轮明确没做

不接云端/登录/真实数据（内存 mock）；不做"停止"；不做快速标签 / 新增分类 / 编辑记录 /
统计图表 / 历史页；不做多指、捏合、长按、双击；不做键盘等价与无障碍朗读。

**一个已知死胡同**：「其他分类」扇区（分类超过 7 个才出现）目前只弹一句提示，
没做展开列表 —— 分类 ≤7 个时不会遇到。
