//! Sorting files out: into the system's trash and back, copying and moving to a folder, and the playlist files of the
//! queue. Only files of folders the user opened can be touched (the asset protocol's scope), and nothing is overwritten.

use crate::media;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The path as a media file the user has opened.
fn opened(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if media::entry(&p).is_none() || !app.asset_protocol_scope().is_allowed(&p) { return Err(format!("Not an opened file: {path}")); }
    Ok(p)
}

/// A free name in `dir`: "Foto.jpg", then "Foto (2).jpg" and so on.
pub fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() { return first; }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2u32..).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|c| !c.exists()).unwrap_or(first)
}

/// Moves a file, also to another drive (a copy, and the original goes only when the copy is complete).
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    if std::fs::rename(from, to).is_ok() { return Ok(()); }
    std::fs::copy(from, to).map_err(|e| format!("{}: {e}", to.display()))?;
    std::fs::remove_file(from).map_err(|e| format!("{}: {e}", from.display()))
}

#[cfg(target_os = "macos")]
fn to_trash(p: &Path) -> Result<Option<String>, String> {
    use objc2::rc::Retained;
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&p.to_string_lossy()));
    let mut landed: Option<Retained<NSURL>> = None;
    NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, Some(&mut landed)).map_err(|e| e.localizedDescription().to_string())?;
    Ok(landed.and_then(|u| u.path()).map(|s| s.to_string()))
}

#[cfg(target_os = "macos")]
fn from_trash(original: &Path, landed: Option<String>) -> Result<(), String> {
    let landed = landed.ok_or("The trash didn't say where the file went.")?;
    move_file(Path::new(&landed), original)
}

#[cfg(not(target_os = "macos"))]
fn to_trash(p: &Path) -> Result<Option<String>, String> {
    trash::delete(p).map_err(|e| e.to_string())?;
    Ok(None)
}

#[cfg(not(target_os = "macos"))]
fn from_trash(original: &Path, _landed: Option<String>) -> Result<(), String> {
    let (parent, name) = (original.parent().ok_or("no folder")?, original.file_name().ok_or("no name")?);
    let item = trash::os_limited::list().map_err(|e| e.to_string())?.into_iter()
        .filter(|i| i.name == name && i.original_parent == parent)
        .max_by_key(|i| i.time_deleted)
        .ok_or("The file is no longer in the trash.")?;
    trash::os_limited::restore_all([item]).map_err(|e| e.to_string())
}

/// Puts a file into the system's trash. The answer is what `untrash_file` needs to bring it back.
#[tauri::command]
pub async fn trash_file(app: AppHandle, path: String) -> Result<Option<String>, String> {
    let p = opened(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || to_trash(&p)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn untrash_file(path: String, landed: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let original = PathBuf::from(&path);
        if original.exists() { return Err(format!("{path} exists again.")); }
        from_trash(&original, landed)
    }).await.map_err(|e| e.to_string())?
}

/// Copies or moves a file into a folder chosen in a dialog. Returns the new path, or nothing when cancelled.
#[tauri::command]
pub async fn transfer_file(app: AppHandle, path: String, mv: bool) -> Result<Option<String>, String> {
    let p = opened(&app, &path)?;
    let Some(dir) = crate::shared::file_dialog(&app).blocking_pick_folder() else { return Ok(None) };
    let dir = dir.into_path().map_err(|e| e.to_string())?;
    crate::allow(&app, &dir);
    tauri::async_runtime::spawn_blocking(move || {
        let name = p.file_name().ok_or("no name")?.to_string_lossy().into_owned();
        let target = free_name(&dir, &name);
        if mv { move_file(&p, &target)?; } else { std::fs::copy(&p, &target).map_err(|e| format!("{}: {e}", target.display()))?; }
        Ok(Some(target.to_string_lossy().into_owned()))
    }).await.map_err(|e| e.to_string())?
}

/// Undoes a move.
#[tauri::command]
pub async fn move_back(app: AppHandle, path: String, to: String) -> Result<(), String> {
    let p = opened(&app, &path)?;
    let target = PathBuf::from(&to);
    if target.exists() { return Err(format!("{to} exists again.")); }
    tauri::async_runtime::spawn_blocking(move || move_file(&p, &target)).await.map_err(|e| e.to_string())?
}

/// The video and audio files among these paths, which the WebView may then load.
#[tauri::command]
pub fn queue_entries(app: AppHandle, paths: Vec<String>) -> Vec<media::Entry> {
    entries(&app, paths.iter().map(PathBuf::from))
}

fn entries(app: &AppHandle, paths: impl Iterator<Item = PathBuf>) -> Vec<media::Entry> {
    paths.filter_map(|p| {
        let e = media::entry(&p).filter(|e| e.kind == "video" || e.kind == "audio")?;
        crate::allow(app, p.parent()?);
        Some(e)
    }).collect()
}

fn load_playlist(app: &AppHandle, path: &Path) -> Result<Vec<media::Entry>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let text = String::from_utf8(bytes.clone()).unwrap_or_else(|_| bytes.iter().map(|&b| b as char).collect());
    Ok(entries(app, media::parse_m3u(&text, path.parent().unwrap_or(Path::new(""))).into_iter()))
}

#[tauri::command]
pub async fn pick_playlist(app: AppHandle, label: String) -> Result<Vec<media::Entry>, String> {
    let Some(f) = crate::shared::file_dialog(&app).add_filter(&label, &["m3u", "m3u8"]).blocking_pick_file() else { return Ok(vec![]) };
    load_playlist(&app, &f.into_path().map_err(|e| e.to_string())?)
}

/// A playlist dropped onto the window.
#[tauri::command]
pub fn read_playlist(app: AppHandle, path: String) -> Result<Vec<media::Entry>, String> {
    load_playlist(&app, Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_overwritten() {
        let dir = std::env::temp_dir().join(format!("viewer-org-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_name(&dir, "Foto.jpg"), dir.join("Foto.jpg"));
        std::fs::write(dir.join("Foto.jpg"), b"1").unwrap();
        assert_eq!(free_name(&dir, "Foto.jpg"), dir.join("Foto (2).jpg"));
        std::fs::write(dir.join("Foto (2).jpg"), b"2").unwrap();
        assert_eq!(free_name(&dir, "Foto.jpg"), dir.join("Foto (3).jpg"));
        move_file(&dir.join("Foto.jpg"), &dir.join("Neu.jpg")).unwrap();
        assert!(!dir.join("Foto.jpg").exists() && dir.join("Neu.jpg").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_trash_gives_back() {
        let dir = std::env::temp_dir().join(format!("viewer-trash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("weg.jpg");
        std::fs::write(&f, b"x").unwrap();
        let landed = to_trash(&f).unwrap();
        assert!(!f.exists());
        from_trash(&f, landed).unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"x");
        std::fs::remove_dir_all(&dir).ok();
    }
}
