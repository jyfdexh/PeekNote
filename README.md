# PeekNote

PeekNote is a Windows edge-triggered floating notes and todo panel. It stays out of the way until your cursor reaches a configured screen edge, then expands into a compact Markdown editor for quick capture.

## Features

- Edge-triggered floating panel for top, left, or right screen edges.
- Transparent frameless window with rounded corners, glass/solid styles, and light/dark/system themes.
- Local Markdown notes with headings, task lists, links, quotes, code blocks, dividers, and pasted images.
- Multiple note tabs with rename, delete, and drag sorting.
- Resizable panel with synchronized width and height settings.
- Configurable trigger width and trigger debug overlay.
- Optional pin mode to keep the panel open.
- Global shortcut, defaulting to `Ctrl + Alt + Space`.
- Tray menu for show/hide, pin mode, data folder, and quit.
- Optional launch at login.

## Install

Download and run the Windows installer from the release artifact:

```text
release/PeekNote-0.1.0-setup.exe
```

After installation, move your cursor to the configured screen edge or press `Ctrl + Alt + Space` to open PeekNote.

## Development

Requirements:

- Node.js
- npm

Install dependencies:

```powershell
npm install
```

Start in development mode:

```powershell
npm start
```

Run checks:

```powershell
npm run smoke
npm run self-test
```

## Build

Create a Windows installer:

```powershell
npm run dist
```

The installer will be generated in:

```text
release/
```

Create an unpacked app build for quick local inspection:

```powershell
npm run pack
```

## Data

PeekNote stores notes and settings locally in Electron's user data directory. The exact directory depends on whether you run the development build or the packaged app.

## Notes

The current version is an Electron implementation. It is packaged as a normal Windows app, so end users do not need to install Node.js, npm, or Electron separately.
