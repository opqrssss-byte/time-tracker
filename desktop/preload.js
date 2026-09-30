const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  fixedSize: true,                                                          // 固定窗口：页面不要再调 resize
  resize: (height) => ipcRenderer.send('widget:resize', height),            // 旧协议：只改高度
  resizeTo: (width, height) => ipcRenderer.send('widget:resize', { width, height }), // 新协议
  openFull: () => ipcRenderer.send('widget:open-full'),
  menu: () => ipcRenderer.send('widget:menu'),
  onAddCat: (cb) => ipcRenderer.on('widget:add-cat', () => cb()),
  ignoreMouse: (ignore) => ipcRenderer.send('widget:ignore-mouse', ignore), // 点击穿透
  dragStart: () => ipcRenderer.send('widget:drag-start'),                   // 任意位置拖动
  dragEnd: () => ipcRenderer.send('widget:drag-end'),
})
