# 新环境接手清单（换机器 / 换 agent 必读）

> 目标：**克隆本仓库到一台全新电脑后，照着这份清单就能继续开发。**
> 读完顺序：本文件 → `HANDOFF.md`（产品与架构全貌）→ `DESIGN.md`（组件设计系统与坑位）→ `desktop/PACKAGING.md`（打包）

---

## 0. 一句话现状（截至 2026-09-30）

- 三端 + 一个 Electron 壳都在本仓库；线上页面**仍是 v1.0 旧版**，新版组件（圆形光环 + 滚轮切换）**只在本地与 exe 里**
- 仓库 tag：`v1.0.0`（初版）、`v1.1.0`（组件重构里程碑）
- **未完成的一件事：把新版页面发布上线**（平台发布环境此前不可达）—— 发布前需用户当次确认

## 1. 环境准备

| 需要 | 版本/说明 |
|---|---|
| Node.js | 22.x（`desktop/` 装 electron 用；`miniprogram/` 构建也用） |
| Python 3 | 本地起静态服务预览网页（`python -m http.server`） |
| Git 凭据 | 新机首次 `git push` 会弹一次浏览器授权（本仓库用 HTTPS + Git Credential Manager） |
| 网络 | 云后端国内直连；**Google API 仅在同步瞬间需要代理**；npm 安装建议用镜像（见下） |

```bash
git clone https://github.com/opqrssss-byte/time-tracker.git
cd time-tracker
cd desktop && npm install        # electron + electron-builder（打包细节见 PACKAGING.md）
```

> `desktop/package-lock.json` 已入库，安装版本可复现。若 npm 拉 electron 慢，先设镜像：
> `export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"`

## 2. 本地跑起来

```bash
# ① 完整版网页（计时/记录/统计/设置）—— 在**仓库根目录**起服务
python -m http.server 8899
#   → 完整版：http://localhost:8899/site/index.html
#   注意：云登录只在「已发布域名」可用（服务端精确 Origin 匹配），localhost 上只能看静态界面

# ② 组件外观与交互（推荐！不依赖发布、不连云端，用样例数据）
#   → http://localhost:8899/site/index.html?widget=1&demo=1

# ②' 组件"实战"试用：空数据起步 + 本机保存（同样不连云端），可以真的记起来
#   → http://localhost:8899/site/index.html?widget=1&sandbox=1
#   想清空重来：URL 加 &reset=1，或控制台执行 __sandboxReset()

# ②'' 组件"舞台"（推荐给"给人看"的场合）：把组件按真实窗口尺寸 260×380 框出来，
#      顶栏可切 沙盒 / 演示 / 清空重来。浏览器面板通常很宽，直接开组件页会孤零零缩在左上角，
#      用这个页面看比例才对。不是产品文件，只在本地用。
#   → http://localhost:8899/tools/widget-stage.html

# ③ 真实悬浮窗：双击 desktop/dist/时间追踪-本地预览.exe
#    —— 桌面组件形态 + 沙盒模式（空数据起步、可真的记录，数据存 %TEMP%/tt-widget-preview）
#    —— 右键菜单有「清空本地记录（重来）」。产物不入库，换机先按 desktop/PACKAGING.md 打包
#    想让悬浮窗加载本地开发中的 site/（不必重打包）：
WIDGET_URL="http://127.0.0.1:8899/site/index.html?widget=1&sandbox=1" \
  ./desktop/dist/win-unpacked/时间追踪-本地预览.exe
#    ⚠️ 带 WIDGET_URL 就退化成普通实例（默认 userData）→ 会与正式组件抢单实例锁，先退出正式组件
```

`?demo=1` 的约定：**仅当同时带 `widget` 参数时生效**，用样例分类与今日数据渲染，点击/滚轮只改本地状态、绝不写云端；正式环境不带该参数。

`?sandbox=1`（沙盒）与 demo 的区别：① **初始无任何记录**（只在首次种子 4 个默认分类，与正式首登一致）
② 每次操作写 `localStorage`，刷新/重开窗口后记录与"正在计时"都还在（体感同正式版"状态存云端"）
③ 文案不带"演示"字样 —— 用来以真实手感试用，**只是数据存本机、不连云端**。

## 3. 改完怎么验证（重要）

组件大量依赖鼠标事件与 Electron 壳能力，**纯静态看代码很容易漏回归**。仓库里有现成的自测脚本：

```bash
python -m http.server 8899      # 在仓库根目录执行（脚本在 tools/，服务必须挂在仓库根）
playwright-cli open "http://localhost:8899/site/index.html?widget=1&demo=1"   # 终端 2（需 playwright）
playwright-cli resize 260 380   # 必须用真实窗口尺寸，否则布局类断言无意义
playwright-cli eval "fetch('/tools/widget-selftest.js').then(r=>r.text()).then(t=>eval(t))"
playwright-cli close
```

