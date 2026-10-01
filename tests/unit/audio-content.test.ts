import { describe, expect, it } from "vitest";
import {
  classifyContent, classifyWindows, contentFeatures, contentSegments, contentShares, QUALITY_SR, sourceHasMusic, speechBackgroundUnknown, VAD_HOP_SEC,
  type ContentLabel,
} from "../../engine/audio/src/index.js";

// Deterministic synthetic signals at 16 kHz (no media files): enough to pin the rules, not to measure them.
const SR = QUALITY_SR;
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const zeros = (sec: number) => new Float32Array(Math.round(sec * SR));
function add(dst: Float32Array, src: Float32Array, gain = 1) {
  for (let i = 0; i < dst.length; i++) dst[i]! += gain * (src[i] ?? 0);
  return dst;
}
/** Plucked notes from a scale (4 harmonics, decaying), one every `noteSec`. */
function melody(sec: number, noteSec = 0.25, seed = 1): Float32Array {
  const out = zeros(sec);
  const r = rng(seed);
  const scale = [262, 294, 330, 349, 392, 440, 494, 523];
  for (let t = 0; t < sec; t += noteSec) {
    const f0 = scale[Math.floor(r() * scale.length)]!;
    const a = Math.round(t * SR);
    const len = Math.round(Math.min(noteSec * 2, sec - t) * SR);
    for (let i = 0; i < len && a + i < out.length; i++) {
      const env = Math.exp(-i / (0.35 * SR));
      let v = 0;
      for (let h = 1; h <= 4; h++) v += Math.sin((2 * Math.PI * f0 * h * i) / SR) / h;
      out[a + i]! += 0.08 * env * v;
    }
  }
  return out;
}
/** Sustained chords changing every 2 s (a pad: few onsets, peaky spectrum). */
function pad(sec: number): Float32Array {
  const out = zeros(sec);
  const chords = [[262, 330, 392], [220, 277, 330], [175, 220, 262], [196, 247, 294]];
  for (let i = 0; i < out.length; i++) {
    const c = chords[Math.floor(i / SR / 2) % chords.length]!;
    let v = 0;
    for (const f of c) for (let h = 1; h <= 3; h++) v += Math.sin((2 * Math.PI * f * h * i) / SR) / h;
    out[i] = 0.05 * v;
  }
  return out;
}
function noise(sec: number, amp = 0.1, seed = 7): Float32Array {
  const r = rng(seed);
  return Float32Array.from({ length: Math.round(sec * SR) }, () => amp * (r() * 2 - 1));
}
function hum(sec: number): Float32Array {
  return Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => [50, 100, 150, 200, 250].reduce((v, f, h) => v + (0.03 / (h + 1)) * Math.sin((2 * Math.PI * f * i) / SR), 0));
}
/** A fake VAD track: speech probability 1 inside [from, to), 0 elsewhere. */
function vad(sec: number, from: number, to: number): Float32Array {
  return Float32Array.from({ length: Math.ceil(sec / VAD_HOP_SEC) }, (_, i) => (i * VAD_HOP_SEC >= from && i * VAD_HOP_SEC < to ? 1 : 0));
}
function labelsOf(x: Float32Array, speechProb?: Float32Array): ContentLabel[] {
  return classifyContent(contentFeatures(x, speechProb ? { speechProb } : {}));
}
const share = (ls: ContentLabel[], l: ContentLabel) => ls.filter((x) => x === l).length / ls.length;

describe("audio content: music vs noise vs silence (no speech)", () => {
  it("plucked notes are music", () => {
    expect(share(labelsOf(melody(12), vad(12, 99, 99)), "music")).toBeGreaterThan(0.9);
  });
  it("a slow pad of sustained chords is music at source level (few onsets, peaky spectrum)", () => {
    const x = pad(12);
    const ws = contentFeatures(x, { speechProb: vad(12, 99, 99) });
    const ls = classifyContent(ws);
    // Known limit (docs/measurements/audio-content.md): with chords held 2 s and no rhythm, the windows
    // between two chord changes see almost no onset and read as noise. The source decision holds.
    expect(share(ls, "music")).toBeGreaterThan(0.6);
    expect(sourceHasMusic(contentShares(contentSegments(ws, ls, 12)))).toBe(true);
  });
  it("broadband noise is noise, never music", () => {
    const ls = labelsOf(noise(12), vad(12, 99, 99));
    expect(share(ls, "noise")).toBe(1);
  });
  it("a stationary hum is tonal but is noise, not music", () => {
    const ls = labelsOf(add(hum(12), noise(12, 0.002)), vad(12, 99, 99));
    expect(ls.some((l) => l.includes("music"))).toBe(false);
  });
  it("digital silence and a −70 dBFS floor are silence", () => {
    expect(share(labelsOf(zeros(6), vad(6, 99, 99)), "silence")).toBe(1);
    expect(share(labelsOf(noise(6, 0.0005), vad(6, 99, 99)), "silence")).toBe(1);
  });
});

