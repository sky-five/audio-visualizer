# Contributing

Thanks for considering a contribution!

## Getting started

1. Fork the repo and clone your fork
2. `npm install`
3. `npm start` to run the app
4. Make your changes, then open a PR

For verbose renderer/main-process logging while debugging, run:

```bash
AV_DEBUG_LOG=1 npm start
```

## Reporting bugs / requesting features

Open an issue with as much detail as you can — Windows version, what you
were doing, and console output if relevant (see the debug flag above).

## Code style

- No build step or bundler by design — keep dependencies to what can run
  directly via Electron's `require`/dynamic `import()`
- Keep `main.js` (Electron main process) and `renderer/` (UI, audio capture,
  visualizer logic) cleanly separated
- Comments should explain *why*, not *what* — the code should be readable
  enough that restating it in prose isn't useful

## Ideas that would be especially welcome

- Packaging (`electron-builder`) for a distributable installer
- Cross-platform loopback capture (macOS/Linux)
- UI polish for the windowed config toolbar
- A preset favorites/blacklist system
