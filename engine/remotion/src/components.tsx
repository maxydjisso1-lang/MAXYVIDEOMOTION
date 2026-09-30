/**
 * Brand motion components. Each one reads ONLY style tokens + content props.
 * Variants come from tokens.shape.style ("line" | "block" | "pill" | ...), motion from
 * tokens.motion (duration, easing curve or spring, amplitude, stagger).
 */
import React from "react";
import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { StyleTokens } from "../../core/src/types.generated.js";
import { anchorBox, ctaLayout, lowerThirdBox, titleLayout, unit, watermarkBox, type Anchor, type Frame } from "../../motion/src/layout.js";
import { applyCase, clamp01, enter, exit, fontStack, shadowCss } from "./runtime.js";

export interface ComponentProps {
  tokens: StyleTokens;
  frame: Frame;
  durationFrames: number;
  anchor: Anchor;
  props: Record<string, unknown>;
  logoSrc?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function useAnim(t: StyleTokens, durationFrames: number) {
  const f = useCurrentFrame();
  const pin = enter(f, t);
  const pout = exit(f, durationFrames, t);
  return { f, pin, pout, vis: Math.min(clamp01(pin), pout) };
}

/** Text that staggers word by word for energetic brands, as one block for calm ones. */
function StaggerText({ text, t, color, fontPx, family, weight, align }: { text: string; t: StyleTokens; color: string; fontPx: number; family: string; weight: number; align: "left" | "center" }) {
  const f = useCurrentFrame();
  const u = 1;
  const words = text.split(/\s+/);
  return (
    <div style={{ fontFamily: family, fontWeight: weight, fontSize: fontPx, lineHeight: 1.08, color, textAlign: align, letterSpacing: t.motion.energy < 0.35 ? "0.02em" : "-0.01em" }}>
      {words.map((w, i) => {
        const p = enter(f, t, i * t.motion.staggerFrames);
        const y = (1 - clamp01(p)) * t.motion.distancePx * 0.6 * u;
        const s = t.motion.scaleFrom + (1 - t.motion.scaleFrom) * p;
        return (
          <span key={i} style={{ display: "inline-block", opacity: clamp01(p * 1.4), transform: `translateY(${y}px) scale(${s})`, marginRight: "0.25em" }}>
            {w}
          </span>
        );
      })}
    </div>
  );
}

export function Title({ tokens: t, frame, durationFrames, anchor, props }: ComponentProps) {
  const { pin, pout, vis } = useAnim(t, durationFrames);
  const u = unit(frame);
  const upper = t.caption.case === "upper";
  const text = applyCase(str(props.text), upper ? "upper" : "as-spoken");
  const { box, fontPx, lines, padPx: pad } = titleLayout(frame, t, text, anchor);
  const fit = { fontPx, lines };
  const align = t.layout.composition === "centered" ? "center" : "left";
  const family = fontStack(t.type.display);

  if (t.shape.style === "line") {
    // Minimal: a hairline draws, text rises a few pixels. Nothing bounces.
    return (
      <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, opacity: pout }}>
        <div style={{ height: t.shape.strokePx * u, width: `${30 * clamp01(pin)}%`, background: t.color.accent, marginBottom: 20 * u, marginLeft: align === "center" ? "auto" : 0, marginRight: align === "center" ? "auto" : 0 }} />
        <div style={{ opacity: clamp01(pin), transform: `translateY(${(1 - clamp01(pin)) * t.motion.distancePx * u}px)`, fontFamily: family, fontWeight: t.type.display.weight, fontSize: fit.fontPx, lineHeight: 1.1, color: "#FFFFFF", textAlign: align, textShadow: "0 2px 12px rgba(0,0,0,0.45)" }}>
          {fit.lines.join(" ")}
        </div>
      </div>
    );
  }
  const bg = t.color.accent;
  const fg = t.color.onAccent;
  const radius = t.shape.style === "pill" ? 999 : t.shape.radiusPx * u;
  const scale = t.shape.style === "pill" ? t.motion.scaleFrom + (1 - t.motion.scaleFrom) * pin : 1;
  const reveal = t.shape.style === "block" ? `inset(0 ${100 - 100 * clamp01(pin)}% 0 0)` : undefined;
  return (
    <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, display: "flex", justifyContent: align === "center" ? "center" : "flex-start", opacity: t.shape.style === "block" ? pout : vis }}>
      <div style={{ background: bg, color: fg, borderRadius: radius, padding: `${pad * 0.7}px ${pad * 1.4}px`, transform: `scale(${scale})`, clipPath: reveal, boxShadow: shadowCss(t, u), maxWidth: box.w }}>
        <StaggerText text={fit.lines.join(" ")} t={t} color={fg} fontPx={fit.fontPx} family={family} weight={t.type.display.weight} align={align} />
      </div>
    </div>
  );
}

