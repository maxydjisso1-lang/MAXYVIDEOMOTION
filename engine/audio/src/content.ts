/**
 * Audio content features (chantier 4): what is in a source — speech, music, ambient noise, silence.
 * Pure signal processing on the engine's 16 kHz mono decode; no model, no dependency.
 *
 * Features are computed per 1 s window (hop 0.5 s) from a 64 ms / 16 ms STFT.
 */
import { QUALITY_SR } from "./quality.js";

const N = 1024; // 64 ms at 16 kHz: 15.6 Hz bins, enough to follow the partials of notes
const HOP = 256; // 16 ms
export const FRAME_SEC = HOP / QUALITY_SR;
export const WINDOW_SEC = 1;
export const WINDOW_HOP_SEC = 0.5;
const BIN_HZ = QUALITY_SR / N;
const bin = (hz: number) => Math.round(hz / BIN_HZ);

// ---------------------------------------------------------------- FFT

const HANN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const REV = (() => {
  const bits = Math.log2(N);
  return Uint32Array.from({ length: N }, (_, i) => {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    return r;
  });
})();
const COS = Float64Array.from({ length: N / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / N));
const SIN = Float64Array.from({ length: N / 2 }, (_, i) => -Math.sin((2 * Math.PI * i) / N));

/** Power spectrum (bins 0..N/2) of one Hann-windowed frame. */
function powerSpectrum(x: Float32Array, start: number, re: Float64Array, im: Float64Array, out: Float64Array): void {
  for (let i = 0; i < N; i++) {
    const v = start + i < x.length ? x[start + i]! * HANN[i]! : 0;
    re[REV[i]!] = v;
    im[REV[i]!] = 0;
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let s = 0; s < N; s += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * step]!;
        const wi = SIN[k * step]!;
        const a = s + k;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
  for (let k = 0; k <= N / 2; k++) out[k] = (re[k]! * re[k]! + im[k]! * im[k]!) / N;
}

// ---------------------------------------------------------------- frame analysis

const db = (p: number) => 10 * Math.log10(Math.max(p, 1e-12));
const LO = bin(100);
const HI = bin(4000);
const PEAK_LO = bin(80);
const PEAK_HI = bin(5000);
/** 16 log-spaced bands, 40 Hz – 8 kHz, for the onset (flux) envelope. */
const FLUX_BANDS = Array.from({ length: 17 }, (_, i) => Math.max(1, bin(40 * 200 ** (i / 16))));

export interface Frames {
  /** Full-band frame level, dBFS. */
  levelDb: Float64Array;
  /** Voice-band (300–3400 Hz) frame level, dBFS. */
  voiceDb: Float64Array;
  /** Spectral flatness (geometric / arithmetic mean power) on 100–4000 Hz: 1 = white noise, → 0 = pure tones. */
  flatness: Float64Array;
  /** Spectral peaks per frame (bin indexes): prominent, narrow maxima. */
  peaks: Int32Array[];
  /** Power of each peak (its bin ± 1), same order as peaks. */
  peakPow: Float64Array[];
  /** Power in the peak search band (80–5000 Hz). */
  bandPow: Float64Array;
  /** Onset strength: summed rise of log energy over 16 bands (spectral flux). */
  flux: Float64Array;
  /** Power below 200 Hz, and total power (for the low-frequency share: kick drum and bass). */
  lowPow: Float64Array;
  allPow: Float64Array;
  count: number;
}

