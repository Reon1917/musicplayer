import { create } from "zustand";
import type {
  AppTheme,
  PlayerStatus,
  Song,
  VisualizerFrame,
  VisualizerMode,
} from "./types";

type AppStore = {
  songs: Song[];
  selectedSongId?: string;
  pendingSongId?: string;
  playerStatus: PlayerStatus;
  visualizerFrame?: VisualizerFrame;
  visualizerMode: VisualizerMode;
  theme: AppTheme;
  scanError?: string;
  isScanning: boolean;
  isLoadingTrack: boolean;
  setSongs: (songs: Song[]) => void;
  setSelectedSongId: (songId?: string) => void;
  setPendingSongId: (songId?: string) => void;
  setPlayerStatus: (status: PlayerStatus) => void;
  setVisualizerFrame: (frame: VisualizerFrame) => void;
  setVisualizerMode: (mode: VisualizerMode) => void;
  setTheme: (theme: AppTheme) => void;
  setScanError: (error?: string) => void;
  setIsScanning: (isScanning: boolean) => void;
  setIsLoadingTrack: (isLoadingTrack: boolean) => void;
};

const themeIds: AppTheme[] = ["studio", "lapis", "phosphor", "amber", "ice"];
const modeIds: VisualizerMode[] = ["aurora", "silk", "halo", "classicBars", "windowsScope", "waveform", "phosphorTrails", "freestyle", "ribbonDance", "starTunnel"];
function readPreference<T extends string>(key: string, allowed: T[], fallback: T): T {
  try { const value = localStorage.getItem(key); return allowed.includes(value as T) ? value as T : fallback; }
  catch { return fallback; }
}
function savePreference(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Preferences remain available for this session. */ }
}

export const useAppStore = create<AppStore>((set) => ({
  songs: [],
  playerStatus: {
    songId: null,
    title: null,
    artist: null,
    isPlaying: false,
    positionSeconds: 0,
    durationSeconds: 0,
    volume: 0.8,
  },
  visualizerMode: readPreference("lapis.visualizer", modeIds, "aurora"),
  theme: readPreference("lapis.theme", themeIds, "studio"),
  isScanning: false,
  isLoadingTrack: false,
  setSongs: (songs) => set({ songs }),
  setSelectedSongId: (selectedSongId) => set({ selectedSongId }),
  setPendingSongId: (pendingSongId) => set({ pendingSongId }),
  setPlayerStatus: (playerStatus) => set({ playerStatus }),
  setVisualizerFrame: (visualizerFrame) => set({ visualizerFrame }),
  setVisualizerMode: (visualizerMode) => { savePreference("lapis.visualizer", visualizerMode); set({ visualizerMode }); },
  setTheme: (theme) => {
    savePreference("lapis.theme", theme);
    set((state) => {
      const visualizerMode = theme === "studio" && !["aurora", "silk", "halo"].includes(state.visualizerMode)
        ? "aurora" : theme !== "studio" && ["aurora", "silk", "halo"].includes(state.visualizerMode) ? "classicBars" : state.visualizerMode;
      savePreference("lapis.visualizer", visualizerMode);
      return { theme, visualizerMode };
    });
  },
  setScanError: (scanError) => set({ scanError }),
  setIsScanning: (isScanning) => set({ isScanning }),
  setIsLoadingTrack: (isLoadingTrack) => set({ isLoadingTrack }),
}));
