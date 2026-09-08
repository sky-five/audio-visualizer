const { app, BrowserWindow, desktopCapturer, session, ipcMain, protocol, net, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// GPU preference: on hybrid-graphics laptops (Intel iGPU + NVIDIA/AMD dGPU),
// Chromium/Electron defaults to the low-power integrated GPU. This visualizer
// is GPU-bound (WebGL2 fragment shaders driving the full canvas every frame),
// so it should prefer the discrete GPU when one exists. Must be set before
// app.whenReady() — these are Chromium command-line switches, not runtime APIs.
app.commandLine.appendSwitch('force_high_performance_gpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

let mainWindow;

// Some community Butterchurn presets don't throw a catchable error at all —
// their eel-wasm expressions or shaders just hang the renderer's JS thread
// synchronously (observed firsthand: "_Geiss - untitled" freezes the
// renderer solid, no crash, no exception, nothing recoverable from inside
// the renderer itself). Recovery has to come from the main process, via
// Chromium's own unresponsive-page detection, and the offending preset gets
// permanently blacklisted (persisted to disk) so it's never loaded again.
let blacklistPath;
let presetBlacklist = new Set();
function persistBlacklist() {
  try {
    fs.mkdirSync(path.dirname(blacklistPath), { recursive: true });
    fs.writeFileSync(blacklistPath, JSON.stringify([...presetBlacklist]));
  } catch (err) {
    console.error('failed to persist preset blacklist:', err.message);
  }
}

let lastAttemptedPreset = null;
let lastAttemptedAt = 0;

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

  // A handful of community Butterchurn presets are buggy enough to crash the
  // GPU/renderer process outright rather than throw a catchable JS error
  // (renderer.js guards against the catchable kind). If that happens, just
  // recreate the window instead of leaving the app silently dead.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (process.env.AV_DEBUG_LOG) console.log('[renderer] gone', details);
    if (details.reason !== 'clean-exit') {
      if (lastAttemptedPreset && Date.now() - lastAttemptedAt < 10000) {
        presetBlacklist.add(lastAttemptedPreset);
        persistBlacklist();
      }
      lastAttemptedPreset = null;
      mainWindow = null;
      createWindow();
    }
  });

  // Some other presets hang the renderer's JS thread outright (no crash, no
  // exception — see the blacklist comment up top) instead of throwing.
  // Chromium's own "page unresponsive" detector is the only thing that can
  // still notice from outside; reload forcibly abandons the frozen renderer.
  mainWindow.webContents.on('unresponsive', () => {
    if (process.env.AV_DEBUG_LOG) {
      console.log('[main] renderer unresponsive, lastAttemptedPreset=', lastAttemptedPreset);
    }
    if (lastAttemptedPreset && Date.now() - lastAttemptedAt < 10000) {
      presetBlacklist.add(lastAttemptedPreset);
      persistBlacklist();
    }
    lastAttemptedPreset = null;
    mainWindow.reload();
  });

  if (process.env.AV_DEBUG_LOG) {
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[renderer] ${message} (${sourceId}:${line})`);
    });
  }

  if (process.env.AV_STRESS_TEST) {
    setTimeout(() => {
      mainWindow.webContents
        .executeJavaScript('window.__stressTestAllPresets()')
        .then((result) => console.log('[stress] resolved with', JSON.stringify(result)))
        .catch((err) => console.log('[stress] executeJavaScript failed', err.message));
    }, 4000);
  }
}

app.whenReady().then(() => {
  blacklistPath = path.join(app.getPath('userData'), 'preset-blacklist.json');
  try {
    presetBlacklist = new Set(JSON.parse(fs.readFileSync(blacklistPath, 'utf8')));
  } catch {
    // no blacklist file yet — fine
  }

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

  // Instrument/mic input mode (renderer.js) uses plain getUserMedia({audio}),
  // separate from the loopback path above. Electron denies media permission
  // requests by default unless a handler explicitly grants them, so both the
  // async request handler and the sync check handler need to allow 'media'.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === 'media');

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on('quit-app', () => {
  app.quit();
});

ipcMain.handle('get-preset-blacklist', () => [...presetBlacklist]);

ipcMain.on('preset-load-attempt', (_event, name) => {
  lastAttemptedPreset = name;
  lastAttemptedAt = Date.now();
});

ipcMain.on('preset-load-success', () => {
  lastAttemptedPreset = null;
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
