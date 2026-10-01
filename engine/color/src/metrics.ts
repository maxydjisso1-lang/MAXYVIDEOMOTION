/**
 * Objective colour measurements (chantier 5). Pure functions on 8-bit RGB frames, plus one decoder
 * that states the YUV→RGB interpretation explicitly (matrix and range), so a measurement never
 * depends on FFmpeg's untagged defaults.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withTempDir } from "../../core/src/index.js";
import { ffmpeg, type RunOptions } from "../../ffmpeg/src/index.js";

export interface RgbFrame {
  width: number;
  height: number;
  /** Interleaved R'G'B' (gamma-encoded), 8 bits. */
  data: Uint8Array;
}

export type Matrix = "bt709" | "bt601";

/**
 * Decode `count` frames, `everySec` apart, as full-range RGB, interpreting the YUV with `matrix`
 * and limited (TV) range. Optional filters run on the YUV first (the pipeline under test).
 */
export async function decodeRgb(
  input: string,
  opts: { matrix: Matrix; count?: number; everySec?: number; start?: number; filters?: string[]; width?: number } & RunOptions,
): Promise<RgbFrame[]> {
  const count = opts.count ?? 1;
  const every = opts.everySec ?? 1;
  return withTempDir(async (dir) => {
    const out = join(dir, "frames.rgb");
    const pre = opts.filters?.length ? `${opts.filters.join(",")},` : "";
    const scale = opts.width ? `scale=${opts.width}:-2:flags=bicubic:` : "scale=";
    // in_color_matrix/in_range describe the YUV; the RGB is always full range.
    const vf = `${pre}fps=1/${every},${scale}in_color_matrix=${opts.matrix}:in_range=tv:out_range=pc,format=rgb24`;
    await ffmpeg([...(opts.start ? ["-ss", String(opts.start)] : []), "-i", resolve(input), "-an", "-vf", vf, "-frames:v", String(count), "-f", "rawvideo", out], { ...opts, cwd: dir });
    const buf = await readFile(out);
    const { width, height } = await frameSize(input, opts);
    const fw = opts.width ?? width;
    const fh = opts.width ? Math.round((height * opts.width) / width / 2) * 2 : height;
    const size = fw * fh * 3;
    const frames: RgbFrame[] = [];
    for (let o = 0; o + size <= buf.length; o += size) frames.push({ width: fw, height: fh, data: new Uint8Array(buf.subarray(o, o + size)) });
    return frames;
  });
}

async function frameSize(input: string, opts: RunOptions): Promise<{ width: number; height: number }> {
  const { probe } = await import("../../ffmpeg/src/index.js");
  void opts;
  const p = await probe(input);
  return { width: p.width ?? 0, height: p.height ?? 0 };
}

// ---------------------------------------------------------------- colour science

/** sRGB / BT.709 display EOTF, close enough for differences (the display interprets BT.709 this way). */
export const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const toGamma = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const LIN = Float64Array.from({ length: 256 }, (_, i) => toLinear(i / 255));

