import { ipcMain } from 'electron'

export function setupIpc() {
  ipcMain.handle('ping', () => 'pong')
}