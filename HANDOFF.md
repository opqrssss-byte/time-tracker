# 时间追踪项目 · Agent 交接文档

> 版本：v1.0.0（2026-09-29 存档）｜ 用途：交给任何 agent 即可接手本项目的需求理解、开发与运维
> 仓库：https://github.com/opqrssss-byte/time-tracker ｜ 线上：https://time-tracker-91208.app.workbuddy.host/

---

## 1. 用户需求（原始意图，务必先读）

### 1.1 用户是谁、要解决什么
用户在 Gemini（NotebookLM）里建了一个**个人笔记本**，记录每天的状态以更好地了解自己。痛点是**信源不足**：只能靠自己事后用文字描述"今天干了啥"，难免偏颇和不准确。

### 1.2 产品定位（v2 定稿，用户原话确认）
> **本产品是 Gemini Notebook (NotebookLM) 的"自动化数据入参管道/被动喂料源"。**
> 用户只需正常计时/记录，后台自动把结构化时间日志同步到用户绑定在 NotebookLM 中的指定 Google Doc，使用户打开笔记本思考时已自动具备最新的时间上下文，**全程无需手动复制粘贴**。

### 1.3 功能需求清单
1. **一键计时**：一件事开始时点一下，工具随时间流逝自动记录，**用户绝不手动记录时长**；结束时点停止自动保存（开始/结束/时长/事项）
2. **桌面常驻悬浮组件**：对标用户喜爱的番茄钟交互（PowerShell+WPF 胶囊，位于 `C:\Users\zhangzining\Desktop\dk小屋\番茄钟-分享版`）——置顶、无边框、单击开始/停止
3. **快速标签后补内容**：每段时间结束时可先一键打个简易分类标签，完整内容之后再补；标题允许为空
4. **云端多端同步**：同一份数据在桌面组件、网页、微信小程序间实时互通；邮箱验证码登录识别同一人
5. **NotebookLM 自动喂料**：通过 Google Docs API 桥接（服务账号免弹窗授权），记录自动写入 Google Doc，NotebookLM 挂载该 Doc 为来源
6. 既有功能保留：分类管理、统计图表（日/周/月饼图+柱状图）、记录编辑/删除、CSV/Excel 导出

### 1.4 明确的取舍（用户已拍板，勿推翻）
- 桌面技术选 **Electron**（包体 ~200MB 可接受）
- 分类体系**单层分类**即可，多标签后期再加
- 新用户首次验证码登录必须设密码（平台硬性要求，用户已接受）
- **不复用 ActivityWatch**（场景不同：被动监视 vs 主动计时；无官方云同步/账号体系）
- 不做手机端悬浮窗（iOS/安卓系统限制，微信小程序即手机端正解）
- 不接 NotebookLM Enterprise API（alpha 且只覆盖企业版；Google Doc 桥接消费/企业版通用）

---

## 2. 系统架构

```
桌面悬浮组件(Electron·desktop/) ─┐
微信小程序(miniprogram/)        ├─→ WorkBuddy 云后端 ─→ GSync 同步引擎 ─→ Google Doc ─→ NotebookLM(Source)
网页版(web/·已上线)             ┘   (云数据库+邮箱认证)    (web/gsync.js)     《时间日志》
```

