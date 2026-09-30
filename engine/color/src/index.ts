/**
 * Color = correction (technical, per shot, measured) + grade (creative, from style tokens).
 * Both stay parameters in color.json and are compiled to FFmpeg filters at render time.
 */
import { round3, SCHEMA_VERSION, type Analysis, type ColorDoc, type StyleTokens, type Timeline } from "../../core/src/index.js";
import { hasFilter } from "../../ffmpeg/src/index.js";

type ShotEntry = ColorDoc["shots"][number];
type Correction = NonNullable<ShotEntry["correction"]>;
type Grade = NonNullable<ColorDoc["globalGrade"]>;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const TARGET_MEAN = 0.46;
const MAX_EV = 1.5;

export function autoCorrection(shot: Analysis["sources"][number]["shots"][number], protectSkin = true): { correction: Correction; reason: string } {
  const reasons: string[] = [];
  const luma = shot.luma ?? { mean: TARGET_MEAN, p05: 0.05, p95: 0.9 };
  const mean = Math.max(0.02, luma.mean ?? TARGET_MEAN);
  // Gentle: correct 70% of the way, deadband ±0.15 EV, hard clamp ±1.5 EV (8-bit footage breaks beyond).
  let exposure = Math.log2(TARGET_MEAN / mean) * 0.7;
  exposure = Math.abs(exposure) < 0.15 ? 0 : clamp(exposure, -MAX_EV, MAX_EV);
  if (exposure) reasons.push(`${exposure > 0 ? "brightened" : "darkened"} ${Math.abs(exposure).toFixed(2)} EV (luma mean ${mean.toFixed(2)})`);

  const range = (luma.p95 ?? 0.9) - (luma.p05 ?? 0.05);
  const contrast = range < 0.6 ? round3(clamp((0.7 - range) * 0.6, 0, 0.3)) : 0;
  if (contrast) reasons.push(`contrast +${contrast} (flat image, range ${range.toFixed(2)})`);

  // Gray-world white balance, half strength (and less with skin protection) to avoid over-neutralising.
  const [r, g, b] = shot.rgbMean ?? [0.5, 0.5, 0.5];
  const avg = (r + g + b) / 3 || 0.5;
  const strength = protectSkin ? 0.35 : 0.5;
  const gains = [r, g, b].map((c) => round3(clamp(1 + (avg / Math.max(0.02, c) - 1) * strength, 0.85, 1.15))) as [number, number, number];
  const castMagnitude = Math.max(...gains.map((x) => Math.abs(x - 1)));
  const whiteBalance: Correction["whiteBalance"] = castMagnitude > 0.02 ? { mode: "auto-gray-world", gains } : { mode: "as-shot" };
  if (whiteBalance.mode !== "as-shot") reasons.push(`white balance gains ${gains.join("/")}`);

  return {
    correction: { exposure: round3(exposure), contrast, whiteBalance, protectSkinTones: protectSkin },
    reason: reasons.length ? reasons.join("; ") : "within tolerance: no correction",
  };
}

export function gradeFromTokens(tokens: StyleTokens): Grade {
  return {
    look: tokens.grade.look,
    intensity: tokens.grade.intensity,
    ...(tokens.grade.lut ? { lut: tokens.grade.lut } : {}),
  };
}

/** Correct every analysed shot that the timeline actually uses; grade comes from the brand. */
export function autoColor(analysis: Analysis, timeline: Timeline, tokens: StyleTokens, opts: { intent?: "correct-only" | "brand-look"; previous?: ColorDoc } = {}): ColorDoc {
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
      const { correction, reason } = autoCorrection(shot, tokens.grade.protectSkinTones ?? true);
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

function correctionFilters(c: Correction | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  const ev = 2 ** (c.exposure ?? 0);
  const [gr, gg, gb] = c.whiteBalance?.mode && c.whiteBalance.mode !== "as-shot" && c.whiteBalance.gains ? c.whiteBalance.gains : [1, 1, 1];
  if (Math.abs(ev - 1) > 1e-3 || gr !== 1 || gg !== 1 || gb !== 1) {
    // Exposure and white balance are both per-channel gains: one pass.
    out.push(`colorchannelmixer=rr=${round3(ev * gr)}:gg=${round3(ev * gg)}:bb=${round3(ev * gb)}`);
  }
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
