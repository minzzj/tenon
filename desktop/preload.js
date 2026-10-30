// 榫卯超级终端 · preload：仅暴露安全只读信息与桌面动作
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tenonDesktop', {
  isDesktop: true,
  getState: () => ipcRenderer.invoke('desktop:getState'),
  screenCapture: undefined,
  toggleVoice: () => ipcRenderer.invoke('desktop:toggleVoice'),
  getToken: () => ipcRenderer.invoke('desktop:getToken'),
  toggleScreen: () => ipcRenderer.invoke('desktop:toggleScreen'),
  generateDiary: () => ipcRenderer.invoke('desktop:generateDiary'),
  onState: (cb) => { if (typeof cb === 'function') ipcRenderer.on('desktop:state', (_e, s) => cb(s)); },
});
// 悬浮快捷录音按钮专用
contextBridge.exposeInMainWorld('tenonQuick', {
  toggle: () => ipcRenderer.invoke('quick:toggle'),
  getStatus: () => ipcRenderer.invoke('quick:getStatus'),
  hide: () => ipcRenderer.invoke('quick:hide'),
  onStatus: (cb) => { if (typeof cb === 'function') ipcRenderer.on('quick:status', (_e, s) => cb(s)); },
});
