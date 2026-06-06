mod models;
mod youtube;

use models::{Transcript, VideoInfo};

#[tauri::command]
async fn fetch_video(url: String, api_key: Option<String>) -> Result<VideoInfo, String> {
    youtube::fetch_video(&url, api_key.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_transcript(
    video_id: String,
    lang_code: String,
    is_generated: bool,
) -> Result<Transcript, String> {
    youtube::fetch_transcript(&video_id, &lang_code, is_generated)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_file(url: String, dest_path: String) -> Result<(), String> {
    youtube::download_file(&url, &dest_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_text(path: String, contents: String) -> Result<(), String> {
    youtube::save_text(&path, &contents).map_err(|e| e.to_string())
}

/// Открыть внешнюю ссылку в браузере по умолчанию.
/// Через Rust-сторону, чтобы не зависеть от scope JS-плагина opener.
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            fetch_video,
            fetch_transcript,
            download_file,
            save_text,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения viTool");
}
