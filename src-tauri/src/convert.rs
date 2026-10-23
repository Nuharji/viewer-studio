//! Formats the WebView can't show (MKV/AVI/WMV, HEVC on Windows, AC-3 sound, HEIC photos …) go through a small
//! LGPL-only FFmpeg that ships next to the program (`viewer-ffmpeg`, built from the official sources in GitHub Actions).
//! A file is first looked at (`ffmpeg -i`): if the WebView plays it as it is, nothing happens; if only the container is
//! the problem, the streams are copied into one it can play ("remux", takes seconds); otherwise the streams it can't play
//! are converted — with the operating system's H.264 encoder (VideoToolbox on macOS, Media Foundation on Windows) or
//! VP8 / Opus on Linux. Results are kept in the app's cache folder (at most 4 GB, the oldest go first).

use serde::Serialize;
use std::{
    collections::HashMap,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

/// What the WebView of this operating system plays, and what videos / sound it can't play are converted into.
pub struct Target {
    /// File types it opens as they are.
    pub native: &'static [&'static str],
    pub video_ok: &'static [&'static str],
    pub audio_ok: &'static [&'static str],
    /// Container of converted videos (H.264 + AAC in "mp4", VP8 + Opus in "webm") and of converted sound.
    pub convert_video: &'static str,
    pub convert_audio: &'static str,
}

#[cfg(target_os = "macos")]
pub const TARGET: Target = Target {
    native: &["mp4", "m4v", "mov", "m4a", "mp3", "wav", "aac", "flac", "aiff", "aif", "caf"],
    video_ok: &["h264", "hevc"],
    audio_ok: &["aac", "mp3", "alac", "flac", "pcm_s16le", "pcm_s24le"],
    convert_video: "mp4",
    convert_audio: "m4a",
};
#[cfg(target_os = "windows")]
pub const TARGET: Target = Target {
    native: &["mp4", "m4v", "mov", "webm", "ogv", "m4a", "mp3", "wav", "aac", "flac", "ogg", "oga", "opus", "weba"],
    video_ok: &["h264", "vp8", "vp9", "av1"],
    audio_ok: &["aac", "mp3", "flac", "opus", "vorbis", "pcm_s16le"],
    convert_video: "mp4",
    convert_audio: "m4a",
};
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub const TARGET: Target = Target {
    native: &["mp4", "m4v", "mov", "m4a", "aac", "webm", "ogv", "ogg", "oga", "opus", "weba", "mp3", "wav", "flac"],
    video_ok: &["h264", "vp8", "vp9"],
    audio_ok: &["aac", "opus", "vorbis", "mp3", "flac", "pcm_s16le"],
    convert_video: "webm",
    convert_audio: "webm",
};

/// The streams of a file, as `ffmpeg -i` describes them.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Probe {
    pub duration: f64,
    /// Codec, width, height of the first real video stream (cover pictures don't count).
    pub video: Option<(String, u32, u32)>,
    pub audio: Option<String>,
}

/// Reads the input description FFmpeg prints (stderr of `ffmpeg -i file`).
pub fn parse_probe(text: &str) -> Probe {
    let mut p = Probe::default();
    for line in text.lines().map(str::trim) {
        if let Some(rest) = line.strip_prefix("Duration: ") {
            let t = rest.split(',').next().unwrap_or("");
            let parts: Vec<f64> = t.split(':').filter_map(|x| x.trim().parse().ok()).collect();
            if parts.len() == 3 { p.duration = parts[0] * 3600.0 + parts[1] * 60.0 + parts[2]; }
        }
        if !line.starts_with("Stream #") { continue; }
        let codec_after = |tag: &str| line.split(tag).nth(1).map(|r| r.split([' ', ',']).next().unwrap_or("").to_string());
        if let (None, Some(c)) = (&p.video, codec_after(": Video: ")) {
            if line.contains("(attached pic)") || c.is_empty() { continue; }
            let size = line.split([' ', ',']).find_map(|w| {
                let (a, b) = w.split_once('x')?;
                Some((a.parse::<u32>().ok()?, b.parse::<u32>().ok()?))
            }).unwrap_or((0, 0));
            p.video = Some((c, size.0, size.1));
        } else if let (None, Some(c)) = (&p.audio, codec_after(": Audio: ")) {
            if !c.is_empty() { p.audio = Some(c); }
        }
    }
    p
}

