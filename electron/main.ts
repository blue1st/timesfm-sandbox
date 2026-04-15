import { app, BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:net'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.APP_ROOT = path.join(__dirname, '..')

export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null
let pythonProcess: any = null
let backendPort: number = 8000 // Default fallback

// Helper to find a free port
async function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port
      server.close(() => resolve(port))
    })
  })
}

async function startPythonBackend() {
  backendPort = await getFreePort();
  console.log(`Assigned dynamic port: ${backendPort}`);

  const isPackaged = app.isPackaged;
  let backendPath: string;
  
  const env = { ...process.env, PORT: backendPort.toString() };

  if (isPackaged) {
    backendPath = path.join(process.resourcesPath, 'backend', 'server');
    console.log(`Spawning packaged backend: ${backendPath} on port ${backendPort}`);
    pythonProcess = spawn(backendPath, [], { env, stdio: 'pipe' });
  } else {
    const scriptPath = path.join(process.env.APP_ROOT, 'backend', 'server.py');
    const venvPythonPath = path.join(process.env.APP_ROOT, 'venv', 'bin', 'python');
    const pythonExe = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';
    
    console.log(`Spawning dev backend: ${pythonExe} ${scriptPath} on port ${backendPort}`);
    pythonProcess = spawn(pythonExe, [scriptPath], { env, stdio: 'pipe' });
  }

  pythonProcess.on('error', (err: Error) => {
    console.error(`Failed to start backend process: ${err.message}`);
  });

  pythonProcess.stdout.on('data', (data: any) => {
    console.log(`[Python]: ${data}`);
  });
  
  pythonProcess.stderr.on('data', (data: any) => {
    console.error(`[Python API]: ${data}`);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 1000,
    icon: path.join(process.env.VITE_PUBLIC, 'vite.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

// IPC handler to return the backend port
ipcMain.handle('get-port', () => backendPort)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('will-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill();
  }
})

app.whenReady().then(async () => {
  await startPythonBackend()
  createWindow()
})
