# Winamp-Inspired Lightweight Music Player — Project Context

## 1. Project Overview

Build a lightweight desktop music player inspired by old Winamp aesthetics, focused on accurate and beautiful real-time audio visualization.

The app should allow users to input a local music folder containing `.mp3` and `.wav` files, manage song metadata and cover art, play songs efficiently, and display multiple visualizer styles ranging from retro Windows/Winamp-style visuals to modern animated spectrum visualizers.

The main focus of the project is the **sound visualizer**. Playback is important, but the visual experience should be treated as the core product identity.

---

## 2. Core Concept

A retro-modern desktop music player with:

* Local-first music playback
* Folder-based MP3/WAV import
* Manual and automatic song metadata support
* Per-song cover art support
* SQLite local database
* Multiple visualizer styles
* Accurate real-time frequency visualization
* Old Windows / Winamp-inspired interface
* Lightweight native desktop feel

---

## 3. Target Platform

Primary target:

* macOS desktop app

Preferred implementation:

* Tauri desktop app
* Rust backend
* Web-based frontend UI

Possible future support:

* Windows
* Linux

---

## 4. Tech Stack

### Desktop Framework

Use:

```txt
Tauri v2
```

Reason:

* Lightweight compared to Electron
* Native desktop packaging
* Rust backend access
* Good file system support
* Works well with React-based frontend
* Suitable for local-first desktop apps

---

### Frontend

Use:

```txt
React
TypeScript
Tailwind CSS
Canvas API
WebGL / shaders later
```

Frontend responsibilities:

* Music player UI
* Song library display
* Playlist display
* Metadata editor UI
* Cover art display
* Visualizer rendering
* Theme/skin system
* User settings panel

---

### Backend

Use:

```txt
Rust
Tauri Commands
SQLite
Audio decoding/playback libraries
FFT/audio analysis libraries
```

Backend responsibilities:

* Scan music folders
* Read `.mp3` and `.wav` files
* Extract metadata
* Store metadata in SQLite
* Handle playback
* Decode audio samples
* Generate waveform and FFT data
* Send visualizer data to frontend
* Manage cover art files
* Save user settings

---

### Local Database

Use:

```txt
SQLite
```

Suggested Rust options:

```txt
sqlx
rusqlite
```

SQLite stores:

* Songs
* Artists
* Albums
* Playlists
* Cover art paths
* Metadata overrides
* Visualizer preferences
* Last played song
* Playback history
* App settings

---

## 5. Supported Audio Formats

MVP formats:

```txt
.mp3
.wav
```

Future formats:

```txt
.flac
.ogg
.m4a
.aac
```

---

## 6. Main Features

### 6.1 Music Folder Import

User can select a local folder.

The app scans for:

```txt
.mp3
.wav
```

For each file, the app should:

* Detect file path
* Read file name
* Read metadata if available
* Extract duration
* Extract artist/title/album if available
* Extract embedded cover art if available
* Save song record into SQLite

Folder import should support:

* Initial import
* Re-scan folder
* Detect new songs
* Detect deleted/moved songs
* Avoid duplicate records

---

### 6.2 Song Metadata

Metadata can come from:

1. Embedded file tags
2. File name fallback
3. Manual user input

Supported metadata fields:

```txt
Title
Artist
Album
Album Artist
Genre
Year
Track Number
Disc Number
Duration
File Path
File Type
Bitrate
Sample Rate
Date Added
Last Played
Play Count
```

Manual metadata editing should be supported.

Example:

User can right-click a song and edit:

```txt
Title: Starlight Drive
Artist: Unknown Artist
Album: Local Mix
Genre: Synthwave
Year: 2026
```

---

### 6.3 Cover Art

Each song should support cover art.

Cover art sources:

1. Embedded MP3 cover art
2. Image file in same folder
3. Manual user-uploaded image
4. Default placeholder image

Supported image formats:

```txt
.jpg
.jpeg
.png
.webp
```

Cover art behavior:

