/**
 * Speech / music / noise / silence detection benchmark (chantier 4). Measures, does not decide.
 *
 * Corpus: tests/fixtures/real/reference/audio-content-corpus.json (real fixtures + synthetic cases).
 * Cases: each background alone, each speech alone, speech over each background at several levels,
 * hard cases (singing), synthetic silence / room tone / noise / hum. Ground truth per 1 s window:
 * background class from the corpus, speech presence from the CLEAN speech track's own activity.
 *
 * Splits: dev (thresholds chosen here), test (first held-out set, now seen), test2 (second held-out set).
 * Speech comes from the engine's own path (runVad → Silero VAD), cached per case file.
 *
 * Usage: tsx scripts/bench-content.ts [--split dev|test|test2|all] [--dump]
 * Results → docs/measurements/audio-content.{json,md} (with --split all)
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson, REPO_ROOT } from "../engine/core/src/index.js";
import {
  classifyContent, classifyWindows, contentFeatures, contentSegments, speechBackgroundUnknown, contentShares, decodePcm, frameActivity, FRAME_SEC as FRAME, sourceHasMusic,
  type ContentLabel, type WindowFeatures,
} from "../engine/audio/src/index.js";
import { runVad, sidecarAvailable } from "../engine/transcription/src/index.js";
import { detectSilences, ffmpeg, measureLoudness } from "../engine/ffmpeg/src/index.js";

interface Corpus {
  speech: { id: string; fixture: string; start: number; duration: number; split: string[] }[];
  music: { id: string; fixture: string; split: string }[];
  noise: { id: string; fixture: string; split: string }[];
  hard: { id: string; fixture: string; truth: "music" }[];
  synthetic: { id: string; lavfi: string; truth: "silence" | "noise" }[];
  mixLevelsDb: { music: number[]; noise: number[] };
}

const argv = process.argv.slice(2);
const split = argv.includes("--split") ? argv[argv.indexOf("--split") + 1]! : "dev";
const REAL = join(REPO_ROOT, "tests/fixtures/real");
const WORK = join(REPO_ROOT, "tests/.tmp/bench-content");
await mkdir(WORK, { recursive: true });
const corpus = await readJson<Corpus>(join(REAL, "reference/audio-content-corpus.json"));
const inSplit = (s: string | string[]) => split === "all" || (Array.isArray(s) ? s.includes(split) : s === split);
/** The split a speech source counts in for this run. */
const speechSplit = (s: string[]) => (split === "all" ? s[0]! : split);
const DUR = 30;
const SPEECH_AT = 6;
const SPEECH_LUFS = -23;

type Bg = "music" | "noise" | "none";
interface Case {
  id: string;
  kind: "background" | "speech" | "mix" | "mix-continuous" | "hard" | "synthetic";
  split: string;
  background: Bg | "silence";
  file: string;
  /** Speech activity per 16 ms frame of the case timeline (from the clean speech), or none. */
  speechActivity?: Float32Array;
  levelDb?: number;
  bgId?: string;
  speechId?: string;
}

// ------------------------------------------------------------- build the cases

async function wav(id: string, args: string[]): Promise<string> {
  const out = join(WORK, `${id}.wav`);
  if (!existsSync(out)) await ffmpeg([...args, "-ac", "1", "-ar", "48000", out]);
  return out;
}
/** A background, 30 s (looped when shorter), normalised to −23 LUFS (level must not be the cue). */
async function background(id: string, fixture: string): Promise<string> {
  const raw = await wav(`bg-raw-${id}`, ["-stream_loop", "-1", "-i", join(REAL, fixture), "-t", String(DUR), "-vn"]);
  const l = await measureLoudness(raw);
  return wav(`bg-${id}`, ["-i", raw, "-af", `volume=${(SPEECH_LUFS - l.integratedLufs).toFixed(2)}dB`]);
}
async function speech(s: Corpus["speech"][number]): Promise<string> {
  const raw = await wav(`sp-raw-${s.id}`, ["-ss", String(s.start), "-t", String(s.duration), "-i", join(REAL, s.fixture), "-vn"]);
  const l = await measureLoudness(raw);
  return wav(`sp-${s.id}`, ["-i", raw, "-af", `volume=${(SPEECH_LUFS - l.integratedLufs).toFixed(2)}dB`]);
}

