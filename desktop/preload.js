const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  resize: (height) => ipcRenderer.send('widget:resize', height),            // 旧协议：只改高度
  resizeTo: (width, height) => ipcRenderer.send('widget:resize', { width, height }), // 新协议
  openFull: () => ipcRenderer.send('widget:open-full'),
  menu: () => ipcRenderer.send('widget:menu'),
})
