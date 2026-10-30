# 交接：VectorCraft 接入与矢量资产

> 最后更新：2026-10-29 17:25 · 交接对象：任意接手这个线程的 agent
> 前置阅读：`HANDOFF.md`（产品架构）、`DESIGN.md`（设计规范）。这份只讲这一段任务。

## 0. 一句话现状

本机装了 **VectorCraft 0.18.0**（Illustrator 的开源复刻，Rust + WASM），已经打通「命令行/MCP 下指令 → 应用里出图」的闭环，并产出 `design/vector/00-知识图谱画布.vectorcraft`（**单文件 5 画板**：3 张讲解图 + 2 张空白画布，纯白底 + 苹果系统色）。启动器有个必现 bug，绕法见 §2。

**这份文档的边界**：讲"怎么用 VectorCraft 生成这套矢量稿"。产品本身的设计决策不在这里。时间追踪 UI 组件（计时胶囊 / 今日统计 / 控件组）已于 2026-10-29 按用户要求移除，**不要凭旧记忆把它们加回来**。

## 1. 环境事实（本机，别猜）

| 项 | 值 |
|---|---|
| 主程序 | `%LOCALAPPDATA%\Programs\ArtCraft\VectorCraft\vectorcraft.exe`（0.18.0，172 MB） |
| 命令行 | 同目录 `vectorcraft-cli.exe`（113 MB） |
| 签名 | Learning Machines Inc，有效，无 Mark-of-the-Web |
| 启动器 | `ArtCraft Launcher` 0.8.1（**坏的，见 §2**） |
| 可用入口 | 桌面 / 开始菜单里的 `VectorCraft.lnk`（MSI 建好的，指向正确的 exe） |
| 命令总数 | 822 条（`vectorcraft-cli commands`），MCP 暴露 33 个工具 |

CLI 子命令只有这几个，别记错：

```
vectorcraft-cli mcp [--connect ADDR | --headless]      MCP server over stdio
vectorcraft-cli run [--commands FILE] [--export ...]   无界面批处理（最常用）
vectorcraft-cli convert IN OUT [--scale N]             格式转换
vectorcraft-cli info FILE / commands / bench / perf
```

## 2. 已知故障与绕法（都实测过）

### 2.1 启动器点「开启」报 "X isn't where it was installed"

- 根因：`%APPDATA%\ai.storyteller.artcraft-launcher\data\app.ron` 里 `install_locations:(root:None,per_app:{})` 是空的 —— 安装路径没被记录。而 MSI 声明的默认目标是 `Program Files\ArtCraft\VectorCraft`，实际被覆盖装到 `LocalAppData\Programs\ArtCraft\VectorCraft`，启动器按默认路径找 → 找不到。
- 上游已有大量同症状 issue：craft-launcher `#964 #966 #970 #973 #976`（约 131 条相关）。**卸载重装无效**，因为重装后仍不记录路径。
- 绕法：**别用启动器**。直接双击桌面快捷方式，或从 `%LOCALAPPDATA%\Programs\ArtCraft\VectorCraft\vectorcraft.exe` 起。

### 2.2 画板背景色不参与导出

`artboard.new {color}` / `artboard.setProps {color}` 只影响屏幕显示，导出的 PNG/PDF 里是透明的。**要背景色就在画板最底层画一个矩形**（本仓库的构建脚本都是这么做的）。

### 2.2b 打开文件看到的是旧内容 / 只有一两个画板（2026-10-30 排查完）

用户在软件里看到的内容和导出的 PNG 对不上，标题栏带 `[Recovered]`。**这不是文件坏了，是三个问题叠在一起**：

1. **强杀进程会留下恢复快照，下次打开加载的是快照不是文件。** 快照在
   `%APPDATA%\VectorCraft\Data Recovery\<id>\<文件名>-1.vectorcraft`，是崩溃那一刻的内存状态 —— 可能是几轮之前的老版本。窗口标题出现 `[Recovered]` 就说明你正在看假货。清法：退出应用后删掉 `Data Recovery` 下那个 `<id>` 目录（删前先备份），再重开。
