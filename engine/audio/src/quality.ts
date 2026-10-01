/**
 * Objective audio quality measurements (chantier 2).
 *
 * Reference-free (usable in production, on any source):
 *   - estimateSnrDb: loudest-speech windows vs quietest windows, in the voice band.
 *   - voiceGuard:    does processing keep the voice? Level change of the voice band on the
 *                    windows where the INPUT is loudest (speech-dominated), plus spectral change.
 * With a clean reference (benchmarks only):
 *   - siSdrDb:       scale-invariant signal-to-distortion ratio, after delay alignment.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withTempDir } from "../../core/src/index.js";
import { ffmpeg } from "../../ffmpeg/src/index.js";

export const QUALITY_SR = 16000;
const WIN = QUALITY_SR / 10; // 100 ms

/** Mono float32 samples at 16 kHz, decoded by the engine's FFmpeg. */
export async function decodePcm(input: string, opts: { start?: number; duration?: number } = {}): Promise<Float32Array> {
  return withTempDir(async (dir) => {
    const out = join(dir, "pcm.f32");
    await ffmpeg([...(opts.start !== undefined ? ["-ss", String(opts.start)] : []), ...(opts.duration !== undefined ? ["-t", String(opts.duration)] : []), "-i", resolve(input), "-vn", "-ac", "1", "-ar", String(QUALITY_SR), "-f", "f32le", out]);
    const buf = await readFile(out);
    return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice();
  });
}

/** 2nd-order Butterworth biquad (RBJ cookbook). */
function biquad(x: Float32Array, type: "hp" | "lp", f0: number): Float32Array {
  const w0 = (2 * Math.PI * f0) / QUALITY_SR;
  const alpha = Math.sin(w0) / Math.SQRT2;
  const cos = Math.cos(w0);
  const [b0, b1, b2] = type === "lp" ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]!; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Telephone-band voice filter: where intelligibility lives, where street rumble mostly does not. */
export const voiceBand = (x: Float32Array) => biquad(biquad(x, "hp", 300), "lp", 3400);

const db = (p: number) => 10 * Math.log10(Math.max(p, 1e-12));

/** Mean power per 100 ms window. */
export function windowPowers(x: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + WIN <= x.length; i += WIN) {
    let s = 0;
    for (let j = i; j < i + WIN; j++) s += x[j]! * x[j]!;
    out.push(s / WIN);
  }
  return out;
}

function meanDb(powers: number[]): number {
  return db(powers.reduce((a, b) => a + b, 0) / Math.max(1, powers.length));
}

/** Indexes of the loudest `share` of windows (speech-dominated when the voice is above the noise). */
function loudestWindows(powers: number[], share: number): number[] {
  return powers.map((p, i) => [p, i] as const).sort((a, b) => b[0] - a[0]).slice(0, Math.max(1, Math.floor(powers.length * share))).map(([, i]) => i);
}

/**
 * Reference-free SNR estimate in the voice band: mean level of the loudest 20 % windows minus
 * mean level of the quietest 10 %. Biased (calibrated against true SNR in the benchmark), but
 * monotonic, and it is what production can measure.
 */
export function estimateSnrDb(x: Float32Array): number {
  const p = windowPowers(voiceBand(x)).sort((a, b) => a - b);
  if (p.length < 10) return 0;
  const quiet = p.slice(0, Math.max(1, Math.floor(p.length * 0.1)));
  const loud = p.slice(-Math.max(1, Math.floor(p.length * 0.2)));
  return Math.round((meanDb(loud) - meanDb(quiet)) * 10) / 10;
}

export interface GuardMetrics {
  /** Voice-band level change on the input's loudest (speech) windows, dB. Strongly negative = voice removed. */
  voiceLevelDeltaDb: number;
  /** Mean absolute spectral change of the speech windows across 1/3-octave voice bands, dB. */
  voiceSpectralChangeDb: number;
  snrBeforeDb: number;
  snrAfterDb: number;
}

/** 1/3-octave-ish voice bands for the spectral check. */
const BANDS: [number, number][] = [[300, 500], [500, 800], [800, 1250], [1250, 2000], [2000, 3400]];

function bandPowerOnWindows(x: Float32Array, lo: number, hi: number, idx: number[]): number {
  const y = biquad(biquad(x, "hp", lo), "lp", hi);
  const p = windowPowers(y);
  return meanDb(idx.map((i) => p[i] ?? 0));
}

export function guardMetrics(input: Float32Array, output: Float32Array): GuardMetrics {
  const n = Math.min(input.length, output.length);
  const a = input.subarray(0, n);
  const b = output.subarray(0, n);
  const vin = windowPowers(voiceBand(a));
  const vout = windowPowers(voiceBand(b));
  const speech = loudestWindows(vin, 0.2);
  const level = (p: number[]) => meanDb(speech.map((i) => p[i] ?? 0));
  const deltas = BANDS.map(([lo, hi]) => bandPowerOnWindows(b, lo, hi, speech) - bandPowerOnWindows(a, lo, hi, speech));
  const meanDelta = deltas.reduce((s, d) => s + d, 0) / deltas.length;
  return {
    voiceLevelDeltaDb: Math.round((level(vout) - level(vin)) * 10) / 10,
    // Shape change only: remove the common gain, keep how unevenly the bands moved.
    voiceSpectralChangeDb: Math.round((deltas.reduce((s, d) => s + Math.abs(d - meanDelta), 0) / deltas.length) * 10) / 10,
    snrBeforeDb: estimateSnrDb(a),
    snrAfterDb: estimateSnrDb(b),
  };
}

/** Scale-invariant SDR (dB) of `est` against `ref`, searching ±maxLagMs for the best alignment. */
export function siSdrDb(ref: Float32Array, est: Float32Array, maxLagMs = 60): number {
  const maxLag = Math.round((maxLagMs / 1000) * QUALITY_SR);
  const n = Math.min(ref.length, est.length) - 2 * maxLag;
  if (n <= 0) return -Infinity;
  let bestLag = 0;
  let best = -Infinity;
  // Coarse-to-fine lag search on the dot product.
  const dot = (lag: number, step: number) => {
    let s = 0;
    for (let i = maxLag; i < maxLag + n; i += step) s += ref[i]! * est[i + lag]!;
    return s;
  };
  for (let lag = -maxLag; lag <= maxLag; lag += 8) {
    const d = dot(lag, 4);
    if (d > best) { best = d; bestLag = lag; }
  }
  for (let lag = bestLag - 8; lag <= bestLag + 8; lag++) {
    const d = dot(lag, 1);
    if (d > best) { best = d; bestLag = lag; }
  }
  let rr = 0, re = 0;
  for (let i = maxLag; i < maxLag + n; i++) {
    rr += ref[i]! * ref[i]!;
    re += ref[i]! * est[i + bestLag]!;
  }
  const alpha = re / rr;
  let target = 0, noise = 0;
  for (let i = maxLag; i < maxLag + n; i++) {
    const t = alpha * ref[i]!;
    const e = est[i + bestLag]! - t;
    target += t * t;
    noise += e * e;
  }
  return Math.round(db(target / Math.max(noise, 1e-12)) * 100) / 100;
}
