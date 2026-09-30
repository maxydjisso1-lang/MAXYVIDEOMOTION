/**
 * Pass A — FFmpeg: cut + color + reframe to the target geometry. Muted, high quality.
 * Each clip is its own seeked input, so long sources are never decoded from the start.
 */
import { clipDurationSec, clipFrames, type Analysis, type ColorDoc, type Preset, type Project, type StyleTokens, type Timeline } from "../../core/src/index.js";
import { clipColorFilters } from "../../color/src/index.js";
import { cropWindow, reframeFor } from "../../editing/src/index.js";
import { ffmpeg } from "../../ffmpeg/src/index.js";

export interface Geometry {
  width: number;
  height: number;
  fps: number;
}

export function geometry(preset: Preset, draft: boolean): Geometry {
  const even = (n: number) => Math.round(n / 2) * 2;
  return draft ? { width: even(preset.width / 2), height: even(preset.height / 2), fps: preset.fps } : { width: preset.width, height: preset.height, fps: preset.fps };
}

export function activeClips(tl: Timeline) {
  return tl.tracks.video.filter((t) => t.kind === "primary").flatMap((t) => t.clips).filter((c) => c.enabled !== false);
}

export async function renderBasePlate(
  project: Project,
  args: { timeline: Timeline; color?: ColorDoc; analysis?: Analysis; tokens: StyleTokens; preset: Preset; targetId: string; draft: boolean },
  out: string,
): Promise<void> {
  const { timeline, preset, draft } = args;
  const g = geometry(preset, draft);
  const clips = activeClips(timeline);
  const reframe = reframeFor(timeline, args.targetId);
  const lut = args.tokens.grade.lut ? project.abs(args.tokens.grade.lut) : undefined;
  const inputs: string[] = [];
  const chains: string[] = [];

  clips.forEach((c, i) => {
    const src = project.source(c.sourceId);
    const dur = clipDurationSec(c, g.fps);
    // Read a little extra and cut to an exact frame count below: clips never gain or lose a frame.
    inputs.push("-ss", c.sourceIn.toFixed(3), "-t", (dur + 0.1).toFixed(3), "-i", project.sourceMediaPath(c.sourceId));
    const sw = src.probe.width ?? g.width;
    const sh = src.probe.height ?? g.height;
    const color = clipColorFilters(args.color, c.sourceId, (c.sourceIn + c.sourceOut) / 2, args.analysis, args.tokens, lut);
    const zoom = c.zoom?.[0]?.scale ?? 1;
    const kf = reframe.keyframes?.find((k) => k.clipId === c.id);
    const f = [`setpts=PTS-STARTPTS`, `fps=${g.fps}`, `trim=end_frame=${clipFrames(c, g.fps)}`, ...color];
    if (reframe.mode === "fit-blur") {
      const fg = `scale=${g.width}:${g.height}:force_original_aspect_ratio=decrease:flags=lanczos`;
      chains.push(
        `[${i}:v]${f.join(",")},split[bg${i}][fg${i}];` +
        `[bg${i}]scale=${g.width}:${g.height}:force_original_aspect_ratio=increase,crop=${g.width}:${g.height},boxblur=24:2[bgb${i}];` +
        `[fg${i}]${fg}[fgs${i}];[bgb${i}][fgs${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v${i}]`,
      );
    } else {
      const win = cropWindow(sw, sh, { width: g.width, height: g.height }, kf?.cx ?? 0.5, kf?.cy ?? 0.5, (kf?.scale ?? 1) * zoom);
      f.push(`crop=${win.w}:${win.h}:${win.x}:${win.y}`, `scale=${g.width}:${g.height}:flags=lanczos`, "setsar=1", "format=yuv420p");
      chains.push(`[${i}:v]${f.join(",")}[v${i}]`);
    }
  });
  const graph = `${chains.join(";")};${clips.map((_, i) => `[v${i}]`).join("")}concat=n=${clips.length}:v=1:a=0[vout]`;
  const total = clips.reduce((a, c) => a + clipDurationSec(c, g.fps), 0);
  await ffmpeg(
    [
      ...inputs,
      "-filter_complex", graph,
      "-map", "[vout]", "-an",
      "-c:v", "libx264", "-preset", draft ? "veryfast" : "medium", "-crf", draft ? "22" : "14",
      // Short GOP, no B-frames: Remotion seeks into this file frame by frame (B-frame reordering
      // with negative DTS makes its compositor miss frames).
      "-g", String(Math.round(g.fps / 2)), "-bf", "0", "-pix_fmt", "yuv420p", "-t", total.toFixed(3),
      out,
    ],
    { log: project.log, cwd: project.root },
  );
}
