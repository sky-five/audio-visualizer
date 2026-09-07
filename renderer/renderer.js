const { ipcRenderer } = require('electron');
const path = require('path');

// butterchurn ships ESM-only (package.json "type": "module"), so it must be
// loaded via dynamic import() even though this script itself is a plain
// CommonJS-style <script> (butterchurn-presets is a UMD/CJS bundle and
// works fine with require()).
function unwrap(mod) {
  return mod && mod.default ? mod.default : mod;
}

const presetsModule = unwrap(require('butterchurn-presets'));
const presets =
  typeof presetsModule.getPresets === 'function' ? presetsModule.getPresets() : presetsModule;

let butterchurn = null;

const canvas = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const toolbarEl = document.getElementById('toolbar');
const toolbarPresetEl = document.getElementById('toolbarPreset');
const btnAuto = document.getElementById('btnAuto');

const AUTO_CYCLE_MS = 20000;
const BLEND_SECONDS = 2.7;

let visualizer = null;
let audioContext = null;
let currentStream = null;
// Filtered down to exclude blacklisted (known-to-hang) presets once init()
// fetches the list from main — see loadPresetAt for why a blacklist exists.
let presetKeys = Object.keys(presets);
let presetIndex = 0;
let autoCycleEnabled = true;
let autoCycleTimer = null;

function setStatus(text, opts = {}) {
  statusEl.textContent = text;
  statusEl.style.opacity = '1';
  if (opts.fade !== false) {
    clearTimeout(setStatus._fadeTimer);
    setStatus._fadeTimer = setTimeout(() => {
      statusEl.style.opacity = '0';
    }, opts.holdMs || 3000);
  }
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const toolbarHeight = document.body.classList.contains('windowed') ? toolbarEl.offsetHeight : 0;
  const width = Math.floor(window.innerWidth * dpr);
  const height = Math.floor((window.innerHeight - toolbarHeight) * dpr);
  canvas.width = width;
  canvas.height = height;
  if (visualizer) visualizer.setRendererSize(width, height);
}

// A handful of community Butterchurn presets are simply buggy. loadPreset()
// itself can throw synchronously, or the preset can compile fine but throw
// later during render() (handled in renderLoop below). Either way, skip to
// the next preset automatically rather than getting stuck — with a retry
// cap so a broken run of consecutive presets can't recurse forever.
//
// A worse category throws nothing at all — the eel-wasm expressions or
// shaders just hang the JS thread synchronously, which try/catch can't do
// anything about. We can't recover from that here; ipcRenderer.send below
// tells main.js what we're about to attempt so that IF the whole renderer
// goes unresponsive, main can identify and blacklist the culprit and reload
// us back to life. See main.js for that half of the story.
function loadPresetAt(index, { blend = BLEND_SECONDS, attemptsLeft = presetKeys.length } = {}) {
  presetIndex = ((index % presetKeys.length) + presetKeys.length) % presetKeys.length;
  const name = presetKeys[presetIndex];
  ipcRenderer.send('preset-load-attempt', name);
  try {
    visualizer.loadPreset(presets[name], blend);
  } catch (err) {
    console.warn(`preset failed to load, skipping: "${name}"`, err.message);
    if (attemptsLeft > 1) {
      loadPresetAt(index + 1, { blend, attemptsLeft: attemptsLeft - 1 });
    } else {
      setStatus('all presets failed to load', { fade: false });
    }
    return;
  }
  // Delay the "success" signal — a hang can happen on the first render()
  // frame rather than during loadPreset() itself. If we cleared the attempt
  // attribution immediately, main.js wouldn't know who to blame for a hang
  // that shows up moments later. If the thread is frozen, this timeout
  // callback simply never runs, which is exactly what we want.
  setTimeout(() => ipcRenderer.send('preset-load-success', name), 2000);
  setStatus(name);
  toolbarPresetEl.textContent = name;
}

