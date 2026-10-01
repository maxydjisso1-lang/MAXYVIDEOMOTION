import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BveError, existsSync, readJson, REPO_ROOT, SCHEMA_VERSION, validate, withTempDir, type Analysis, type Project, type Transcript,
} from "../../core/src/index.js";
import { ffmpeg } from "../../ffmpeg/src/index.js";

type TranscriptSource = Transcript["sources"][number];

export interface TranscribeOptions {
  language?: string;
  model?: string;
}

/** Any speech-to-text backend. It must return word-level timestamps in SOURCE time. */
export interface TranscriptionProvider {
  readonly id: string;
  available(): Promise<boolean>;
  transcribe(project: Project, sourceId: string, opts: TranscribeOptions): Promise<{ language: string; model: string; source: TranscriptSource }>;
}

const FILLERS: Record<string, string[]> = {
  fr: ["euh", "heu", "hum", "bah", "ben", "euhm"],
  en: ["um", "uh", "erm", "hmm", "uhm"],
};

/** Mark hesitations so the editor can remove them on request. */
export function markFillers(source: TranscriptSource, language: string): TranscriptSource {
  const set = new Set([...(FILLERS[language.slice(0, 2)] ?? []), ...FILLERS.fr!, ...FILLERS.en!]);
  for (const seg of source.segments) {
    for (const w of seg.words) {
      const bare = w.w.toLowerCase().replace(/[^\p{L}]/gu, "");
      if (set.has(bare)) w.filler = true;
    }
  }
  return source;
}

// ---------------------------------------------------------------- faster-whisper (Python sidecar)

function pythonBin(): string {
  if (process.env.BVE_PYTHON) return process.env.BVE_PYTHON;
  const venv = join(REPO_ROOT, "engine/python/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return venv;
}

export interface WhisperRaw {
  language: string;
  language_probability?: number;
  model: string;
  device?: string;
  vad?: boolean;
  segments: { start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number; words: { word: string; start: number; end: number; probability: number }[] }[];
}

export interface RunWhisperOptions {
  model?: string;
  language?: string;
  /** Silero VAD pre-filter (default on). Off only for diagnostics. */
  vad?: boolean;
  log?: Project["log"];
}

/**
 * The single path to Whisper, shared by the project provider and the benchmarks: decode any media
 * with the engine's FFmpeg to 16 kHz mono, run the Python sidecar, return its raw output.
 */
export async function runWhisper(input: string, opts: RunWhisperOptions = {}): Promise<WhisperRaw> {
  if (!existsSync(pythonBin())) {
    throw new BveError("TOOL_MISSING", "The transcription environment is not installed", {
      hint: "Run `uv sync --project engine/python` (installs Python 3.12 + faster-whisper), or import a transcript with `bve transcript import <file>`.",
    });
  }
  return withTempDir(async (dir) => {
    const out = join(dir, "transcript.json");
    const wav = join(dir, "audio16k.wav");
    await ffmpeg(["-i", input, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], opts.log ? { log: opts.log } : {});
    const args = ["-m", "bve_py.transcribe", "--input", wav, "--output", out, "--model", opts.model ?? "small"];
    if (opts.language && opts.language !== "auto") args.push("--language", opts.language);
    if (opts.vad === false) args.push("--no-vad");
    // Models are downloaded once into ./models (gitignored) and loaded offline afterwards.
    args.push("--model-dir", process.env.WHISPER_MODEL_DIR ?? join(REPO_ROOT, "models"));
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(pythonBin(), args, { cwd: join(REPO_ROOT, "engine/python"), windowsHide: true });
      let err = "";
      child.stderr.on("data", (d) => {
        err += d;
        opts.log?.debug({ whisper: String(d).trim() }, "whisper");
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new BveError("TOOL_MISSING", `Transcription failed (exit ${code}): ${err.slice(-2000)}`))));
    });
    return JSON.parse(await readFile(out, "utf8")) as WhisperRaw;
  });
}

export const fasterWhisper: TranscriptionProvider = {
  id: "faster-whisper",
  async available() {
    return existsSync(pythonBin());
  },
  async transcribe(project, sourceId, opts) {
    const model = opts.model ?? "small";
    const raw = await runWhisper(project.sourceMediaPath(sourceId), { model, ...(opts.language ? { language: opts.language } : {}), log: project.log });
    const source: TranscriptSource = {
      sourceId,
      segments: raw.segments.map((s, i) => ({
        id: `seg_${String(i + 1).padStart(3, "0")}`,
        start: s.start,
        end: s.end,
        text: s.text.trim(),
        words: joinSubwordTokens(s.words.map((w) => ({ w: w.word.trim(), start: w.start, end: w.end, p: Math.round(w.probability * 1000) / 1000 })).filter((w) => w.w)),
      })),
    };
    return { language: raw.language, model: `faster-whisper/${model}`, source: markFillers(source, raw.language) };
  },
};

// ---------------------------------------------------------------- import (existing transcript / fixtures)

/** Import a transcript produced elsewhere (another STT, a corrected file, a test fixture). */
export async function importTranscript(project: Project, file: string): Promise<Transcript> {
  const data = validate<Transcript>("transcript", await readJson(file), file);
  for (const s of data.sources) {
    for (const seg of s.segments) seg.words = joinSubwordTokens(seg.words);
    project.source(s.sourceId);
    markFillers(s, data.language);
  }
  return mergeAndSave(project, data, `Imported transcript from ${file}`);
}