const cases: Case[] = [];
const bgFiles = new Map<string, { file: string; cls: "music" | "noise"; split: string }>();
for (const m of corpus.music.filter((x) => inSplit(x.split))) bgFiles.set(m.id, { file: await background(m.id, m.fixture), cls: "music", split: m.split });
for (const n of corpus.noise.filter((x) => inSplit(x.split))) bgFiles.set(n.id, { file: await background(n.id, n.fixture), cls: "noise", split: n.split });
const spFiles = new Map<string, { file: string; split: string; splits: string[]; activity: Float32Array }>();
for (const s of corpus.speech.filter((x) => inSplit(x.split))) {
  const file = await speech(s);
  spFiles.set(s.id, { file, split: speechSplit(s.split), splits: s.split, activity: frameActivity(await decodePcm(file)) });
}

for (const [id, b] of bgFiles) if (inSplit(b.split)) cases.push({ id: `${b.cls}:${id}`, kind: "background", split: b.split, background: b.cls, file: b.file, bgId: id });
for (const [id, s] of spFiles) cases.push({ id: `speech:${id}`, kind: "speech", split: s.split, background: "none", file: s.file, speechActivity: s.activity, speechId: id });
for (const [sid, s] of spFiles) {
  for (const [bid, b] of bgFiles) {
    // dev mixes use dev material only; test mixes combine held-out speech AND held-out backgrounds
    if (!s.splits.includes(b.split) || !inSplit(b.split)) continue;
    for (const level of corpus.mixLevelsDb[b.cls]) {
      const id = `mix-${sid}-${bid}-${level}`;
      const file = await wav(id, ["-i", b.file, "-i", s.file, "-filter_complex", `[0:a]volume=${-level}dB[b];[1:a]adelay=${SPEECH_AT * 1000}:all=1,apad[s];[b][s]amix=inputs=2:normalize=0:duration=first[a]`, "-map", "[a]"]);
      const act = new Float32Array(Math.round(DUR / FRAME));
      act.set(s.activity, Math.round(SPEECH_AT / FRAME));
      cases.push({ id: `speech+${b.cls}:${sid}/${bid}@${level}`, kind: "mix", split: b.split, background: b.cls, file, speechActivity: act, levelDb: level, bgId: bid, speechId: sid });
      // Harder layout: the voice covers the whole clip, the background is never heard alone.
      const cid = `cmix-${sid}-${bid}-${level}`;
      const cfile = await wav(cid, ["-i", b.file, "-i", s.file, "-filter_complex", `[0:a]volume=${-level}dB[b];[b][1:a]amix=inputs=2:normalize=0:duration=shortest[a]`, "-map", "[a]"]);
      cases.push({ id: `speech+${b.cls} continuous:${sid}/${bid}@${level}`, kind: "mix-continuous", split: b.split, background: b.cls, file: cfile, speechActivity: s.activity, levelDb: level, bgId: bid, speechId: sid });
    }
  }
}
if (split === "test" || split === "all") {
  for (const h of corpus.hard) cases.push({ id: `hard:${h.id}`, kind: "hard", split: "test", background: "music", file: await background(h.id, h.fixture), bgId: h.id });
  for (const s of corpus.synthetic) cases.push({ id: `synthetic:${s.id}`, kind: "synthetic", split: "test", background: s.truth === "silence" ? "silence" : "noise", file: await wav(`syn-${s.id}`, ["-f", "lavfi", "-i", s.lavfi, "-t", "20"]) });
}
console.log(`${cases.length} cases (${split})`);

// ------------------------------------------------------------- ground truth per window


type Truth = { speech: boolean | null; background: Bg | "silence" };
function truthFor(c: Case, w: WindowFeatures): Truth {
  let speechTruth: boolean | null = false;
  if (c.speechActivity) {
    const a = Math.floor(w.start / FRAME);
    const b = Math.min(c.speechActivity.length, Math.floor(w.end / FRAME));
    let on = 0;
    for (let i = a; i < b; i++) on += c.speechActivity[i]!;
    const share = b > a ? on / (b - a) : 0;
    speechTruth = share >= 0.25 ? true : share <= 0.05 ? false : null; // in between: not scored
  }
  // A speech-only recording: the background in the pauses is the room (silence, or its own noise): not scored.
  return { speech: speechTruth, background: c.background };
}

// ------------------------------------------------------------- Silero VAD (reference speech detector)

