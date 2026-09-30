import { BveError, clipDurationSec, round3, type Preset, type Project, type Timeline } from "../../core/src/index.js";

type Clip = Timeline["tracks"]["video"][number]["clips"][number];

function primary(tl: Timeline): Clip[] {
  const track = tl.tracks.video.find((v) => v.kind === "primary");
  if (!track) throw new BveError("VALIDATION", "Timeline has no primary video track");
  return track.clips;
}

/** Re-pack clips end to end (ripple) after an edit. */
export function ripple(tl: Timeline): Timeline {
  let t = 0;
  for (const c of primary(tl)) {
    if (c.enabled === false) continue;
    c.timelineStart = round3(t);
    t += clipDurationSec(c, tl.fps);
  }
  tl.durationSec = round3(t);
  const clips = primary(tl);
  for (const m of tl.markers ?? []) {
    if (m.kind === "section" || m.kind === "hook") {
      const first = clips.find((c) => `m_${c.sectionId}` === m.id && c.enabled !== false);
      if (first) m.time = first.timelineStart;
    }
    if (m.kind === "cta") m.time = Math.min(m.time, tl.durationSec);
  }
  return tl;
}

export function deleteClip(tl: Timeline, clipId: string): Timeline {
  const clips = primary(tl);
  const i = clips.findIndex((c) => c.id === clipId);
  if (i < 0) throw new BveError("NOT_FOUND", `Unknown clip "${clipId}"`, { hint: "See `bve timeline show`." });
  clips.splice(i, 1);
  if (!clips.length) throw new BveError("VALIDATION", "Refusing to delete the last clip");
  return ripple(tl);
}

export function trimClip(tl: Timeline, clipId: string, opts: { in?: number; out?: number }): Timeline {
  const clip = primary(tl).find((c) => c.id === clipId);
  if (!clip) throw new BveError("NOT_FOUND", `Unknown clip "${clipId}"`);
  const sIn = opts.in ?? clip.sourceIn;
  const sOut = opts.out ?? clip.sourceOut;
  if (sOut - sIn < 0.1) throw new BveError("VALIDATION", "A clip must last at least 0.1 s");
  clip.sourceIn = round3(sIn);
  clip.sourceOut = round3(sOut);
  return ripple(tl);
}

/**
 * Per-target reframing. Phase 1 modes: `center` (crop to aspect around the frame center) and
 * `fit-blur` (whole frame over a blurred fill). `face` needs the Phase 2 face tracker.
 */
export function setReframe(tl: Timeline, targetId: string, mode: "center" | "fit-blur" | "manual", keyframes?: NonNullable<Timeline["reframe"]>[string]["keyframes"]): Timeline {
  tl.reframe ??= {};
  tl.reframe[targetId] = { mode, smoothingSec: 0.8, ...(keyframes ? { keyframes } : {}) };
  return tl;
}

export function reframeFor(tl: Timeline, targetId: string) {
  return tl.reframe?.[targetId] ?? { mode: "center" as const };
}

/** Crop window (in source pixels) that fills the target aspect ratio. */
export function cropWindow(srcW: number, srcH: number, preset: Pick<Preset, "width" | "height">, cx = 0.5, cy = 0.5, scale = 1) {
  const targetAr = preset.width / preset.height;
  let w = srcW;
  let h = srcH;
  if (srcW / srcH > targetAr) w = srcH * targetAr;
  else h = srcW / targetAr;
  w = Math.floor(w / scale / 2) * 2;
  h = Math.floor(h / scale / 2) * 2;
  const x = Math.round(Math.min(Math.max(cx * srcW - w / 2, 0), srcW - w));
  const y = Math.round(Math.min(Math.max(cy * srcH - h / 2, 0), srcH - h));
  return { w, h, x, y };
}

export async function ensureReframes(project: Project, tl: Timeline): Promise<Timeline> {
  for (const t of project.manifest.targets) if (!tl.reframe?.[t.id]) setReframe(tl, t.id, "center");
  return tl;
}
