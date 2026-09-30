# 微信小程序：构建与排障

> 原生小程序（`miniprogram/`），与网页版共用同一个 WorkBuddy 云后端（同一份 `endpoint` + `publishableKey`）。
> 后端与账号体系说明见根目录 `HANDOFF.md` §2 / §3。

## 构建与运行

1. 用**微信开发者工具**打开 `miniprogram/` 目录
2. 首次需执行 **工具 → 构建 npm**（`miniprogram/utils/cloud.js` 引用的是 SDK 的 `/miniprogram` 子路径，不构建会报模块找不到）
3. 预览可用**试用小程序**（无需 AppID）；正式发布走应用面板的「分享/Share → 发布小程序」

## 四个已知坑

1. **不要手写 `fetch` 调 `/.cloud/**`，也不要用 `@cloudbase/js-sdk`**
   云操作一律走 `@tencent-ai/workbuddy-cloud-sdk` 的 `/miniprogram` 子路径 + `createMiniProgramWorkBuddyCloud` + `utils/cloud.js` 里的诊断适配器。
2. **不要把 `owner_id` 传给云端**：数据库是 owner-only RLS（`owner_id DEFAULT auth.uid()`），客户端传了反而会 403。
3. **排障看 vConsole 日志**，不要用 `curl` 固定网关判断可用性：未签名请求返回通用页是**预期行为**，据此判断"服务挂了"会误判。
4. **登录只用邮箱验证码**，绝不做微信登录：微信登录会产生不同的 uid，导致同一人的数据分裂（平台没有账号绑定能力）。

## 与迁移相关的提醒

- 换机器克隆后：本目录的 `node_modules/` 不在仓库里，需在开发者工具里重新「构建 npm」
- 小程序的发布**不走 `workbuddy_sites_deploy`**（那条路只发布网页）——详见 `HANDOFF.md` §6.4
