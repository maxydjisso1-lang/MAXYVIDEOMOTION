/**
 * Transcription benchmark on REAL noise (chantier 1). Nothing here changes the engine: it measures it.
 *
 *   reference : La Fontaine's text (tests/fixtures/real/reference/cigale-fourmi.json)
 *   speech    : the matching span of the LibriVox reading (speech-fr fixture)
 *   noise     : real street ambience (street-noise fixture), looped, scaled to a target SNR
 *
 * SNR = RMS(speech span) − RMS(noise), both measured over their whole duration (dB).
 * For each model × VAD × SNR: WER (S/D/I), segment count, mean word probability, mean
 * no-speech probability, wall time. Results → docs/measurements/transcription-noise.{json,md}.
 *
 * Usage: tsx scripts/bench-transcription.ts [--models small,medium] [--snr clean,30,20,15,10,5,0] [--vad on,off]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readJson, REPO_ROOT } from "../engine/core/src/index.js";
import { ffmpeg, probe, rmsLevel } from "../engine/ffmpeg/src/index.js";
import { runWhisper, wordErrorRate, type WhisperRaw } from "../engine/transcription/src/index.js";

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return (i > 0 ? process.argv[i + 1]! : dflt).split(",");
};
const models = arg("models", "small");
const snrs = arg("snr", "clean,30,20,15,10,5,0");
const vads = arg("vad", "on,off");

const REAL = join(REPO_ROOT, "tests/fixtures/real");
const WORK = join(REPO_ROOT, "tests/.tmp/bench-transcription");
const ref = await readJson<{ fixture: string; span: { start: number; end: number }; text: string; language: string }>(join(REAL, "reference/cigale-fourmi.json"));
for (const f of [ref.fixture, "street-noise.mp4"]) if (!existsSync(join(REAL, f))) throw new Error(`Missing fixture ${f}: run npm run fixtures:real`);
await mkdir(WORK, { recursive: true });

const speech = join(WORK, "speech.wav");
await ffmpeg(["-ss", String(ref.span.start), "-t", (ref.span.end - ref.span.start).toFixed(3), "-i", join(REAL, ref.fixture), "-ac", "1", "-ar", "48000", speech]);
const speechDur = (await probe(speech)).durationSec;
const speechRms = await rmsLevel(speech, { start: 0, end: speechDur });
const noise = join(WORK, "noise.wav");
await ffmpeg(["-i", join(REAL, "street-noise.mp4"), "-vn", "-ac", "1", "-ar", "48000", noise]);
const noiseRms = await rmsLevel(noise, { start: 0, end: (await probe(noise)).durationSec });
console.log(`speech span ${speechDur.toFixed(1)} s, RMS ${speechRms.toFixed(1)} dBFS; street noise RMS ${noiseRms.toFixed(1)} dBFS`);

async function mix(snr: string): Promise<string> {
  if (snr === "clean") return speech;
  const out = join(WORK, `mix-snr${snr}.wav`);
  const gain = speechRms - Number(snr) - noiseRms;
  await ffmpeg(["-i", speech, "-stream_loop", "-1", "-i", noise, "-filter_complex", `[1:a]volume=${gain.toFixed(2)}dB[n];[0:a][n]amix=inputs=2:normalize=0:duration=first[a]`, "-map", "[a]", out]);
  return out;
}

interface Row {
  model: string;
  vad: boolean;
  snr: string;
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  segments: number;
  meanWordProb: number | null;
  meanNoSpeechProb: number | null;
  seconds: number;
  hypothesis: string;
}
const rows: Row[] = [];
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);

for (const model of models) {
  for (const vad of vads.map((v) => v === "on")) {
    for (const snr of snrs) {
      const input = await mix(snr);
      const t0 = Date.now();
      const raw: WhisperRaw = await runWhisper(input, { model, language: ref.language, vad });
      const seconds = Math.round((Date.now() - t0) / 100) / 10;
      const hyp = raw.segments.map((s) => s.text.trim()).join(" ");
      const w = wordErrorRate(ref.text, hyp);
      const row: Row = {
        model, vad, snr,
        wer: Math.round(w.wer * 1000) / 1000,
        substitutions: w.substitutions, deletions: w.deletions, insertions: w.insertions,
        segments: raw.segments.length,
        meanWordProb: mean(raw.segments.flatMap((s) => s.words.map((x) => x.probability))),
        meanNoSpeechProb: mean(raw.segments.map((s) => s.no_speech_prob ?? 0)),
        seconds,
        hypothesis: hyp,
      };
      rows.push(row);
      console.log(`${model.padEnd(7)} vad=${vad ? "on " : "off"} SNR ${snr.padStart(5)}  WER ${(row.wer * 100).toFixed(1).padStart(5)}%  (S${w.substitutions} D${w.deletions} I${w.insertions})  segs ${row.segments}  p̄ ${row.meanWordProb}  ${seconds}s`);
    }
  }
}

const out = join(REPO_ROOT, "docs/measurements");
await mkdir(out, { recursive: true });
await writeFile(join(out, "transcription-noise.json"), JSON.stringify({ date: new Date().toISOString(), reference: "tests/fixtures/real/reference/cigale-fourmi.json", referenceWords: wordErrorRate(ref.text, "").referenceWords, speechRmsDb: speechRms, noiseRmsDb: noiseRms, rows }, null, 2) + "\n");
const table = ["| model | VAD | SNR (dB) | WER | S / D / I | segments | mean word p | mean no-speech p | time |", "|---|---|---|---|---|---|---|---|---|"]
  .concat(rows.map((r) => `| ${r.model} | ${r.vad ? "on" : "off"} | ${r.snr} | **${(r.wer * 100).toFixed(1)} %** | ${r.substitutions} / ${r.deletions} / ${r.insertions} | ${r.segments} | ${r.meanWordProb ?? "—"} | ${r.meanNoSpeechProb ?? "—"} | ${r.seconds} s |`));
await writeFile(join(out, "transcription-noise.md"), `# Transcription vs real street noise\n\nGenerated by \`scripts/bench-transcription.ts\` on ${new Date().toISOString().slice(0, 10)} (CPU, int8).\nReference: La Fontaine, *La Cigale et la Fourmi* (${wordErrorRate(ref.text, "").referenceWords} words), read by a LibriVox volunteer; noise: real Liverpool street ambience, looped.\n\n${table.join("\n")}\n`);
console.log(`\nwritten: docs/measurements/transcription-noise.{json,md}`);