/** CIE L*a*b* (D65) of an 8-bit R'G'B' pixel. */
export function lab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r]!;
  const G = LIN[g]!;
  const B = LIN[b]!;
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference. */
export function deltaE2000([L1, a1, b1]: [number, number, number], [L2, a2, b2]: [number, number, number]): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h = (a: number, b: number) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1p = h(a1p, b1);
  const h2p = h(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lpm = (L1 + L2) / 2;
  const Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hpm = (h1p + h2p) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hpm - 30) * rad) + 0.24 * Math.cos(2 * hpm * rad) + 0.32 * Math.cos((3 * hpm + 6) * rad) - 0.2 * Math.cos((4 * hpm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm;
  const Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

// ---------------------------------------------------------------- frame statistics

/** Skin-like pixels (classic YCbCr box, BT.601 chroma on full-range RGB). */
export function skinMask(f: RgbFrame): Uint8Array {
  const m = new Uint8Array(f.width * f.height);
  for (let i = 0, p = 0; p < m.length; i += 3, p++) {
    const r = f.data[i]!;
    const g = f.data[i + 1]!;
    const b = f.data[i + 2]!;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    m[p] = y > 60 && y < 235 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173 ? 1 : 0;
  }
  return m;
}

export interface FrameMetrics {
  /** BT.709 luma Y' (0..1): mean and 5th / 95th percentiles. */
  lumaMean: number;
  lumaP05: number;
  lumaP95: number;
  /** Mean L*a*b*: a* (green−/red+) and b* (blue−/yellow+). A neutral scene sits near 0/0. */
  meanA: number;
  meanB: number;
  /** a* and b* of the darkest 5 % of pixels: the colour of the blacks. */
  shadowA: number;
  shadowB: number;
  /** Share of pixels with a channel at 0 or 255 (crushed or clipped). */
  clippedLow: number;
  clippedHigh: number;
  /** Empty luma levels inside the 2–98 % range: posterisation after a strong gain. */
  histogramHoles: number;
  /** Skin pixels (mask given by the caller): mean L*, chroma and hue angle. */
  skin?: { share: number; L: number; chroma: number; hue: number };
}

export function frameMetrics(f: RgbFrame, skin?: Uint8Array): FrameMetrics {
  const n = f.width * f.height;
  const hist = new Uint32Array(256);
  const ys = new Float32Array(n);
  let sa = 0;
  let sb = 0;
  let lo = 0;
  let hi = 0;
  let sk = 0;
  let sL = 0;
  let sA = 0;
  let sB = 0;
  const labs = new Float32Array(n * 2);
  for (let i = 0, p = 0; p < n; i += 3, p++) {
    const r = f.data[i]!;
    const g = f.data[i + 1]!;
    const b = f.data[i + 2]!;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    ys[p] = y / 255;
    hist[Math.round(y)]!++;
    const [L, A, B] = lab(r, g, b);
    labs[2 * p] = A;
    labs[2 * p + 1] = B;
    sa += A;
    sb += B;
    if (r === 0 || g === 0 || b === 0) lo++;
    if (r === 255 || g === 255 || b === 255) hi++;
    if (skin?.[p]) {
      sk++;
      sL += L;
      sA += A;
      sB += B;
    }
  }
  const sorted = Float32Array.from(ys).sort();
  const q = (x: number) => sorted[Math.min(n - 1, Math.floor(x * n))]!;
  // colour of the blacks
  const thr = q(0.05);
  let da = 0;
  let db = 0;
  let dn = 0;
  for (let p = 0; p < n; p++) {
    if (ys[p]! > thr) continue;
    da += labs[2 * p]!;
    db += labs[2 * p + 1]!;
    dn++;
  }
  // histogram holes between the 2 % and 98 % luma levels
  const l0 = Math.round(q(0.02) * 255);
  const l1 = Math.round(q(0.98) * 255);
  let holes = 0;
  for (let v = l0; v <= l1; v++) if (!hist[v]) holes++;
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    lumaMean: r4(ys.reduce((a, b) => a + b, 0) / n),
    lumaP05: r4(q(0.05)),
    lumaP95: r4(q(0.95)),
    meanA: r2(sa / n),
    meanB: r2(sb / n),
    shadowA: r2(dn ? da / dn : 0),
    shadowB: r2(dn ? db / dn : 0),
    clippedLow: r4(lo / n),
    clippedHigh: r4(hi / n),
    histogramHoles: l1 > l0 ? r4(holes / (l1 - l0 + 1)) : 0,
    ...(skin && sk ? { skin: { share: r4(sk / n), L: r2(sL / sk), chroma: r2(Math.hypot(sA / sk, sB / sk)), hue: r2(((Math.atan2(sB / sk, sA / sk) * 180) / Math.PI + 360) % 360) } } : {}),
  };
}

/** Mean CIEDE2000 between two frames of equal size (every 2nd pixel in both directions). */
export function meanDeltaE(a: RgbFrame, b: RgbFrame, mask?: Uint8Array): number {
  let s = 0;
  let n = 0;
  for (let y = 0; y < a.height; y += 2) {
    for (let x = 0; x < a.width; x += 2) {
      const p = y * a.width + x;
      if (mask && !mask[p]) continue;
      const i = 3 * p;
      s += deltaE2000(lab(a.data[i]!, a.data[i + 1]!, a.data[i + 2]!), lab(b.data[i]!, b.data[i + 1]!, b.data[i + 2]!));
      n++;
    }
  }
  return n ? Math.round((s / n) * 100) / 100 : 0;
}