/** Speech probabilities from the engine's own path (runVad), cached next to each case file. */
async function sileroProbs(files: string[]): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  if (!sidecarAvailable()) return out;
  for (const f of files) {
    const cache = `${f}.vad.json`;
    if (!existsSync(cache)) await writeFile(cache, JSON.stringify(Array.from((await runVad(f)).probs)));
    out.set(f, Float32Array.from(JSON.parse(await readFile(cache, "utf8")) as number[]));
  }
  return out;
}
const silero = await sileroProbs(cases.map((c) => c.file));

// ------------------------------------------------------------- the engine's behaviour before chantier 4

/** Before chantier 4: every non-silent range (silencedetect −35 dB) is "speech"; music is never detected. */
async function beforeLabels(file: string, ws: WindowFeatures[]): Promise<ContentLabel[]> {
  const sil = await detectSilences(file, { noiseDb: -35, minSec: 0.3 });
  return ws.map((w) => (sil.some((s) => s.start <= w.start + 0.25 && s.end >= w.end - 0.25) ? "silence" : "speech"));
}

// ------------------------------------------------------------- run

const METHODS = ["before", "vad", "dsp"] as const;
type Method = (typeof METHODS)[number];
interface Row {
  case: string;
  kind: Case["kind"];
  split: string;
  background: Truth["background"];
  level?: number;
  windows: { t: number; truth: Truth; labels: Record<Method, ContentLabel>; f: WindowFeatures }[];
}
const rows: Row[] = [];
for (const c of cases) {
  const pcm = await decodePcm(c.file);
  const speechProb = silero.get(c.file);
  const fv = contentFeatures(pcm, { speechProb });
  const fd = contentFeatures(pcm);
  const lv = classifyContent(fv);
  const ld = classifyContent(fd);
  const lb = await beforeLabels(c.file, fv);
  rows.push({
    case: c.id, kind: c.kind, split: c.split, background: c.background, level: c.levelDb,
    windows: fv.map((f, i) => ({ t: f.start, truth: truthFor(c, f), labels: { before: lb[i]!, vad: lv[i]!, dsp: ld[i]! }, f })),
  });
}

// ------------------------------------------------------------- metrics

type C3 = [number, number, number];
const has = (l: ContentLabel, x: "speech" | "music" | "noise") => (x === "speech" ? l.startsWith("speech") : l === x || l === `speech+${x}`);
function prf([tp, fp, fn]: C3) {
  const p = tp + fp ? tp / (tp + fp) : 1;
  const r = tp + fn ? tp / (tp + fn) : 1;
  return { tp, fp, fn, precision: Math.round(p * 1000) / 1000, recall: Math.round(r * 1000) / 1000, f1: Math.round(((2 * p * r) / (p + r || 1)) * 1000) / 1000 };
}
const bump = (c: C3, pred: boolean, truth: boolean) => {
  if (pred && truth) c[0]++;
  else if (pred && !truth) c[1]++;
  else if (!pred && truth) c[2]++;
};
/** Source-level decision: exactly what the engine ships (segments → shares → sourceHasMusic). */
function sourceMusic(r: Row, m: Method): boolean {
  const ws = r.windows.map((w) => w.f);
  return sourceHasMusic(contentShares(contentSegments(ws, r.windows.map((w) => w.labels[m]), ws.at(-1)?.end ?? 0)));
}
function score(sel: Row[], m: Method) {
  const speech: C3 = [0, 0, 0];
  const music: C3 = [0, 0, 0];
  const noise: C3 = [0, 0, 0];
  const silence: C3 = [0, 0, 0];
  const src: C3 = [0, 0, 0];
  for (const r of sel) {
    for (const w of r.windows) {
      const l = w.labels[m];
      if (w.truth.speech !== null) bump(speech, has(l, "speech"), w.truth.speech);
      if (r.kind === "speech") continue; // background of a speech-only recording: unknown, not scored
      bump(music, has(l, "music"), w.truth.background === "music");
      bump(noise, has(l, "noise"), w.truth.background === "noise");
      bump(silence, l === "silence", w.truth.background === "silence");
    }
    bump(src, sourceMusic(r, m), r.background === "music");
  }
  // sources where the engine says "background under the voice not measurable" (≥ 50 %): the documented limit, flagged
  const flagged = m === "vad" ? sel.filter((r) => speechBackgroundUnknown(classifyWindows(r.windows.map((w) => w.f))) >= 0.5).length : undefined;
  return { speech: prf(speech), music: prf(music), noise: prf(noise), silence: prf(silence), sourceMusic: prf(src), ...(flagged !== undefined ? { flaggedBackgroundUnknown: flagged } : {}) };
}

