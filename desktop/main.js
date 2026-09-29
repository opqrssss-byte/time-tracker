const { app, BrowserWindow, Menu, ipcMain, screen, session } = require('electron')
const fs = require('fs')
const path = require('path')

const WIDGET_URL = 'https://time-tracker-91208.app.workbuddy.host/?widget=1'
const FULL_URL = 'https://time-tracker-91208.app.workbuddy.host/'
const CAPSULE_W = 260
const CAPSULE_H = 130
const STATE_FILE = path.join(app.getPath('userData'), 'widget-state.json')

let widgetWin = null
let fullWin = null

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
      // 兼容两种协议：数字 = 旧协议（只改高度）；对象 = 新协议 {width, height}
      const isObj = payload && typeof payload === 'object'
      const w = Math.max(200, Math.min(400, Number(isObj ? payload.width : CAPSULE_W) || CAPSULE_W))
      const h = Math.max(72, Math.min(500, Number(isObj ? payload.height : payload) || CAPSULE_H))
      widgetWin.setSize(w, h, true)
    })

    ipcMain.on('widget:open-full', () => openFull())

    ipcMain.on('widget:menu', () => {
      const autoLaunch = app.getLoginItemSettings().openAtLogin
      const menu = Menu.buildFromTemplate([
        { label: '打开完整版', click: () => openFull() },
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
  widgetWin.loadURL(WIDGET_URL)

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