* Use embedded cover art if available
* Allow manual override
* Store custom cover art reference in SQLite
* Keep original file untouched unless user explicitly chooses to write metadata back later
* Use cover art in player UI
* Optionally use cover art colors for visualizer theme later

---

## 7. Music Player Features

MVP controls:

```txt
Play
Pause
Stop
Next
Previous
Seek
Volume
Mute
Shuffle
Repeat one
Repeat all
```

Player display:

```txt
Song title
Artist
Album
Cover art
Current time
Total duration
Progress bar
Audio format
Visualizer mode
```

Playback should be smooth and lightweight.

---

## 8. Visualizer as Main Focus

The visualizer is the core feature of the app.

The goal is not just a fake animated visualizer. The app should use real audio data to generate accurate visual responses.

Visualizer data should be based on:

```txt
PCM audio samples
FFT frequency analysis
Amplitude
Bass / mid / treble energy
Peak detection
Beat-like energy spikes
Stereo channel difference
```

---

## 9. Visualizer Accuracy Goals

The visualizer should react correctly to:

* Bass kicks
* Snare hits
* Vocals
* High hats
* Quiet parts
* Loud chorus sections
* Stereo movement
* Dynamic changes
* Drops/build-ups

Visualizer should not feel random.

It should be audio-driven.

Accuracy requirements:

```txt
Bass range should affect low-frequency bars
Mid range should affect central bands
Treble range should affect high-frequency bands
Overall amplitude should affect visual intensity
Peaks should decay smoothly
Visualizer should remain synced with playback
```

---

## 10. Audio Analysis Pipeline

Suggested pipeline:

```txt
Audio File
→ Decode to PCM samples
→ Playback engine
→ Real-time sample tap / analysis buffer
→ Windowing function
→ FFT
→ Frequency bin calculation
→ Smoothing
→ Peak hold
→ Normalization
→ Send data to frontend
→ Render visualizer
```

---

## 11. FFT Details

Use FFT to convert audio samples from time domain to frequency domain.

Suggested settings:

```txt
FFT size: 1024 or 2048 for MVP
Sample rate: use source file sample rate
Update rate: 30–60 FPS
Window function: Hann window
Frequency bins: 64 / 128 / 256 depending on visualizer mode
```

Recommended data output:

```ts
type VisualizerFrame = {
  timestamp: number;
  volume: number;
  bass: number;
  mids: number;
  treble: number;
  leftLevel: number;
  rightLevel: number;
  frequencyBins: number[];
  waveform: number[];
  peaks: number[];
};
```

---

## 12. Visualizer Styles

### 12.1 Classic Winamp Bar Spectrum

Retro spectrum analyzer inspired by old Winamp.

Features:

* Small pixel-like bars
* Fast response
* Peak caps
* Green/orange/red energy levels
* Low-resolution retro feeling
* Optional scanline effect

---

### 12.2 Oscilloscope Waveform

Classic waveform display.

Features:

* Horizontal waveform
* Left/right stereo overlay
* Smooth motion
* CRT-style glow option
* Good for vocals and instruments

---

### 12.3 MilkDrop-Inspired Abstract Visualizer

Modernized old-school Winamp plugin vibe.

Features:

* Reactive shapes
* Color gradients
* Pulsing tunnel effects
* Beat-reactive distortion
* Shader-based rendering
* Trippy full-screen mode later

---

### 12.4 Modern Circular Spectrum

Modern music player style.

Features:

* Circular frequency bars around cover art
* Bass pulses the circle
* Treble creates sharp outer movements
* Cover art in center
* Clean modern UI

---

### 12.5 Minimal Wave Bars

Simple modern visualizer.

Features:

* Smooth rounded bars
* Good for normal listening
* Uses bass/mid/treble separation
* Clean low-distraction mode

---

### 12.6 Pixel Retro Visualizer

Old Windows / DOS-like aesthetic.

Features:

* Chunky pixels
* Limited palette
* Low FPS option
* CRT grid
* Dithered color effect
* Looks intentionally old-school

---

## 13. Visualizer Rendering

Frontend rendering options:

### MVP

Use:

```txt
HTML Canvas 2D
```

Good for:

* Bar spectrum
* Waveform
* Circular spectrum
* Pixel visualizer

### Later

Use:

```txt
WebGL
WGSL/WGPU if needed later
Shader-based rendering
```

Good for:

* MilkDrop-style visuals
* Fullscreen effects
* Particle systems
* Distortion
* Fluid-like visuals

---

## 14. Visualizer Data Flow

Rust backend should generate audio analysis data and send it to frontend.

Example flow:

```txt
Rust audio engine
→ Analyze current audio frame
→ Create VisualizerFrame
→ Emit Tauri event
→ React frontend receives event
→ Store latest frame in state/ref
→ Canvas render loop draws frame
```

Example frontend event:

```ts
listen<VisualizerFrame>("visualizer-frame", (event) => {
  latestFrame.current = event.payload;
});
```

---

## 15. Suggested Rust Libraries

Audio decoding/playback:

```txt
symphonia
rodio
cpal
```

FFT/audio analysis:

```txt
rustfft
realfft
```

Metadata:

```txt
lofty
id3
```

Database:

```txt
sqlx
rusqlite
```

File watching:

```txt
notify
```

Image handling:

```txt
image
```

---

## 16. Suggested Frontend Libraries

Core:

```txt
React
TypeScript
Tailwind CSS
```

State:

```txt
Zustand
```

Canvas utilities:

```txt
Native Canvas API first
```

Optional later:

```txt
Three.js
PixiJS
WebGL shaders
```

UI:

```txt
Custom components
ShadCN optional but avoid overly modern SaaS look
```

The UI should not look like a generic dashboard. It should feel like a retro desktop music tool.

---

## 17. Database Schema Draft

```sql
CREATE TABLE songs (
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
  metadata_source TEXT,
  date_added TEXT NOT NULL,
  last_played TEXT,
  play_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE playlist_songs (
  playlist_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, song_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id),
  FOREIGN KEY (song_id) REFERENCES songs(id)
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE visualizer_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  style_type TEXT NOT NULL,
  config_json TEXT NOT NULL,
  is_builtin INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 18. App UI Layout

Suggested layout:

```txt
+--------------------------------------------------+
| Tiny title bar / skin controls                   |
+--------------------------------------------------+
| Cover Art      | Song Info                       |
|                | Progress Bar                    |
|                | Controls                        |
+--------------------------------------------------+
| Main Visualizer                                  |
|                                                  |
|                                                  |
+--------------------------------------------------+
| Playlist / Library                               |
+--------------------------------------------------+
```

Alternative Winamp-inspired compact layout:

```txt
+--------------------------------------+
| Song Title                 00:42/3:51|
| [==== progress bar ==============]   |
| [prev] [play] [pause] [next] [vol]   |
+--------------------------------------+
| VISUALIZER PANEL                     |
|                                      |
+--------------------------------------+
| PLAYLIST                             |
| 01. Song A                           |
| 02. Song B                           |
+--------------------------------------+
```

---

## 19. Visual Design Direction

Aesthetic keywords:

```txt
Winamp
Old Windows
Retro desktop
Tiny controls
Pixel edges
Compact layout
Dark panels
Neon spectrum
CRT glow
Skinnable UI
Techy but cozy
```

Avoid:

```txt
Generic Spotify clone
Overly clean SaaS dashboard
Huge empty spacing
Modern boring music app UI
```

---

## 20. MVP Scope

MVP should include:

```txt
Tauri app setup
Folder picker
MP3/WAV scanning
SQLite song storage
Song list UI
Basic playback
Basic metadata display
Manual metadata edit
Cover art display
Manual cover art upload
One accurate FFT bar spectrum visualizer
One waveform visualizer
Basic Winamp-style skin
```

---

## 21. Phase 2 Scope

Add:

```txt
Playlist management
Search/filter
Shuffle/repeat
Visualizer preset switcher
Circular spectrum visualizer
Pixel retro visualizer
Cover art color extraction
File watching for folder changes
Fullscreen visualizer mode
```

---

## 22. Phase 3 Scope

Add:

```txt
MilkDrop-inspired WebGL visualizer
Shader presets
Visualizer preset editor
Per-song visualizer preference
Beat/energy detection
Album grouping
FLAC/OGG/M4A support
Cross-platform Windows build
Optional terminal/TUI companion player
```

---

## 23. Suggested Folder Structure

```txt
music-player/
├─ src/
│  ├─ components/
│  │  ├─ player/
│  │  ├─ library/
│  │  ├─ metadata/
│  │  └─ visualizers/
│  ├─ hooks/
│  ├─ stores/
│  ├─ types/
│  ├─ lib/
│  └─ App.tsx
│
├─ src-tauri/
│  ├─ src/
│  │  ├─ audio/
│  │  │  ├─ playback.rs
│  │  │  ├─ analysis.rs
│  │  │  └─ fft.rs
│  │  ├─ db/
│  │  ├─ metadata/
│  │  ├─ files/
│  │  ├─ commands/
│  │  └─ main.rs
│  ├─ Cargo.toml
│  └─ tauri.conf.json
│
├─ public/
├─ package.json
└─ README.md
```

---

## 24. Key Tauri Commands

Suggested commands:

```rust
scan_music_folder(path: String)
get_songs()
play_song(song_id: String)
pause_song()
resume_song()
stop_song()
seek_song(position_seconds: f64)
set_volume(volume: f32)
update_song_metadata(song_id: String, metadata: SongMetadataInput)
set_song_cover_art(song_id: String, image_path: String)
get_visualizer_presets()
set_visualizer_preset(preset_id: String)
```

---

## 25. Frontend Type Draft

```ts
export type Song = {
  id: string;
  filePath: string;
  fileName: string;
  fileType: "mp3" | "wav";
  title?: string;
  artist?: string;
  album?: string;
  albumArtist?: string;
  genre?: string;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
  durationSeconds?: number;
  bitrate?: number;
  sampleRate?: number;
  coverArtPath?: string;
  lastPlayed?: string;
  playCount: number;
};