export function CTA({ tokens: t, frame, durationFrames, anchor, props }: ComponentProps) {
  const { f, pin, pout, vis } = useAnim(t, durationFrames);
  const u = unit(frame);
  const upper = t.caption.case === "upper";
  const text = applyCase(str(props.text), upper ? "upper" : "as-spoken");
  const fit = ctaLayout(frame, t, text, anchor, !!props.subtext);
  const box = fit.box;
  const family = fontStack(t.type.body);
  // Energetic brands pulse the button on a steady beat once it has landed.
  const pulse = t.motion.energy > 0.6 && f > t.motion.enterFrames ? 1 + 0.035 * Math.sin(((f - t.motion.enterFrames) / t.fps) * Math.PI * 2 * 1.8) : 1;
  const line = t.shape.style === "line";
  return (
    <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, display: "flex", flexDirection: "column", alignItems: t.layout.composition === "centered" || !line ? "center" : "flex-start", opacity: line ? vis : pout }}>
      <div
        style={{
          fontFamily: family, fontWeight: t.type.body.weight, fontSize: fit.fontPx, whiteSpace: "nowrap",
          color: line ? "#FFFFFF" : t.color.onAccent,
          background: line ? "transparent" : t.color.accent,
          border: line ? `${Math.max(2, t.shape.strokePx * u)}px solid ${t.color.accent}` : "none",
          borderRadius: t.shape.style === "pill" ? 999 : t.shape.radiusPx * u,
          padding: `${22 * u}px ${48 * u}px`,
          boxShadow: shadowCss(t, u),
          letterSpacing: line ? "0.08em" : "0",
          transform: `translateY(${(1 - clamp01(pin)) * t.motion.distancePx * u}px) scale(${(t.motion.scaleFrom + (1 - t.motion.scaleFrom) * pin) * pulse})`,
          textShadow: line ? "0 2px 12px rgba(0,0,0,0.5)" : undefined,
        }}
      >
        {text}
      </div>
      {props.subtext ? (
        <div style={{ marginTop: 14 * u, fontFamily: family, fontSize: 34 * u, color: "#FFFFFF", opacity: clamp01(enter(f, t, t.motion.staggerFrames * 3 + 4)), textShadow: "0 2px 10px rgba(0,0,0,0.5)" }}>{str(props.subtext)}</div>
      ) : null}
    </div>
  );
}

