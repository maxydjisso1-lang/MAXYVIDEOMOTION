/**
 * Brand DNA -> Style Tokens.
 *
 * This is the ONLY place where brand identity is translated into concrete rendering values.
 * Every mapping below is a reviewable design decision; components never invent style values.
 */
import { SCHEMA_VERSION, sha256Json, type Brand, type StyleTokens } from "../../core/src/index.js";
import { bestTextOn } from "./color.js";

type Motion = Brand["motion"];

/** Enter duration (seconds) by brand speed. Exit is shorter: things leave faster than they arrive. */
export const SPEED_ENTER_SEC: Record<Motion["speed"], number> = { slow: 0.8, medium: 0.5, fast: 0.27 };
export const SPEED_MIN_HOLD_SEC: Record<Motion["speed"], number> = { slow: 1.6, medium: 1.1, fast: 0.7 };
const EXIT_RATIO = 0.7;

export const EASING: Record<Extract<Motion["easing"], string>, StyleTokens["motion"]["easing"]> = {
  linear: { kind: "bezier", bezier: [0, 0, 1, 1] },
  standard: { kind: "bezier", bezier: [0.4, 0, 0.2, 1] },
  emphasized: { kind: "bezier", bezier: [0.2, 0, 0, 1] },
  decelerate: { kind: "bezier", bezier: [0, 0, 0.2, 1] },
  "spring-soft": { kind: "spring", damping: 20, stiffness: 90, mass: 1 },
  "spring-snappy": { kind: "spring", damping: 11, stiffness: 210, mass: 0.6 },
  bounce: { kind: "spring", damping: 7, stiffness: 180, mass: 0.8 },
};

/** Travel distance (px @1080) and starting scale by amplitude. */
export const AMPLITUDE: Record<Motion["amplitude"], { distancePx: number; scaleFrom: number }> = {
  subtle: { distancePx: 14, scaleFrom: 1 },
  moderate: { distancePx: 48, scaleFrom: 0.92 },
  bold: { distancePx: 120, scaleFrom: 0.7 },
};

const DEFAULT_ENERGY: Record<Motion["speed"], number> = { slow: 0.2, medium: 0.5, fast: 0.8 };
const MARGIN_PX = { airy: 96, balanced: 64, dense: 40 } as const;
const CAPTION_BASE_PX = 62;

function font(brand: Brand, roleOrFamily: string, fallbackRole: "display" | "body" | "caption") {
  const fonts = brand.identity.fonts;
  const f = fonts.find((x) => x.role === roleOrFamily) ?? fonts.find((x) => x.family === roleOrFamily) ?? fonts.find((x) => x.role === fallbackRole) ?? fonts[0]!;
  const weight = Math.max(...(f.weights?.length ? f.weights : [fallbackRole === "body" ? 400 : 700]));
  return {
    family: f.family,
    weight,
    ...(f.fallback ? { fallback: f.fallback } : {}),
    ...(f.source?.kind === "file" && f.source.path ? { file: f.source.path } : {}),
  };
}