export type VisualizerFrame = {
  timestamp: number;
  volume: number;
  bass: number;
  mids: number;
  treble: number;
  leftLevel: number;
  rightLevel: number;
  frequencyBins: number[];
  waveform: number[];
  peaks: number[];
};

export type VisualizerPreset = {
  id: string;
  name: string;
  styleType:
    | "classic_winamp_bars"
    | "oscilloscope"
    | "milkdrop_inspired"
    | "circular_spectrum"
    | "minimal_wave_bars"
    | "pixel_retro";
  config: Record<string, unknown>;
};
```

---

## 26. Development Priorities

Build in this order:

```txt
1. Tauri + React base app
2. SQLite setup
3. Folder picker
4. MP3/WAV scanner
5. Song database insert
6. Song list UI
7. Basic playback
8. Metadata extraction
9. Cover art extraction/manual cover upload
10. Basic canvas visualizer with fake data
11. Real audio sample analysis
12. FFT spectrum visualizer
13. Waveform visualizer
14. Winamp-style UI polish
15. Visualizer preset system
```

---

## 27. Important Engineering Notes

The visualizer should not depend on random animation.

Use real decoded audio data whenever possible.

For MVP, it is acceptable to start with fake visualizer data only to build the UI, but this should be replaced early.

The final app should have:

```txt
Accurate frequency response
Smooth peak decay
Low latency visual sync
Good performance on macOS
Minimal CPU usage during playback
```

The app should avoid heavy memory usage and should not behave like an Electron app.

---

## 28. Product Identity

This app should feel like:

```txt
A tiny powerful retro desktop music tool
```

Not:

```txt
A Spotify clone
A generic SaaS dashboard
A bloated music library manager
```

Core identity:

```txt
Local music
Retro player
Accurate visualizer
Skinnable interface
Lightweight desktop performance
```

---

## 29. One-Line Summary

A lightweight Tauri + Rust desktop MP3/WAV music player with SQLite storage, editable song metadata, per-song cover art, and highly accurate Winamp-inspired real-time audio visualizers as the main feature.
