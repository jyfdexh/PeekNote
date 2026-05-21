const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("peekNote", {
  loadStore: () => ipcRenderer.invoke("store:load"),
  saveStore: (store) => ipcRenderer.invoke("store:save", store),
  updateSettings: (settings) => ipcRenderer.invoke("settings:update", settings),
  expand: () => ipcRenderer.send("window:expand"),
  collapse: () => ipcRenderer.send("window:collapse"),
  toggle: () => ipcRenderer.send("window:toggle"),
  setPinned: (pinned) => ipcRenderer.send("window:set-pinned", pinned),
  setPanelActive: (active = true) => ipcRenderer.send("panel:set-active", active),
  resizeStart: (edge) => ipcRenderer.send("window:resize-start", edge),
  resizeMove: () => ipcRenderer.send("window:resize-move"),
  resizeEnd: () => ipcRenderer.send("window:resize-end"),
  openExternal: (url) => ipcRenderer.send("system:open-external", url),
  modeApplied: (mode) => ipcRenderer.send("window:mode-applied", mode),
  onModeChange: (callback) => ipcRenderer.on("window:mode", (_event, mode) => callback(mode)),
  onSettingsChanged: (callback) => ipcRenderer.on("settings:changed", (_event, payload) => callback(payload))
});