export function analyzeFrames(x: Float32Array): Frames {
  const count = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const p = new Float64Array(N / 2 + 1);
  const pdb = new Float64Array(N / 2 + 1);
  const levelDb = new Float64Array(count);
  const voiceDb = new Float64Array(count);
  const flatness = new Float64Array(count);
  const peaks: Int32Array[] = [];
  const peakPow: Float64Array[] = [];
  const bandPow = new Float64Array(count);
  const flux = new Float64Array(count);
  const lowPow = new Float64Array(count);
  const allPow = new Float64Array(count);
  const LOW = bin(200);
  const prevBands = new Float64Array(FLUX_BANDS.length - 1);
  const v0 = bin(300);
  const v1 = bin(3400);
  for (let f = 0; f < count; f++) {
    powerSpectrum(x, f * HOP, re, im, p);
    let all = 0;
    let voice = 0;
    let sum = 0;
    let logSum = 0;
    for (let k = 1; k <= N / 2; k++) {
      all += p[k]!;
      if (k <= LOW) lowPow[f]! += p[k]!;
      if (k >= v0 && k <= v1) voice += p[k]!;
      if (k >= LO && k <= HI) {
        sum += p[k]!;
        logSum += Math.log(p[k]! + 1e-20);
      }
      pdb[k] = db(p[k]!);
    }
    // Parseval with the Hann window: mean power ≈ sum / (N * 0.375) per sample.
    levelDb[f] = db((2 * all) / (N * 0.375));
    allPow[f] = all;
    voiceDb[f] = db((2 * voice) / (N * 0.375));
    const nb = HI - LO + 1;
    flatness[f] = sum > 0 ? Math.exp(logSum / nb) / (sum / nb) : 1;
    // Peaks: local maximum over ±2 bins, ≥ 10 dB above the local median (±12 bins), within 45 dB of the frame max.
    let maxDb = -Infinity;
    for (let k = PEAK_LO; k <= PEAK_HI; k++) {
      maxDb = Math.max(maxDb, pdb[k]!);
      bandPow[f]! += p[k]!;
    }
    const found: number[] = [];
    const nbh: number[] = [];
    for (let k = PEAK_LO; k <= PEAK_HI; k++) {
      const v = pdb[k]!;
      if (v < maxDb - 45 || v < -100) continue;
      if (!(v > pdb[k - 1]! && v >= pdb[k + 1]! && v > pdb[k - 2]! && v >= pdb[k + 2]!)) continue;
      nbh.length = 0;
      for (let j = k - 12; j <= k + 12; j++) if (j > 0 && j <= N / 2) nbh.push(pdb[j]!);
      nbh.sort((a, b) => a - b);
      if (v - nbh[nbh.length >> 1]! >= 10) found.push(k);
    }
    peaks.push(Int32Array.from(found));
    peakPow.push(Float64Array.from(found, (k) => p[k - 1]! + p[k]! + p[k + 1]!));
    let fx = 0;
    for (let b = 0; b + 1 < FLUX_BANDS.length; b++) {
      let e = 0;
      for (let k = FLUX_BANDS[b]!; k < FLUX_BANDS[b + 1]!; k++) e += p[k]!;
      const le = Math.log10(e + 1e-10);
      if (f > 0) fx += Math.max(0, le - prevBands[b]!);
      prevBands[b] = le;
    }
    flux[f] = fx;
  }
  return { levelDb, voiceDb, flatness, peaks, peakPow, bandPow, flux, lowPow, allPow, count };
}

// ---------------------------------------------------------------- partial tracks

export interface Track {
  start: number; // frame
  end: number; // frame, exclusive
  bin: number; // mean bin
  /** Power carried by the track in each of its frames (from frame start). */
  pow: number[];
}