if (process.env.AV_DEBUG_LOG) {
  window.__loadPresetByName = (name) => {
    const idx = presetKeys.indexOf(name);
    if (idx === -1) throw new Error(`preset not found: ${name}`);
    loadPresetAt(idx, { blend: 0 });
  };

  window.__stressTestAllPresets = async (limit = presetKeys.length) => {
    console.log('[stress] starting, testing', limit, 'of', presetKeys.length);
    const failures = [];
    for (let i = 0; i < limit; i++) {
      const name = presetKeys[i];
      console.log('[stress] attempting', i, name);
      let loadError = null;
      try {
        visualizer.loadPreset(presets[name], 0);
      } catch (err) {
        loadError = err.message;
      }
      // let a handful of frames render so render()-time errors surface too
      const errorsBefore = consecutiveRenderErrors;
      await new Promise((r) => setTimeout(r, 120));
      const renderErrored = consecutiveRenderErrors > errorsBefore || consecutiveRenderErrors > 0;
      consecutiveRenderErrors = 0;
      if (loadError || renderErrored) {
        failures.push({ name, loadError, renderErrored });
        console.log('[stress] FAIL', name, loadError || '(render error)');
      }
      if (i % 10 === 0) console.log('[stress] progress', i, '/', limit);
    }
    console.log('[stress] done. failures:', JSON.stringify(failures));
    return failures;
  };
}

function nextPreset() {
  loadPresetAt(presetIndex + 1);
}

function prevPreset() {
  loadPresetAt(presetIndex - 1);
}

function randomPreset() {
  const idx = Math.floor(Math.random() * presetKeys.length);
  loadPresetAt(idx);
}

function restartAutoCycle() {
  clearInterval(autoCycleTimer);
  if (autoCycleEnabled) {
    autoCycleTimer = setInterval(nextPreset, AUTO_CYCLE_MS);
  }
}

function toggleAutoCycle() {
  autoCycleEnabled = !autoCycleEnabled;
  setStatus(`auto-cycle: ${autoCycleEnabled ? 'on' : 'off'}`);
  btnAuto.classList.toggle('active', autoCycleEnabled);
  restartAutoCycle();
}

let consecutiveRenderErrors = 0;

function renderLoop() {
  try {
    if (visualizer) visualizer.render();
    consecutiveRenderErrors = 0;
  } catch (err) {
    consecutiveRenderErrors += 1;
    console.warn(`preset render error in "${presetKeys[presetIndex]}" (${consecutiveRenderErrors}):`, err.message);
    // A single bad frame usually isn't fatal (e.g. a transient NaN from a
    // preset's own audio-reactive math); a run of them means this preset is
    // actually broken, so bail out to the next one instead of spamming
    // errors at 60fps forever.
    if (consecutiveRenderErrors >= 5) {
      consecutiveRenderErrors = 0;
      setStatus(`preset errored, skipping: "${presetKeys[presetIndex]}"`, { fade: false, holdMs: 4000 });
      nextPreset();
    }
  }
  requestAnimationFrame(renderLoop);
}

async function connectAudio() {
  setStatus('waiting for system audio…', { fade: false });

  // Chromium requires a video track alongside desktop-audio capture; we
  // discard it immediately and only use the audio.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  currentStream = stream;
  stream.getVideoTracks().forEach((track) => track.stop());

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    throw new Error('No system audio track available (loopback capture failed).');
  }

  audioTracks[0].addEventListener('ended', () => {
    setStatus('audio stream ended, reconnecting…', { fade: false });
    connectAudio().catch((err) => setStatus(`reconnect failed: ${err.message}`, { fade: false }));
  });

  const sourceNode = audioContext.createMediaStreamSource(stream);
  visualizer.connectAudio(sourceNode);

  setStatus(presetKeys[presetIndex]);
}

