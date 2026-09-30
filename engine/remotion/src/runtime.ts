/** Turns style tokens into animation curves. Components call these; they never pick timings themselves. */
import { Easing, interpolate, spring } from "remotion";
import type { StyleTokens } from "../../core/src/types.generated.js";

const EXIT_EASE = Easing.bezier(0.4, 0, 1, 1);

/** 0 -> 1 entrance progress (may overshoot above 1 for spring brands). */
export function enter(frame: number, t: StyleTokens, delayFrames = 0): number {
  const f = frame - delayFrames;
  if (f <= 0) return 0;
  const e = t.motion.easing;
  if (e.kind === "spring") {
    return spring({ frame: f, fps: t.fps, config: { damping: e.damping, stiffness: e.stiffness, mass: e.mass }, durationInFrames: Math.round(t.motion.enterFrames * 1.6) });
  }
  const [x1, y1, x2, y2] = e.bezier as [number, number, number, number];
  return interpolate(f, [0, t.motion.enterFrames], [0, 1], { easing: Easing.bezier(x1, y1, x2, y2), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

/** 1 -> 0 exit progress over the last exitFrames of an element of `durationFrames`. */
export function exit(frame: number, durationFrames: number, t: StyleTokens): number {
  return interpolate(frame, [durationFrames - t.motion.exitFrames, durationFrames], [1, 0], { easing: EXIT_EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
}

export const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

const SERIF = /serif|garamond|canela|playfair|times|georgia|didot|bodoni|cormorant|lora|merriweather/i;

/** CSS stack: brand font, declared fallback, then a generic family of the same classification. */
export function fontStack(font: { family: string; fallback?: string }): string {
  const generic = SERIF.test(`${font.family} ${font.fallback ?? ""}`) && !/sans/i.test(font.family) ? "Georgia, 'Times New Roman', serif" : "'Segoe UI', Arial, Helvetica, sans-serif";
  return [font.family, font.fallback].filter(Boolean).map((f) => `"${f}"`).concat(generic).join(", ");
}

export function shadowCss(t: StyleTokens, u: number): string | undefined {
  switch (t.shape.shadow) {
    case "soft": return `0 ${8 * u}px ${24 * u}px rgba(0,0,0,0.25)`;
    case "hard": return `${6 * u}px ${6 * u}px 0 rgba(0,0,0,0.9)`;
    case "glow": return `0 0 ${28 * u}px ${t.color.accent}AA`;
    default: return undefined;
  }
}

export function applyCase(text: string, rule: StyleTokens["caption"]["case"]): string {
  if (rule === "upper") return text.toLocaleUpperCase();
  if (rule === "sentence") return text.charAt(0).toLocaleUpperCase() + text.slice(1);
  return text;
}