/** Link spectral peaks frame to frame (±1 bin) into partial tracks. */
export function trackPartials(frames: Frames, maxGap = 1): Track[] {
  const done: Track[] = [];
  let open: { start: number; last: number; lastBin: number; sum: number; n: number; pow: number[] }[] = [];
  for (let f = 0; f < frames.count; f++) {
    const next: typeof open = [];
    const used = new Set<number>();
    const ps = frames.peaks[f]!;
    for (let j = 0; j < ps.length; j++) {
      const k = ps[j]!;
      const pw = frames.peakPow[f]![j]!;
      // the open track whose last bin is closest
      let best = -1;
      let bestD = 2;
      for (let i = 0; i < open.length; i++) {
        if (used.has(i)) continue;
        const d = Math.abs(open[i]!.lastBin - k);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) {
        used.add(best);
        const t = open[best]!;
        while (t.start + t.pow.length < f) t.pow.push(0); // bridged gap
        t.pow.push(pw);
        next.push({ start: t.start, last: f, lastBin: k, sum: t.sum + k, n: t.n + 1, pow: t.pow });
      } else next.push({ start: f, last: f, lastBin: k, sum: k, n: 1, pow: [pw] });
    }
    // tracks not continued survive a short gap, then close
    for (let i = 0; i < open.length; i++) {
      if (used.has(i)) continue;
      const t = open[i]!;
      if (f - t.last <= maxGap) next.push(t);
      else done.push({ start: t.start, end: t.last + 1, bin: t.sum / t.n, pow: t.pow });
    }
    open = next;
  }
  for (const t of open) done.push({ start: t.start, end: t.last + 1, bin: t.sum / t.n, pow: t.pow });
  return done;
}

// ---------------------------------------------------------------- window features

/** Silero VAD works on 512-sample chunks at 16 kHz: one speech probability per 32 ms. */
export const VAD_HOP_SEC = 512 / QUALITY_SR;

export interface ContentOptions {
  /** Speech probability per 32 ms chunk (Silero VAD). Without it, a weaker signal-only fallback decides speech. */
  speechProb?: Float32Array;
}

export interface WindowFeatures {
  start: number;
  end: number;
  /** Mean level, dBFS. */
  levelDb: number;
  /** Share of the window that is speech (VAD), or the fallback's 0/1 decision. */
  speech: number;
  /** Background = the frames WITHOUT speech (≥ 150 ms away from it) in a 3 s context around the window. */
  bgSec: number;
  /** Mean level of the background frames, dBFS. */
  bgLevelDb: number;
  /** Share of background frames crossed by a long partial (≥ 0.3 s, stationary tones excluded): held notes. */
  bgTonal: number;
  /** Share of the background's 80–5000 Hz energy carried by those long partials (music: its notes ARE the sound). */
  bgNoteEnergy: number;
  /** Long partials starting in background frames, per background second: note onsets. */
  bgNoteRate: number;
  /** Mean spectral flatness of the background frames (1 = white noise). */
  bgFlatness: number;
  /** Share of background frames holding a stationary tone (hum, fan, engine). */
  bgStationary: number;
  /** Mean onset strength of the background frames (summed log10 energy rise over 16 bands per frame). */
  bgOnset: number;
  /** Share of the background's energy below 200 Hz (a beat's kick drum and bass; a clock's tick has almost none). */
  bgLowShare: number;
  /**
   * Beat periodicity: peak normalised autocorrelation of the background onset envelope at 0.25–1 s
   * (60–240 BPM), 6 s context. null = not measurable (under 3 s of background there, e.g. during speech).
   */
  bgRhythm: number | null;
  /** Fallback speech cues: share of frames ≥ 10 dB under the loud ones, and voice-band level spread (dB). */
  lowEnergy: number;
  voiceVarDb: number;
}

export const CONTENT_PARAMS = {
  longTrackSec: 0.3,
  /** Share of the background frames holding a peak at one frequency above which that frequency is a stationary tone. */
  stationaryOccupancy: 0.9,
  vadThreshold: 0.5,
  /** Background must be confidently NOT speech: word edges below vadThreshold still carry voice partials. */
  backgroundMaxProb: 0.15,
  /** Frames this close to possible speech are not background (voice onsets, reverb tails). */
  speechGuardSec: 0.2,
  contextSec: 1,
  rhythmContextSec: 2.5,
};

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The fallback speech decision, window by window (thresholds from the dev split). */
export const DSP_SPEECH = { lowEnergy: 0.2, voiceVarDb: 5.5 };

