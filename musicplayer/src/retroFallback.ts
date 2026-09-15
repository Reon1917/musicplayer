import type { VisualizerFrame } from "./types";

export type RetroMode = "freestyle" | "ribbonDance" | "starTunnel";
type Colors = { mid: string; hot: string; peak: string; iidxCyan: string; iidxViolet: string };
const TAU = Math.PI * 2;
// Fixed seeds make the tunnel continuous and avoid per-frame random allocation.
const STARS = Array.from({ length: 120 }, (_, index) => ({
  angle: index * 2.39996323,
  radius: 0.12 + ((index * 37) % 101) / 101 * 0.56,
  depth: ((index * 61) % 127) / 127,
}));

function band(samples: number[], t: number) {
  const position = Math.max(0, Math.min(1, t)) * Math.max(0, samples.length - 1);
  const index = Math.floor(position);
  const left = samples[index] ?? 0;
  return left + ((samples[index + 1] ?? left) - left) * (position - index);
}

// Re-stroke the same path for a soft halo instead of filtering an entire canvas.
function neon(context: CanvasRenderingContext2D, color: string, opacity: number, width = 1.2) {
  context.strokeStyle = color;
  context.lineWidth = width + 5;
  context.globalAlpha = opacity * 0.08;
  context.stroke();
  context.lineWidth = width + 2;
  context.globalAlpha = opacity * 0.18;
  context.stroke();
  context.lineWidth = width;
  context.globalAlpha = opacity;
  context.stroke();
}

export function drawRetroVisualizer(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  frame: VisualizerFrame,
  mode: RetroMode,
  phase: number,
  colors: Colors,
) {
  context.save();
  context.globalCompositeOperation = "lighter";
  if (mode === "freestyle") drawFreestyle(context, width, height, frame, phase, colors);
  else if (mode === "ribbonDance") drawRibbons(context, width, height, frame, phase, colors);
  else drawTunnel(context, width, height, frame, phase, colors);
  context.restore();
}

function drawFreestyle(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  frame: VisualizerFrame, phase: number, colors: Colors,
) {
  const size = Math.min(w, h) * (0.28 + frame.bassPulse * 0.055);
  const morph = (Math.sin(phase * 0.13) + 1) * 0.5;
  const rotation = phase * 0.16;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  for (let trail = 8; trail >= 0; trail--) {
    const time = phase - trail * 0.075;
    ctx.beginPath();
    for (let point = 0; point <= 192; point++) {
      const t = point / 192;
      const angle = t * TAU;
      const signal = band(frame.waveform, t);
      const vocal = band(frame.vocalBins, (Math.sin(angle) + 1) * 0.5);
      const radius = size * (0.83 + vocal * 0.3 + signal * 0.16);
      const x = radius * (Math.sin(angle * 3 + time * 0.6) * (1 - morph * 0.38)
        + Math.cos(angle * 2 - time * 0.35) * morph * 0.55);
      const y = radius * (Math.sin(angle * 2 + time * 0.31) * 0.78
        + Math.cos(angle * 5 + time * 0.23) * (0.12 + frame.treble * 0.18));
      const px = w / 2 + x * cos - y * sin;
      const py = h / 2 + x * sin + y * cos;
      if (point === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
    neon(ctx, trail < 2 ? colors.peak : trail < 5 ? colors.iidxCyan : colors.iidxViolet,
      (1 - trail / 10) * (0.4 + frame.volume * 0.4), trail === 0 ? 1.4 : 0.8);
  }
}

function drawRibbons(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  frame: VisualizerFrame, phase: number, colors: Colors,
) {
  for (let ribbon = 0; ribbon < 4; ribbon++) {
    const color = ribbon === 0 ? colors.hot : ribbon === 1 ? colors.iidxViolet : ribbon === 2 ? colors.iidxCyan : colors.peak;
    // Batch the four faint strands into one path, then draw the bright spine.
    // This keeps the ribbon detail while sharing the halo strokes.
    for (let group = 0; group < 2; group++) {
      ctx.beginPath();
      for (let strand = 0; strand < 5; strand++) {
        if ((strand === 2) !== (group === 1)) continue;
        for (let point = 0; point <= 112; point++) {
          const t = point / 112;
          const envelope = Math.sin(t * Math.PI);
          const vocal = band(frame.vocalBins, t);
          const signal = band(frame.waveform, t);
          const time = phase * (0.48 + ribbon * 0.055) - strand * 0.055;
          const sway = Math.sin(t * TAU * 1.4 + time + ribbon * 1.6);
          const fold = Math.cos(t * TAU * 0.65 - time * 0.7 + ribbon);
          const x = w * (0.08 + t * 0.84);
          const y = h * (0.5 + (ribbon - 1.5) * 0.045)
            + envelope * h * (sway * (0.16 + vocal * 0.12) + fold * 0.055
              + signal * 0.055 + (strand - 2) * (0.009 + frame.bassPulse * 0.006));
          if (point === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      neon(ctx, color, (group === 1 ? 0.7 : 0.22) * (0.65 + frame.mids * 0.35), group === 1 ? 1.1 : 0.65);
    }
  }
}

function drawTunnel(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  frame: VisualizerFrame, phase: number, colors: Colors,
) {
  const centerX = w * (0.5 + Math.sin(phase * 0.22) * 0.07);
  const centerY = h * (0.5 + Math.cos(phase * 0.17) * 0.06);
  const size = Math.min(w, h);
  // Time stays continuous; the beat changes streak length, never star position.
  for (let ring = 0; ring < 9; ring++) {
    const z = ((ring / 9 + phase * 0.09) % 1);
    const radius = size * (0.035 + z * z * 0.64);
    ctx.beginPath();
    for (let point = 0; point <= 64; point++) {
      const angle = point / 64 * TAU + phase * 0.08;
      const energy = band(frame.frequencyBins, point / 64);
      const r = radius * (1 + energy * 0.09);
      const x = centerX + Math.cos(angle) * r;
      const y = centerY + Math.sin(angle) * r * 0.78;
      if (point === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    neon(ctx, ring % 2 ? colors.iidxViolet : colors.mid, Math.sin(z * Math.PI) * 0.32, 0.7);
  }
  for (const star of STARS) {
    const z = 1 - ((star.depth + phase * 0.14) % 1);
    const depth = 0.22 + z * 2.7;
    const radius = star.radius * size / depth;
    const angle = star.angle + phase * 0.045;
    const x = centerX + Math.cos(angle) * radius;
    const y = centerY + Math.sin(angle) * radius * 0.78;
    if (x < 0 || x > w || y < 0 || y > h) continue;
    const stretch = 0.014 + (1 - z) * 0.055 + frame.bassPulse * 0.065;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (x - centerX) * stretch, y + (y - centerY) * stretch);
    neon(ctx, star.depth > 0.66 ? colors.hot : colors.peak,
      Math.min(1, (1 - z) * 1.5) * (0.5 + frame.treble * 0.5), 0.7 + (1 - z) * 0.9);
  }
}
