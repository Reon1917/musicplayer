import type { ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioLines, FolderOpen, Library, Music2, Settings2, Sparkles, Disc3 } from "lucide-react";
import type { Song, VisualizerMode } from "./types";

const modes = [
  { id: "aurora", label: "Aurora", description: "Light that follows the music" },
  { id: "silk", label: "Silk", description: "A flowing waveform" },
  { id: "halo", label: "Halo", description: "Your sound, in orbit" },
] as const;

type Props = {
  song?: Song;
  cover: ReactNode;
  transport: ReactNode;
  library: ReactNode;
  visualizer: ReactNode;
  isEmpty: boolean;
  isScanning: boolean;
  mode: VisualizerMode;
  onImport: () => void;
  onMode: (mode: VisualizerMode) => void;
  onRetro: () => void;
  onSettings: () => void;
};

export function StudioShell(props: Props) {
  return <div className="studio-layout">
    <aside className="studio-sidebar">
      <div className="studio-brand"><AudioLines size={27} /><span>Lapis</span></div>
      <nav aria-label="Library navigation">
        <button className="studio-nav selected" onClick={() => document.querySelector<HTMLInputElement>('.studio-library input[aria-label="Search tracks"]')?.focus({ preventScroll: true })}><Library size={19} />Your library</button>
        <button className="studio-nav" disabled={props.isScanning} onClick={props.onImport}><FolderOpen size={19} />{props.isScanning ? "Importing…" : "Import folder"}</button>
      </nav>
      <div className="studio-appearance">
        <p>Appearance</p>
        <button className="studio-nav selected" aria-pressed="true" onClick={props.onSettings}><Sparkles size={18} />Studio</button>
        <button className="studio-nav" onClick={props.onRetro}><Disc3 size={18} />Retro</button>
      </div>
      <div className="studio-sidebar-footer"><span>Local music. All yours.</span><button className="studio-nav" onClick={props.onSettings}><Settings2 size={18} />Settings</button></div>
    </aside>
    <div className="studio-content">
      <header className="studio-heading"><div><h1>Now playing</h1><p>Your music, a little closer.</p></div><button className="icon-button" aria-label="Open settings" onClick={props.onSettings}><Settings2 size={20} /></button></header>
      <section className="studio-listening" aria-label="Now playing and visualizer">
        {props.cover}
        <div className="studio-visual">
          {props.visualizer}
          <div className="studio-visual-footer"><span>{modes.find(mode => mode.id === props.mode)?.description ?? "Move with the music"}</span><div className="studio-mode-switch" aria-label="Visualizer style">{modes.map(mode => <button key={mode.id} aria-pressed={props.mode === mode.id} className={props.mode === mode.id ? "selected" : ""} onClick={() => props.onMode(mode.id)}>{mode.label}</button>)}</div></div>
        </div>
      </section>
      <section className="studio-library" id="studio-library" aria-label="Your library">
        <h2>Your library</h2><p>All your music, in one place.</p>
        {props.library}
        {props.isEmpty && <div className="studio-empty"><div className="studio-empty-icon"><Music2 size={28} /></div><h3>Make room for your music</h3><p>Import a folder to start listening.</p><button className="studio-import" disabled={props.isScanning} onClick={props.onImport}><FolderOpen size={18} />{props.isScanning ? "Importing…" : "Import a folder"}</button></div>}
      </section>
    </div>
    <footer className="studio-dock"><div className="studio-dock-track"><div className="studio-mini-art">{props.song?.coverArtPath ? <img src={convertFileSrc(props.song.coverArtPath)} alt="" /> : <Music2 size={24} />}</div><div><strong>{props.song?.title ?? props.song?.fileName ?? "Nothing playing yet"}</strong><span>{props.song?.artist ?? "Pick something you love"}</span></div></div>{props.transport}</footer>
  </div>;
}
