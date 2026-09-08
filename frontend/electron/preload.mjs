import { contextBridge, ipcRenderer } from 'electron'

// The old version called `window.electron.ipcRenderer.invoke('ping')` — but
// `window.electron` is never created (there is no `electron` global in a
// contextIsolation renderer), so the only exposed function threw on use.
// Correct pattern: import ipcRenderer HERE (trusted preload) and expose
// narrow wrappers on the other side of the bridge.
contextBridge.exposeInMainWorld('opentermElectron', {
  ping: () => ipcRenderer.invoke('ping'),
})