export async function transcribeProject(project: Project, opts: TranscribeOptions & { sourceIds?: string[] } = {}): Promise<Transcript> {
  const sources = project.manifest.sources.filter((s) => s.probe.hasAudio && (!opts.sourceIds || opts.sourceIds.includes(s.id)));
  if (!sources.length) throw new BveError("MISSING_INPUT", "No source with an audio stream to transcribe");
  let language = opts.language ?? "auto";
  let model = "";
  const results: TranscriptSource[] = [];
  for (const s of sources) {
    const r = await fasterWhisper.transcribe(project, s.id, opts);
    language = r.language;
    model = r.model;
    results.push(r.source);
  }
  return mergeAndSave(project, { schemaVersion: SCHEMA_VERSION, language, model, sources: results }, `Transcribed ${results.length} source(s) with ${model}`);
}

async function mergeAndSave(project: Project, incoming: Transcript, message: string): Promise<Transcript> {
  const prev = await project.readDocOptional("transcript");
  const kept = (prev?.sources ?? []).filter((p) => !incoming.sources.some((s) => s.sourceId === p.sourceId));
  const doc: Transcript = { ...incoming, schemaVersion: SCHEMA_VERSION, sources: [...kept, ...incoming.sources] };
  await project.writeDoc("transcript", doc, { command: "transcript", message });
  // Link it from the analysis if one exists.
  const analysis = await project.readDocOptional("analysis");
  if (analysis) {
    for (const s of analysis.sources) if (doc.sources.some((d) => d.sourceId === s.sourceId)) s.transcriptRef = "analysis/transcript.json";
    await project.writeDoc("analysis", analysis, { command: "transcript", message: "Linked transcript" });
  }
  return doc;
}

/** Numbered segments with timecodes: what the creative director references in a plan. */
export async function listSegments(project: Project) {
  const t = await project.readDoc("transcript");
  return t.sources.flatMap((s) => s.segments.map((seg) => ({ sourceId: s.sourceId, id: seg.id, range: `${seg.start.toFixed(2)}-${seg.end.toFixed(2)}`, text: seg.text, fillers: seg.words.filter((w) => w.filler).length })));
}

/**
 * Whisper sometimes splits one written word into tokens ("j" + "'exerce", "aujourd" + "'hui",
 * "2026" + "."). Merge tokens that start with an apostrophe or are pure punctuation into the
 * previous word, keeping the combined timing, so captions never show "j 'exerce".
 */
export function joinSubwordTokens<W extends { w: string; start: number; end: number; p?: number }>(words: W[]): W[] {
  const out: W[] = [];
  for (const w of words) {
    const prev = out.at(-1);
    // "-ce", "-elle", "-vous": French inversion hyphen tokens belong to the previous word too.
    if (prev && (/^['’]/.test(w.w) || /^-\p{L}/u.test(w.w) || /^[.,!?;:…»)]+$/.test(w.w))) {
      prev.w += w.w;
      prev.end = w.end;
      if (prev.p !== undefined && w.p !== undefined) prev.p = Math.min(prev.p, w.p);
    } else out.push({ ...w });
  }
  return out;
}
export * from "./metrics.js";
export * from "./sentences.js";

/** Project operation: the sentence view of the current transcript. */
export async function listSentences(project: Project) {
  const { toSentences } = await import("./sentences.js");
  return toSentences(await project.readDoc("transcript"));
}

export interface TranscriptionReport {
  sourceId: string;
  words: number;
  segments: number;
  /** Seconds of non-silent audio according to the analysis (speech, music or ambience). */
  nonSilentSec: number;
  wordsPerMinute: number;
  warning?: string;
}

/**
 * Facts about a transcription, so an empty or thin result is never silent. No guessing: Whisper
 * returns nothing both when there is no speech and when speech is buried under noise (measured:
 * 0 segments below ≈ −10 dB SNR, docs/measurements/transcription-noise.md).
 */
export function transcriptionReport(transcript: Transcript, analysis?: Analysis): TranscriptionReport[] {
  return transcript.sources.map((s) => {
    const words = s.segments.reduce((a, g) => a + g.words.length, 0);
    const audio = analysis?.sources.find((a) => a.sourceId === s.sourceId)?.audio;
    const nonSilentSec = Math.round((audio?.speech ?? []).reduce((a, r) => a + r.end - r.start, 0) * 10) / 10;
    const wordsPerMinute = nonSilentSec > 0 ? Math.round((words / nonSilentSec) * 60) : 0;
    const report: TranscriptionReport = { sourceId: s.sourceId, words, segments: s.segments.length, nonSilentSec, wordsPerMinute };
    if (words === 0 && nonSilentSec >= 5) {
      report.warning = `No speech transcribed from ${nonSilentSec}s of non-silent audio: either there is no speech (music, ambience) or the speech is buried under noise (Whisper returns nothing below ≈ −10 dB SNR). Do not caption this source until a human confirms which.`;
    } else if (words > 0 && wordsPerMinute < 40 && nonSilentSec >= 20) {
      report.warning = `Only ${wordsPerMinute} words/min over ${nonSilentSec}s of non-silent audio: speech may be partly missed (noise, music, distant voice). Check before relying on the transcript.`;
    }
    return report;
  });
}
