/**
 * Color = correction (technical, per shot, measured) + grade (creative, from style tokens).
 * Both stay parameters in color.json and are compiled to FFmpeg filters at render time.
 */
import { round3, SCHEMA_VERSION, type Analysis, type ColorDoc, type Project, type StyleTokens, type Timeline } from "../../core/src/index.js";
import { hasFilter } from "../../ffmpeg/src/index.js";

type ShotEntry = ColorDoc["shots"][number];
type Correction = NonNullable<ShotEntry["correction"]>;
type Grade = NonNullable<ColorDoc["globalGrade"]>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Guard-rails, from docs/measurements/color.md (chantier 5). The analysis luma statistics are 8-bit
 * TV-range code values / 255, and its "p05"/"p95" are signalstats' 10th/90th percentiles.
 */
export const CORRECTION_POLICY = {
  /**
   * Brighten only a shot without highlights: a dark shot WITH highlights is low-key on purpose. Judged on
   * the 98th percentile when the analysis has it (small bright elements count: titles, lamps), else on the 90th.
   */
  underMaxP98: 0.65,
  underMaxP90: 0.5,
  /** Brightening lifts the 98th percentile to at most this… */
  targetP98: 0.92,
  /** Brightening lifts the 90th percentile to at most this (no highlight clipping)… */
  targetP90: 0.75,
  /** …and the mean to at most this. */
  targetMean: 0.42,
  /** Darken only a washed-out shot: bright mean AND no deep shadows. */
  overMinMean: 0.62,
  overMinP10: 0.25,
  maxGain: 2 ** 1.5,
  /** Below this |log2 gain| nothing is done. */
  deadbandEv: 0.2,
  /** Contrast only when the 10–90 % spread is still this small AFTER exposure. */
  flatSpread: 0.4,
  /**
   * Automatic white balance. "off": the measured cast is reported, not applied — gray-world could not
   * tell a warm interior, a forest or a candle-lit scene from a cast (measured), so it harmed real footage.
   */
  whiteBalance: "off" as "off" | "gray-world",
};

/** TV-range code value / 255 → full-range 0..1. */
const fullRange = (v: number) => clamp((v * 255 - 16) / 219, 0, 1);

