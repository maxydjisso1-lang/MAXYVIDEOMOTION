/** Time helpers. Documents store seconds; rendering snaps to frames. */

export const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const toFrames = (seconds: number, fps: number) => Math.round(seconds * fps);

export const snapToFrame = (seconds: number, fps: number) => round3(Math.round(seconds * fps) / fps);

export interface Range {
  start: number;
  end: number;
}

export const overlaps = (a: Range, b: Range) => a.start < b.end && b.start < a.end;

/** Subtract a set of ranges from one range; returns the remaining pieces in order. */
export function subtractRanges(base: Range, cuts: Range[]): Range[] {
  let pieces: Range[] = [{ ...base }];
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    const next: Range[] = [];
    for (const p of pieces) {
      if (!overlaps(p, cut)) {
        next.push(p);
        continue;
      }
      if (cut.start > p.start) next.push({ start: p.start, end: cut.start });
      if (cut.end < p.end) next.push({ start: cut.end, end: p.end });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.end - p.start > 1e-6);
}

/** Complement of `ranges` within [0, duration]. */
export function invertRanges(ranges: Range[], duration: number): Range[] {
  return subtractRanges({ start: 0, end: duration }, ranges);
}

/** Frame-exact length of a clip on the timeline. Every renderer uses this, never raw subtraction. */
export function clipFrames(clip: { sourceIn: number; sourceOut: number; speed?: number }, fps: number): number {
  return Math.max(1, Math.round(((clip.sourceOut - clip.sourceIn) / (clip.speed ?? 1)) * fps));
}

export function clipDurationSec(clip: { sourceIn: number; sourceOut: number; speed?: number }, fps: number): number {
  return clipFrames(clip, fps) / fps;
}
