import type { VisualizerFrame, VisualizerMode } from "./types";

export function isModernMode(mode: VisualizerMode) {
  return mode === "aurora" || mode === "silk" || mode === "halo";
}

export type ModernMotion = {
  timestamp?: number;
  phase: number;
  energy: number;
  weight: number;
  presence: number;
  air: number;
  warmth: number;
  swell: number;
  lean: number;
  momentum: number;
  brightness: number;
  vocal: number;
};

export function createModernMotion(): ModernMotion {
  return { phase: 0, energy: 0, weight: 0, presence: 0, air: 0, warmth: .5, swell: 0, lean: 0, momentum: 0, brightness: 0, vocal: 0 };
}

const unit = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const follow = (current: number, target: number, dt: number, attack: number, release: number) =>
  current + (target - current) * -Math.expm1(-dt / (target > current ? attack : release));

/** Musical envelopes, not individual samples, drive the scene. Time constants are
 * in seconds, so smoothing is consistent across audio/render frame rates.
 * Playback time freezes on pause; seeks rebase the clock without teleporting the art.
 */
export function updateModernMotion(state: ModernMotion, frame?: VisualizerFrame, reducedMotion = false) {
  if (!frame || !Number.isFinite(frame.timestamp)) return state;
  const elapsed = state.timestamp === undefined ? 0 : frame.timestamp - state.timestamp;
  state.timestamp = frame.timestamp;
  const dt = elapsed > 0 && elapsed <= .5 ? elapsed : 0;
  if (!dt) return state;

  const bass = unit(frame.bass), mids = unit(frame.mids), treble = unit(frame.treble);
  const energy = unit(Math.sqrt(unit(frame.volume)) * .6 + bass * .2 + mids * .2);
  const total = bass + mids + treble;
  // Silence tends toward a neutral palette rather than amplifying noisy ratios.
  const warmth = total > .025 ? (bass + mids * .5) / total : .5;
  const stereoTotal = unit(frame.leftLevel) + unit(frame.rightLevel);
  const lean = stereoTotal > .025 ? (unit(frame.rightLevel) - unit(frame.leftLevel)) / stereoTotal : 0;
  const slow = reducedMotion ? 2 : 1;
  state.energy = follow(state.energy, energy, dt, 1.8 * slow, 4.5 * slow);
  state.weight = follow(state.weight, bass, dt, 1.2 * slow, 3.8 * slow);
  state.presence = follow(state.presence, mids, dt, 2.2 * slow, 4 * slow);
  state.air = follow(state.air, treble, dt, 2.8 * slow, 5 * slow);
  state.warmth = follow(state.warmth, warmth, dt, 5 * slow, 5 * slow);
  state.swell = follow(state.swell, unit(frame.bassPulse), dt, 1.4 * slow, 4 * slow);
  // Relative spectral balance preserves differences between quietly mastered
  // acoustic tracks and loud electronic tracks without turning volume into mood.
  const audible = total / (total + .06);
  state.brightness = follow(state.brightness, total > 0 ? treble / total * audible : 0, dt, .65 * slow, 1.8 * slow);
  state.vocal = follow(state.vocal, total > 0 ? mids / total * audible : 0, dt, .7 * slow, 2 * slow);
  // A second, faster envelope gives percussion a soft follow-through while the
  // existing multi-second envelopes retain the underlying calm composition.
  state.momentum = follow(state.momentum, unit(frame.bassPulse) * .65 + energy * .35, dt, .24 * slow, .9 * slow);
  state.lean = follow(state.lean, lean, dt, 3 * slow, 3 * slow);
  // Integrating speed avoids a phase jump when loudness changes. Reduced-motion
  // mode retains gradual color/intensity changes without continuous orbiting.
  if (!reducedMotion) state.phase += dt * (.1 + state.energy * .28 + state.momentum * .16);
  return state;
}

/** Draws only from smoothed envelopes. No PCM samples or individual FFT bins
 * reach geometry; a snare cannot turn a calm contour into a vibrating wire.
 * Uses the existing wake/sleep loop, with no independent timer or audio analysis.
 */
