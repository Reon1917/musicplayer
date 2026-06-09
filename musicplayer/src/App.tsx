import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  ImagePlus,
  Pause,
  PencilLine,
  Play,
  RefreshCw,
  Repeat,
  Repeat1,
  Save,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
  Waves,
  X,
} from "lucide-react";
import clsx from "clsx";
import "./App.css";
import { useAppStore } from "./store";
import type {
  AppTheme,
  PlayerStatus,
  Song,
  SongMetadataInput,
  VisualizerFrame,
  VisualizerMode,
} from "./types";

const themes: Array<{ id: AppTheme; label: string }> = [
  { id: "lapis", label: "Lapis Steel" },
  { id: "phosphor", label: "Phosphor" },
  { id: "amber", label: "Amber CRT" },
  { id: "ice", label: "Ice LCD" },
];

const visualizers: Array<{ id: VisualizerMode; label: string }> = [
  { id: "classicBars", label: "Winamp Bars" },
  { id: "windowsScope", label: "Old Windows" },
  { id: "waveform", label: "Oscilloscope" },
];

const VISUALIZER_RENDER_FPS = 60;
const VISUALIZER_RENDER_INTERVAL_MS = 1000 / VISUALIZER_RENDER_FPS;
const VISUALIZER_MAX_DEVICE_PIXEL_RATIO = 1.5;
const VISUALIZER_STORE_INTERVAL_MS = 100;
const PLAYER_STATUS_RENDER_INTERVAL_MS = 250;
const SIDE_METER_SEGMENTS = Array.from({ length: 12 }, (_, index) => index);

const activeVisualizerIds = visualizers.map((item) => item.id);

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type MetadataDraft = {
  title: string;
  artist: string;
  genre: string;
  year: string;
  coverArtPath: string | null;
};

type RepeatMode = "all" | "one";

function App() {
  const songs = useAppStore((state) => state.songs);
  const selectedSongId = useAppStore((state) => state.selectedSongId);
  const pendingSongId = useAppStore((state) => state.pendingSongId);
  const playerStatus = useAppStore((state) => state.playerStatus);
  const visualizerMode = useAppStore((state) => state.visualizerMode);
  const theme = useAppStore((state) => state.theme);
  const scanError = useAppStore((state) => state.scanError);
  const isScanning = useAppStore((state) => state.isScanning);
  const isLoadingTrack = useAppStore((state) => state.isLoadingTrack);
  const setSongs = useAppStore((state) => state.setSongs);
  const setSelectedSongId = useAppStore((state) => state.setSelectedSongId);
  const setPendingSongId = useAppStore((state) => state.setPendingSongId);
  const setPlayerStatus = useAppStore((state) => state.setPlayerStatus);
  const setVisualizerFrame = useAppStore((state) => state.setVisualizerFrame);
  const setVisualizerMode = useAppStore((state) => state.setVisualizerMode);
  const setTheme = useAppStore((state) => state.setTheme);
  const setScanError = useAppStore((state) => state.setScanError);
  const setIsScanning = useAppStore((state) => state.setIsScanning);
  const setIsLoadingTrack = useAppStore((state) => state.setIsLoadingTrack);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMetadataEditorOpen, setIsMetadataEditorOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [metadataDraft, setMetadataDraft] = useState<MetadataDraft>(() => createMetadataDraft());
  const [metadataStatus, setMetadataStatus] = useState<string | undefined>();
  const [isSavingMetadata, setIsSavingMetadata] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("all");
  const [isShuffleEnabled, setIsShuffleEnabled] = useState(false);
  const preloadQueueRef = useRef<Set<string>>(new Set());
  const playRequestRef = useRef(0);
  const lastVisualizerStoreUpdateRef = useRef(0);
  const lastStatusRenderUpdateRef = useRef(0);
  const canvasFrameRef = useRef<VisualizerFrame | undefined>(undefined);
  const lastPlaybackRef = useRef<{ songId?: string | null; wasPlaying: boolean }>({
    songId: undefined,
    wasPlaying: false,
  });
  const handledCompletionRef = useRef<string | undefined>(undefined);
  const suppressAutoAdvanceRef = useRef(false);

  const selectedSong = useMemo(
    () => songs.find((song) => song.id === selectedSongId) ?? songs[0],
    [selectedSongId, songs],
  );
  const nowPlayingSong = useMemo(
    () => songs.find((song) => song.id === playerStatus.songId),
    [playerStatus.songId, songs],
  );
  const displaySong = nowPlayingSong ?? selectedSong;
  const filteredSongs = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return songs;
    return songs.filter((song) =>
      [song.title, song.artist, song.album, song.fileName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [searchQuery, songs]);

  const preloadSong = useCallback((songId: string) => {
    if (!isTauriRuntime || preloadQueueRef.current.has(songId)) return;
    preloadQueueRef.current.add(songId);
    invoke("preload_song", { songId })
      .catch((error) => console.warn("song preload failed", error))
      .finally(() => preloadQueueRef.current.delete(songId));
  }, []);

  const play = useCallback(async (song: Song | undefined = selectedSong) => {
    if (!isTauriRuntime) {
      setScanError("Playback uses the Tauri/Rust backend. Start the desktop app with `pnpm run desktop`.");
      return;
    }
    if (!song) return;
    const requestId = playRequestRef.current + 1;
    playRequestRef.current = requestId;
    setSelectedSongId(song.id);
    setPendingSongId(song.id);
    setIsLoadingTrack(true);
    setScanError(undefined);
    suppressAutoAdvanceRef.current = false;
    handledCompletionRef.current = undefined;
    try {
      const status = await invoke<PlayerStatus>("play_song", { songId: song.id });
      if (playRequestRef.current !== requestId) return;
      setPlayerStatus(status);
    } catch (error) {
      if (playRequestRef.current !== requestId) return;
      setScanError(String(error));
      try {
        const status = await invoke<PlayerStatus>("get_player_status");
        if (playRequestRef.current === requestId) {
          setPlayerStatus(status);
        }
      } catch {
        // Keep the original playback error visible.
      }
    } finally {
      if (playRequestRef.current === requestId) {
        setPendingSongId(undefined);
        setIsLoadingTrack(false);
      }
    }
  }, [
    selectedSong,
    setIsLoadingTrack,
    setPendingSongId,
    setPlayerStatus,
    setScanError,
    setSelectedSongId,
  ]);

  const handleSongSelect = useCallback((songId: string) => {
    setSelectedSongId(songId);
    preloadSong(songId);
  }, [preloadSong, setSelectedSongId]);

  const handleSongPlay = useCallback((song: Song) => {
    void play(song);
  }, [play]);

  useEffect(() => {
    if (!isTauriRuntime) {
      setScanError("Run `pnpm run desktop` to use folder import and playback in the macOS desktop app.");
      return;
    }

    invoke<Song[]>("get_songs")
      .then(setSongs)
      .catch((error) => setScanError(String(error)));

    invoke<PlayerStatus>("get_player_status")
      .then(setPlayerStatus)
      .catch((error) => setScanError(String(error)));

    const unlisten = listen<VisualizerFrame>("visualizer-frame", (event) => {
      canvasFrameRef.current = event.payload;
      const now = performance.now();
      if (now - lastVisualizerStoreUpdateRef.current >= VISUALIZER_STORE_INTERVAL_MS) {
        lastVisualizerStoreUpdateRef.current = now;
        setVisualizerFrame(event.payload);
      }
      if (now - lastStatusRenderUpdateRef.current >= PLAYER_STATUS_RENDER_INTERVAL_MS) {
        lastStatusRenderUpdateRef.current = now;
        setPlayerStatus({
          ...useAppStore.getState().playerStatus,
          positionSeconds: event.payload.timestamp,
        });
      }
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [setPlayerStatus, setScanError, setSongs, setVisualizerFrame]);

  useEffect(() => {
    if (!isTauriRuntime || !playerStatus.songId) return;
    const intervalMs = playerStatus.isPlaying ? 750 : 1500;
    const interval = window.setInterval(() => {
      invoke<PlayerStatus>("get_player_status")
        .then(setPlayerStatus)
        .catch(() => {
          // The visualizer event loop will continue to update status when available.
        });
    }, intervalMs);

    return () => window.clearInterval(interval);
  }, [playerStatus.isPlaying, playerStatus.songId, setPlayerStatus]);

  useEffect(() => {
    if (!selectedSong) return;
    preloadSong(selectedSong.id);
  }, [preloadSong, selectedSong?.id]);

  useEffect(() => {
    if (songs.length === 0) return;
    preloadSong(songs[0].id);
  }, [preloadSong, songs]);

  useEffect(() => {
    setMetadataDraft(createMetadataDraft(selectedSong));
    setMetadataStatus(undefined);
  }, [selectedSong?.id]);

  useEffect(() => {
    if (!activeVisualizerIds.includes(visualizerMode)) {
      setVisualizerMode("classicBars");
    }
  }, [setVisualizerMode, visualizerMode]);

  async function chooseFolder() {
    if (!isTauriRuntime) {
      setScanError("This screen is running in a browser. Start the desktop app with `pnpm run desktop`.");
      return;
    }

    setIsScanning(true);
    setScanError(undefined);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Choose a music folder",
      });
      if (typeof selected !== "string") {
        return;
      }
      const nextSongs = await invoke<Song[]>("scan_music_folder", { path: selected });
      setSongs(nextSongs);
      if (nextSongs.length > 0) {
        setSelectedSongId(nextSongs[0].id);
      }
    } catch (error) {
      setScanError(String(error));
    } finally {
      setIsScanning(false);
    }
  }

  async function rescanFolder() {
    if (!isTauriRuntime) {
      setScanError("Directory rescans use the Tauri/Rust backend. Start the desktop app with `pnpm run desktop`.");
      return;
    }

    setIsScanning(true);
    setScanError(undefined);
    try {
      const nextSongs = await invoke<Song[]>("rescan_music_folder");
      setSongs(nextSongs);
      if (nextSongs.length > 0 && !nextSongs.some((song) => song.id === selectedSongId)) {
        setSelectedSongId(nextSongs[0].id);
      }
    } catch (error) {
      setScanError(String(error));
    } finally {
      setIsScanning(false);
    }
  }

  function updateSongInState(updatedSong: Song) {
    setSongs(songs.map((song) => (song.id === updatedSong.id ? updatedSong : song)));
    if (playerStatus.songId === updatedSong.id) {
      setPlayerStatus({
        ...playerStatus,
        title: updatedSong.title,
        artist: updatedSong.artist,
      });
    }
  }

  async function chooseAlbumArt() {
    if (!isTauriRuntime) {
      setMetadataStatus("Album art import is available in the desktop app.");
      return;
    }

    setMetadataStatus(undefined);
    try {
      const selected = await open({
        multiple: false,
        title: "Choose album art",
        filters: [
          {
            name: "Images",
            extensions: ["png", "jpg", "jpeg", "webp"],
          },
        ],
      });
      if (typeof selected !== "string") return;
      const optimizedPath = await invoke<string>("import_album_art", { sourcePath: selected });
      setMetadataDraft((draft) => ({ ...draft, coverArtPath: optimizedPath }));
      setMetadataStatus("Artwork optimized to 1024 x 1024 JPEG.");
    } catch (error) {
      setMetadataStatus(String(error));
    }
  }

  async function saveMetadata() {
    if (!selectedSong) return;
    if (!isTauriRuntime) {
      setMetadataStatus("Metadata editing is available in the desktop app.");
      return;
    }

    setIsSavingMetadata(true);
    setMetadataStatus(undefined);
    try {
      const metadata: SongMetadataInput = {
        title: textOrNull(metadataDraft.title),
        artist: textOrNull(metadataDraft.artist),
        genre: textOrNull(metadataDraft.genre),
        year: numberOrNull(metadataDraft.year),
        coverArtPath: metadataDraft.coverArtPath,
      };
      const updatedSong = await invoke<Song>("update_song_metadata", {
        songId: selectedSong.id,
        metadata,
      });
      updateSongInState(updatedSong);
      setMetadataDraft(createMetadataDraft(updatedSong));
      setMetadataStatus("Metadata saved locally.");
      setIsMetadataEditorOpen(false);
    } catch (error) {
      setMetadataStatus(String(error));
    } finally {
      setIsSavingMetadata(false);
    }
  }

  async function pauseOrResume() {
    if (!isTauriRuntime) return;
    suppressAutoAdvanceRef.current = playerStatus.isPlaying;
    const status = await invoke<PlayerStatus>(playerStatus.isPlaying ? "pause_song" : "resume_song");
    if (status.isPlaying) {
      suppressAutoAdvanceRef.current = false;
    }
    setPlayerStatus(status);
  }

  async function primaryTransportAction() {
    if (playerStatus.isPlaying) {
      await pauseOrResume();
      return;
    }

    if (playerStatus.songId && (!selectedSong || selectedSong.id === playerStatus.songId)) {
      await pauseOrResume();
      return;
    }

    await play(selectedSong);
  }

  async function stop() {
    if (!isTauriRuntime) return;
    suppressAutoAdvanceRef.current = true;
    const status = await invoke<PlayerStatus>("stop_song");
    setPlayerStatus(status);
  }

  async function setVolume(volume: number) {
    if (!isTauriRuntime) {
      setPlayerStatus({ ...playerStatus, volume });
      return;
    }
    const status = await invoke<PlayerStatus>("set_volume", { volume });
    setPlayerStatus(status);
  }

  async function seek(positionSeconds: number) {
    if (!isTauriRuntime) {
      setPlayerStatus({ ...playerStatus, positionSeconds });
      return;
    }
    const status = await invoke<PlayerStatus>("seek_song", { positionSeconds });
    setPlayerStatus(status);
  }

  function nextSong(offset: number) {
    const next = pickNextSong(playerStatus.songId ?? selectedSongId, offset, isShuffleEnabled);
    if (!next) return;
    preloadSong(next.id);
    void play(next);
  }

  function pickNextSong(currentSongId: string | null | undefined, offset: number, shuffle: boolean) {
    if (songs.length === 0) return undefined;

    if (shuffle && songs.length > 1) {
      const candidates = songs.filter((song) => song.id !== currentSongId);
      return candidates[Math.floor(Math.random() * candidates.length)] ?? songs[0];
    }

    const currentIndex = Math.max(
      0,
      songs.findIndex((song) => song.id === currentSongId),
    );
    return songs[(currentIndex + offset + songs.length) % songs.length];
  }

  function toggleRepeatMode() {
    setRepeatMode((mode) => (mode === "all" ? "one" : "all"));
  }

  useEffect(() => {
    const previous = lastPlaybackRef.current;
    const wasPlayingThisSong =
      previous.wasPlaying && previous.songId != null && previous.songId === playerStatus.songId;
    const isAtEnd =
      playerStatus.songId != null &&
      playerStatus.durationSeconds > 0 &&
      playerStatus.positionSeconds >= Math.max(0, playerStatus.durationSeconds - 0.2);
    const isCompleted =
      wasPlayingThisSong &&
      !playerStatus.isPlaying &&
      isAtEnd &&
      !isLoadingTrack &&
      !suppressAutoAdvanceRef.current;

    lastPlaybackRef.current = {
      songId: playerStatus.songId,
      wasPlaying: playerStatus.isPlaying,
    };

    if (!isCompleted) {
      if (playerStatus.isPlaying) {
        handledCompletionRef.current = undefined;
        suppressAutoAdvanceRef.current = false;
      }
      return;
    }

    const completionKey = `${playerStatus.songId}:${Math.round(playerStatus.durationSeconds * 10)}`;
    if (handledCompletionRef.current === completionKey) return;
    handledCompletionRef.current = completionKey;

    const completedSong = songs.find((song) => song.id === playerStatus.songId);
    const next = repeatMode === "one"
      ? completedSong
      : pickNextSong(playerStatus.songId, 1, isShuffleEnabled);
    if (next) {
      preloadSong(next.id);
      void play(next);
    }
  }, [isLoadingTrack, isShuffleEnabled, playerStatus, repeatMode, songs]);

  return (
    <main className={clsx("app-shell", `theme-${theme}`)}>
      <section className="player-frame">
        <header className="title-strip">
          <div className="brand-lockup">
            <Waves size={15} />
            <span>LAPIS PLAYER</span>
          </div>
          <div className="title-marquee">
            <MarqueeLine
              text={playerStatus.title ?? nowPlayingSong?.title ?? displaySong?.title ?? displaySong?.fileName ?? "No song loaded"}
            />
          </div>
          <button
            className="icon-button"
            type="button"
            title="Settings"
            aria-label="Open settings"
            onClick={() => setIsSettingsOpen(true)}
          >
            <Settings size={15} />
          </button>
        </header>

        <div className="deck-grid">
          <aside className="left-rack">
            <CoverPanel
              song={displaySong}
              isPreview={!nowPlayingSong && Boolean(selectedSong)}
              onEdit={() => {
                setMetadataDraft(createMetadataDraft(selectedSong));
                setMetadataStatus(undefined);
                setIsMetadataEditorOpen(true);
              }}
            />
            <TransportPanel
              canPlay={songs.length > 0}
              isLoadingTrack={isLoadingTrack}
              isShuffleEnabled={isShuffleEnabled}
              repeatMode={repeatMode}
              status={playerStatus}
              onPrimary={() => void primaryTransportAction()}
              onStop={() => void stop()}
              onPrevious={() => nextSong(-1)}
              onNext={() => nextSong(1)}
              onToggleShuffle={() => setIsShuffleEnabled((enabled) => !enabled)}
              onToggleRepeat={toggleRepeatMode}
              onVolume={setVolume}
              onSeek={seek}
            />
          </aside>

          <VisualizerRack
            frameRef={canvasFrameRef}
            mode={visualizerMode}
            theme={theme}
          />
        </div>

        <section className="library-panel">
          <div className="library-toolbar">
            <button className="utility-button" type="button" onClick={() => void chooseFolder()}>
              <FolderOpen size={15} />
              {isScanning ? "Scanning..." : "Import Folder"}
            </button>
            <button
              className="icon-button refresh-button"
              type="button"
              title="Rescan music directory"
              aria-label="Rescan music directory"
              disabled={isScanning}
              onClick={() => void rescanFolder()}
            >
              <RefreshCw size={14} className={clsx(isScanning && "spin-icon")} />
            </button>
            <label className="search-box">
              <Search size={14} />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.currentTarget.value)}
                placeholder="Search tracks"
              />
            </label>
            <span>
              {filteredSongs.length}/{songs.length} tracks
            </span>
          </div>
          {scanError && <div className="error-line">{scanError}</div>}
          <SongTable
            songs={filteredSongs}
            selectedSongId={selectedSongId}
            playingSongId={playerStatus.songId}
            pendingSongId={pendingSongId}
            onSelect={handleSongSelect}
            onPreload={preloadSong}
            onPlay={handleSongPlay}
          />
        </section>
      </section>

      {isSettingsOpen && (
        <SettingsModal
          visualizerMode={visualizerMode}
          theme={theme}
          onModeChange={setVisualizerMode}
          onThemeChange={setTheme}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}

      {isMetadataEditorOpen && (
        <MetadataEditor
          draft={metadataDraft}
          song={selectedSong}
          status={metadataStatus}
          isSaving={isSavingMetadata}
          onDraftChange={setMetadataDraft}
          onChooseArt={() => void chooseAlbumArt()}
          onSave={() => void saveMetadata()}
          onClose={() => setIsMetadataEditorOpen(false)}
        />
      )}
    </main>
  );
}

