import React, { useEffect, useState } from "react";
import { AbsoluteFill, cancelRender, continueRender, delayRender, OffthreadVideo, Sequence, staticFile } from "remotion";
import { FULLSCREEN_COMPONENTS, motionObstacles, type Anchor, type Frame } from "../../motion/src/layout.js";
import { CaptionCue } from "./Captions.js";
import { COMPONENTS } from "./components.js";
import type { BrandVideoProps } from "./props.js";

/** Load every project font file before the first frame; a font that fails to load fails the render. */
function useProjectFonts(faces: BrandVideoProps["fontFaces"]) {
  const [handle] = useState(() => (faces.length ? delayRender("Loading brand fonts") : null));
  useEffect(() => {
    if (handle === null) return;
    Promise.all(
      faces.map(async (ff) => {
        const face = new FontFace(ff.family, `url("${staticFile(ff.src)}")`, { weight: String(ff.weight ?? 400) });
        (document.fonts as unknown as { add(f: FontFace): void }).add(await face.load());
      }),
    )
      .then(() => continueRender(handle))
      .catch((err) => cancelRender(new Error(`Brand font failed to load: ${err instanceof Error ? err.message : String(err)}`)));
  }, [faces, handle]);
}

export function BrandVideo(p: BrandVideoProps) {
  useProjectFonts(p.fontFaces);
  const frame: Frame = { width: p.width, height: p.height, safeZone: p.safeZone };
  const toF = (s: number) => Math.round(s * p.fps);
  const logo = p.logoSrc ? staticFile(p.logoSrc) : undefined;
  const fullscreen = p.instances.filter((i) => FULLSCREEN_COMPONENTS.has(i.component));
  const obstacles = motionObstacles(frame, p.tokens, p.instances);
  const hiddenAt = (start: number) => fullscreen.some((i) => start >= i.start && start < i.start + i.durationSec);

  return (
    // Transparent unless previewing with a base plate: the render is composited by FFmpeg.
    <AbsoluteFill style={{ background: p.baseSrc ? "#000" : "transparent" }}>
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
            <CaptionCue cue={c} tokens={p.tokens} frame={frame} fps={p.fps} obstacles={obstacles} />
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
