/**
 * Pass A — FFmpeg: cut + color + reframe to the target geometry. Muted, high quality.
 * Each clip is its own seeked input, so long sources are never decoded from the start.
 */
import { clipDurationSec, clipFrames, type Analysis, type ColorDoc, type Preset, type Project, type StyleTokens, type Timeline } from "../../core/src/index.js";
import { clipColorFilters, normalizeColorimetryFilter } from "../../color/src/index.js";
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

/**
 * x264 settings of an intermediate pass (base plate, graphics overlay). Final quality: lossless and
 * fast — only the delivery encode compresses (docs/measurements/render-performance.md). Draft: unchanged.
 */
export function intermediateEncode(draft: boolean): string[] {
  return draft ? ["-preset", "veryfast", "-crf", "22"] : ["-preset", "ultrafast", "-qp", "0"];
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
    // Every source re-expressed as BT.709 limited range first (its tag, else HD=709 / SD=601): the final
    // encode tags BT.709, and an untagged HD source was otherwise read as BT.601 (≈2 ΔE, docs/measurements/color.md).
    const color = [normalizeColorimetryFilter(src.probe), ...clipColorFilters(args.color, c.sourceId, (c.sourceIn + c.sourceOut) / 2, args.analysis, args.tokens, lut)];
    const zoom = c.zoom?.[0]?.scale ?? 1;
    const kf = reframe.keyframes?.find((k) => k.clipId === c.id);
    const f = [`setpts=PTS-STARTPTS`, `fps=${g.fps}`, `trim=end_frame=${clipFrames(c, g.fps)}`];
    if (reframe.mode === "fit-blur") {
      f.push(...color);
      const fg = `scale=${g.width}:${g.height}:force_original_aspect_ratio=decrease:flags=lanczos`;
      chains.push(
        `[${i}:v]${f.join(",")},split[bg${i}][fg${i}];` +
        `[bg${i}]scale=${g.width}:${g.height}:force_original_aspect_ratio=increase,crop=${g.width}:${g.height},boxblur=24:2[bgb${i}];` +
        `[fg${i}]${fg}[fgs${i}];[bgb${i}][fgs${i}]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v${i}]`,
      );
    } else {
      const win = cropWindow(sw, sh, { width: g.width, height: g.height }, kf?.cx ?? 0.5, kf?.cy ?? 0.5, (kf?.scale ?? 1) * zoom);
      // Colour filters are per-pixel: on the cropped window they give the same pixels for a fraction of
      // the work (chantier 6: a 9:16 crop of a 16:9 source keeps 32 % of the pixels). Only with an even
      // offset: on subsampled YUV an odd crop offset is rounded, so it then stays after the colour.
      const crop = `crop=${win.w}:${win.h}:${win.x}:${win.y}`;
      if (win.x % 2 === 0 && win.y % 2 === 0) f.push(crop, ...color);
      else f.push(...color, crop);
      f.push(`scale=${g.width}:${g.height}:flags=lanczos`, "setsar=1", "format=yuv420p");
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
      // Intermediate, never delivered: lossless and fast (chantier 6). medium/crf14 cost ≈26 s of encoding
      // on the reference render and added a compression generation; ultrafast/qp0 encodes in <1 s.
      "-c:v", "libx264", ...intermediateEncode(draft),
      // Short GOP, no B-frames: Remotion seeks into this file frame by frame (B-frame reordering
      // with negative DTS makes its compositor miss frames).
      "-g", String(Math.round(g.fps / 2)), "-bf", "0", "-pix_fmt", "yuv420p", "-t", total.toFixed(3),
      out,
    ],
    { log: project.log, cwd: project.root },
  );
}