export function contentFeatures(x: Float32Array, opts: ContentOptions = {}, params = CONTENT_PARAMS): WindowFeatures[] {
  const frames = analyzeFrames(x);
  const per = Math.round(WINDOW_SEC / FRAME_SEC);
  const hop = Math.round(WINDOW_HOP_SEC / FRAME_SEC);
  const starts: number[] = [];
  for (let s = 0; s < frames.count; s += hop) {
    starts.push(s);
    if (s + per >= frames.count) break;
  }

  // Per-window fallback cues (also reported with the VAD).
  const cues = starts.map((s) => {
    const e = Math.min(frames.count, s + per);
    const voice = Array.from(frames.voiceDb.subarray(s, e));
    const n = voice.length;
    const loud = [...voice].sort((a, b) => a - b)[Math.floor(n * 0.9)] ?? -120;
    const vm = voice.reduce((a, b) => a + b, 0) / n;
    return { lowEnergy: voice.filter((v) => v < loud - 10).length / n, voiceVarDb: Math.sqrt(voice.reduce((a, b) => a + (b - vm) ** 2, 0) / n) };
  });

  // Speech mask per STFT frame (speech), and frames that may hold voice (excluded from the background).
  const speech = new Uint8Array(frames.count);
  const voiced = new Uint8Array(frames.count);
  if (opts.speechProb) {
    for (let f = 0; f < frames.count; f++) {
      const t = (f * HOP + N / 2) / QUALITY_SR;
      const prob = opts.speechProb[Math.floor(t / VAD_HOP_SEC)] ?? 0;
      speech[f] = prob >= params.vadThreshold ? 1 : 0;
      voiced[f] = prob >= params.backgroundMaxProb ? 1 : 0;
    }
  } else {
    starts.forEach((s, i) => {
      const c = cues[i]!;
      if (c.lowEnergy >= DSP_SPEECH.lowEnergy && c.voiceVarDb >= DSP_SPEECH.voiceVarDb) speech.fill(1, s, Math.min(frames.count, s + per));
    });
    voiced.set(speech);
  }
  // Background = not speech and at least speechGuardSec away from it.
  const guard = Math.round(params.speechGuardSec / FRAME_SEC);
  const bg = new Uint8Array(frames.count).fill(1);
  for (let f = 0; f < frames.count; f++) if (voiced[f]) bg.fill(0, Math.max(0, f - guard), Math.min(frames.count, f + guard + 1));

  // Stationary tones (hum, fan, engine): a frequency holding a peak in ≥ half of the source's background
  // frames (all frames when there is little background). A note changes; these do not. They are taken
  // out of the note tracking and reported apart, so speech interrupting a hum cannot turn it into "notes".
  let refFrames = 0;
  for (let f = 0; f < frames.count; f++) refFrames += bg[f]!;
  const useBg = refFrames * FRAME_SEC >= 3;
  if (!useBg) refFrames = frames.count;
  const occupancy = new Float64Array(N / 2 + 2);
  for (let f = 0; f < frames.count; f++) {
    if (useBg && !bg[f]) continue;
    for (const k of frames.peaks[f]!) for (let j = k - 1; j <= k + 1; j++) occupancy[j]! += 1 / refFrames;
  }
  const stat = new Uint8Array(frames.count);
  const keepIdx = frames.peaks.map((ps) => Array.from(ps.keys()).filter((j) => occupancy[ps[j]!]! < params.stationaryOccupancy));
  keepIdx.forEach((idx, f) => {
    if (idx.length < frames.peaks[f]!.length) stat[f] = 1;
  });
  const toned: Frames = {
    ...frames,
    peaks: frames.peaks.map((ps, f) => Int32Array.from(keepIdx[f]!, (j) => ps[j]!)),
    peakPow: frames.peakPow.map((pp, f) => Float64Array.from(keepIdx[f]!, (j) => pp[j]!)),
  };
  const tracks = trackPartials(toned);
  const long = Math.round(params.longTrackSec / FRAME_SEC);
  const notes = new Uint8Array(frames.count);
  const noteEnergy = new Float64Array(frames.count);
  const onsets = new Uint16Array(frames.count);
  for (const t of tracks) {
    if (t.end - t.start < long) continue;
    notes.fill(1, t.start, t.end);
    t.pow.forEach((pw, i) => (noteEnergy[t.start + i]! += pw));
    onsets[t.start]!++;
  }

  const ctx = Math.round(params.contextSec / FRAME_SEC);
  const rctx = Math.round(params.rhythmContextSec / FRAME_SEC);
  const lag0 = Math.round(0.25 / FRAME_SEC);
  const lag1 = Math.round(1 / FRAME_SEC);
  /** Masked, mean-removed autocorrelation of the onset envelope over background frames only. */
  const rhythmAt = (a: number, b: number): number | null => {
    let n = 0;
    let m = 0;
    for (let f = a; f < b; f++) if (bg[f]) { m += frames.flux[f]!; n++; }
    if (n < lag1 * 3) return null;
    m /= n;
    let best = 0;
    for (let l = lag0; l <= lag1; l++) {
      let xy = 0;
      let xx = 0;
      let yy = 0;
      for (let f = a; f + l < b; f++) {
        if (!bg[f] || !bg[f + l]) continue;
        const x = frames.flux[f]! - m;
        const y = frames.flux[f + l]! - m;
        xy += x * y;
        xx += x * x;
        yy += y * y;
      }
      if (xx > 0 && yy > 0) best = Math.max(best, xy / Math.sqrt(xx * yy));
    }
    return best;
  };
  return starts.map((s, i) => {
    const e = Math.min(frames.count, s + per);
    let lin = 0;
    let sp = 0;
    for (let f = s; f < e; f++) {
      lin += 10 ** (frames.levelDb[f]! / 10);
      sp += speech[f]!;
    }
    let nb = 0;
    let bgLin = 0;
    let ton = 0;
    let ons = 0;
    let flat = 0;
    let st = 0;
    let ne = 0;
    let be = 0;
    let lowE = 0;
    let allE = 0;
    let fluxSum = 0;
    for (let f = Math.max(0, s - ctx); f < Math.min(frames.count, e + ctx); f++) {
      if (!bg[f]) continue;
      nb++;
      ne += noteEnergy[f]!;
      be += frames.bandPow[f]!;
      lowE += frames.lowPow[f]!;
      allE += frames.allPow[f]!;
      fluxSum += frames.flux[f]!;
      bgLin += 10 ** (frames.levelDb[f]! / 10);
      ton += notes[f]!;
      ons += onsets[f]!;
      flat += frames.flatness[f]!;
      st += stat[f]!;
    }
    const n = e - s;
    const bgSec = nb * FRAME_SEC;
    return {
      start: r3(s * FRAME_SEC),
      end: r3(e * FRAME_SEC),
      levelDb: r1(db(lin / n)),
      speech: r3(sp / n),
      bgSec: r3(bgSec),
      bgLevelDb: nb ? r1(db(bgLin / nb)) : -120,
      bgTonal: nb ? r3(ton / nb) : 0,
      bgNoteEnergy: be > 0 ? r3(ne / be) : 0,
      bgNoteRate: nb ? r1(ons / bgSec) : 0,
      bgFlatness: nb ? r3(flat / nb) : 0,
      bgStationary: nb ? r3(st / nb) : 0,
      bgLowShare: allE > 0 ? r3(lowE / allE) : 0,
      bgOnset: nb ? r3(fluxSum / nb) : 0,
      bgRhythm: ((r) => (r === null ? null : r3(r)))(rhythmAt(Math.max(0, s - rctx), Math.min(frames.count, e + rctx))),
      lowEnergy: r3(cues[i]!.lowEnergy),
      voiceVarDb: r1(cues[i]!.voiceVarDb),
    };
  });
}