- **云后端**：WorkBuddy 云服务（对标 Supabase）。应用 ID `wbapp_Nv3mR6jZnOsFxEs3wbZrvd`（**appType=miniprogram，创建时写死不可改**），endpoint 固定网关 `https://mp-api.app.workbuddy.host`
- **三端共用同一份 publicConfig**（endpoint + publishableKey），统一**邮箱验证码登录**（绝不做微信登录——会产生不同 uid 导致数据分裂，平台无账号绑定能力）
- **计时机制**：状态存云端，`时长 = now − start_time`；`end_time IS NULL` 即"正在计时"；前端 setInterval 只刷新显示；多端同步靠 30s 轮询（SDK 无推送）
- **同步引擎**：GCP 服务账号自签 JWT（jsrsasign RS256）→ `oauth2.googleapis.com/token` 换 access_token → Docs API **全量重写**（幂等，断档自愈，无需增量队列）
- **桌面组件**：Electron 无边框置顶悬浮窗（**固定 260×380，运行期绝不 setSize**），`loadURL(线上网页?widget=1)`，UI/逻辑全在 web/（与网页零重复）；`persist:timetracker` 分区持久化登录态
  - 组件形态是**圆形玻璃盘 + 环形色块**（不是胶囊了），设计系统见 `DESIGN.md`
  - 交互：**滚轮沿环移动选中 → 停顿 0.9s 自动确认（换标签）/ 点击立即确认**（仿三星旋转表圈）；点扇区＝停止（临时妥协）；右键菜单＝完整版/新增分类/开机自启/退出
  - 壳能力（新 exe 才有，页面用 `electronAPI.fixedSize/dragStart/ignoreMouse` 探测）：**点击穿透**（透明区不挡桌面点击）、**任意位置拖动**、固定尺寸、右键菜单「新增分类」
  - 预览版：`desktop/electron-builder.preview.yml` → `dist/时间追踪-本地预览.exe`，把 web/ 打进包，**双击即看组件（样例数据、不连云端）**，无需线上发布

## 3. 数据库结构（云数据库，owner-only RLS）

```sql
categories(id, owner_id TEXT DEFAULT auth.uid(), name, color, sort_order, created_at)
  唯一索引 (owner_id, name)
time_entries(id, owner_id, title DEFAULT '', category_id→categories ON DELETE SET NULL,
  start_time, end_time NULL, duration_sec, note, created_at, updated_at)
  索引 (owner_id, start_time DESC)
  关键：唯一部分索引 (owner_id) WHERE end_time IS NULL  -- 每用户最多一条"正在计时"，防多端冲突
```
两表各 4 条 owner-only policy（SELECT/UPDATE/DELETE `USING (owner_id=auth.uid())`，INSERT `WITH CHECK`，UPDATE 两者都要），GRANT 给 `authenticated, anon`。客户端**永不传 owner_id**。

## 4. 目录与关键文件

| 路径 | 内容 |
|---|---|
| `web/index.html` `app.js` `style.css` | 网页版全部（计时/记录/统计/设置/`?widget=1` 圆形组件模式/快速标签/待补充筛选/`?widget=1&demo=1` 演示模式） |
| **`DESIGN.md`** | **桌面组件的设计系统文档**（token/几何/交互规格/Do-Don't/踩坑记录）——改组件前先读它 |
| `web/gsync.js` | Google Docs 同步引擎 + `diagnose()` 四步自检 |
| `web/setup-google.html` | 用户一次性 Google 配置引导（5 步） |
| `desktop/main.js` `preload.js` `package.json` | Electron 壳（窗口/穿透/拖动/菜单 IPC + 加载地址三档优先级） |
| `desktop/electron-builder.preview.yml` | 预览版打包配置（把 web/ 打进包，供离线试组件） |
| `desktop/gen-icon.js` | 纯 Node 生成 icon.ico（icon.ico 是二进制，可用它重新生成） |
| `website` 相关 | `miniprogram/` 原生小程序：login/timer/history/settings 四页 + utils/cloud.js（SDK `/miniprogram` 子路径 + 诊断适配器） |
| `.wbapp_*.genie` | WorkBuddy 应用注册标记（勿删，entryHtml 已设 web/index.html） |

---

## 5. 已验证的关键事实（不要重复验证，不要推翻）

