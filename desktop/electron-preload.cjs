// 预加载脚本：向页面暴露安全的桌面能力（打开目录等）
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopAPI', {
  isElectron: true,
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  getPort: () => ipcRenderer.invoke('get-port'),
});