2. **`cmd //c start` 启动的 GUI 会被环境回收，存活不过几秒。** 表现为「进程起来了一下就没了」，让人误以为文件打不开。**用 `run_in_background` 直接执行 exe**，不要经 `cmd start`。
3. **108.9% 缩放下窗口只装得下一个 900×620 画板。** 5 个画板横排 2740 宽，看不到全部是正常的，不是文件里只有一两个。`Ctrl+-` 缩到约 35% 就能一屏看全五张。

**验证文件是不是真的、新的，别看窗口，看这三样**：`vectorcraft-cli info <file>` 的画板数、窗口标题有没有 `[Recovered]`、`.vectorcraft` 文件大小和 mtime 对不对得上。

### 2.3 `paint.setStroke` 只吃颜色

`paint.setStroke` 的文档是 "same as paint.setFill, for the stroke" —— 它接受 `color` / `none` / `swatch` / `gradient`，**不接受** `weight` / `cap` / `dash`。传了这些字段不报错、返回 `{objects:1}`，但会被静默丢弃。

正确写法（两条命令）：

```json
{"id": "paint.setStroke", "params": {"color": "#1C1C1C"}},
{"id": "stroke.set", "params": {"weight": 2, "cap": "round", "dash": [10, 8]}}
```

我一开始把 `dash` 塞进 `paint.setStroke`，结果整份稿子的虚线全成了实线，排查了两轮才定位。**虚线一律用 `stroke.set`。**

### 2.4 其它

- `draw_shape`（MCP 工具）的形状字段叫 **`shape`** 不是 `kind`，必填。
- `command_batch` 的步骤键是 **`id` + `params`**，不是 `command`。
- `document.export` 是 **command**，不是 MCP tool，必须走 `command_run`。
- 文字 `text.create` 支持 `style:"Bold"`，实测生效（导出 SVG 带 `font-weight="bold"`）。
- **箭头有原生端点，别用多边形拼**。见 §2.5。

### 2.5 箭头：用 `stroke.set` 的 `endArrow`（2026-10-29 更正）

旧版本文档写「箭头没有 marker，用三角多边形拼（`arrow_r()`）」，**这条是错的**。`vectorcraft-cli run` 批处理里 `stroke.set` 支持四十多种原生箭头：

```
endArrow?: Arrow|ArrowOpen|Barbed|Concave|DoubleArrow|HalfArrowLeft|HalfArrowRight|
           Chevron|Feather|Swallowtail|Triangle|TriangleOpen|TriangleReverse|TriangleBar|
           Kite|Leaf|Drop|Circle|CircleOpen|HalfCircle|Oval|Target|Square|SquareOpen|
           Tag|TagOpen|Diamond|DiamondOpen|Hexagon|HexagonOpen|Star|Cross|Plus|Bar|
           DoubleBar|DotOnBar|Slash|DoubleSlash|Bracket|Fork
arrowAlign?: "extend"（默认，尖超出终点）| "tip"（尖落在终点，线自动缩短）
```

正确写法（一个路径 + 端点 = **一个对象**）：

```json
{"id": "path.create", "params": {"d": "M60 336 H144", "closed": false}},
{"id": "paint.setFill", "params": {"none": true}},
{"id": "paint.setStroke", "params": {"color": "#1C1C1C"}},
{"id": "stroke.set", "params": {"weight": 1.6, "cap": "round", "endArrow": "Arrow", "arrowAlign": "tip"}}
```

**为什么必须改**：这份工作簿的核心用途是「选中零件 → Ctrl+C → 粘到空白画板」（见 §5）。多边形拼的箭头复制过去是**两个对象**，用户拉长路径时箭头不跟随、改粗细要手工重算三角坐标，等于给用户埋坑。原生端点跟着路径走、跟着线宽缩放。折线箭头（`M..V..H..`）同样一个对象搞定。

### 2.6 居中文字：用 `justify`，别估字宽（2026-10-29 更正）

