import { BrowserWindow, app } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";
//#region electron/main.ts
var __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.APP_ROOT = path.join(__dirname, "..");
var VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
var MAIN_DIST = path.join(process.env.APP_ROOT, "dist-electron");
var RENDERER_DIST = path.join(process.env.APP_ROOT, "dist");
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, "public") : RENDERER_DIST;
var win;
var pythonProcess = null;
function startPythonBackend() {
	if (app.isPackaged) pythonProcess = spawn(path.join(process.resourcesPath, "backend", "server"), [], { stdio: "pipe" });
	else {
		const backendPath = path.join(process.env.APP_ROOT, "backend", "server.py");
		const venvPythonPath = path.join(process.env.APP_ROOT, "venv", "bin", "python");
		pythonProcess = spawn(fs.existsSync(venvPythonPath) ? venvPythonPath : "python", [backendPath], { stdio: "pipe" });
	}
	pythonProcess.stdout.on("data", (data) => {
		console.log(`[Python]: ${data}`);
	});
	pythonProcess.stderr.on("data", (data) => {
		console.error(`[Python API]: ${data}`);
	});
}
function createWindow() {
	win = new BrowserWindow({
		width: 1400,
		height: 1e3,
		icon: path.join(process.env.VITE_PUBLIC, "vite.svg"),
		webPreferences: {
			preload: path.join(__dirname, "preload.mjs"),
			nodeIntegration: true,
			contextIsolation: false
		}
	});
	if (VITE_DEV_SERVER_URL) win.loadURL(VITE_DEV_SERVER_URL);
	else win.loadFile(path.join(RENDERER_DIST, "index.html"));
}
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
		win = null;
	}
});
app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("will-quit", () => {
	if (pythonProcess) pythonProcess.kill();
});
app.whenReady().then(() => {
	startPythonBackend();
	createWindow();
});
//#endregion
export { MAIN_DIST, RENDERER_DIST, VITE_DEV_SERVER_URL };
