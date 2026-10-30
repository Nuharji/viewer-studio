# Viewer Studio (Rust / Tauri)

> **Status: Pre-Alpha** — early version (0.x): it works, but things may still change or break. Version 1.0 will be the first stable one.

Look at photos, videos, music and 3D models — the viewer of the Studio family. Works offline, no account.
The native shell is Rust ([Tauri 2](https://tauri.app)); the UI is plain HTML/JS in `ui/`, with the same chrome
and controls as the other Studio apps.

## Features
- **Open** files or a whole folder (dialog, drag & drop, "Open with", recent list); every file opens in a tab and pages
  through the media of its folder (← / →, Page Up / Down), sorted like Explorer ("Photo 2" before "Photo 10")
- **Photos** — JPG, PNG, GIF, WebP, AVIF, BMP, ICO, SVG: fit or zoom at the mouse (wheel), move, rotate, slideshow,
  full screen; details from EXIF (taken, camera, lens, exposure, aperture, ISO, focal length, GPS with a map link)
- **Videos** — MP4, WebM, MOV, M4V, OGV: own controls (seek with time tip, ±10 s, frame by frame, speed 0.25–4×, volume,
  A–B loop, repeat), subtitles next to the file (`.srt` / `.vtt`, also `name.de.srt`), still frame as PNG, continues where you
  stopped, finds the length of recordings that don't store one
- **Audio** — MP3, FLAC, WAV, OGG, Opus, M4A: title, artist, album, year and cover from the tags; plays the folder in order
- **3D models** — STL, OBJ, GLB / GLTF, 3MF, PLY: rotate, move, zoom, front / top / side views, wireframe, view as PNG;
  **width, depth, height, volume, surface and triangles** (in mm for STL/OBJ/PLY/3MF — handy for 3D printing)
- **Notes per file** — with the current time for videos and audio (click a time to jump there); save them as Markdown
- **Sorting out** — grid of the folder, sort and filter, stars and color labels (kept in the app, not in the files), system
  trash with undo, copy / move to a folder, two photos side by side with linked zoom, mirror, copy to clipboard, histogram
- **Player** — sound track and subtitle choice (also inside the file), chapters, queue with `.m3u`, mini player, save A–B as a
  file without converting, even out loudness and boost speech
- Info, folder (with thumbnails and a filter), notes and queue in the side panel; 4 app themes, background for the stage
  (dark, black, theme, light, checkerboard), settings dialog, customizable shortcuts, auto-hide bars, German/English;
  theme and language shared with the other Studio apps

The app can only read the folders you open (the asset protocol starts with an empty scope). It doesn't register itself
as the default program for any file type; use "Open with" or drag files onto it.

Formats the WebView can't play — MKV, AVI, WMV, MPG, TS, HEVC on Windows / Linux, AC-3 / DTS / WMA sound, HEIC and TIFF
photos — go through a small LGPL-only FFmpeg that ships next to the program (`viewer-ffmpeg`, see `ffmpeg/build.sh` and
`src-tauri/src/convert.rs`): if only the container is the problem the streams are copied (seconds), otherwise what can't be
played is converted once (H.264/AAC with the system's encoder on macOS and Windows, VP8/Opus on Linux) and kept in the cache.

FFmpeg is built unchanged from the official sources in GitHub Actions (`.github/workflows/ffmpeg.yml`, release
`ffmpeg-<version>-<n>`), without GPL or non-free parts, and is not linked into the app. For a local build put a binary
named `viewer-ffmpeg-<target triple>` into `src-tauri/binaries/` (e.g. `ffmpeg/build.sh macos-arm64 out`), or let
`STUDIO_FFMPEG` point to one; without it the app works as before.

## Layout
```
ui/                 index.html, app.js — the viewer; organize.js — its plain logic (sorting, marks, histogram); viewer3d.js — 3D view (three.js, ui/vendor/three, MIT)
                    native.js, autohide.js, shortcuts.js, shared.js (the same in every Studio app)
src-tauri/src/      main.rs — opening, dialogs, saving; media.rs — folder lists, EXIF, audio tags, subtitles, playlists;
                    convert.rs — FFmpeg (playable copies, tracks, clips); organize.rs — trash, copy, move, queue files;
                    shared.rs — theme / language shared by the Studio apps
src-tauri/i18n/     en.json, de.json — all texts
```

## Build
Install Rust and Node, then `npx @tauri-apps/cli@2 icon app-icon.png` once and `npx @tauri-apps/cli@2 dev`.
Release builds for Windows / macOS / Linux come from GitHub Actions when you push a tag like `v0.1.0`.

## Licenses
Viewer Studio uses [three.js](https://threejs.org) (MIT), [kamadak-exif](https://github.com/kamadak/exif-rs) (BSD-2-Clause)
[lofty](https://github.com/Serial-ATA/lofty-rs) (MIT / Apache-2.0) and, on Windows and Linux, [trash](https://github.com/Byron/trash-rs) (MIT).
