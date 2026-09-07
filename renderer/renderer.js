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
const btnInput = document.getElementById('btnInput');

const AUTO_CYCLE_MS = 20000;
const BLEND_SECONDS = 2.7;

// Butterchurn's mesh (the vertex grid the warp shader distorts) defaults to
// roughly 1080p-tuned settings. On a 4K canvas that undersells the GPU: a
// denser mesh gives visibly smoother warping at the cost of more vertex
// shader work, which a discrete GPU handles easily. Auto-picked at startup
// from the canvas's actual pixel count, and cyclable at runtime with Q in
// case auto-detection guesses wrong for your setup.
const QUALITY_LEVELS = [
  { name: 'Low', meshWidth: 24, meshHeight: 18 },
  { name: 'Medium', meshWidth: 32, meshHeight: 24 },
  { name: 'High', meshWidth: 48, meshHeight: 36 },
  { name: 'Ultra (4K)', meshWidth: 64, meshHeight: 48 },
];

function pickDefaultQualityIndex(pixelCount) {
  if (pixelCount > 3840 * 2160 * 0.9) return 3; // 4K+
  if (pixelCount > 2560 * 1440 * 0.9) return 2; // 1440p
  if (pixelCount > 1920 * 1080 * 0.9) return 1; // 1080p
  return 1;
}

let visualizer = null;
let audioContext = null;
let currentStream = null;
let currentSourceNode = null;
let currentQualityIndex = 1;
let inputMode = 'system'; // 'system' (WASAPI loopback) or 'instrument' (mic/line-in via getUserMedia)
let presetKeys = Object.keys(presets);
let presetIndex = Math.floor(Math.random() * presetKeys.length);
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

function loadPresetAt(index, { blend = BLEND_SECONDS } = {}) {
  presetIndex = ((index % presetKeys.length) + presetKeys.length) % presetKeys.length;
  const name = presetKeys[presetIndex];
  visualizer.loadPreset(presets[name], blend);
  setStatus(name);
  toolbarPresetEl.textContent = name;
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

function renderLoop() {
  if (visualizer) visualizer.render();
  requestAnimationFrame(renderLoop);
}

function stopCurrentAudio() {
  if (currentSourceNode) {
    currentSourceNode.disconnect();
    currentSourceNode = null;
  }
  if (currentStream) {
    currentStream.getTracks().forEach((track) => track.stop());
    currentStream = null;
  }
}

function attachStream(stream) {
  currentStream = stream;
  const sourceNode = audioContext.createMediaStreamSource(stream);
  currentSourceNode = sourceNode;
  visualizer.connectAudio(sourceNode);
}

async function connectSystemAudio() {
  setStatus('waiting for system audio…', { fade: false });

  // Chromium requires a video track alongside desktop-audio capture; we
  // discard it immediately and only use the audio.
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });

  stream.getVideoTracks().forEach((track) => track.stop());

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    throw new Error('No system audio track available (loopback capture failed).');
  }

  audioTracks[0].addEventListener('ended', () => {
    if (inputMode !== 'system') return; // superseded by a mode switch, not a real drop
    setStatus('audio stream ended, reconnecting…', { fade: false });
    connectSystemAudio().catch((err) =>
      setStatus(`reconnect failed: ${err.message}`, { fade: false })
    );
  });

  attachStream(stream);
  setStatus(presetKeys[presetIndex]);
}

// Instrument/mic input: a guitar (or anything else) plugged into an audio
// interface that's set as the Windows default input device shows up here
// like any other microphone. Processing that a browser normally applies to
// voice calls (echo cancellation, noise suppression, AGC) actively hurts an
// instrument signal, so all three are explicitly disabled.
async function connectInstrumentAudio() {
  setStatus('waiting for mic/instrument input…', { fade: false });

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    throw new Error('No input device available.');
  }

  audioTracks[0].addEventListener('ended', () => {
    if (inputMode !== 'instrument') return;
    setStatus('input device disconnected, reconnecting…', { fade: false });
    connectInstrumentAudio().catch((err) =>
      setStatus(`reconnect failed: ${err.message}`, { fade: false })
    );
  });

  attachStream(stream);
  setStatus(`${presetKeys[presetIndex]}  (input: ${audioTracks[0].label || 'mic/instrument'})`);
}

function connectAudioForCurrentMode() {
  return inputMode === 'system' ? connectSystemAudio() : connectInstrumentAudio();
}

function toggleInputMode() {
  inputMode = inputMode === 'system' ? 'instrument' : 'system';
  stopCurrentAudio();
  btnInput.textContent = inputMode === 'system' ? 'Input: System' : 'Input: Instrument';
  btnInput.classList.toggle('active', inputMode === 'instrument');
  connectAudioForCurrentMode().catch((err) =>
    setStatus(`could not connect audio: ${err.message}`, { fade: false })
  );
}

function createVisualizerInstance({ meshWidth, meshHeight }) {
  const dpr = window.devicePixelRatio || 1;
  return butterchurn.createVisualizer(audioContext, canvas, {
    width: canvas.width,
    height: canvas.height,
    pixelRatio: dpr,
    meshWidth,
    meshHeight,
  });
}

function cycleQuality() {
  currentQualityIndex = (currentQualityIndex + 1) % QUALITY_LEVELS.length;
  const level = QUALITY_LEVELS[currentQualityIndex];
  visualizer = createVisualizerInstance(level);
  if (currentSourceNode) visualizer.connectAudio(currentSourceNode);
  loadPresetAt(presetIndex, { blend: 0 });
  setStatus(`quality: ${level.name} (mesh ${level.meshWidth}×${level.meshHeight})`);
}

async function init() {
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

  resizeCanvas();

  currentQualityIndex = pickDefaultQualityIndex(canvas.width * canvas.height);
  visualizer = createVisualizerInstance(QUALITY_LEVELS[currentQualityIndex]);
  console.log(
    `visualizer created at ${canvas.width}x${canvas.height}, quality: ${QUALITY_LEVELS[currentQualityIndex].name}`
  );

  loadPresetAt(presetIndex, { blend: 0 });
  btnAuto.classList.toggle('active', autoCycleEnabled);
  restartAutoCycle();
  requestAnimationFrame(renderLoop);

  try {
    await connectAudioForCurrentMode();
    console.log('audio connected ok');
  } catch (err) {
    console.log('audio connect FAILED:', err.message);
    setStatus(`could not capture system audio: ${err.message}`, { fade: false });
  }

  setStatus(
    [
      presetKeys[presetIndex],
      'Space/N next · P prev · R random · A auto-cycle · I input · Q quality · F fullscreen · Esc quit',
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
btnInput.addEventListener('click', toggleInputMode);
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
    case 'i':
    case 'I':
      toggleInputMode();
      break;
    case 'q':
    case 'Q':
      cycleQuality();
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