function CoverPanel({
  song,
  isPreview,
  onEdit,
}: {
  song?: Song;
  isPreview: boolean;
  onEdit: () => void;
}) {
  const coverUrl = song?.coverArtPath ? convertFileSrc(song.coverArtPath) : undefined;

  return (
    <section className="cover-panel">
      <div className="cover-art">
        {coverUrl ? <img src={coverUrl} alt="" /> : <div className="cover-placeholder">LAPIS</div>}
      </div>
      <div className="song-readout">
        <span className={clsx("playback-badge", isPreview && "preview")}>
          {song ? (isPreview ? "Selected" : "Now playing") : "No track"}
        </span>
        <MarqueeLine
          className="song-title-line"
          text={song?.title ?? song?.fileName ?? "No track selected"}
        />
        <MarqueeLine
          className="song-meta-line"
          text={song?.artist ?? "Unknown Artist"}
        />
        <MarqueeLine
          className="song-meta-line"
          text={`${song?.genre ?? "Unknown Genre"}${song?.year ? ` / ${song.year}` : ""}`}
        />
        <button
          className="utility-button edit-metadata-button"
          type="button"
          title="Edit metadata"
          aria-label="Edit metadata"
          disabled={!song}
          onClick={onEdit}
        >
          <PencilLine size={15} strokeWidth={2.4} />
        </button>
      </div>
    </section>
  );
}

function MarqueeLine({ text, className }: { text: string; className?: string }) {
  const shouldScroll = text.length > 24;

  if (!shouldScroll) {
    return (
      <span className={clsx("marquee-line marquee-static", className)} title={text}>
        {text}
      </span>
    );
  }

  return (
    <span className={clsx("marquee-line", className)} title={text}>
      <span className="marquee-track">
        <span>{text}</span>
        <span aria-hidden="true">{text}</span>
      </span>
    </span>
  );
}