describe("audio content: a voice over a background (speech from the VAD)", () => {
  // The "voice" is any loud foreground: what is tested is how the background is read around it.
  const voice = (sec: number) => noise(sec, 0.2, 3);
  it("speech over a music bed is speech+music, even where the voice never pauses", () => {
    const x = add(melody(30), voice(30).map((v, i) => (i >= 6 * SR && i < 24 * SR ? v : 0)));
    const ls = labelsOf(x, vad(30, 6, 24));
    const during = ls.slice(14, 46); // windows inside 7–23 s
    expect(share(during, "speech+music")).toBeGreaterThan(0.9);
    expect(ls.slice(0, 10).every((l) => l === "music")).toBe(true);
  });
  it("speech over noise is speech+noise, and never music", () => {
    const x = add(noise(30, 0.05), voice(30).map((v, i) => (i >= 6 * SR && i < 24 * SR ? v : 0)));
    const ls = labelsOf(x, vad(30, 6, 24));
    expect(ls.some((l) => l.includes("music"))).toBe(false);
    expect(share(ls.slice(14, 46), "speech+noise")).toBeGreaterThan(0.9);
  });
  it("speech in silence is plain speech", () => {
    const x = voice(12).map((v, i) => (i >= 2 * SR && i < 10 * SR ? v : 0));
    const ls = labelsOf(x, vad(12, 2, 10));
    expect(share(ls.slice(6, 16), "speech")).toBe(1);
    expect(ls[0]).toBe("silence");
  });
});

describe("audio content: robustness", () => {
  it("an input shorter than one analysis frame yields no window and no music", () => {
    const ws = contentFeatures(zeros(0.02));
    expect(ws).toEqual([]);
    const segs = contentSegments(ws, [], 0.02);
    expect(sourceHasMusic(contentShares(segs))).toBe(false);
  });
  it("without a VAD the spectral-only fallback still separates music from noise", () => {
    expect(share(labelsOf(melody(12)), "music")).toBeGreaterThan(0.8);
    expect(labelsOf(noise(12)).some((l) => l.includes("music"))).toBe(false);
  });
});

describe("content segments and source decision", () => {
  const w = (i: number) => ({ start: i * 0.5, end: i * 0.5 + 1 }) as Parameters<typeof contentSegments>[0][number];
  it("merges equal neighbours and absorbs sub-second flicker", () => {
    const labels: ContentLabel[] = ["music", "music", "music", "noise", "music", "music", "music", "speech+music", "speech+music", "speech+music", "speech+music"];
    const segs = contentSegments(labels.map((_, i) => w(i)), labels, 6);
    expect(segs.map((s) => s.label)).toEqual(["music", "speech+music"]);
    expect(segs[0]!.start).toBe(0);
    expect(segs.at(-1)!.end).toBe(6);
  });
  it("music counts at ≥ 20 % of the non-silent duration", () => {
    expect(sourceHasMusic({ speech: 0.5, music: 0.1, noise: 0, silence: 0.5 })).toBe(true); // 10 / 50
    expect(sourceHasMusic({ speech: 0.9, music: 0.1, noise: 0, silence: 0 })).toBe(false);
    expect(sourceHasMusic({ speech: 0, music: 0, noise: 0, silence: 1 })).toBe(false);
  });
});

describe("audio content: regressions found by the benchmark", () => {
  it("an exact 50 Hz mains hum (perfectly periodic, no onsets) is not a beat", () => {
    const x = hum(20);
    const ls = labelsOf(x, vad(20, 99, 99));
    expect(ls.some((l) => l.includes("music"))).toBe(false);
  });
});

describe("audio content: what cannot be measured is said", () => {
  it("a voice covering the whole clip over music: background unmeasurable, flagged (documented limit)", () => {
    const x = add(melody(20), noise(20, 0.2, 3));
    const classes = classifyWindows(contentFeatures(x, { speechProb: vad(20, 0, 20) }));
    expect(classes.every((c) => c.label === "speech")).toBe(true);
    expect(speechBackgroundUnknown(classes)).toBeGreaterThan(0.9);
  });
  it("speech with pauses over a measurable background is not flagged", () => {
    const x = add(noise(30, 0.05), noise(30, 0.2, 3).map((v, i) => (i >= 6 * SR && i < 24 * SR ? v : 0)));
    expect(speechBackgroundUnknown(classifyWindows(contentFeatures(x, { speechProb: vad(30, 6, 24) })))).toBe(0);
  });
});
