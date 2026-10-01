import { describe, expect, it } from "vitest";
import { DENOISE_POLICY, estimateSnrDb, guardMetrics, judge, QUALITY_SR, siSdrDb } from "../../engine/audio/src/index.js";

// Deterministic pseudo-random noise and a speech-like signal (syllable bursts of a 3-harmonic voice).
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
function voice(seconds: number): Float32Array {
  const x = new Float32Array(seconds * QUALITY_SR);
  for (let i = 0; i < x.length; i++) {
    const t = i / QUALITY_SR;
    const env = (t % 0.5) < 0.35 ? 1 : 0; // syllables with pauses
    x[i] = env * 0.3 * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 900 * t) + 0.3 * Math.sin(2 * Math.PI * 2200 * t));
  }
  return x;
}
function noise(n: number, amp: number, seed = 1): Float32Array {
  const r = rng(seed);
  return Float32Array.from({ length: n }, () => r() * amp);
}
const add = (a: Float32Array, b: Float32Array) => Float32Array.from(a, (v, i) => v + b[i]!);

describe("audio quality metrics", () => {
  const v = voice(6);

  it("SI-SDR: identical signals score very high, and it ignores gain", () => {
    expect(siSdrDb(v, v)).toBeGreaterThan(60);
    expect(siSdrDb(v, Float32Array.from(v, (x) => x * 0.3))).toBeGreaterThan(60);
  });
  it("SI-SDR: tracks the amount of added noise, and survives a small delay", () => {
    const light = siSdrDb(v, add(v, noise(v.length, 0.02)));
    const heavy = siSdrDb(v, add(v, noise(v.length, 0.2)));
    expect(light).toBeGreaterThan(heavy + 10);
    const delayed = new Float32Array(v.length);
    delayed.set(v.subarray(0, v.length - 160), 160); // 10 ms
    expect(siSdrDb(v, delayed)).toBeGreaterThan(40);
  });
  it("reference-free SNR estimate decreases as noise increases", () => {
    const a = estimateSnrDb(add(v, noise(v.length, 0.01)));
    const b = estimateSnrDb(add(v, noise(v.length, 0.05)));
    const c = estimateSnrDb(add(v, noise(v.length, 0.2)));
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });
  it("guard: unchanged audio = 0 dB voice change; a voice cut by 10 dB is seen as −10 dB", () => {
    const x = add(v, noise(v.length, 0.02));
    expect(guardMetrics(x, x).voiceLevelDeltaDb).toBe(0);
    expect(guardMetrics(x, Float32Array.from(x, (s) => s * 10 ** (-10 / 20))).voiceLevelDeltaDb).toBeCloseTo(-10, 0);
  });
  it("guard: removing only the noise keeps the voice level", () => {
    const n = noise(v.length, 0.02);
    const g = guardMetrics(add(v, n), v);
    expect(g.voiceLevelDeltaDb).toBeGreaterThan(-1);
    expect(g.snrAfterDb).toBeGreaterThan(g.snrBeforeDb);
  });
});

describe("denoise guard and policy", () => {
  const g = (voiceLevelDeltaDb: number, voiceSpectralChangeDb: number, snrBeforeDb: number, snrAfterDb: number) => ({ voiceLevelDeltaDb, voiceSpectralChangeDb, snrBeforeDb, snrAfterDb });

  it("accepts the measured good case (RNNoise 70 % at true 10 dB: voice −0.6 dB, timbre 0.1 dB, SNR +8)", () => {
    expect(judge(g(-0.6, 0.1, 15.4, 23.7)).accepted).toBe(true);
  });
  it("rejects a voice drop, a timbre change, or no real gain — with the reasons", () => {
    const r = judge(g(-3.7, 1.0, 7.1, 27.4)); // RNNoise 100 % at 0 dB: WER +19 points
    expect(r.accepted).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/voice level/);
    expect(r.reasons.join(" ")).toMatch(/timbre/);
    expect(judge(g(-0.1, 0.0, 22, 22.3)).reasons.join(" ")).toMatch(/SNR gain/);
  });
  it("never tries the strongest setting automatically", () => {
    expect(Math.max(...DENOISE_POLICY.candidates)).toBeLessThan(1);
    expect(DENOISE_POLICY.mediumSnrDb).toBeLessThan(DENOISE_POLICY.cleanSnrDb);
  });
});
