/* Viewer Studio: the plain logic of sorting, filtering, marks, histogram and playlists — no window needed, so it can be
   tested on its own (loaded before app.js). */
'use strict';
const naturalCmp = (a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}) || (a < b ? -1 : a > b ? 1 : 0);
const extOfName = n => (/\.([^.\\/]+)$/.exec(n) || [, ''])[1].toLowerCase();
/* A sorted copy. key: name | date | size | type; dir: 1 or -1. Equal ones stay in name order. */
function sortEntries(list, key, dir = 1) {
  const by = {
    name: () => 0,
    date: (a, b) => a.modified - b.modified,
    size: (a, b) => a.size - b.size,
    type: (a, b) => a.kind.localeCompare(b.kind) || extOfName(a.name).localeCompare(extOfName(b.name))
  }[key] || (() => 0);
  return [...list].sort((a, b) => (by(a, b) || naturalCmp(a.name, b.name)) * dir);
}
/* mark: all | none (no stars, no color) | s1 … s5 (at least so many stars) | a color name */
function passesMark(m, mark) {
  if (!mark || mark === 'all') return true;
  if (mark === 'none') return !m.stars && !m.color;
  if (/^s[1-5]$/.test(mark)) return (m.stars || 0) >= +mark[1];
  return m.color === mark;
}
/* The positions in the list that the filter lets through. f: {kind, mark, text} */
function visibleIndexes(list, f, markOf) {
  const text = (f.text || '').toLowerCase(), out = [];
  list.forEach((e, i) => {
    if (f.kind && f.kind !== 'all' && e.kind !== f.kind) return;
    if (text && !e.name.toLowerCase().includes(text)) return;
    if (!passesMark(markOf(e.path), f.mark)) return;
    out.push(i);
  });
  return out;
}
/* The next visible position from i (which may itself be filtered out), or -1 at the end. */
function stepVisible(vis, i, step, wrap = false) {
  if (!vis.length) return -1;
  const at = vis.indexOf(i);
  if (at < 0) {
    const n = step > 0 ? vis.find(x => x > i) : [...vis].reverse().find(x => x < i);
    return n ?? (wrap ? vis[step > 0 ? 0 : vis.length - 1] : -1);
  }
  const p = at + step;
  if (wrap) return vis[(p % vis.length + vis.length) % vis.length];
  return p < 0 || p >= vis.length ? -1 : vis[p];
}
/* Marks of one file: the patch's empty values (0, null) are removed; an empty record is no record. */
function mergeMark(old, patch) {
  const m = {...old, ...patch};
  for (const k of Object.keys(m)) if (!m[k]) delete m[k];
  return Object.keys(m).length ? m : null;
}
/* Mirroring is asked for as seen on the screen: on a photo turned sideways that is the other axis of the file. */
function flipped(view, axis) {
  const a = view.rot % 180 ? (axis === 'x' ? 'y' : 'x') : axis;
  return a === 'x' ? {fx: !view.fx} : {fy: !view.fy};
}
/* Counts per brightness level of RGBA pixels: {r, g, b, l}, 256 levels each; fully transparent pixels don't count. */
function histogramOf(rgba) {
  const h = {r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256)};
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    h.r[r]++; h.g[g]++; h.b[b]++; h.l[Math.round(.2126 * r + .7152 * g + .0722 * b)]++;
  }
  return h;
}
/* An SVG path of one channel; the peak is cut at the 99.5 % level so one burnt-out level doesn't flatten the rest. */
function histogramPath(bins, w, h) {
  const top = Math.max(1, [...bins].sort((a, b) => a - b)[Math.floor(bins.length * .995)]);
  let d = `M0 ${h}`;
  for (let i = 0; i < bins.length; i++) d += `L${(i / (bins.length - 1) * w).toFixed(1)} ${(h - Math.min(1, bins[i] / top) * h).toFixed(1)}`;
  return d + `L${w} ${h}Z`;
}
/* Moves one element inside the array itself (the queue's array is shared with its tab). */
function moveItem(list, from, to) {
  if (from === to || from < 0 || from >= list.length) return list;
  const [x] = list.splice(from, 1);
  list.splice(Math.min(Math.max(0, to), list.length), 0, x);
  return list;
}
function m3uText(entries) {
  return '#EXTM3U\n' + entries.map(e => `#EXTINF:-1,${e.name.replace(/\.[^.]+$/, '').replace(/\r?\n/g, ' ')}\n${e.path}\n`).join('');
}
/* A label for a sound or subtitle stream: "Deutsch (ger) · ac3". */
function trackLabel(tr, n, fallback) {
  const head = [tr.title, tr.lang && tr.title ? `(${tr.lang})` : tr.lang].filter(Boolean).join(' ') || `${fallback} ${n + 1}`;
  return `${head} · ${tr.codec}`;
}
/* The chapter that is running at time s, as its position, or -1. */
function chapterAt(chapters, s) {
  for (let i = chapters.length - 1; i >= 0; i--) if (s >= chapters[i].start) return i;
  return -1;
}
