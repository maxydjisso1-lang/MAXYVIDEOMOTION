/**
 * Pure layout math shared by the Remotion renderer, the ASS fallback renderer and QC.
 * One implementation = what QC checks is what the renderers draw.
 * (No Node imports here: this file is bundled for the browser by Remotion.)
 */
import type { Preset, StyleTokens } from "../../core/src/types.generated.js";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Anchor = "top-left" | "top" | "top-right" | "left" | "center" | "right" | "bottom-left" | "bottom" | "bottom-right" | "lower-third" | "safe-bottom" | "auto";

export interface Frame {
  width: number;
  height: number;
  safeZone: Preset["safeZone"];
}

/** Style tokens are authored for a 1080 px short side. */
export const unit = (f: Pick<Frame, "width" | "height">) => Math.min(f.width, f.height) / 1080;

export function safeRect(f: Frame): Box {
  const x = f.safeZone.left * f.width;
  const y = f.safeZone.top * f.height;
  return { x, y, w: f.width * (1 - f.safeZone.left - f.safeZone.right), h: f.height * (1 - f.safeZone.top - f.safeZone.bottom) };
}

/** Safe area minus the brand's breathing room (airy brands keep more margin). */
export function contentRect(f: Frame, tokens: StyleTokens): Box {
  const s = safeRect(f);
  const m = tokens.layout.marginPx * unit(f) * 0.5;
  return { x: s.x + m, y: s.y + m, w: s.w - 2 * m, h: s.h - 2 * m };
}

/** Average glyph advance as a fraction of font size. Conservative so QC over-estimates width. */
export function glyphRatio(upper: boolean, weight: number): number {
  return (upper ? 0.66 : 0.56) + (weight >= 800 ? 0.05 : weight >= 600 ? 0.02 : 0);
}

export function estimateTextWidth(text: string, fontPx: number, upper: boolean, weight: number): number {
  return [...text].length * fontPx * glyphRatio(upper, weight);
}

/** Greedy word wrap using the estimate; returns the lines. */
export function wrap(text: string, maxWidth: number, fontPx: number, upper: boolean, weight: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && estimateTextWidth(next, fontPx, upper, weight) > maxWidth) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Largest font size <= base that fits `maxLines` lines in `maxWidth` (never below `min`). */
export function fitFont(text: string, maxWidth: number, baseFontPx: number, maxLines: number, upper: boolean, weight: number, minFontPx = baseFontPx * 0.55): { fontPx: number; lines: string[] } {
  for (let size = baseFontPx; size >= minFontPx; size -= Math.max(1, baseFontPx * 0.04)) {
    const lines = wrap(text, maxWidth, size, upper, weight);
    if (lines.length <= maxLines && lines.every((l) => estimateTextWidth(l, size, upper, weight) <= maxWidth)) return { fontPx: Math.round(size), lines };
  }
  return { fontPx: Math.round(minFontPx), lines: wrap(text, maxWidth, minFontPx, upper, weight) };
}

/** Where a block of height `h` goes for an anchor, inside the content rect. */
export function anchorBox(f: Frame, tokens: StyleTokens, anchor: Anchor, h: number, widthRatio = 1): Box {
  const c = contentRect(f, tokens);
  const w = c.w * widthRatio;
  const left = tokens.layout.composition === "asymmetric" || tokens.layout.composition === "editorial" ? c.x : c.x + (c.w - w) / 2;
  switch (anchor) {
    case "top": case "top-left": case "top-right":
      return { x: anchor === "top-right" ? c.x + c.w - w : anchor === "top-left" ? c.x : left, y: c.y, w, h };
    case "center": case "left": case "right": case "auto":
      return { x: left, y: c.y + (c.h - h) / 2, w, h };
    case "lower-third":
      return { x: c.x, y: Math.min(c.y + c.h - h, f.height * 0.64), w, h };
    case "bottom": case "bottom-left": case "bottom-right": case "safe-bottom":
      return { x: left, y: c.y + c.h - h, w, h };
  }
}

export interface CaptionLayout {
  box: Box;
  fontPx: number;
  lineHeightPx: number;
  lines: string[];
}

function placeCaption(f: Frame, tokens: StyleTokens, lines: string[], fontPx: number): CaptionLayout {
  const u = unit(f);
  const c = contentRect(f, tokens);
  const lineHeightPx = fontPx * 1.18;
  const h = lines.length * lineHeightPx + tokens.caption.strokePx * u * 2;
  const pos = tokens.caption.position;
  const anchor: Anchor = pos === "center" ? "center" : pos === "lower-third" ? "lower-third" : "safe-bottom";
  const box = anchorBox(f, { ...tokens, layout: { ...tokens.layout, composition: "centered" } }, anchor, h);
  // Centered captions sit slightly below the optical center to leave faces free.
  if (pos === "center") box.y = Math.min(c.y + c.h - h, f.height * 0.58 - h / 2);
  return { box, fontPx, lineHeightPx, lines };
}

