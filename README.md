# Thore

Live, windowed views of multiple web pages with user-defined crops. Each page is rendered once in a Chromium webview and masked to a rectangle you draw, so animation, JS, and video stay live rather than refreshing screenshots.

## Demo

![Demo GIF](demo/thoredemo.gif)

## Features

- Add any URL and define a crop rectangle via drag/resize overlay.
- Real-time view: each tile is a live webview, not a thumbnail.
- Adjustable zoom (per tile) via page zoom.
- Per-tile viewport sizing so layouts match your target resolution.
- Persistent layout state stored locally (URLs, crops, viewports, zoom).

## Getting started

```bash
npm install
npm start
```

## Downloads

- Windows portable (x64): [Download](https://github.com/arxidaki/thore/releases/download/v0.1.0/thore-0.1.0-x64.exe)
- Windows portable (ARM64): [Download](https://github.com/arxidaki/thore/releases/download/v0.1.0/thore-0.1.0-arm64.exe)

## Building

### Windows (portable)

```bash
npm run dist:win
```

Outputs a portable `.exe` at `dist/thore-0.1.0-x64.exe` (unpacked app in `dist/win-unpacked`).

### Windows (portable, ARM64)

```bash
npm run dist:win-arm
```

Outputs a portable `.exe` at `dist/thore-0.1.0-arm64.exe` (unpacked app in `dist/win-arm64-unpacked`).

### Linux (AppImage)

Run on a Linux shell (or WSL) with build deps installed (`libfuse2`/fuse, build-essential, python, etc.):

```bash
npm run dist:linux
```

Outputs an AppImage under `dist/`.

### macOS (zip)

Run on macOS (Apple tooling required; codesign optional for local use):

```bash
npm run dist:mac
```

Outputs a `.zip` under `dist/`.

## How it works

- Each tile wraps a `<webview>` sized to a virtual viewport (default 1280x720). The crop rectangle sets the wrapper size; the webview is offset negatively to reveal only that region.
- Zoom uses `setZoomFactor`; no screenshotting or timers are used.
- Crops are edited in a modal with a draggable/resizable marquee over a live webview. Saving updates the main tile immediately.

## Notes

- Keep the number of concurrent tiles reasonable; each webview is a full Chromium instance.
- Use "Clear all" if you want to reset stored state in `localStorage`.
