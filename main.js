const { spawn } = require('child_process');
const fs = require('fs');
const electron = require('electron');
const { Menu } = electron;
const path = require('path');

// Handle environments where ELECTRON_RUN_AS_NODE may be set (e.g., system env).
if (!electron.app || process.env.ELECTRON_RUN_AS_NODE) {
  if (process.env.ELECTRON_RUN_AS_NODE) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(process.execPath, process.argv.slice(1), {
      env,
      detached: true,
      stdio: 'ignore'
    });
  } else {
    console.error('Electron not available; check environment.');
  }
  process.exit(0);
}

const { app, BrowserWindow } = electron;

function getWindowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  const statePath = getWindowStatePath();
  const defaults = { width: 1400, height: 900 };

  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const data = JSON.parse(raw);
    const state = { ...defaults };
    ['x', 'y', 'width', 'height'].forEach((key) => {
      if (Number.isFinite(data[key])) {
        state[key] = data[key];
      }
    });
    return state;
  } catch (_err) {
    return defaults;
  }
}

function saveWindowState(win) {
  if (!win) return;
  const statePath = getWindowStatePath();
  const bounds = win.getNormalBounds();

  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(bounds));
  } catch (_err) {
    // Persisting window state failed; continue without throwing.
  }
}

// Reduce background throttling for live tiles.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
Menu.setApplicationMenu(null);

function createWindow() {
  const windowState = loadWindowState();
  const win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    backgroundColor: '#0f1115',
    title: 'Thore',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('close', () => {
    saveWindowState(win);
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
