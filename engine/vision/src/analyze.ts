import { mkdir } from "node:fs/promises";
import {
  invertRanges, round3, SCHEMA_VERSION, toProjectRel, type Analysis, type Project, type Range, type Shot, type Source,
} from "../../core/src/index.js";
import {
  capabilities, detectBlack, detectSceneCuts, detectSilences, extractFrame, ffmpeg, frameStats, measureLoudness, rmsLevel,
  type FrameStats,
} from "../../ffmpeg/src/index.js";

type SourceAnalysis = Analysis["sources"][number];
type AudioAnalysis = SourceAnalysis["audio"];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** BT.709 YUV means -> RGB means (0..1). Used for white-balance estimation and shot matching. */
export function yuvToRgb(y: number, u: number, v: number, max = 255): [number, number, number] {
  const Y = y / max;
  const U = u / max - 0.5;
  const V = v / max - 0.5;
  return [clamp01(Y + 1.5748 * V), clamp01(Y - 0.1873 * U - 0.4681 * V), clamp01(Y + 1.8556 * U)].map(round3) as [number, number, number];
}

export function classifyExposure(lumaMean: number, p05: number, p95: number): Shot["exposure"] {
  if (lumaMean < 0.3 || p95 < 0.55) return "under";
  if (lumaMean > 0.72 || p05 > 0.35) return "over";
  if (p95 - p05 > 0.95) return "mixed";
  return "ok";
}

export function buildShots(cuts: { time: number; score: number }[], duration: number, minShotSec = 0.4): { start: number; end: number; score: number }[] {
  const bounds = [{ time: 0, score: 1 }, ...cuts.filter((c) => c.time > minShotSec && c.time < duration - minShotSec)];
  const shots: { start: number; end: number; score: number }[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i]!.time;
    const end = i + 1 < bounds.length ? bounds[i + 1]!.time : duration;
    if (end - start >= minShotSec) shots.push({ start: round3(start), end: round3(end), score: round3(bounds[i]!.score) });
    else if (shots.length) shots.at(-1)!.end = round3(end);
  }
  return shots;
}

function shotStats(frames: FrameStats[], range: Range, bitDepth: number) {
  const inShot = frames.filter((f) => f.t >= range.start && f.t < range.end);
  const sample = inShot.length ? inShot : frames.filter((f) => Math.abs(f.t - (range.start + range.end) / 2) < 1);
  const max = (1 << bitDepth) - 1;
  const y = mean(sample.map((f) => f.yavg));
  // signalstats YLOW/YHIGH are the 10th/90th luma percentiles; we store them as the low/high anchors.
  const lo = mean(sample.map((f) => f.ylow)) / max;
  const hi = mean(sample.map((f) => f.yhigh)) / max;
  return {
    luma: { mean: round3(y / max), p05: round3(lo), p95: round3(hi) },
    saturationMean: round3(clamp01(mean(sample.map((f) => f.satavg)) / (max / 2))),
    rgbMean: yuvToRgb(y, mean(sample.map((f) => f.uavg)), mean(sample.map((f) => f.vavg)), max),
  };
}

async function analyzeAudio(project: Project, input: string, duration: number): Promise<AudioAnalysis> {
  const [silencesRaw, loud] = await Promise.all([
    detectSilences(input, { noiseDb: -35, minSec: 0.3, log: project.log }),
    measureLoudness(input, { log: project.log }),
  ]);
  const silences = silencesRaw.map((s) => ({ start: round3(s.start), end: round3(Math.min(s.end, duration)) }));
  const longest = [...silences].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  const noiseFloorDb = longest && longest.end - longest.start > 0.25
    ? await rmsLevel(input, { start: longest.start + 0.05, end: longest.end - 0.05 }, { log: project.log })
    : -90;
  const noiseProfile: NonNullable<AudioAnalysis["noiseProfile"]> = noiseFloorDb > -62 ? ["broadband"] : [];
  const speech = invertRanges(silences, duration).map((r) => ({ start: round3(r.start), end: round3(r.end) }));
  return {
    integratedLufs: round3(loud.integratedLufs),
    loudnessRange: round3(loud.loudnessRange),
    truePeakDb: round3(loud.truePeakDb),
    noiseFloorDb: round3(noiseFloorDb),
    clipping: loud.truePeakDb > -0.3,
    silences,
    speech,
    noiseProfile,
    qualityScore: round3(clamp01((-noiseFloorDb - 35) / 40)),
  };
}

