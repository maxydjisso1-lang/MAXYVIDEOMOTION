/**
 * Denoising benchmark (chantier 2). Measures, does not decide.
 *
 * Controlled cases (clean reference known): the LibriVox fable span + real street noise at a TRUE
 * SNR (20, 10, 5, 0, −5 dB). Metrics: SI-SDR (vs clean voice), Whisper WER (small), voice-band
 * level change on speech windows, spectral change, reference-free SNR estimate.
 * Real cases (no reference): talking head, interview, noisy-audio fixture, street ambience alone.
 *
 * Usage: tsx scripts/bench-denoise.ts [--wer] [--methods none,afftdn,rnn100,rnn70,rnn40,dfn]
 * Results → docs/measurements/denoise.{json,md}
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson, REPO_ROOT } from "../engine/core/src/index.js";
import { decodePcm, estimateSnrDb, guardMetrics, siSdrDb } from "../engine/audio/src/index.js";
import { estimateNoiseFloor, ffmpeg, probe, rmsLevel } from "../engine/ffmpeg/src/index.js";
import { runWhisper, wordErrorRate } from "../engine/transcription/src/index.js";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return (i > 0 ? process.argv[i + 1]! : dflt).split(",");
};
const methods = arg("methods", "none,afftdn,rnn100,rnn70,rnn40");
const withWer = process.argv.includes("--wer");
const REAL = join(REPO_ROOT, "tests/fixtures/real");
const WORK = join(REPO_ROOT, "tests/.tmp/bench-denoise");
const RNN = join(REPO_ROOT, "models/rnnoise");
const DFN_PY = join(REPO_ROOT, "tests/.tmp/dfn-eval/.venv/Scripts/python.exe");
await mkdir(WORK, { recursive: true });

const ref = await readJson<{ fixture: string; span: { start: number; end: number }; text: string }>(join(REAL, "reference/cigale-fourmi.json"));
const clean = join(WORK, "clean.wav");
await ffmpeg(["-ss", String(ref.span.start), "-t", (ref.span.end - ref.span.start).toFixed(3), "-i", join(REAL, ref.fixture), "-ac", "1", "-ar", "48000", clean]);
const noise = join(WORK, "noise.wav");
await ffmpeg(["-i", join(REAL, "street-noise.mp4"), "-vn", "-ac", "1", "-ar", "48000", noise]);
const cleanRms = await rmsLevel(clean, { start: 0, end: (await probe(clean)).durationSec });
const noiseRms = await rmsLevel(noise, { start: 0, end: (await probe(noise)).durationSec });

async function mixAt(snr: number): Promise<string> {
  const out = join(WORK, `mix${snr}.wav`);
  await ffmpeg(["-i", clean, "-stream_loop", "-1", "-i", noise, "-filter_complex", `[1:a]volume=${(cleanRms - snr - noiseRms).toFixed(2)}dB[n];[0:a][n]amix=inputs=2:normalize=0:duration=first[a]`, "-map", "[a]", out]);
  return out;
}

async function apply(method: string, input: string, tag: string): Promise<string> {
  const out = join(WORK, `${tag}-${method}.wav`);
  if (method === "none") return input;
  if (method === "afftdn") {
    const floor = (await estimateNoiseFloor(input)).noiseFloorDb;
    await ffmpeg(["-i", input, "-af", `afftdn=nr=10:nf=${Math.round(Math.min(-20, Math.max(-80, floor)))}:tn=1`, "-ar", "48000", out]);
  } else if (method.startsWith("rnn")) {
    const mix = Number(method.slice(3)) / 100;
    await ffmpeg(["-i", input, "-af", `aresample=48000,arnndn=m=sh.rnnn:mix=${mix}`, out], { cwd: RNN });
  } else if (method === "dfn") {
    if (!existsSync(DFN_PY)) throw new Error("DeepFilterNet env missing");
    const { spawnSync } = await import("node:child_process");
    const code = `import truststore\ntruststore.inject_into_ssl()\nfrom df.enhance import enhance, init_df, load_audio, save_audio\nm,s,_=init_df()\na,_=load_audio(r"${input}", sr=s.sr())\nsave_audio(r"${out}", enhance(m,s,a), s.sr())`;
    const r = spawnSync(DFN_PY, ["-c", code], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`DeepFilterNet failed: ${r.stderr.slice(-800)}`);
  }
  return out;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const rows: Record<string, unknown>[] = [];
const refPcm = await decodePcm(clean);

console.log("== controlled (true SNR, clean reference)");
for (const snr of [20, 10, 5, 0, -5]) {
  const input = await mixAt(snr);
  const inPcm = await decodePcm(input);
  const sdrIn = siSdrDb(refPcm, inPcm);
  const werIn = withWer ? wordErrorRate(ref.text, (await runWhisper(input, { language: "fr" })).segments.map((s) => s.text).join(" ")).wer : undefined;
  for (const m of methods) {
    let out: string;
    try {
      out = await apply(m, input, `snr${snr}`);
    } catch (e) {
      console.log(`  skip ${m}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    const outPcm = await decodePcm(out);
    const g = guardMetrics(inPcm, outPcm);
    const sdr = siSdrDb(refPcm, outPcm);
    const wer = withWer ? wordErrorRate(ref.text, (await runWhisper(out, { language: "fr" })).segments.map((s) => s.text).join(" ")).wer : undefined;
    const row = { case: `controlled ${snr} dB`, trueSnrDb: snr, method: m, siSdrInDb: r1(sdrIn), siSdrOutDb: r1(sdr), siSdrGainDb: r1(sdr - sdrIn), ...g, ...(wer !== undefined ? { werIn: Math.round(werIn! * 1000) / 1000, werOut: Math.round(wer * 1000) / 1000 } : {}) };
    rows.push(row);
    console.log(`  SNR ${String(snr).padStart(3)} ${m.padEnd(7)} SI-SDR ${r1(sdrIn)}→${r1(sdr)} (${r1(sdr - sdrIn) >= 0 ? "+" : ""}${r1(sdr - sdrIn)})  voiceΔ ${g.voiceLevelDeltaDb}  spec ${g.voiceSpectralChangeDb}  estSNR ${g.snrBeforeDb}→${g.snrAfterDb}${wer !== undefined ? `  WER ${(werIn! * 100).toFixed(1)}→${(wer * 100).toFixed(1)}%` : ""}`);
  }
}

console.log("== real fixtures (no reference)");
for (const [name, file, start, dur] of [["talking-head", "talking-head.mp4", 0, 30], ["interview", "interview.mp4", 0, 30], ["noisy-audio", "noisy-audio.mp4", 0, 30], ["street only", "street-noise.mp4", 0, 30]] as const) {
  const input = join(WORK, `real-${name.replace(/\W/g, "")}.wav`);
  await ffmpeg(["-ss", String(start), "-t", String(dur), "-i", join(REAL, file), "-vn", "-ac", "1", "-ar", "48000", input]);
  const inPcm = await decodePcm(input);
  for (const m of methods) {
    let out: string;
    try {
      out = await apply(m, input, `real-${name.replace(/\W/g, "")}`);
    } catch (e) {
      console.log(`  skip ${m}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    const g = guardMetrics(inPcm, await decodePcm(out));
    rows.push({ case: name, method: m, ...g });
    console.log(`  ${name.padEnd(13)} ${m.padEnd(7)} voiceΔ ${g.voiceLevelDeltaDb}  spec ${g.voiceSpectralChangeDb}  estSNR ${g.snrBeforeDb}→${g.snrAfterDb}`);
  }
}

const dir = join(REPO_ROOT, "docs/measurements");
await mkdir(dir, { recursive: true });
await writeFile(join(dir, "denoise.json"), JSON.stringify({ date: new Date().toISOString(), methods, withWer, rows }, null, 2) + "\n");
console.log("written docs/measurements/denoise.json");
