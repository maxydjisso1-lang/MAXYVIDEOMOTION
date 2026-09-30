/**
 * Dialogue cleanup chains (built from MEASURED problems) and the master loudness stage.
 * Chains are data in audio.json; they compile to FFmpeg filters only at render time.
 */
import { BveError, round3, SCHEMA_VERSION, type Analysis, type AudioDoc, type Preset, type Project } from "../../core/src/index.js";
import { ffmpeg, hasFilter, type RunOptions } from "../../ffmpeg/src/index.js";

type Processor = AudioDoc["dialogue"][number]["chain"][number];
export type CleanupPreset = "off" | "gentle" | "standard" | "aggressive";

const STRENGTH: Record<Exclude<CleanupPreset, "off">, { nr: number; comp: number }> = {
  gentle: { nr: 6, comp: 2 },
  standard: { nr: 10, comp: 3 },
  aggressive: { nr: 16, comp: 4 },
};

export function buildDialogueChain(audio: Analysis["sources"][number]["audio"], preset: CleanupPreset): Processor[] {
  if (preset === "off") return [];
  const s = STRENGTH[preset];
  const chain: Processor[] = [
    { type: "highpass", params: { frequency: preset === "gentle" ? 70 : 85 }, reason: "remove rumble and handling noise below the voice" },
  ];
  if (audio.humHz) {
    chain.push({ type: "dehum", params: { frequency: audio.humHz, harmonics: 4 }, reason: `electrical hum at ${audio.humHz} Hz` });
  }
  const floor = audio.noiseFloorDb ?? -90;
  if (floor > -62 || audio.noiseProfile?.length) {
    chain.push({
      type: "denoise-fft",
      params: { reductionDb: s.nr, noiseFloorDb: Math.round(Math.min(-20, Math.max(-80, floor))) },
      reason: `noise floor ${floor.toFixed(1)} dBFS (${(audio.noiseProfile ?? ["broadband"]).join(", ")})`,
    });
  }
  chain.push({ type: "eq", params: { bands: [{ f: 250, g: -2, q: 1 }, { f: 4000, g: 1.5, q: 0.8 }] }, reason: "reduce mud, add presence" });
  chain.push({ type: "compressor", params: { thresholdDb: -20, ratio: s.comp, attackMs: 10, releaseMs: 180, makeupDb: 2 }, reason: "even out level differences between words" });
  if (preset !== "gentle") chain.push({ type: "deess", params: { intensity: 0.3 }, reason: "tame sibilance after presence boost" });
  return chain;
}

export function buildAudioDoc(analysis: Analysis, preset: Preset, cleanup: CleanupPreset, previous?: AudioDoc): AudioDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    dialogue: analysis.sources
      .filter((s) => s.audio && Object.keys(s.audio).length)
      .map((s) => ({
        sourceId: s.sourceId,
        preset: cleanup,
        chain: buildDialogueChain(s.audio, cleanup),
        measurements: { before: { integratedLufs: s.audio.integratedLufs, truePeakDb: s.audio.truePeakDb, noiseFloorDb: s.audio.noiseFloorDb } },
      })),
    music: previous?.music ?? [],
    master: { loudnessLufs: preset.loudness.integratedLufs, truePeakDb: preset.loudness.truePeakDb, limiter: true },
  };
}

const p = (x: Processor, key: string, dflt: number) => Number((x.params as Record<string, unknown> | undefined)?.[key] ?? dflt);

