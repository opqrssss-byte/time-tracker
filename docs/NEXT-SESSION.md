# 下一轮会话从这里开始（目标：在本地把 UI 做好）

> 用法：新开对话时把**这份文件**（或 `HANDOFF.md`）交给 agent，即可无缝接手。
> 需求定位读 `HANDOFF.md` §1；组件设计规范读 `DESIGN.md`；打包读 `desktop/PACKAGING.md`。

## 一、当前状态（2026-10-10 收尾时）

| 项 | 状态 |
|---|---|
| **线上网页** | **已上线**：https://time-tracker-33431.app.workbuddy.host/ |
| 线上应用 | `wbapp_aEuqo04CtucnCnaaQ8i9oU`（2026-10-10 在当前账号下新建；旧应用属另一个无积分账号，已弃用但旧链接未下线） |
| 线上内容 | 新版圆形光环组件 + 滚轮切换；与本地 `site/` **逐字节一致**（已验证） |
| 数据库 | 新环境已建 `categories` / `time_entries` + RLS + 索引，并做过写入→读回→删除往返验证；**历史数据按用户决定全部废弃** |
| 网页目录 | **`site/`**（由 `web/` 改名而来，原因见 `HANDOFF.md` §6.1：平台按**目录路径**解析发布目标，`web/` 被登记给旧应用且传 `appId` 也改不了） |
| 桌面 exe | 已重打（`desktop/dist/`），包内域名已换新；用户需安装新的 `时间追踪-桌面组件.exe` |
| 未完成 | ① `git push`（GitHub 网络 502，连续失败；本地领先 2 个提交，网络恢复后 `env -u GIT_TERMINAL_PROMPT git push origin main`）② 用户侧三件事：新域名登录 / 重配 Google 同步 / 装新 exe |

## 二、本地开发循环（不依赖云端、不依赖发布）

```bash
python -m http.server 8899          # 在仓库根目录执行
# 组件外观与交互（样例数据、不连云端）：
#   http://localhost:8899/site/index.html?widget=1&demo=1
# 组件实战试用（空数据起步 + 本机 localStorage 保存，可以真的记起来；不连云端）：
#   http://localhost:8899/site/index.html?widget=1&sandbox=1
#   清空重来：加 &reset=1 或控制台 __sandboxReset()
# 组件"舞台"（给人看组件时用这个：按真实窗口尺寸 260×380 框出来，顶栏可切模式）：
#   http://localhost:8899/tools/widget-stage.html
# 完整版网页（云登录只在已发布域名可用，本地只能看静态界面）：
#   http://localhost:8899/site/index.html
# 真实悬浮窗（可选）：
WIDGET_URL="http://127.0.0.1:8899/site/index.html?widget=1&sandbox=1" \
  ./desktop/dist/win-unpacked/时间追踪.exe --user-data-dir="$LOCALAPPDATA/Temp/tt-widget-preview"
```

**改完 UI 必须跑自测**（会拦下绝大多数回归；脚本在 `tools/widget-selftest.js`）：

```bash
playwright-cli open "http://localhost:8899/site/index.html?widget=1&demo=1"
playwright-cli resize 260 380            # 必须用真实窗口尺寸，否则布局类断言无意义
playwright-cli eval "fetch('/tools/widget-selftest.js').then(r=>r.text()).then(t=>eval(t))"
```

改到**沙盒 / 本地模式**（`app.js` 里的 `IS_LOCAL` 分支、`localToggle`、`sandboxSave`）时再跑一份
`tools/sandbox-selftest.js`（同一页面换成 `?widget=1&sandbox=1`，22 项）。⚠️ 它会清掉本机沙盒存档再重来。

想看某个状态定格（例如悬停/选中）可以手动摆：`setHover('d4')`、`clearHover()`、轮 `wheel` 事件见脚本写法；
要验证壳行为（点击穿透/拖动），用 `playwright run-code` + `addInitScript` 注入 mock `electronAPI`（写法见 `HANDOFF.md` §7.1 末尾）。

## 三、UI 改动前必须知道的硬约束（都是踩过的坑）

1. **窗口固定 260×380，运行期绝不 `setSize`**（Windows 透明窗口程序化改尺寸会留残影）
2. **`#widget-ring` 必须 `overflow: visible`**：选中弧外推 `scale(1.12)` 会超出 120×120 画布，否则被切平（用户报过"被方块遮住"）
3. **主读数（大字 + 状态行）永不被悬停/选中顶掉**（双通道原则，`DESIGN.md` §3.4）
4. **环形 DOM 只在形状变化时重建**，每秒只 `tickRing()` 原地改属性（否则悬停状态会卡死）
5. 分类色**只用在圆环上**；主操作白底黑字；层级用"表面阶梯 + 发丝描边 + 内阴影"，不用外投影（`DESIGN.md`）
6. 点击穿透 / 任意位置拖动 / 固定尺寸由 Electron 壳提供，页面用能力探测（`electronAPI.fixedSize / dragStart / ignoreMouse`）
7. **只改 `site/`**（网页端）→ **不需要重打 exe**；改了 `desktop/`（含域名、窗口尺寸）→ 必须重打
8. 组件同时有"悬停"与"滚轮选中"两套次要通道，互斥（选中优先）；新增交互前先读 `DESIGN.md` §3.4/§3.5

## 四、可选的美化方向（供用户挑选，非必做）

- 中心四行信息层级偏密：字号/行距/弱化层次可再调（例如把「最近：」进一步降级）
- 选中态：外推幅度、确认进度弧的粗细/颜色/时长（现 900ms）
- 提示条与面板的视觉统一（发丝描边、圆角、内距、与圆盘的距离）
- 幽灵扇区（今日无记录的灰药丸）的形态：药丸 / 细点 / 空心轨道
- 空态（全天零记录）的引导：文案 + 视觉提示
- **亮色主题版本**：目前组件是深色玻璃，而网页版/小程序是浅色体系，可考虑跟随系统或加浅色皮肤

## 五、发布与提交（改完想上线时）

- 提交：`git add` → commit → `env -u GIT_TERMINAL_PROMPT git push origin main`（不解除该变量会禁掉凭据弹窗）
- 发布：`workbuddy_sites_deploy`（`directory=<仓库>/site`、`entryHtml=index.html`、**需用户当次确认**）；细则见 `HANDOFF.md` §6.1
- **发布目录必须是 `site/`**：换回 `web/` 或改别的名字都会解析到错误的应用 / 变成小程序工程
