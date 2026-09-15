import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/modernVisualizers.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { createModernMotion, updateModernMotion, drawModernVisualizer } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const frame = (timestamp, overrides = {}) => ({
  timestamp, volume: .5, bass: .4, mids: .3, treble: .2, bassPulse: .5,
  leftLevel: .4, rightLevel: .4, frequencyBins: [], vocalBins: [], waveform: [], peaks: [], ...overrides,
});
function settle(overrides, seconds = 15, fps = 60) {
  const state = createModernMotion();
  for (let i = 0; i <= seconds * fps; i++) updateModernMotion(state, frame(i / fps, overrides));
  return state;
}

test('single transients barely move the shape, sustained music opens it', () => {
  const state = createModernMotion();
  updateModernMotion(state, frame(0, { bass: 0 }));
  updateModernMotion(state, frame(1 / 60, { bass: 1, bassPulse: 1 }));
  assert.ok(state.weight < .015);
  assert.ok(state.swell < .015);
  const sustained = settle({ bass: 1, bassPulse: 1 }, 5);
  assert.ok(sustained.weight > .98);
  assert.ok(sustained.swell > .97);
});

test('release is gradual after a loud phrase', () => {
  const state = settle({ bass: 1 }, 10);
  updateModernMotion(state, frame(10 + 1 / 60, { bass: 0 }));
  assert.ok(state.weight > .99);
  for (let i = 2; i <= 300; i++) updateModernMotion(state, frame(10 + i / 60, { bass: 0 }));
  assert.ok(state.weight > .2 && state.weight < .3);
});

test('envelope response is independent of rendering frame rate', () => {
  const a = settle({}, 10, 30), b = settle({}, 10, 60);
  for (const key of ['energy', 'weight', 'presence', 'air', 'warmth', 'swell', 'momentum', 'brightness', 'vocal']) {
    assert.ok(Math.abs(a[key] - b[key]) < 1e-9, key);
  }
  assert.ok(Math.abs(a.phase - b.phase) < .002);
});

test('pause and seeks do not jump phase or shape', () => {
  const state = settle({});
  const previous = { ...state };
  updateModernMotion(state, frame(15));
  assert.deepEqual(state, previous);
  updateModernMotion(state, frame(100));
  assert.deepEqual({ ...state, timestamp: 15 }, previous);
  updateModernMotion(state, frame(0));
  assert.deepEqual({ ...state, timestamp: 15 }, previous);
});

test('bass-rich and bright passages develop different color and shape envelopes', () => {
  const warm = settle({ bass: .9, mids: .2, treble: .02 });
  const bright = settle({ bass: .02, mids: .2, treble: .9 });
  assert.ok(warm.warmth - bright.warmth > .65);
  assert.ok(warm.weight > bright.weight);
  assert.ok(bright.air > warm.air);
});

test('reduced motion freezes drift while allowing slow expressive changes', () => {
  const state = createModernMotion();
  for (let i = 0; i <= 600; i++) updateModernMotion(state, frame(i / 60), true);
  assert.equal(state.phase, 0);
  assert.ok(state.energy > .4);
});

function drawing(mode, audioFrame) {
  const commands = [];
  const context = new Proxy({}, {
    set(target, key, value) { target[key] = value; return true; },
    get(target, key) {
      if (String(key).startsWith('create')) return () => ({ addColorStop() {} });
      if (key in target) return target[key];
      return (...args) => {
        assert.ok(args.every(value => typeof value !== 'number' || Number.isFinite(value)));
        commands.push([key, ...args]);
      };
    },
  });
  drawModernVisualizer(context, 800, 300, audioFrame, mode, createModernMotion());
  return commands;
}

test('all scenes render finite geometry; raw PCM and individual FFT spikes cannot vibrate contours', () => {
  for (const mode of ['aurora', 'silk', 'halo']) {
    drawing(mode, undefined);
    const quiet = drawing(mode, frame(0));
    const noisy = drawing(mode, frame(0, { waveform: Array(256).fill(1), frequencyBins: Array(64).fill(1) }));
    assert.deepEqual(quiet, noisy, mode);
  }
});


test('rhythm gets a faster response without moving the slow baseline abruptly', () => {
  const state = settle({ bassPulse: 0 });
  const before = { ...state };
  for (let i = 1; i <= 12; i++) updateModernMotion(state, frame(15 + i / 60, { bassPulse: 1 }));
  assert.ok(state.momentum - before.momentum > .3);
  assert.ok(state.swell - before.swell < .15);
});

test('relative tone separates vocal and bright tracks even at matching loudness', () => {
  const vocal = settle({ volume: .2, bass: .05, mids: .65, treble: .02 });
  const bright = settle({ volume: .2, bass: .05, mids: .02, treble: .65 });
  assert.ok(vocal.vocal - bright.vocal > .7);
  assert.ok(bright.brightness - vocal.brightness > .7);
});