旧版本用 `tw()` 按「ASCII ≈ 0.55×字号、CJK ≈ 1.0×字号」估算宽度再左移，中英混排（`"① 你画"`、`"路径 →"`）会偏。`text.create` 本身就有 `justify`：

```json
{"id": "text.create", "params": {"x": 300, "y": 80, "text": "居中文字 ABC", "size": 18, "justify": "center"}}
```

`x` 直接传**中心点**，每行按该点居中。`text.create` 还会返回 `bounds {x, y, width, height}`，需要真实宽度时读返回值，不要再估。当前 `ctext()` 已改成走 `justify`，`tw()` 已删除。


## 3. 两条接入通路

### A. 无界面批处理（推荐，当前所有产物都是这么来的）

不需要开 GUI，不打扰用户：

```bash
CLI="%LOCALAPPDATA%\Programs\ArtCraft\VectorCraft\vectorcraft-cli.exe"
"$CLI" run --commands steps.json
```

`steps.json` 是 `[{"id":"...","params":{...}}, ...]`，每步结果一行 JSON 打到 stdout（出错会在步里带 `error`）。

### B. 实时联机（用户开着窗口，能看见我下笔）

```bash
vectorcraft.exe --control 7979            # 应用侧开控制口
vectorcraft-cli mcp --connect 127.0.0.1:7979   # 我这边 stdio 代理
```

连上后 33 个工具，关键是 `doc_inspect`（读图层树/选中）、`render_preview`（把画板渲成 PNG 回给我，等于我能"看见"画布）、`draw_shape` / `draw_path` / `set_paint`、`command_run`。

> 注意：这段期间用户把带 `--control 7979` 的进程关了，**现在没有在跑**。要恢复得重新起并征得同意。

stdio 代理的最小可用骨架（Windows，python）：

```python
import json, subprocess
CLI = r"C:\Users\<you>\AppData\Local\Programs\ArtCraft\VectorCraft\vectorcraft-cli.exe"
p = subprocess.Popen([CLI, "mcp", "--connect", "127.0.0.1:7979"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
n = [0]
def call(method, params=None):
    n[0] += 1
    p.stdin.write((json.dumps({"jsonrpc": "2.0", "id": n[0],
                               "method": method, "params": params or {}}) + "\n").encode())
    p.stdin.flush()
    return json.loads(p.stdout.readline().decode("utf-8", "replace"))
call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "agent", "version": "1"}})
p.stdin.write((json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n").encode())
p.stdin.flush()
tools = call("tools/list")["result"]["tools"]
```

## 4. 资产清单

全部在 `design/vector/`：

| 文件 | 内容 |
|---|---|
| `00-知识图谱画布.vectorcraft` | **唯一交付**：单文件 5 画板（详见 §5） |
| `00-知识图谱画布.pdf` | 同上的 5 页 PDF，用于打印 / 丢给多模态模型识图 |
| `00-总览-0X-*.png` | 每个画板一张，scale 2 |
| `build_workbook.py` | **生成 5 画板工作簿的脚本，可重跑** |
| `README.md` | **给编辑者看的说明书**：怎么打开、什么能拖、改脚本还是手改、字体和尺寸约定 |

> 如果你只是要**打开来改图**，读 `design/vector/README.md` 就够了。这份文档讲的是更深的技术细节（CLI 用法、命令坑、id 推算），改脚本之前再看。

**目录里只留这 8 个文件**（5 张 PNG + 1 个 pdf + 1 个 vectorcraft + 1 个脚本）。2026-10-29 按用户要求合并：原先散落的 `01-四种连线.*` / `02-你画我改闭环.*` / `03-计时胶囊.*` / `04-今日统计.*` / `05-控件组.*`（各带 vectorcraft + png + svg 三件）已全部删除，内容要么并进了单文件，要么按需求砍掉。**不要再往这个目录加散文件**，一个 `.vectorcraft` 装完。

`.svg` 导出不再产出。要 SVG 就走 `vectorcraft-cli convert IN.vectorcraft OUT.svg` 或应用内导出，不必为每个画板单独存一份。

