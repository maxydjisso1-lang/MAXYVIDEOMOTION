/**
 * Measure what the dialogue cleanup chain does to a real file: noise floor (10th percentile of
 * 100 ms RMS windows) and loudness before/after, per preset. Usage: tsx scripts/measure-cleanup.ts <media>
 */
import { dirname, join, resolve } from "node:path";
import { existsSync, REPO_ROOT, withTempDir } from "../engine/core/src/index.js";
import { buildDialogueChain, compileChain, type CleanupPreset } from "../engine/audio/src/index.js";
import { estimateNoiseFloor, ffmpeg, measureLoudness } from "../engine/ffmpeg/src/index.js";

const input = process.argv[2]!;
const before = await estimateNoiseFloor(input);
const loud = await measureLoudness(input);
console.log(`before: floor ${before.noiseFloorDb.toFixed(1)} dBFS, loudness ${loud.integratedLufs} LUFS, SNR≈${(loud.integratedLufs - before.noiseFloorDb).toFixed(1)} dB`);
// Neural denoiser (RNNoise via FFmpeg arnndn) when a model is present in models/rnnoise/.
const rnn = join(REPO_ROOT, "models/rnnoise/sh.rnnn");
if (existsSync(rnn)) {
  await withTempDir(async (dir) => {
    const out = join(dir, "rnn.wav");
    await ffmpeg(["-i", resolve(input), "-vn", "-af", "aresample=48000,arnndn=m=sh.rnnn", out], { cwd: dirname(rnn) });
    const f = await estimateNoiseFloor(out);
    const l = await measureLoudness(out);
    console.log(`${"rnnoise".padEnd(10)} floor ${f.noiseFloorDb.toFixed(1)} dBFS (${(f.noiseFloorDb - before.noiseFloorDb).toFixed(1)} dB), loudness ${l.integratedLufs} LUFS, SNR≈${(l.integratedLufs - f.noiseFloorDb).toFixed(1)} dB`);
  });
}
for (const preset of ["gentle", "standard", "aggressive"] as CleanupPreset[]) {
  await withTempDir(async (dir) => {
    const chain = buildDialogueChain({ noiseFloorDb: before.noiseFloorDb, noiseProfile: ["broadband"] }, preset);
    const out = join(dir, "out.wav");
    await ffmpeg(["-i", input, "-vn", "-af", compileChain(chain).join(","), out]);
    const f = await estimateNoiseFloor(out);
    const l = await measureLoudness(out);
    console.log(`${preset.padEnd(10)} floor ${f.noiseFloorDb.toFixed(1)} dBFS (${(f.noiseFloorDb - before.noiseFloorDb).toFixed(1)} dB), loudness ${l.integratedLufs} LUFS, SNR≈${(l.integratedLufs - f.noiseFloorDb).toFixed(1)} dB`);
  });
}
