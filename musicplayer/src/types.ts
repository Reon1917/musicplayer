export type Song = {
  id: string;
  filePath: string;
  fileName: string;
  fileType: "mp3" | "wav" | string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  genre?: string | null;
  year?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  durationSeconds?: number | null;
  bitrate?: number | null;
  sampleRate?: number | null;
  coverArtPath?: string | null;
  metadataSource: string;
  dateAdded: string;
  lastPlayed?: string | null;
  playCount: number;
};

export type PlayerStatus = {
  songId?: string | null;
  title?: string | null;
  artist?: string | null;
  isPlaying: boolean;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
};

export type VisualizerFrame = {
  timestamp: number;
  volume: number;
  bassPulse: number;
  bass: number;
  mids: number;
  treble: number;
  leftLevel: number;
  rightLevel: number;
  frequencyBins: number[];
  vocalBins: number[];
  waveform: number[];
  peaks: number[];
};

export type VisualizerMode =
  | "trapNation"
  | "wmpRibbons"
  | "plasmaStorm"
  | "spectrumRing"
  | "classicBars"
  | "centerStereo"
  | "radial"
  | "windowsScope"
  | "waveform";
export type AppTheme = "phosphor" | "amber" | "ice";