1. **网页端可以共享 miniprogram 应用的云后端**（官方文档未写明，已实测：已发布域名下调 sendOtp 返回 verificationId、匿名查库被 RLS 正常拦截）
2. **Google token 端点支持浏览器 CORS**（实测 400/401 正常应答）——服务账号 JWT 流程在纯浏览器可行
3. 网页端云登录**只在已发布域名可用**，localhost/预览不行（服务端精确 Origin 匹配）；开发流程 = 本地改 → 发布 → 线上验证
4. 用户已完成 Google 一次性配置，同步管道**已打通**（2026-09-28 验证成功）
5. 网络：云后端国内可达无需代理；Google API 仅在同步瞬间需要代理，断档后下次成功同步自动全量补齐
6. **组件页面在圆外完全透明**（`html`/`body`/`#view-widget` 背景均为 `rgba(0,0,0,0)`，用 `elementFromPoint` 逐层验过）——看到"方形底色/方形阴影"一律先查窗口层与提示条，不要怀疑页面背景
7. **Electron 透明窗口的透明区域不会穿透点击**（官方明确限制）→ 必须用 `setIgnoreMouseEvents` 动态开关，见 `DESIGN.md` §5.1
8. **透明窗口 programmatic setSize 会留残影**（Windows）→ 组件已改为固定尺寸，见 `DESIGN.md` §4

## 6. 运维操作手册

### 6.1 发布网页（改完 web/ 必做）
用内置工具 `workbuddy_sites_deploy`（directory=`…/buddy小屋/web`，appName=时间追踪，domainPrefix=time-tracker，`miniProgramRequested: true`）。**发布=覆盖线上**，需用户当次确认。链接固定 `https://time-tracker-91208.app.workbuddy.host/`。
- **只改 web/ → 不用重打 exe**（组件加载线上代码）；**改了 desktop/（壳）→ 必须重打 exe**
- 2026-09-30 状态：线上仍是 v1.0 旧页面，多次发布均被平台拒绝（`暂时无法连接原发布环境`），待恢复后重发

### 6.2 打包桌面 exe
完整排障流程已沉淀为技能 `~/.workbuddy/skills/electron-builder-china/SKILL.md`，要点：
```bash
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
cd desktop && npx electron-builder --win portable                 # 正式版 → dist/时间追踪-桌面组件.exe
cd desktop && npx electron-builder --win portable --config electron-builder.preview.yml   # 预览版（含 web/ 副本）
```
**产物文件锁**：若用户正开着 exe，electron-builder 会报 `output file is locked for writing ... waiting for unlock` 并**无限等待**。判断是否被占用：`mv A B && mv B A`（能改名=已解锁）。让用户先关闭程序再打。
- winCodeSign 已手工预置到 `%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0`（符号链接权限问题，用 `7za x -snl` 解的）
- 结尾报 safe-delete/SAFE_DELETE_BULK_CONFIRM_REQUIRED 是 WorkBuddy 沙箱拦截清理的**假失败**，exe 已生成，勿重试
- 产物：`desktop/dist/时间追踪-桌面组件.exe`（74MB 便携版）

### 6.3 Git 工作流
- 本地 git 身份已配（repo 级 noreply 邮箱）；Git Credential Manager 已授权，**`git push` 免密**
- GitHub 连接器（MCP）对本账号**无建库/推送权限**（403），只用于只读查询；建新库让用户在 github.com/new 手动建
- `GIT_TERMINAL_PROMPT=0` 会禁掉 GCM 弹窗导致推送立即失败，调试时注意
- 节奏：每轮改动 commit；大版本打 tag（当前 v1.0.0）

### 6.4 小程序发布
**不要**用 sites_deploy。路径：对话中的小程序产物卡片 → 预览 → 右上角「分享/Share」→ 试用小程序（14 天）或绑定已有小程序。隐私清单 `miniprogram/.wbapp_*.privacy.json` 已写好（仅 Email 一项）。发布时机由用户决定（当前暂缓）。

## 7. 已知坑与禁忌