`.vectorcraft` 内部字体仍是 `Source Sans 3`。

**字体已换成 `Noto Sans SC`（2026-10-30，推翻了下面这段旧结论）。**

上一版写着「字体别再折腾」，理由是 `Source Sans 3` 缺 288 个中文字形、靠回退链渲染、"字形正常"。**这条判断是错的** —— 回退链在 Windows 上落到**宋体（衬线）**，整份稿子一直是宋体版，根本不是苹果该有的黑体。当时的 `Source Sans 3` 和显式写它渲染完全一致（宽度 278.8 vs 278.8），就是证据。

现在 `text()` 统一注入 `font: "Noto Sans SC"`。实测宽度代价（这才是当初不敢换的真实原因）：

| 场景 | 宽度变化 |
|---|---|
| 纯中文 Regular | +0.3% |
| 纯中文 Bold | +8.7% |
| 含拉丁（如 `豆包 / WorkBuddy · 前置 20%`） | **+13.8%** |

所以**换字体必然重排**，别以为能直接套。这次换完修了三处：01 卡 1 引线起点 44→60（黑体更宽会穿过标签）、01 卡 3 去掉贯穿删除线（10px 小字扛不住任何横线）、其余靠逐张目检确认无溢出。

**不要再换回 `Source Sans 3`**，那等于回到宋体。也不建议 `Microsoft YaHei UI`：宽度只 +3.9% 看着更安全，但笔画方硬、字面偏小，离苹方更远。

## 5. 工作簿结构（5 画板，两排）

| # | 名称 | 位置 | 尺寸 | 用途 |
|---|---|---|---|---|
| 0 | 01-四种连线 | (0,0) | 900×620 | 讲解：层级 / 路径 / 互斥 / 平替 |
| 1 | 02-你画我改闭环 | (940,0) | 900×620 | 讲解：你画→AI 扫→你改→存料 |
| 2 | 03-工具库 | (1880,0) | 900×620 | **零件箱**：3 种节点 + 2 种圆 / 6 种连线 / 3 种容器 / 配色 |
| 3 | 04-空白画布 01 | (0,680) | 900×620 | 用户在这里画 |
| 4 | 05-空白画布 02 | (940,680) | 900×620 | 用户在这里画 |

总尺寸 2740×1300。

用户的用法：在 03 里选中零件 → `Ctrl+C` → 切到 04/05 → `Ctrl+V`。

**"零编组"已经作废（2026-10-30）。** 原来要求 `Group` 必须为 0，是为了"零件能单独框选"。但副作用是**拖一个节点只动了框、文字留在原地**，整份稿子根本没法直接用。现在改成：

- **一个语义单元 = 一个 group**（`object.group {ids}`）。整份 33 组：01 四张 Bento 卡、02 四张流程卡 + 回环线 + 两张对照卡、03 每个节点/容器/算子/色板条目、04 中心锚点。
- **底图和说明文字 = 锁定**（`object.lock {ids}`）。整份 65 个：5 张白底矩形、各画板大标题与副标题、03 的分类标签与分隔线、04 的十字虚线与四象限标题、05 的全部刻度。拖不到、选不中，误操作不会散架。
- 03 的零件现在是"一整个节点组"，复制走就是完整的框+字，比散装更好用。

验收指标改成：`kinds` 里 `Group` = 33、顶层 `locked` = 65、对象的 `font_family` 全是 `Noto Sans SC`。

**id 怎么算的**：画板 id 是独立序列(1..5)；对象 id 与 layer 共用序列，首个对象 id=2 且严格连续递增，所以"第 n 个创建的对象 id = n+1"可以精确预测。**所有 group / lock 命令必须放在所有对象创建完之后统一发**，中途发会打乱后续 id 推算 —— 算错就会把不相关的对象编到一起，比散装更糟。

**04/05 故意留白，没加网格。** 淡网格 / 四象限参考线这事问过用户、没答复，别自己加。提示文字只有左上角两行，压在 `GRAY2` / `GRAY3` 上，看得见但不抢画面。

