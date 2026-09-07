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

## Known limitations

- Windows-only (WASAPI loopback via Chromium's desktop capture)
- Captures the full system audio mix, not a single app in isolation
- No now-playing metadata (track/artist) — pure audio-reactive visuals by design

## Roadmap / ideas

- [ ] Packaged installer (`electron-builder`)
- [ ] Preset favorites / blacklist
- [ ] Optional now-playing overlay via the Windows SMTC API
- [ ] Cross-platform loopback capture (macOS/Linux)

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
