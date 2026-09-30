# 时间追踪 Time Tracker

点一下就计时的时间追踪工具：**桌面圆形悬浮组件** + 网页版 + 微信小程序，云端多端同步，并把时间数据自动喂给 NotebookLM（作为个人 AI 笔记本的行为信源）。

## 从这里开始

| 你的身份 | 先读 |
|---|---|
| **刚克隆仓库 / 换了台电脑** | [`docs/SETUP-NEW-MACHINE.md`](docs/SETUP-NEW-MACHINE.md) —— 环境准备、本地跑起来、改完怎么验证、发布与凭据恢复 |
| **接手开发（AI agent 或人）** | [`HANDOFF.md`](HANDOFF.md) —— 需求定位、架构、数据库、已验证事实、运维手册、已知坑 |
| **要改桌面组件** | [`DESIGN.md`](DESIGN.md) —— 组件设计系统（token/几何/交互规格/Do-Don't/踩坑） |
| **要打包 exe** | [`desktop/PACKAGING.md`](desktop/PACKAGING.md) —— 国内网络打包的四个坑与命令 |

## 组成

| 目录 | 说明 |
|---|---|
| `web/` | 网页版：计时 / 记录（编辑·待补充）/ 统计图表 / CSV·Excel 导出 / NotebookLM 同步设置 / Google 配置引导页 |
| `desktop/` | Electron 悬浮组件（**圆形玻璃盘 + 环形色块**）：置顶常驻、**滚轮沿环选分类 → 停顿自动换标签**、点击开始/停止、快速标签、右键菜单（完整版/新增分类/开机自启/退出） |
| `miniprogram/` | 微信小程序：计时 / 快速标签 / 记录 / 分类管理 |
| `tools/` | 开发工具：`widget-selftest.js` 组件交互自测脚本（改组件后跑一遍） |
| `docs/` | 补充文档与界面截图 |

## 架构

- 三端共用同一云后端（WorkBuddy 云服务：云数据库 + 邮箱验证码认证），计时状态存云端，时长 = 当前时间 − 开始时间戳，关页面/换设备不中断
- `web/gsync.js` 同步引擎：GCP 服务账号自签 JWT → Google Docs API，把时间日志全量写入指定 Google Doc，NotebookLM 将该 Doc 挂载为来源（Source）即可获得最新行为上下文
- 桌面组件加载线上网页的 `?widget=1` 组件模式（UI 与逻辑零重复）；带 `&demo=1` 时用样例数据本地渲染，**不连云端、不依赖发布**，用于离线试组件
- Electron 壳提供页面拿不到的能力：点击穿透（透明区不挡桌面点击）、任意位置拖动、固定窗口尺寸；页面用 `electronAPI.fixedSize / dragStart / ignoreMouse` 能力探测，旧壳自动回退

## 本地预览（30 秒上手）

```bash
python -m http.server 8899          # 在仓库根目录执行
# 完整版：   http://localhost:8899/web/index.html
# 组件外观： http://localhost:8899/web/index.html?widget=1&demo=1
```

## 安全说明

- 代码中的云 `publishableKey` 为官方设计的公开密钥，仅标识应用、不含任何权限
- Google 服务账号私钥与 Doc ID 仅存用户本机 localStorage，**不在本仓库**
- `desktop/icon.ico` 可由 `desktop/gen-icon.js` 重新生成（纯 Node 无依赖）
- `.workbuddy/applications.yaml` 记录"发布应用 ↔ 目录"绑定（含平台应用 ID，非密钥），**故意入库**以免换机后发布到新应用、导致分享链接与云登录域变更
