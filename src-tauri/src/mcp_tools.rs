//! What Viewer Studio offers over MCP (mcp.rs): looking at folders and media files. It only reads, like the app reads
//! originals; sorting out (marks, trash) stays with the window.

use crate::{mcp, media};
use serde_json::{json, Value};

pub fn run() { mcp::serve("viewer-studio", env!("CARGO_PKG_VERSION"), &tools(), &call) }

fn tools() -> Vec<Value> {
    let path = json!({"type": "string", "description": "Full path of the file"});
    vec![
        mcp::tool("list_folder", "The media files of a folder that Viewer Studio can show, with kind and size.", json!({"folder": {"type": "string", "description": "Full path of the folder"}}), &["folder"]),
        mcp::tool("photo_info", "Properties of a photo: size, camera and shot details (EXIF).", json!({"path": path}), &["path"]),
        mcp::tool("audio_info", "Tags of an audio file: title, artist, album, duration …", json!({"path": path}), &["path"]),
        mcp::tool("subtitles", "The subtitle files next to a video: [name, text as WebVTT].", json!({"path": path}), &["path"]),
    ]
}

/// The file has to exist: the reading functions return an empty result for a missing file.
fn file(args: &Value) -> Result<std::path::PathBuf, String> {
    let p = mcp::path(args, "path")?;
    if p.is_file() { Ok(p) } else { Err(format!("{}: not found", p.display())) }
}

fn call(name: &str, args: &Value) -> Result<Value, String> {
    let to_json = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
    match name {
        "list_folder" => {
            let d = mcp::path(args, "folder")?;
            if !d.is_dir() { return Err(format!("{}: not a folder", d.display())); }
            to_json(serde_json::to_value(media::folder(&d)))
        }
        "photo_info" => to_json(serde_json::to_value(media::photo(&file(args)?))),
        "audio_info" => to_json(serde_json::to_value(media::audio(&file(args)?))),
        "subtitles" => to_json(serde_json::to_value(media::subtitles(&file(args)?))),
        _ => Err(format!("unknown tool: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn folders_and_files() {
        let d = std::env::temp_dir().join(format!("viewer-mcp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("film.mp4"), b"x").unwrap();
        fs::write(d.join("film.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHallo\n").unwrap();
        fs::write(d.join("notizen.xyz"), b"x").unwrap();
        let list = call("list_folder", &json!({"folder": d})).unwrap();
        assert!(list.as_array().unwrap().iter().any(|e| e["kind"] == "video"));
        assert!(!list.to_string().contains("notizen.xyz"), "only what the app can show");
        let subs = call("subtitles", &json!({"path": d.join("film.mp4")})).unwrap();
        assert!(subs[0][1].as_str().unwrap().contains("Hallo"));
        assert!(call("photo_info", &json!({"path": d.join("none.jpg")})).is_err());
        assert!(call("list_folder", &json!({"folder": "relativ"})).is_err());
        let _ = fs::remove_dir_all(d);
    }
}
