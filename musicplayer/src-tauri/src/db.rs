use std::path::PathBuf;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub file_path: String,
    pub file_name: String,
    pub file_type: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<i64>,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub duration_seconds: Option<f64>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
    pub cover_art_path: Option<String>,
    pub metadata_source: String,
    pub date_added: String,
    pub last_played: Option<String>,
    pub play_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongMetadataInput {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<i64>,
    pub track_number: Option<i64>,
    pub disc_number: Option<i64>,
    pub cover_art_path: Option<String>,
}

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open(path: PathBuf) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|err| err.to_string())?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys = ON;

                CREATE TABLE IF NOT EXISTS songs (
                  id TEXT PRIMARY KEY,
                  file_path TEXT NOT NULL UNIQUE,
                  file_name TEXT NOT NULL,
                  file_type TEXT NOT NULL,
                  title TEXT,
                  artist TEXT,
                  album TEXT,
                  album_artist TEXT,
                  genre TEXT,
                  year INTEGER,
                  track_number INTEGER,
                  disc_number INTEGER,
                  duration_seconds REAL,
                  bitrate INTEGER,
                  sample_rate INTEGER,
                  cover_art_path TEXT,
                  embedded_cover_extracted_path TEXT,
                  metadata_source TEXT NOT NULL,
                  date_added TEXT NOT NULL,
                  last_played TEXT,
                  play_count INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS playlists (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS playlist_songs (
                  playlist_id TEXT NOT NULL,
                  song_id TEXT NOT NULL,
                  position INTEGER NOT NULL,
                  PRIMARY KEY (playlist_id, song_id),
                  FOREIGN KEY (playlist_id) REFERENCES playlists(id),
                  FOREIGN KEY (song_id) REFERENCES songs(id)
                );

                CREATE TABLE IF NOT EXISTS app_settings (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS visualizer_presets (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  style_type TEXT NOT NULL,
                  config_json TEXT NOT NULL,
                  is_builtin INTEGER DEFAULT 0,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                ",
            )
            .map_err(|err| err.to_string())
    }

    pub fn upsert_songs(&self, songs: &[Song]) -> Result<(), String> {
        let now = Utc::now().to_rfc3339();
        self.conn
            .execute("BEGIN", [])
            .map_err(|err| err.to_string())?;
        let result = (|| -> Result<(), String> {
            for song in songs {
                self.conn
                    .execute(
                        "
                    INSERT INTO songs (
                      id, file_path, file_name, file_type, title, artist, album, album_artist,
                      genre, year, track_number, disc_number, duration_seconds, bitrate,
                      sample_rate, cover_art_path, metadata_source, date_added, created_at, updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
                    ON CONFLICT(file_path) DO UPDATE SET
                      file_name = excluded.file_name,
                      file_type = excluded.file_type,
                      title = COALESCE(songs.title, excluded.title),
                      artist = COALESCE(songs.artist, excluded.artist),
                      album = COALESCE(songs.album, excluded.album),
                      album_artist = COALESCE(songs.album_artist, excluded.album_artist),
                      genre = COALESCE(songs.genre, excluded.genre),
                      year = COALESCE(songs.year, excluded.year),
                      track_number = COALESCE(songs.track_number, excluded.track_number),
                      disc_number = COALESCE(songs.disc_number, excluded.disc_number),
                      duration_seconds = excluded.duration_seconds,
                      bitrate = excluded.bitrate,
                      sample_rate = excluded.sample_rate,
                      cover_art_path = COALESCE(songs.cover_art_path, excluded.cover_art_path),
                      updated_at = excluded.updated_at
                    ",
                        params![
                            song.id,
                            song.file_path,
                            song.file_name,
                            song.file_type,
                            song.title,
                            song.artist,
                            song.album,
                            song.album_artist,
                            song.genre,
                            song.year,
                            song.track_number,
                            song.disc_number,
                            song.duration_seconds,
                            song.bitrate,
                            song.sample_rate,
                            song.cover_art_path,
                            song.metadata_source,
                            song.date_added,
                            now,
                            now,
                        ],
                    )
                    .map_err(|err| err.to_string())?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            let _ = self.conn.execute("ROLLBACK", []);
            return Err(e);
        }
        self.conn
            .execute("COMMIT", [])
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    pub fn get_songs(&self) -> Result<Vec<Song>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "
                SELECT id, file_path, file_name, file_type, title, artist, album, album_artist,
                       genre, year, track_number, disc_number, duration_seconds, bitrate,
                       sample_rate, cover_art_path, metadata_source, date_added, last_played, play_count
                FROM songs
                ORDER BY artist COLLATE NOCASE, album COLLATE NOCASE, track_number, title COLLATE NOCASE, file_name COLLATE NOCASE
                ",
            )
            .map_err(|err| err.to_string())?;

        let rows = stmt
            .query_map([], song_from_row)
            .map_err(|err| err.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|err| err.to_string())
    }

    pub fn get_song(&self, id: &str) -> Result<Option<Song>, String> {
        self.conn
            .query_row(
                "
                SELECT id, file_path, file_name, file_type, title, artist, album, album_artist,
                       genre, year, track_number, disc_number, duration_seconds, bitrate,
                       sample_rate, cover_art_path, metadata_source, date_added, last_played, play_count
                FROM songs
                WHERE id = ?1
                ",
                params![id],
                song_from_row,
            )
            .optional()
            .map_err(|err| err.to_string())
    }

    pub fn update_song_metadata(
        &self,
        song_id: &str,
        metadata: SongMetadataInput,
    ) -> Result<Song, String> {
        let now = Utc::now().to_rfc3339();
        self.conn
            .execute(
                "
                UPDATE songs SET
                  title = ?1,
                  artist = ?2,
                  album = ?3,
                  album_artist = ?4,
                  genre = ?5,
                  year = ?6,
                  track_number = ?7,
                  disc_number = ?8,
                  cover_art_path = ?9,
                  metadata_source = 'manual',
                  updated_at = ?10
                WHERE id = ?11
                ",
                params![
                    metadata.title,
                    metadata.artist,
                    metadata.album,
                    metadata.album_artist,
                    metadata.genre,
                    metadata.year,
                    metadata.track_number,
                    metadata.disc_number,
                    metadata.cover_art_path,
                    now,
                    song_id,
                ],
            )
            .map_err(|err| err.to_string())?;

        self.get_song(song_id)?
            .ok_or_else(|| "Song not found after metadata update".to_string())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "
                INSERT INTO app_settings (key, value)
                VALUES (?1, ?2)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                ",
                params![key, value],
            )
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| err.to_string())
    }
}

fn song_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Song> {
    Ok(Song {
        id: row.get(0)?,
        file_path: row.get(1)?,
        file_name: row.get(2)?,
        file_type: row.get(3)?,
        title: row.get(4)?,
        artist: row.get(5)?,
        album: row.get(6)?,
        album_artist: row.get(7)?,
        genre: row.get(8)?,
        year: row.get(9)?,
        track_number: row.get(10)?,
        disc_number: row.get(11)?,
        duration_seconds: row.get(12)?,
        bitrate: row.get(13)?,
        sample_rate: row.get(14)?,
        cover_art_path: row.get(15)?,
        metadata_source: row.get(16)?,
        date_added: row.get(17)?,
        last_played: row.get(18)?,
        play_count: row.get(19)?,
    })
}