const groups: Record<string, Row[]> = {
  "music alone": rows.filter((r) => r.kind === "background" && r.background === "music"),
  "noise alone": rows.filter((r) => r.kind === "background" && r.background === "noise"),
  "speech alone": rows.filter((r) => r.kind === "speech"),
  "speech + music": rows.filter((r) => r.kind === "mix" && r.background === "music"),
  "speech + noise": rows.filter((r) => r.kind === "mix" && r.background === "noise"),
  "speech + music, continuous": rows.filter((r) => r.kind === "mix-continuous" && r.background === "music"),
  "speech + noise, continuous": rows.filter((r) => r.kind === "mix-continuous" && r.background === "noise"),
  "hard (singing)": rows.filter((r) => r.kind === "hard"),
  synthetic: rows.filter((r) => r.kind === "synthetic"),
  all: rows.filter((r) => r.kind !== "hard"),
};
const results: Record<string, Record<Method, ReturnType<typeof score>>> = {};
for (const [g, sel] of Object.entries(groups)) {
  if (!sel.length) continue;
  results[g] = Object.fromEntries(METHODS.map((m) => [m, score(sel, m)])) as Record<Method, ReturnType<typeof score>>;
  console.log(`\n## ${g} (${sel.length} cases)`);
  for (const m of METHODS) {
    const s = results[g][m];
    const f = (x: ReturnType<typeof prf>) => `P ${x.precision.toFixed(2)} R ${x.recall.toFixed(2)} (fp ${x.fp}, fn ${x.fn})`;
    console.log(`  ${m.padEnd(6)} speech ${f(s.speech)} | music ${f(s.music)} | noise ${f(s.noise)} | silence ${f(s.silence)} | source-music ${f(s.sourceMusic)}${s.flaggedBackgroundUnknown !== undefined ? ` | flagged-unknown ${s.flaggedBackgroundUnknown}` : ""}`);
  }
}
const perCase = rows.map((r) => {
  const shares = (m: Method) => {
    const counts: Record<string, number> = {};
    for (const w of r.windows) counts[w.labels[m]] = (counts[w.labels[m]] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((v / r.windows.length) * 100)]));
  };
  return { case: r.case, split: r.split, vad: shares("vad"), dsp: shares("dsp"), sourceMusic: { vad: sourceMusic(r, "vad"), dsp: sourceMusic(r, "dsp") } };
});
console.log("\n## per case (VAD method, label shares %)");
for (const p of perCase) console.log(`${p.case.padEnd(48)} ${p.sourceMusic.vad ? "MUSIC " : "      "}${Object.entries(p.vad).map(([k, v]) => `${k} ${v}`).join(", ")}`);
if (argv.includes("--dump")) await writeFile(join(WORK, `features-${split}.json`), JSON.stringify(rows));
if (split === "all") {
  const file = join(REPO_ROOT, "docs/measurements/audio-content.json");
  // leaf objects (metrics, label shares) on one line: readable diffs, small file
  const compact = (t: string) => t.replace(/\{[^{}[\]]*\}/g, (m) => m.replace(/\s*\n\s*/g, " "));
  await writeFile(file, compact(JSON.stringify({ date: new Date().toISOString(), corpus: "tests/fixtures/real/reference/audio-content-corpus.json", windowSec: 1, hopSec: 0.5, splits: Object.fromEntries(["dev", "test", "test2"].map((sp) => [sp, Object.fromEntries(Object.entries(groups).filter(([, sel]) => sel.some((r) => r.split === sp)).map(([g, sel]) => [g, { cases: sel.filter((r) => r.split === sp).length, ...Object.fromEntries(METHODS.map((m) => [m, score(sel.filter((r) => r.split === sp), m)])) }]))])), perCase: perCase.filter((_, i) => rows[i]!.kind !== "mix").map(({ case: c, split: sp, vad, sourceMusic }) => ({ case: c, split: sp, labels: vad, sourceMusic: sourceMusic.vad })), sourceMusicErrors: rows.filter((r) => sourceMusic(r, "vad") !== (r.background === "music")).map((r) => ({ case: r.case, split: r.split, detected: sourceMusic(r, "vad") })) }, null, 1)) + "\n");
  console.log(`written ${file}`);
}