/// What has to happen before the WebView can play a file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Plan {
    Native,
    /// Streams copied into `ext`.
    Remux { ext: String },
    /// The video and / or the sound converted, into `ext`.
    Convert { video: bool, audio: bool, ext: String },
    /// Nothing in it that could be played.
    Nothing,
}

pub fn plan(ext: &str, p: &Probe, audio_only: bool, t: &Target) -> Plan {
    let video = if audio_only { None } else { p.video.as_ref().map(|v| v.0.as_str()) };
    let audio = p.audio.as_deref();
    if video.is_none() && audio.is_none() { return Plan::Nothing; }
    let v_ok = video.is_none_or(|c| t.video_ok.contains(&c));
    let a_ok = audio.is_none_or(|c| t.audio_ok.contains(&c));
    if t.native.contains(&ext) && v_ok && a_ok { return Plan::Native; }
    let webm = |c: &str| matches!(c, "vp8" | "vp9" | "av1" | "opus" | "vorbis");
    // The container of the playable copy: what the video becomes, or what fits the streams that are kept.
    let out = match (video, audio) {
        (Some(_), _) if !v_ok => t.convert_video,
        (Some(v), _) => if webm(v) { "webm" } else { "mp4" },
        (None, Some(a)) if a_ok => if webm(a) { "webm" } else { "m4a" },
        _ => t.convert_audio,
    };
    // The sound has to fit that container too (WebM only holds Opus / Vorbis, MP4 no Vorbis).
    let a_fits = audio.is_none_or(|c| if out == "webm" { matches!(c, "opus" | "vorbis") } else { c != "vorbis" });
    let (conv_v, conv_a) = (!v_ok, !a_ok || !a_fits);
    if !conv_v && !conv_a { return Plan::Remux { ext: out.to_string() }; }
    Plan::Convert { video: conv_v, audio: conv_a, ext: out.to_string() }
}

/// Bit rate for a converted video: about 8 Mbit/s for Full HD, more or less by the number of pixels.
fn video_kbps(w: u32, h: u32) -> u32 {
    let px = (w.max(1) as f64) * (h.max(1) as f64);
    ((px / (1920.0 * 1080.0) * 8000.0) as u32).clamp(1500, 25000)
}

/// The FFmpeg arguments for a plan (input, output and the progress report on stdout).
pub fn args(input: &str, output: &str, p: &Probe, plan: &Plan, audio_only: bool) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-i", input].iter().map(|s| s.to_string()).collect();
    let (conv_v, conv_a, ext) = match plan {
        Plan::Remux { ext } => (false, false, ext.as_str()),
        Plan::Convert { video, audio, ext } => (*video, *audio, ext.as_str()),
        _ => (false, false, ""),
    };
    let has_v = !audio_only && p.video.is_some();
    if has_v { a.extend(["-map".into(), "0:v:0".into()]); } else { a.push("-vn".into()); }
    if p.audio.is_some() { a.extend(["-map".into(), "0:a:0".into()]); }
    a.extend(["-sn".into(), "-dn".into()]);
    if has_v {
        if conv_v {
            let (w, h) = p.video.as_ref().map(|v| (v.1, v.2)).unwrap_or((1920, 1080));
            // Even sizes (needed by the encoders), at most 4K wide.
            a.extend(["-vf".into(), "scale=trunc(min(iw\\,3840)/2)*2:-2".into()]);
            let kbps = format!("{}k", video_kbps(w.min(3840), h));
            if ext == "webm" {
                a.extend(["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p"].map(String::from));
            } else if cfg!(target_os = "windows") {
                a.extend(["-c:v", "h264_mf", "-pix_fmt", "nv12"].map(String::from));
            } else {
                a.extend(["-c:v", "h264_videotoolbox", "-allow_sw", "1", "-pix_fmt", "yuv420p"].map(String::from));
            }
            a.extend(["-b:v".into(), kbps]);
        } else {
            a.extend(["-c:v".into(), "copy".into()]);
            // Apple players need HEVC in MP4 marked as "hvc1".
            if ext != "webm" && p.video.as_ref().is_some_and(|v| v.0 == "hevc") { a.extend(["-tag:v".into(), "hvc1".into()]); }
        }
    }
    if p.audio.is_some() {
        if conv_a {
            if ext == "webm" { a.extend(["-c:a", "libopus", "-b:a", "160k", "-ac", "2"].map(String::from)); }
            else { a.extend(["-c:a", "aac", "-b:a", "192k", "-ac", "2"].map(String::from)); }
        } else {
            a.extend(["-c:a".into(), "copy".into()]);
        }
    }
    if ext != "webm" { a.extend(["-movflags".into(), "+faststart".into()]); }
    a.extend(["-f", if ext == "webm" { "webm" } else { "mp4" }].map(String::from));   // .m4a is MP4 too
    a.extend(["-progress", "pipe:1", "-nostats"].map(String::from));
    a.push(output.to_string());
    a
}

