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
  playerStatus: PlayerStatus;
  visualizerFrame?: VisualizerFrame;
  visualizerMode: VisualizerMode;
  theme: AppTheme;
  scanError?: string;
  isScanning: boolean;
  isLoadingTrack: boolean;
  setSongs: (songs: Song[]) => void;
  setSelectedSongId: (songId?: string) => void;
  setPlayerStatus: (status: PlayerStatus) => void;
  setVisualizerFrame: (frame: VisualizerFrame) => void;
  setVisualizerMode: (mode: VisualizerMode) => void;
  setTheme: (theme: AppTheme) => void;
  setScanError: (error?: string) => void;
  setIsScanning: (isScanning: boolean) => void;
  setIsLoadingTrack: (isLoadingTrack: boolean) => void;
};

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
  visualizerMode: "trapNation",
  theme: "phosphor",
  isScanning: false,
  isLoadingTrack: false,
  setSongs: (songs) => set({ songs }),
  setSelectedSongId: (selectedSongId) => set({ selectedSongId }),
  setPlayerStatus: (playerStatus) => set({ playerStatus }),
  setVisualizerFrame: (visualizerFrame) => set({ visualizerFrame }),
  setVisualizerMode: (visualizerMode) => set({ visualizerMode }),
  setTheme: (theme) => set({ theme }),
  setScanError: (scanError) => set({ scanError }),
  setIsScanning: (isScanning) => set({ isScanning }),
  setIsLoadingTrack: (isLoadingTrack) => set({ isLoadingTrack }),
}));
