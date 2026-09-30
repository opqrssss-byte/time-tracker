# 桌面组件打包说明（Windows）

> 这份文档把原先只存在于**本机技能目录**（`~/.workbuddy/skills/electron-builder-china/`）的打包排障经验落进仓库，
> 保证换机器 / 换 agent 后仍能独立完成 exe 打包。**产物（`desktop/dist/**`）不入库，需本地构建。**

## 命令

```bash
cd desktop

# 国内网络必须设这两个镜像，否则 electron 运行时下载会被代理拦成 Bad Gateway
export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

npx electron-builder --win portable                                      # 正式版 → dist/时间追踪-桌面组件.exe
npx electron-builder --win portable --config electron-builder.preview.yml # 预览版 → dist/时间追踪-本地预览.exe
```

两种产物的区别：

| 产物 | 加载什么 | 用途 |
|---|---|---|
| `时间追踪-桌面组件.exe` | 线上页面（`WIDGET_URL`） | 正式使用；**改网页端不用重打它**，改 `desktop/` 才要 |
| `时间追踪-本地预览.exe` | 包内 `resources/web/` 副本（`?widget=1&demo=1`） | 离线试组件外观与交互，不连云端、不依赖发布 |

## 四个已知坑（按出现顺序）

### 1. Electron 运行时下载失败（Bad Gateway）
electron-builder **不从 `node_modules/electron/dist` 复用**，而是自己从 github.com 下载运行时 zip → 被网关拦。
设上面那两个 `*_MIRROR` 环境变量即可。

### 2. winCodeSign 解压报"客户端没有所需的特权"（符号链接）
`winCodeSign-*.7z` 内含 darwin 符号链接，Windows 非开发者模式无法创建。**手工预置缓存**跳过自动下载解压：

```bash
CACHE="$LOCALAPPDATA/electron-builder/Cache/winCodeSign"
curl -sL -o "$CACHE/wcs.7z" "https://npmmirror.com/mirrors/electron-builder-binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z"
rm -rf "$CACHE/winCodeSign-2.6.0" "$CACHE/648066799"                     # 清掉失败残留
"<项目>/desktop/node_modules/7zip-bin/win/x64/7za.exe" x -bd -snl "$CACHE/wcs.7z" -o"$CACHE/winCodeSign-2.6.0"
rm "$CACHE/wcs.7z"
```
关键：`7za` 加 `-snl`（不恢复符号链接）；退出码 2 只是跳过 symlink 的警告——目录里只要有 `rcedit-x64.exe` 等 Windows 文件就够。
目录名必须是 `winCodeSign-2.6.0`，electron-builder 检测到已存在就跳过下载。

### 3. 结尾报 safe-delete / SAFE_DELETE_BULK_CONFIRM_REQUIRED（**假失败**）
WorkBuddy 沙箱的 safe-delete shim 会拦截 electron-builder 的收尾清理（删 nsis 中间包），EXIT=1 且堆栈指向 `node-safe-delete-shim.cjs`。
**此时最终 exe 已经生成**：检查 `dist/*.exe` 存在即为成功，手工删掉中间文件（`*-x64.nsis.7z`、`builder-debug.yml`）即可，**不要当成构建失败重试**。

### 4. `output file is locked for writing ... waiting for unlock`（会无限等待）
目标 exe 被占用（**用户正开着它**，或杀毒软件正在扫描）。electron-builder 会一直等，进程假死。
判断是否被占用（能改名=已解锁）：

```bash
cd desktop && mv "dist/时间追踪-桌面组件.exe" dist/_p.exe && mv dist/_p.exe "dist/时间追踪-桌面组件.exe"
```
解决：让用户先关闭组件窗口再打包。

## 打包相关的架构约定（改壳前必读）

- **固定窗口**：`CAPSULE_W/H = 260×380`，运行期**绝不 `setSize`**（透明窗口程序化改尺寸会在 Windows 留残影，见 `DESIGN.md` §4.1）。主进程有 `FIXED_WINDOW` 门闩。
- **加载地址三档优先级**：`WIDGET_URL` 环境变量 → 包内 `resources/web/index.html`（预览版）→ 线上地址。
  预览版因此可用 `WIDGET_URL="http://127.0.0.1:8899/index.html?widget=1&demo=1"` 指向本地服务调试。
- **壳能力用能力探测而非版本号**：页面靠 `electronAPI.fixedSize / dragStart / ignoreMouse` 判断壳是否支持新能力，
  旧壳（无这些字段）自动回退到 `-webkit-app-region` 拖动与 `resize` 协议。
- **icon**：`icon.ico` 已入库；需要重新生成时用纯 Node 脚本 `node gen-icon.js`（手画像素 → zlib 编 PNG → 包 ICO 头）。
- 后台构建建议 `> builder.log 2>&1` 落盘：管道接 `| tail` 会吞掉实时输出、进程假死时难诊断。
