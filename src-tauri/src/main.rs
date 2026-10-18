// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod media;
mod shared;

use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Emitter, Manager, State, WebviewWindow,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

/// Paths requested before the UI was ready (command-line args, macOS "Open with").
struct Pending {
    ready: bool,
    paths: Vec<PathBuf>,
}

/// A file (or folder) opened in the UI: the file to show first and the media of its folder (for ←/→ and the panel).
#[derive(Serialize, Clone)]
struct Opened {
    current: Option<media::Entry>,
    folder: String,
    siblings: Vec<media::Entry>,
}

/// Lets the WebView load the media of one folder (not its subfolders) through the asset protocol — only what was opened.
fn allow(app: &AppHandle, dir: &Path) {
    let _ = app.asset_protocol_scope().allow_directory(dir, false);
}

fn open_one(app: &AppHandle, path: &Path) -> Option<Opened> {
    // The file's path is rebuilt from its folder like the folder list does, so both spell it the same way
    // ("C:/a/b.jpg" and "C:\a\b.jpg" are the same file, but not the same text).
    let (dir, current) = if path.is_dir() { (path.to_path_buf(), None) } else {
        let dir = path.parent()?.to_path_buf();
        let file = dir.join(path.file_name()?);
        (dir, Some(media::entry(&file)?))
    };
    allow(app, &dir);
    let siblings = media::folder(&dir);
    let current = current.or_else(|| siblings.first().cloned());
    current.as_ref()?;
    Some(Opened { current, folder: dir.to_string_lossy().into_owned(), siblings })
}

/// The app's texts in English and German (i18n/*.json, built into the program).
#[tauri::command]
fn texts() -> serde_json::Value {
    let parse = |s: &str| serde_json::from_str::<serde_json::Value>(s).unwrap_or_default();
    serde_json::json!({"en": parse(include_str!("../i18n/en.json")), "de": parse(include_str!("../i18n/de.json"))})
}

/// Opens files or a folder by path (start screen, recent list, drag & drop, "Open with").
#[tauri::command]
fn open_paths(app: AppHandle, paths: Vec<String>) -> Vec<Opened> {
    paths.iter().filter_map(|p| open_one(&app, Path::new(p))).collect()
}

/// The open dialog for media files (several at once).
#[tauri::command]
async fn pick_files(app: AppHandle, label: String) -> Vec<Opened> {
    let all: Vec<&str> = [media::IMAGE, media::VIDEO, media::AUDIO, media::MODEL].concat();
    let Some(files) = shared::file_dialog(&app).add_filter(&label, &all).blocking_pick_files() else { return vec![] };
    files.into_iter().filter_map(|f| f.into_path().ok()).filter_map(|p| open_one(&app, &p)).collect()
}

/// The folder dialog: all media of the chosen folder.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<Opened> {
    let dir = shared::file_dialog(&app).blocking_pick_folder()?.into_path().ok()?;
    open_one(&app, &dir)
}

/// The media of a folder again (after files were added or removed).
#[tauri::command]
fn folder_list(app: AppHandle, folder: String) -> Vec<media::Entry> {
    let dir = Path::new(&folder);
    allow(&app, dir);
    media::folder(dir)
}

#[tauri::command]
fn photo_info(path: String) -> media::Photo {
    media::photo(Path::new(&path))
}

#[tauri::command]
fn audio_info(path: String) -> media::Audio {
    media::audio(Path::new(&path))
}

#[tauri::command]
fn subtitles(path: String) -> Vec<(String, String)> {
    media::subtitles(Path::new(&path))
}

fn header(req: &Request, name: &str) -> String {
    req.headers().get(name).and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) { out.push(v); i += 3; continue; }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Saves bytes after a save dialog (still frame / 3D view as PNG). Body: the bytes; headers x-name, x-filter, x-ext.
#[tauri::command]
async fn save_bytes(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected a binary body".into()) };
    let (name, filter, ext) = (header(&request, "x-name"), header(&request, "x-filter"), header(&request, "x-ext"));
    let Some(f) = shared::file_dialog(&app).set_file_name(&name).add_filter(&filter, &[ext.as_str()]).blocking_save_file() else { return Ok(None) };
    let target = f.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&target, bytes).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// Saves text after a save dialog (notes as Markdown).
#[tauri::command]
async fn save_text(app: AppHandle, name: String, filter: String, ext: String, content: String) -> Result<Option<String>, String> {
    let Some(f) = shared::file_dialog(&app).set_file_name(&name).add_filter(&filter, &[ext.as_str()]).blocking_save_file() else { return Ok(None) };
    let target = f.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&target, content).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

