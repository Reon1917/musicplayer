use std::path::{Path, PathBuf};

use chrono::Utc;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::prelude::Accessor;
use lofty::read_from_path;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::db::Song;

pub fn scan_music_folder(path: &str) -> Result<Vec<Song>, String> {
    let root = PathBuf::from(path);
    if !root.exists() {
        return Err("Selected folder does not exist".to_string());
    }
    if !root.is_dir() {
        return Err("Selected path is not a folder".to_string());
    }

    let songs = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && is_supported_audio_file(entry.path()))
        .filter_map(|entry| {
            let path = entry.into_path();
            match song_from_path(&path) {
                Ok(song) => Some(song),
                Err(err) => {
                    eprintln!("Skipping {}: {err}", path.display());
                    None
                }
            }
        })
        .collect();

    Ok(songs)
}

fn is_supported_audio_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "mp3" | "wav"))
        .unwrap_or(false)
}

fn song_from_path(path: &Path) -> Result<Song, String> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Unknown file")
        .to_string();
    let file_type = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("unknown")
        .to_ascii_lowercase();
    let now = Utc::now().to_rfc3339();
    let mut song = Song {
        id: Uuid::new_v4().to_string(),
        file_path: path.to_string_lossy().to_string(),
        file_name: file_name.clone(),
        file_type,
        title: file_stem_title(path),
        artist: None,
        album: None,
        album_artist: None,
        genre: None,
        year: None,
        track_number: None,
        disc_number: None,
        duration_seconds: None,
        bitrate: None,
        sample_rate: None,
        cover_art_path: find_neighbor_cover_art(path),
        metadata_source: "filename".to_string(),
        date_added: now,
        last_played: None,
        play_count: 0,
    };

    if let Ok(tagged_file) = read_from_path(path) {
        let properties = tagged_file.properties();
        song.duration_seconds = Some(properties.duration().as_secs_f64());
        song.bitrate = properties.audio_bitrate().map(i64::from);
        song.sample_rate = properties.sample_rate().map(i64::from);

        if let Some(tag) = tagged_file
            .primary_tag()
            .or_else(|| tagged_file.first_tag())
        {
            song.title = tag.title().map(|value| value.to_string()).or(song.title);
            song.artist = tag.artist().map(|value| value.to_string());
            song.album = tag.album().map(|value| value.to_string());
            song.genre = tag.genre().map(|value| value.to_string());
            song.track_number = tag.track().map(i64::from);
            song.disc_number = tag.disk().map(i64::from);
            if song.title.is_some() || song.artist.is_some() || song.album.is_some() {
                song.metadata_source = "embedded".to_string();
            }
        }
    }

    Ok(song)
}

fn file_stem_title(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.replace(['_', '-'], " "))
}

fn find_neighbor_cover_art(path: &Path) -> Option<String> {
    let parent = path.parent()?;
    ["cover", "folder", "front", "album"]
        .iter()
        .flat_map(|stem| ["jpg", "jpeg", "png", "webp"].map(move |ext| format!("{stem}.{ext}")))
        .map(|name| parent.join(name))
        .find(|candidate| candidate.exists())
        .map(|candidate| candidate.to_string_lossy().to_string())
}
