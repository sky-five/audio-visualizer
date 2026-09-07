const { app, BrowserWindow, desktopCapturer, session, ipcMain, protocol, net, screen } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

let mainWindow;

// "Fullscreen" here is simulated by sizing the borderless window to cover
// the whole display, rather than using BrowserWindow's native setFullScreen().
// On Windows, toggling native fullscreen off on a frame:false window fires
// enter-full-screen/leave-full-screen events that lag or double-fire well
// behind the actual isFullScreen() state, so a renderer listening for them
// ends up applying the wrong UI state. Tracking our own boolean and sizing
// the window directly avoids that entirely — no OS event round-trip needed.
let bigMode = true;
const WINDOWED_WIDTH = 1280;
const WINDOWED_HEIGHT = 800;

// file:// pages get a null/opaque security origin, which Chromium's
// MediaStreamManager rejects for desktop-capture requests ("Renderer
// requested a URL it's not allowed to use: null"). Serving the renderer
// from a custom standard+secure scheme instead gives it a real origin.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

function bigModeBounds(display) {
  return { ...display.bounds };
}

function windowedModeBounds(display) {
  const { x, y, width, height } = display.workArea;
  return {
    x: x + Math.round((width - WINDOWED_WIDTH) / 2),
    y: y + Math.round((height - WINDOWED_HEIGHT) / 2),
    width: WINDOWED_WIDTH,
    height: WINDOWED_HEIGHT,
  };
}

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  mainWindow = new BrowserWindow({
    ...bigModeBounds(primary),
    frame: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      // Local-only app, no remote content is ever loaded, so it's safe to
      // require() npm packages (butterchurn, butterchurn-presets) directly
      // from the renderer instead of standing up a bundler.
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  // The constructor's own width/height/x/y get clamped to the work area
  // (excluding the taskbar) on Windows; an explicit setBounds() afterward
  // applies the full display bounds correctly.
  mainWindow.setBounds(bigModeBounds(primary));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL('app://bundle/renderer/index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('fullscreen-changed', bigMode);
  });

  // alwaysOnTop is what lets big mode cover the taskbar (there's no real OS
  // fullscreen involved), but staying topmost while unfocused would mean an
  // Alt-Tabbed-to app renders hidden behind us. Only stay on top while we
  // actually have focus, so switching away works like a normal window.
  mainWindow.on('blur', () => {
    if (bigMode) mainWindow.setAlwaysOnTop(false);
  });
  mainWindow.on('focus', () => {
    if (bigMode) mainWindow.setAlwaysOnTop(true);
  });

  if (process.env.AV_DEBUG_LOG) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[renderer] ${message} (${sourceId}:${line})`);
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.log('[renderer] gone', details);
    });
  }
}

app.whenReady().then(() => {
  // Serves from the project root (not just renderer/) so the renderer can
  // also pull node_modules packages, like butterchurn, through this same
  // origin — importing a raw file:// URL from an app:// page would otherwise
  // be blocked as cross-origin.
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const filePath = path.join(__dirname, decodeURIComponent(pathname));
    return net.fetch(pathToFileURL(filePath).href);
  });

  // Enables system audio loopback capture: when the renderer calls
  // getDisplayMedia({audio: true, video: true}), respond with the primary
  // screen plus 'loopback' audio instead of showing an OS picker dialog.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    });
  }, { useSystemPicker: false });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on('quit-app', () => {
  app.quit();
});

ipcMain.on('toggle-fullscreen', () => {
  if (!mainWindow) return;
  bigMode = !bigMode;
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  mainWindow.setBounds(bigMode ? bigModeBounds(display) : windowedModeBounds(display));
  mainWindow.setAlwaysOnTop(bigMode);
  mainWindow.webContents.send('fullscreen-changed', bigMode);
});

ipcMain.on('move-to-next-display', () => {
  if (!mainWindow) return;
  const displays = screen.getAllDisplays();
  if (displays.length < 2) return;

  const currentDisplay = screen.getDisplayMatching(mainWindow.getBounds());
  const currentIndex = displays.findIndex((d) => d.id === currentDisplay.id);
  const next = displays[(currentIndex + 1) % displays.length];
  mainWindow.setBounds(bigMode ? bigModeBounds(next) : windowedModeBounds(next));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
