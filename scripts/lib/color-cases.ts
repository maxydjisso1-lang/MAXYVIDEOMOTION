/**
 * Shared colour-measurement kit (chantier 5): the benchmark (scripts/bench-color.ts) and the real tests
 * (tests/real/color.test.ts) run exactly the same code, so a test reproduces a measured number.
 *
 * - clipFromRgb: real frames → a clip with an explicit matrix / range / tags (or none), lossless;
 * - enginePasses: replica of the two FFmpeg passes that touch colour (base plate, final encode), lossless;
 * - CASES / derive: degradations applied in LINEAR light to real frames (the frames are the ground truth);
 * - analyseShot: what the engine analysis records for a clip (frameStats + histograms → shotStats).
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg, frameStats, lumaHistograms, probe } from "../../engine/ffmpeg/src/index.js";
import { shotStats } from "../../engine/vision/src/analyze.js";
import { decodeRgb, frameMetrics, meanDeltaE, normalizeColorimetryFilter, toGamma, toLinear, type FrameMetrics, type RgbFrame } from "../../engine/color/src/index.js";

let WORK = "";
let FRAMES = 6;
export async function useWorkDir(dir: string, frames = 6): Promise<void> {
  WORK = dir;
  FRAMES = frames;
  await mkdir(dir, { recursive: true });
}

/** Encode RGB frames as a clip with an explicit matrix and tags (or none), lossless. */
export async function clipFromRgb(id: string, frames: RgbFrame[], enc: "bt709" | "bt601" | "untagged709" | "untagged601" | "bt709full"): Promise<string> {
  // the key includes the size: the same id at another resolution is another clip
  const out = join(WORK, `${id}-${enc}-${frames[0]!.width}x${frames[0]!.height}.mp4`);
  if (existsSync(out)) return out;
  const raw = join(WORK, `${id}-${enc}-${frames[0]!.width}x${frames[0]!.height}.rgb`);
  await writeFile(raw, Buffer.concat(frames.map((f) => Buffer.from(f.data))));
  const f0 = frames[0]!;
  const matrix = enc === "bt601" || enc === "untagged601" ? "bt601" : "bt709";
  const range = enc === "bt709full" ? "pc" : "tv";
  const tags = enc === "bt709full" ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "pc"] : enc === "bt709" ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"] : enc === "bt601" ? ["-color_primaries", "smpte170m", "-color_trc", "smpte170m", "-colorspace", "smpte170m", "-color_range", "tv"] : [];
  // each frame held 1 s (25 fps): the colour path sees real video, the metrics read one frame per second
  await ffmpeg(["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${f0.width}x${f0.height}`, "-r", "1", "-i", raw, "-vf", `fps=25,scale=out_color_matrix=${matrix}:out_range=${range},format=yuv444p`, "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p", ...tags, ...(enc.startsWith("untagged") ? ["-bsf:v", "h264_metadata=matrix_coefficients=2:colour_primaries=2:transfer_characteristics=2"] : []), out]);
  return out;
}

/**
 * The engine's two colour-relevant passes, with the engine's arguments (basePlate.ts, renderTarget.ts),
 * lossless and without the geometry. Returns the delivered file (tagged BT.709 like a real render).
 */
export async function enginePasses(src: string, color: string[], tag: string, opts: { normalize?: boolean } = {}): Promise<string> {
  const base = join(WORK, `${tag}.base.mp4`);
  const out = join(WORK, `${tag}.final.mp4`);
  const norm = opts.normalize ? [normalizeColorimetryFilter(await probe(src))] : [];
  const t0 = performance.now();
  await ffmpeg(["-i", src, "-filter_complex", `[0:v]${["setpts=PTS-STARTPTS", "fps=25", ...norm, ...color, "setsar=1", "format=yuv420p"].join(",")}[v]`, "-map", "[v]", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", base]);
  const baseMs = performance.now() - t0;
  await finalPass(base, out);
  timings[tag] = Math.round(baseMs);
  return out;
}
export const timings: Record<string, number> = {};

/** The final encode colour step (renderTarget.ts), lossless: tags the delivery BT.709. */
export async function finalPass(base: string, out: string): Promise<void> {
  await ffmpeg(["-i", base, "-vf", "scale=out_range=tv:out_color_matrix=bt709,format=yuv420p", "-color_range", "tv", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", out]);
}
export const delivered = (file: string) => decodeRgb(file, { matrix: "bt709", count: FRAMES, everySec: 1, start: 0.5 });

export const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
export const dE = (a: RgbFrame[], b: RgbFrame[], masks?: Uint8Array[]) => avg(a.map((f, i) => meanDeltaE(f, b[i]!, masks?.[i])));

export type Derive = (r: number, g: number, b: number, x: number) => [number, number, number];
/** Degradations in LINEAR light (what a camera would have recorded), x = horizontal position 0..1. */
export const CASES: Record<string, { what: string; fn: Derive | "flat" }> = {
  ok: { what: "correctly exposed (the real frame)", fn: (r, g, b) => [r, g, b] },
  "under-1.5": { what: "underexposed 1.5 EV", fn: (r, g, b) => [r * 2 ** -1.5, g * 2 ** -1.5, b * 2 ** -1.5] },
  "under-2.5": { what: "underexposed 2.5 EV (dark shot, large gain needed)", fn: (r, g, b) => [r * 2 ** -2.5, g * 2 ** -2.5, b * 2 ** -2.5] },
  "over+1": { what: "overexposed 1 EV, highlights clipped", fn: (r, g, b) => [r * 2, g * 2, b * 2] },
  "cast-warm": { what: "tungsten cast (R ×1.3, B ×0.7)", fn: (r, g, b) => [r * 1.3, g, b * 0.7] },
  "cast-cool": { what: "cool cast (R ×0.8, B ×1.25)", fn: (r, g, b) => [r * 0.8, g, b * 1.25] },
  "cast-green": { what: "fluorescent green cast (G ×1.2)", fn: (r, g, b) => [r, g * 1.2, b] },
  flat: { what: "low contrast (gamma values pulled 45 % toward mid-grey)", fn: "flat" },
  mixed: { what: "mixed light: warm on the left, cool on the right", fn: (r, g, b, x) => [r * (1.3 - 0.5 * x), g, b * (0.75 + 0.5 * x)] },
  "dark-warm": { what: "dark AND warm (−2 EV, R ×1.3, B ×0.7): large gains on a dark shot", fn: (r, g, b) => [r * 1.3 * 0.25, g * 0.25, b * 0.7 * 0.25] },
};

export function derive(frames: RgbFrame[], c: (typeof CASES)[string]): RgbFrame[] {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return frames.map((f) => {
    const out = new Uint8Array(f.data.length);
    for (let p = 0, i = 0; i < f.data.length; i += 3, p++) {
      const R = f.data[i]! / 255, G = f.data[i + 1]! / 255, B = f.data[i + 2]! / 255;
      if (c.fn === "flat") {
        out[i] = q(0.5 + (R - 0.5) * 0.55); out[i + 1] = q(0.5 + (G - 0.5) * 0.55); out[i + 2] = q(0.5 + (B - 0.5) * 0.55);
        continue;
      }
      const [r, g, b] = c.fn(toLinear(R), toLinear(G), toLinear(B), (p % f.width) / f.width);
      out[i] = q(toGamma(Math.min(1, r))); out[i + 1] = q(toGamma(Math.min(1, g))); out[i + 2] = q(toGamma(Math.min(1, b)));
    }
    return { ...f, data: out };
  });
}

/** What the engine's analysis would record for this clip as one shot. */
export async function analyseShot(clip: string) {
  const [frames, hists] = await Promise.all([frameStats(clip, { fps: 4 }), lumaHistograms(clip, { fps: 2 })]);
  const end = frames.at(-1)!.t + 0.25;
  return { id: "s001", start: 0, end, ...shotStats(frames, { start: 0, end }, 8, hists) };
}

const mean = (ms: FrameMetrics[], k: keyof FrameMetrics) => avg(ms.map((m) => m[k] as number));
const skinOf = (ms: FrameMetrics[]) => {
  const s = ms.map((m) => m.skin).filter((x): x is NonNullable<FrameMetrics["skin"]> => !!x);
  return s.length ? { L: avg(s.map((x) => x.L)), chroma: avg(s.map((x) => x.chroma)), hue: avg(s.map((x) => x.hue)) } : undefined;
};
export function summary(frames: RgbFrame[], masks?: Uint8Array[]) {
  const ms = frames.map((f, i) => frameMetrics(f, masks?.[i]));
  return {
    luma: mean(ms, "lumaMean"), contrast: avg(ms.map((m) => m.lumaP95 - m.lumaP05)), a: mean(ms, "meanA"), b: mean(ms, "meanB"),
    shadowA: mean(ms, "shadowA"), shadowB: mean(ms, "shadowB"), clipHigh: mean(ms, "clippedHigh"), clipLow: mean(ms, "clippedLow"), holes: mean(ms, "histogramHoles"),
    skin: skinOf(ms),
  };
}