`tools/widget-selftest.js` 会断言：滚轮选中 / 主读数不被顶掉 / 停顿自动确认 / 切换 / 循环回绕 /
同分类不误停 / Esc 取消 / 面板禁用滚轮 / 内联错误 / 元素守恒。**改组件后跑一遍再交付。**

> 这条路径已被验证：用 GitHub 上的**全新克隆**起服务跑过一次，21 项全通过（2026-09-30）。

**改到沙盒 / 本地模式时再跑一份**（空数据起步、停止+快速标签、改标签的时长迁移、面板拦点击、落盘完整性）：

```bash
playwright-cli open "http://localhost:8899/site/index.html?widget=1&sandbox=1"
playwright-cli resize 260 380
playwright-cli eval "fetch('/tools/sandbox-selftest.js').then(r=>r.text()).then(t=>eval(t))"
```

⚠️ 它会清掉 `tt-sandbox-v1` 再重来，跑完页面停在"有记录"状态 —— **交付给用户试用前记得清空**（`&reset=1`）。

**模拟 Electron 壳**（浏览器里验证穿透/拖动等壳行为）：用 `playwright run-code` + `addInitScript`
注入一个假的 `window.electronAPI`，把 IPC 调用记进 `window.__ipc` 再断言 —— 示例见 `HANDOFF.md` §7.1 末尾。

## 4. 发布上线（覆盖性操作，**必须先问用户**）

1. 用内置工具 `workbuddy_sites_deploy`：`directory=<仓库>/site`、`appName=时间追踪`、`domainPrefix=time-tracker`、`entryHtml=index.html`、`miniProgramRequested: true`、`userAskedToPublish: true`（**仅当用户本轮明确要求发布时才传**）
2. 当前应用 `wbapp_aEuqo04CtucnCnaaQ8i9oU`（2026-10-10 在现账号下新建），线上链接 `https://time-tracker-33431.app.workbuddy.host/`；发布 = 覆盖线上
3. ⚠️ **目录必须用 `site/`**：平台按目录路径解析发布目标，`web/` 曾被登记给旧应用（传 `appId` 也改不了）→ 用 `web/` 发布永远失败。细则与历史见 `HANDOFF.md` §6.1
4. 发布前核对 `.workbuddy/applications.yaml`（locator 应为上面那个 appId）与 `site/app.js` 的 `publishableKey`（须与该应用 publicConfig 一致）

## 5. 克隆后必然丢失的东西（及恢复方式）

| 丢失项 | 影响 | 怎么办 |
|---|---|---|
| Google 服务账号私钥 + Doc ID（只存 localStorage，**故意不入库**） | NotebookLM 同步不可用 | 按 `site/setup-google.html` 五步重配（约 10 分钟），或从旧机导出 localStorage |
| 云登录态（localStorage / Electron `persist:timetracker` 分区） | 组件与网页显示未登录 | 邮箱验证码重新登录（首次需设密码） |
| Git 凭据（GCM） | `git push` 需授权 | 首次推送时在弹窗里浏览器授权一次 |
| winCodeSign 构建缓存 | 打包报符号链接错误 | 按 `desktop/PACKAGING.md` 坑 2 预置 |
| `desktop/dist/*.exe`（产物不入库） | 没有现成 exe | 本地按 `PACKAGING.md` 打包（约 2 分钟） |
| `.workbuddy/memory/*.md`（开发日志，被 gitignore） | 丢失开发过程细节 | 关键结论已沉淀进 `HANDOFF.md` / `DESIGN.md`，够用 |

## 6. 已知的非可复现项（接手时留意）

- `site/index.html` 的云 SDK 走 CDN 浮动版本 `@tencent-ai/workbuddy-cloud-sdk@dev`（官方要求，勿擅自固定）
- 其余 CDN 均为固定版本：`echarts@5.5.1`、`xlsx@0.18.5`、`jsrsasign@11.1.0`
- 小程序依赖需在**微信开发者工具里执行「工具 → 构建 npm」**（`miniprogram/utils/cloud.js` 用 SDK 的 `/miniprogram` 子路径 + 诊断适配器）

## 7. 这份清单之外还有疑问？

`HANDOFF.md` §5「已验证的关键事实」与 §7「已知坑与禁忌」是踩坑总结；`DESIGN.md` 是组件的设计系统与实现约定。
**不要重新调研架构、不要提议换技术栈**（Electron / WorkBuddy 云 / Google Doc 桥接都是用户拍板过的）。
