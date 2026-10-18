//! Media files: which kind a file is (by its extension), the media next to it in its folder (sorted like Explorer:
//! "Bild 2" before "Bild 10"), photo details from EXIF, audio details and cover from the tags, and subtitles
//! (.srt → WebVTT for the player).

use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const IMAGE: &[&str] = &["jpg", "jpeg", "jfif", "png", "gif", "webp", "avif", "bmp", "ico", "svg"];
pub const VIDEO: &[&str] = &["mp4", "m4v", "webm", "mov", "ogv", "mkv"];
pub const AUDIO: &[&str] = &["mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "weba"];
pub const MODEL: &[&str] = &["stl", "obj", "glb", "gltf", "ply", "3mf"];

pub fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// "image", "video", "audio", "model" or "" (not shown).
pub fn kind_of(p: &Path) -> &'static str {
    let e = ext_of(p);
    let e = e.as_str();
    if IMAGE.contains(&e) { "image" } else if VIDEO.contains(&e) { "video" } else if AUDIO.contains(&e) { "audio" } else if MODEL.contains(&e) { "model" } else { "" }
}

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
    /// Last change, ms since 1970.
    pub modified: u64,
}

pub fn entry(p: &Path) -> Option<Entry> {
    let kind = kind_of(p);
    if kind.is_empty() { return None; }
    let meta = std::fs::metadata(p).ok().filter(|m| m.is_file())?;
    let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
    Some(Entry { path: p.to_string_lossy().into_owned(), name: p.file_name()?.to_string_lossy().into_owned(), kind, size: meta.len(), modified })
}

/// Compares names like Explorer: runs of digits by their value, letters without case ("bild 2" < "Bild 10").
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| { let mut s = String::new(); while let Some(&c) = it.peek() { if c.is_ascii_digit() { s.push(c); it.next(); } else { break; } } s };
                let (n, m) = (take(&mut x), take(&mut y));
                let (n0, m0) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let o = n0.len().cmp(&m0.len()).then_with(|| n0.cmp(m0));
                if o != Ordering::Equal { return o; }
            }
            (Some(c), Some(d)) => {
                let o = c.to_lowercase().cmp(d.to_lowercase());
                if o != Ordering::Equal { return o; }
                x.next(); y.next();
            }
        }
    }
}

/// The media files of a folder (not its subfolders), sorted by name.
pub fn folder(dir: &Path) -> Vec<Entry> {
    let mut list: Vec<Entry> = std::fs::read_dir(dir).map(|rd| rd.flatten().filter_map(|e| entry(&e.path())).collect()).unwrap_or_default();
    list.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    list
}

/// Photo details from EXIF (JPEG, TIFF-based RAW, HEIF, PNG, WebP): [label key, value] pairs plus the orientation.
#[derive(Serialize, Default, Debug)]
pub struct Photo {
    pub fields: Vec<(String, String)>,
    /// EXIF orientation 1–8 (most viewers apply it; the WebView does for JPEG by itself).
    pub orientation: u32,
    /// Latitude, longitude in degrees, when the photo has a GPS position.
    pub gps: Option<(f64, f64)>,
}

pub fn photo(path: &Path) -> Photo {
    let mut out = Photo { orientation: 1, ..Default::default() };
    let Ok(file) = std::fs::File::open(path) else { return out };
    let Ok(ex) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)) else { return out };
    let text = |tag: exif::Tag| ex.get_field(tag, exif::In::PRIMARY).map(|f| f.display_value().with_unit(&ex).to_string().trim_matches('"').trim().to_string()).filter(|s| !s.is_empty());
    let pairs = [
        ("exif.taken", exif::Tag::DateTimeOriginal), ("exif.make", exif::Tag::Make), ("exif.model", exif::Tag::Model),
        ("exif.lens", exif::Tag::LensModel), ("exif.exposure", exif::Tag::ExposureTime), ("exif.fnumber", exif::Tag::FNumber),
        ("exif.iso", exif::Tag::PhotographicSensitivity), ("exif.focal", exif::Tag::FocalLength), ("exif.software", exif::Tag::Software),
    ];
    for (key, tag) in pairs { if let Some(v) = text(tag) { out.fields.push((key.into(), v)); } }
    if let Some(o) = ex.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)) { out.orientation = o; }
    let deg = |tag: exif::Tag, refr: exif::Tag| -> Option<f64> {
        let f = ex.get_field(tag, exif::In::PRIMARY)?;
        let exif::Value::Rational(v) = &f.value else { return None };
        if v.len() < 3 { return None; }
        let d = v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0;
        let r = ex.get_field(refr, exif::In::PRIMARY).map(|f| f.display_value().to_string()).unwrap_or_default();
        Some(if r.contains('S') || r.contains('W') { -d } else { d })
    };
    if let (Some(lat), Some(lon)) = (deg(exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef), deg(exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef)) {
        out.gps = Some((lat, lon));
    }
    out
}

/// Audio details from the tags (ID3, Vorbis comments, MP4 atoms …) and the cover as a data: URL.
#[derive(Serialize, Default, Debug)]
pub struct Audio {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<u32>,
    pub track: Option<u32>,
    pub genre: Option<String>,
    pub seconds: Option<f64>,
    pub bitrate: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u8>,
    pub cover: Option<String>,
}