export function compileProcessor(x: Processor): string[] {
  if (x.enabled === false) return [];
  switch (x.type) {
    case "highpass": return [`highpass=f=${p(x, "frequency", 80)}`];
    case "lowpass": return [`lowpass=f=${p(x, "frequency", 16000)}`];
    case "dehum": {
      const f0 = p(x, "frequency", 50);
      return Array.from({ length: p(x, "harmonics", 4) }, (_, i) => `bandreject=f=${f0 * (i + 1)}:width_type=q:w=30`);
    }
    case "denoise-fft": return [`afftdn=nr=${p(x, "reductionDb", 10)}:nf=${p(x, "noiseFloorDb", -50)}:tn=1`];
    case "denoise-rnn": {
      const model = (x.params as Record<string, unknown> | undefined)?.model;
      if (!model || !hasFilter("arnndn")) return [`afftdn=nr=${p(x, "reductionDb", 12)}`];
      return [`arnndn=m=${String(model)}`];
    }
    case "gate": return [`agate=threshold=${round3(10 ** (p(x, "thresholdDb", -50) / 20))}:ratio=2`];
    case "deess": return hasFilter("deesser") ? [`deesser=i=${p(x, "intensity", 0.3)}`] : [];
    case "eq": {
      const bands = ((x.params as { bands?: { f: number; g: number; q?: number }[] } | undefined)?.bands ?? []);
      return bands.map((b) => `equalizer=f=${b.f}:t=q:w=${b.q ?? 1}:g=${b.g}`);
    }
    case "compressor": {
      const thr = round3(10 ** (p(x, "thresholdDb", -20) / 20));
      return [`acompressor=threshold=${thr}:ratio=${p(x, "ratio", 3)}:attack=${p(x, "attackMs", 10)}:release=${p(x, "releaseMs", 180)}:makeup=${round3(10 ** (p(x, "makeupDb", 0) / 20))}`];
    }
    case "gain": return [`volume=${p(x, "db", 0)}dB`];
    case "limiter": return [`alimiter=limit=${round3(10 ** (p(x, "ceilingDb", -1) / 20))}`];
    case "dereverb": return []; // Phase 2 (DeepFilterNet). Kept in the chain for traceability.
  }
}

export function compileChain(chain: Processor[]): string[] {
  return chain.flatMap(compileProcessor);
}

/**
 * Two-pass EBU R128 normalisation of a mixed file to the preset target, then a true-peak limiter.
 * Pass 1 measures, pass 2 applies linear gain when possible (no pumping).
 */
export async function normalizeLoudness(input: string, output: string, master: AudioDoc["master"], sampleRate: number, opts: RunOptions = {}): Promise<{ measured: Record<string, string> }> {
  const target = `I=${master.loudnessLufs}:TP=${master.truePeakDb}:LRA=11`;
  const { stderr } = await ffmpeg(["-i", input, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"], { ...opts, captureStderr: true });
  const jsonStart = stderr.lastIndexOf("{");
  const jsonEnd = stderr.lastIndexOf("}");
  if (jsonStart < 0) throw new BveError("FFMPEG_FAILED", "loudnorm did not report measurements");
  const m = JSON.parse(stderr.slice(jsonStart, jsonEnd + 1)) as Record<string, string>;
  // A silent programme (e.g. footage without audio) cannot be normalised: keep it silent.
  const inputI = Number(m.input_i);
  if (!Number.isFinite(inputI) || inputI < -70) {
    await ffmpeg(["-i", input, "-af", `aresample=${sampleRate}`, "-ar", String(sampleRate), "-c:a", "pcm_s24le", output], opts);
    return { measured: { ...m, silent: "true" } };
  }
  const second = `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`;
  const limiter = master.limiter !== false ? `,alimiter=limit=${round3(10 ** ((master.truePeakDb - 0.3) / 20))}:level=disabled` : "";
  await ffmpeg(["-i", input, "-af", `${second}${limiter},aresample=${sampleRate}`, "-ar", String(sampleRate), "-c:a", "pcm_s24le", output], opts);
  return { measured: m };
}

/**
 * Project operation: cleanup level = explicit > creative plan > "standard"; loudness target from
 * the given target's preset (else the first target).
 */
export async function cleanProjectAudio(project: Project, opts: { preset?: CleanupPreset; targetId?: string } = {}): Promise<AudioDoc> {
  const plan = await project.readDocOptional("plan");
  const level = opts.preset ?? (plan?.audio?.cleanup as CleanupPreset | undefined) ?? "standard";
  const targetId = opts.targetId ?? project.manifest.targets[0]?.id;
  if (!targetId) throw new BveError("MISSING_INPUT", "No target: the loudness target comes from a delivery preset", { hint: "bve target add ig_reels --preset instagram/reels" });
  const doc = buildAudioDoc(await project.readDoc("analysis"), await project.preset(targetId), level, await project.readDocOptional("audio"));
  await project.writeDoc("audio", doc, { command: "audio clean", message: `Audio cleanup (${level}), master ${doc.master.loudnessLufs} LUFS` });
  return doc;
}
