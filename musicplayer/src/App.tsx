import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  Pause,
  Play,
  Search,
  Settings,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
  Waves,
} from "lucide-react";
import clsx from "clsx";
import "./App.css";
import { useAppStore } from "./store";
import type {
  AppTheme,
  PlayerStatus,
  Song,
  VisualizerFrame,
  VisualizerMode,
} from "./types";

const themes: Array<{ id: AppTheme; label: string }> = [
  { id: "phosphor", label: "Phosphor" },
  { id: "amber", label: "Amber CRT" },
  { id: "ice", label: "Ice LCD" },
];

const visualizers: Array<{ id: VisualizerMode; label: string }> = [
  { id: "trapNation", label: "Trap Pulse" },
  { id: "wmpRibbons", label: "WMP Ribbons" },
  { id: "plasmaStorm", label: "Plasma Storm" },
  { id: "spectrumRing", label: "Spectrum Ring" },
  { id: "classicBars", label: "Winamp Bars" },
  { id: "centerStereo", label: "Center Stereo" },
  { id: "radial", label: "Radial Deck" },
  { id: "windowsScope", label: "Old Windows" },
  { id: "waveform", label: "Oscilloscope" },
];

const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function App() {
  const {
    songs,
    selectedSongId,
    playerStatus,
    visualizerFrame,
    visualizerMode,
    theme,
    scanError,
    isScanning,
    isLoadingTrack,
    setSongs,
    setSelectedSongId,
    setPlayerStatus,
    setVisualizerFrame,
    setVisualizerMode,
    setTheme,
    setScanError,
    setIsScanning,
    setIsLoadingTrack,
  } = useAppStore();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const preloadQueueRef = useRef<Set<string>>(new Set());

  const selectedSong = useMemo(
    () => songs.find((song) => song.id === (selectedSongId ?? playerStatus.songId)) ?? songs[0],
    [playerStatus.songId, selectedSongId, songs],
  );
  const filteredSongs = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return songs;
    return songs.filter((song) =>
      [song.title, song.artist, song.album, song.fileName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [searchQuery, songs]);

  useEffect(() => {
    if (!isTauriRuntime) {
      setScanError("Run `pnpm tauri dev` to use folder import and playback in the macOS desktop app.");
      return;
    }

    invoke<Song[]>("get_songs")
      .then(setSongs)
      .catch((error) => setScanError(String(error)));

    invoke<PlayerStatus>("get_player_status")
      .then(setPlayerStatus)
      .catch((error) => setScanError(String(error)));

    const unlisten = listen<VisualizerFrame>("visualizer-frame", (event) => {
      setVisualizerFrame(event.payload);
      setPlayerStatus({
        ...useAppStore.getState().playerStatus,
        positionSeconds: event.payload.timestamp,
      });
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [setPlayerStatus, setScanError, setSongs, setVisualizerFrame]);

  useEffect(() => {
    if (!selectedSong) return;
    preloadSong(selectedSong.id);
  }, [selectedSong?.id]);

  useEffect(() => {
    if (songs.length === 0) return;
    preloadSong(songs[0].id);
  }, [songs]);

  async function chooseFolder() {
    if (!isTauriRuntime) {
      setScanError("This screen is running in a browser. Start the desktop app with `pnpm tauri dev`.");
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

  async function play(song: Song | undefined = selectedSong) {
    if (!isTauriRuntime) {
      setScanError("Playback uses the Tauri/Rust backend. Start the desktop app with `pnpm tauri dev`.");
      return;
    }
    if (!song) return;
    setSelectedSongId(song.id);
    setIsLoadingTrack(true);
    setScanError(undefined);
    try {
      const status = await invoke<PlayerStatus>("play_song", { songId: song.id });
      setPlayerStatus(status);
    } catch (error) {
      setScanError(String(error));
    } finally {
      setIsLoadingTrack(false);
    }
  }

  function preloadSong(songId: string) {
    if (!isTauriRuntime || preloadQueueRef.current.has(songId)) return;
    preloadQueueRef.current.add(songId);
    invoke("preload_song", { songId })
      .catch((error) => console.warn("song preload failed", error))
      .finally(() => preloadQueueRef.current.delete(songId));
  }

  async function pauseOrResume() {
    if (!isTauriRuntime) return;
    const status = await invoke<PlayerStatus>(playerStatus.isPlaying ? "pause_song" : "resume_song");
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
    if (songs.length === 0) return;
    const currentIndex = Math.max(
      0,
      songs.findIndex((song) => song.id === (playerStatus.songId ?? selectedSongId)),
    );
    const next = songs[(currentIndex + offset + songs.length) % songs.length];
    preloadSong(next.id);
    void play(next);
  }

  return (
    <main className={clsx("app-shell", `theme-${theme}`)}>
      <section className="player-frame">
        <header className="title-strip">
          <div className="brand-lockup">
            <Waves size={15} />
            <span>LOCALAMP</span>
          </div>
          <div className="title-marquee">
            {playerStatus.title ?? selectedSong?.title ?? selectedSong?.fileName ?? "No song loaded"}
          </div>
          <button className="icon-button" type="button" onClick={() => setIsSettingsOpen(true)}>
            <Settings size={15} />
          </button>
        </header>

        <div className="deck-grid">
          <aside className="left-rack">
            <CoverPanel song={selectedSong} />
            <TransportPanel
              canPlay={songs.length > 0}
              isLoadingTrack={isLoadingTrack}
              status={playerStatus}
              onPrimary={() => void primaryTransportAction()}
              onStop={() => void stop()}
              onPrevious={() => nextSong(-1)}
              onNext={() => nextSong(1)}
              onVolume={setVolume}
              onSeek={seek}
            />
          </aside>

          <section className={clsx("visualizer-rack", `visual-mode-${visualizerMode}`)}>
            <VisualizerCanvas
              frame={visualizerFrame}
              mode={visualizerMode}
              theme={theme}
            />
            <SideMeter frame={visualizerFrame} side="left" />
            <SideMeter frame={visualizerFrame} side="right" />
            <div className="visualizer-label">
              {getVisualizerLabel(visualizerMode)}
            </div>
            <div className="meter-row">
              <Meter label="Bass" value={visualizerFrame?.bass ?? 0} />
              <Meter label="Pulse" value={visualizerFrame?.bassPulse ?? 0} />
              <Meter label="Vocal" value={visualizerFrame?.mids ?? 0} />
              <Meter label="Treble" value={visualizerFrame?.treble ?? 0} />
            </div>
          </section>
        </div>

        <section className="library-panel">
          <div className="library-toolbar">
            <button className="utility-button" type="button" onClick={() => void chooseFolder()}>
              <FolderOpen size={15} />
              {isScanning ? "Scanning..." : "Import Folder"}
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
            activeSongId={playerStatus.songId ?? selectedSongId}
            onSelect={(songId) => {
              setSelectedSongId(songId);
              preloadSong(songId);
            }}
            onPreload={preloadSong}
            onPlay={(song) => void play(song)}
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
    </main>
  );
}

function CoverPanel({ song }: { song?: Song }) {
  const coverUrl = song?.coverArtPath ? convertFileSrc(song.coverArtPath) : undefined;

  return (
    <section className="cover-panel">
      <div className="cover-art">
        {coverUrl ? <img src={coverUrl} alt="" /> : <div className="cover-placeholder">LOCAL</div>}
      </div>
      <div className="song-readout">
        <strong>{song?.title ?? song?.fileName ?? "No track selected"}</strong>
        <span>{song?.artist ?? "Unknown Artist"}</span>
        <span>{song?.album ?? "Unknown Album"}</span>
      </div>
    </section>
  );
}

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
  const signal = Math.min(1, level * 0.36 + vocal * 0.48 + bassPulse * 0.14 + treble * 0.1);
  const vocalFocus = Math.min(1, vocal * 1.18 + treble * 0.16);

  return (
    <div className={clsx("side-meter", `side-meter-${side}`)} aria-hidden="true">
      {Array.from({ length: 12 }).map((_, index) => {
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
  status,
  onPrimary,
  onStop,
  onPrevious,
  onNext,
  onVolume,
  onSeek,
}: {
  canPlay: boolean;
  isLoadingTrack: boolean;
  status: PlayerStatus;
  onPrimary: () => void;
  onStop: () => void;
  onPrevious: () => void;
  onNext: () => void;
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

function VisualizerCanvas({
  frame,
  mode,
  theme,
}: {
  frame?: VisualizerFrame;
  mode: VisualizerMode;
  theme: AppTheme;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latestFrameRef = useRef<VisualizerFrame | undefined>(frame);
  const renderStateRef = useRef<VisualizerRenderState>({
    smoothedBars: [],
    peakBars: [],
    vocalWave: [],
    melodyWave: [],
    scopeWave: [],
    phase: 0,
    lastTime: 0,
  });

  useEffect(() => {
    latestFrameRef.current = frame;
  }, [frame]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const activeCanvas = canvas;
    const activeContext = context;

    let animationFrame = 0;
    let lastDeviceWidth = 0;
    let lastDeviceHeight = 0;

    function render(now: number) {
      const rect = activeCanvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const deviceWidth = Math.max(1, Math.floor(rect.width * scale));
      const deviceHeight = Math.max(1, Math.floor(rect.height * scale));
      if (deviceWidth !== lastDeviceWidth || deviceHeight !== lastDeviceHeight) {
        activeCanvas.width = deviceWidth;
        activeCanvas.height = deviceHeight;
        lastDeviceWidth = deviceWidth;
        lastDeviceHeight = deviceHeight;
      }

      activeContext.setTransform(scale, 0, 0, scale, 0, 0);
      drawVisualizer(
        activeContext,
        rect.width,
        rect.height,
        latestFrameRef.current,
        mode,
        theme,
        renderStateRef.current,
        now,
      );
      animationFrame = window.requestAnimationFrame(render);
    }

    animationFrame = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [mode, theme]);

  return <canvas className="visualizer-canvas" ref={canvasRef} />;
}

type VisualizerRenderState = {
  smoothedBars: number[];
  peakBars: number[];
  vocalWave: number[];
  melodyWave: number[];
  scopeWave: number[];
  phase: number;
  lastTime: number;
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
  const palette = getPalette(theme);
  const dt = renderState.lastTime > 0 ? Math.min(0.05, (now - renderState.lastTime) / 1000) : 1 / 60;
  renderState.lastTime = now;
  renderState.phase += dt * 1.35;

  const { smoothedBars, peakBars } = renderState;
  context.clearRect(0, 0, width, height);
  context.fillStyle = palette.panel;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = mode === "windowsScope" ? palette.gridStrong : palette.grid;
  context.lineWidth = 1;
  for (let y = 16; y < height; y += 14) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  if (mode === "radial") {
    context.strokeStyle = palette.grid;
    for (let x = 18; x < width; x += 28) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
  }

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

  if (mode !== "wmpRibbons") {
    drawRetroAudioAtmosphere(context, width, height, frame, palette, mode, renderState.phase);
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

  if (mode === "classicBars" || mode === "windowsScope") {
    drawAnalyzerDeckMotion(context, width, height, frame, palette, mode, renderState.phase);
  }

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

  bins.forEach((target, index) => {
    const current = smoothedBars[index] ?? 0;
    const center = (bins.length - 1) / 2;
    const centerWeight = mode === "classicBars" || mode === "windowsScope"
      ? Math.max(0, 1 - Math.abs(index - center) / Math.max(1, center))
      : 0;
    const bassLift = Math.pow(frame.bassPulse ?? 0, 1.8) * centerWeight * 0.26;
    const melodicLift = frame.mids * (1 - centerWeight) * 0.08;
    const shapedTarget = Math.min(1, target * (mode === "windowsScope" ? 0.95 : 1.04) + bassLift + melodicLift);
    const attack = shapedTarget > current ? 0.24 : 0.075;
    const smoothed = current + (shapedTarget - current) * attack;
    smoothedBars[index] = smoothed;
    peakBars[index] = Math.max(smoothed, (peakBars[index] ?? 0) - 0.012);

    const x = paddingX + index * (barWidth + barGap);
    const barHeight = Math.max(0, smoothed * usableHeight);
    const blockCount = Math.floor(barHeight / (blockHeight + blockGap));
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

function drawAnalyzerDeckMotion(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame,
  palette: ReturnType<typeof getPalette>,
  mode: VisualizerMode,
  phase: number,
) {
  const bassAccent = Math.pow(frame.bassPulse ?? 0, 1.85);
  const lyricFlow = Math.min(1, frame.mids * 0.72 + frame.treble * 0.28);
  const floor = height * 0.88;
  const color = mode === "windowsScope" ? palette.windowsMid : palette.low;
  const glow = context.createLinearGradient(0, height * 0.35, 0, height);
  glow.addColorStop(0, "rgba(0,0,0,0)");
  glow.addColorStop(0.64, alphaColor(color, 0.04 + lyricFlow * 0.06));
  glow.addColorStop(1, alphaColor(palette.hot, 0.06 + bassAccent * 0.12));
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = alphaColor(color, 0.14 + lyricFlow * 0.12);
  context.lineWidth = 1;
  for (let lane = 0; lane < 7; lane += 1) {
    const y = floor - lane * height * 0.085;
    const offset = Math.sin(phase * 0.8 + lane) * width * 0.02;
    context.beginPath();
    context.moveTo(width * 0.18 + offset, y);
    context.lineTo(width * 0.82 - offset, y - lyricFlow * lane * 2);
    context.stroke();
  }

  context.globalCompositeOperation = "lighter";
  const sparkCount = Math.round(frame.treble * 14 + bassAccent * 5);
  for (let spark = 0; spark < sparkCount; spark += 1) {
    const seed = spark * 23.71 + Math.floor(phase * 2.4) * 17.3;
    const x = width * (0.16 + fract(Math.sin(seed) * 7789.3) * 0.68);
    const y = height * (0.22 + fract(Math.sin(seed + 2.1) * 2927.9) * 0.5);
    context.fillStyle = alphaColor(spark % 3 === 0 ? palette.hot : palette.peak, 0.16 + frame.treble * 0.32);
    context.beginPath();
    context.arc(x, y, 1.2 + frame.treble * 2.2, 0, Math.PI * 2);
    context.fill();
  }
  context.globalCompositeOperation = "source-over";
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
  const bassAccent = Math.pow(frame.bassPulse ?? frame.bass, 1.55);
  const lyricFlow = Math.min(1, frame.mids * 0.72 + frame.treble * 0.32);
  const radiusBase = Math.min(width, height);

  const aura = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radiusBase * 0.76);
  aura.addColorStop(0, alphaColor(hudAmber, 0.08 + lyricFlow * 0.08));
  aura.addColorStop(0.36, alphaColor(hudGreen, 0.1 + lyricFlow * 0.16));
  aura.addColorStop(0.7, alphaColor(hudOrange, 0.045 + bassAccent * 0.08));
  aura.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = aura;
  context.fillRect(0, 0, width, height);

  drawEvaHudOverlay(context, width, height, frame, phase, { hudOrange, hudAmber, hudGreen, hudRed, hudBlue });

  for (let ring = 0; ring < 7; ring += 1) {
    const t = ring / 6;
    const radius = radiusBase * (0.12 + t * 0.34 + bassAccent * 0.012);
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

function drawRetroAudioAtmosphere(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame,
  palette: ReturnType<typeof getPalette>,
  mode: VisualizerMode,
  phase: number,
) {
  const centerX = width / 2;
  const centerY = height / 2;
  const bassAccent = Math.pow(frame.bassPulse ?? 0, 1.75);
  const flow = Math.min(1, frame.mids * 0.76 + frame.treble * 0.24);
  const radius = Math.min(width, height);
  const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 0.78);
  gradient.addColorStop(0, alphaColor(palette.peak, mode === "windowsScope" ? 0.035 : 0.05 + flow * 0.05));
  gradient.addColorStop(0.36, alphaColor(palette.low, 0.06 + flow * 0.1));
  gradient.addColorStop(0.76, alphaColor(palette.hot, 0.025 + bassAccent * 0.08));
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = alphaColor(mode === "windowsScope" ? palette.windowsMid : palette.gridStrong, 0.08 + flow * 0.06);
  context.lineWidth = 1;
  for (let index = 0; index < 8; index += 1) {
    const t = index / 7;
    const y = height * (0.16 + t * 0.68);
    context.beginPath();
    context.moveTo(width * 0.12, y + Math.sin(phase + index) * 2);
    context.lineTo(width * 0.88, y + Math.cos(phase * 0.7 + index) * 2);
    context.stroke();
  }
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
  const bassPulse = frame.bassPulse ?? 0;
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

  const bassAccent = Math.pow(bassPulse, 1.7);
  const flowGlow = Math.pow(lyricFlow, 0.85);
  const haloRadius = Math.min(width, height) * (0.2 + flowGlow * 0.08);
  const halo = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, haloRadius * 2.9);
  halo.addColorStop(0, `rgba(255, 255, 255, ${0.08 + bassAccent * 0.08})`);
  halo.addColorStop(0.24, alphaColor(palette.iidxCyan, 0.18 + flowGlow * 0.26));
  halo.addColorStop(0.58, alphaColor(palette.iidxViolet, 0.1 + lyricFlow * 0.22));
  halo.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = halo;
  context.fillRect(0, 0, width, height);

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
  const core = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 1.9);
  core.addColorStop(0, alphaColor(palette.peak, 0.08 + lyricFlow * 0.08));
  core.addColorStop(0.48, alphaColor(palette.iidxCyan, 0.08 + lyricFlow * 0.12));
  core.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = core;
  context.fillRect(0, 0, width, height);

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
  palette: ReturnType<typeof getPalette>,
  phase: number,
) {
  const bassAccent = Math.pow(frame.bassPulse ?? 0, 1.7);
  const vocalBands = selectCenterOutBands(frame.vocalBins?.length ? frame.vocalBins : frame.frequencyBins, 96);
  const melodyBands = selectCenterOutBands(trimVisualizerBins(frame.frequencyBins), 96);
  const vocalEnergy = averageBands(vocalBands);
  const melodyEnergy = averageBands(melodyBands.slice(Math.floor(melodyBands.length * 0.28)));
  const vocalPresence = Math.min(1, Math.max(0, frame.mids * 0.82 + vocalEnergy * 0.72 - frame.treble * 0.18));
  const melodyPresence = Math.min(1, Math.max(0, melodyEnergy * 0.82 + frame.treble * 0.42 - vocalPresence * 0.28));
  const vocalBlend = vocalPresence / Math.max(0.001, vocalPresence + melodyPresence);
  const melodyBlend = 1 - vocalBlend;
  const songFlow = Math.min(1, frame.mids * 0.36 + frame.treble * 0.24 + vocalEnergy * 0.28 + melodyEnergy * 0.28);
  renderState.vocalWave.length = Math.max(renderState.vocalWave.length, vocalBands.length);
  renderState.melodyWave.length = Math.max(renderState.melodyWave.length, melodyBands.length);
  const centerY = height / 2;

  const field = context.createLinearGradient(0, centerY - height * 0.32, 0, centerY + height * 0.32);
  field.addColorStop(0, "rgba(0,0,0,0)");
  field.addColorStop(0.38, alphaColor(palette.iidxCyan, 0.035 + vocalPresence * 0.08));
  field.addColorStop(0.5, alphaColor(palette.peak, 0.035 + bassAccent * 0.04));
  field.addColorStop(0.62, alphaColor(palette.iidxViolet, 0.035 + melodyPresence * 0.07));
  field.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = field;
  context.fillRect(0, 0, width, height);

  context.strokeStyle = alphaColor(palette.gridStrong, 0.3);
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, centerY);
  context.lineTo(width, centerY);
  context.stroke();

  context.strokeStyle = alphaColor(palette.gridStrong, 0.12 + songFlow * 0.05);
  for (let band = -2; band <= 2; band += 1) {
    if (band === 0) continue;
    const y = centerY + band * height * 0.105;
    context.beginPath();
    context.moveTo(width * 0.08, y);
    context.lineTo(width * 0.92, y);
    context.stroke();
  }

  const scopePoints = 164;
  renderState.scopeWave.length = Math.max(renderState.scopeWave.length, scopePoints + 1);
  const scopeValues = Array.from({ length: scopePoints + 1 }, (_, point) => {
    const t = point / scopePoints;
    const sampleIndex = Math.round(t * Math.max(0, frame.waveform.length - 1));
    const raw = smoothedWaveSample(frame.waveform, sampleIndex, 9);
    const vocalIndex = Math.min(vocalBands.length - 1, Math.floor(t * vocalBands.length));
    const melodyIndex = Math.min(melodyBands.length - 1, Math.floor(t * melodyBands.length));
    const vocalTarget = vocalBands[vocalIndex] ?? 0;
    const melodyTarget = melodyBands[melodyIndex] ?? 0;
    const vocalCurrent = renderState.vocalWave[vocalIndex] ?? 0;
    const melodyCurrent = renderState.melodyWave[melodyIndex] ?? 0;
    const vocal = vocalCurrent + (vocalTarget - vocalCurrent) * (vocalTarget > vocalCurrent ? 0.085 : 0.032);
    const melody = melodyCurrent + (melodyTarget - melodyCurrent) * (melodyTarget > melodyCurrent ? 0.12 : 0.045);
    renderState.vocalWave[vocalIndex] = vocal;
    renderState.melodyWave[melodyIndex] = melody;

    const phrase = Math.sin(phase * 0.82 + t * Math.PI * (2.4 + vocalBlend * 1.5)) * vocal * vocalBlend;
    const harmonic =
      (Math.sin(phase * 0.56 + t * Math.PI * 4.8) * 0.72 +
        Math.sin(phase * 0.34 + t * Math.PI * 7.2 + 1.2) * 0.28) *
      melody *
      melodyBlend;
    const breath = Math.sin(phase * 0.38 + t * Math.PI * 1.2) * (vocal * vocalBlend + melody * melodyBlend) * 0.28;
    const beatSway = Math.sin(phase * 1.16 + t * Math.PI * 1.5) * bassAccent * 0.16;
    const rawTexture = Math.tanh(raw * 1.55) * (0.035 + frame.treble * 0.045 + songFlow * 0.018);
    const target = phrase * 0.52 + harmonic * 0.42 + breath + beatSway + rawTexture;
    const current = renderState.scopeWave[point] ?? 0;
    const scoped = current + (target - current) * (Math.abs(target) > Math.abs(current) ? 0.18 : 0.065);
    renderState.scopeWave[point] = scoped;
    return scoped;
  });

  const upper = scopeValues.map((value) => centerY + value * height * (0.25 + songFlow * 0.04));
  const lower = scopeValues.map((value) => centerY - value * height * (0.14 + vocalBlend * 0.06));

  context.globalCompositeOperation = "lighter";
  const wash = context.createLinearGradient(0, centerY - height * 0.22, width, centerY + height * 0.22);
  wash.addColorStop(0, alphaColor(palette.iidxCyan, 0.04 + vocalPresence * 0.06));
  wash.addColorStop(0.5, alphaColor(palette.peak, 0.035 + bassAccent * 0.045));
  wash.addColorStop(1, alphaColor(palette.iidxViolet, 0.035 + melodyPresence * 0.055));
  context.fillStyle = wash;
  context.beginPath();
  upper.forEach((y, index) => {
    const x = (index / scopePoints) * width;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  for (let index = lower.length - 1; index >= 0; index -= 1) {
    const x = (index / scopePoints) * width;
    context.lineTo(x, lower[index]);
  }
  context.closePath();
  context.fill();

  context.globalCompositeOperation = "lighter";
  context.strokeStyle = vocalBlend > 0.54 ? palette.iidxCyan : palette.iidxViolet;
  context.lineWidth = 1.7 + songFlow * 1.1;
  context.shadowColor = context.strokeStyle;
  context.shadowBlur = 9 + songFlow * 12 + bassAccent * 4;
  context.beginPath();
  scopeValues.forEach((_, index) => {
    const x = (index / scopePoints) * width;
    const y = upper[index];
    if (index === 0) {
      context.moveTo(x, y);
      return;
    }
    const previousX = ((index - 1) / scopePoints) * width;
    const previousY = upper[index - 1];
    context.quadraticCurveTo(previousX, previousY, (previousX + x) / 2, (previousY + y) / 2);
  });
  context.stroke();

  context.strokeStyle = alphaColor(palette.hot, 0.44 + bassAccent * 0.14);
  context.lineWidth = 1.1 + melodyPresence * 0.7;
  context.globalAlpha = 0.48 + songFlow * 0.16;
  context.shadowColor = palette.hot;
  context.shadowBlur = 7 + melodyPresence * 9;
  context.beginPath();
  scopeValues.forEach((_, index) => {
    const x = (index / scopePoints) * width;
    const y = lower[index];
    if (index === 0) {
      context.moveTo(x, y);
      return;
    }
    const previousX = ((index - 1) / scopePoints) * width;
    const previousY = lower[index - 1];
    context.quadraticCurveTo(previousX, previousY, (previousX + x) / 2, (previousY + y) / 2);
  });
  context.stroke();

  context.strokeStyle = alphaColor(palette.peak, 0.1 + bassAccent * 0.18);
  context.lineWidth = 1;
  for (let marker = 0; marker < 5; marker += 1) {
    const x = ((marker / 4 + phase * 0.028) % 1) * width;
    const heightBoost = height * (0.045 + bassAccent * 0.07);
    context.beginPath();
    context.moveTo(x, centerY - heightBoost);
    context.lineTo(x, centerY + heightBoost);
    context.stroke();
  }

  context.globalCompositeOperation = "source-over";
  context.shadowBlur = 0;
  context.globalAlpha = 0.58;
  context.fillStyle = alphaColor(vocalBlend > 0.54 ? palette.iidxCyan : palette.iidxViolet, 0.76);
  context.font = "10px 'IBM Plex Mono', 'Courier New', monospace";
  context.fillText(vocalBlend > 0.54 ? "VOCAL TRACE" : "MELODY TRACE", width * 0.06, height - 18);
  context.fillStyle = alphaColor(palette.gridStrong, 0.42);
  context.fillRect(width * 0.22, height - 22, width * 0.22, 3);
  context.fillStyle = alphaColor(palette.iidxCyan, 0.78);
  context.fillRect(width * 0.22, height - 22, width * 0.22 * vocalBlend, 3);
  context.fillStyle = alphaColor(palette.iidxViolet, 0.76);
  context.fillRect(width * 0.22 + width * 0.22 * vocalBlend, height - 22, width * 0.22 * melodyBlend, 3);

  context.globalAlpha = 1;
  context.shadowBlur = 0;
  context.globalCompositeOperation = "source-over";
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

function averageBands(source: number[]) {
  if (source.length === 0) return 0;
  return source.reduce((sum, value) => sum + value, 0) / source.length;
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

function SongTable({
  songs,
  activeSongId,
  onSelect,
  onPreload,
  onPlay,
}: {
  songs: Song[];
  activeSongId?: string | null;
  onSelect: (songId: string) => void;
  onPreload: (songId: string) => void;
  onPlay: (song: Song) => void;
}) {
  if (songs.length === 0) {
    return <div className="empty-library">No matching tracks.</div>;
  }

  return (
    <div className="song-table">
      {songs.map((song, index) => (
        <button
          key={song.id}
          className={clsx("song-row", song.id === activeSongId && "active")}
          type="button"
          onClick={() => onSelect(song.id)}
          onPointerEnter={() => onPreload(song.id)}
          onFocus={() => onPreload(song.id)}
          onDoubleClick={() => onPlay(song)}
        >
          <span>{String(index + 1).padStart(2, "0")}</span>
          <strong>{song.title ?? song.fileName}</strong>
          <em>{song.artist ?? "Unknown Artist"}</em>
          <small>{formatTime(song.durationSeconds ?? 0)}</small>
        </button>
      ))}
    </div>
  );
}

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

function getPalette(theme: AppTheme) {
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
