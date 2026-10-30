# Changelog

## 0.3.0 — 2026-10-30
**Photos: sorting out and comparing**
- Grid of the whole folder (G): choose with click or arrows, double click or Enter opens.
- Sort by name, date changed, size or type; filter by kind and by mark. The filter also applies to paging and the slideshow.
- Stars (1–5) and color labels (6–9, 0 removes them), kept in the app: the files stay untouched. A file renamed outside the app loses them.
- Delete puts a file into the system's trash, Ctrl+Z brings it back; copy and move to a folder (nothing is overwritten, a move can be undone too).
- Compare two photos side by side (V, or Ctrl-click in the grid): zoom and moving run together.
- Mirror (H, Shift+H), copy the photo to the clipboard (Ctrl+C), histogram in the info panel. Turning and mirroring are remembered per file.

**Layouts**
- New: Layouts, next to the themes (Settings → Appearance; shared by all Studio apps, any layout goes with any theme). **Adobe** is the look so far; **Modern** has rounded, floating panels and more room; **Custom** is yours: panels and tool rail left or right, density, corners, floating panels, status bar.

**Player**
- Choose the sound track and subtitles of films with several (MKV …), also subtitles inside the film (text ones; picture subtitles from DVD / Blu-ray can't be shown).
- Chapters from the file: list, marks on the time bar, Shift+N / Shift+P.
- Queue with files from any folder: order by dragging, saved between starts, as `.m3u` to save and load (also by dropping it on the window).
- Mini player (Shift+M): the window gets small and stays above the others; Esc goes back.
- Save the A–B part as its own file, without converting (Ctrl+Shift+B); it starts at the key frame before A.
- Even out loudness and boost speech for quiet recordings (until the app closes).
- FFmpeg build ffmpeg-8.1.3-4: WebVTT for subtitles, MP3 / FLAC / Ogg / ADTS for clips (still LGPL only).

## 0.2.1 — 2026-10-24
- New app icon: the tile now fades from dark at the top left to lighter at the bottom right, like the other Studio apps.

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