// ---------------------------------------------------------------- classification

export type ContentLabel = "silence" | "noise" | "music" | "speech" | "speech+noise" | "speech+music";
type Background = "silence" | "noise" | "music";

/** Thresholds: chosen on the dev split of scripts/bench-content.ts, checked on the held-out split. */
export const CLASSIFY = {
  speechShare: 0.3,
  silenceDb: -55,
  /** Less background than this in the 3 s context: borrow the nearest window's background. */
  minBgSec: 1,
  borrowWithinSec: 10,
  /**
   * Held notes carrying a real share of the background's energy, AND (frequent note onsets, OR slower
   * onsets over a peaky spectrum: pads, sustained chords).
   */
  music: { tonal: 0.6, noteEnergy: 0.1, noteRate: 4, slowNoteRate: 1.5, maxFlatness: 0.05 },
  /** Beat music without held notes (electronic, drums + bass): periodic onsets AND low-frequency weight. */
  beat: { rhythm: 0.4, lowShare: 0.15, minOnset: 0.5 },
};

function backgroundOf(w: WindowFeatures, p: typeof CLASSIFY): Background | undefined {
  if (w.bgSec < p.minBgSec) return undefined;
  if (w.bgLevelDb < p.silenceDb) return "silence";
  const m = p.music;
  const notes = w.bgNoteRate >= m.noteRate || (w.bgNoteRate >= m.slowNoteRate && w.bgFlatness <= m.maxFlatness);
  const tonal = w.bgTonal >= m.tonal && w.bgNoteEnergy >= m.noteEnergy && notes;
  if (tonal) return "music";
  // Not tonal, and the beat cannot be measured here: undecided, borrow the nearest decided background.
  if (w.bgRhythm === null) return undefined;
  // A perfectly steady tone has a periodic but negligible onset envelope (min real recording measured: 1.0).
  const beat = w.bgOnset >= p.beat.minOnset && w.bgRhythm >= p.beat.rhythm && w.bgLowShare >= p.beat.lowShare;
  return beat ? "music" : "noise";
}