/// The bundled FFmpeg: next to the program (`viewer-ffmpeg`), or for development the copy in `src-tauri/binaries`
/// or the one `STUDIO_FFMPEG` points to.
pub fn ffmpeg_path() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "viewer-ffmpeg.exe" } else { "viewer-ffmpeg" };
    if let Ok(p) = std::env::var("STUDIO_FFMPEG") { let p = PathBuf::from(p); if p.is_file() { return Some(p); } }
    if let Some(p) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(exe))).filter(|p| p.is_file()) { return Some(p); }
    #[cfg(debug_assertions)]
    {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        if let Some(p) = std::fs::read_dir(&dir).ok()?.flatten().map(|e| e.path())
            .find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("viewer-ffmpeg"))) { return Some(p); }
    }
    None
}

fn command(ffmpeg: &Path) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut c = Command::new(ffmpeg);
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; c.creation_flags(0x0800_0000); }   // CREATE_NO_WINDOW
    c
}

pub fn probe(ffmpeg: &Path, path: &Path) -> Result<Probe, String> {
    let out = command(ffmpeg).arg("-hide_banner").arg("-nostdin").arg("-i").arg(path).output().map_err(|e| e.to_string())?;
    // "At least one output file must be specified" is the normal end of `ffmpeg -i`; what matters is the description.
    let text = String::from_utf8_lossy(&out.stderr);
    if !text.contains("Input #") { return Err(text.lines().last().unwrap_or("").to_string()); }
    Ok(parse_probe(&text))
}

/// Running conversions by the UI's id, so they can be stopped.
#[derive(Default)]
pub struct Jobs(Mutex<HashMap<u64, Child>>);

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("converted");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let _ = app.asset_protocol_scope().allow_directory(&d, false);
    Ok(d)
}

/// The cache file of a source: named after its path, size and last change (a changed file is converted again).
fn cache_name(path: &Path, ext: &str, kind: &str) -> String {
    let meta = std::fs::metadata(path).ok();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (path.to_string_lossy(), meta.as_ref().map(|m| m.len()), meta.and_then(|m| m.modified().ok()), kind, 1u8).hash(&mut h);
    format!("{:016x}.{ext}", h.finish())
}

/// Keeps the cache at most `limit` bytes: the files used longest ago are removed first.
fn trim_cache(dir: &Path, limit: u64) {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter_map(|e| { let m = e.metadata().ok()?; Some((m.modified().ok()?, m.len(), e.path())) }).collect();
    files.sort();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    for (_, len, p) in files {
        if total <= limit { break; }
        if std::fs::remove_file(&p).is_ok() { total -= len; }
    }
}

#[derive(Serialize)]
pub struct Check {
    /// "native", "remux", "convert", "nothing" or "unavailable" (no FFmpeg with the app).
    pub plan: String,
    /// The converted file when it is in the cache already.
    pub ready: Option<String>,
}