export function LowerThird({ tokens: t, frame, durationFrames, props }: ComponentProps) {
  const { pin, vis } = useAnim(t, durationFrames);
  const u = unit(frame);
  const box = lowerThirdBox(frame, t);
  const family = fontStack(t.type.body);
  return (
    <div style={{ position: "absolute", left: box.x, top: box.y, opacity: vis, transform: `translateX(${-(1 - clamp01(pin)) * t.motion.distancePx * u}px)` }}>
      <div style={{ display: "flex", alignItems: "stretch", gap: 18 * u }}>
        <div style={{ width: Math.max(4, t.shape.strokePx * 2) * u, background: t.color.accent, borderRadius: t.shape.style === "pill" ? 999 : 0 }} />
        <div>
          <div style={{ fontFamily: fontStack(t.type.display), fontWeight: t.type.display.weight, fontSize: 52 * u, color: "#FFFFFF", textShadow: "0 2px 10px rgba(0,0,0,0.5)" }}>{str(props.name)}</div>
          {props.title ? <div style={{ fontFamily: family, fontSize: 32 * u, color: t.color.accent, marginTop: 4 * u }}>{str(props.title)}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function Watermark({ tokens: t, frame, durationFrames, anchor, logoSrc }: ComponentProps) {
  const { vis } = useAnim(t, durationFrames);
  if (!logoSrc) return null;
  const u = unit(frame);
  const box = watermarkBox(frame, t, anchor);
  const h = box.h;
  return (
    <div style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: h, display: "flex", justifyContent: anchor.endsWith("right") ? "flex-end" : "flex-start", opacity: vis * (t.logo?.watermark?.opacity ?? 0.8) }}>
      <Img src={logoSrc} style={{ height: h, objectFit: "contain", filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.25))" }} />
    </div>
  );
}

/** Full-frame end card. The reveal uses the brand's transition style. */
export function BrandOutro({ tokens: t, frame, logoSrc }: ComponentProps) {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const u = unit(frame);
  const p = clamp01(enter(f, t));
  const logoP = enter(f, t, Math.round(t.motion.enterFrames * 0.6));
  const reveal: React.CSSProperties = (() => {
    switch (t.motion.transition) {
      case "wipe": return { clipPath: `inset(0 ${100 - 100 * p}% 0 0)` };
      case "slide": return { transform: `translateY(${(1 - p) * height}px)` };
      case "zoom": return { transform: `scale(${1.25 - 0.25 * p})`, opacity: p };
      case "mask": case "blur": return { clipPath: `circle(${p * 75}% at 50% 50%)` };
      default: return { opacity: p };
    }
  })();
  const logoH = Math.min(width, height) * 0.2;
  return (
    <AbsoluteFill style={{ background: t.color.background, alignItems: "center", justifyContent: "center", ...reveal }}>
      {logoSrc ? (
        <Img src={logoSrc} style={{ height: logoH, objectFit: "contain", opacity: clamp01(logoP), transform: `scale(${t.motion.scaleFrom + (1 - t.motion.scaleFrom) * logoP}) translateY(${(1 - clamp01(logoP)) * t.motion.distancePx * u}px)` }} />
      ) : (
        <div style={{ fontFamily: fontStack(t.type.display), fontSize: 110 * u, color: t.color.foreground, opacity: clamp01(logoP) }}>{t.brandName}</div>
      )}
      {t.shape.style === "line" ? (
        <div style={{ marginTop: 36 * u, height: t.shape.strokePx * u, width: `${24 * clamp01(enter(f, t, t.motion.enterFrames))}%`, background: t.color.accent }} />
      ) : (
        <div style={{ marginTop: 40 * u, width: 140 * u * clamp01(enter(f, t, t.motion.enterFrames)), height: 18 * u, borderRadius: t.shape.style === "pill" ? 999 : t.shape.radiusPx * u, background: t.color.accent, boxShadow: shadowCss(t, u) }} />
      )}
    </AbsoluteFill>
  );
}

/** Section transition overlay, symmetric around the cut. */
export function Transition({ tokens: t, durationFrames }: ComponentProps) {
  const f = useCurrentFrame();
  const { width } = useVideoConfig();
  const half = durationFrames / 2;
  const tri = f < half ? f / half : (durationFrames - f) / half;
  const progress = f / durationFrames;
  switch (t.motion.transition) {
    case "wipe":
      return <AbsoluteFill style={{ background: t.color.accent, transform: `translateX(${interpolate(progress, [0, 1], [-width, width])}px)` }} />;
    case "slide":
      return <AbsoluteFill style={{ background: t.color.primary, transform: `translateY(${interpolate(progress, [0, 1], [100, -100])}%)` }} />;
    case "zoom":
      return (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ width: width * 2 * clamp01(tri), height: width * 2 * clamp01(tri), borderRadius: "50%", background: t.color.accent, opacity: 0.9 }} />
        </AbsoluteFill>
      );
    default:
      return <AbsoluteFill style={{ background: t.color.background, opacity: 0.85 * clamp01(tri) }} />;
  }
}

export const COMPONENTS: Record<string, React.ComponentType<ComponentProps>> = {
  Title,
  Subtitle: Title,
  CTA,
  LowerThird,
  Watermark,
  BrandOutro,
  BrandIntro: BrandOutro,
  LogoReveal: BrandOutro,
  Transition,
};