export interface WindowClass {
  label: ContentLabel;
  /** false = speech whose background could not be measured (no pause nor background heard alone within reach). */
  backgroundMeasured: boolean;
}

export function classifyWindows(ws: WindowFeatures[], p = CLASSIFY): WindowClass[] {
  const own = ws.map((w) => backgroundOf(w, p));
  return ws.map((w, i) => {
    if (w.levelDb < p.silenceDb) return { label: "silence", backgroundMeasured: true };
    let b = own[i];
    // Continuous speech: the background is the one heard in the nearest pause (a music bed does not stop).
    for (let d = 1; b === undefined && d * WINDOW_HOP_SEC <= p.borrowWithinSec; d++) b = own[i - d] ?? own[i + d];
    const speech = w.speech >= p.speechShare;
    if (!speech) return { label: b ?? "noise", backgroundMeasured: b !== undefined };
    return { label: b === "music" ? "speech+music" : b === "noise" ? "speech+noise" : "speech", backgroundMeasured: b !== undefined };
  });
}

export function classifyContent(ws: WindowFeatures[], p = CLASSIFY): ContentLabel[] {
  return classifyWindows(ws, p).map((c) => c.label);
}

/**
 * Share of the windows holding speech whose background could not be measured. Measured limit
 * (docs/measurements/audio-content.md): a music bed heard ONLY under continuous speech is not detected,
 * so on these stretches music cannot be ruled out.
 */
export function speechBackgroundUnknown(classes: WindowClass[]): number {
  return classes.length ? r3(classes.filter((c) => !c.backgroundMeasured && c.label.startsWith("speech")).length / classes.length) : 0;
}