export async function analyzeSource(project: Project, source: Source): Promise<SourceAnalysis> {
  const input = project.sourceMediaPath(source.id);
  const duration = source.probe.durationSec;
  const out: SourceAnalysis = { sourceId: source.id, shots: [], audio: {} };

  if (source.probe.hasVideo) {
    const [cuts, frames, black] = await Promise.all([
      detectSceneCuts(input, { log: project.log }),
      frameStats(input, { fps: 4, log: project.log }),
      detectBlack(input, { log: project.log }),
    ]);
    const bitDepth = source.probe.bitDepth && source.probe.bitDepth > 8 ? source.probe.bitDepth : 8;
    const kfDir = `analysis/keyframes/${source.id}`;
    await mkdir(project.abs(kfDir), { recursive: true });
    const shots = buildShots(cuts, duration);
    for (const [i, s] of shots.entries()) {
      const id = `s${String(i + 1).padStart(3, "0")}`;
      const stats = shotStats(frames, s, bitDepth);
      const keyframe = `${kfDir}/${id}.jpg`;
      await extractFrame(input, (s.start + s.end) / 2, project.writable(keyframe), { width: 480, log: project.log });
      out.shots.push({
        id,
        start: s.start,
        end: s.end,
        sceneScore: s.score,
        keyframe,
        ...stats,
        exposure: classifyExposure(stats.luma.mean, stats.luma.p05, stats.luma.p95),
      });
    }
    out.blackSegments = black.map((b) => ({ start: round3(b.start), end: round3(b.end) }));
    out.contactSheets = [await contactSheet(project, source.id, out.shots)];
  }
  if (source.probe.hasAudio) out.audio = await analyzeAudio(project, input, duration);
  return out;
}

/** One image with every shot's keyframe: this is what Claude looks at to label shots. */
async function contactSheet(project: Project, sourceId: string, shots: Shot[]): Promise<string> {
  const rel = `analysis/contact-sheets/${sourceId}.jpg`;
  await mkdir(project.abs("analysis/contact-sheets"), { recursive: true });
  const cols = Math.min(4, shots.length);
  const inputs = shots.flatMap((s) => ["-i", project.abs(s.keyframe!)]);
  const scaled = shots.map((s, i) => `[${i}:v]scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,drawbox=x=0:y=0:w=120:h=34:color=black@0.6:t=fill[k${i}]`).join(";");
  const layout = shots.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 270}`).join("|");
  const graph = shots.length === 1
    ? `${scaled};[k0]null[out]`
    : `${scaled};${shots.map((_, i) => `[k${i}]`).join("")}xstack=inputs=${shots.length}:layout=${layout}:fill=black[out]`;
  await ffmpeg([...inputs, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-q:v", "3", project.writable(rel)], { log: project.log });
  return toProjectRel(project.root, project.abs(rel));
}

export async function analyzeProject(project: Project, opts: { sourceIds?: string[] } = {}): Promise<Analysis> {
  const sources = project.manifest.sources.filter((s) => !opts.sourceIds || opts.sourceIds.includes(s.id));
  const previous = await project.readDocOptional("analysis");
  const results: SourceAnalysis[] = [];
  for (const s of sources) {
    project.log.info({ source: s.id }, "analyzing");
    const a = await analyzeSource(project, s);
    // Keep Claude's semantic labels when re-analysing unchanged shots.
    const prev = previous?.sources.find((p) => p.sourceId === s.id);
    for (const shot of a.shots) {
      const old = prev?.shots.find((p) => p.id === shot.id && Math.abs(p.start - shot.start) < 0.05);
      if (old?.labels) shot.labels = old.labels;
      if (old?.notes) shot.notes = old.notes;
    }
    if (project.hasDoc("transcript")) a.transcriptRef = "analysis/transcript.json";
    results.push(a);
  }
  const untouched = (previous?.sources ?? []).filter((p) => !results.some((r) => r.sourceId === p.sourceId));
  const analysis: Analysis = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    tools: { ffmpeg: capabilities().version },
    sources: [...untouched, ...results],
  };
  await project.writeDoc("analysis", analysis, { command: "analyze", message: `Analyzed ${results.length} source(s)` });
  return analysis;
}

/** Compact view that fits in Claude's context even for long videos. */
export function summarizeAnalysis(analysis: Analysis) {
  return analysis.sources.map((s) => ({
    sourceId: s.sourceId,
    shots: s.shots.map((sh) => ({ id: sh.id, range: `${sh.start.toFixed(2)}-${sh.end.toFixed(2)}`, exposure: sh.exposure, luma: sh.luma?.mean, labels: sh.labels?.map((l) => l.label) })),
    problems: [
      ...s.shots.filter((sh) => sh.exposure !== "ok").map((sh) => `shot ${sh.id} exposure ${sh.exposure}`),
      ...(s.audio.clipping ? ["audio clipping"] : []),
      ...((s.audio.noiseFloorDb ?? -90) > -62 ? [`audible noise floor ${s.audio.noiseFloorDb} dBFS`] : []),
      ...(s.blackSegments ?? []).map((b) => `black ${b.start}-${b.end}`),
    ],
    audio: { lufs: s.audio.integratedLufs, truePeak: s.audio.truePeakDb, noiseFloorDb: s.audio.noiseFloorDb, silences: s.audio.silences?.length, speechSec: round3((s.audio.speech ?? []).reduce((a, r) => a + r.end - r.start, 0)) },
    contactSheets: s.contactSheets,
  }));
}