## 6. 怎么重新生成

```bash
python design/vector/build_workbook.py
```

脚本会用 `vectorcraft-cli run` 无界面新建文档 → 画 5 个画板 → `file.saveAs` 保存 → 导出 5 张 PNG + 1 个 PDF，全部覆盖 `design/vector/` 下的 `00-*`。改内容就改脚本里的坐标和文案，别手动改稿——脚本是唯一真相。

要居中文字用 `ctext()`（内部走 `text.create` 的 `justify:"center"`，传中心点即可）。旧的 `tw()` 字宽估算已删，别再按 0.55/1.0 系数硬算坐标。

画板右边界约定：`01/02` 用 60..840，`03` 用 60..666（配色另占 700..840）。加东西前先对齐这两条线，不然一眼就看出歪。

### 6.1 配色（2026-10-29 全面换成苹果系统色）

**底色一律纯白 `#FFFFFF`**。旧版是暖米纸色 `#F6F4EF` + 暖灰 `#7A7468`，那是「纸质笔记」的语言，不是苹果。层级靠发丝线和留白撑，不靠填色。

| 常量 | 值 | 用途 |
|---|---|---|
| `INK` | `#1D1D1F` | 主文字、实心节点 |
| `SUB` | `#6E6E73` | 次文字 |
| `TERT` / `GRAY3` | `#8E8E93` / `#C7C7CC` | 三级文字、小标签 |
| `GRAY2` | `#AEAEB2` | **零件描边**（白底上要看得清，`GRAY3` 太淡会消失） |
| `HAIR` | `#E5E5EA` | 发丝线、卡片描边 |
| `GRAY6` | `#F2F2F7` | 浅灰底（对照卡片） |
| `BLUE` / `BLUEL` | `#007AFF` / `#EAF3FF` | 强调节点、强调容器 |
| `GREEN` `ORANGE` `RED` `PURPLE` | `#34C759` `#FF9500` `#FF3B30` `#AF52DE` | 系统色，配色板与警示 |
| `REDL` / `REDB` | `#FFF5F4` / `#FFD6D1` | 否决态填充 / 边框 |

三条硬规矩：

1. **不要整块铺系统色。** 否决态是「浅红底 + 红框 + 红叉」，不是一块 `#FF3B30` 大红面 —— 苹果不会用那么大面积的高饱和色。
2. **白底上的白卡片会消失。** 流程卡片靠 `HAIR` 发丝边就行；但**零件**（要被复制走的）描边必须用 `GRAY2`。
3. **两张对照卡片用底色区分**，不要两张都用白底发丝边 —— 左 `GRAY6` 灰、右 `REDL` 浅红，一眼看出正反对照。

## 7. 待办 / 没做完

### 7.0 已做完（2026-10-29 接手这一轮）

一轮「把零件真正做成零件」的清理，全部通过重跑 `build_workbook.py` 验证（当时 8 画板 / 222 对象 / 0 组 / PDF 8 页）：

| 改了什么 | 为什么 |
|---|---|
| 箭头改成原生 `endArrow` 单对象（含折线箭头、02 回环线） | 原来「线 + 三角」两个对象，复制走之后拉长不跟随，违背 §5 的核心用途 |
| `ctext()` 改走 `justify:"center"`，删掉 `tw()` | 中英混排（`① 你画`、`路径 →`）估算会偏 |
| `01` 层级示范内框归位（96 → 111） | 外框 70..220 里，内框左留 26 右留 56，明显偏左 |
| `05` 柱状图改成三色堆叠 | 图例写着工作/学习/娱乐三色，柱子却全是橙的，图例是假的 |
| `06` 右边界统一到 392 | toggle 380 / 分割线 392 / 按钮 398 三条线不齐；「周」「月」坐标漏加左边距 48 |
| `03` 配色挪到连线行右侧，「用法」让出间距，加号竖线不压字 | 原来配色挤在节点行里、「用法」贴着容器边缘 0 间距 |
| `03` 副标题改「切到 07 / 08」 | 原文写「贴到右边空白画布」，但 07/08 在 `(0,1000)`，是在 03 的**下方**不是右边 |