fn plan_for(path: &Path, kind: &str) -> Result<(PathBuf, Probe, Plan), String> {
    let ffmpeg = ffmpeg_path().ok_or("unavailable")?;
    let p = probe(&ffmpeg, path)?;
    let ext = crate::media::ext_of(path);
    Ok((ffmpeg, p.clone(), plan(&ext, &p, kind == "audio", &TARGET)))
}

/// Whether a video or audio file needs preparing, and whether it is prepared already.
#[tauri::command]
pub async fn media_check(app: AppHandle, path: String, kind: String) -> Check {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(&path);
        let (plan_s, ready) = match plan_for(&path, &kind) {
            Err(e) if e == "unavailable" => ("unavailable".to_string(), None),
            Err(_) => ("native".to_string(), None),   // FFmpeg can't read it either: let the WebView try
            Ok((_, _, pl)) => {
                let name = match &pl { Plan::Remux { ext } | Plan::Convert { ext, .. } => Some(cache_name(&path, ext, &kind)), _ => None };
                let ready = name.and_then(|n| cache_dir(&app).ok().map(|d| d.join(n))).filter(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned());
                (match pl { Plan::Native => "native", Plan::Remux { .. } => "remux", Plan::Convert { .. } => "convert", Plan::Nothing => "nothing" }.to_string(), ready)
            }
        };
        Check { plan: plan_s, ready }
    }).await.unwrap_or(Check { plan: "native".into(), ready: None })
}

#[derive(Serialize, Clone)]
struct Progress { id: u64, done: f64 }

/// Prepares a file for the WebView (see the module notes) and returns the path of the playable copy. Progress goes to
/// the UI as "media-progress" events ({id, done: 0…1}).
#[tauri::command]
pub async fn media_prepare(app: AppHandle, path: String, kind: String, id: u64) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(&path);
        let dir = cache_dir(&app)?;
        if kind == "image" { return prepare_image(&app, &src, &dir, id); }
        let (ffmpeg, p, pl) = plan_for(&src, &kind)?;
        let ext = match &pl { Plan::Remux { ext } | Plan::Convert { ext, .. } => ext.clone(), _ => return Ok(path) };
        let out = dir.join(cache_name(&src, &ext, &kind));
        if out.is_file() { touch(&out); return Ok(out.to_string_lossy().into_owned()); }
        let part = out.with_extension(format!("part.{ext}"));
        let a = args(&src.to_string_lossy(), &part.to_string_lossy(), &p, &pl, kind == "audio");
        run(&app, &ffmpeg, &a, p.duration, id)?;
        std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
        trim_cache(&dir, 4 << 30);
        Ok(out.to_string_lossy().into_owned())
    }).await.map_err(|e| e.to_string())?
}

/// Photos the WebView can't show (HEIC/HEIF, TIFF …) become a JPEG.
fn prepare_image(app: &AppHandle, src: &Path, dir: &Path, id: u64) -> Result<String, String> {
    let ffmpeg = ffmpeg_path().ok_or("unavailable")?;
    let out = dir.join(cache_name(src, "jpg", "image"));
    if out.is_file() { touch(&out); return Ok(out.to_string_lossy().into_owned()); }
    let part = out.with_extension("part.jpg");
    let a: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into(), "-i".into(), src.to_string_lossy().into_owned(),
        "-frames:v".into(), "1".into(), "-q:v".into(), "2".into(), "-update".into(), "1".into(), "-f".into(), "image2".into(),
        "-progress".into(), "pipe:1".into(), "-nostats".into(), part.to_string_lossy().into_owned()];
    run(app, &ffmpeg, &a, 0.0, id)?;
    std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().into_owned())
}

fn touch(p: &Path) {
    let _ = std::fs::File::options().append(true).open(p).and_then(|f| f.set_modified(std::time::SystemTime::now()));
}

