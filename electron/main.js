const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let mainWindow;

async function startServer() {
  try {
    process.env.PORT = '3001';
    const serverPath = path.join(__dirname, '..', 'server', 'index.js');
    if (fs.existsSync(serverPath)) {
      await import(pathToFileURL(serverPath).href);
      console.log('[MossZip Desktop Backend] Express server loaded inside Electron runtime.');
    }
  } catch (err) {
    console.warn('[MossZip Desktop Backend Notice]:', err.message);
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
  const fallbackIcon = path.join(__dirname, '..', 'frontend', 'public', 'logo.png');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 1000,
    minHeight: 700,
    title: 'MossZip Studio',
    icon: fs.existsSync(iconPath) ? iconPath : fallbackIcon,
    backgroundColor: '#FFF7E2',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    }
  });

  const distPath = path.join(__dirname, '..', 'frontend', 'dist', 'index.html');

  if (fs.existsSync(distPath)) {
    mainWindow.loadFile(distPath);
  } else {
    mainWindow.loadURL('http://localhost:5173');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