export function drawModernVisualizer(
  ctx: CanvasRenderingContext2D, width: number, height: number,
  frame: VisualizerFrame | undefined, mode: VisualizerMode,
  state: ModernMotion, reducedMotion = false,
) {
  updateModernMotion(state, frame, reducedMotion);
  const { phase, energy, weight, presence, air, warmth, swell, lean, momentum, brightness, vocal } = state;
  const hue = 215 - warmth * 65 + brightness * 28;
  const color = (alpha: number, lightness = 70, offset = 0) =>
    `hsla(${hue + offset}, ${35 + energy * 20}%, ${lightness}%, ${alpha})`;
  ctx.fillStyle = "#101719";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  const centerX = width * (.5 + lean * .06);
  const glow = ctx.createRadialGradient(centerX, height * .55, 0, centerX, height * .55, Math.max(width, height) * .6);
  glow.addColorStop(0, color(.14 + energy * .12, 36));
  glow.addColorStop(1, color(0, 20));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  if (mode === "halo") {
    // Broad closed contours resemble a gently opening flower, without FFT teeth.
    const radius = Math.min(width, height) * (.21 + weight * .04 + swell * .02 + momentum * .025);
    for (let ring = 6; ring >= 0; ring--) {
      const depth = ring / 6;
      ctx.beginPath();
      for (let i = 0; i <= 96; i++) {
        const angle = i / 96 * Math.PI * 2;
        const opening = Math.sin(angle * 2 + phase + depth * .7) * (.03 + vocal * .16 + presence * .05);
        const petal = Math.cos(angle * 3 - phase * .65 + depth) * (.015 + brightness * .09 + momentum * .04);
        const r = radius * (1 + depth * (.24 + presence * .12) + opening + petal);
        const x = centerX + Math.cos(angle) * r * (1.06 + Math.sin(phase * .6 + depth) * (.06 + brightness * .15));
        const y = height * .5 + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = color(.012, 55);
      ctx.fill();
      ctx.strokeStyle = color(.46 - depth * .32 + air * .08, 74, depth * 16);
      ctx.lineWidth = ring === 0 ? 1.7 : 1;
      ctx.shadowColor = color(.5); ctx.shadowBlur = ring === 0 ? 10 + air * 6 : 0;
      ctx.stroke();
    }
  } else {
    const silk = mode === "silk";
    const layers = silk ? 12 : 16;
    // One shared gradient per scene instead of one allocation per strand.
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, color(.025, 65, 20));
    gradient.addColorStop(.3, color(.5, 67, 14));
    gradient.addColorStop(.6, color(.85, 76));
    gradient.addColorStop(1, color(.035, 65, -8));
    ctx.strokeStyle = gradient;
    ctx.shadowColor = color(.4);
    const segments = Math.max(64, Math.min(128, Math.ceil(width / 7)));
    const amplitude = .09 + weight * .06 + swell * .025 + momentum * .045;
    // Two broad currents gently separate as sustained mids/energy increase.
    // Layer offsets stay coherent instead of tracking instantaneous samples.
    for (let layer = 0; layer < layers; layer++) {
      const depth = layer / (layers - 1);
      const strand = depth - .5;
      ctx.beginPath();
      for (let step = 0; step <= segments; step++) {
        const progress = step / segments;
        const envelope = Math.sin(progress * Math.PI);
        const sweep = Math.sin(progress * Math.PI * 2 + phase + strand * .75);
        const fold = Math.sin(progress * Math.PI * 3 - phase * .55 + depth * 1.2);
        const spread = strand * (silk ? .24 : .38) * (.65 + vocal * .9 + presence * .5);
        const y = height * (.51 + lean * .025 + envelope * (
          sweep * amplitude + fold * (.022 + vocal * .09 + brightness * .05) + spread * Math.cos(progress * 3 + phase * .35)
        ));
        // Silk curls sideways into loose, interweaving loops; Aurora stays
        // broad and horizontal. Both retain a quiet silhouette between phrases.
        const curl = silk ? Math.sin(progress * Math.PI * 4 + phase * 1.2 + depth * 2) * envelope : 0;
        const x = progress * width + curl * width * (.018 + vocal * .055 + brightness * .035);
        const silkY = y + curl * height * (.025 + momentum * .06);
        if (step === 0) ctx.moveTo(x, silkY); else ctx.lineTo(x, silkY);
      }
      ctx.globalAlpha = .35 + depth * .5 + air * .1;
      ctx.lineWidth = silk ? 1 : 1.8;
      // Most strands stay sharp; a few soft strokes supply depth without
      // repeatedly blurring the entire canvas for every strand.
      ctx.shadowBlur = !silk && layer % 4 === 0 ? 12 : 0;
      ctx.stroke();
    }
  }
  ctx.restore();
}
