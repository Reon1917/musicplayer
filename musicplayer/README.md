# Lapis Player

A lightweight Tauri v2 music player with a deep blue steel retro interface, local SQLite library, Rust playback, editable metadata, optimized album art, and real PCM/FFT-driven visualizers.

## Current Scope

- macOS-first Tauri desktop app.
- React + TypeScript frontend.
- Rust backend for folder scanning, SQLite persistence, audio decoding/playback, and visualizer events.
- Manual folder import and one-click rescans for `.mp3` and `.wav`.
- Metadata is read from files and stored in SQLite. Manual metadata edits and album art are stored as local overrides, not written back to source audio files.
- Uploaded album art is normalized to a 1024 x 1024 JPEG in app storage for consistent display and optimization.
- Visualizer modes: spectrum bars and oscilloscope waveform.
- Settings modal for visualizer mode and app theme.

## Development

Install dependencies:

```bash
pnpm install
```

Run the app:

```bash
pnpm run desktop
```

Build the frontend:

```bash
pnpm run build
```

Build the Rust backend:

```bash
cd src-tauri
cargo build
```

## Architecture

- `src/App.tsx` contains the compact player shell and visualizer canvas.
- `src/store.ts` contains app state.
- `src-tauri/src/db.rs` owns SQLite schema and queries.
- `src-tauri/src/scanner.rs` scans supported local audio files and reads metadata.
- `src-tauri/src/audio.rs` decodes audio to PCM, plays through `cpal`, and emits `visualizer-frame` events.

## Release Notes

This is not release-ready yet. The next engineering priorities are seek UI wiring, playlist queue behavior, extracted embedded cover art, better metadata override UX, and audio-memory limits for very large files.
