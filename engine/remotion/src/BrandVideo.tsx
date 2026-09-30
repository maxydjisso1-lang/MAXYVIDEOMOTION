import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile } from "remotion";
import { FULLSCREEN_COMPONENTS, type Anchor, type Frame } from "../../motion/src/layout.js";
import { CaptionCue } from "./Captions.js";
import { COMPONENTS } from "./components.js";
import type { BrandVideoProps } from "./props.js";

export function BrandVideo(p: BrandVideoProps) {
  const frame: Frame = { width: p.width, height: p.height, safeZone: p.safeZone };
  const toF = (s: number) => Math.round(s * p.fps);
  const logo = p.logoSrc ? staticFile(p.logoSrc) : undefined;
  const fullscreen = p.instances.filter((i) => FULLSCREEN_COMPONENTS.has(i.component));
  const hiddenAt = (start: number) => fullscreen.some((i) => start >= i.start && start < i.start + i.durationSec);
  const fontCss = p.fontFaces.map((ff) => `@font-face{font-family:"${ff.family}";src:url("${staticFile(ff.src)}");font-weight:${ff.weight ?? 400};font-display:block;}`).join("\n");

  return (
    // Transparent unless previewing with a base plate: the render is composited by FFmpeg.
    <AbsoluteFill style={{ background: p.baseSrc ? "#000" : "transparent" }}>
      {fontCss ? <style>{fontCss}</style> : null}
      {p.baseSrc ? <OffthreadVideo src={staticFile(p.baseSrc)} muted /> : null}
      {[...p.instances]
        .sort((a, b) => (a.layer ?? 1) - (b.layer ?? 1))
        .filter((i) => !FULLSCREEN_COMPONENTS.has(i.component))
        .map((i) => {
          const C = COMPONENTS[i.component];
          if (!C) return null;
          const dur = Math.max(1, toF(i.durationSec));
          return (
            <Sequence key={i.id} from={toF(i.start)} durationInFrames={dur} layout="none">
              <AbsoluteFill><C tokens={p.tokens} frame={frame} durationFrames={dur} anchor={(i.anchor ?? "auto") as Anchor} props={i.props} logoSrc={logo} /></AbsoluteFill>
            </Sequence>
          );
        })}
      {p.cues.filter((c) => !c.hidden && !hiddenAt(c.start)).map((c) => (
        <Sequence key={c.id} from={toF(c.start)} durationInFrames={Math.max(1, toF(c.end) - toF(c.start))} layout="none">
          <AbsoluteFill>
            <CaptionCue cue={c} tokens={p.tokens} frame={frame} fps={p.fps} />
          </AbsoluteFill>
        </Sequence>
      ))}
      {/* Full-screen brand cards sit above captions: captions are hidden while they are on. */}
      {fullscreen.map((i) => {
        const C = COMPONENTS[i.component]!;
        const dur = Math.max(1, toF(i.durationSec));
        return (
          <Sequence key={i.id} from={toF(i.start)} durationInFrames={dur} layout="none">
            <AbsoluteFill><C tokens={p.tokens} frame={frame} durationFrames={dur} anchor="center" props={i.props} logoSrc={logo} /></AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
