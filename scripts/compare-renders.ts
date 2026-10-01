/**
 * Quality comparison of rendered deliverables (chantier 6). Measures, does not decide.
 *
 * Video: VMAF, SSIM, PSNR (mean and worst frame) of each candidate against a reference — a single
 * frame of a caption or a motion element that differs shows up in the worst-frame PSNR.
 * Audio: decoded PCM compared sample by sample. Format: frames, duration, size.
 *
 * Usage: tsx scripts/compare-renders.ts --ref <ref.mp4> <a.mp4> [<b.mp4> …]
 */
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withTempDir } from "../engine/core/src/index.js";
import { ffmpeg, ffprobe } from "../engine/ffmpeg/src/index.js";

const argv = process.argv.slice(2);
const ref = resolve(argv[argv.indexOf("--ref") + 1]!);
const cands = argv.filter((a, i) => a !== "--ref" && argv[i - 1] !== "--ref").map((a) => resolve(a));

async function frames(file: string): Promise<{ frames: number; durationSec: number; bytes: number }> {
  const { stdout } = await ffprobe(["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames:format=duration", "-of", "json", file]);
  const j = JSON.parse(stdout) as { streams: { nb_read_frames: string }[]; format: { duration: string } };
  return { frames: Number(j.streams[0]!.nb_read_frames), durationSec: Number(j.format.duration), bytes: (await stat(file)).size };
}

async function video(a: string, b: string) {
  return withTempDir(async (dir) => {
    // both decoded as delivered (BT.709, TV range) to the same pixel format
    const { stderr } = await ffmpeg([
      "-i", a, "-i", b, "-lavfi",
      "[0:v]format=yuv420p,split=3[a1][a2][a3];[1:v]format=yuv420p,split=3[b1][b2][b3];[a1][b1]libvmaf=log_fmt=json:log_path=vmaf.json;[a2][b2]ssim;[a3][b3]psnr=stats_file=psnr.txt",
      "-f", "null", "-",
    ], { cwd: dir, captureStderr: true });
    const vmaf = JSON.parse(await readFile(join(dir, "vmaf.json"), "utf8")) as { pooled_metrics: { vmaf: { mean: number; min: number } } };
    const ssim = Number(/SSIM .*All:([\d.]+)/.exec(stderr)?.[1]);
    const psnrLines = (await readFile(join(dir, "psnr.txt"), "utf8")).split(/\r?\n/).filter(Boolean);
    const perFrame = psnrLines.map((l) => Number(/psnr_avg:([\d.]+|inf)/.exec(l)?.[1] === "inf" ? 100 : /psnr_avg:([\d.]+)/.exec(l)?.[1]));
    const r2 = (x: number) => Math.round(x * 100) / 100;
    return {
      vmafMean: r2(vmaf.pooled_metrics.vmaf.mean), vmafMin: r2(vmaf.pooled_metrics.vmaf.min), ssim: Math.round(ssim * 10000) / 10000,
      psnrMean: r2(perFrame.reduce((s, x) => s + x, 0) / perFrame.length), psnrWorstFrame: r2(Math.min(...perFrame)),
    };
  });
}

async function pcm(file: string): Promise<Int16Array> {
  return withTempDir(async (dir) => {
    await ffmpeg(["-i", file, "-vn", "-f", "s16le", "-ac", "2", "-ar", "48000", join(dir, "a.raw")]);
    const b = await readFile(join(dir, "a.raw"));
    return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2));
  });
}
async function audio(a: string, b: string) {
  const [x, y] = await Promise.all([pcm(a), pcm(b)]);
  const n = Math.min(x.length, y.length);
  let maxDiff = 0;
  let diffs = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(x[i]! - y[i]!);
    if (d) diffs++;
    if (d > maxDiff) maxDiff = d;
  }
  return { samples: [x.length, y.length], identical: x.length === y.length && diffs === 0, differingSamples: diffs, maxAbsDiff: maxDiff };
}

const refInfo = await frames(ref);
console.log(JSON.stringify({ ref, ...refInfo }));
for (const c of cands) {
  const row = { candidate: c, ...(await frames(c)), video: await video(c, ref), audio: await audio(c, ref) };
  console.log(JSON.stringify(row));
}
