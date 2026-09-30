import React from "react";
import { useCurrentFrame } from "remotion";
import type { Captions as CaptionsDoc, StyleTokens } from "../../core/src/types.generated.js";
import { cueLayout, type Frame, unit } from "../../motion/src/layout.js";
import { applyCase, clamp01, enter, fontStack } from "./runtime.js";

type Cue = CaptionsDoc["cues"][number];

/** Brand-styled captions. Emphasis, case, animation and background all come from tokens. */
export function CaptionCue({ cue, tokens: t, frame, fps }: { cue: Cue; tokens: StyleTokens; frame: Frame; fps: number }) {
  const f = useCurrentFrame(); // relative to the cue's <Sequence>
  const now = cue.start + f / fps;
  const u = unit(frame);
  const display = cue.words.map((w, i) => applyCase(w.text, t.caption.case === "sentence" && i > 0 ? "as-spoken" : t.caption.case));
  const layout = cueLayout(frame, t, cue.words.map((w, i) => ({ text: display[i]!, lineBreakAfter: w.lineBreakAfter })));
  const cueIn = clamp01(f / Math.max(1, t.motion.enterFrames * 0.5));

  const lines: { text: string; emphasis?: string; start: number; idx: number }[][] = [[]];
  cue.words.forEach((w, i) => {
    lines.at(-1)!.push({ text: display[i]!, emphasis: w.emphasis, start: w.start, idx: i });
    if (layout.breaks.has(i)) lines.push([]);
  });

  const base: React.CSSProperties = {
    fontFamily: fontStack({ family: t.caption.family, fallback: t.caption.fallback }),
    fontWeight: t.caption.weight,
    fontSize: layout.fontPx,
    lineHeight: `${layout.lineHeightPx}px`,
    color: t.caption.textColor,
    textAlign: "center",
    whiteSpace: "nowrap",
  };
  if (t.caption.background === "shadow") base.textShadow = `0 ${3 * u}px ${10 * u}px rgba(0,0,0,0.75)`;
  if (t.caption.background === "stroke") {
    base.WebkitTextStroke = `${t.caption.strokePx * u}px #000`;
    base.paintOrder = "stroke fill";
  }

  const slide = t.caption.animation === "slide" ? (1 - cueIn) * 20 * u : 0;
  return (
    <div style={{ position: "absolute", left: layout.box.x, top: layout.box.y, width: layout.box.w, opacity: t.caption.animation === "none" ? 1 : cueIn, transform: `translateY(${slide}px)` }}>
      <div style={t.caption.background === "box" ? { background: "rgba(0,0,0,0.6)", borderRadius: 12 * u, padding: `${8 * u}px ${18 * u}px` } : undefined}>
        {lines.filter((l) => l.length).map((line, li) => (
          <div key={li} style={base}>
            {line.map((w) => {
              const spoken = now >= w.start;
              const wordFrame = Math.round((now - w.start) * fps);
              const popping = t.caption.animation === "pop" || t.caption.animation === "word-by-word";
              const p = popping ? (spoken ? enter(wordFrame, t) : 0) : 1;
              const emph = w.emphasis === "key" || w.emphasis === "strong";
              const style: React.CSSProperties = { display: "inline-block", marginRight: "0.28em" };
              if (popping) {
                style.opacity = t.caption.animation === "word-by-word" ? clamp01(p * 2) : clamp01(0.35 + p);
                style.transform = `scale(${0.75 + 0.25 * p})`;
              }
              if (t.caption.animation === "karaoke" && spoken) style.color = t.caption.highlightColor;
              if (emph) {
                switch (t.caption.emphasisStyle) {
                  case "color": style.color = t.caption.highlightColor; break;
                  case "scale": style.color = t.caption.highlightColor; style.transform = `${style.transform ?? ""} scale(${w.emphasis === "key" ? 1.18 : 1.08})`; break;
                  case "box": style.background = t.caption.highlightColor; style.color = t.color.onAccent; style.padding = `0 ${8 * u}px`; style.borderRadius = 8 * u; break;
                  case "underline": style.textDecoration = `underline ${t.caption.highlightColor} ${4 * u}px`; break;
                  case "weight": style.fontWeight = 900; break;
                }
              }
              return <span key={w.idx} style={style}>{w.text}</span>;
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
