import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'url'
import * as path from 'path'
import { setupIpc } from './ipc.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let mainWindow
const isDev = !!process.env.VITE_DEV_SERVER_URL

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#0a0c10',
    darkTheme: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Explicit, not default-inherited: sandbox:true is the default only as
      // long as no nodeIntegration/offscreen weirdness is configured. Pin it
      // so an "upgrade" elsewhere cannot quietly unsandbox the renderer.
      sandbox: true,
    },
  })

  setupIpc()

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('Failed to load:', validatedURL, errorCode, errorDescription)
    if (isDev) {
      mainWindow.webContents.executeJavaScript(`
        document.body.innerHTML = \`
          <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#d7dde8;font-family:monospace;background:#0a0c10;padding:20px;text-align:center;">
            <div>
              <h2 style="color:#f87171;margin-bottom:16px;">Failed to load dev server</h2>
              <p style="color:#8a94a6;margin-bottom:8px;">URL: \${validatedURL}</p>
              <p style="color:#8a94a6;margin-bottom:24px;">Error: \${errorDescription} (code \${errorCode})</p>
              <button onclick="location.reload()" style="background:#34d399;color:#0a0c10;border:none;padding:12px 24px;border-radius:4px;cursor:pointer;font-family:monospace;font-size:14px;">
                Retry
              </button>
            </div>
          </div>
        \`
      `)
    }
  })

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    // loadURL() with a bare filesystem path is not a URL and fails with an
    // opaque ERR. loadFile() is the API that takes a path (and sets the right
    // file:// base for the SPA's relative asset URLs).
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})