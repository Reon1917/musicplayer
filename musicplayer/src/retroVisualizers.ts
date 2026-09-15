import type { AppTheme, VisualizerFrame, VisualizerMode } from "./types";

// Original effects informed by the XP Alchemy / Ambience / Battery footage:
// https://www.youtube.com/watch?v=ntyKbTLrfxE
// Two reusable GPU textures carry the previous picture through a moving warp.
// No CPU pixel processing, extra FFT, or frame-rate/resolution reduction.
export function isRetroMode(mode: VisualizerMode): mode is "freestyle" | "ribbonDance" | "starTunnel" {
  return mode === "freestyle" || mode === "ribbonDance" || mode === "starTunnel";
}

const VERTEX = `
attribute vec2 position;
varying vec2 uv;
void main() { uv = position * .5 + .5; gl_Position = vec4(position, 0., 1.); }
`;
const FRAGMENT = `
precision highp float;
varying vec2 uv;
uniform sampler2D history;
uniform sampler2D signal;
uniform vec2 resolution;
uniform vec4 energy;
uniform float volume;
uniform float time;
uniform float delta;
uniform float mode;
uniform float theme;
uniform float present;
const float PI = 3.14159265;
vec3 palette(float t) {
  return .5 + .5 * cos(6.2831853 * (t + vec3(0., .33, .67)));
}
vec4 audio(float t) { return texture2D(signal, vec2(clamp(t, .004, .996), .5)); }
mat2 rotate(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
void main() {
  if (present > .5) { gl_FragColor = texture2D(history, uv); return; }
  vec2 p = (uv * 2. - 1.) * vec2(resolution.x / resolution.y, 1.);
  float r = length(p), a = atan(p.y, p.x);
  float bass = energy.x, mids = energy.z, high = energy.w;
  float bin = audio(abs(a) / PI).r;
  float wave = audio(uv.x).g * 2. - 1.;
  float activity = smoothstep(.001, .045, volume + energy.y + mids + high);
  vec2 previous = p;
  vec3 ink = vec3(0.);
  float decay = .955;
  float tint = theme + time * .024;
  if (mode < .5) {
    // Alchemy: liquid mirrored color fields, evolving symmetry and a live wave.
    vec2 q = abs(p);
    q += .13 * vec2(sin(q.y * 4. + time * .41), cos(q.x * 3. - time * .33));
    float folds = sin(q.x * (4.5 + mids) + time * .35)
      * cos(q.y * 5.8 - time * .29) + sin(r * 7. - time * .9) * .38;
    float contour = exp(-abs(folds + wave * .2) * 7.);
    float core = exp(-r * r * (9. - bass * 4.));
    float beam = .012 / (.022 + abs(p.y - wave * (.2 + mids * .4)));
    vec3 color = palette(tint + folds * .16 + r * .12);
    ink = color * (.045 + contour * .24 + core * .12)
      + palette(tint + .32) * (core * bass * .22 + beam * (.03 + high * .08));
    previous = rotate(sin(time * .27) * .008 * delta) * p;
    previous *= 1. - (.003 + bass * .008) * delta;
    previous += sin(p.yx * 4. + time * .4) * .0025 * delta;
    decay = .91;
  } else if (mode < 1.5) {
    // Ambience: fiery, noisy lobes and expanding luminous wave echoes.
    float petals = sin(a * 6. + time * .3) * sin(a * 3. - time * .19);
    float ripple = sin(a * 17. + r * 11. - time * 1.4);
    float boundary = .3 + petals * .1 + bin * .22 + bass * .13;
    float edge = exp(-abs(r - boundary - ripple * .022) * 35.);
    float rays = pow(max(0., sin(a * 12. + r * 5. - time * .23)), 9.)
      * exp(-abs(r - boundary) * 4.);
    float streak = .008 / (.025 + abs(p.y - wave * (.2 + mids * .5)));
    ink = palette(tint + .14 + r * .12) * (edge * .48 + rays * (.035 + high * .09))
      + palette(tint + .23) * streak * (.12 + mids * .15);
    previous = rotate((.006 + sin(time * .3) * .009) * delta) * p
      * (1. - (.014 + bass * .014) * delta);
    previous += vec2(sin(a * 5. + time), cos(a * 4. - time)) * .002 * delta;
    decay = .967;
  } else {
    // Battery: a dense, changing radial fan pulled into a spiral by feedback.
    float teeth = sin(a * 18. + sin(r * 5. - time * .7) * 2.5 + time * .25);
    float ring = .19 + bass * .12 + bin * .11;
    float filament = pow(max(0., teeth), 18.) * exp(-abs(r - ring) * 5.);
    float crown = exp(-abs(r - ring - teeth * (.035 + high * .04)) * 55.);
    float lattice = pow(max(0., sin(a * 36. - r * 16. + time)), 14.)
      * exp(-r * 3.) * .06;
    ink = palette(tint + .4 + r * .17) * (filament * .27 + crown * .42 + lattice)
      + palette(tint + .02) * exp(-r * 18.) * bass * .1;
    previous = rotate((.012 + sin(time * .2) * .008) * delta) * p
      * (1. - (.019 + bass * .011) * delta);
    decay = .978;
  }
  vec2 oldUV = previous / vec2(resolution.x / resolution.y, 1.) * .5 + .5;
  float inside = step(0., oldUV.x) * step(oldUV.x, 1.) * step(0., oldUV.y) * step(oldUV.y, 1.);
  vec3 old = texture2D(history, oldUV).rgb * inside;
  // Screen blending retains saturated color without additive clipping to white.
  vec3 fresh = clamp(ink * activity * delta, 0., .95);
  vec3 result = 1. - (1. - old * pow(decay, delta)) * (1. - fresh);
  result *= 1. - .008 * smoothstep(.4, 1.5, r) * delta;
  gl_FragColor = vec4(result, 1.);
}
`;

