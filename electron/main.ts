import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawn } from 'node:child_process'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.js
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null
let pythonProcess: any = null

function startPythonBackend() {
  const isPackaged = app.isPackaged;
  let backendPath: string;
  
  if (isPackaged) {
    // When packaged, the backend folder is in extraResources (Resources/backend)
    backendPath = path.join(process.resourcesPath, 'backend', 'server');
    
    // Check if the binary exists, if not, try alternative path (sometimes Nuitka keeps the .dist folder structure)
    if (!fs.existsSync(backendPath)) {
      const altPath = path.join(process.resourcesPath, 'backend', 'server.dist', 'server');
      if (fs.existsSync(altPath)) {
        backendPath = altPath;
      } else {
        console.error(`Backend binary not found at:\n1: ${backendPath}\n2: ${altPath}`);
      }
    }
    
    console.log(`Spawning packaged backend: ${backendPath}`);
    pythonProcess = spawn(backendPath, [], { stdio: 'pipe' });
  } else {
    // In dev mode, spawn using local python environment
    const scriptPath = path.join(process.env.APP_ROOT, 'backend', 'server.py');
    const venvPythonPath = path.join(process.env.APP_ROOT, 'venv', 'bin', 'python');
    
    // Prefer venv python if it exists, otherwise fallback to system 'python'
    const pythonExe = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';
    
    console.log(`Spawning dev backend: ${pythonExe} ${scriptPath}`);
    pythonProcess = spawn(pythonExe, [scriptPath], { stdio: 'pipe' });
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
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
}

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

app.whenReady().then(() => {
  startPythonBackend()
  createWindow()
})
