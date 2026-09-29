# 时间追踪 Time Tracker

点一下就计时的时间追踪工具：桌面悬浮组件 + 网页版 + 微信小程序，云端多端同步，并把时间数据自动喂给 NotebookLM（作为个人 AI 笔记本的行为信源）。

## 组成

| 目录 | 说明 |
|---|---|
| `web/` | 网页版：计时 / 记录（编辑·待补充）/ 统计图表 / CSV·Excel 导出 / NotebookLM 同步设置 / Google 配置引导页 |
| `desktop/` | Electron 桌面悬浮胶囊：置顶常驻、单击开始/停止、停止后快速打标签、右键菜单（开机自启等） |
| `miniprogram/` | 微信小程序：计时 / 快速标签 / 记录 / 分类管理 |

## 架构

- 三端共用同一云后端（WorkBuddy 云服务：云数据库 + 邮箱验证码认证），计时状态存云端，时长 = 当前时间 − 开始时间戳，关页面/换设备不中断
- `web/gsync.js` 同步引擎：GCP 服务账号自签 JWT → Google Docs API，把时间日志全量写入指定 Google Doc，NotebookLM 将该 Doc 挂载为来源（Source）即可获得最新行为上下文
- 桌面组件加载线上网页的 `?widget=1` 胶囊模式，UI 与逻辑零重复

## 安全说明

- 代码中的云 `publishableKey` 为官方设计的公开密钥，仅标识应用、不含任何权限
- Google 服务账号私钥与 Doc ID 仅存用户本机 localStorage，不在本仓库
- `desktop/icon.ico` 可由 `desktop/gen-icon.js` 重新生成（纯 Node 无依赖）
