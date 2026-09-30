const { app, BrowserWindow, Menu, ipcMain, screen, session } = require('electron')
const fs = require('fs')
const path = require('path')

// 加载地址解析（三档优先级）：
//   1. 环境变量 WIDGET_URL（本地开发/临时指向任意页面）
//   2. 包内自带 web/ 副本 → 本地演示模式（预览版 exe，用样例数据、不连云端）
//   3. 线上正式地址
const LOCAL_DEMO = path.join(process.resourcesPath || '', 'web', 'index.html')
const IS_PREVIEW = !process.env.WIDGET_URL && app.isPackaged && fs.existsSync(LOCAL_DEMO)
const WIDGET_URL = process.env.WIDGET_URL || 'https://time-tracker-91208.app.workbuddy.host/?widget=1'

// 预览版与正式版并存：预览版用独立的 userData，避免单实例锁互相顶掉
if (IS_PREVIEW) app.setPath('userData', path.join(app.getPath('temp'), 'tt-widget-preview'))
const FULL_URL = 'https://time-tracker-91208.app.workbuddy.host/'
/* 固定窗口尺寸：圆盘 + 面板一次到位，**运行期不再 setSize**。
   原因：Windows 上透明窗口程序化改尺寸会让 backing store 只重绘变化区域，
   留下竖直缝 / 顶部缺块残影（2026-09-30 用户截图实测）。多出的透明区域靠点击穿透放行，无副作用。 */
const CAPSULE_W = 260
const CAPSULE_H = 380
const FIXED_WINDOW = true      // 固定窗口：主进程拒绝一切改尺寸请求（防旧线上页面触发 setSize 残影）
const STATE_FILE = path.join(app.getPath('userData'), 'widget-state.json')

let widgetWin = null
let fullWin = null
let sawPassthroughSignal = false   // 页面是否发过"点击穿透"信号（用于失败保护）
let passthroughGuard = null

/* ---------- 窗口位置持久化 ---------- */
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function saveState(patch) {
  const state = { ...loadState(), ...patch }
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)) } catch { /* 忽略 */ }
}

/* ---------- 单实例 ---------- */
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (widgetWin) widgetWin.show()
  })

  app.whenReady().then(() => {
    createWidget()

    ipcMain.on('widget:resize', (_e, payload) => {
      if (!widgetWin) return
      if (FIXED_WINDOW) return   // 固定窗口模式下忽略（页面已不再调用；旧页面调也无效，避免残影）
      // 兼容两种协议：数字 = 旧协议（只改高度）；对象 = 新协议 {width, height}
      const isObj = payload && typeof payload === 'object'
      const w = Math.max(140, Math.min(460, Number(isObj ? payload.width : CAPSULE_W) || CAPSULE_W))
      const h = Math.max(72, Math.min(520, Number(isObj ? payload.height : payload) || CAPSULE_H))
      widgetWin.setSize(w, h, true)
    })

    ipcMain.on('widget:open-full', () => openFull())

    /* 点击穿透：透明区域默认放行给桌面（否则窗口矩形会挡住下方/右侧的点击）。
       指针进入可交互区域（圆盘/面板）时由渲染进程发 false 关闭穿透。 */
    ipcMain.on('widget:ignore-mouse', (_e, ignore) => {
      if (!widgetWin) return
      sawPassthroughSignal = true
      widgetWin.setIgnoreMouseEvents(!!ignore, { forward: true })
    })

    /* 任意位置拖动：按下即在主进程按光标位移移动窗口。
       比 app-region 更可控，且不会与环上的点击/滚轮/悬停冲突（app-region 需把环设为 no-drag，
       那正是"只有盘缘能动"的原因）。 */
    let dragTimer = null
    let dragOffset = { x: 0, y: 0 }
    const stopDrag = () => {
      if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
    }
    ipcMain.on('widget:drag-start', () => {
      if (!widgetWin) return
      widgetWin.setIgnoreMouseEvents(false)
      const cur = screen.getCursorScreenPoint()
      const [wx, wy] = widgetWin.getPosition()
      dragOffset = { x: cur.x - wx, y: cur.y - wy }
      stopDrag()
      dragTimer = setInterval(() => {
        if (!widgetWin) return
        const p = screen.getCursorScreenPoint()
        widgetWin.setPosition(p.x - dragOffset.x, p.y - dragOffset.y)
      }, 16)
    })
    ipcMain.on('widget:drag-end', stopDrag)

    ipcMain.on('widget:menu', () => {
      const autoLaunch = app.getLoginItemSettings().openAtLogin
      const menu = Menu.buildFromTemplate([
        { label: '打开完整版', click: () => openFull() },
        { label: '新增分类', click: () => { if (widgetWin) widgetWin.webContents.send('widget:add-cat') } },
        { type: 'separator' },
        {
          label: '开机自启',
          type: 'checkbox',
          checked: autoLaunch,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ])
      menu.popup({ window: widgetWin })
    })
  })

  app.on('window-all-closed', () => {
    // 胶囊关闭即退出（右键菜单也有退出项）
    app.quit()
  })
}

/* ---------- 胶囊悬浮窗 ---------- */
function createWidget() {
  const state = loadState()
  const workArea = screen.getPrimaryDisplay().workAreaSize
  const x = state.x != null ? state.x : workArea.width - CAPSULE_W - 20
  const y = state.y != null ? state.y : workArea.height - CAPSULE_H - 90

  widgetWin = new BrowserWindow({
    width: CAPSULE_W,
    height: CAPSULE_H,
    x, y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',   // 明确透明底色，避免平台默认底色把圆盘渲染成方块
    roundedCorners: false,          // 禁止系统在窗口层再加圆角/阴影（那会在圆盘外露一圈方形硬边）
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      session: session.fromPartition('persist:timetracker'),
    },
  })

  widgetWin.setAlwaysOnTop(true, 'screen-saver')
  widgetWin.setVisibleOnAllWorkspaces(true)
  widgetWin.setBackgroundColor('#00000000')   // 再显式声明一次透明底色，防平台默认底色把窗口画成方块
  // 启动即进入穿透状态；指针进入圆盘时渲染进程会立刻发 false 关闭（forward:true 保证仍能收到 mousemove）
  widgetWin.setIgnoreMouseEvents(true, { forward: true })
  /* 失败保护：页面加载完 3 秒内若没收到过穿透信号（线上仍是旧页面、脚本报错等），
     就退回"可交互"。否则"新壳 + 旧页面"会让整个组件点不动。 */
  widgetWin.webContents.on('did-finish-load', () => {
    sawPassthroughSignal = false
    if (passthroughGuard) clearTimeout(passthroughGuard)
    passthroughGuard = setTimeout(() => {
      if (!sawPassthroughSignal && widgetWin) widgetWin.setIgnoreMouseEvents(false)
    }, 3000)
  })
  if (IS_PREVIEW) widgetWin.loadFile(LOCAL_DEMO, { search: 'widget=1&demo=1' })
  else widgetWin.loadURL(WIDGET_URL)

  widgetWin.on('moved', () => {
    if (!widgetWin) return
    const [wx, wy] = widgetWin.getPosition()
    saveState({ x: wx, y: wy })
  })

  widgetWin.on('closed', () => { widgetWin = null })
}

/* ---------- 完整版窗口 ---------- */
function openFull() {
  if (fullWin) {
    fullWin.focus()
    return
  }
  fullWin = new BrowserWindow({
    width: 1100,
    height: 820,
    title: '时间追踪',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      session: session.fromPartition('persist:timetracker'),
    },
  })
  fullWin.loadURL(FULL_URL)
  fullWin.on('closed', () => { fullWin = null })
}