export function compileStyleTokens(brand: Brand, fps: number): StyleTokens {
  const m = brand.motion;
  const energy = m.energy ?? DEFAULT_ENERGY[m.speed];
  const easing = Array.isArray(m.easing) ? { kind: "bezier" as const, bezier: m.easing } : EASING[m.easing];
  const enterFrames = Math.max(2, Math.round(SPEED_ENTER_SEC[m.speed] * fps));
  const amp = AMPLITUDE[m.amplitude];

  const id = brand.identity;
  const primary = id.primaryColors[0]!.hex;
  const secondary = id.secondaryColors?.[0]?.hex ?? primary;
  const accent = id.accentColors?.[0]?.hex ?? primary;
  const background = id.neutrals?.background ?? primary;
  const foreground = id.neutrals?.foreground ?? bestTextOn(background);
  const muted = id.neutrals?.muted ?? foreground;
  const cap = brand.caption;
  const captionFont = font(brand, cap.font, "caption");
  const palette = [...new Set([
    ...id.primaryColors, ...(id.secondaryColors ?? []), ...(id.accentColors ?? []),
  ].map((c) => c.hex.toUpperCase()).concat([background, foreground, muted].map((c) => c.toUpperCase())))];

  const tokens: StyleTokens = {
    schemaVersion: SCHEMA_VERSION,
    brandName: brand.name,
    brandHash: sha256Json(brand),
    fps,
    color: {
      primary, secondary, accent, background, foreground, muted,
      onPrimary: bestTextOn(primary),
      onAccent: bestTextOn(accent),
      palette,
    },
    type: {
      display: font(brand, "display", "display"),
      body: font(brand, "body", "body"),
      caption: captionFont,
    },
    shape: {
      style: brand.visual.shapes ?? "block",
      radiusPx: brand.visual.shapes === "pill" ? 999 : brand.visual.radius,
      shadow: brand.visual.shadows,
      strokePx: brand.visual.shapes === "line" ? 3 : 0,
    },
    motion: {
      enterFrames,
      exitFrames: Math.max(2, Math.round(enterFrames * EXIT_RATIO)),
      minHoldFrames: Math.round(SPEED_MIN_HOLD_SEC[m.speed] * fps),
      // Only energetic brands stagger words/elements.
      staggerFrames: energy >= 0.45 ? Math.max(1, Math.round(fps * 0.05 * energy)) : 0,
      easing,
      distancePx: amp.distancePx,
      scaleFrom: amp.scaleFrom,
      overshoot: easing.kind === "spring" ? Math.round(Math.min(0.35, energy * 0.3) * 100) / 100 : 0,
      transition: m.transitionStyle,
      transitionFrames: m.transitionStyle === "cut" ? 0 : Math.max(2, Math.round(enterFrames * 0.8)),
      energy,
    },
    caption: {
      family: captionFont.family,
      ...(captionFont.fallback ? { fallback: captionFont.fallback } : {}),
      weight: cap.weight ?? 700,
      sizePx: Math.round(CAPTION_BASE_PX * (cap.sizeScale ?? 1)),
      case: cap.case ?? "as-spoken",
      position: cap.position,
      animation: cap.animation,
      emphasisStyle: cap.emphasisStyle ?? "color",
      background: cap.background ?? "shadow",
      maxWordsPerLine: cap.maxWordsPerLine ?? 5,
      maxLines: cap.maxLines ?? 2,
      textColor: cap.textColor ?? "#FFFFFF",
      highlightColor: cap.highlightColor,
      strokePx: cap.background === "stroke" ? 6 : 0,
    },
    layout: {
      density: brand.visual.density ?? "balanced",
      composition: brand.visual.composition,
      marginPx: MARGIN_PX[brand.visual.density ?? "balanced"],
    },
    grade: {
      look: brand.grade?.look ?? "natural",
      intensity: brand.grade?.intensity ?? 0.5,
      saturation: brand.grade?.saturation ?? 0,
      warmth: brand.grade?.warmth ?? 0,
      ...(brand.grade?.lut ? { lut: brand.grade.lut } : {}),
      protectSkinTones: brand.grade?.protectSkinTones ?? true,
    },
    logo: {
      primary: id.logo.primary,
      ...(id.logo.monochrome ? { monochrome: id.logo.monochrome } : {}),
      ...(id.logo.clearSpace !== undefined ? { clearSpace: id.logo.clearSpace } : {}),
      ...(id.logo.minHeightPx !== undefined ? { minHeightPx: id.logo.minHeightPx } : {}),
      ...(id.logo.watermark ? { watermark: { ...id.logo.watermark } } : {}),
    },
  };
  return tokens;
}

/** Seconds helpers derived from tokens (used by motion planning, captions and QC). */
export const tokenSec = (t: StyleTokens) => ({
  enter: t.motion.enterFrames / t.fps,
  exit: t.motion.exitFrames / t.fps,
  minHold: t.motion.minHoldFrames / t.fps,
  transition: t.motion.transitionFrames / t.fps,
});