fn run(app: &AppHandle, ffmpeg: &Path, a: &[String], duration: f64, id: u64) -> Result<(), String> {
    let mut child = command(ffmpeg).args(a).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("no output")?;
    let stderr = child.stderr.take().ok_or("no output")?;
    // Errors come on stderr; keep its last lines (read on its own thread so FFmpeg never blocks on a full pipe).
    let err_thread = std::thread::spawn(move || {
        let mut last: Vec<String> = Vec::new();
        for l in BufReader::new(stderr).lines().map_while(Result::ok) { last.push(l); if last.len() > 6 { last.remove(0); } }
        last.join("\n")
    });
    let jobs = app.state::<Jobs>();
    jobs.0.lock().unwrap().insert(id, child);
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
            if duration > 0.0 { let _ = app.emit("media-progress", Progress { id, done: (us / 1e6 / duration).clamp(0.0, 1.0) }); }
        }
    }
    let child = jobs.0.lock().unwrap().remove(&id);
    let status = match child { Some(mut c) => c.wait().map_err(|e| e.to_string())?, None => return Err("cancelled".into()) };
    let err = err_thread.join().unwrap_or_default();
    if !status.success() { return Err(err.lines().last().unwrap_or("FFmpeg failed").to_string()); }
    Ok(())
}

