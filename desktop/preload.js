const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  resize: (height) => ipcRenderer.send('widget:resize', height),
  openFull: () => ipcRenderer.send('widget:open-full'),
  menu: () => ipcRenderer.send('widget:menu'),
})