export function autoCorrection(
  shot: Analysis["sources"][number]["shots"][number],
  protectSkin = true,
  policy = CORRECTION_POLICY,
): { correction: Correction; reason: string } {
  const reasons: string[] = [];
  const luma = shot.luma;
  if (!luma) return { correction: { exposure: 0, contrast: 0, whiteBalance: { mode: "as-shot" }, protectSkinTones: protectSkin }, reason: "no luma statistics: no correction" };
  const mean = Math.max(0.01, fullRange(luma.mean ?? 0.46));
  const p10 = fullRange(luma.p05 ?? 0.1);
  const p90 = Math.max(0.01, fullRange(luma.p95 ?? 0.8));
  const p98 = luma.p98 !== undefined ? Math.max(0.01, fullRange(luma.p98)) : undefined;

  // Exposure: a gain on the encoded signal (2^exposure), never clipping the 90th percentile.
  let gain = 1;
  const noHighlights = p98 !== undefined ? p98 < policy.underMaxP98 : p90 < policy.underMaxP90;
  if (noHighlights) {
    gain = clamp(Math.min(policy.targetP90 / p90, policy.targetMean / mean, p98 !== undefined ? policy.targetP98 / p98 : Infinity), 1, policy.maxGain);
  } else if (mean > policy.overMinMean && p10 > policy.overMinP10) {
    gain = clamp(policy.targetMean / mean, 1 / policy.maxGain, 1);
  }
  let exposure = Math.log2(gain);
  if (Math.abs(exposure) < policy.deadbandEv) exposure = 0;
  if (exposure > 0) reasons.push(`brightened ${exposure.toFixed(2)} EV (no highlights: ${p98 !== undefined ? `98th percentile ${p98.toFixed(2)}` : `90th percentile ${p90.toFixed(2)}`}, mean ${mean.toFixed(2)})`);
  else if (exposure < 0) reasons.push(`darkened ${(-exposure).toFixed(2)} EV (washed out: mean ${mean.toFixed(2)}, 10th percentile ${p10.toFixed(2)})`);
  else if (!noHighlights && mean < 0.3) reasons.push(`dark but with highlights (${p98 !== undefined ? `98th percentile ${p98.toFixed(2)}` : `90th percentile ${p90.toFixed(2)}`}): low-key, left as shot`);

  // Contrast on what the shot will look like after the exposure gain.
  const spread = (p90 - p10) * 2 ** exposure;
  const contrast = spread < policy.flatSpread ? round3(clamp((policy.flatSpread + 0.1 - spread) * 0.8, 0, 0.3)) : 0;
  if (contrast) reasons.push(`contrast +${contrast} (flat: 10–90 % spread ${spread.toFixed(2)})`);

  // White balance (gray world), reported always, applied only when the policy says so.
  const [r, g, b] = shot.rgbMean ?? [0.5, 0.5, 0.5];
  const avg = (r + g + b) / 3 || 0.5;
  const strength = protectSkin ? 0.35 : 0.5;
  const gains = [r, g, b].map((c) => round3(clamp(1 + (avg / Math.max(0.02, c) - 1) * strength, 0.85, 1.15))) as [number, number, number];
  const castMagnitude = Math.max(...gains.map((x) => Math.abs(x - 1)));
  let whiteBalance: Correction["whiteBalance"] = { mode: "as-shot" };
  if (castMagnitude > 0.02) {
    if (policy.whiteBalance === "gray-world") {
      whiteBalance = { mode: "auto-gray-world", gains };
      reasons.push(`white balance gains ${gains.join("/")}`);
    } else {
      reasons.push(`average colour off neutral (gray-world would apply ${gains.join("/")}): not applied, a scene's own colour cannot be told from a cast — set it by hand if it is a cast`);
    }
  }

  return {
    correction: { exposure: round3(exposure), contrast, whiteBalance, protectSkinTones: protectSkin },
    reason: reasons.length ? reasons.join("; ") : "within tolerance: no correction",
  };
}

/**
 * How a source's YUV must be read (chantier 5, docs/measurements/color.md). The tag wins; an
 * unsignalled source follows the broadcast convention (HD = BT.709, SD = BT.601) instead of FFmpeg's
 * BT.601 default, which shifted untagged HD sources by ≈2 ΔE (measured).
 */
export function sourceColorimetry(probe: { colorSpace?: string; colorRange?: "tv" | "pc"; pixFmt?: string; height?: number }): { matrix: "bt709" | "bt601"; range: "tv" | "pc"; assumed: boolean } {
  const cs = probe.colorSpace;
  const tagged = cs === "bt709" ? "bt709" : cs === "bt470bg" || cs === "smpte170m" ? "bt601" : undefined;
  const matrix = tagged ?? ((probe.height ?? 0) >= 720 ? "bt709" : "bt601");
  const range = probe.colorRange ?? (probe.pixFmt?.startsWith("yuvj") ? "pc" : "tv");
  return { matrix, range, assumed: !tagged };
}

/** First filter of every clip: the source's YUV re-expressed as BT.709 limited range, the delivery colorimetry. */
export function normalizeColorimetryFilter(probe: Parameters<typeof sourceColorimetry>[0]): string {
  const { matrix, range } = sourceColorimetry(probe);
  return `scale=in_color_matrix=${matrix}:in_range=${range}:out_color_matrix=bt709:out_range=tv`;
}

export function gradeFromTokens(tokens: StyleTokens): Grade {
  return {
    look: tokens.grade.look,
    intensity: tokens.grade.intensity,
    ...(tokens.grade.lut ? { lut: tokens.grade.lut } : {}),
  };
}