/**
 * Speech activity of a CLEAN speech track per STFT frame (benchmark ground truth): voice-band level
 * within 30 dB of the loud frames, gaps shorter than 200 ms filled (between syllables).
 */
export function frameActivity(x: Float32Array): Float32Array {
  const fr = analyzeFrames(x);
  const sorted = Array.from(fr.voiceDb).sort((a, b) => a - b);
  const ref = sorted[Math.floor(sorted.length * 0.95)] ?? -120;
  const act = Float32Array.from(fr.voiceDb, (v) => (v > ref - 30 && v > -60 ? 1 : 0));
  const gap = Math.round(0.2 / FRAME_SEC);
  let last = -1;
  for (let i = 0; i < act.length; i++) {
    if (!act[i]) continue;
    if (last >= 0 && i - last > 1 && i - last <= gap) for (let j = last + 1; j < i; j++) act[j] = 1;
    last = i;
  }
  return act;
}

// ---------------------------------------------------------------- source summary

export interface ContentSegment {
  start: number;
  end: number;
  label: ContentLabel;
}

/**
 * Window labels → time segments: each window speaks for the 0.5 s around its centre; equal neighbours
 * merge; a segment shorter than minSec is absorbed by its longer neighbour (no 0.5 s flicker).
 */
export function contentSegments(ws: WindowFeatures[], labels: ContentLabel[], durationSec: number, minSec = 1): ContentSegment[] {
  const segs: ContentSegment[] = [];
  ws.forEach((w, i) => {
    const c = (w.start + w.end) / 2;
    const start = i === 0 ? 0 : c - WINDOW_HOP_SEC / 2;
    const end = i === ws.length - 1 ? durationSec : c + WINDOW_HOP_SEC / 2;
    const last = segs.at(-1);
    if (last && last.label === labels[i]) last.end = end;
    else segs.push({ start, end, label: labels[i]! });
  });
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < segs.length && segs.length > 1; i++) {
      const s = segs[i]!;
      if (s.end - s.start >= minSec) continue;
      const prev = segs[i - 1];
      const next = segs[i + 1];
      const into = !prev ? next! : !next ? prev : prev.end - prev.start >= next.end - next.start ? prev : next;
      into.start = Math.min(into.start, s.start);
      into.end = Math.max(into.end, s.end);
      segs.splice(i, 1);
      // merge the now-adjacent equal neighbours
      for (let j = 1; j < segs.length; j++) {
        if (segs[j]!.label === segs[j - 1]!.label) {
          segs[j - 1]!.end = segs[j]!.end;
          segs.splice(j, 1);
          j--;
        }
      }
      changed = true;
      break;
    }
  }
  return segs.map((s) => ({ start: r3(s.start), end: r3(s.end), label: s.label }));
}

export interface ContentShares {
  speech: number;
  music: number;
  noise: number;
  silence: number;
}

/** Share of the source's duration holding each class (speech+music counts for speech AND music). */
export function contentShares(segs: ContentSegment[]): ContentShares {
  const total = segs.reduce((a, s) => a + (s.end - s.start), 0) || 1;
  const share = (pred: (l: ContentLabel) => boolean) => r3(segs.filter((s) => pred(s.label)).reduce((a, s) => a + (s.end - s.start), 0) / total);
  return {
    speech: share((l) => l.startsWith("speech")),
    music: share((l) => l === "music" || l === "speech+music"),
    noise: share((l) => l === "noise" || l === "speech+noise"),
    silence: share((l) => l === "silence"),
  };
}

/**
 * Source-level decision (what the denoiser reads): music in ≥ 20 % of the NON-silent duration.
 * Measured at source level in docs/measurements/audio-content.md.
 */
export const SOURCE_MUSIC_SHARE = 0.2;
export function sourceHasMusic(shares: ContentShares): boolean {
  const live = 1 - shares.silence;
  return live > 0 && shares.music / live >= SOURCE_MUSIC_SHARE;
}
