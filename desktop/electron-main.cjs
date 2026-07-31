// Electron 外壳：启动本地服务 + 桌面窗口（Chrome 窗口模式的进阶版，可选）
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = process.env.ZDXR_PORT || '4879';
const here = __dirname;
let serverChild = null;
let win = null;

function startServer() {
  serverChild = spawn(process.execPath, [path.join(here, 'server.mjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZDXR_PORT: PORT },
    stdio: 'inherit',
    windowsHide: true,
  });
  serverChild.on('exit', () => { serverChild = null; });
}

function serverReady() {
  return fetch(`http://127.0.0.1:${PORT}/api/state`).then((r) => r.ok).catch(() => false);
}

async function waitServer(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await serverReady()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '明日方舟 Spine 自动动画工作室',
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: path.join(here, 'electron-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/ui/`);
  win.on('closed', () => { win = null; });
}

ipcMain.handle('open-path', async (_e, p) => {
  if (!p) return { ok: false, error: 'no path' };
  const err = await shell.openPath(String(p));
  return { ok: !err, error: err || '' };
});
ipcMain.handle('get-port', () => PORT);

app.whenReady().then(async () => {
  startServer();
  const ok = await waitServer();
  if (!ok) {
    console.error('[electron] 本地服务启动失败');
    app.exit(1);
    return;
  }
  createWindow();
  if (process.argv.includes('--smoke')) {
    win.webContents.once('did-finish-load', () => {
      console.log('SMOKE OK');
      setTimeout(() => app.exit(0), 1500);
    });
    return;
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverChild) { try { serverChild.kill(); } catch {} }
  app.quit();
});