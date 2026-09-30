import {
  BveError, round3, SCHEMA_VERSION, subtractRanges, type Analysis, type CreativePlan, type Project, type Range, type Timeline, type Transcript,
} from "../../core/src/index.js";

type SourceRef = CreativePlan["sections"][number]["sourceRefs"][number];
type Clip = Timeline["tracks"]["video"][number]["clips"][number];
type Word = Transcript["sources"][number]["segments"][number]["words"][number];

export interface ResolvedRange extends Range {
  sourceId: string;
}

export interface EditContext {
  analysis?: Analysis;
  transcript?: Transcript;
  sourceDurations?: Record<string, number>;
}

const FPS_ALLOWED = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export function resolveRef(ref: SourceRef, ctx: EditContext): ResolvedRange {
  if ("segmentId" in ref) {
    for (const s of ctx.transcript?.sources ?? []) {
      if (ref.sourceId && s.sourceId !== ref.sourceId) continue;
      const seg = s.segments.find((x) => x.id === ref.segmentId);
      if (seg) return { sourceId: s.sourceId, start: seg.start, end: seg.end };
    }
    throw new BveError("VALIDATION", `Unknown transcript segment "${ref.segmentId}"`, { hint: "List segments with `bve transcript show`." });
  }
  if ("shotId" in ref) {
    const src = ctx.analysis?.sources.find((s) => s.sourceId === ref.sourceId);
    const shot = src?.shots.find((s) => s.id === ref.shotId);
    if (!shot) throw new BveError("VALIDATION", `Unknown shot "${ref.shotId}" in source "${ref.sourceId}"`, { hint: "See `bve analysis summary`." });
    return { sourceId: ref.sourceId, start: shot.start, end: shot.end };
  }
  if (ref.end <= ref.start) throw new BveError("VALIDATION", `Empty range ${ref.start}-${ref.end} in ${ref.sourceId}`);
  return { sourceId: ref.sourceId, start: ref.start, end: ref.end };
}

function wordsOf(ctx: EditContext, sourceId: string): Word[] {
  return (ctx.transcript?.sources.find((s) => s.sourceId === sourceId)?.segments ?? []).flatMap((s) => s.words);
}

/**
 * Remove silences (and optionally fillers) inside a range. Cuts only happen where no word is
 * spoken, and keep `pad` seconds of air around speech so edits do not sound clipped.
 */
export function tightenRange(range: ResolvedRange, ctx: EditContext, opts: { minSilenceSec: number; padSec: number; removeFillers: boolean; sourceDurationSec?: number }): ResolvedRange[] {
  const words = wordsOf(ctx, range.sourceId);
  const silences = ctx.analysis?.sources.find((s) => s.sourceId === range.sourceId)?.audio.silences ?? [];
  const cuts: Range[] = [];
  for (const s of silences) {
    if (s.end - s.start < opts.minSilenceSec) continue;
    const cut = { start: s.start + opts.padSec, end: s.end - opts.padSec };
    if (cut.end - cut.start <= 0.05) continue;
    // Word-gap safety: never cut through a word even if the silence detector says so.
    if (words.some((w) => w.start < cut.end && cut.start < w.end)) continue;
    cuts.push(cut);
  }
  if (opts.removeFillers) {
    for (const w of words.filter((x) => x.filler)) cuts.push({ start: w.start - 0.02, end: w.end + 0.02 });
  }
  // Frame the speech: first word - pad to last word + pad (may extend slightly past a segment's
  // word-aligned bounds, never into a neighbouring word).
  const inside = words.filter((w) => w.end > range.start && w.start < range.end && !(opts.removeFillers && w.filler));
  let start = range.start;
  let end = range.end;
  if (inside.length) {
    const first = inside[0]!;
    const last = inside.at(-1)!;
    const prevEnd = words.filter((w) => w.end <= first.start).at(-1)?.end ?? 0;
    const nextStart = words.find((w) => w.start >= last.end)?.start ?? Infinity;
    start = Math.max(0, prevEnd, first.start - opts.padSec);
    end = Math.min(nextStart, last.end + opts.padSec, opts.sourceDurationSec ?? Infinity);
  }
  return subtractRanges({ start, end }, cuts)
    .filter((p) => p.end - p.start >= 0.12)
    .map((p) => ({ sourceId: range.sourceId, start: round3(p.start), end: round3(p.end) }));
}

interface Piece extends ResolvedRange {
  sectionId: string;
  reason: string;
}

