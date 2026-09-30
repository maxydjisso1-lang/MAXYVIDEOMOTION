/**
 * Measurement passes built on FFmpeg's own analysis filters. Each returns plain numbers;
 * interpretation (what counts as "underexposed", "noisy"…) lives in the callers.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withTempDir, type Range } from "../../core/src/index.js";
import { ffmpeg, type RunOptions } from "./run.js";

const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));

export async function detectSilences(input: string, opts: { noiseDb?: number; minSec?: number } & RunOptions = {}): Promise<Range[]> {
  const { stderr } = await ffmpeg(
    ["-i", input, "-vn", "-af", `silencedetect=noise=${opts.noiseDb ?? -35}dB:d=${opts.minSec ?? 0.3}`, "-f", "null", "-"],
    { ...opts, captureStderr: true },
  );
  const out: Range[] = [];
  let start: number | undefined;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, num(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start !== undefined) {
      out.push({ start, end: num(e[1]) });
      start = undefined;
    }
  }
  return out;
}

export interface Loudness {
  integratedLufs: number;
  loudnessRange: number;
  truePeakDb: number;
}

export async function measureLoudness(input: string, opts: RunOptions & { streamSpec?: string } = {}): Promise<Loudness> {
  const { stderr } = await ffmpeg(["-i", input, "-vn", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], { ...opts, captureStderr: true });
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  return {
    integratedLufs: num(/I:\s+(-?[\d.]+|-inf) LUFS/.exec(summary)?.[1]?.replace("-inf", "-70")),
    loudnessRange: num(/LRA:\s+(-?[\d.]+) LU/.exec(summary)?.[1]),
    truePeakDb: num(/Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(summary)?.[1]?.replace("-inf", "-70")),
  };
}

/** RMS level (dBFS) of a range — used to estimate the noise floor inside detected silences. */
export async function rmsLevel(input: string, range: Range, opts: RunOptions = {}): Promise<number> {
  const { stderr } = await ffmpeg(
    ["-ss", String(range.start), "-t", String(Math.max(0.05, range.end - range.start)), "-i", input, "-vn", "-af", "astats=measure_perchannel=none:measure_overall=RMS_level", "-f", "null", "-"],
    { ...opts, captureStderr: true },
  );
  const v = /RMS level dB:\s+(-?[\d.]+|-inf)/.exec(stderr)?.[1];
  return v === undefined || v === "-inf" ? -90 : Number(v);
}

/**
 * Noise floor that works WITHOUT silences: RMS over 100 ms windows, 10th percentile. Continuous
 * speech still has micro-pauses between words, and those windows sit on the background noise.
 */
export async function estimateNoiseFloor(input: string, opts: RunOptions = {}): Promise<{ noiseFloorDb: number; windows: number }> {
  return withTempDir(async (dir) => {
    await ffmpeg(
      ["-i", resolve(input), "-vn", "-af", "aresample=48000,asetnsamples=n=4800:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=rms.txt", "-f", "null", "-"],
      { ...opts, cwd: dir },
    );
    const values = (await readFile(join(dir, "rms.txt"), "utf8"))
      .split(/\r?\n/)
      .map((l) => /RMS_level=(-?[\d.]+)/.exec(l)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number)
      .filter((v) => Number.isFinite(v) && v > -120)
      .sort((a, b) => a - b);
    if (!values.length) return { noiseFloorDb: -120, windows: 0 };
    return { noiseFloorDb: values[Math.floor(values.length * 0.1)]!, windows: values.length };
  });
}

export async function detectSceneCuts(input: string, opts: { threshold?: number } & RunOptions = {}): Promise<{ time: number; score: number }[]> {
  const { stderr } = await ffmpeg(
    ["-i", input, "-an", "-vf", `scale=320:-2,scdet=threshold=${opts.threshold ?? 10}`, "-f", "null", "-"],
    { ...opts, captureStderr: true },
  );
  const out: { time: number; score: number }[] = [];
  for (const m of stderr.matchAll(/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/g)) {
    out.push({ score: Math.min(1, num(m[1]) / 100), time: num(m[2]) });
  }
  return out;
}

export async function detectBlack(input: string, opts: { minSec?: number } & RunOptions = {}): Promise<Range[]> {
  const { stderr } = await ffmpeg(
    ["-i", input, "-an", "-vf", `scale=320:-2,blackdetect=d=${opts.minSec ?? 0.5}:pix_th=0.10`, "-f", "null", "-"],
    { ...opts, captureStderr: true },
  );
  return [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ start: num(m[1]), end: num(m[2]) }));
}

export interface FrameStats {
  t: number;
  yavg: number;
  ylow: number;
  yhigh: number;
  satavg: number;
  uavg: number;
  vavg: number;
}

/** Per-frame luma/chroma statistics, sampled at `fps` on a downscaled copy (fast on long files). */
export async function frameStats(input: string, opts: { fps?: number; start?: number; duration?: number } & RunOptions = {}): Promise<FrameStats[]> {
  return withTempDir(async (dir) => {
    const seek = opts.start !== undefined ? ["-ss", String(opts.start)] : [];
    const dur = opts.duration !== undefined ? ["-t", String(opts.duration)] : [];
    // metadata=print writes to a file relative to cwd: avoids escaping Windows paths in the graph.
    await ffmpeg(
      [...seek, ...dur, "-i", resolve(input), "-an", "-vf", `fps=${opts.fps ?? 2},scale=320:-2,format=yuv420p,signalstats,metadata=mode=print:file=stats.txt`, "-f", "null", "-"],
      { ...opts, cwd: dir },
    );
    const text = await readFile(join(dir, "stats.txt"), "utf8");
    const frames: FrameStats[] = [];
    let cur: Partial<FrameStats> = {};
    for (const line of text.split(/\r?\n/)) {
      const head = /pts_time:([\d.]+)/.exec(line);
      if (head) {
        if (cur.t !== undefined) frames.push(cur as FrameStats);
        cur = { t: num(head[1]) + (opts.start ?? 0) };
        continue;
      }
      const kv = /lavfi\.signalstats\.(\w+)=([\d.]+)/.exec(line);
      if (!kv) continue;
      const v = num(kv[2]);
      switch (kv[1]) {
        case "YAVG": cur.yavg = v; break;
        case "YLOW": cur.ylow = v; break;
        case "YHIGH": cur.yhigh = v; break;
        case "SATAVG": cur.satavg = v; break;
        case "UAVG": cur.uavg = v; break;
        case "VAVG": cur.vavg = v; break;
      }
    }
    if (cur.t !== undefined) frames.push(cur as FrameStats);
    return frames;
  });
}

/** PSNR between two videos of equal geometry (dB). Used by tests/QC to prove renders differ. */
export async function psnr(a: string, b: string, opts: RunOptions = {}): Promise<number> {
  const { stderr } = await ffmpeg(["-i", a, "-i", b, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"], { ...opts, captureStderr: true });
  const v = /PSNR .*average:([\d.]+|inf)/.exec(stderr)?.[1];
  return v === undefined ? NaN : v === "inf" ? Infinity : Number(v);
}

export async function extractFrame(input: string, atSec: number, outPath: string, opts: { width?: number } & RunOptions = {}): Promise<string> {
  await ffmpeg(["-ss", String(atSec), "-i", input, "-frames:v", "1", ...(opts.width ? ["-vf", `scale=${opts.width}:-2`] : []), "-q:v", "3", outPath], opts);
  return outPath;
}
