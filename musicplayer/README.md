# Lapis Player

A lightweight Tauri v2 music player with a modern Studio interface and optional retro themes, local SQLite library, Rust playback, editable metadata, optimized album art, and real PCM/FFT-driven visualizers.

## Current Scope

- macOS-first Tauri desktop app.
- React + TypeScript frontend.
- Rust backend for folder scanning, SQLite persistence, audio decoding/playback, and visualizer events.
- Manual folder import and one-click rescans for `.mp3` and `.wav`.
- Metadata is read from files and stored in SQLite. Manual metadata edits and album art are stored as local overrides, not written back to source audio files.
- Uploaded album art is normalized to a 1024 x 1024 JPEG in app storage for consistent display and optimization.
- Visualizer modes: Aurora, Silk, Halo, Winamp Bars, Old Windows, Oscilloscope, Phosphor Trails, Alchemy Flow, Ambience, and Battery Spiral.
- Settings modal for visualizer mode and app theme.

## Studio theme

Studio is the default appearance: charcoal surfaces, mint accents, a library sidebar, large artwork, and a persistent playback dock. Choose **Settings → Theme → Studio · Modern** to switch back from a retro theme. Theme and visualizer choices are remembered on this device.

The Studio visualizer controls offer **Aurora** (layered light ribbons), **Silk** (fine waveform threads), and **Halo** (a reactive spectrum orbit). They share the existing PCM frame stream. A time-based response layer smooths bass, mids, treble, loudness, bass pulses, and stereo balance before drawing: bass gives weight, mids unfold the contours, treble adds highlights, and sustained energy slowly changes drift and color. The broad shape envelopes take roughly 1–3 seconds to rise and 4–5 seconds to settle. A separate 0.24-second attack / 0.9-second release follows rhythm, while relative mid/treble balance distinguishes songs at similar loudness; individual waveform samples and FFT bins never deform the contours. These are visual interpretations of musical texture, not emotion classification. Aurora makes broad waves, Silk curls sideways into interweaving loops, and Halo changes its petal shape and orbit. Rendering shares a gradient across strands, limits contour detail to the display size, and blurs only selected strokes. Studio skips unused waveform/FFT array interpolation and does not mount the hidden retro meters. Scenes remain static without new signal and sleep while hidden. Reduced motion freezes the continuous drift and slows the remaining envelope changes. All existing playback, import, search, metadata editing, and retro modes remain available.

## Visualizers and efficiency

Choose **Settings → Visualizer → Phosphor Trails** for a scrolling retro wireframe spectrum. Alchemy Flow adds liquid mirrored color fields, Ambience expands glowing waveform echoes, and Battery Spiral stretches radial bursts into spiraling trails. These original effects were reworked after studying [Windows Media Player XP footage](https://www.youtube.com/watch?v=ntyKbTLrfxE), rather than reproducing Microsoft’s visualizer code. Two reusable GPU textures preserve and warp afterimages at the existing canvas resolution. When WebGL is unavailable, simpler canvas effects remain available as a fallback. All modes use the existing PCM analysis and selected color theme. The lower Bass/Pulse/Vocal/Treble meter row has been removed to give the visualizer more space.

The canvas retains its 60 FPS target and existing resolution cap. Bar glows are cached at device-pixel resolution, and the animation loop sleeps after the signal settles. Hidden windows suspend FFT analysis and visualizer events while audio playback continues. The analyzer reuses its Hann window, FFT scratch space, and sample buffer; audio output batches playback-position updates once per callback.

Run audio regression checks with `cargo test --manifest-path src-tauri/Cargo.toml --lib`. These compare analysis output against the original implementation and verify PCM output, cursor position, pause, and completion. Battery savings need to be measured on the target Mac during real playback; renderer timings alone are not a battery-life estimate.

Run Studio motion regression checks with `pnpm test:visualizers` (transient rejection, release, frame-rate independence, pause/seek continuity, tonal contrast, reduced motion, and drawing safety).

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
- `src/StudioShell.tsx` and `src/Studio.css` define the modern layout; `tokens.css` contains its design tokens.
- `src/modernVisualizers.ts` draws the Studio canvas effects.
- `src/store.ts` contains app state and saved appearance preferences.
- `src-tauri/src/db.rs` owns SQLite schema and queries.
- `src-tauri/src/scanner.rs` scans supported local audio files and reads metadata.
- `src-tauri/src/audio.rs` decodes audio to PCM, plays through `cpal`, and emits `visualizer-frame` events.

## Release Notes

This is not release-ready yet. The next engineering priorities are seek UI wiring, playlist queue behavior, extracted embedded cover art, better metadata override UX, and audio-memory limits for very large files.