### 7.0b 第二轮（2026-10-29 17:15，用户当面提的三条需求）

用户原话：「把那几个时间组件删掉，这不是主需」「改一下现在的 ui，模仿一下苹果系产品的风格和配色」「把所有文件做到一起」。

| 改了什么 | 结果 |
|---|---|
| 删掉 04-计时胶囊 / 05-今日统计 / 06-控件组 | 8 画板 → **5 画板**，对象 222 → 129 |
| 空白画布 07/08 → **04/05**，位置上移到第二排 `(0,680)` / `(940,680)` | 两排铺开，总尺寸 2740×1300 |
| 全局换成苹果系统色（§6.1） | 暖米纸底 `#F6F4EF` → 纯白；暖灰 `#7A7468` → `#6E6E73`；强调色全换 iOS 系统色 |
| 标题 30pt Regular → 32pt **Bold**，正文 14 → 15 | 苹果大标题层级 |
| 圆角统一 8 / 12 / 14（原来 0~14 混用） | 与 iOS 控件半径对齐 |
| 01 否决态：整块 `#FF3B30` → 浅红底 + 红框 + 红叉 | 苹果不用大面高饱和色 |
| 02 两张对照卡：白底发丝边 → 左 `GRAY6` 灰 / 右 `REDL` 浅红 | 白底上的白卡会「消失」 |
| 零件描边 `#C7C7CC` → `#AEAEB2` | `GRAY3` 在纯白上太淡，零件边界必须看清 |
| 删掉 15 个散文件（5 套 × vectorcraft/png/svg） | 目录只留 1 个 vectorcraft + 1 个 pdf + 5 张 png + 1 个脚本 |

验证：`info` → 5 画板 / 129 对象 / `kinds` 无 `Group` / `warnings` 空；PDF `/Count 5`；5 张 PNG 逐张目检。

### 7.1 还没做

- [ ] `04/05` 空白画板加淡网格或四象限参考线（画层级图好对齐）——问过用户，未答复，**别自己加**
- [ ] 把 VectorCraft 注册进 `~/.workbuddy/mcp.json`，省掉每次起代理；**未做**，因为需要在连接器页面点「信任」，要用户操作
- [ ] 5 画板是横向两排铺开（总 2740×1300），打印建议 A3 横版；没做过实际打印验证

### 7.2 已作废（2026-10-29）

- ~~深色模式版本的 UI 组件~~ —— 时间追踪 UI 组件整体不再是需求，画板已删
- ~~UI 三个组件是否要落进产品（`site/` / `desktop/`）~~ —— 同上，没有组件了，不需要决定
- ~~`01/02` 讲解图没进 Obsidian~~ —— 开发日志已补，见 `项目/buddy小屋/2026-10-29.md`

## 8. 用户偏好（别推翻，会被骂）

- 要的是**能复制的作图零件**，不是成品 UI。第一版做成产品 UI 被明确否掉：「不是这个 ui，是那种我能直接在里面复制，用来画自己的思维图用的」。
- **一个文件多画板**，在一个文件里批注，不要一堆散文件。
- 视觉走苹果：8pt 网格、发丝线 `#E5E5EA`、系统色 `#007AFF / #34C759 / #FF9500`、卡片圆角 28、按钮高 44、**图标用几何画，不要 emoji**（emoji 跨系统字形会变）。
- 产品硬约束：计时器**只显示分+秒**，不出现小时位。

## 9. 一分钟自检

```bash
CLI="%LOCALAPPDATA%\Programs\ArtCraft\VectorCraft\vectorcraft-cli.exe"
"$CLI" commands | head -c 200                  # 能出命令目录 = CLI 正常
python design/vector/build_workbook.py          # 能跑完 = 生成链路正常
"$CLI" info "design/vector/00-知识图谱画布.vectorcraft"   # 看画板数/对象数/字体
```
