# Changelog

## 0.2.0 — 2026-10-23
- Plays what the WebView can't: MKV, AVI, WMV, ASF, FLV, MPG, VOB, TS / M2TS, 3GP, RM …, HEVC on Windows and Linux,
  AC-3, E-AC-3, DTS, WMA, APE, AIFF … sound, and shows HEIC / HEIF and TIFF photos. A small LGPL-only FFmpeg ships with the
  app: if only the container is the problem the streams are copied (takes seconds), otherwise what can't be played is
  converted once — with the system's H.264 encoder on macOS and Windows, VP8 / Opus on Linux — with a progress card.
  The copy is kept in the cache (at most 4 GB), so the file opens at once the next time; moving on stops the conversion.
- Files the WebView plays as they are (MP4, MOV, WebM, MP3 …) stay untouched.

## 0.1.1 — 2026-10-23
- Start page: the app tile shows the letters "Vw" like the other Studio apps, instead of the whole app icon inside the tile.

## 0.1.0 — 2026-10-18
- First version: photos (JPG, PNG, GIF, WebP, AVIF, BMP, ICO, SVG), videos (MP4, WebM, MOV, M4V, OGV), audio (MP3, FLAC,
  WAV, OGG, Opus, M4A) and 3D models (STL, OBJ, GLB / GLTF, 3MF, PLY) in one viewer with the Studio layout.
- Open files or folders, page through a folder in Explorer order, tabs, drag & drop, recent list, full screen, slideshow.
- Photos: fit / zoom at the mouse / move / rotate; EXIF details with GPS map link.
- Video and audio: own controls, speed, frame by frame, A–B loop, subtitles (.srt / .vtt), still frame as PNG, remembered
  position, tags and cover for music.
- 3D: views, wireframe, PNG of the view, size / volume / surface / triangles for 3D printing.
- Notes per file (with times for video and audio), saved as Markdown.