export function planPieces(plan: CreativePlan, ctx: EditContext): Piece[] {
  const pacing = plan.pacing;
  const opts = {
    minSilenceSec: pacing.removeSilences?.minSilenceSec ?? 0.45,
    padSec: pacing.removeSilences?.keepPaddingSec ?? 0.12,
    removeFillers: pacing.removeFillers ?? false,
  };
  const silenceCut = pacing.removeSilences?.enabled !== false;
  const ordered: { id: string; role: string; refs: SourceRef[] }[] = [];
  if (plan.hook.sourceRefs?.length) ordered.push({ id: "hook", role: "hook", refs: plan.hook.sourceRefs });
  for (const s of plan.sections) ordered.push({ id: s.id, role: s.role, refs: s.sourceRefs });

  const pieces: Piece[] = [];
  for (const sec of ordered) {
    for (const ref of sec.refs) {
      const r = resolveRef(ref, ctx);
      const parts = silenceCut ? tightenRange(r, ctx, { ...opts, sourceDurationSec: ctx.sourceDurations?.[r.sourceId] }) : [r];
      parts.forEach((p, i) => {
        const why = [`${sec.role} (${sec.id})`];
        if (parts.length > 1 && i > 0) why.push("jump cut after removed silence/filler");
        pieces.push({ ...p, sectionId: sec.id, reason: why.join("; ") });
      });
    }
  }
  return pieces;
}

export function compilePlan(plan: CreativePlan, ctx: EditContext, fps: number): Timeline {
  const timelineFps = FPS_ALLOWED.includes(fps) ? fps : 30;
  const pieces = planPieces(plan, ctx);
  if (!pieces.length) throw new BveError("VALIDATION", "The plan resolves to no usable material");

  const clips: Clip[] = [];
  const markers: NonNullable<Timeline["markers"]> = [];
  let t = 0;
  let prev: Piece | undefined;
  let zoomToggle = false;
  for (const [i, p] of pieces.entries()) {
    // Snap every clip to whole frames so the edit is identical in every renderer.
    const dur = Math.max(1, Math.round((p.end - p.start) * timelineFps)) / timelineFps;
    const clip: Clip = {
      id: `c${String(i + 1).padStart(3, "0")}`,
      sourceId: p.sourceId,
      sourceIn: p.start,
      sourceOut: round3(p.start + dur),
      timelineStart: round3(t),
      sectionId: p.sectionId,
      reason: p.reason,
    };
    // Same source, contiguous material: a jump cut. Alternate a punch-in so it reads as intentional.
    const isJump = prev && prev.sourceId === p.sourceId && prev.sectionId === p.sectionId && p.start - prev.end < 3;
    if (plan.pacing.punchIns && isJump) {
      zoomToggle = !zoomToggle;
      if (zoomToggle) clip.zoom = [{ t: 0, scale: 1.12, ease: "hold" }];
    } else if (!isJump) {
      zoomToggle = false;
    }
    if (!prev || prev.sectionId !== p.sectionId) {
      markers.push({ id: `m_${p.sectionId}`, time: round3(t), kind: p.sectionId === "hook" ? "hook" : "section", label: p.sectionId });
    }
    clips.push(clip);
    t += dur;
    prev = p;
  }
  const duration = round3(t);
  if (plan.cta) {
    const ctaAt = plan.cta.at === undefined || plan.cta.at === "end" ? Math.max(0, duration - (plan.cta.durationSec ?? 3)) : plan.cta.at;
    markers.push({ id: "cta_overlay", time: round3(Math.min(ctaAt, duration)), kind: "cta", label: "cta overlay" });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    fps: timelineFps as Timeline["fps"],
    durationSec: duration,
    tracks: {
      video: [{ id: "v1", kind: "primary", clips }],
      audio: [{ id: "a1", kind: "dialogue", followVideoTrack: "v1", clips: [] }],
    },
    transitions: [],
    markers,
    reframe: {},
  };
}

/** Validates refs and returns duration estimates without writing anything. */
export function estimatePlan(plan: CreativePlan, ctx: EditContext) {
  const pieces = planPieces(plan, ctx);
  const bySection = new Map<string, number>();
  for (const p of pieces) bySection.set(p.sectionId, round3((bySection.get(p.sectionId) ?? 0) + p.end - p.start));
  const total = round3([...bySection.values()].reduce((a, b) => a + b, 0));
  const tolerance = plan.durationToleranceSec ?? 2;
  return {
    totalSec: total,
    targetSec: plan.targetDurationSec,
    withinTolerance: Math.abs(total - plan.targetDurationSec) <= tolerance,
    sections: Object.fromEntries(bySection),
    clips: pieces.length,
  };
}

export function timelineContext(project: Project): Promise<EditContext> {
  return Promise.all([project.readDocOptional("analysis"), project.readDocOptional("transcript")]).then(([analysis, transcript]) => ({
    ...(analysis ? { analysis } : {}),
    ...(transcript ? { transcript } : {}),
    sourceDurations: Object.fromEntries(project.manifest.sources.map((s) => [s.id, s.probe.durationSec])),
  }));
}