function MetadataEditor({
  draft,
  song,
  status,
  isSaving,
  onDraftChange,
  onChooseArt,
  onSave,
  onClose,
}: {
  draft: MetadataDraft;
  song?: Song;
  status?: string;
  isSaving: boolean;
  onDraftChange: (draft: MetadataDraft) => void;
  onChooseArt: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const coverUrl = draft.coverArtPath ? convertFileSrc(draft.coverArtPath) : undefined;

  function patchDraft(patch: Partial<MetadataDraft>) {
    onDraftChange({ ...draft, ...patch });
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="metadata-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header>
          <div className="metadata-heading">
            <PencilLine size={14} />
            <strong>Edit Track</strong>
          </div>
          <button className="icon-button" type="button" aria-label="Close metadata editor" onClick={onClose}>
            <X size={15} />
          </button>
        </header>
        <div className="metadata-modal-body">
          <div className="metadata-art-preview">
            {coverUrl ? <img src={coverUrl} alt="" /> : <span>1024</span>}
          </div>
          <div className="metadata-grid">
            <label>
              <span>Title</span>
              <input value={draft.title} disabled={!song} onChange={(event) => patchDraft({ title: event.currentTarget.value })} />
            </label>
            <label>
              <span>Artist</span>
              <input value={draft.artist} disabled={!song} onChange={(event) => patchDraft({ artist: event.currentTarget.value })} />
            </label>
            <label>
              <span>Genre</span>
              <input value={draft.genre} disabled={!song} onChange={(event) => patchDraft({ genre: event.currentTarget.value })} />
            </label>
            <label>
              <span>Year</span>
              <input value={draft.year} inputMode="numeric" disabled={!song} onChange={(event) => patchDraft({ year: event.currentTarget.value })} />
            </label>
          </div>
        </div>
        <footer>
          <button className="utility-button" type="button" disabled={!song} onClick={onChooseArt}>
            <ImagePlus size={14} />
            Album Art
          </button>
          <button className="utility-button save-button" type="button" disabled={!song || isSaving} onClick={onSave}>
            <Save size={14} />
            {isSaving ? "Saving..." : "Save"}
          </button>
        </footer>
        {status && <div className="metadata-status">{status}</div>}
      </section>
    </div>
  );
}

const VisualizerRack = memo(function VisualizerRack({
  frameRef,
  mode,
  theme,
}: {
  frameRef: MutableRefObject<VisualizerFrame | undefined>;
  mode: VisualizerMode;
  theme: AppTheme;
}) {
  const frame = useAppStore((state) => state.visualizerFrame);

  return (
    <section className={clsx("visualizer-rack", `visual-mode-${mode}`)}>
      <VisualizerCanvas
        frameRef={frameRef}
        mode={mode}
        theme={theme}
      />
      <SideMeter frame={frame} side="left" />
      <SideMeter frame={frame} side="right" />
      <div className="visualizer-label">
        {getVisualizerLabel(mode)}
      </div>
      <div className="meter-row">
        <Meter label="Bass" value={frame?.bass ?? 0} />
        <Meter label="Pulse" value={frame?.bassPulse ?? 0} />
        <Meter label="Vocal" value={frame?.mids ?? 0} />
        <Meter label="Treble" value={frame?.treble ?? 0} />
      </div>
    </section>
  );
});

function SideMeter({
  frame,
  side,
}: {
  frame?: VisualizerFrame;
  side: "left" | "right";
}) {
  const level = side === "left" ? frame?.leftLevel ?? 0 : frame?.rightLevel ?? 0;
  const vocal = frame?.mids ?? 0;
  const treble = frame?.treble ?? 0;
  const bassPulse = frame?.bassPulse ?? 0;
  const signal = Math.min(1, (level * 0.36 + vocal * 0.48 + bassPulse * 0.14 + treble * 0.1) * 1.5);
  const vocalFocus = Math.min(1, (vocal * 1.18 + treble * 0.16) * 1.5);

  return (
    <div className={clsx("side-meter", `side-meter-${side}`)} aria-hidden="true">
      {SIDE_METER_SEGMENTS.map((index) => {
        const fromBottom = 11 - index;
        const threshold = fromBottom / 12;
        const meterFill = Math.max(0, Math.min(1, (signal - threshold * 0.84) / 0.22));
        const lyricBand = Math.max(0, 1 - Math.abs(threshold - 0.42) * 3.4) * vocalFocus;
        const peakAccent = fromBottom > 8 && meterFill > 0.22 && treble + bassPulse > 0.62;
        const intensity = Math.min(1, meterFill * 0.86 + lyricBand * 0.22 + (peakAccent ? 0.16 : 0));

        return (
          <i
            key={index}
            className={clsx(intensity > 0.08 && "lit", peakAccent && "peak")}
            style={
              {
                "--meter-intensity": intensity.toFixed(3),
                "--meter-fill": meterFill.toFixed(3),
                "--meter-vocal": lyricBand.toFixed(3),
                "--meter-glow": `${(3 + intensity * 14).toFixed(1)}px`,
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
}

function getVisualizerLabel(mode: VisualizerMode) {
  switch (mode) {
    case "trapNation":
      return "TRAP PULSE FIELD";
    case "wmpRibbons":
      return "WMP RIBBON FIELD";
    case "plasmaStorm":
      return "PLASMA STORM";
    case "spectrumRing":
      return "SPECTRUM RING";
    case "centerStereo":
      return "CENTER STEREO FIELD";
    case "classicBars":
      return "CLASSIC ANALYZER";
    case "radial":
      return "RADIAL DECK";
    case "windowsScope":
      return "WINDOWS ANALYZER";
    case "waveform":
      return "OSCILLOSCOPE";
  }
}

function TransportPanel({
  canPlay,
  isLoadingTrack,
  isShuffleEnabled,
  repeatMode,
  status,
  onPrimary,
  onStop,
  onPrevious,
  onNext,
  onToggleShuffle,
  onToggleRepeat,
  onVolume,
  onSeek,
}: {
  canPlay: boolean;
  isLoadingTrack: boolean;
  isShuffleEnabled: boolean;
  repeatMode: RepeatMode;
  status: PlayerStatus;
  onPrimary: () => void;
  onStop: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onToggleShuffle: () => void;
  onToggleRepeat: () => void;
  onVolume: (volume: number) => void;
  onSeek: (positionSeconds: number) => void;
}) {
  const [draftPosition, setDraftPosition] = useState<number | null>(null);
  const visiblePosition = draftPosition ?? status.positionSeconds;
  const boundedPosition = Math.min(Math.max(visiblePosition, 0), status.durationSeconds || 0);

  function commitSeek(value: number) {
    const boundedValue = Math.min(Math.max(value, 0), status.durationSeconds || 0);
    setDraftPosition(null);
    onSeek(boundedValue);
  }

  return (
    <section className="transport-panel">
      <div className="time-row">
        <span>{formatTime(boundedPosition)}</span>
        <span>{formatTime(status.durationSeconds)}</span>
      </div>
      <input
        className="seek-slider"
        type="range"
        min="0"
        max={Math.max(0, status.durationSeconds)}
        step="0.1"
        value={boundedPosition}
        disabled={!canPlay || status.durationSeconds <= 0}
        onChange={(event) => setDraftPosition(Number(event.currentTarget.value))}
        onBlur={() => draftPosition !== null && commitSeek(draftPosition)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && draftPosition !== null) {
            commitSeek(draftPosition);
          }
        }}
        onKeyUp={(event) => {
          if (
            ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) &&
            draftPosition !== null
          ) {
            commitSeek(draftPosition);
          }
        }}
        onPointerUp={(event) => commitSeek(Number(event.currentTarget.value))}
      />
      <div className="button-row">
        <button
          className={clsx("control-button mode-toggle", isShuffleEnabled && "active")}
          type="button"
          title={isShuffleEnabled ? "Shuffle on" : "Shuffle off"}
          aria-label={isShuffleEnabled ? "Turn shuffle off" : "Turn shuffle on"}
          aria-pressed={isShuffleEnabled}
          disabled={!canPlay}
          onClick={onToggleShuffle}
        >
          <Shuffle size={15} />
        </button>
        <button className="control-button" type="button" disabled={!canPlay} onClick={onPrevious}>
          <SkipBack size={16} />
        </button>
        <button className="control-button primary" type="button" disabled={!canPlay || isLoadingTrack} onClick={onPrimary}>
          {status.isPlaying ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <button className="control-button" type="button" onClick={onStop}>
          <Square size={14} />
        </button>
        <button className="control-button" type="button" disabled={!canPlay} onClick={onNext}>
          <SkipForward size={16} />
        </button>
        <button
          className={clsx("control-button mode-toggle active", repeatMode === "one" && "repeat-one")}
          type="button"
          title={repeatMode === "one" ? "Repeat one" : "Repeat all"}
          aria-label={repeatMode === "one" ? "Switch to repeat all" : "Switch to repeat one"}
          aria-pressed
          disabled={!canPlay}
          onClick={onToggleRepeat}
        >
          {repeatMode === "one" ? <Repeat1 size={15} /> : <Repeat size={15} />}
        </button>
      </div>
      <label className="volume-row">
        <Volume2 size={15} />
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={status.volume}
          onChange={(event) => onVolume(Number(event.currentTarget.value))}
        />
      </label>
      {isLoadingTrack && <div className="loading-line">Decoding track...</div>}
    </section>
  );
}

const VisualizerCanvas = memo(function VisualizerCanvas({
  frameRef,
  mode,
  theme,
}: {
  frameRef: MutableRefObject<VisualizerFrame | undefined>;
  mode: VisualizerMode;
  theme: AppTheme;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasSizeRef = useRef({
    width: 0,
    height: 0,
    deviceWidth: 0,
    deviceHeight: 0,
    scale: 1,
  });
  const renderStateRef = useRef<VisualizerRenderState>({
    smoothedBars: [],
    peakBars: [],
    vocalWave: [],
    melodyWave: [],
    scopeWave: [],
    scopeCeiling: 0.45,
    scopeFloor: 0.02,
    analyzerCeiling: 0.18,
    analyzerFloor: 0.02,
    phase: 0,
    lastTime: 0,
    lastRenderWallTime: 0,
    interpolatedFrame: createEmptyVisualizerFrame(),
    nextFrameArrival: 0,
    lastRenderedTimestamp: -1,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    const activeCanvas = canvas;
    const activeContext = context;

    let animationFrame = 0;
    let lastDeviceWidth = 0;
    let lastDeviceHeight = 0;
    const syncCanvasSize = () => {
      const rect = activeCanvas.getBoundingClientRect();
      const scale = Math.min(window.devicePixelRatio || 1, VISUALIZER_MAX_DEVICE_PIXEL_RATIO);
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      canvasSizeRef.current = {
        width,
        height,
        deviceWidth: Math.max(1, Math.round(width * scale)),
        deviceHeight: Math.max(1, Math.round(height * scale)),
        scale,
      };
    };

    syncCanvasSize();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(syncCanvasSize);
    resizeObserver?.observe(activeCanvas);
    window.addEventListener("resize", syncCanvasSize);

    function render(now: number) {
      if (document.visibilityState === "hidden") {
        animationFrame = window.requestAnimationFrame(render);
        return;
      }

      const { width, height, deviceWidth, deviceHeight, scale } = canvasSizeRef.current;
      const needsResize = deviceWidth !== lastDeviceWidth || deviceHeight !== lastDeviceHeight;
      if (needsResize) {
        activeCanvas.width = deviceWidth;
        activeCanvas.height = deviceHeight;
        lastDeviceWidth = deviceWidth;
        lastDeviceHeight = deviceHeight;
      }

      const state = renderStateRef.current;
      const incoming = frameRef.current;
      if (
        !needsResize &&
        state.lastRenderWallTime > 0 &&
        now - state.lastRenderWallTime < VISUALIZER_RENDER_INTERVAL_MS
      ) {
        animationFrame = window.requestAnimationFrame(render);
        return;
      }

      if (incoming && incoming.timestamp !== state.nextFrame?.timestamp) {
        const gap = state.nextFrame ? Math.abs(incoming.timestamp - state.nextFrame.timestamp) : 0;
        state.prevFrame = gap > 1.0 ? undefined : state.nextFrame;
        state.nextFrame = incoming;
        state.nextFrameArrival = now;
      }

      let displayFrame: VisualizerFrame | undefined;
      if (state.prevFrame && state.nextFrame) {
        const frameIntervalMs = (state.nextFrame.timestamp - state.prevFrame.timestamp) * 1000;
        const t = Math.min(1, (now - state.nextFrameArrival) / Math.max(frameIntervalMs, 16));
        displayFrame = interpolateFrameInto(
          state.interpolatedFrame,
          state.prevFrame,
          state.nextFrame,
          t,
        );
      } else {
        displayFrame = state.nextFrame ?? state.prevFrame;
      }

      const displayTimestamp = displayFrame?.timestamp ?? -1;
      const useHighFpsSmoothing =
        Boolean(displayFrame) &&
        (mode === "classicBars" || mode === "windowsScope" || mode === "waveform") &&
        now - state.nextFrameArrival < 250;
      if (!useHighFpsSmoothing && displayTimestamp === state.lastRenderedTimestamp && !needsResize) {
        animationFrame = window.requestAnimationFrame(render);
        return;
      }
      state.lastRenderedTimestamp = displayTimestamp;
      state.lastRenderWallTime = now;

      activeContext.setTransform(scale, 0, 0, scale, 0, 0);
      drawVisualizer(
        activeContext,
        width,
        height,
        displayFrame,
        mode,
        theme,
        state,
        now,
      );
      animationFrame = window.requestAnimationFrame(render);
    }

    animationFrame = window.requestAnimationFrame(render);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncCanvasSize);
    };
  }, [mode, theme]);

  return <canvas className="visualizer-canvas" ref={canvasRef} />;
});

type VisualizerRenderState = {
  smoothedBars: number[];
  peakBars: number[];
  vocalWave: number[];
  melodyWave: number[];
  scopeWave: number[];
  scopeCeiling: number;
  scopeFloor: number;
  analyzerCeiling: number;
  analyzerFloor: number;
  phase: number;
  lastTime: number;
  lastRenderWallTime: number;
  interpolatedFrame: VisualizerFrame;
  prevFrame?: VisualizerFrame;
  nextFrame?: VisualizerFrame;
  nextFrameArrival: number;
  lastRenderedTimestamp: number;
};

function drawVisualizer(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame | undefined,
  mode: VisualizerMode,
  theme: AppTheme,
  renderState: VisualizerRenderState,
  now: number,
) {
  ensureVisualizerStateDefaults(renderState);
  const palette = getPalette(theme);
  const dt = renderState.lastTime > 0 ? Math.min(0.05, (now - renderState.lastTime) / 1000) : 1 / 60;
  renderState.lastTime = now;
  renderState.phase += dt * 1.35;

  const { smoothedBars, peakBars } = renderState;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);

  if (!frame) {
    context.fillStyle = palette.muted;
    context.font = "11px 'Courier New', monospace";
    context.fillText("WAITING FOR PCM SIGNAL", 18, height / 2);
    return;
  }

  if (mode === "trapNation") {
    drawTrapPulse(context, width, height, frame, renderState, palette);
    return;
  }

  if (mode === "waveform") {
    drawWaveform(context, width, height, frame, renderState, palette, renderState.phase);
    return;
  }

  const bandCount = getVisualizerBandCount(mode);
  const sourceBins =
    mode === "spectrumRing" || mode === "centerStereo" || mode === "radial"
      ? frame.vocalBins?.length
        ? frame.vocalBins
        : frame.frequencyBins
      : frame.frequencyBins;
  const bins = selectVisualizerBands(sourceBins, bandCount, mode);
  while (smoothedBars.length < bins.length) smoothedBars.push(0);
  while (peakBars.length < bins.length) peakBars.push(0);
  smoothedBars.length = bins.length;
  peakBars.length = bins.length;

  const contentWidth = width * (mode === "centerStereo" ? 0.76 : 0.84);
  const paddingX = (width - contentWidth) / 2;
  const floorY = height - 16;
  const usableWidth = contentWidth;
  const usableHeight = height * 0.74;
  const barGap = mode === "windowsScope" ? 4 : 6;
  const barWidth = Math.max(8, (usableWidth - (bins.length - 1) * barGap) / bins.length);
  const blockHeight = mode === "windowsScope" ? 5 : 6;
  const blockGap = 2;

  if (mode === "wmpRibbons") {
    drawWmpRibbons(context, width, height, frame, palette, renderState.phase);
    return;
  }

  if (mode === "plasmaStorm") {
    drawPlasmaStorm(context, width, height, frame, palette, renderState.phase);
    return;
  }

  if (mode === "spectrumRing") {
    drawSpectrumRing(context, width, height, bins, smoothedBars, peakBars, frame, palette, renderState.phase);
    return;
  }

  if (mode === "centerStereo") {
    drawCenterStereo(context, width, height, bins, frame, smoothedBars, peakBars, palette);
    return;
  }

  if (mode === "radial") {
    drawRadialDeck(context, width, height, bins, smoothedBars, peakBars, frame, palette, renderState.phase);
    return;
  }

  const peakBins = selectVisualizerBands(frame.peaks, bandCount, mode);
  const waveformBands = selectWaveformEnvelopeBands(frame.waveform, bandCount, mode);
  const waveformMotion = getWaveformMotion(frame);
  const analyzerTargets = bins.map((target, index) => {
    const center = (bins.length - 1) / 2;
    const centerWeight = mode === "classicBars" || mode === "windowsScope"
      ? Math.max(0, 1 - Math.abs(index - center) / Math.max(1, center))
      : 0;
    const t = index / Math.max(1, bins.length - 1);
    const sampleIndex = Math.round(t * Math.max(0, frame.waveform.length - 1));
    const raw = Math.abs(smoothedWaveSample(frame.waveform, sampleIndex, 1));
    const previousRaw = Math.abs(smoothedWaveSample(frame.waveform, Math.max(0, sampleIndex - 3), 1));
    const nextRaw = Math.abs(smoothedWaveSample(frame.waveform, Math.min(frame.waveform.length - 1, sampleIndex + 3), 1));
    const transient = Math.min(1, Math.abs(nextRaw - previousRaw) * 2.6);
    const peakTarget = peakBins[index] ?? 0;
    const waveformTarget = waveformBands[index] ?? 0;
    const midFocus = Math.max(0, 1 - Math.abs(t - 0.58) / 0.36);
    const edgeShape = Math.pow(Math.abs(t - 0.5) * 2, 1.15);
    const bassLift = waveformMotion.bassAccent * centerWeight * 0.24;
    const riffLift = waveformMotion.riffEnergy * midFocus * 0.36 + transient * waveformMotion.riffFocus * 0.26;
    const vocalLift = waveformMotion.vocalFlow * Math.max(0, 1 - Math.abs(t - 0.5) / 0.5) * 0.16;
    const frequencyTarget = target * (mode === "windowsScope" ? 0.62 : 0.72) + peakTarget * 0.26;
    const motionTarget = Math.max(raw * 1.18, waveformTarget * 0.92) + transient * (0.2 + waveformMotion.rhythmPunch * 0.14);
    const levelLift = frame.volume * 0.04 + edgeShape * 0.014;
    return Math.max(0, motionTarget + frequencyTarget + bassLift + riffLift + vocalLift + levelLift);
  });
  const audibleEnergy = Math.max(frame.volume, frame.bassPulse ?? 0, frame.mids, frame.treble);
  const analyzerPeak = Math.max(0.012, audibleEnergy * 0.36, ...analyzerTargets);
  const analyzerFloor = percentile(analyzerTargets, 0.15);
  renderState.analyzerCeiling += (analyzerPeak - renderState.analyzerCeiling) * (analyzerPeak > renderState.analyzerCeiling ? 0.34 : 0.24);
  renderState.analyzerFloor += (analyzerFloor - renderState.analyzerFloor) * 0.16;
  const analyzerAdaptiveCeiling = Math.max(0.035, Math.min(renderState.analyzerCeiling, analyzerPeak * 1.42 + 0.022));
  const analyzerAdaptiveFloor = Math.min(renderState.analyzerFloor * 0.42, analyzerAdaptiveCeiling * 0.16);
  const analyzerRange = Math.max(0.024, analyzerAdaptiveCeiling - analyzerAdaptiveFloor);

  analyzerTargets.forEach((target, index) => {
    const current = smoothedBars[index] ?? 0;
    const normalized = Math.min(1, Math.max(0, (target - analyzerAdaptiveFloor) / analyzerRange));
    const waveformDetail = waveformBands[index] ?? 0;
    const detailFloor = audibleEnergy > 0.001
      ? Math.min(0.34, 0.045 + audibleEnergy * 4.2 + waveformDetail * 0.22)
      : 0;
    const shapedTarget = Math.max(detailFloor, Math.pow(normalized, mode === "windowsScope" ? 0.9 : 0.78) * 0.98);
    const attack = shapedTarget > current
      ? 0.48 + waveformMotion.riffFocus * 0.18 + waveformMotion.rhythmPunch * 0.06
      : 0.16 + waveformMotion.vocalFocus * 0.04;
    const smoothed = current + (shapedTarget - current) * attack;
    smoothedBars[index] = smoothed;
    peakBars[index] = Math.max(smoothed, (peakBars[index] ?? 0) - 0.012);

    const x = paddingX + index * (barWidth + barGap);
    const barHeight = Math.max(0, smoothed * usableHeight);
    const blockCount = smoothed > 0.012
      ? Math.max(1, Math.floor(barHeight / (blockHeight + blockGap)))
      : 0;
    for (let block = 0; block < blockCount; block += 1) {
      const y = floorY - (block + 1) * (blockHeight + blockGap);
      const heat = block / Math.max(1, Math.floor(usableHeight / (blockHeight + blockGap)));
      const color = getBarColor(palette, mode, heat, index, bins.length);
      context.shadowColor = color;
      context.shadowBlur = heat > 0.7 ? 11 : 5;
      context.fillStyle = color;
      context.fillRect(x, y, barWidth, blockHeight);
    }

    context.shadowBlur = 0;
    const peakY = floorY - peakBars[index] * usableHeight - 3;
    context.fillStyle = palette.peak;
    context.fillRect(x, Math.max(10, peakY), barWidth, mode === "windowsScope" ? 1 : 2);
  });
}

function ensureVisualizerStateDefaults(renderState: VisualizerRenderState) {
  if (!Number.isFinite(renderState.scopeCeiling)) {
    renderState.scopeCeiling = 0.45;
  }
  if (!Number.isFinite(renderState.scopeFloor)) {
    renderState.scopeFloor = 0.02;
  }
  if (!Number.isFinite(renderState.analyzerCeiling)) {
    renderState.analyzerCeiling = 0.18;
  }
  if (!Number.isFinite(renderState.analyzerFloor)) {
    renderState.analyzerFloor = 0.02;
  }
}

function drawWmpRibbons(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame,
  _palette: ReturnType<typeof getPalette>,
  phase: number,
) {
  const sourceBands = frame.vocalBins?.length ? frame.vocalBins : frame.frequencyBins;
  const flowBands = selectCenterOutBands(sourceBands, 42);
  context.globalCompositeOperation = "lighter";
  const hudOrange = "#ff9a35";
  const hudAmber = "#fff179";
  const hudGreen = "#45ff9a";
  const hudRed = "#ff4b35";
  const hudBlue = "#66e8ff";
  const colors = [hudAmber, hudGreen, hudBlue, hudOrange, hudRed];
  const centerX = width / 2;
  const centerY = height / 2;
  const lyricFlow = Math.min(1, frame.mids * 0.72 + frame.treble * 0.32);
  const bassAccent = Math.pow(frame.bassPulse ?? frame.bass, 1.55);
  const radiusBase = Math.min(width, height);

  drawEvaHudOverlay(context, width, height, frame, phase, { hudOrange, hudAmber, hudGreen, hudRed, hudBlue });

  for (let ring = 0; ring < 7; ring += 1) {
    const t = ring / 6;
    const radius = radiusBase * (0.12 + t * 0.34);
    const skew = 0.5 + Math.sin(phase * 0.58 + ring) * 0.08;
    context.save();
    context.translate(centerX, centerY);
    context.rotate(phase * 0.08 + ring * 0.12);
    context.scale(1.08 + lyricFlow * 0.12, skew);
    context.strokeStyle = alphaColor(colors[ring % colors.length], 0.06 + (1 - t) * 0.08 + lyricFlow * 0.07);
    context.lineWidth = ring % 3 === 0 ? 1.25 : 0.8;
    context.beginPath();
    context.ellipse(0, 0, radius, radius * 0.72, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  for (let ribbon = 0; ribbon < 7; ribbon += 1) {
    const side = ribbon % 2 === 0 ? 1 : -1;
    const lane = Math.floor(ribbon / 2);
    const color = colors[ribbon % colors.length];
    context.strokeStyle = color;
    context.lineWidth = 1.8 + lane * 0.22 + lyricFlow * 1.45 + bassAccent * 0.28;
    context.globalAlpha = 0.26 + lyricFlow * 0.24;
    context.shadowColor = color;
    context.shadowBlur = 8 + lyricFlow * 14 + bassAccent * 5;
    context.beginPath();

    for (let step = 0; step <= 140; step += 1) {
      const t = step / 140;
      const bandPosition = t * (flowBands.length - 1);
      const bandIndex = Math.floor(bandPosition);
      const vocal = lerp(
        flowBands[bandIndex] ?? 0,
        flowBands[bandIndex + 1] ?? flowBands[bandIndex] ?? 0,
        bandPosition - bandIndex,
      );
      const sweep = t * Math.PI * (1.05 + lane * 0.08);
      const orbit = phase * (0.56 + lane * 0.04) + side * sweep + lane * 0.5;
      const radius = radiusBase * (0.08 + t * (0.34 + lyricFlow * 0.07));
      const ribbonBend = Math.sin(phase * 1.18 + t * Math.PI * 4.2 + lane) * vocal * height * 0.092;
      const drumKick = bassAccent * Math.pow(1 - t, 3.0) * height * 0.03 * side;
      const x = centerX + Math.cos(orbit) * radius * (0.98 + vocal * 0.18);
      const y = centerY
        + Math.sin(orbit * 0.84 + side * 0.3) * radius * 0.62
        + ribbonBend
        + drumKick;
      if (step === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }

  for (let ray = 0; ray < 12; ray += 1) {
    const energy = ray % 3 === 0 ? bassAccent : frame.treble;
    const angle = phase * 0.5 + ray * ((Math.PI * 2) / 12);
    const inner = radiusBase * (0.08 + lyricFlow * 0.04);
    const outer = inner + radiusBase * (0.08 + energy * 0.22);
    const color = ray % 3 === 0 ? hudRed : hudGreen;
    context.globalAlpha = 0.05 + energy * 0.15;
    context.strokeStyle = color;
    context.lineWidth = ray % 3 === 0 ? 2 : 1;
    context.shadowColor = color;
    context.shadowBlur = 10 + energy * 16;
    context.beginPath();
    context.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner);
    context.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer);
    context.stroke();
  }

  const sparkCount = Math.round(5 + frame.treble * 16 + bassAccent * 5);
  for (let spark = 0; spark < sparkCount; spark += 1) {
    const seed = spark * 19.19 + Math.floor(phase * 3.2) * 43.7;
    const angle = fract(Math.sin(seed) * 9137.41) * Math.PI * 2;
    const radius = radiusBase * (0.1 + fract(Math.sin(seed + 2.4) * 137.5) * 0.38);
    const x = centerX + Math.cos(angle + phase * 0.28) * radius;
    const y = centerY + Math.sin(angle * 0.82 - phase * 0.2) * radius * 0.68;
    context.fillStyle = alphaColor(spark % 4 === 0 ? hudRed : hudAmber, 0.14 + frame.treble * 0.36);
    context.beginPath();
    context.arc(x, y, 1.3 + frame.treble * 2.2 + (spark % 4 === 0 ? bassAccent * 2 : 0), 0, Math.PI * 2);
    context.fill();
  }

  context.shadowBlur = 0;
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
}

function drawEvaHudOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame,
  phase: number,
  colors: {
    hudOrange: string;
    hudAmber: string;
    hudGreen: string;
    hudRed: string;
    hudBlue: string;
  },
) {
  const { hudOrange, hudAmber, hudGreen, hudRed, hudBlue } = colors;
  const centerX = width / 2;
  const centerY = height / 2;
  const bassAccent = Math.pow(frame.bassPulse ?? frame.bass, 1.55);
  const lyricFlow = Math.min(1, frame.mids * 0.72 + frame.treble * 0.32);

  context.save();
  context.globalCompositeOperation = "lighter";
  context.lineWidth = 1;
  context.font = "10px 'Courier New', monospace";
  context.textBaseline = "middle";

  context.strokeStyle = alphaColor(hudGreen, 0.09 + lyricFlow * 0.08);
  for (let x = 20; x < width; x += 42) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x + Math.sin(phase + x * 0.01) * 3, height);
    context.stroke();
  }
  for (let y = 20; y < height; y += 32) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y + Math.cos(phase + y * 0.02) * 2);
    context.stroke();
  }

  context.strokeStyle = alphaColor(hudOrange, 0.34);
  context.lineWidth = 1.4;
  drawChamferFrame(context, 18, 18, width - 36, height - 36, 18);
  context.stroke();

  context.strokeStyle = alphaColor(hudRed, 0.18 + bassAccent * 0.24);
  context.lineWidth = 1.2;
  context.beginPath();
  context.arc(centerX, centerY, Math.min(width, height) * (0.19 + bassAccent * 0.018), 0, Math.PI * 2);
  context.stroke();
  context.beginPath();
  context.arc(centerX, centerY, Math.min(width, height) * (0.28 + lyricFlow * 0.025), phase, phase + Math.PI * 1.5);
  context.stroke();

  const panels = [
    { x: 30, y: 28, w: 122, h: 38, label: "VOCAL", value: frame.mids },
    { x: width - 152, y: 28, w: 122, h: 38, label: "BASS", value: frame.bass },
    { x: width - 156, y: height - 66, w: 126, h: 38, label: "MELODY", value: lyricFlow },
  ];

  panels.forEach((panel, index) => {
    context.strokeStyle = alphaColor(index % 2 === 0 ? hudOrange : hudGreen, 0.58);
    context.fillStyle = alphaColor("#060804", 0.34);
    context.lineWidth = 1.2;
    drawChamferFrame(context, panel.x, panel.y, panel.w, panel.h, 8);
    context.fill();
    context.stroke();
    context.fillStyle = alphaColor(index === 2 ? hudRed : hudAmber, 0.85);
    context.fillText(panel.label, panel.x + 10, panel.y + 12);
    const meterWidth = Math.max(2, (panel.w - 20) * Math.min(1, panel.value));
    context.fillStyle = alphaColor(index === 1 ? hudOrange : hudGreen, 0.58);
    context.fillRect(panel.x + 10, panel.y + 24, meterWidth, 5);
    context.strokeStyle = alphaColor(hudAmber, 0.22);
    context.strokeRect(panel.x + 10, panel.y + 24, panel.w - 20, 5);
  });

  const warningAlpha = bassAccent > 0.52 ? 0.72 : 0.28 + lyricFlow * 0.12;
  context.fillStyle = alphaColor(hudRed, warningAlpha);
  context.strokeStyle = alphaColor(hudRed, warningAlpha);
  drawHexWarning(context, centerX - 46, 42, 13, "");
  drawHexWarning(context, centerX + 46, 42, 13, "");

  context.strokeStyle = alphaColor(hudBlue, 0.22 + frame.treble * 0.16);
  context.lineWidth = 1;
  for (let index = 0; index < 12; index += 1) {
    const angle = phase * 0.18 + index * (Math.PI / 6);
    const radius = Math.min(width, height) * 0.31;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius * 0.68;
    context.beginPath();
    context.moveTo(x - 5, y);
    context.lineTo(x + 5, y);
    context.moveTo(x, y - 5);
    context.lineTo(x, y + 5);
    context.stroke();
  }

  context.restore();
}

function drawChamferFrame(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  chamfer: number,
) {
  context.beginPath();
  context.moveTo(x + chamfer, y);
  context.lineTo(x + width - chamfer, y);
  context.lineTo(x + width, y + chamfer);
  context.lineTo(x + width, y + height - chamfer);
  context.lineTo(x + width - chamfer, y + height);
  context.lineTo(x + chamfer, y + height);
  context.lineTo(x, y + height - chamfer);
  context.lineTo(x, y + chamfer);
  context.closePath();
}

function drawHexWarning(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  label: string,
) {
  context.beginPath();
  for (let point = 0; point < 6; point += 1) {
    const angle = -Math.PI / 2 + point * (Math.PI / 3);
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius;
    if (point === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.stroke();
  context.fillText(label, centerX - radius * 0.74, centerY);
}

function drawTrapPulse(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame,
  renderState: VisualizerRenderState,
  palette: ReturnType<typeof getPalette>,
) {
  const centerX = width / 2;
  const centerY = height / 2;
  const bassAccent = Math.pow(frame.bassPulse ?? 0, 1.7);
  const lyricFlow = Math.min(1, frame.mids * 0.72 + frame.treble * 0.28);
  const halfCount = 30;
  const vocalBands = selectCenterOutBands(frame.vocalBins?.length ? frame.vocalBins : frame.frequencyBins, halfCount);
  const totalBars = halfCount * 2;
  const smoothedBars = renderState.smoothedBars;
  const peakBars = renderState.peakBars;
  while (smoothedBars.length < totalBars) smoothedBars.push(0);
  while (peakBars.length < totalBars) peakBars.push(0);
  smoothedBars.length = totalBars;
  peakBars.length = totalBars;

  const flowGlow = Math.pow(lyricFlow, 0.85);

  drawLyricRibbons(context, width, height, vocalBands, frame, renderState, palette, lyricFlow);
  drawBassBed(context, width, height, frame, palette);
  drawDrumSparks(context, width, height, frame, renderState.phase, palette);

  renderState.vocalWave.length = Math.max(renderState.vocalWave.length, 96);
  context.save();
  context.translate(centerX, centerY);
  context.translate(-centerX, -centerY);

  for (let ring = 0; ring < 4; ring += 1) {
    const points = 144;
    const baseRadius = Math.min(width, height) * (0.16 + ring * 0.044 + flowGlow * 0.028);
    context.beginPath();
    for (let point = 0; point <= points; point += 1) {
      const t = point / points;
      const sourcePosition = t * (vocalBands.length - 1);
      const sourceIndex = Math.floor(sourcePosition);
      const sourceMix = sourcePosition - sourceIndex;
      const target = lerp(vocalBands[sourceIndex] ?? 0, vocalBands[sourceIndex + 1] ?? vocalBands[sourceIndex] ?? 0, sourceMix);
      const waveIndex = point % 96;
      const current = renderState.vocalWave[waveIndex] ?? 0;
      const wave = current + (target - current) * (target > current ? 0.09 : 0.035);
      renderState.vocalWave[waveIndex] = wave;
      const angle = -Math.PI / 2 + t * Math.PI * 2;
      const drift = Math.sin(renderState.phase * (1.2 + ring * 0.16) + point * 0.12 + ring) * lyricFlow * 8;
      const fineRipple = Math.sin(renderState.phase * 2.1 + point * 0.28 + ring) * frame.treble * 4.5;
      const radius = baseRadius + wave * Math.min(width, height) * 0.16 + drift + fineRipple;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      if (point === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.globalAlpha = 0.38 - ring * 0.055;
    context.strokeStyle = ring === 0 ? palette.iidxCyan : ring === 1 ? palette.hot : palette.iidxViolet;
    context.lineWidth = 1.2 + lyricFlow * 1.1 + bassAccent * 0.65;
    context.shadowColor = context.strokeStyle;
    context.shadowBlur = 12 + flowGlow * 16 + bassAccent * 4;
    context.stroke();
  }

  context.globalAlpha = 1;
  context.shadowBlur = 0;
  const contentWidth = width * 0.86;
  const floorY = height - 20;
  const barGap = 3;
  const centerGap = 8;
  const barWidth = Math.max(3, (contentWidth - centerGap - (totalBars - 2) * barGap) / totalBars);
  const maxHeight = height * 0.38;

  for (let side = -1; side <= 1; side += 2) {
    for (let distance = 0; distance < halfCount; distance += 1) {
      const centerWeight = Math.max(0, 1 - distance / halfCount);
      const vocal = vocalBands[distance] ?? 0;
      const phraseLift = Math.sin(renderState.phase * 1.45 + distance * 0.34) * 0.07 * lyricFlow;
      const centerKick = bassAccent * Math.pow(centerWeight, 4.0) * 0.16;
      const rhythm = Math.min(1, Math.max(0, vocal * 1.08 + phraseLift + centerKick));
      const index = side < 0 ? halfCount - 1 - distance : halfCount + distance;
      const current = smoothedBars[index] ?? 0;
      const smoothed = current + (rhythm - current) * (rhythm > current ? 0.32 : 0.055);
      smoothedBars[index] = smoothed;
      peakBars[index] = Math.max(smoothed, (peakBars[index] ?? 0) - 0.01);

      const xOffset = centerGap / 2 + distance * (barWidth + barGap);
      const x = side < 0 ? centerX - xOffset - barWidth : centerX + xOffset;
      const barHeight = Math.max(2, smoothed * maxHeight * (1.15 - centerWeight * 0.12));
      const y = floorY - barHeight;
      const color = distance < 5 && bassAccent > 0.45
        ? palette.hot
        : distance < 16
          ? palette.iidxCyan
          : palette.iidxViolet;
      const gradient = context.createLinearGradient(0, floorY, 0, y);
      gradient.addColorStop(0, alphaColor(color, 0.2));
      gradient.addColorStop(0.62, color);
      gradient.addColorStop(1, palette.peak);
      context.shadowColor = color;
      context.shadowBlur = 8 + smoothed * 16;
      context.fillStyle = gradient;
      context.fillRect(x, y, barWidth, barHeight);
      context.shadowBlur = 0;
      context.fillStyle = alphaColor(palette.peak, 0.85);
      context.fillRect(x, floorY - peakBars[index] * maxHeight - 4, barWidth, 2);
    }
  }

  context.restore();
  context.fillStyle = alphaColor(palette.peak, 0.46 + bassAccent * 0.34);
  context.beginPath();
  context.arc(centerX, centerY, 4 + bassAccent * 6 + lyricFlow * 2, 0, Math.PI * 2);
  context.fill();
}

function drawLyricRibbons(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  vocalBands: number[],
  frame: VisualizerFrame,
  renderState: VisualizerRenderState,
  palette: ReturnType<typeof getPalette>,
  lyricFlow: number,
) {
  const centerY = height * 0.46;
  const colors = [palette.iidxCyan, palette.hot, palette.iidxViolet];
  context.globalCompositeOperation = "lighter";

  for (let ribbon = 0; ribbon < 3; ribbon += 1) {
    context.beginPath();
    for (let step = 0; step <= 120; step += 1) {
      const t = step / 120;
      const sourcePosition = t * (vocalBands.length - 1);
      const sourceIndex = Math.floor(sourcePosition);
      const vocal = lerp(vocalBands[sourceIndex] ?? 0, vocalBands[sourceIndex + 1] ?? vocalBands[sourceIndex] ?? 0, sourcePosition - sourceIndex);
      const x = t * width;
      const phrase = Math.sin(renderState.phase * (1.05 + ribbon * 0.12) + t * Math.PI * 5.5 + ribbon * 1.4);
      const melody = Math.sin(renderState.phase * 0.62 + t * Math.PI * 2 + ribbon) * height * 0.035;
      const y = centerY
        + (ribbon - 1) * height * 0.06
        + phrase * (height * 0.035 + vocal * height * 0.12)
        + melody;
      if (step === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = alphaColor(colors[ribbon], 0.22 + lyricFlow * 0.34);
    context.lineWidth = 1.1 + lyricFlow * 2.4 + frame.treble * 0.7;
    context.shadowColor = colors[ribbon];
    context.shadowBlur = 12 + lyricFlow * 18;
    context.stroke();
  }

  context.shadowBlur = 0;
  context.globalCompositeOperation = "source-over";
}

function drawBassBed(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame,
  palette: ReturnType<typeof getPalette>,
) {
  const bass = Math.min(1, frame.bass * 1.08);
  const floor = height * 0.83;
  const amplitude = height * (0.035 + bass * 0.09);
  const gradient = context.createLinearGradient(0, floor - amplitude * 1.7, 0, height);
  gradient.addColorStop(0, alphaColor(palette.hot, 0.02 + bass * 0.12));
  gradient.addColorStop(0.55, alphaColor(palette.iidxBlue, 0.14 + bass * 0.2));
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.beginPath();
  context.moveTo(0, height);
  for (let step = 0; step <= 96; step += 1) {
    const t = step / 96;
    const wave = Math.sin(t * Math.PI * 4 + bass * 2.1) * amplitude * 0.32;
    const y = floor - amplitude - wave;
    context.lineTo(t * width, y);
  }
  context.lineTo(width, height);
  context.closePath();
  context.fill();
}

function drawDrumSparks(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame,
  phase: number,
  palette: ReturnType<typeof getPalette>,
) {
  const kick = Math.pow(frame.bassPulse ?? 0, 1.8);
  const hats = Math.pow(frame.treble, 1.15);
  const count = Math.round(5 + hats * 18 + kick * 8);
  context.globalCompositeOperation = "lighter";

  for (let index = 0; index < count; index += 1) {
    const seed = index * 12.989 + Math.floor(phase * 2.2) * 78.233;
    const x = width * fract(Math.sin(seed) * 43758.5453);
    const y = height * (0.18 + fract(Math.sin(seed + 4.7) * 19341.17) * 0.58);
    const radius = 1.2 + hats * 3.4 + (index % 3 === 0 ? kick * 3.8 : 0);
    context.fillStyle = alphaColor(index % 3 === 0 ? palette.hot : palette.peak, 0.16 + hats * 0.36 + kick * 0.18);
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  context.globalCompositeOperation = "source-over";
}

function drawPlasmaStorm(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame,
  palette: ReturnType<typeof getPalette>,
  phase: number,
) {
  context.globalCompositeOperation = "lighter";
  const sourceBands = frame.vocalBins?.length ? frame.vocalBins : frame.frequencyBins;
  const flowBands = selectCenterOutBands(sourceBands, 36);
  const bassAccent = Math.pow(frame.bassPulse ?? frame.bass, 1.7);
  const lyricFlow = Math.min(1, frame.mids * 0.72 + frame.treble * 0.28);
  const lobes = 8;
  for (let index = 0; index < lobes; index += 1) {
    const t = index / lobes;
    const vocal = flowBands[Math.min(flowBands.length - 1, Math.floor(t * flowBands.length))] ?? 0;
    const x = width * (0.5 + Math.cos(phase * 0.72 + index * 1.7) * (0.14 + vocal * 0.18));
    const y = height * (0.5 + Math.sin(phase * 0.58 + index * 1.31) * (0.16 + lyricFlow * 0.16));
    const radius = Math.min(width, height) * (0.1 + vocal * 0.16 + bassAccent * 0.06 + t * 0.018);
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, index % 3 === 0 ? palette.hot : index % 3 === 1 ? palette.iidxCyan : palette.iidxViolet);
    gradient.addColorStop(0.28, alphaColor(palette.peak, 0.08 + vocal * 0.08));
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.globalAlpha = 0.18 + lyricFlow * 0.1;
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  for (let ribbon = 0; ribbon < 4; ribbon += 1) {
    const color = ribbon % 2 === 0 ? palette.iidxCyan : palette.hot;
    context.strokeStyle = alphaColor(color, 0.3 + lyricFlow * 0.24);
    context.shadowColor = color;
    context.shadowBlur = 14 + lyricFlow * 16;
    context.lineWidth = 1.2 + lyricFlow * 1.8;
    context.beginPath();
    for (let step = 0; step <= 112; step += 1) {
      const t = step / 112;
      const sourceIndex = Math.min(flowBands.length - 1, Math.floor(t * flowBands.length));
      const vocal = flowBands[sourceIndex] ?? 0;
      const x = t * width;
      const y = height * (0.34 + ribbon * 0.095)
        + Math.sin(phase * (0.9 + ribbon * 0.08) + t * Math.PI * 5.4 + ribbon) * (height * 0.035 + vocal * height * 0.13)
        + Math.cos(phase * 0.6 + t * Math.PI * 2) * bassAccent * height * 0.025;
      if (step === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  }

  context.shadowBlur = 0;
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
}

function drawSpectrumRing(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  bins: number[],
  smoothedBars: number[],
  peakBars: number[],
  frame: VisualizerFrame,
  palette: ReturnType<typeof getPalette>,
  phase: number,
) {
  const centerX = width / 2;
  const centerY = height / 2;
  const bassAccent = Math.pow(frame.bassPulse ?? 0, 1.8);
  const lyricFlow = Math.min(1, frame.mids * 0.72 + frame.treble * 0.28);
  const radius = Math.min(width, height) * (0.2 + bassAccent * 0.018);

  context.lineWidth = 6 + bassAccent * 3;
  context.strokeStyle = alphaColor(palette.peak, 0.72);
  context.shadowColor = palette.iidxCyan;
  context.shadowBlur = 12 + lyricFlow * 12;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.stroke();
  context.shadowBlur = 0;

  bins.forEach((target, index) => {
    const current = smoothedBars[index] ?? 0;
    const hatTick = index % 4 === 0 ? frame.treble * 0.08 : 0;
    const shapedTarget = Math.min(0.92, target * 1.08 + hatTick);
    const smoothed = current + (shapedTarget - current) * (shapedTarget > current ? 0.18 : 0.045);
    smoothedBars[index] = smoothed;
    peakBars[index] = Math.max(smoothed, (peakBars[index] ?? 0) - 0.008);
    const angle = phase * 0.18 - Math.PI / 2 + (index / bins.length) * Math.PI * 2;
    const inner = radius + 8 + bassAccent * 5;
    const outer = inner + smoothed * Math.min(width, height) * 0.24;
    context.strokeStyle = getBarColor(palette, "radial", smoothed, index, bins.length);
    context.lineWidth = 3.5 + smoothed * 2.2;
    context.shadowColor = context.strokeStyle;
    context.shadowBlur = 7 + smoothed * 11;
    context.beginPath();
    context.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner);
    context.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer);
    context.stroke();
  });
  context.shadowBlur = 0;
}

function drawWaveform(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame,
  renderState: VisualizerRenderState,
  _palette: ReturnType<typeof getPalette>,
  _phase: number,
) {
  const waveformMotion = getWaveformMotion(frame);
  const { bassAccent, riffEnergy, vocalFlow, rhythmPunch, riffFocus, vocalFocus, songFlow } = waveformMotion;
  const bins = selectCenterOutBands(frame.frequencyBins, 96);
  const centerY = height / 2;

  const barCount = 74;
  renderState.scopeWave.length = Math.max(renderState.scopeWave.length, barCount);
  const contentWidth = width * 0.76;
  const startX = (width - contentWidth) / 2;
  const barGap = Math.max(4, contentWidth / barCount * 0.42);
  const barWidth = Math.max(3, (contentWidth - barGap * (barCount - 1)) / barCount);
  const maxBarHeight = height * 0.24;

  const rawTargets = Array.from({ length: barCount }, (_, index) => {
    const t = index / Math.max(1, barCount - 1);
    const sampleIndex = Math.round(t * Math.max(0, frame.waveform.length - 1));
    const raw = Math.abs(smoothedWaveSample(frame.waveform, sampleIndex, 1));
    const previousRaw = Math.abs(smoothedWaveSample(frame.waveform, Math.max(0, sampleIndex - 3), 1));
    const nextRaw = Math.abs(smoothedWaveSample(frame.waveform, Math.min(frame.waveform.length - 1, sampleIndex + 3), 1));
    const transient = Math.min(1, Math.abs(nextRaw - previousRaw) * 2.6);
    const band = bins[Math.min(bins.length - 1, Math.floor(t * bins.length))] ?? 0;
    const edgeShape = Math.pow(Math.abs(t - 0.5) * 2, 1.15);
    const sideLift = t < 0.18 ? (0.18 - t) * 2.2 * (frame.bass + bassAccent) : t > 0.68 ? (t - 0.68) * 1.25 * (frame.mids + frame.treble) : 0;
    const midFocus = Math.max(0, 1 - Math.abs(t - 0.58) / 0.36);
    const riffComb = index % 3 === 0 ? 0.12 : index % 3 === 1 ? 0.04 : 0;
    const riffLift = riffEnergy * midFocus * (0.22 + riffComb) + transient * riffFocus * 0.24;
    const vocalLift = vocalFlow * Math.max(0, 1 - Math.abs(t - 0.5) / 0.5) * 0.11;
    return Math.max(
      0,
      raw * (1.25 + riffFocus * 0.22)
        + band * (0.2 + riffFocus * 0.12)
        + transient * (0.18 + rhythmPunch * 0.14)
        + sideLift * 0.08
        + edgeShape * 0.018
        + riffLift * 0.62
        + vocalLift * 0.54,
    );
  });
  const framePeak = Math.max(0.04, ...rawTargets);
  const frameFloor = percentile(rawTargets, 0.18);
  renderState.scopeCeiling += (framePeak - renderState.scopeCeiling) * (framePeak > renderState.scopeCeiling ? 0.2 : 0.035);
  renderState.scopeFloor += (frameFloor - renderState.scopeFloor) * 0.08;
  const adaptiveFloor = Math.min(renderState.scopeFloor * 0.82, renderState.scopeCeiling * 0.42);
  const adaptiveRange = Math.max(0.08, renderState.scopeCeiling - adaptiveFloor);

  context.shadowBlur = 10 + songFlow * 8;
  for (let index = 0; index < barCount; index += 1) {
    const t = index / Math.max(1, barCount - 1);
    const midFocus = Math.max(0, 1 - Math.abs(t - 0.58) / 0.36);
    const normalized = Math.min(1, Math.max(0, (rawTargets[index] - adaptiveFloor) / adaptiveRange));
    const target = Math.pow(normalized, 1.28 - riffFocus * 0.18) * (0.84 + rhythmPunch * 0.12);
    const current = renderState.scopeWave[index] ?? 0;
    const attack = target > current ? 0.48 + riffFocus * 0.22 + rhythmPunch * 0.08 : 0.16 + vocalFocus * 0.05;
    const value = current + (target - current) * attack;
    renderState.scopeWave[index] = value;

    const x = startX + index * (barWidth + barGap);
    const barHeight = Math.max(3, value * maxBarHeight);
    const riffColor = lerpColor("#ffe36e", "#ff5a3f", Math.min(1, riffFocus * midFocus));
    const baseHue = lerpColor("#19ffd5", "#ff3fb7", t);
    const hue = lerpColor(baseHue, riffColor, riffFocus * midFocus * 0.42);
    const glow = riffFocus * midFocus > 0.45 ? "#ffd45f" : t < 0.5 ? "#00ffd0" : "#ff4abf";
    const capGlow = alphaColor(riffFocus * midFocus > 0.42 ? "#fff0a8" : "#fff3c4", 0.22 + value * 0.32 + rhythmPunch * 0.08);

    context.shadowColor = glow;
    context.fillStyle = hue;
    context.beginPath();
    context.roundRect(x, centerY - barHeight, barWidth, barHeight * 2, Math.min(barWidth / 2, 5));
    context.fill();

    context.globalAlpha = 0.6 + value * 0.35;
    context.fillStyle = capGlow;
    context.fillRect(x + barWidth * 0.12, centerY - barHeight, barWidth * 0.76, Math.min(3, barHeight));
    context.fillRect(x + barWidth * 0.12, centerY + barHeight - Math.min(3, barHeight), barWidth * 0.76, Math.min(3, barHeight));
    context.globalAlpha = 1;
  }
  context.shadowBlur = 0;

  context.strokeStyle = alphaColor("#fff0a8", 0.07 + songFlow * 0.07);
  context.lineWidth = 1;
  for (let band = -1; band <= 1; band += 2) {
    const y = centerY + band * height * 0.008;
    context.beginPath();
    context.moveTo(startX, y);
    context.lineTo(startX + contentWidth, y);
    context.stroke();
  }
}

function drawCenterStereo(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  bins: number[],
  frame: VisualizerFrame,
  smoothedBars: number[],
  peakBars: number[],
  palette: ReturnType<typeof getPalette>,
) {
  const centerX = width / 2;
  const floorY = height - 16;
  const maxHeight = height * 0.74;
  const half = bins.length;
  const gap = 5;
  const sideWidth = width * 0.43;
  const laneWidth = Math.max(6, Math.min(13, (sideWidth - half * gap) / half));

  const bassAccent = Math.pow(frame.bassPulse ?? 0, 1.7);
  const beam = context.createLinearGradient(centerX - 12, 0, centerX + 12, 0);
  beam.addColorStop(0, "rgba(0,0,0,0)");
  beam.addColorStop(0.5, alphaColor(palette.peak, 0.2 + bassAccent * 0.26));
  beam.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = beam;
  context.fillRect(centerX - 14, 14, 28, height - 28);
  context.fillStyle = alphaColor(palette.gridStrong, 0.45);
  context.fillRect(centerX - 1, 14, 2, height - 28);

  for (let distance = 0; distance < half; distance += 1) {
    const centerWeight = Math.max(0, 1 - distance / Math.max(1, half - 1));
    const target = Math.min(0.98, (bins[distance] ?? 0) * (1.1 - distance * 0.01) + bassAccent * centerWeight * 0.16);
    const current = smoothedBars[distance] ?? 0;
    const smoothed = current + (target - current) * (target > current ? 0.24 : 0.075);
    smoothedBars[distance] = smoothed;
    peakBars[distance] = Math.max(smoothed, (peakBars[distance] ?? 0) - 0.012);

    const barHeight = smoothed * maxHeight;
    const leftX = centerX - (distance + 1) * (laneWidth + gap);
    const rightX = centerX + distance * (laneWidth + gap) + gap;
    const y = floorY - barHeight;
    const color = getBarColor(palette, "centerStereo", smoothed, distance, half);
    context.shadowColor = color;
    context.shadowBlur = 6 + smoothed * 10;
    context.fillStyle = color;
    context.fillRect(leftX, y, laneWidth, barHeight * (0.85 + frame.leftLevel * 0.35));
    context.fillRect(rightX, y, laneWidth, barHeight * (0.85 + frame.rightLevel * 0.35));
    context.shadowBlur = 0;
    context.fillStyle = palette.peak;
    const peakY = floorY - peakBars[distance] * maxHeight - 3;
    context.fillRect(leftX, peakY, laneWidth, 2);
    context.fillRect(rightX, peakY, laneWidth, 2);
  }
}

function drawRadialDeck(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  bins: number[],
  smoothedBars: number[],
  peakBars: number[],
  frame: VisualizerFrame,
  palette: ReturnType<typeof getPalette>,
  phase: number,
) {
  const centerX = width / 2;
  const centerY = height / 2;
  const bassAccent = Math.pow(frame.bassPulse ?? 0, 1.75);
  const radius = Math.min(width, height) * (0.16 + bassAccent * 0.02);
  context.strokeStyle = alphaColor(palette.gridStrong, 0.55);
  context.lineWidth = 1;
  for (let ring = 0; ring < 4; ring += 1) {
    context.beginPath();
    context.arc(centerX, centerY, radius + ring * Math.min(width, height) * 0.06, phase * 0.12, Math.PI * 2 + phase * 0.12);
    context.stroke();
  }

  bins.forEach((target, index) => {
    const current = smoothedBars[index] ?? 0;
    const shapedTarget = Math.min(0.96, target * 1.08 + (index % 5 === 0 ? frame.treble * 0.06 : 0));
    const smoothed = current + (shapedTarget - current) * (shapedTarget > current ? 0.24 : 0.075);
    smoothedBars[index] = smoothed;
    peakBars[index] = Math.max(smoothed, (peakBars[index] ?? 0) - 0.012);
    const angle = phase * 0.08 - Math.PI / 2 + (index / bins.length) * Math.PI * 2;
    const inner = radius;
    const outer = radius + smoothed * Math.min(width, height) * 0.34;
    context.strokeStyle = getBarColor(palette, "radial", smoothed, index, bins.length);
    context.lineWidth = 2.6 + smoothed * 2.4;
    context.shadowColor = context.strokeStyle;
    context.shadowBlur = 6 + smoothed * 10;
    context.beginPath();
    context.moveTo(centerX + Math.cos(angle) * inner, centerY + Math.sin(angle) * inner);
    context.lineTo(centerX + Math.cos(angle) * outer, centerY + Math.sin(angle) * outer);
    context.stroke();
  });
  context.shadowBlur = 0;
}

function getWaveformMotion(frame: VisualizerFrame) {
  const bassAccent = Math.pow(frame.bassPulse ?? 0, 1.25);
  const orderedBins = trimVisualizerBins(frame.frequencyBins);
  const riffBand = averageRange(orderedBins, 0.34, 0.76);
  const riffPeak = averageRange(frame.peaks, 0.34, 0.76);
  const vocalBand = averageRange(frame.vocalBins?.length ? frame.vocalBins : orderedBins, 0.22, 0.72);
  const waveformDelta = averageWaveformDelta(frame.waveform);
  const riffEnergy = Math.min(1, riffBand * 0.82 + riffPeak * 0.44 + waveformDelta * 0.5 + frame.treble * 0.16);
  const vocalFlow = Math.min(1, vocalBand * 0.82 + frame.mids * 0.48 - waveformDelta * 0.16);
  const rhythmPunch = Math.min(1, bassAccent * 0.52 + waveformDelta * 0.68 + riffPeak * 0.24);
  const riffFocus = riffEnergy / Math.max(0.001, riffEnergy + vocalFlow);
  const vocalFocus = 1 - riffFocus;
  const songFlow = Math.min(1, frame.bass * 0.26 + frame.mids * 0.28 + frame.treble * 0.22 + bassAccent * 0.16 + riffEnergy * 0.32);
  return { bassAccent, riffEnergy, vocalFlow, rhythmPunch, riffFocus, vocalFocus, songFlow };
}

function getVisualizerBandCount(mode: VisualizerMode) {
  if (mode === "windowsScope") return 22;
  if (mode === "centerStereo") return 20;
  if (mode === "classicBars") return 22;
  return 28;
}

function selectVisualizerBands(source: number[], bandCount: number, mode: VisualizerMode) {
  const useful = trimVisualizerBins(source);
  if (mode === "classicBars" || mode === "windowsScope") {
    return selectMirroredCenterBands(useful, bandCount);
  }
  if (mode === "centerStereo") {
    return selectCenterOutBands(useful, bandCount);
  }
  return downsampleBands(useful, bandCount);
}

function trimVisualizerBins(source: number[]) {
  if (source.length === 0) return [];
  const start = Math.min(4, Math.max(0, source.length - 1));
  const end = Math.max(start + 1, Math.floor(source.length * 0.82));
  return source.slice(start, end);
}

function downsampleBands(source: number[], bandCount: number) {
  if (source.length === 0) return Array.from({ length: bandCount }, () => 0);
  if (source.length === bandCount) return source.slice();

  const bands = [];
  for (let band = 0; band < bandCount; band += 1) {
    const start = Math.floor((band / bandCount) * source.length);
    const end = Math.max(start + 1, Math.floor(((band + 1) / bandCount) * source.length));
    let sum = 0;
    let count = 0;
    for (let index = start; index < Math.min(end, source.length); index += 1) {
      sum += source[index] ?? 0;
      count += 1;
    }
    bands.push(sum / Math.max(1, count));
  }
  return bands;
}

function selectCenterOutBands(source: number[], bandCount: number) {
  if (source.length === 0) return Array.from({ length: bandCount }, () => 0);
  const lowMidIndex = Math.floor(source.length * 0.16);
  const highIndex = Math.max(lowMidIndex, source.length - 1);

  return Array.from({ length: bandCount }, (_, index) => {
    const distance = index / Math.max(1, bandCount - 1);
    const curved = Math.pow(distance, 1.42);
    const sourceIndex = Math.min(
      highIndex,
      Math.round(lowMidIndex + curved * (highIndex - lowMidIndex)),
    );
    const centerWeight = 1.14 - distance * 0.3;
    return Math.min(1, (source[sourceIndex] ?? 0) * centerWeight);
  });
}

function selectMirroredCenterBands(source: number[], bandCount: number) {
  if (source.length === 0) return Array.from({ length: bandCount }, () => 0);
  const centerOut = selectCenterOutBands(source, Math.ceil(bandCount / 2));
  const center = (bandCount - 1) / 2;

  return Array.from({ length: bandCount }, (_, index) => {
    const distance = Math.abs(index - center);
    const centerOutIndex = Math.min(centerOut.length - 1, Math.floor(distance));
    const edgeDistance = distance / Math.max(1, center);
    const edgeShelf = 0.82 + (1 - edgeDistance) * 0.22;
    return Math.min(1, (centerOut[centerOutIndex] ?? 0) * edgeShelf);
  });
}

function selectWaveformEnvelopeBands(source: number[], bandCount: number, mode: VisualizerMode) {
  if (source.length === 0) return Array.from({ length: bandCount }, () => 0);
  const samplesPerBand = Math.max(1, Math.floor(source.length / bandCount));
  const rawBands = Array.from({ length: bandCount }, (_, band) => {
    const start = Math.floor((band / bandCount) * source.length);
    const end = Math.min(source.length, Math.max(start + 1, start + samplesPerBand));
    let peak = 0;
    let total = 0;
    for (let index = start; index < end; index += 1) {
      const sample = Math.abs(source[index] ?? 0);
      peak = Math.max(peak, sample);
      total += sample;
    }
    const average = total / Math.max(1, end - start);
    return Math.min(1, peak * 1.28 + average * 1.1);
  });

  if (mode === "classicBars" || mode === "windowsScope") {
    return selectMirroredCenterBands(rawBands, bandCount);
  }
  return rawBands;
}

function averageRange(source: number[], startRatio: number, endRatio: number) {
  if (source.length === 0) return 0;
  const start = Math.max(0, Math.min(source.length - 1, Math.floor(source.length * startRatio)));
  const end = Math.max(start + 1, Math.min(source.length, Math.ceil(source.length * endRatio)));
  let total = 0;
  for (let index = start; index < end; index += 1) {
    total += source[index] ?? 0;
  }
  return total / Math.max(1, end - start);
}

function percentile(source: number[], ratio: number) {
  if (source.length === 0) return 0;
  const sorted = source.slice().sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)));
  return sorted[index] ?? 0;
}

function averageWaveformDelta(samples: number[]) {
  if (samples.length < 2) return 0;
  let total = 0;
  for (let index = 1; index < samples.length; index += 1) {
    total += Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0));
  }
  return Math.min(1, (total / (samples.length - 1)) * 9);
}

function getBarColor(
  palette: ReturnType<typeof getPalette>,
  mode: VisualizerMode,
  heat: number,
  index: number,
  bandCount: number,
) {
  if (mode === "windowsScope") {
    return heat > 0.72 ? palette.windowsHot : heat > 0.45 ? palette.windowsMid : palette.windowsLow;
  }
  if (mode === "radial") {
    const sweep = index / Math.max(1, bandCount - 1);
    if (heat > 0.72) return palette.iidxHot;
    return sweep > 0.68 ? palette.iidxBlue : sweep > 0.34 ? palette.iidxCyan : palette.iidxViolet;
  }
  if (mode === "centerStereo") {
    return heat > 0.72 ? palette.hot : heat > 0.45 ? palette.mid : palette.low;
  }
  return heat > 0.72 ? palette.hot : heat > 0.45 ? palette.mid : palette.low;
}

function alphaColor(hex: string, alpha: number) {
  const value = hex.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16);
  const green = Number.parseInt(value.slice(2, 4), 16);
  const blue = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${Math.min(1, Math.max(0, alpha))})`;
}

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
}

function createEmptyVisualizerFrame(): VisualizerFrame {
  return {
    timestamp: 0,
    volume: 0,
    bassPulse: 0,
    bass: 0,
    mids: 0,
    treble: 0,
    leftLevel: 0,
    rightLevel: 0,
    frequencyBins: [],
    vocalBins: [],
    waveform: [],
    peaks: [],
  };
}

function interpolateFrameInto(
  target: VisualizerFrame,
  prev: VisualizerFrame,
  next: VisualizerFrame,
  t: number,
): VisualizerFrame {
  const ease = Math.min(1, Math.max(0, t));
  target.timestamp = lerp(prev.timestamp, next.timestamp, ease);
  target.volume = lerp(prev.volume, next.volume, ease);
  target.bassPulse = lerp(prev.bassPulse, next.bassPulse, ease);
  target.bass = lerp(prev.bass, next.bass, ease);
  target.mids = lerp(prev.mids, next.mids, ease);
  target.treble = lerp(prev.treble, next.treble, ease);
  target.leftLevel = lerp(prev.leftLevel, next.leftLevel, ease);
  target.rightLevel = lerp(prev.rightLevel, next.rightLevel, ease);
  interpolateArrayInto(target.frequencyBins, prev.frequencyBins, next.frequencyBins, ease);
  interpolateArrayInto(target.vocalBins, prev.vocalBins, next.vocalBins, ease);
  interpolateArrayInto(target.waveform, prev.waveform, next.waveform, ease);
  interpolateArrayInto(target.peaks, prev.peaks, next.peaks, ease);
  return target;
}

function interpolateArrayInto(target: number[], prev: number[], next: number[], ease: number) {
  target.length = prev.length;
  for (let index = 0; index < prev.length; index += 1) {
    const value = prev[index];
    target[index] = lerp(value, next[index] ?? value, ease);
  }
}

function lerpColor(fromHex: string, toHex: string, amount: number) {
  const amountBounded = Math.min(1, Math.max(0, amount));
  const fromRed = Number.parseInt(fromHex.slice(1, 3), 16);
  const fromGreen = Number.parseInt(fromHex.slice(3, 5), 16);
  const fromBlue = Number.parseInt(fromHex.slice(5, 7), 16);
  const toRed = Number.parseInt(toHex.slice(1, 3), 16);
  const toGreen = Number.parseInt(toHex.slice(3, 5), 16);
  const toBlue = Number.parseInt(toHex.slice(5, 7), 16);
  const red = Math.round(lerp(fromRed, toRed, amountBounded));
  const green = Math.round(lerp(fromGreen, toGreen, amountBounded));
  const blue = Math.round(lerp(fromBlue, toBlue, amountBounded));

  return `rgb(${red}, ${green}, ${blue})`;
}

function fract(value: number) {
  return value - Math.floor(value);
}

function smoothedWaveSample(samples: number[], centerIndex: number, radius: number) {
  if (samples.length === 0) return 0;
  let total = 0;
  let weightTotal = 0;
  for (let offset = -radius; offset <= radius; offset += 1) {
    const index = Math.min(samples.length - 1, Math.max(0, centerIndex + offset));
    const weight = radius + 1 - Math.abs(offset);
    total += samples[index] * weight;
    weightTotal += weight;
  }
  return total / Math.max(1, weightTotal);
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="meter">
      <span>{label}</span>
      <div>
        <i style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );
}

const SongTable = memo(function SongTable({
  songs,
  selectedSongId,
  playingSongId,
  pendingSongId,
  onSelect,
  onPreload,
  onPlay,
}: {
  songs: Song[];
  selectedSongId?: string | null;
  playingSongId?: string | null;
  pendingSongId?: string | null;
  onSelect: (songId: string) => void;
  onPreload: (songId: string) => void;
  onPlay: (song: Song) => void;
}) {
  if (songs.length === 0) {
    return <div className="empty-library">No matching tracks.</div>;
  }

  return (
    <div className="song-table">
      {songs.map((song, index) => {
        const isSelected = song.id === selectedSongId;
        const isPlaying = song.id === playingSongId;
        const isPending = song.id === pendingSongId;

        return (
          <button
            key={song.id}
            className={clsx(
              "song-row",
              isSelected && "selected",
              isPlaying && "playing",
              isPending && "pending",
            )}
            type="button"
            onClick={() => onSelect(song.id)}
            onPointerEnter={() => onPreload(song.id)}
            onFocus={() => onPreload(song.id)}
            onDoubleClick={() => {
              if (!isPending) onPlay(song);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (!isPending) onPlay(song);
              }
            }}
          >
            <span className="row-index">
              {isPending ? "..." : isPlaying ? ">" : String(index + 1).padStart(2, "0")}
            </span>
            <span className="song-main">
              <strong>{song.title ?? song.fileName}</strong>
              <em>{song.artist ?? "Unknown Artist"}</em>
            </span>
            <small>{isPending ? "Loading" : formatTime(song.durationSeconds ?? 0)}</small>
          </button>
        );
      })}
    </div>
  );
});

function SettingsModal({
  visualizerMode,
  theme,
  onModeChange,
  onThemeChange,
  onClose,
}: {
  visualizerMode: VisualizerMode;
  theme: AppTheme;
  onModeChange: (mode: VisualizerMode) => void;
  onThemeChange: (theme: AppTheme) => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section className="settings-modal" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <header>
          <strong>Settings</strong>
          <button className="icon-button" type="button" onClick={onClose}>
            x
          </button>
        </header>
        <div className="settings-group">
          <span>Visualizer</span>
          <div className="segmented">
            {visualizers.map((item) => (
              <button
                key={item.id}
                className={clsx(item.id === visualizerMode && "selected")}
                type="button"
                onClick={() => onModeChange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-group">
          <span>Theme</span>
          <div className="segmented">
            {themes.map((item) => (
              <button
                key={item.id}
                className={clsx(item.id === theme && "selected")}
                type="button"
                onClick={() => onThemeChange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function createMetadataDraft(song?: Song): MetadataDraft {
  return {
    title: song?.title ?? "",
    artist: song?.artist ?? "",
    genre: song?.genre ?? "",
    year: song?.year ? String(song.year) : "",
    coverArtPath: song?.coverArtPath ?? null,
  };
}

function textOrNull(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberOrNull(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPalette(theme: AppTheme) {
  if (theme === "lapis") {
    return {
      panel: "#06111d",
      grid: "rgba(76, 177, 255, 0.12)",
      muted: "#80b4d8",
      low: "#2779d8",
      mid: "#66d6ff",
      hot: "#c7f3ff",
      peak: "#fff4c2",
      gridStrong: "rgba(138, 202, 245, 0.22)",
      windowsLow: "#2ec7ff",
      windowsMid: "#d9f4ff",
      windowsHot: "#ffb84a",
      iidxViolet: "#3a5fff",
      iidxCyan: "#64e7ff",
      iidxBlue: "#1f75ff",
      iidxHot: "#fff8de",
    };
  }
  if (theme === "amber") {
    return {
      panel: "#120d06",
      grid: "rgba(255, 178, 72, 0.12)",
      muted: "#b77a2b",
      low: "#ef9e31",
      mid: "#ffd15e",
      hot: "#fff1a8",
      peak: "#fff8d5",
      gridStrong: "rgba(255, 178, 72, 0.2)",
      windowsLow: "#1cc957",
      windowsMid: "#f4e84a",
      windowsHot: "#ff5a3f",
      iidxViolet: "#9468ff",
      iidxCyan: "#62ecff",
      iidxBlue: "#3fa2ff",
      iidxHot: "#fff7e8",
    };
  }
  if (theme === "ice") {
    return {
      panel: "#061014",
      grid: "rgba(114, 230, 255, 0.12)",
      muted: "#7ccfe0",
      low: "#43b7d4",
      mid: "#98f3ff",
      hot: "#e9fdff",
      peak: "#ffffff",
      gridStrong: "rgba(114, 230, 255, 0.2)",
      windowsLow: "#2edb7a",
      windowsMid: "#dce95e",
      windowsHot: "#ff5b5b",
      iidxViolet: "#8a6dff",
      iidxCyan: "#72e6ff",
      iidxBlue: "#4ba8ff",
      iidxHot: "#ffffff",
    };
  }
  return {
    panel: "#071008",
    grid: "rgba(71, 255, 117, 0.12)",
    muted: "#6fbf7d",
    low: "#31d653",
    mid: "#c8f24b",
    hot: "#ff774d",
    peak: "#ffe87a",
    gridStrong: "rgba(71, 255, 117, 0.2)",
    windowsLow: "#25d45d",
    windowsMid: "#e7ea4b",
    windowsHot: "#ff5b45",
    iidxViolet: "#8d66ff",
    iidxCyan: "#47f0ff",
    iidxBlue: "#3aa8ff",
    iidxHot: "#fff8de",
  };
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00";
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

export default App;
