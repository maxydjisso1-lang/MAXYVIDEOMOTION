import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BveError, existsSync, readJson, REPO_ROOT, SCHEMA_VERSION, validate, withTempDir, type Project, type Transcript,
} from "../../core/src/index.js";

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

export const fasterWhisper: TranscriptionProvider = {
  id: "faster-whisper",
  async available() {
    return existsSync(pythonBin());
  },
  async transcribe(project, sourceId, opts) {
    if (!(await this.available())) {
      throw new BveError("TOOL_MISSING", "The transcription environment is not installed", {
        hint: "Run `uv sync --project engine/python` (installs Python 3.12 + faster-whisper), or import a transcript with `bve transcript import <file>`.",
      });
    }
    const input = project.sourceMediaPath(sourceId);
    const model = opts.model ?? "large-v3";
    return withTempDir(async (dir) => {
      const out = join(dir, "transcript.json");
      const args = ["-m", "bve_py.transcribe", "--input", input, "--output", out, "--model", model];
      if (opts.language && opts.language !== "auto") args.push("--language", opts.language);
      if (process.env.WHISPER_MODEL_DIR) args.push("--model-dir", process.env.WHISPER_MODEL_DIR);
      await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(pythonBin(), args, { cwd: join(REPO_ROOT, "engine/python"), windowsHide: true });
        let err = "";
        child.stderr.on("data", (d) => {
          err += d;
          project.log.debug({ whisper: String(d).trim() }, "whisper");
        });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolvePromise() : reject(new BveError("TOOL_MISSING", `Transcription failed (exit ${code}): ${err.slice(-2000)}`))));
      });
      const raw = JSON.parse(await readFile(out, "utf8")) as { language: string; segments: { start: number; end: number; text: string; words: { word: string; start: number; end: number; probability: number }[] }[] };
      const source: TranscriptSource = {
        sourceId,
        segments: raw.segments.map((s, i) => ({
          id: `seg_${String(i + 1).padStart(3, "0")}`,
          start: s.start,
          end: s.end,
          text: s.text.trim(),
          words: s.words.map((w) => ({ w: w.word.trim(), start: w.start, end: w.end, p: Math.round(w.probability * 1000) / 1000 })).filter((w) => w.w),
        })),
      };
      return { language: raw.language, model: `faster-whisper/${model}`, source: markFillers(source, raw.language) };
    });
  },
};

// ---------------------------------------------------------------- import (existing transcript / fixtures)

/** Import a transcript produced elsewhere (another STT, a corrected file, a test fixture). */
export async function importTranscript(project: Project, file: string): Promise<Transcript> {
  const data = validate<Transcript>("transcript", await readJson(file), file);
  for (const s of data.sources) {
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