- **绝不**手写 fetch 调 `/.cloud/**`、绝不用 `@cloudbase/js-sdk`；云操作一律走 `@tencent-ai/workbuddy-cloud-sdk`（web 用 CDN `@dev` 版 `index.global.js`，小程序用 npm `/miniprogram` 子路径 + `createMiniProgramWorkBuddyCloud` + 诊断适配器）
- `publishableKey` 官方设计为可公开（无权限，服务端靠 Origin/Referer 校验）；Google 服务账号私钥/Doc ID 只存本机 localStorage，**绝不入库、不进代码**
- jsrsasign 失败时抛**字符串**而非 Error——异常兜底必须 `e.message || String(e)`，否则报错变"网络异常"（2026-09-28 真实事故）
- 小程序 npm 构建/云请求问题排查看 `references/mini-program/diagnostics.md` 的 vConsole 日志；不要 curl 固定网关判断可用性（未签名请求返回通用页是预期）
- playwright-cli 的 `open` 会话**不跨 Bash 调用**，验证步骤要串在一条命令里
- 后台任务的完成通知可能严重延迟（遇到过 6 小时），长任务日志落盘 + 主动检查产物，别干等

### 7.1 组件专属坑（都是实际踩过的，改动见 `DESIGN.md`）

- **SVG 默认 `overflow:hidden`**：任何"出界"的动效（如选中弧 `scale(1.12)`）会被 120×120 画布**切平**，看起来像"被一个方块遮住" → 需要 `#widget-ring { overflow: visible }`
- **`-webkit-app-region` 做拖动**：要求交互元素设 `no-drag`，结果只剩盘缘约 16px 能拖 → 新壳改为主进程手动拖动（`widget:drag-start/end`）
- **面板关闭后必须 `blur()` 面板内的输入框**：否则它仍持有焦点，"输入框聚焦时忽略滚轮"的守卫会一直生效 → 滚轮失灵
- **面板打开时不能用 toast 报错**（提示条与面板互斥、会被隐藏）→ 校验/错误走面板内联错误行 `.widget-panel-error`
- **改窗口尺寸 = 残影**：透明窗口 `setSize` 在 Windows 上会留缝/缺块 → 已固定尺寸，主进程 `FIXED_WINDOW` 门闩兜底
- **沙箱内无法启动 GUI**：Electron 进程能起来但页面不加载（本地服务无请求日志）→ 需要"看界面"的验证交给用户双击 exe
- **验证技巧**：用 playwright `run-code` + `addInitScript` **注入 mock `electronAPI`**（把 IPC 记进 `window.__ipc`），就能在浏览器里断言穿透/拖动等壳行为

## 8. 待办与路线（供接手者参考优先级）

1. **发布线上（最高优先）**：线上仍是 v1.0 旧页面，组件新交互/新壳都在本地完成却上不去；平台发布环境恢复后重发（发布前需用户当次确认）
2. **正式版 exe 装机**：`dist/时间追踪-桌面组件.exe` 已含新壳（穿透/拖动/固定尺寸），但需先发布线上页面才有意义（否则加载的是旧 UI）
3. **无暂停连续记录（用户明确的产品终局）**：24h 全时段有标签、没有"停止"；需要 win/mac/安卓/iOS/watch 端都能操作后再做。已预留三个扩展点：**原子切换**（关闭上一条+开启下一条同一时刻，消除毫秒间隙）、**跨天不断档**、**24h 覆盖率读数**
4. 小程序发布：工程已就绪（含快速标签），等用户决定时机
5. 同步引擎增强：失败后自动重试 + 每日定时补同步
6. Phase 4 候选：小程序统计页（ec-canvas）、多标签（`tags TEXT[]`）、RPC `stop_time_entry` 抗时钟偏移
7. NotebookLM Enterprise API 直连（等其 GA 且确认覆盖消费版笔记本后再评估）
8. 可选交互增强（已评估、成本低）：键盘等价（↑↓ 移选中、回车确认）、选中超时自动取消

## 9. 给用户的第一句话（接手 agent 开场建议）

先读第 1 节需求定位 + `DESIGN.md`（组件的设计系统与坑位记录），再用一句话向用户确认本轮要改什么；**不要**重新调研架构、不要提议换技术栈（Electron/WorkBuddy 云/Google Doc 桥接都是用户拍板过的）。改组件前先看 `DESIGN.md` §3.4/§3.5/§5 的交互规格，避免把已定原则推翻。