/// Stops a running conversion (the UI moved on to another file).
#[tauri::command]
pub fn media_cancel(jobs: State<Jobs>, id: u64) {
    if let Some(mut c) = jobs.0.lock().unwrap().remove(&id) { let _ = c.kill(); let _ = c.wait(); }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MKV: &str = "Input #0, matroska,webm, from 'Film.mkv':
  Metadata:
    title           : Test
  Duration: 01:02:03.50, start: 0.000000, bitrate: 4321 kb/s
  Stream #0:0(eng): Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 25 fps, 25 tbr, 1k tbn (default)
  Stream #0:1(ger): Audio: ac3, 48000 Hz, 5.1(side), fltp, 384 kb/s (default)
  Stream #0:2(ger): Subtitle: subrip
At least one output file must be specified";

    const MP3: &str = "Input #0, mp3, from 'Lied.mp3':
  Duration: 00:03:10.00, start: 0.025057, bitrate: 320 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600, 90k tbr, 90k tbn (attached pic)";

    #[test]
    fn reads_the_streams() {
        let p = parse_probe(MKV);
        assert_eq!(p.duration, 3723.5);
        assert_eq!(p.video, Some(("h264".into(), 1920, 1080)));
        assert_eq!(p.audio.as_deref(), Some("ac3"));
        let a = parse_probe(MP3);
        assert_eq!((a.video, a.audio.as_deref()), (None, Some("mp3")), "cover pictures are not a video");
    }

    #[test]
    fn plans_per_platform() {
        let mac = Target { native: &["mp4", "mov", "mp3"], video_ok: &["h264", "hevc"], audio_ok: &["aac", "mp3"], convert_video: "mp4", convert_audio: "m4a" };
        let linux = Target { native: &["mp4", "webm", "mp3"], video_ok: &["h264", "vp8", "vp9"], audio_ok: &["aac", "opus", "vorbis", "mp3"], convert_video: "webm", convert_audio: "webm" };
        let p = |v: Option<&str>, a: Option<&str>| Probe { duration: 10.0, video: v.map(|c| (c.to_string(), 1280, 720)), audio: a.map(String::from) };
        let conv = |video, audio, ext: &str| Plan::Convert { video, audio, ext: ext.into() };
        assert_eq!(plan("mp4", &p(Some("h264"), Some("aac")), false, &mac), Plan::Native);
        assert_eq!(plan("mkv", &p(Some("h264"), Some("aac")), false, &mac), Plan::Remux { ext: "mp4".into() });
        assert_eq!(plan("mkv", &p(Some("h264"), Some("ac3")), false, &mac), conv(false, true, "mp4"));
        assert_eq!(plan("avi", &p(Some("msmpeg4v3"), Some("mp3")), false, &mac), conv(true, false, "mp4"));
        assert_eq!(plan("mov", &p(Some("hevc"), None), false, &mac), Plan::Native);
        assert_eq!(plan("webm", &p(Some("vp9"), Some("opus")), false, &mac), conv(true, true, "mp4"), "Opus doesn't go into MP4 for Apple");
        assert_eq!(plan("wma", &p(None, Some("wmav2")), true, &mac), conv(false, true, "m4a"));
        assert_eq!(plan("mp3", &p(Some("mjpeg"), Some("mp3")), true, &mac), Plan::Native, "audio files ignore their cover");
        assert_eq!(plan("srt", &p(None, None), false, &mac), Plan::Nothing);
        // Linux: normal MP4 stays as it is; H.264 in MKV is only remuxed; what it can't play becomes VP8 + Opus.
        assert_eq!(plan("mp4", &p(Some("h264"), Some("aac")), false, &linux), Plan::Native);
        assert_eq!(plan("mkv", &p(Some("h264"), Some("aac")), false, &linux), Plan::Remux { ext: "mp4".into() });
        assert_eq!(plan("mkv", &p(Some("vp9"), Some("opus")), false, &linux), Plan::Remux { ext: "webm".into() });
        assert_eq!(plan("mp4", &p(Some("hevc"), Some("aac")), false, &linux), conv(true, true, "webm"), "AAC doesn't go into WebM");
        assert_eq!(plan("mkv", &p(Some("h264"), Some("ac3")), false, &linux), conv(false, true, "mp4"));
        assert_eq!(plan("wma", &p(None, Some("wmav2")), true, &linux), conv(false, true, "webm"));
    }

    #[test]
    fn ffmpeg_arguments() {
        let p = parse_probe(MKV);
        let pl = Plan::Convert { video: false, audio: true, ext: "mp4".into() };
        let a = args("in.mkv", "out.mp4", &p, &pl, false).join(" ");
        assert!(a.starts_with("-hide_banner -nostdin -y -i in.mkv -map 0:v:0 -map 0:a:0 -sn -dn -c:v copy -c:a aac -b:a 192k -ac 2 -movflags +faststart -f mp4"), "{a}");
        assert!(a.ends_with("-progress pipe:1 -nostats out.mp4"));
        let hevc = Probe { duration: 1.0, video: Some(("hevc".into(), 3840, 2160)), audio: None };
        let r = args("a.mkv", "b.mp4", &hevc, &Plan::Remux { ext: "mp4".into() }, false).join(" ");
        assert!(r.contains("-c:v copy -tag:v hvc1") && !r.contains("-c:a"), "{r}");
        let w = args("a.avi", "b.webm", &hevc, &Plan::Convert { video: true, audio: false, ext: "webm".into() }, false).join(" ");
        assert!(w.contains("-c:v libvpx -deadline realtime") && w.contains("-b:v 25000k") && w.contains("-f webm") && !w.contains("faststart"), "{w}");
        let m = args("x.wma", "y.m4a", &Probe { duration: 1.0, video: None, audio: Some("wmav2".into()) }, &Plan::Convert { video: false, audio: true, ext: "m4a".into() }, true).join(" ");
        assert!(m.contains("-vn -map 0:a:0") && m.contains("-c:a aac"), "{m}");
        assert_eq!(video_kbps(640, 360), 1500);
        assert_eq!(video_kbps(1920, 1080), 8000);
    }

    #[test]
    fn cache_keeps_its_limit() {
        let dir = std::env::temp_dir().join(format!("viewer-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (i, n) in ["old", "mid", "new"].iter().enumerate() {
            let p = dir.join(n);
            std::fs::write(&p, vec![0u8; 100]).unwrap();
            let t = std::time::SystemTime::now() - std::time::Duration::from_secs(1000 - i as u64 * 100);
            std::fs::File::options().append(true).open(&p).unwrap().set_modified(t).unwrap();
        }
        trim_cache(&dir, 250);
        assert!(!dir.join("old").exists() && dir.join("mid").exists() && dir.join("new").exists());
        assert_ne!(cache_name(&dir.join("mid"), "mp4", "video"), cache_name(&dir.join("new"), "mp4", "video"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
