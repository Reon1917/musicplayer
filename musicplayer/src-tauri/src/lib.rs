mod audio;
mod db;
mod scanner;

use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use audio::{Player, PlayerStatus, VisualizerFrame};
use db::{Database, Song, SongMetadataInput};
use image::{imageops::FilterType, ImageFormat};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

struct AppState {
    db: Arc<Mutex<Database>>,
    player: Arc<Player>,
}

#[tauri::command]
async fn scan_music_folder(path: String, state: State<'_, AppState>) -> Result<Vec<Song>, String> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        let songs = scanner::scan_music_folder(&path)?;
        let db = db.lock().map_err(|err| err.to_string())?;
        db.upsert_songs(&songs)?;
        db.set_setting("last_music_folder", &path)?;
        db.get_songs()
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn get_songs(state: State<'_, AppState>) -> Result<Vec<Song>, String> {
    state.db.lock().map_err(|err| err.to_string())?.get_songs()
}

#[tauri::command]
async fn rescan_music_folder(state: State<'_, AppState>) -> Result<Vec<Song>, String> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        let path = {
            let db = db.lock().map_err(|err| err.to_string())?;
            db.get_setting("last_music_folder")?
                .ok_or_else(|| "Choose a music folder before rescanning.".to_string())?
        };

        let songs = scanner::scan_music_folder(&path)?;
        let db = db.lock().map_err(|err| err.to_string())?;
        db.upsert_songs(&songs)?;
        db.get_songs()
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
fn import_album_art(source_path: String, app: AppHandle) -> Result<String, String> {
    let source = PathBuf::from(source_path);
    if !source.exists() {
        return Err("Selected album art file does not exist.".to_string());
    }

    let art_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data directory: {err}"))?
        .join("album-art");
    std::fs::create_dir_all(&art_dir)
        .map_err(|err| format!("Failed to create album art directory: {err}"))?;

    let file_name = format!("{}.jpg", Uuid::new_v4());
    let output_path = art_dir.join(file_name);
    normalize_album_art(&source, &output_path)?;
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
fn update_song_metadata(
    song_id: String,
    metadata: SongMetadataInput,
    state: State<'_, AppState>,
) -> Result<Song, String> {
    state
        .db
        .lock()
        .map_err(|err| err.to_string())?
        .update_song_metadata(&song_id, metadata)
}

#[tauri::command]
fn play_song(
    song_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PlayerStatus, String> {
    let song = state
        .db
        .lock()
        .map_err(|err| err.to_string())?
        .get_song(&song_id)?
        .ok_or_else(|| "Song not found".to_string())?;

    state.player.play_song(song, app)
}

#[tauri::command]
fn preload_song(song_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let song = state
        .db
        .lock()
        .map_err(|err| err.to_string())?
        .get_song(&song_id)?
        .ok_or_else(|| "Song not found".to_string())?;

    state.player.preload_song(song)
}

#[tauri::command]
fn pause_song(state: State<'_, AppState>) -> Result<PlayerStatus, String> {
    state.player.pause()
}

#[tauri::command]
fn resume_song(state: State<'_, AppState>) -> Result<PlayerStatus, String> {
    state.player.resume()
}

#[tauri::command]
fn stop_song(state: State<'_, AppState>) -> Result<PlayerStatus, String> {
    state.player.stop()
}

#[tauri::command]
fn seek_song(position_seconds: f64, state: State<'_, AppState>) -> Result<PlayerStatus, String> {
    state.player.seek(position_seconds)
}

#[tauri::command]
fn set_volume(volume: f32, state: State<'_, AppState>) -> Result<PlayerStatus, String> {
    state.player.set_volume(volume)
}

#[tauri::command]
fn get_player_status(state: State<'_, AppState>) -> Result<PlayerStatus, String> {
    Ok(state.player.status())
}

#[tauri::command]
fn get_last_visualizer_frame(
    state: State<'_, AppState>,
) -> Result<Option<VisualizerFrame>, String> {
    Ok(state.player.last_visualizer_frame())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|err| format!("Failed to resolve app data directory: {err}"))?;
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|err| format!("Failed to create app data directory: {err}"))?;
            let db = Database::open(app_data_dir.join("musicplayer.sqlite"))?;
            app.manage(AppState {
                db: Arc::new(Mutex::new(db)),
                player: Arc::new(Player::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_music_folder,
            get_songs,
            rescan_music_folder,
            import_album_art,
            update_song_metadata,
            play_song,
            preload_song,
            pause_song,
            resume_song,
            stop_song,
            seek_song,
            set_volume,
            get_player_status,
            get_last_visualizer_frame
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn normalize_album_art(source: &Path, output_path: &Path) -> Result<(), String> {
    let image = image::open(source)
        .map_err(|err| format!("Failed to read album art image: {err}"))?
        .resize_to_fill(1024, 1024, FilterType::Lanczos3);
    image
        .save_with_format(output_path, ImageFormat::Jpeg)
        .map_err(|err| format!("Failed to save optimized album art: {err}"))
}