export function createRetroRenderer(canvas: HTMLCanvasElement, mode: VisualizerMode, theme: AppTheme) {
  const gl = canvas.getContext("webgl", {
    alpha: false, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false, powerPreference: "low-power",
  });
  if (!gl) return undefined;
  const shaders: WebGLShader[] = [];
  function compile(type: number, source: string) {
    const shader = gl!.createShader(type)!;
    shaders.push(shader);
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error(gl!.getShaderInfoLog(shader) ?? "Visualizer shader failed");
    return shader;
  }
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Visualizer program failed");
  gl.useProgram(program);
  const vertices = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniforms = Object.fromEntries(["history", "signal", "resolution", "energy", "volume", "time", "delta", "mode", "theme", "present"]
    .map(name => [name, gl.getUniformLocation(program, name)]));
  const textures: WebGLTexture[] = [];
  function texture() {
    const value = gl!.createTexture()!;
    textures.push(value);
    gl!.bindTexture(gl!.TEXTURE_2D, value);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    return value;
  }
  const pictures = [texture(), texture()];
  const targets = pictures.map(() => gl.createFramebuffer()!);
  const signal = texture();
  const audioBytes = new Uint8Array(128 * 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 128, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, audioBytes);
  gl.uniform1i(uniforms.history, 0);
  gl.uniform1i(uniforms.signal, 1);
  gl.uniform1f(uniforms.mode, mode === "freestyle" ? 0 : mode === "ribbonDance" ? 1 : 2);
  gl.uniform1f(uniforms.theme, theme === "amber" ? .08 : theme === "phosphor" ? .27 : theme === "ice" ? .48 : .65);
  let width = 0, height = 0, front = 0, lastTime = 0, time = 0;
  let lastTimestamp: number | undefined;
  function clearHistory() {
    for (const target of targets) {
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, target);
      gl!.clearColor(0, 0, 0, 1);
      gl!.clear(gl!.COLOR_BUFFER_BIT);
    }
  }
  return {
    draw(frame: VisualizerFrame | undefined, now: number) {
      if (gl.isContextLost()) return;
      if (width !== canvas.width || height !== canvas.height) {
        width = canvas.width; height = canvas.height;
        gl.activeTexture(gl.TEXTURE0);
        for (let index = 0; index < 2; index++) {
          gl.bindTexture(gl.TEXTURE_2D, pictures[index]);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, targets[index]);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pictures[index], 0);
        }
        clearHistory();
      }
      if (frame && lastTimestamp !== undefined && Math.abs(frame.timestamp - lastTimestamp) > 1) clearHistory();
      lastTimestamp = frame?.timestamp;
      const delta = lastTime ? Math.min(3, (now - lastTime) / (1000 / 60)) : 1;
      lastTime = now;
      time += delta / 60 * (.6 + (frame?.mids ?? 0) * .45);
      for (let index = 0; index < 128; index++) {
        audioBytes[index * 4] = Math.round((frame?.frequencyBins[Math.floor(index / 2)] ?? 0) * 255);
        audioBytes[index * 4 + 1] = Math.round(((frame?.waveform[index] ?? 0) * .5 + .5) * 255);
        audioBytes[index * 4 + 2] = Math.round((frame?.vocalBins[Math.floor(index / 128 * 48)] ?? 0) * 255);
        audioBytes[index * 4 + 3] = 255;
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, signal);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 128, 1, gl.RGBA, gl.UNSIGNED_BYTE, audioBytes);
      gl.uniform2f(uniforms.resolution, width, height);
      gl.uniform4f(uniforms.energy, frame?.bassPulse ?? 0, frame?.bass ?? 0, frame?.mids ?? 0, frame?.treble ?? 0);
      gl.uniform1f(uniforms.volume, frame?.volume ?? 0);
      gl.uniform1f(uniforms.time, time);
      gl.uniform1f(uniforms.delta, delta);
      gl.uniform1f(uniforms.present, 0);
      gl.viewport(0, 0, width, height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, pictures[front]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[1 - front]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      front = 1 - front;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, pictures[front]);
      gl.uniform1f(uniforms.present, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      targets.forEach(target => gl.deleteFramebuffer(target));
      textures.forEach(value => gl.deleteTexture(value));
      shaders.forEach(shader => gl.deleteShader(shader));
      gl.deleteBuffer(vertices);
      gl.deleteProgram(program);
    },
  };
}
