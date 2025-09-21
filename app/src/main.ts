// app/src/main.ts
import { app, BrowserWindow } from 'electron'
import path from 'node:path'

async function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 780,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // __dirname is available in CJS output, so we can use it after build
await win.loadFile(path.join(__dirname, 'index.html'))
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