/** Correct every analysed shot that the timeline actually uses; grade comes from the brand. */
export function autoColor(analysis: Analysis, timeline: Timeline, tokens: StyleTokens, opts: { intent?: "correct-only" | "brand-look"; previous?: ColorDoc; whiteBalance?: "off" | "gray-world" } = {}): ColorDoc {
  const used = timeline.tracks.video.flatMap((t) => t.clips);
  const shots: ShotEntry[] = [];
  for (const src of analysis.sources) {
    for (const shot of src.shots) {
      if (!used.some((c) => c.sourceId === src.sourceId && c.sourceIn < shot.end && shot.start < c.sourceOut)) continue;
      const locked = opts.previous?.shots.find((s) => s.sourceId === src.sourceId && s.shotId === shot.id && s.locked);
      if (locked) {
        shots.push(locked);
        continue;
      }
      const { correction, reason } = autoCorrection(shot, tokens.grade.protectSkinTones ?? true, { ...CORRECTION_POLICY, whiteBalance: opts.whiteBalance ?? CORRECTION_POLICY.whiteBalance });
      shots.push({
        sourceId: src.sourceId,
        shotId: shot.id,
        correction,
        measurements: { before: { lumaMean: shot.luma?.mean ?? 0, lumaP05: shot.luma?.p05 ?? 0, lumaP95: shot.luma?.p95 ?? 0, saturationMean: shot.saturationMean ?? 0, rgbMean: shot.rgbMean ?? [0, 0, 0] } },
        reason,
      });
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    globalGrade: opts.intent === "correct-only" ? { look: "none", intensity: 0 } : gradeFromTokens(tokens),
    shots,
  };
}

// ---------------------------------------------------------------- compilation to FFmpeg filters

/**
 * Brightening by a gain g WITHOUT clipping: ×g up to a knee, then an exponential shoulder with the
 * same slope that approaches white. A plain gain pushed small bright elements (titles, lamps) to
 * clipped white (measured: 17 % of a title card). A spline (curves) overshoots and clips too, so the
 * mapping is an exact per-value table (lutrgb). Values in 8-bit code values.
 */
export function brightenCurve(g: number): string {
  // knee output y0 from 204 (0.8) upward until the shoulder lands within 2 % of white at 255
  let y0 = 204;
  while (y0 < 245 && (g * (255 - y0 / g)) / (255 - y0) < 4) y0++;
  const k = round3(y0 / g);
  const h = 255 - y0;
  const e = `if(lt(val\,${k})\,val*${round3(g)}\,${y0}+${h}*(1-exp(-${round3(g / h)}*(val-${k}))))`;
  return `lutrgb=r='${e}':g='${e}':b='${e}'`;
}

function correctionFilters(c: Correction | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  const ev = 2 ** (c.exposure ?? 0);
  const [gr, gg, gb] = c.whiteBalance?.mode && c.whiteBalance.mode !== "as-shot" && c.whiteBalance.gains ? c.whiteBalance.gains : [1, 1, 1];
  // Darkening and white balance are per-channel gains ≤ 1.15 here: one colorchannelmixer pass.
  const darken = ev < 1 - 1e-3 ? ev : 1;
  if (darken !== 1 || gr !== 1 || gg !== 1 || gb !== 1) {
    out.push(`colorchannelmixer=rr=${round3(darken * gr)}:gg=${round3(darken * gg)}:bb=${round3(darken * gb)}`);
  }
  if (ev > 1 + 1e-3) out.push(brightenCurve(ev));
  const eq: string[] = [];
  if (c.contrast) eq.push(`contrast=${round3(1 + c.contrast)}`);
  if (c.saturation) eq.push(`saturation=${round3(1 + c.saturation)}`);
  if (eq.length) out.push(`eq=${eq.join(":")}`);
  return out;
}

/** Brand looks. Intensity scales every parameter so a look can be dialled from 0 to 1. */
function lookFilters(grade: Grade | undefined, tokens?: StyleTokens): string[] {
  if (!grade || !grade.look || grade.look === "none" || !grade.intensity) return [];
  const i = grade.intensity;
  const f: string[] = [];
  switch (grade.look) {
    case "warm":
      f.push(`colorbalance=rm=${round3(0.06 * i)}:bm=${round3(-0.06 * i)}:rh=${round3(0.04 * i)}:bh=${round3(-0.04 * i)}`);
      break;
    case "cool":
      f.push(`colorbalance=rm=${round3(-0.05 * i)}:bm=${round3(0.06 * i)}:bh=${round3(0.04 * i)}`);
      break;
    case "filmic":
      // Lifted blacks, rolled-off highlights, teal shadows / warm highlights, slightly muted.
      f.push(`curves=all='0/${round3(0.06 * i)} 0.25/${round3(0.25 - 0.03 * i)} 0.75/${round3(0.75 + 0.02 * i)} 1/${round3(1 - 0.05 * i)}'`);
      f.push(`colorbalance=bs=${round3(0.05 * i)}:rs=${round3(-0.03 * i)}:rh=${round3(0.04 * i)}:bh=${round3(-0.04 * i)}`);
      f.push(`eq=saturation=${round3(1 - 0.12 * i)}`);
      break;
    case "high-contrast":
      f.push(`eq=contrast=${round3(1 + 0.25 * i)}:saturation=${round3(1 + 0.05 * i)}`);
      break;
    case "muted":
      f.push(`eq=saturation=${round3(1 - 0.35 * i)}:contrast=${round3(1 - 0.05 * i)}`);
      break;
    case "vibrant":
      // vibrance boosts low-saturation colors more than skin-like saturated ones.
      f.push(hasFilter("vibrance") ? `vibrance=intensity=${round3(0.5 * i)}` : `eq=saturation=${round3(1 + 0.3 * i)}`);
      f.push(`eq=contrast=${round3(1 + 0.08 * i)}`);
      break;
    case "mono":
      f.push(`hue=s=${round3(1 - i)}`);
      break;
    case "natural":
      break;
  }
  if (tokens) {
    if (tokens.grade.saturation) f.push(`eq=saturation=${round3(1 + tokens.grade.saturation * i)}`);
    if (tokens.grade.warmth) f.push(`colorbalance=rm=${round3(0.05 * tokens.grade.warmth * i)}:bm=${round3(-0.05 * tokens.grade.warmth * i)}`);
  }
  return f;
}

/** Filter chain for one clip: the correction of the shot at the clip's midpoint, then the grade. */
export function clipColorFilters(color: ColorDoc | undefined, sourceId: string, midSourceSec: number, analysis: Analysis | undefined, tokens?: StyleTokens, lutPath?: string): string[] {
  if (!color) return [];
  const shot = analysis?.sources.find((s) => s.sourceId === sourceId)?.shots.find((s) => midSourceSec >= s.start && midSourceSec < s.end);
  const entry = shot ? color.shots.find((s) => s.sourceId === sourceId && s.shotId === shot.id) : undefined;
  const grade = entry?.grade ?? color.globalGrade;
  const filters = [...correctionFilters(entry?.correction), ...lookFilters(grade, tokens)];
  if (lutPath) filters.push(`lut3d=file=${lutPath}`);
  return filters;
}

/** Project operation: measured correction + brand grade for every shot the timeline uses. */
export async function colorAutoProject(project: Project, intent: "correct-only" | "brand-look" = "brand-look", opts: { whiteBalance?: "off" | "gray-world" } = {}): Promise<ColorDoc> {
  const doc = autoColor(await project.readDoc("analysis"), await project.readDoc("timeline"), await project.readDoc("styleTokens"), { intent, previous: await project.readDocOptional("color"), ...opts });
  await project.writeDoc("color", doc, { command: "color auto", message: `Color: ${doc.shots.length} shot(s) corrected, look ${doc.globalGrade?.look}` });
  return doc;
}
export * from "./metrics.js";
