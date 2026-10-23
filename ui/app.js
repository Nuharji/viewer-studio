/* Viewer Studio — look at photos, videos, music and 3D models (Studio family). Same chrome as the other apps: menus from
   MENUS with customizable shortcuts, option bar, tool rail, tabs, side panel, status bar, settings, shared theme and
   language. Rust (main.rs, media.rs) lists the media of a folder, reads photo (EXIF) and audio (tags) details and
   subtitles, and lets the WebView load exactly the folders that were opened (asset protocol). 3D: viewer3d.js. */
'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const STORE = 'viewer-studio.v1', NOTES = 'viewer-studio.notes', POS = 'viewer-studio.positions';
const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
const fileUrl = p => window.__TAURI__ ? window.__TAURI__.core.convertFileSrc(p) : p;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const extOf = n => (/\.([^.\\/]+)$/.exec(n) || [, ''])[1].toLowerCase();

/* ================= Texts ================= */
let I18N = {en: {}, de: {}}, lang = 'en';
function t(key, vars) {
  let s = (I18N[lang] && I18N[lang][key]) ?? I18N.en[key] ?? key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
const fmtKey = k => lang === 'de' ? k.replace(/Ctrl/g, 'Strg').replace(/Shift/g, 'Umschalt').replace(/Space/g, 'Leertaste') : k;
async function loadTexts() {
  if (invoke) { I18N = await invoke('texts'); return; }
  const get = l => fetch(`../src-tauri/i18n/${l}.json`).then(r => r.json()).catch(() => ({}));
  I18N = {en: await get('en'), de: await get('de')};
}
const loc = () => lang === 'de' ? 'de-DE' : 'en-GB';
const num = (v, d = 1) => Number(v).toLocaleString(loc(), {maximumFractionDigits: d});
const fmtSize = b => b < 1024 ? `${b} B` : b < 1048576 ? `${num(b / 1024)} KB` : b < 1073741824 ? `${num(b / 1048576)} MB` : `${num(b / 1073741824, 2)} GB`;
const fmtTime = s => {
  if (!Number.isFinite(s)) return '–:––';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
const fmtDate = ms => ms ? new Date(ms).toLocaleString(loc(), {dateStyle: 'medium', timeStyle: 'short'}) : '';

/* ================= Settings and state ================= */
const THEMES = ['dark', 'light', 'github', 'github-dark'];
const DEF = {keys: {}, autoHide: false, lang: 'auto', theme: 'dark', dock: true, dockTab: 'info', stage: 'dark',
  slideSec: 4, autoplay: true, remember: true, volume: 1, muted: false, loopFile: false, subs: true};
let settings = {...DEF}, recent = [], tabs = [], active = -1, booted = false, seq = 0;
const effectiveLang = () => settings.lang === 'auto' ? ((navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en') : settings.lang;
function saveState() { try { localStorage.setItem(STORE, JSON.stringify({settings, recent})); } catch (e) {} }
const readJson = k => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch (e) { return {}; } };
let notes = readJson(NOTES), positions = readJson(POS);
const saveNotes = () => { try { localStorage.setItem(NOTES, JSON.stringify(notes)); } catch (e) {} };
function savePos(path, sec) {
  if (!settings.remember) return;
  if (sec == null) delete positions[path]; else positions[path] = Math.round(sec);
  const keys = Object.keys(positions); if (keys.length > 400) keys.slice(0, keys.length - 400).forEach(k => delete positions[k]);
  try { localStorage.setItem(POS, JSON.stringify(positions)); } catch (e) {}
}
const cur = () => tabs[active] || null;
const entryOf = tab => tab && tab.list[tab.i];
const curEntry = () => entryOf(cur());
function addRecent(path, name, kind) {
  recent = [{path, name, kind}, ...recent.filter(r => r.path !== path)].slice(0, 12);
  saveState();
}

/* ================= Opening ================= */
/* Rust hands over {current, folder, siblings}: every opened file becomes a tab that can page through its folder. */
function openResults(list, fromFolder = false) {
  if (!list || !list.length) return;
  for (const o of list) {
    const i = Math.max(0, o.siblings.findIndex(e => o.current && e.path === o.current.path));
    const existing = tabs.findIndex(tb => tb.folder === o.folder && entryOf(tb) && o.current && entryOf(tb).path === o.current.path);
    if (existing >= 0) { activate(existing); continue; }
    tabs.push({id: ++seq, folder: o.folder, list: o.siblings, i, view: {}});
    if (fromFolder) addRecent(o.folder, o.folder.split(/[\\/]/).pop() || o.folder, 'folder');
    else if (o.current) addRecent(o.current.path, o.current.name, o.current.kind);
  }
  activate(tabs.length - 1);
}
async function openFiles() { if (invoke) openResults(await invoke('pick_files', {label: t('ui.mediaFiles')})); }
async function openFolder() { if (invoke) { const o = await invoke('pick_folder'); if (o) openResults([o], true); else if (o === null) {} } }
async function openPaths(paths, fromFolder = false) {
  if (!invoke || !paths.length) return;
  const res = await invoke('open_paths', {paths});
  if (!res.length) return toast(t('toast.nothing'));
  openResults(res, fromFolder);
}
function activate(i) {
  stopSlideshow();
  leaveMedia();
  active = clamp(i, -1, tabs.length - 1);
  renderTabs(); show();
}
function closeTab(i = active) {
  if (i < 0 || !tabs[i]) return;
  if (i === active) leaveMedia();
  tabs.splice(i, 1);
  active = Math.min(active >= i ? active - (active > i ? 1 : 0) : active, tabs.length - 1);
  if (active < 0 && tabs.length) active = 0;
  renderTabs(); show();
}
function go(step, wrap = false) {
  const tab = cur(); if (!tab || tab.list.length < 2) return;
  let i = tab.i + step;
  if (wrap) i = (i + tab.list.length) % tab.list.length;
  if (i < 0 || i >= tab.list.length) return;
  leaveMedia(); tab.i = i; tab.view = {}; renderTabs(); show();
}
const goTo = i => { const tab = cur(); if (!tab || i === tab.i) return; leaveMedia(); tab.i = clamp(i, 0, tab.list.length - 1); tab.view = {}; renderTabs(); show(); };

/* ================= Showing a file ================= */
const stage = $('#stage');
let media = null, view3d = null, view3dSeq = 0, info = null;
function leaveMedia() {
  cancelPrep();
  if (media) { const e = curEntry(); if (e && Number.isFinite(media.duration) && media.currentTime > 0) rememberPos(e.path, media); media.pause(); media.removeAttribute('src'); media.load(); media = null; }
  if (view3d) { view3d.dispose(); view3d = null; }
  view3dSeq++;
  abLoop = null;
}
function rememberPos(path, m) {
  const d = m.duration, s = m.currentTime;
  savePos(path, s > 5 && s < d - 8 ? s : null);
}
function show() {
  const tab = cur(), e = entryOf(tab);
  document.body.classList.toggle('has-doc', !!e);
  $('#empty').hidden = !!e; stage.hidden = !e;
  info = null;
  stage.className = 'stage kind-' + (e ? e.kind : 'none') + ' bg-' + settings.stage;
  stage.innerHTML = '';
  updateTitle();
  if (!e) { renderEmpty(); buildCtxBar(); renderDock(); updateStatus(); return; }
  if (e.kind === 'image') showImage(e, tab);
  else if (e.kind === 'video' || e.kind === 'audio') showMedia(e);
  else if (e.kind === 'model') showModel(e);
  buildCtxBar(); renderDock(); updateStatus(); syncDisabled();
  preloadNext(tab);
}
function failed(msgKey, e) {
  stage.innerHTML = `<div class="failed"><div class="big">!</div><h2>${esc(e ? e.name : '')}</h2><p>${esc(t(msgKey))}</p></div>`;
}
// The next photo loads in the background, so paging is instant.
let preImg = null;
function preloadNext(tab) {
  const n = tab.list[tab.i + 1];
  if (n && n.kind === 'image') { preImg = new Image(); preImg.src = fileUrl(n.path); }
}

/* ----- Photos: fit / zoom around the mouse / move / rotate ----- */
const ZOOMS = [.1, .25, .33, .5, .67, .75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
function showImage(e, tab) {
  const v = tab.view;
  v.zoom = v.zoom || 'fit'; v.rot = v.rot || 0; v.x = v.x || 0; v.y = v.y || 0;
  const img = new Image();
  img.className = 'photo'; img.draggable = false; img.alt = e.name;
  img.onload = () => { v.w = img.naturalWidth; v.h = img.naturalHeight; if (cur() === tab) { layoutImage(); updateStatus(); renderDock(); } };
  img.onerror = async () => {
    if (cur() !== tab || curEntry() !== e) return;
    // HEIC, TIFF … : the bundled FFmpeg turns the photo into a JPEG (once; it is kept in the cache).
    if (invoke && !img.dataset.prepared) {
      img.dataset.prepared = '1';
      const p = await prepare(e, 'image', stage, 'prep.image');
      if (p && curEntry() === e) { img.src = fileUrl(p); return; }
      if (curEntry() !== e) return;
    }
    failed('err.image', e);
  };
  img.src = fileUrl(e.path);
  stage.append(img);
  if (invoke && ext3(e) !== 'svg') invoke('photo_info', {path: e.path}).then(p => { if (curEntry() === e) { info = p; renderDock(); } }).catch(() => {});
}
const ext3 = e => extOf(e.name);
function fitScale() {
  const v = cur().view, sw = stage.clientWidth - 24, sh = stage.clientHeight - 24;
  const [w, h] = v.rot % 180 ? [v.h, v.w] : [v.w, v.h];
  if (!w || !h) return 1;
  return Math.min(1, sw / w, sh / h);
}
const scaleOf = v => v.zoom === 'fit' ? fitScale() : v.zoom;
function layoutImage() {
  const tab = cur(), img = stage.querySelector('img.photo'); if (!tab || !img || !tab.view.w) return;
  const v = tab.view, s = scaleOf(v);
  if (v.zoom === 'fit') { v.x = 0; v.y = 0; }
  img.style.width = v.w * s + 'px'; img.style.height = v.h * s + 'px';
  img.style.transform = `translate(-50%, -50%) translate(${v.x}px, ${v.y}px) rotate(${v.rot}deg)`;
  stage.classList.toggle('pannable', v.zoom !== 'fit' && s > fitScale());
  const z = $('#zoomSel'); if (z) z.value = v.zoom === 'fit' ? 'fit' : String(v.zoom);
  $('#stZoom').textContent = Math.round(s * 100) + ' %';
}
function setZoom(z, at) {
  const tab = cur(); if (!tab || entryOf(tab).kind !== 'image') return;
  const v = tab.view, before = scaleOf(v);
  v.zoom = z === 'fit' ? 'fit' : clamp(z, .05, 16);
  if (z !== 'fit' && at) {
    // Zoom around the mouse: the point under it stays where it is.
    const r = stage.getBoundingClientRect(), cx = at[0] - r.left - r.width / 2, cy = at[1] - r.top - r.height / 2, k = v.zoom / before;
    v.x = cx - (cx - v.x) * k; v.y = cy - (cy - v.y) * k;
  }
  if (v.zoom === 'fit') { v.x = v.y = 0; }
  layoutImage();
}
const zoomStep = (dir, at) => {
  const s = scaleOf(cur().view);
  setZoom(dir > 0 ? (ZOOMS.find(z => z > s + 1e-3) || 16) : ([...ZOOMS].reverse().find(z => z < s - 1e-3) || .05), at);
};
function rotate(d) { const tab = cur(); if (!tab || entryOf(tab).kind !== 'image') return; tab.view.rot = (tab.view.rot + d + 360) % 360; layoutImage(); }
stage.addEventListener('wheel', ev => {
  const e = curEntry(); if (!e || e.kind !== 'image') return;
  ev.preventDefault();
  zoomStep(ev.deltaY < 0 ? 1 : -1, [ev.clientX, ev.clientY]);
}, {passive: false});
stage.addEventListener('pointerdown', ev => {
  const e = curEntry(); if (!e || e.kind !== 'image' || ev.button !== 0) return;
  const v = cur().view; if (v.zoom === 'fit' || scaleOf(v) <= fitScale()) return;
  const sx = ev.clientX, sy = ev.clientY, x0 = v.x, y0 = v.y;
  stage.setPointerCapture(ev.pointerId); stage.classList.add('panning');
  const move = m => { v.x = x0 + m.clientX - sx; v.y = y0 + m.clientY - sy; layoutImage(); };
  stage.addEventListener('pointermove', move);
  stage.addEventListener('pointerup', () => { stage.removeEventListener('pointermove', move); stage.classList.remove('panning'); }, {once: true});
});
stage.addEventListener('dblclick', ev => {
  const e = curEntry(); if (!e) return;
  if (e.kind === 'image') { const v = cur().view; setZoom(v.zoom === 'fit' ? 1 : 'fit', [ev.clientX, ev.clientY]); }
  else if (e.kind === 'video') A.fullscreen();
});
new ResizeObserver(() => { const e = curEntry(); if (e && e.kind === 'image') layoutImage(); }).observe(stage);

/* ----- Slideshow ----- */
let slideTimer = 0;
function startSlideshow() {
  const tab = cur(); if (!tab) return;
  stopSlideshow(); document.body.classList.add('slideshow');
  slideTimer = setInterval(() => {
    const tb = cur(); if (!tb) return stopSlideshow();
    // Photos only: other files in the folder are skipped.
    let i = tb.i;
    for (let k = 0; k < tb.list.length; k++) { i = (i + 1) % tb.list.length; if (tb.list[i].kind === 'image') break; }
    goTo(i); document.body.classList.add('slideshow');
  }, Math.max(1, settings.slideSec) * 1000);
  toast(t('toast.slideshow'));
}
function stopSlideshow() { if (slideTimer) { clearInterval(slideTimer); slideTimer = 0; } document.body.classList.remove('slideshow'); }

/* ----- Formats the WebView can't play: a prepared copy from the bundled FFmpeg (Rust: convert.rs) ----- */
/* The file is looked at first; if the WebView plays it as it is, nothing happens. Otherwise it is remuxed (seconds) or
   converted once, with a progress card, and the copy is kept in the cache. Moving on to another file stops it. */
let prepSeq = 0, prepId = 0, prepCount = 0;
if (window.__TAURI__) window.__TAURI__.event.listen('media-progress', ev => {
  const p = ev.payload || {}, card = stage.querySelector('.prep');
  if (p.id !== prepId || !card) return;
  card.querySelector('.prep-bar i').style.width = (p.done * 100).toFixed(1) + '%';
  card.querySelector('.prep-pct').textContent = Math.round(p.done * 100) + ' %';
});
function cancelPrep() {
  prepSeq++;
  if (prepId && invoke) invoke('media_cancel', {id: prepId}).catch(() => {});
  prepId = 0;
}
function prepCard(host, key) {
  const card = document.createElement('div');
  card.className = 'prep';
  card.innerHTML = `<b>${esc(t(key))}</b><div class="prep-bar"><i></i></div><div class="prep-row"><span>${esc(t('prep.once'))}</span><span class="prep-pct"></span></div>`;
  host.append(card);
  return card;
}
/* The path the player should load: the file itself or a prepared copy; null when another file is shown meanwhile. */
async function playablePath(e, kind, host) {
  if (!invoke) return e.path;
  const seq = ++prepSeq;
  const c = await invoke('media_check', {path: e.path, kind}).catch(() => ({plan: 'native'}));
  if (seq !== prepSeq) return null;
  if (c.ready) return c.ready;
  if (c.plan !== 'remux' && c.plan !== 'convert') return e.path;
  return prepare(e, kind, host, c.plan === 'remux' ? 'prep.remux' : 'prep.convert', seq);
}
async function prepare(e, kind, host, key, seq = ++prepSeq) {
  const id = prepId = ++prepCount, card = prepCard(host, key);
  try {
    const out = await invoke('media_prepare', {path: e.path, kind, id});
    if (seq !== prepSeq) return null;
    return out;
  } catch (err) {
    if (seq !== prepSeq || String(err) === 'cancelled') return null;
    toast(t('prep.fail', {e: String(err)}));
    return kind === 'image' ? null : e.path;
  } finally {
    card.remove();
    if (prepId === id) prepId = 0;
  }
}

/* ----- Video and audio: own controls over the picture ----- */
let abLoop = null, hideT = 0;
async function showMedia(e) {
  const isVideo = e.kind === 'video';
  const m = document.createElement(isVideo ? 'video' : 'audio');
  m.className = 'player'; m.preload = 'metadata'; m.playsInline = true;
  m.volume = settings.volume; m.muted = settings.muted; m.loop = settings.loopFile;
  media = m;
  const wrap = document.createElement('div'); wrap.className = 'media-wrap';
  if (!isVideo) wrap.innerHTML = `<div class="audio-card"><div class="cover"><svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
    <div class="a-title">${esc(e.name.replace(/\.[^.]+$/, ''))}</div><div class="a-sub"></div></div>`;
  wrap.append(m);
  wrap.insertAdjacentHTML('beforeend', `<div class="controls" id="ctl">
    <div class="seek"><div class="buf"></div><div class="ab"></div><input type="range" id="seek" min="0" max="1000" value="0" step="1"><div class="tip" id="seekTip"></div></div>
    <div class="ctl-row">
      <button class="cbtn" data-act="playPause" id="playBtn"></button>
      <button class="cbtn" data-act="back10" title="${esc(tip('back10'))}">${ICONS.back10}</button>
      <button class="cbtn" data-act="fwd10" title="${esc(tip('fwd10'))}">${ICONS.fwd10}</button>
      <span class="time" id="time">0:00 / –:––</span><span class="flex"></span>
      <span class="ab-label" id="abLabel"></span>
      <button class="cbtn" data-act="toggleMute" id="muteBtn"></button><input type="range" id="vol" min="0" max="1" step="0.02" value="${settings.volume}">
      <select id="speed" title="${esc(t('a.speedUp'))}">${[.25, .5, .75, 1, 1.25, 1.5, 1.75, 2, 3, 4].map(s => `<option value="${s}"${s === 1 ? ' selected' : ''}>${num(s, 2)}×</option>`).join('')}</select>
      ${isVideo ? `<button class="cbtn" data-act="toggleSubs" id="subsBtn" title="${esc(tip('toggleSubs'))}">${ICONS.subs}</button>
      <button class="cbtn" data-act="snapshot" title="${esc(tip('snapshot'))}">${ICONS.camera}</button>
      <button class="cbtn" data-act="fullscreen" title="${esc(tip('fullscreen'))}">${ICONS.full}</button>` : ''}
    </div></div>`);
  stage.append(wrap);
  playablePath(e, e.kind, wrap).then(p => { if (p && media === m) m.src = fileUrl(p); });
  const seek = $('#seek');
  const paint = () => {
    if (media !== m) return;
    const d = m.duration;
    if (!seek.matches(':active')) seek.value = Number.isFinite(d) && d ? Math.round(m.currentTime / d * 1000) : 0;
    $('#time').textContent = `${fmtTime(m.currentTime)} / ${fmtTime(d)}`;
    $('#playBtn').innerHTML = m.paused ? ICONS.play : ICONS.pause; $('#playBtn').title = tip('playPause');
    $('#muteBtn').innerHTML = m.muted || m.volume === 0 ? ICONS.muted : ICONS.volume; $('#muteBtn').title = tip('toggleMute');
    const b = m.buffered; if (b.length && Number.isFinite(d)) wrap.querySelector('.buf').style.width = (b.end(b.length - 1) / d * 100) + '%';
    const ab = wrap.querySelector('.ab');
    if (abLoop && Number.isFinite(d)) { ab.hidden = false; ab.style.left = abLoop.a / d * 100 + '%'; ab.style.width = ((abLoop.b ?? abLoop.a) - abLoop.a) / d * 100 + '%'; } else ab.hidden = true;
    $('#abLabel').textContent = abLoop ? (abLoop.b == null ? t('ab.a', {a: fmtTime(abLoop.a)}) : t('ab.loop', {a: fmtTime(abLoop.a), b: fmtTime(abLoop.b)})) : '';
    $('#stTime').textContent = `${fmtTime(m.currentTime)} / ${fmtTime(d)}`;
    if (isVideo) $('#subsBtn').classList.toggle('on', settings.subs && m.textTracks.length > 0);
  };
  ['timeupdate', 'play', 'pause', 'volumechange', 'durationchange', 'progress', 'ratechange'].forEach(k => m.addEventListener(k, paint));
  let lastSave = 0;
  m.addEventListener('timeupdate', () => {
    if (abLoop && abLoop.b != null && m.currentTime >= abLoop.b) m.currentTime = abLoop.a;
    if (Date.now() - lastSave > 3000) { lastSave = Date.now(); rememberPos(e.path, m); }
  });
  m.addEventListener('loadedmetadata', async () => {
    // Recordings from browsers and screen recorders often have no length in the file: a jump to the very end makes the
    // player find it, then back to the start.
    if (m.duration === Infinity) {
      await new Promise(r => { m.addEventListener('durationchange', r, {once: true}); m.currentTime = 1e101; setTimeout(r, 1500); });
      if (media !== m) return;
      m.currentTime = 0;
    }
    const p = settings.remember ? positions[e.path] : 0;
    if (p && p < m.duration - 5) { m.currentTime = p; toast(t('toast.resumed', {t: fmtTime(p)})); }
    if (isVideo) { info = {...(info || {}), width: m.videoWidth, height: m.videoHeight}; }
    info = {...(info || {}), duration: m.duration};
    renderDock(); updateStatus();
    if (settings.autoplay) m.play().catch(() => {});
  });
  m.addEventListener('ended', () => { savePos(e.path, null); if (!m.loop && settings.autoplay && !isVideo) go(1); });
  m.addEventListener('error', () => { if (media === m) failed(m.error && m.error.code === 4 ? 'err.codec' : 'err.media', e); });
  seek.addEventListener('input', () => { if (Number.isFinite(m.duration)) m.currentTime = seek.value / 1000 * m.duration; });
  seek.addEventListener('mousemove', ev => {
    const r = seek.getBoundingClientRect(), f = clamp((ev.clientX - r.left) / r.width, 0, 1), tipEl = $('#seekTip');
    if (!Number.isFinite(m.duration)) return;
    tipEl.textContent = fmtTime(f * m.duration); tipEl.style.left = f * 100 + '%';
  });
  $('#vol').addEventListener('input', ev => { m.volume = +ev.target.value; m.muted = m.volume === 0; settings.volume = m.volume; settings.muted = m.muted; saveState(); });
  $('#speed').addEventListener('change', ev => { m.playbackRate = +ev.target.value; });
  m.addEventListener('click', () => A.playPause());
  // Controls fade out while a video plays and the mouse rests.
  const wake = () => { wrap.classList.remove('idle'); clearTimeout(hideT); hideT = setTimeout(() => { if (media === m && !m.paused && isVideo) wrap.classList.add('idle'); }, 2500); };
  wrap.addEventListener('mousemove', wake); m.addEventListener('pause', wake); m.addEventListener('play', wake); wake();
  paint();
  if (!invoke) return;
  if (isVideo) {
    const subs = await invoke('subtitles', {path: e.path}).catch(() => []);
    if (media !== m) return;
    subs.forEach(([label, vtt], k) => {
      const tr = document.createElement('track');
      tr.kind = 'subtitles'; tr.label = label || t('ui.subtitles'); tr.srclang = label || lang;
      tr.src = URL.createObjectURL(new Blob([vtt], {type: 'text/vtt'}));
      if (k === 0 && settings.subs) tr.default = true;
      // Subtitles sit a few lines higher, above the controls.
      tr.addEventListener('load', () => { [...(tr.track.cues || [])].forEach(c => { c.snapToLines = true; c.line = -4; }); });
      m.append(tr);
    });
    if (subs.length) toast(t('toast.subs', {n: subs.length}));
    paint();
  } else {
    const a = await invoke('audio_info', {path: e.path}).catch(() => null);
    if (media !== m || !a) return;
    info = {...(info || {}), audio: a};
    if (a.title) wrap.querySelector('.a-title').textContent = a.title;
    wrap.querySelector('.a-sub').textContent = [a.artist, a.album, a.year].filter(Boolean).join(' · ');
    if (a.cover) wrap.querySelector('.cover').innerHTML = `<img src="${a.cover}" alt="">`;
    renderDock();
  }
}
function setAB() {
  if (!media) return;
  const s = media.currentTime;
  if (!abLoop) abLoop = {a: s, b: null};
  else if (abLoop.b == null && s > abLoop.a + .2) abLoop.b = s;
  else abLoop = null;
  media.dispatchEvent(new Event('timeupdate'));
}
function frameStep(dir) {
  if (!media || curEntry().kind !== 'video') return;
  media.pause(); media.currentTime = clamp(media.currentTime + dir / 30, 0, media.duration || 0);
}
async function snapshot() {
  const e = curEntry();
  if (e && e.kind === 'model' && view3d) return savePng(await view3d.png(), e.name.replace(/\.[^.]+$/, '') + '.png');
  if (!media || e.kind !== 'video' || !media.videoWidth) return;
  const c = document.createElement('canvas'); c.width = media.videoWidth; c.height = media.videoHeight;
  c.getContext('2d').drawImage(media, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  savePng(blob, `${e.name.replace(/\.[^.]+$/, '')} ${fmtTime(media.currentTime).replace(/:/g, '-')}.png`);
}
async function savePng(blob, name) {
  if (!blob) return;
  if (!invoke) { const a = Object.assign(document.createElement('a'), {href: URL.createObjectURL(blob), download: name}); a.click(); return; }
  const r = await invoke('save_bytes', new Uint8Array(await blob.arrayBuffer()), {headers: {'x-name': encodeURIComponent(name), 'x-filter': encodeURIComponent('PNG'), 'x-ext': 'png'}}).catch(err => { toast(t('toast.saveFail', {e: err})); return null; });
  if (r) toast(t('toast.saved', {name: r.split(/[\\/]/).pop()}));
}

/* ----- 3D models ----- */
async function showModel(e) {
  const box = document.createElement('div'); box.className = 'model-box';
  const loading = Object.assign(document.createElement('div'), {className: 'loading', textContent: t('ui.loading3d')});
  stage.append(box, loading);
  if (!window.View3D) await new Promise(r => window.addEventListener('view3d-ready', r, {once: true}));
  const my = ++view3dSeq;
  try {
    const v = await View3D.open(box, fileUrl(e.path), extOf(e.name), {background: getComputedStyle(stage).backgroundColor});
    if (my !== view3dSeq) { v.dispose(); return; }
    view3d = v; loading.remove();
    info = {model: v.stats, unit: ['glb', 'gltf'].includes(extOf(e.name)) ? 'm' : 'mm'};
    if (cur().view.wire) v.setWire(true);
    renderDock(); updateStatus(); buildCtxBar();
  } catch (err) {
    if (my === view3dSeq) failed('err.model', e);
    console.warn(err);
  }
}
function setView3d(name) { if (view3d) { view3d.setView(name); cur().view.cam = name; buildCtxBar(); } }
function toggleWire() { if (!view3d) return; const v = cur().view; v.wire = !v.wire; view3d.setWire(v.wire); buildCtxBar(); }

/* ================= Fullscreen ================= */
let full = false;
async function setFull(on) {
  full = on; document.body.classList.toggle('full', on);
  if (invoke) await invoke('set_fullscreen', {on}).catch(() => {});
  else if (on) document.documentElement.requestFullscreen?.().catch(() => {}); else if (document.fullscreenElement) document.exitFullscreen();
  setTimeout(() => { const e = curEntry(); if (e && e.kind === 'image') layoutImage(); }, 120);
}

/* ================= Side panel: info, folder, notes ================= */
function renderDock() {
  if (!booted) return;
  const tab = cur(), e = entryOf(tab);
  $$('#dockTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === settings.dockTab));
  $$('.dpanel').forEach(p => p.classList.toggle('active', p.dataset.panel === settings.dockTab));
  if (settings.dockTab === 'info') $('#infoBox').innerHTML = e ? infoHtml(e, tab) : `<div class="empty">${esc(t('ui.noFile'))}</div>`;
  if (settings.dockTab === 'folder') renderFolder();
  if (settings.dockTab === 'notes') renderNotes();
}
function infoHtml(e, tab) {
  const kv = (k, v) => v || v === 0 ? `<div class="kv"><span>${esc(t(k))}</span><b title="${esc(v)}">${esc(v)}</b></div>` : '';
  let h = `<div class="psec"><div class="psec-h">${esc(t('info.file'))}</div>${kv('info.name', e.name)}${kv('info.kind', t('kind.' + e.kind) + ' · ' + extOf(e.name).toUpperCase())}
    ${kv('info.size', fmtSize(e.size))}${kv('info.modified', fmtDate(e.modified))}${kv('info.position', `${tab.i + 1} / ${tab.list.length}`)}
    <div class="kv"><span>${esc(t('info.folder'))}</span><b title="${esc(tab.folder)}">${esc(tab.folder.split(/[\\/]/).pop())}</b></div>
    <p><button class="btn-sm" data-act="reveal">${esc(t('a.reveal'))}</button> <button class="btn-sm" data-act="copyPath">${esc(t('a.copyPath'))}</button></p></div>`;
  const v = tab.view, i = info || {};
  if (e.kind === 'image') {
    h += `<div class="psec"><div class="psec-h">${esc(t('info.photo'))}</div>${kv('info.pixels', v.w ? `${v.w} × ${v.h}` : '')}${kv('info.megapixels', v.w ? num(v.w * v.h / 1e6) + ' MP' : '')}`;
    for (const [k, val] of (i.fields || [])) h += kv(k, val);
    if (i.gps) {
      const [la, lo] = i.gps;
      h += kv('info.gps', `${num(la, 5)}, ${num(lo, 5)}`) + `<p><button class="btn-sm" data-map="${la},${lo}">${esc(t('info.map'))}</button></p>`;
    }
    h += '</div>';
  }
  if (e.kind === 'video' || e.kind === 'audio') {
    const a = i.audio || {};
    h += `<div class="psec"><div class="psec-h">${esc(t(e.kind === 'video' ? 'info.video' : 'info.audio'))}</div>${kv('info.duration', i.duration ? fmtTime(i.duration) : '')}
      ${kv('info.pixels', i.width ? `${i.width} × ${i.height}` : '')}${kv('info.title', a.title)}${kv('info.artist', a.artist)}${kv('info.album', a.album)}
      ${kv('info.year', a.year)}${kv('info.track', a.track)}${kv('info.genre', a.genre)}${kv('info.bitrate', a.bitrate ? a.bitrate + ' kbit/s' : '')}
      ${kv('info.sampleRate', a.sample_rate ? num(a.sample_rate / 1000) + ' kHz' : '')}${kv('info.channels', a.channels)}</div>`;
  }
  if (e.kind === 'model' && i.model) {
    const m = i.model, u = i.unit, k = u === 'm' ? 1 : 1;
    const len = x => `${num(x * k, 2)} ${u}`, area = x => `${num(x, 1)} ${u}²`, vol = x => u === 'mm' ? `${num(x / 1000, 2)} cm³` : `${num(x, 4)} m³`;
    h += `<div class="psec"><div class="psec-h">${esc(t('info.model'))}</div>${kv('info.width', len(m.x))}${kv('info.depth', len(m.y))}${kv('info.height', len(m.z))}
      ${kv('info.volume', vol(m.volume))}${kv('info.area', area(m.area))}${kv('info.triangles', m.triangles.toLocaleString(loc()))}
      <p class="hint">${esc(t(u === 'mm' ? 'info.unitMm' : 'info.unitM'))}</p></div>`;
  }
  return h;
}
function renderFolder() {
  const tab = cur(), box = $('#folderBox');
  if (!tab) { box.innerHTML = `<div class="empty">${esc(t('ui.noFile'))}</div>`; return; }
  box.innerHTML = `<div class="dtools"><input class="field-in" id="folderFilter" placeholder="${esc(t('ui.filter'))}" value="${esc(tab.filter || '')}"></div>
    <div class="flist">${tab.list.map((x, i) => (!tab.filter || x.name.toLowerCase().includes(tab.filter.toLowerCase())) ? `<button class="fitem${i === tab.i ? ' on' : ''}" data-goto="${i}" title="${esc(x.name)}">
      ${x.kind === 'image' ? `<img loading="lazy" src="${esc(fileUrl(x.path))}" alt="">` : `<span class="ficon">${ICONS['k_' + x.kind]}</span>`}
      <span class="fname">${esc(x.name)}</span><small>${esc(fmtSize(x.size))}</small></button>` : '').join('')}</div>`;
  const on = box.querySelector('.fitem.on'); if (on) on.scrollIntoView({block: 'nearest'});
}
$('#folderBox').addEventListener('input', ev => { if (ev.target.id === 'folderFilter') { cur().filter = ev.target.value; const pos = ev.target.selectionStart; renderFolder(); const f = $('#folderFilter'); f.focus(); f.setSelectionRange(pos, pos); } });
function renderNotes() {
  const e = curEntry(), box = $('#notesBox');
  if (!e) { box.innerHTML = `<div class="empty">${esc(t('ui.noFile'))}</div>`; return; }
  const list = notes[e.path] || [], timed = e.kind === 'video' || e.kind === 'audio';
  box.innerHTML = `<p class="hint">${esc(t(timed ? 'notes.hintTimed' : 'notes.hint'))}</p>
    <textarea class="note-in" id="noteIn" placeholder="${esc(t('notes.ph'))}"></textarea>
    <p><button class="btn-sm primary" data-note-add>${esc(t(timed ? 'notes.addAt' : 'notes.add'))}</button> <button class="btn-sm" data-act="exportNotes"${list.length ? '' : ' disabled'}>${esc(t('a.exportNotes'))}</button></p>
    ${list.map((n, k) => `<div class="note"><div class="note-h">${n.t != null ? `<button class="tstamp" data-seek="${n.t}">${esc(fmtTime(n.t))}</button>` : ''}<span class="flex"></span><button class="x" data-note-del="${k}" title="${esc(t('notes.delete'))}">&#10005;</button></div><div class="note-t">${esc(n.text)}</div></div>`).join('')}`;
}
function addNote() {
  const e = curEntry(), text = ($('#noteIn') || {}).value || ''; if (!e || !text.trim()) return;
  const timed = (e.kind === 'video' || e.kind === 'audio') && media;
  const list = notes[e.path] = notes[e.path] || [];
  list.push({t: timed ? Math.floor(media.currentTime) : null, text: text.trim()});
  if (timed) list.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  saveNotes(); renderNotes();
}
function notesMarkdown(e) {
  const list = notes[e.path] || [];
  return `# ${e.name}\n\n` + list.map(n => n.t != null ? `- **${fmtTime(n.t)}** ${n.text.replace(/\n/g, '\n  ')}` : `- ${n.text.replace(/\n/g, '\n  ')}`).join('\n') + '\n';
}
$('#dock').addEventListener('click', ev => {
  const g = ev.target.closest('[data-goto]'); if (g) return goTo(+g.dataset.goto);
  if (ev.target.closest('[data-note-add]')) return addNote();
  const d = ev.target.closest('[data-note-del]'); if (d) { const e = curEntry(); notes[e.path].splice(+d.dataset.noteDel, 1); if (!notes[e.path].length) delete notes[e.path]; saveNotes(); return renderNotes(); }
  const s = ev.target.closest('[data-seek]'); if (s && media) { media.currentTime = +s.dataset.seek; media.play().catch(() => {}); return; }
  const mp = ev.target.closest('[data-map]'); if (mp && invoke) { const [la, lo] = mp.dataset.map.split(','); invoke('open_url', {url: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`}); }
});
$('#dock').addEventListener('keydown', ev => { if (ev.target.id === 'noteIn' && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); addNote(); } });
$$('#dockTabs button').forEach(b => b.onclick = () => { settings.dockTab = b.dataset.tab; settings.dock = true; applySettings(); });

/* ================= Tabs, status, start screen ================= */
function renderTabs() {
  const box = $('#tabs'); box.innerHTML = '';
  tabs.forEach((tb, i) => {
    const e = entryOf(tb), el = document.createElement('div');
    el.className = 'tab' + (i === active ? ' active' : ''); el.title = e ? e.path : '';
    el.innerHTML = `<span class="tab-ico">${esc(e ? extOf(e.name).toUpperCase().slice(0, 4) : '')}</span><span class="name">${esc(e ? e.name : '')}</span><button class="x" title="${esc(tip('closeTab'))}">&#10005;</button>`;
    el.onmousedown = ev => { if (ev.button === 1) { ev.preventDefault(); closeTab(i); } };
    el.onclick = ev => { if (ev.target.closest('.x')) closeTab(i); else if (i !== active) activate(i); };
    box.append(el);
  });
  const plus = document.createElement('button'); plus.className = 'tab-new'; plus.textContent = '+'; plus.title = tip('openFile'); plus.onclick = () => openFiles();
  box.append(plus);
}
function updateTitle() {
  const e = curEntry(), title = e ? `${e.name} — Viewer Studio` : 'Viewer Studio';
  document.title = title; $('#apptitle').textContent = title;
}
function updateStatus() {
  const tab = cur(), e = entryOf(tab), v = tab ? tab.view : {}, i = info || {};
  $('#stKind').textContent = e ? t('kind.' + e.kind) : t('ui.ready');
  $('#stPos').textContent = e ? `${tab.i + 1} / ${tab.list.length}` : '';
  $('#stDims').textContent = !e ? '' : e.kind === 'image' && v.w ? `${v.w} × ${v.h}` : i.width ? `${i.width} × ${i.height}` : i.model ? `${num(i.model.x, 1)} × ${num(i.model.y, 1)} × ${num(i.model.z, 1)} ${i.unit}` : '';
  $('#stSize').textContent = e ? fmtSize(e.size) : '';
  $('#stZoom').hidden = !e || e.kind !== 'image'; $('#stTime').hidden = !e || (e.kind !== 'video' && e.kind !== 'audio');
  if (e && e.kind === 'image') layoutImage();
}
const FORMATS = {image: 'JPG · PNG · GIF · WebP · AVIF · HEIC · TIFF · BMP · SVG', video: 'MP4 · MKV · MOV · AVI · WMV · WebM · MPG · TS', audio: 'MP3 · FLAC · WAV · M4A · OGG · WMA · AC-3', model: 'STL · OBJ · GLB · GLTF · 3MF · PLY'};
function renderEmpty() {
  $('#formats').innerHTML = Object.entries(FORMATS).map(([k, f]) => `<div><b>${ICONS['k_' + k]}${esc(t('kinds.' + k))}</b><small>${esc(f)}</small></div>`).join('');
  $('#recentBox').innerHTML = recent.length ? `<div class="sect">${esc(t('ui.recent'))}</div>` + recent.map((r, k) =>
    `<button data-recent="${k}"><span class="ficon">${ICONS[r.kind === 'folder' ? 'folder' : 'k_' + r.kind] || ''}</span><span>${esc(r.name)}</span><small>${esc(r.path)}</small></button>`).join('') : '';
}
$('#recentBox').addEventListener('click', ev => { const b = ev.target.closest('[data-recent]'); if (!b) return; const r = recent[+b.dataset.recent]; openPaths([r.path], r.kind === 'folder'); });

/* ================= Option bar for the shown kind ================= */
function buildCtxBar() {
  const box = $('#ctxBar'), e = curEntry(); box.innerHTML = '';
  if (!e) return;
  const group = (...nodes) => { const g = document.createElement('div'); g.className = 'group'; g.append(...nodes); box.append(g); return g; };
  if (e.kind === 'image') {
    const sel = document.createElement('select'); sel.id = 'zoomSel'; sel.title = t('ui.zoom');
    sel.innerHTML = `<option value="fit">${esc(t('ui.fit'))}</option>` + ZOOMS.map(z => `<option value="${z}">${Math.round(z * 100)} %</option>`).join('');
    sel.onchange = () => { setZoom(sel.value === 'fit' ? 'fit' : +sel.value); };
    group(makeBtn('zoomOut', ICONS.minus), sel, makeBtn('zoomIn', ICONS.plus));
    group(makeBtn('rotateLeft', ICONS.rotL), makeBtn('rotateRight', ICONS.rotR));
    group(makeBtn('slideshow', ICONS.play));
    layoutImage();
  } else if (e.kind === 'model') {
    const v = cur().view;
    const seg = document.createElement('div'); seg.className = 'seg';
    seg.innerHTML = ['iso', 'front', 'top', 'side'].map(n => `<button data-cam="${n}" class="${(v.cam || 'iso') === n ? 'active' : ''}" title="${esc(tip('view' + n[0].toUpperCase() + n.slice(1)))}">${esc(t('view.' + n))}</button>`).join('');
    seg.onclick = ev => { const b = ev.target.closest('[data-cam]'); if (b) setView3d(b.dataset.cam); };
    const wire = makeBtn('wireframe', ICONS.wire); wire.classList.toggle('active', !!v.wire);
    group(seg); group(wire, makeBtn('snapshot', ICONS.camera));
  } else {
    const loop = makeBtn('loopFile', ICONS.loop); loop.classList.toggle('active', settings.loopFile);
    group(makeBtn('abLoop', ICONS.ab), loop, ...(e.kind === 'video' ? [makeBtn('snapshot', ICONS.camera)] : []));
  }
  syncDisabled();
}

/* ================= Actions, menus, shortcuts ================= */
const isKind = (...k) => { const e = curEntry(); return !!e && k.includes(e.kind); };
const A = {
  openFile: () => openFiles(), openFolder: () => openFolder(), closeTab: () => closeTab(),
  reveal: () => { const e = curEntry(); if (e && invoke) invoke('reveal', {path: e.path}).catch(err => toast(String(err))); },
  copyPath: () => { const e = curEntry(); if (!e) return; (invoke ? invoke('clipboard_write', {text: e.path}) : navigator.clipboard.writeText(e.path)).then(() => toast(t('toast.copied'))); },
  exportNotes: async () => {
    const e = curEntry(); if (!e || !(notes[e.path] || []).length) return;
    const md = notesMarkdown(e), name = e.name.replace(/\.[^.]+$/, '') + ' – ' + t('notes.title') + '.md';
    if (!invoke) return;
    const r = await invoke('save_text', {name, filter: 'Markdown', ext: 'md', content: md}).catch(err => { toast(t('toast.saveFail', {e: err})); return null; });
    if (r) toast(t('toast.saved', {name: r.split(/[\\/]/).pop()}));
  },
  prevFile: () => go(-1), nextFile: () => go(1), firstFile: () => goTo(0), lastFile: () => { const tb = cur(); if (tb) goTo(tb.list.length - 1); },
  zoomIn: () => zoomStep(1), zoomOut: () => zoomStep(-1), zoomFit: () => setZoom('fit'), zoom100: () => setZoom(1),
  rotateLeft: () => rotate(-90), rotateRight: () => rotate(90),
  slideshow: () => slideTimer ? stopSlideshow() : startSlideshow(),
  fullscreen: () => setFull(!full),
  playPause: () => { if (!media) return; if (media.paused) media.play().catch(() => {}); else media.pause(); },
  back10: () => { if (media) media.currentTime = Math.max(0, media.currentTime - 10); },
  fwd10: () => { if (media) media.currentTime = Math.min(media.duration || 0, media.currentTime + 10); },
  toggleMute: () => { if (!media) return; media.muted = !media.muted; settings.muted = media.muted; saveState(); },
  speedUp: () => speed(1), speedDown: () => speed(-1),
  frameNext: () => frameStep(1), framePrev: () => frameStep(-1),
  abLoop: () => setAB(),
  loopFile: () => { settings.loopFile = !settings.loopFile; if (media) media.loop = settings.loopFile; saveState(); buildCtxBar(); toast(t(settings.loopFile ? 'toast.loopOn' : 'toast.loopOff')); },
  toggleSubs: () => {
    settings.subs = !settings.subs; saveState();
    if (media) [...media.textTracks].forEach((tr, k) => { tr.mode = settings.subs && k === 0 ? 'showing' : 'disabled'; });
    if (media) media.dispatchEvent(new Event('timeupdate'));
  },
  snapshot: () => snapshot(),
  viewIso: () => setView3d('iso'), viewFront: () => setView3d('front'), viewTop: () => setView3d('top'), viewSide: () => setView3d('side'),
  wireframe: () => toggleWire(),
  togglePanels: () => { settings.dock = !settings.dock; applySettings(); },
  toggleAutoHide: () => { settings.autoHide = !settings.autoHide; applySettings(); },
  settings: () => openSettings(),
  langAuto: () => setLang('auto'), langEn: () => setLang('en'), langDe: () => setLang('de'),
  themeDark: () => setTheme('dark'), themeLight: () => setTheme('light'), themeGithub: () => setTheme('github'), themeGithubDark: () => setTheme('github-dark'),
  shortcuts: () => {
    let h = '';
    MENUS.forEach(([m, items]) => {
      const rows = items.filter(it => Array.isArray(it) && it[1]);
      if (rows.length) h += `<h4>${esc(t('menu.' + m))}</h4><table>` + rows.map(it => `<tr><td>${esc(t('a.' + it[0]))}</td><td><kbd>${esc(fmtKey(it[1]))}</kbd></td></tr>`).join('') + '</table>';
    });
    h += `<h4>${esc(t('keys.more'))}</h4><table>${[['keys.arrows', '← →'], ['keys.arrowsMedia', '← →'], ['keys.volume', '↑ ↓'], ['keys.wheel', t('keys.wheelKey')]].map(([k, v]) => `<tr><td>${esc(t(k))}</td><td><kbd>${esc(v)}</kbd></td></tr>`).join('')}</table>`;
    modal(t('a.shortcuts'), h);
  },
  about: async () => {
    const v = invoke ? await window.__TAURI__.app.getVersion().catch(() => '') : '';
    modal(t('a.about'), `${v ? `<p><b>${esc(t('about.version', {v}))}</b></p>` : ''}<p>${esc(t('about.p1'))}</p><p>${esc(t('about.p2'))}</p><p class="hint">${esc(t('about.licenses'))}</p>`);
  }
};
function speed(dir) {
  if (!media) return;
  const list = [.25, .5, .75, 1, 1.25, 1.5, 1.75, 2, 3, 4], r = media.playbackRate;
  media.playbackRate = dir > 0 ? (list.find(s => s > r + 1e-3) || 4) : ([...list].reverse().find(s => s < r - 1e-3) || .25);
  const sel = $('#speed'); if (sel) sel.value = String(media.playbackRate);
  toast(t('toast.speed', {s: num(media.playbackRate, 2)}));
}
// Menu items: [action, shortcut, checked(), fixed, more keys]; '-' separator, '#key' section label (as in every Studio app).
const MENUS = [
  ['file', [['openFile', 'Ctrl+O'], ['openFolder', 'Ctrl+Shift+O'], '-', ['snapshot', 'Ctrl+Shift+S'], ['exportNotes'], '-', ['reveal', 'Ctrl+Shift+E'], ['copyPath', 'Ctrl+Shift+C'], '-', ['closeTab', 'Alt+W']]],
  ['view', [['prevFile', 'PageUp'], ['nextFile', 'PageDown'], ['firstFile', 'Ctrl+Home'], ['lastFile', 'Ctrl+End'], '-',
    ['zoomIn', 'Ctrl+=', null, false, ['Ctrl++']], ['zoomOut', 'Ctrl+-'], ['zoomFit', 'Ctrl+0'], ['zoom100', 'Ctrl+1'], ['rotateLeft', 'Ctrl+L'], ['rotateRight', 'Ctrl+R'], '-',
    ['slideshow', 'F5', () => !!slideTimer], ['fullscreen', 'F11', () => full], '-',
    ['togglePanels', 'Ctrl+\\', () => settings.dock], ['toggleAutoHide', null, () => settings.autoHide]]],
  ['play', [['playPause', 'Space'], ['back10', 'J'], ['fwd10', 'L'], ['framePrev', ','], ['frameNext', '.'], '-', ['speedDown', '['], ['speedUp', ']'], ['toggleMute', 'M'], '-',
    ['abLoop', 'B'], ['loopFile', null, () => settings.loopFile], ['toggleSubs', 'C', () => settings.subs]]],
  ['model', [['viewIso', '0'], ['viewFront', '1'], ['viewTop', '2'], ['viewSide', '3'], '-', ['wireframe', 'W', () => !!(cur() && cur().view.wire)]]],
  ['settings', [['settings', 'Ctrl+,'], '-', '#menu.language',
    ['langAuto', null, () => settings.lang === 'auto'], ['langEn', null, () => settings.lang === 'en'], ['langDe', null, () => settings.lang === 'de'],
    '-', '#menu.theme',
    ['themeDark', null, () => settings.theme === 'dark'], ['themeLight', null, () => settings.theme === 'light'],
    ['themeGithub', null, () => settings.theme === 'github'], ['themeGithubDark', null, () => settings.theme === 'github-dark']]],
  ['help', [['shortcuts', 'F1'], '-', ['about']]]
];
const NEEDS = {
  closeTab: () => !!cur(), reveal: () => !!curEntry() && !!invoke, copyPath: () => !!curEntry(), exportNotes: () => { const e = curEntry(); return !!e && (notes[e.path] || []).length > 0; },
  prevFile: () => !!cur() && cur().i > 0, nextFile: () => !!cur() && cur().i < cur().list.length - 1, firstFile: () => !!cur(), lastFile: () => !!cur(),
  zoomIn: () => isKind('image'), zoomOut: () => isKind('image'), zoomFit: () => isKind('image'), zoom100: () => isKind('image'),
  rotateLeft: () => isKind('image'), rotateRight: () => isKind('image'), slideshow: () => !!cur() && cur().list.some(x => x.kind === 'image'), fullscreen: () => !!curEntry(),
  playPause: () => !!media, back10: () => !!media, fwd10: () => !!media, toggleMute: () => !!media, speedUp: () => !!media, speedDown: () => !!media,
  frameNext: () => isKind('video'), framePrev: () => isKind('video'), abLoop: () => !!media, toggleSubs: () => isKind('video'),
  snapshot: () => isKind('video', 'model'), viewIso: () => isKind('model'), viewFront: () => isKind('model'), viewTop: () => isKind('model'), viewSide: () => isKind('model'), wireframe: () => isKind('model')
};
const allowed = act => !NEEDS[act] || NEEDS[act]();
function run(act) { if (A[act] && allowed(act)) A[act](); }
function syncDisabled() { $$('[data-act]').forEach(b => { if (A[b.dataset.act]) b.disabled = !allowed(b.dataset.act); }); }
const KEYMAP = {};
function buildKeymap() {
  for (const k in KEYMAP) delete KEYMAP[k];
  MENUS.forEach(([, items]) => items.forEach(it => { if (Array.isArray(it) && !it[3]) [it[1], ...(it[4] || [])].forEach(k => { if (k) KEYMAP[k] = it[0]; }); }));
}
let menuOpen = null;
function openMenu(m, items) {
  closeMenus();
  const dd = m.querySelector('.dropdown'); dd.innerHTML = '';
  items.forEach(it => {
    if (it === '-') return dd.append(document.createElement('hr'));
    if (typeof it === 'string') return dd.append(Object.assign(document.createElement('div'), {className: 'dd-label', textContent: t(it.slice(1))}));
    const [act, key, check] = it, b = document.createElement('button');
    b.innerHTML = `<span class="chk">${check && check() ? '&#10003;' : ''}</span><span>${esc(t('a.' + act))}</span><kbd>${esc(key ? fmtKey(key) : '')}</kbd>`;
    b.disabled = !allowed(act);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => { closeMenus(); run(act); };
    dd.append(b);
  });
  m.classList.add('open'); menuOpen = m;
}
function closeMenus() { $$('.menu.open').forEach(x => x.classList.remove('open')); menuOpen = null; }
function buildMenubar() {
  const nav = $('#menus'); nav.innerHTML = ''; menuOpen = null;
  MENUS.forEach(([name, items]) => {
    const m = document.createElement('div'), b = document.createElement('button'), dd = document.createElement('div');
    m.className = 'menu'; dd.className = 'dropdown'; b.textContent = t('menu.' + name);
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => menuOpen === m ? closeMenus() : openMenu(m, items);
    b.onmouseenter = () => { if (menuOpen && menuOpen !== m) openMenu(m, items); };
    m.append(b, dd); nav.append(m);
  });
}
document.addEventListener('mousedown', e => { if (menuOpen && !e.target.closest('.menu')) closeMenus(); });
const keyOf = act => { for (const [, items] of MENUS) for (const it of items) if (Array.isArray(it) && it[0] === act && it[1]) return it[1]; return ''; };
const tip = act => t('a.' + act) + (keyOf(act) ? ` (${fmtKey(keyOf(act))})` : '');

const SV = p => `<svg viewBox="0 0 24 24">${p}</svg>`;
const ICONS = {
  open: SV('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
  folder: SV('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  prev: SV('<path d="m15 18-6-6 6-6"/>'), next: SV('<path d="m9 18 6-6-6-6"/>'),
  plus: SV('<path d="M12 5v14M5 12h14"/>'), minus: SV('<path d="M5 12h14"/>'),
  rotL: SV('<path d="M3 2v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>'), rotR: SV('<path d="M21 2v6h-6"/><path d="M21 13a9 9 0 1 1-3-7.7L21 8"/>'),
  play: SV('<path d="m6 4 14 8-14 8z" fill="currentColor"/>'), pause: SV('<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor"/>'),
  back10: SV('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">10</text>'),
  fwd10: SV('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/><text x="12" y="15.5" font-size="7" text-anchor="middle" fill="currentColor" stroke="none">10</text>'),
  volume: SV('<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
  muted: SV('<path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor"/><path d="m22 9-6 6M16 9l6 6"/>'),
  subs: SV('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 12h4M12 12h6M6 15h8M16 15h2"/>'),
  camera: SV('<path d="M4 7h3l2-3h6l2 3h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/><circle cx="12" cy="13" r="4"/>'),
  full: SV('<path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5"/>'),
  loop: SV('<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>'),
  ab: SV('<text x="12" y="16" font-size="10" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">A–B</text>'),
  wire: SV('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/>'),
  panel: SV('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>'),
  help: SV('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01"/>'),
  gear: SV('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  fit: SV('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8" y="8" width="8" height="8" rx="1"/>'),
  one: SV('<rect x="3" y="3" width="18" height="18" rx="2"/><text x="12" y="16" font-size="9" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none">1:1</text>'),
  reveal: SV('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v5M9.5 13.5 12 16l2.5-2.5"/>'),
  info: SV('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>'),
  k_image: SV('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>'),
  k_video: SV('<rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3z"/>'),
  k_audio: SV('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  k_model: SV('<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/>')
};
function makeBtn(act, html, cls = '') {
  const b = document.createElement('button');
  b.className = 'ibtn' + (cls ? ' ' + cls : ''); b.innerHTML = html; b.title = tip(act); b.dataset.act = act;
  return b;
}
function buildToolbars() {
  const fill = (id, list) => { const box = $(id); box.innerHTML = ''; list.forEach(([a, i]) => box.append(makeBtn(a, i))); };
  fill('#fileBtns', [['openFile', ICONS.open], ['openFolder', ICONS.folder], ['prevFile', ICONS.prev], ['nextFile', ICONS.next]]);
  fill('#viewBtns', [['fullscreen', ICONS.full], ['togglePanels', ICONS.panel], ['settings', ICONS.gear], ['shortcuts', ICONS.help]]);
  const tools = $('#tools'); tools.innerHTML = '';
  [['zoomFit', 'fit'], ['zoom100', 'one'], ['rotateLeft', 'rotL'], ['rotateRight', 'rotR'], '-', ['playPause', 'play'], ['snapshot', 'camera'], ['wireframe', 'wire'], '-', ['slideshow', 'play'], ['fullscreen', 'full'], '-', ['reveal', 'reveal']]
    .forEach(r => { if (r === '-') { const s = document.createElement('div'); s.className = 'sep'; tools.append(s); } else tools.append(makeBtn(r[0], ICONS[r[1]])); });
  $$('[data-act="togglePanels"]').forEach(b => b.classList.toggle('active', settings.dock));
  buildCtxBar(); syncDisabled();
}
document.addEventListener('mousedown', e => { if (e.target.closest('.ibtn,.cta,.cbtn')) e.preventDefault(); });
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) run(b.dataset.act); });

/* ================= Modal, toast, settings ================= */
let settingsOpen = false, prefsSection = 'general', toastT = 0;
function toast(msg) { const n = $('#toast'); n.textContent = msg; n.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => n.classList.remove('show'), 2600); }
function modal(title, html) {
  $('.modal').classList.remove('wide'); $('#modalFoot').hidden = true; settingsOpen = false;
  $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html; $('#modal').classList.add('show');
}
function closeModal() { $('#modal').classList.remove('show'); settingsOpen = false; }
$('#modalClose').onclick = closeModal;
$('#modal').onmousedown = e => { if (e.target.id === 'modal') closeModal(); };
function openSettings(section) {
  if (section) prefsSection = section;
  $('.modal').classList.add('wide'); $('#modalFoot').hidden = false;
  settingsOpen = true; renderSettings(); $('#modal').classList.add('show');
}
function renderSettings() {
  const opt = (v, label, c) => `<option value="${v}"${String(v) === String(c) ? ' selected' : ''}>${esc(label)}</option>`;
  const sw = (name, label) => `<label class="switch"><input type="checkbox" data-sw="${name}"${settings[name] ? ' checked' : ''}><span></span>${esc(label)}</label>`;
  const mock = th => `<div class="tc-mock" data-theme="${th}"><div class="tc-bar"><i></i><i></i><i></i><b></b></div>
    <div class="tc-body" style="grid-template-columns:14px 1fr 38px"><div class="tc-rail"></div>
    <div class="tc-pv" style="padding:10px 12px"><div class="tc-paper" style="border-radius:3px;border-bottom:var(--paper-border)"><i></i><i style="width:70%"></i><i style="width:50%"></i></div></div><div class="tc-dock"></div></div></div>`;
  const body = {
    general: `<h3>${esc(t('set.language'))}</h3><p class="hint">${esc(t('set.languageHint'))}</p>
      <select class="wide-sel" data-sel="lang">${opt('auto', t('a.langAuto'), settings.lang)}${opt('en', 'English', settings.lang)}${opt('de', 'Deutsch', settings.lang)}</select>
      <h3>${esc(t('set.layout'))}</h3>${sw('dock', t('set.panels'))}${sw('autoHide', t('set.autoHide'))}`,
    appearance: `<h3>${esc(t('set.theme'))}</h3><div class="theme-grid">` + THEMES.map(th =>
      `<button class="theme-card${settings.theme === th ? ' active' : ''}" data-theme-pick="${th}">${mock(th)}
       <div class="theme-name">${esc(t('theme.' + th))}<span>${settings.theme === th ? '&#10003;' : ''}</span></div></button>`).join('') + '</div>' +
      `<h3>${esc(t('set.stage'))}</h3><select class="wide-sel" data-sel="stage">${['dark', 'black', 'theme', 'light', 'checker'].map(s => opt(s, t('stage.' + s), settings.stage)).join('')}</select>`,
    viewing: `<h3>${esc(t('set.playback'))}</h3>${sw('autoplay', t('set.autoplay'))}${sw('remember', t('set.remember'))}${sw('subs', t('set.subs'))}
      <h3>${esc(t('set.slideSec'))} <span class="val">${settings.slideSec} s</span></h3><input type="range" data-range="slideSec" min="1" max="20" step="1" value="${settings.slideSec}">
      <h3>${esc(t('set.forget'))}</h3><p class="hint">${esc(t('set.forgetHint'))}</p><p><button class="btn-sm" data-pref="forgetPos">${esc(t('set.forgetPos'))}</button> <button class="btn-sm" data-pref="forgetRecent">${esc(t('set.forgetRecent'))}</button></p>`,
    keys: '<div id="keysBox"></div>'
  };
  const sections = ['general', 'appearance', 'viewing', 'keys'];
  $('#modalTitle').textContent = t('set.title');
  $('#modalBody').innerHTML = `<div class="prefs"><nav>${sections.map(k =>
    `<button data-sec="${k}" class="${k === prefsSection ? 'active' : ''}">${esc(t('set.' + k))}</button>`).join('')}</nav><section>${body[prefsSection]}</section></div>`;
  if (prefsSection === 'keys') Shortcuts.editor($('#keysBox'), {MENUS, keys: settings.keys || {}, t, fmtKey, comboOf, label: a => t('a.' + a),
    onChange: keys => { settings.keys = keys; applySettings(); }});
  $('#modalFoot').innerHTML = `<button class="btn-sm" data-pref="reset">${esc(t('set.reset'))}</button><span class="flex"></span>
    <button class="btn-sm primary" data-pref="done">${esc(t('set.done'))}</button>`;
}
$('#modal').addEventListener('click', e => {
  if (!settingsOpen) return;
  const el = e.target.closest('[data-sec],[data-theme-pick],[data-pref]'); if (!el) return;
  if (el.dataset.sec) prefsSection = el.dataset.sec;
  else if (el.dataset.themePick) settings.theme = el.dataset.themePick;
  else if (el.dataset.pref === 'done') return closeModal();
  else if (el.dataset.pref === 'reset') { const keep = {theme: settings.theme, lang: settings.lang}; settings = {...DEF, ...keep}; toast(t('set.resetDone')); }
  else if (el.dataset.pref === 'forgetPos') { positions = {}; try { localStorage.removeItem(POS); } catch (er) {} toast(t('toast.forgotten')); }
  else if (el.dataset.pref === 'forgetRecent') { recent = []; saveState(); renderEmpty(); toast(t('toast.forgotten')); }
  applySettings(); renderSettings();
});
$('#modal').addEventListener('change', e => {
  if (!settingsOpen) return;
  const el = e.target;
  if (el.dataset.sw) settings[el.dataset.sw] = el.checked;
  else if (el.dataset.sel) settings[el.dataset.sel] = el.value;
  else return;
  applySettings(); renderSettings();
});
$('#modal').addEventListener('input', e => {
  if (!settingsOpen || !e.target.dataset.range) return;
  settings[e.target.dataset.range] = +e.target.value; saveState();
  e.target.previousElementSibling.querySelector('.val').textContent = e.target.value + ' s';
});
function setLang(l) { settings.lang = l; applySettings(); }
function setTheme(th) { settings.theme = th; applySettings(); }
function applyLanguage() {
  document.documentElement.lang = lang;
  $$('[data-i18n]').forEach(n => n.textContent = t(n.dataset.i18n));
  buildMenubar(); buildToolbars(); renderTabs();
  if (booted) { renderDock(); renderEmpty(); updateStatus(); }
}
let appliedKeys = null;
function applySettings() {
  if (window.AutoHide) AutoHide.set(settings.autoHide);
  if (!THEMES.includes(settings.theme)) settings.theme = 'dark';
  if (window.Shared) Shared.push({theme: settings.theme, lang: settings.lang});
  document.documentElement.dataset.theme = settings.theme;
  if (JSON.stringify(settings.keys || {}) !== appliedKeys) { appliedKeys = JSON.stringify(settings.keys || {}); Shortcuts.apply(MENUS, settings.keys || {}); buildKeymap(); buildToolbars(); }
  const nl = effectiveLang();
  if (nl !== lang) { lang = nl; applyLanguage(); }
  $('#dock').classList.toggle('hidden', !settings.dock);
  $$('[data-act="togglePanels"]').forEach(b => b.classList.toggle('active', settings.dock));
  stage.className = stage.className.replace(/\bbg-\S+/g, '').trim() + ' bg-' + settings.stage;
  if (view3d) view3d.setBackground(getComputedStyle(stage).backgroundColor);
  if (media) media.loop = settings.loopFile;
  if (booted) { renderDock(); updateStatus(); }
  saveState();
}

/* ================= Keyboard ================= */
function comboOf(e) {
  let k = e.key;
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (e.code === 'Comma') k = ',';
  else if (e.code === 'Period') k = '.';
  else if (e.code === 'Backslash' || e.code === 'IntlBackslash') k = '\\';
  else if (e.code === 'BracketLeft') k = '[';
  else if (e.code === 'BracketRight') k = ']';
  else if (e.code === 'Space') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  return (e.ctrlKey || e.metaKey ? 'Ctrl+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + k;
}
const typing = () => { const a = document.activeElement; return a && ((a.tagName === 'INPUT' && !['range', 'checkbox'].includes(a.type)) || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };
window.addEventListener('keydown', e => {
  if (window.Shortcuts && Shortcuts.recording) return;
  if (e.key === 'Escape') {
    if ($('#modal').classList.contains('show')) closeModal();
    else if (menuOpen) closeMenus();
    else if (slideTimer) stopSlideshow();
    else if (full) setFull(false);
    return;
  }
  if (e.ctrlKey && e.altKey) return;
  if ($('#modal').classList.contains('show') || typing()) return;
  const combo = comboOf(e), kind = (curEntry() || {}).kind;
  // Arrows: photos and models page through the folder; video and audio jump 5 s (volume with ↑ ↓).
  if (!e.ctrlKey && !e.altKey && !e.shiftKey && /^Arrow/.test(e.key) && kind) {
    e.preventDefault();
    if ((kind === 'video' || kind === 'audio') && media) {
      if (e.key === 'ArrowLeft') media.currentTime = Math.max(0, media.currentTime - 5);
      else if (e.key === 'ArrowRight') media.currentTime = Math.min(media.duration || 0, media.currentTime + 5);
      else { media.volume = clamp(media.volume + (e.key === 'ArrowUp' ? .05 : -.05), 0, 1); settings.volume = media.volume; saveState(); const v = $('#vol'); if (v) v.value = media.volume; }
    } else if (kind !== 'model' || !e.target.closest('canvas')) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') go(-1); else go(1);
    }
    return;
  }
  const act = KEYMAP[combo];
  if (act) { e.preventDefault(); e.stopPropagation(); run(act); }
}, true);

/* ================= Drag & drop, right-click ================= */
if (window.__TAURI__) window.__TAURI__.event.listen('tauri://drag-drop', ev => { const p = (ev.payload && ev.payload.paths) || []; if (p.length) openPaths(p); });
{
  const item = act => ({id: act, label: t('a.' + act), accel: keyOf(act) || null, enabled: allowed(act)});
  Native.setProvider(e => {
    if (e.target.closest('#stage')) {
      const k = (curEntry() || {}).kind;
      const per = {image: ['zoomFit', 'zoom100', 'rotateLeft', 'rotateRight', null, 'slideshow'], video: ['playPause', 'abLoop', 'toggleSubs', 'snapshot'],
        audio: ['playPause', 'abLoop', 'loopFile'], model: ['viewIso', 'viewFront', 'viewTop', 'viewSide', 'wireframe', 'snapshot']}[k] || [];
      return [...per.map(a => a ? item(a) : null), null, item('prevFile'), item('nextFile'), null, item('fullscreen'), item('reveal'), item('copyPath')];
    }
    if (e.target.closest('.tab')) return [item('closeTab')];
    return null;
  });
  Native.setHandler(id => run(id));
}

/* Test hook (like the other apps' __md / __dt / __pl). */
window.__vw = {A, run, get tabs() { return tabs; }, get active() { return active; }, cur, curEntry, openPaths, openResults, settings: () => settings,
  media: () => media, view3d: () => view3d, info: () => info, notes: () => notes, positions: () => positions, notesMarkdown, setZoom, goTo};

/* ================= Boot ================= */
(async function boot() {
  await loadTexts();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE)); } catch (e) {}
  if (saved) { if (saved.settings) settings = {...DEF, ...saved.settings}; recent = saved.recent || []; }
  // Theme and language shared by all Studio apps (shared.js); the shared values win over this app's own.
  if (window.Shared) await Shared.init({apply: sh => {
    if (sh.theme) settings.theme = sh.theme;
    if (sh.lang) settings.lang = sh.lang;
    if (booted) applySettings();
  }});
  lang = effectiveLang();
  applyLanguage();
  booted = true;
  applySettings();
  show();
  if (invoke) {
    invoke('initial_files').then(list => openResults(list)).catch(() => {});
    window.__TAURI__.event.listen('open-files', e => openResults(e.payload));
  }
})();
