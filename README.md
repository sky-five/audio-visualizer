# Audio Visualizer

Fullscreen, beat-reactive desktop visualizer for Windows. It captures whatever
your laptop is actually playing — any app, not just one browser tab — via
WASAPI loopback, and renders it through [Butterchurn](https://github.com/jberg/butterchurn),
the WebGL port of the MilkDrop engine that Winamp itself ships with.

## Why

Classic Winamp/WMP visualizers look dated. This taps **system-wide audio
loopback** instead of hooking into any single app, and renders through
Butterchurn's full MilkDrop preset library for real visual depth. Play from
YouTube Music in a browser tab, Spotify, a game, whatever's already
playing — it reacts to whatever's actually coming out of your speakers.

## Features

- System-wide WASAPI loopback capture (via Electron's desktop-audio capture) — no per-app integration needed
- 100+ Butterchurn/MilkDrop presets with smooth cross-fade blending, auto-cycle or manual control
- Fullscreen ambient mode + a windowed "config" mode with a draggable control toolbar
- Move-to-next-display support for multi-monitor setups
- Keyboard shortcuts and on-screen button controls

## Requirements

- Windows 10/11
- [Node.js](https://nodejs.org/) 18+

## Install & run

```bash
git clone https://github.com/sky-five/audio-visualizer.git
cd audio-visualizer
npm install
npm start
```

## Controls

| Key         | Action                          |
| ----------- | -------------------------------- |
| Space / N   | Next preset                      |
| P           | Previous preset                  |
| R           | Random preset                    |
| A           | Toggle auto-cycle                |
| I           | Toggle audio input (system loopback / mic \| instrument) |
| Q           | Cycle render quality (mesh resolution) |
| F           | Toggle fullscreen / windowed     |
| Esc         | Quit                              |

In windowed mode, a toolbar appears at the top with the same controls as
buttons, plus a **Move ▸** button that sends the window to your next display.
The toolbar also doubles as a drag handle, since frameless windows have no
title bar to grab.

## How it works

- **Capture** — Electron's `session.setDisplayMediaRequestHandler` +
  `desktopCapturer` grants silent access to a `'loopback'` audio stream. This
  is WASAPI loopback under the hood: it captures the full mixed system
  output, not any single app's audio, and doesn't affect normal playback.
- **Origin** — the renderer is served over a custom `app://` protocol rather
  than `file://`. Chromium rejects desktop-capture requests from a page with
  `file://`'s null/opaque security origin.
- **Rendering** — [Butterchurn](https://github.com/jberg/butterchurn) (ESM-only)
  is dynamically imported and driven by a `MediaStreamAudioSourceNode` built
  from the captured stream, rendering to a full-window WebGL2 canvas.
- **Window modes** — "fullscreen" is simulated by resizing the frameless
  window to the display's full bounds, rather than using Electron's native
  `setFullScreen()`. On Windows, toggling native fullscreen off on a
  frameless window fires `enter-full-screen`/`leave-full-screen` events that
  lag and double-fire well behind the real state — tracking our own boolean
  and sizing the window directly sidesteps that entirely. See the comments in
  [`main.js`](main.js) for the full story.

## Performance & display

- GPU-accelerated WebGL2 rendering throughout (Butterchurn). On startup the
  app picks a mesh-resolution tier (Low/Medium/High/Ultra) based on the
  canvas's actual pixel count, so a 4K display automatically renders at a
  denser mesh than 1080p — press **Q** to cycle tiers manually if you want to
  trade quality for headroom.
- On laptops with hybrid graphics (Intel integrated + NVIDIA/AMD discrete),
  the app hints Chromium to prefer the discrete GPU (`force_high_performance_gpu`),
  since this workload is GPU-bound every frame.
- The canvas always renders at your display's native pixel count
  (`devicePixelRatio`-aware), so a 4K monitor gets a genuine 4K render
  surface, not an upscaled 1080p one.

## Audio input modes

- **System** (default) — WASAPI loopback, captures whatever's playing through
  your speakers, as described above.
- **Instrument / mic** — press **I** or the toolbar button to switch to a
  direct `getUserMedia` input instead (echo cancellation, noise suppression,
  and auto-gain are all disabled so it doesn't dull a live signal). Plug a
  guitar (or anything else) into an audio interface, set it as your Windows
  default recording device, and the visualizer reacts to it directly — no
  system loopback involved. This is also the current path toward real-time
  guitar-reactive visuals; see the roadmap below for where that's headed next.

## Known limitations

- Windows-only (WASAPI loopback via Chromium's desktop capture)
- System mode captures the full system audio mix, not a single app in isolation
- No now-playing metadata (track/artist) — pure audio-reactive visuals by design

## Roadmap / ideas

- [ ] Packaged installer (`electron-builder`)
- [ ] Preset favorites / blacklist
- [ ] Optional now-playing overlay via the Windows SMTC API
- [ ] Cross-platform loopback capture (macOS/Linux)
- [ ] Input-device picker (choose a specific interface instead of the OS default) for instrument mode
- [ ] Pitch/onset detection layered on top of instrument input, for visuals that react to notes/chords rather than just amplitude

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