pub fn audio(path: &Path) -> Audio {
    use lofty::prelude::*;
    let mut out = Audio::default();
    let Ok(tf) = lofty::read_from_path(path) else { return out };
    let p = tf.properties();
    out.seconds = Some(p.duration().as_secs_f64()).filter(|s| *s > 0.0);
    out.bitrate = p.audio_bitrate();
    out.sample_rate = p.sample_rate();
    out.channels = p.channels();
    if let Some(tag) = tf.primary_tag().or_else(|| tf.first_tag()) {
        out.title = tag.title().map(|s| s.to_string());
        out.artist = tag.artist().map(|s| s.to_string());
        out.album = tag.album().map(|s| s.to_string());
        out.year = tag.year();
        out.track = tag.track();
        out.genre = tag.genre().map(|s| s.to_string());
        if let Some(pic) = tag.pictures().first() {
            let mime = pic.mime_type().map(|m| m.as_str().to_string()).unwrap_or_else(|| "image/jpeg".into());
            out.cover = Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(pic.data())));
        }
    }
    out
}

/// SubRip (.srt) as WebVTT: a header, "," → "." in the times, cue numbers dropped. WebVTT stays as it is.
pub fn srt_to_vtt(srt: &str) -> String {
    let text = srt.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    if text.trim_start().starts_with("WEBVTT") { return text; }
    let mut out = String::from("WEBVTT\n\n");
    for block in text.split("\n\n") {
        let lines: Vec<&str> = block.lines().filter(|l| !l.trim().is_empty()).collect();
        let Some(i) = lines.iter().position(|l| l.contains("-->")) else { continue };
        out.push_str(&lines[i].replace(',', "."));
        out.push('\n');
        for l in &lines[i + 1..] { out.push_str(l); out.push('\n'); }
        out.push('\n');
    }
    out
}

/// Subtitles next to a video: same name with .vtt or .srt, also "name.de.srt" / "name.en.vtt". Returns (label, WebVTT).
pub fn subtitles(video: &Path) -> Vec<(String, String)> {
    let (Some(dir), Some(stem)) = (video.parent(), video.file_stem().map(|s| s.to_string_lossy().to_lowercase())) else { return vec![] };
    let mut found: Vec<(String, PathBuf)> = std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.path()).filter_map(|p| {
        let e = ext_of(&p);
        if e != "srt" && e != "vtt" { return None; }
        let s = p.file_stem()?.to_string_lossy().to_lowercase();
        if s == stem { return Some((String::new(), p)); }
        s.strip_prefix(&format!("{stem}.")).map(|lang| (lang.to_string(), p.clone()))
    }).collect()).unwrap_or_default();
    found.sort();
    found.into_iter().filter_map(|(label, p)| {
        let bytes = std::fs::read(&p).ok()?;
        let text = String::from_utf8(bytes.clone()).unwrap_or_else(|_| bytes.iter().map(|&b| b as char).collect());
        Some((label, srt_to_vtt(&text)))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_and_natural_order() {
        assert_eq!(kind_of(Path::new("a/Bild.JPG")), "image");
        assert_eq!(kind_of(Path::new("Teil.stl")), "model");
        assert_eq!(kind_of(Path::new("x.txt")), "");
        let mut v = vec!["Bild 10.jpg", "bild 2.jpg", "Bild 1.jpg", "Anhang.png", "Bild 02b.jpg"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["Anhang.png", "Bild 1.jpg", "bild 2.jpg", "Bild 02b.jpg", "Bild 10.jpg"]);
    }

    #[test]
    fn srt_becomes_vtt() {
        let srt = "\u{feff}1\r\n00:00:01,000 --> 00:00:02,500\r\nHallo Welt\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nZeile 1\r\nZeile 2\r\n";
        assert_eq!(srt_to_vtt(srt), "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHallo Welt\n\n00:00:03.000 --> 00:00:04.000\nZeile 1\nZeile 2\n\n");
        assert!(srt_to_vtt("WEBVTT\n\n00:01.000 --> 00:02.000\nx").starts_with("WEBVTT"));
    }

    #[test]
    fn folder_and_subtitles() {
        let dir = std::env::temp_dir().join(format!("viewer-media-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for n in ["Film.mp4", "Film.srt", "Film.en.vtt", "Foto 10.jpg", "Foto 9.jpg", "notes.txt"] { std::fs::write(dir.join(n), b"1\n00:00:01,000 --> 00:00:02,000\nHi\n").unwrap(); }
        let names: Vec<String> = folder(&dir).into_iter().map(|e| e.name).collect();
        assert_eq!(names, vec!["Film.mp4", "Foto 9.jpg", "Foto 10.jpg"]);
        let subs = subtitles(&dir.join("Film.mp4"));
        assert_eq!(subs.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(), vec!["", "en"]);
        assert!(subs[0].1.starts_with("WEBVTT") && subs[0].1.contains("00:00:01.000 --> 00:00:02.000"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