async function init() {
  const blacklist = await ipcRenderer.invoke('get-preset-blacklist');
  if (blacklist.length) {
    presetKeys = presetKeys.filter((name) => !blacklist.includes(name));
    console.log(`excluded ${blacklist.length} blacklisted preset(s):`, blacklist);
  }
  presetIndex = Math.floor(Math.random() * presetKeys.length);

  // Dynamic import() of a bare specifier isn't resolvable from a
  // non-module <script>; resolve butterchurn's absolute file path via
  // require.resolve (Node-style resolution). The page is served over the
  // custom app:// scheme (see main.js), so re-express that path as an
  // app://bundle/... URL rather than file:// — importing a file:// module
  // from an app:// page would be blocked as cross-origin.
  // Note: __dirname inside this app://-loaded renderer does NOT point at the
  // project directory (it resolves to Electron's own internal asar path),
  // even though require.resolve() itself still finds the right file — so
  // the project root is derived from the resolved path's own node_modules
  // segment instead of from __dirname.
  const resolvedButterchurn = require.resolve('butterchurn');
  const marker = `${path.sep}node_modules${path.sep}`;
  const projectRoot = resolvedButterchurn.slice(0, resolvedButterchurn.indexOf(marker));
  const relPath = path.relative(projectRoot, resolvedButterchurn).split(path.sep).join('/');
  butterchurn = unwrap(await import(`app://bundle/${relPath}`));
  console.log(`butterchurn loaded, ${presetKeys.length} presets found`);

  audioContext = new (window.AudioContext || window.webkitAudioContext)();

  const dpr = window.devicePixelRatio || 1;
  resizeCanvas();

  visualizer = butterchurn.createVisualizer(audioContext, canvas, {
    width: Math.floor(window.innerWidth * dpr),
    height: Math.floor(window.innerHeight * dpr),
    pixelRatio: dpr,
  });
  console.log('visualizer created', !!visualizer);

  loadPresetAt(presetIndex, { blend: 0 });
  btnAuto.classList.toggle('active', autoCycleEnabled);
  restartAutoCycle();
  requestAnimationFrame(renderLoop);

  try {
    await connectAudio();
    console.log('audio connected ok');
  } catch (err) {
    console.log('audio connect FAILED:', err.message);
    setStatus(`could not capture system audio: ${err.message}`, { fade: false });
  }

  setStatus(
    [
      presetKeys[presetIndex],
      'Space/N next · P prev · R random · A auto-cycle · F fullscreen · Esc quit',
    ].join('\n'),
    { holdMs: 6000 }
  );
}

window.addEventListener('resize', resizeCanvas);

ipcRenderer.on('fullscreen-changed', (_event, isFullscreen) => {
  document.body.classList.toggle('windowed', !isFullscreen);
  resizeCanvas();
});

document.getElementById('btnPrev').addEventListener('click', prevPreset);
document.getElementById('btnNext').addEventListener('click', nextPreset);
document.getElementById('btnRandom').addEventListener('click', randomPreset);
document.getElementById('btnAuto').addEventListener('click', toggleAutoCycle);
document.getElementById('btnMoveDisplay').addEventListener('click', () => {
  ipcRenderer.send('move-to-next-display');
});
document.getElementById('btnFullscreen').addEventListener('click', () => {
  ipcRenderer.send('toggle-fullscreen');
});
document.getElementById('btnQuit').addEventListener('click', () => {
  ipcRenderer.send('quit-app');
});

document.addEventListener('keydown', (event) => {
  switch (event.key) {
    case ' ':
    case 'n':
    case 'N':
      nextPreset();
      break;
    case 'p':
    case 'P':
      prevPreset();
      break;
    case 'r':
    case 'R':
      randomPreset();
      break;
    case 'a':
    case 'A':
      toggleAutoCycle();
      break;
    case 'f':
    case 'F':
      ipcRenderer.send('toggle-fullscreen');
      break;
    case 'Escape':
      ipcRenderer.send('quit-app');
      break;
    default:
      return;
  }
  event.preventDefault();
});

init();