/** Caption block for a display text, wrapped greedily. */
export function captionLayout(f: Frame, tokens: StyleTokens, text: string, lines = tokens.caption.maxLines): CaptionLayout {
  const u = unit(f);
  const upper = tokens.caption.case === "upper";
  const fit = fitFont(text, contentRect(f, tokens).w, tokens.caption.sizePx * u, lines, upper, tokens.caption.weight);
  return placeCaption(f, tokens, fit.lines, fit.fontPx);
}

/**
 * Caption block for a cue: keeps the editorial line breaks from captions.json when they fit at
 * a legible size, otherwise re-wraps. Returns the word indexes after which a line breaks.
 * Remotion, the ASS renderer and QC all call this, so they agree on every line.
 */
export function cueLayout(f: Frame, tokens: StyleTokens, words: { text: string; lineBreakAfter?: boolean }[]): CaptionLayout & { breaks: Set<number> } {
  const u = unit(f);
  const upper = tokens.caption.case === "upper";
  const width = contentRect(f, tokens).w;
  const base = tokens.caption.sizePx * u;
  const explicit: string[][] = [[]];
  words.forEach((w, i) => {
    explicit.at(-1)!.push(w.text);
    if (w.lineBreakAfter && i < words.length - 1) explicit.push([]);
  });
  if (explicit.length <= tokens.caption.maxLines) {
    const lines = explicit.map((l) => l.join(" "));
    const fontPx = Math.min(...lines.map((l) => fitFont(l, width, base, 1, upper, tokens.caption.weight).fontPx));
    if (fontPx >= base * 0.75 && lines.every((l) => estimateTextWidth(l, fontPx, upper, tokens.caption.weight) <= width)) {
      const breaks = new Set<number>();
      let n = 0;
      for (const l of explicit.slice(0, -1)) breaks.add((n += l.length) - 1);
      return { ...placeCaption(f, tokens, lines, fontPx), breaks };
    }
  }
  const layout = captionLayout(f, tokens, words.map((w) => w.text).join(" "));
  const breaks = new Set<number>();
  let n = 0;
  for (const l of layout.lines.slice(0, -1)) breaks.add((n += l.split(/\s+/).length) - 1);
  return { ...layout, breaks };
}

export const DISPLAY_PX = 92;
export const CTA_PX = 64;

export interface TextBlockLayout {
  box: Box;
  fontPx: number;
  lines: string[];
  padPx: number;
}

/** Title/Subtitle block. Boxed shapes (block/pill) get padding; "line" brands get a hairline above. */
export function titleLayout(f: Frame, t: StyleTokens, displayText: string, anchor: Anchor): TextBlockLayout {
  const u = unit(f);
  const c = contentRect(f, t);
  const upper = t.caption.case === "upper";
  const padPx = t.shape.style === "line" || t.shape.style === "none" ? 0 : 28 * u;
  const fit = fitFont(displayText, c.w - padPx * 2.8, DISPLAY_PX * u, 2, upper, t.type.display.weight);
  const h = fit.lines.length * fit.fontPx * 1.1 + padPx * 1.4 + (t.shape.style === "line" ? 24 * u : 0);
  return { box: anchorBox(f, t, anchor, h), fontPx: fit.fontPx, lines: fit.lines, padPx };
}

export function ctaLayout(f: Frame, t: StyleTokens, displayText: string, anchor: Anchor, hasSubtext: boolean): TextBlockLayout {
  const u = unit(f);
  const c = contentRect(f, t);
  const upper = t.caption.case === "upper";
  // Button horizontal padding is 48 px each side at 1080.
  const fit = fitFont(displayText, c.w - 96 * u, CTA_PX * u, 1, upper, t.type.body.weight);
  const h = fit.fontPx * 1.2 + 44 * u + (hasSubtext ? 48 * u : 0);
  return { box: anchorBox(f, t, anchor, h), fontPx: fit.fontPx, lines: fit.lines, padPx: 48 * u };
}

export function lowerThirdBox(f: Frame, t: StyleTokens): Box {
  return anchorBox(f, t, "lower-third", 150 * unit(f), 0.8);
}

export function watermarkBox(f: Frame, t: StyleTokens, anchor: Anchor): Box {
  const h = Math.max(t.logo?.minHeightPx ?? 48, 56) * unit(f);
  return anchorBox(f, t, anchor, h, 0.3);
}

export const FULLSCREEN_COMPONENTS = new Set(["BrandIntro", "BrandOutro", "LogoReveal"]);

export function inside(inner: Box, outer: Box, tolerancePx = 1): boolean {
  return inner.x >= outer.x - tolerancePx && inner.y >= outer.y - tolerancePx && inner.x + inner.w <= outer.x + outer.w + tolerancePx && inner.y + inner.h <= outer.y + outer.h + tolerancePx;
}
