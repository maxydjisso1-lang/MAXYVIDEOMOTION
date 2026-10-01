/**
 * Measured neural denoising (chantier 2).
 *
 * Decision = measured SNR → candidate strengths (strongest first) → each candidate is rendered and
 * checked by a voice-preservation guard → the strongest accepted strength wins, or nothing.
 * Every number below comes from docs/measurements/denoise.md (real street noise, clean reference).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BveError, existsSync, REPO_ROOT, withTempDir, type AudioDoc } from "../../core/src/index.js";
import { ffmpeg, quoteFilterPath } from "../../ffmpeg/src/index.js";
import { decodePcm, estimateSnrDb, guardMetrics, type GuardMetrics } from "./quality.js";

type Processor = AudioDoc["dialogue"][number]["chain"][number];

/** RNNoise model (BSD-3, GregorR/rnnoise-models "somnolent-hogwash"). Downloaded once, never committed. */
export const RNNOISE_MODEL = {
  id: "rnnoise/sh.rnnn",
  url: "https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn",
  sha256: "70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0",
};

export const modelPath = (id: string) => join(process.env.BVE_MODEL_DIR ?? join(REPO_ROOT, "models"), id);

export async function ensureRnnoiseModel(): Promise<string> {
  const path = modelPath(RNNOISE_MODEL.id);
  if (existsSync(path)) {
    const sha = createHash("sha256").update(await readFile(path)).digest("hex");
    if (sha === RNNOISE_MODEL.sha256) return path;
  }
  let bytes: Buffer;
  try {
    const res = await fetch(RNNOISE_MODEL.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new BveError("TOOL_MISSING", `Cannot download the RNNoise model: ${(err as Error).message}`, { hint: `Download ${RNNOISE_MODEL.url} to ${path} (sha256 ${RNNOISE_MODEL.sha256}).` });
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== RNNOISE_MODEL.sha256) throw new BveError("TOOL_MISSING", `RNNoise model checksum mismatch (${sha})`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

/** FFmpeg filter for a denoise-rnn processor (the model path is escaped for the filtergraph). */
export function rnnoiseFilter(mix: number, model = RNNOISE_MODEL.id): string {
  return `aresample=48000,arnndn=m=${quoteFilterPath(modelPath(model))}:mix=${mix}`;
}

/**
 * Policy, from docs/measurements/denoise.md (estimated SNR → what to do):
 *  - ≥ cleanSnrDb (≈ true 17 dB+): skip. RNNoise only adds distortion there (SI-SDR −2.6 dB at 70 %, true 20 dB).
 *  - [mediumSnrDb, cleanSnrDb): RNNoise 70 % then 40 %, each checked by the guard. At true 10 dB, 70 % gives
 *    SI-SDR +2.5 dB with an unchanged word error rate.
 *  - < mediumSnrDb (strong noise): NOT applied automatically. Every strength measured either lowered
 *    intelligibility (WER +3.6 to +19.3 points at 5 and 0 dB) or was inconsistent; the user is told instead.
 * Guard thresholds are the worst values of the accepted medium-noise cases, with a small margin.
 */
export const DENOISE_POLICY = {
  cleanSnrDb: 22,
  mediumSnrDb: 13,
  candidates: [0.7, 0.4],
  guard: { minVoiceLevelDeltaDb: -1, maxVoiceSpectralChangeDb: 0.3, minSnrGainDb: 1 },
};

export interface DenoiseCandidate extends GuardMetrics {
  mix: number;
  accepted: boolean;
  reasons: string[];
}

export interface DenoisePlan {
  estimatedSnrDb: number;
  decision: "skip-clean" | "skip-strong-noise" | "applied" | "rejected-all";
  mix?: number;
  candidates: DenoiseCandidate[];
  summary: string;
}

export function judge(g: GuardMetrics, policy = DENOISE_POLICY.guard): { accepted: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (g.voiceLevelDeltaDb < policy.minVoiceLevelDeltaDb) reasons.push(`voice level ${g.voiceLevelDeltaDb} dB (< ${policy.minVoiceLevelDeltaDb})`);
  if (g.voiceSpectralChangeDb > policy.maxVoiceSpectralChangeDb) reasons.push(`voice timbre change ${g.voiceSpectralChangeDb} dB (> ${policy.maxVoiceSpectralChangeDb})`);
  if (g.snrAfterDb - g.snrBeforeDb < policy.minSnrGainDb) reasons.push(`SNR gain ${Math.round((g.snrAfterDb - g.snrBeforeDb) * 10) / 10} dB (< ${policy.minSnrGainDb})`);
  return { accepted: reasons.length === 0, reasons };
}

/** Measure a source, try candidate strengths, keep the strongest one the guard accepts. */
export async function planDenoise(input: string, opts: { log?: { debug: (o: object, m: string) => void } } = {}): Promise<DenoisePlan> {
  const before = await decodePcm(input);
  const snr = estimateSnrDb(before);
  if (snr >= DENOISE_POLICY.cleanSnrDb) {
    return { estimatedSnrDb: snr, decision: "skip-clean", candidates: [], summary: `estimated SNR ${snr} dB ≥ ${DENOISE_POLICY.cleanSnrDb}: clean enough, no neural denoise (it would only add distortion)` };
  }
  if (snr < DENOISE_POLICY.mediumSnrDb) {
    return { estimatedSnrDb: snr, decision: "skip-strong-noise", candidates: [], summary: `estimated SNR ${snr} dB < ${DENOISE_POLICY.mediumSnrDb}: strong noise. Measured: denoising here trades intelligibility for quiet (WER up to +19 points), so the voice is left untouched. Tell the user; a re-recording or a manual tool is the honest fix.` };
  }
  const mixes = DENOISE_POLICY.candidates;
  const model = await ensureRnnoiseModel();
  const candidates: DenoiseCandidate[] = [];
  await withTempDir(async (dir) => {
    for (const mix of mixes) {
      const out = join(dir, `rnn${mix}.wav`);
      await ffmpeg(["-i", input, "-vn", "-af", `aresample=48000,arnndn=m=${quoteFilterPath(model)}:mix=${mix}`, out]);
      const g = guardMetrics(before, await decodePcm(out));
      const verdict = judge(g);
      candidates.push({ mix, ...g, ...verdict });
      opts.log?.debug({ mix, ...g, ...verdict }, "denoise candidate");
      if (verdict.accepted) break; // strongest accepted wins
    }
  });
  const chosen = candidates.find((c) => c.accepted);
  const rejected = candidates.filter((c) => !c.accepted).map((c) => `${Math.round(c.mix * 100)} % (${c.reasons.join(", ")})`);
  if (!chosen) {
    return { estimatedSnrDb: snr, decision: "rejected-all", candidates, summary: `estimated SNR ${snr} dB: every strength degraded the voice — kept the original. Rejected: ${rejected.join("; ")}` };
  }
  return {
    estimatedSnrDb: snr,
    decision: "applied",
    mix: chosen.mix,
    candidates,
    summary: `estimated SNR ${snr} → ${chosen.snrAfterDb} dB with RNNoise ${Math.round(chosen.mix * 100)} %; voice ${chosen.voiceLevelDeltaDb} dB, timbre change ${chosen.voiceSpectralChangeDb} dB (guard OK)${rejected.length ? `. Rejected: ${rejected.join("; ")}` : ""}`,
  };
}

/** The dialogue processor for a plan (undefined when nothing should be applied). */
export function denoiseProcessor(plan: DenoisePlan): Processor | undefined {
  if (plan.decision !== "applied" || plan.mix === undefined) return undefined;
  return { type: "denoise-rnn", params: { model: RNNOISE_MODEL.id, mix: plan.mix }, reason: plan.summary };
}