/// Shows the file in Explorer / Finder.
#[tauri::command]
fn reveal(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn confirm(app: AppHandle, title: String, message: String, ok_label: String, cancel_label: String) -> bool {
    app.dialog().message(message).title(title).kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label, cancel_label)).blocking_show()
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !["https://", "http://", "mailto:"].iter().any(|p| url.starts_with(p)) { return Err(format!("Refusing to open {url}")); }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn initial_files(app: AppHandle, state: State<Mutex<Pending>>) -> Vec<Opened> {
    let mut pending = state.lock().unwrap();
    pending.ready = true;
    let paths: Vec<PathBuf> = pending.paths.drain(..).collect();
    paths.iter().filter_map(|p| open_one(&app, p)).collect()
}

#[tauri::command]
fn set_fullscreen(window: WebviewWindow, on: bool) -> Result<(), String> {
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

/// One entry of a native context menu; an entry without `id` is a separator.
#[derive(Deserialize)]
struct MenuEntry {
    id: Option<String>,
    label: Option<String>,
    enabled: Option<bool>,
    checked: Option<bool>,
    accel: Option<String>,
}

/// Shows a native (OS) context menu at the mouse position; the chosen id reaches the UI as a "context-menu" event.
#[tauri::command]
fn context_menu(app: AppHandle, window: tauri::Window, items: Vec<MenuEntry>) -> Result<(), String> {
    use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
    let mut menu = MenuBuilder::new(&app);
    for entry in items {
        let Some(id) = entry.id else { menu = menu.separator(); continue };
        let label = entry.label.unwrap_or_default();
        let enabled = entry.enabled.unwrap_or(true);
        if let Some(checked) = entry.checked {
            let item = CheckMenuItemBuilder::with_id(id, label).enabled(enabled).checked(checked).build(&app).map_err(|e| e.to_string())?;
            menu = menu.item(&item);
            continue;
        }
        let plain = || MenuItemBuilder::with_id(id.clone(), label.clone()).enabled(enabled);
        let item = match entry.accel.as_deref() {
            Some(a) => plain().accelerator(a).build(&app).or_else(|_| plain().build(&app)),
            None => plain().build(&app),
        }
        .map_err(|e| e.to_string())?;
        menu = menu.item(&item);
    }
    let menu = menu.build().map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

#[tauri::command]
fn clipboard_read(app: AppHandle) -> String {
    app.clipboard().read_text().unwrap_or_default()
}

#[tauri::command]
fn clipboard_write(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

fn main() {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).filter(|p| p.exists()).collect();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_menu_event(|app, event| {
            let _ = app.emit("context-menu", event.id().as_ref());
        })
        .manage(Mutex::new(Pending { ready: false, paths: args }))
        .invoke_handler(tauri::generate_handler![
            shared::shared_get,
            shared::shared_set,
            texts,
            open_paths,
            pick_files,
            pick_folder,
            folder_list,
            photo_info,
            audio_info,
            subtitles,
            save_bytes,
            save_text,
            reveal,
            confirm,
            open_url,
            initial_files,
            set_fullscreen,
            context_menu,
            clipboard_read,
            clipboard_write
        ])
        .build(tauri::generate_context!())
        .expect("error while building Viewer Studio");

    app.run(|_app, _event| {
        // macOS delivers "Open with" / double-clicked files as an event instead of argv.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let paths: Vec<PathBuf> = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
            let state = _app.state::<Mutex<Pending>>();
            let mut pending = state.lock().unwrap();
            if pending.ready {
                let opened: Vec<Opened> = paths.iter().filter_map(|p| open_one(_app, p)).collect();
                let _ = _app.emit("open-files", opened);
            } else {
                pending.paths.extend(paths);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn texts_parse_and_match() {
        let t = texts();
        let (en, de) = (t["en"].as_object().unwrap(), t["de"].as_object().unwrap());
        assert!(en.len() > 60);
        assert!(en.keys().all(|k| de.contains_key(k)), "every English text has a German one");
        assert!(de.keys().all(|k| en.contains_key(k)), "every German text has an English one");
    }

    #[test]
    fn opened_file_matches_its_folder_list() {
        let dir = std::env::temp_dir().join(format!("viewer-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for n in ["a.jpg", "b.mp4", "c.stl"] { std::fs::write(dir.join(n), b"x").unwrap(); }
        // The same file written with forward slashes (as a path from elsewhere may be).
        let slashed = format!("{}/b.mp4", dir.to_string_lossy().replace('\\', "/"));
        let p = std::path::Path::new(&slashed);
        let parent = p.parent().unwrap().to_path_buf();
        let current = media::entry(&parent.join(p.file_name().unwrap())).unwrap();
        let list = media::folder(&parent);
        assert_eq!(list.iter().position(|e| e.path == current.path), Some(1));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("Standbild%20Gr%C3%BC%C3%9Fe.png"), "Standbild Grüße.png");
    }
}
