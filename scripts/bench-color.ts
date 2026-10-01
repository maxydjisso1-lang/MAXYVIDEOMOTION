/**
 * Colour pipeline benchmark (chantier 5). Measures, does not decide.
 *
 * Ground truth: real frames from the fixtures (talking head, interview, product), decoded to RGB with
 * a stated matrix. Degraded cases are derived from them in LINEAR light (under/over exposure, colour
 * cast, low contrast, mixed light), encoded as clean BT.709 clips, then run through the engine's
 * real colour path: analysis (frameStats + shotStats) → autoCorrection → clipColorFilters, inside a
 * faithful replica of the two FFmpeg passes that touch colour (base plate, final encode), lossless.
 *
 * Usage: tsx scripts/bench-color.ts [--part matrix|cases|looks|real|all] [--label <name>]
 * Results → docs/measurements/color.{json,md}
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../engine/core/src/index.js";
import { ffmpeg, frameStats, lumaHistograms, probe } from "../engine/ffmpeg/src/index.js";
import { shotStats } from "../engine/vision/src/analyze.js";
import {
  autoCorrection, clipColorFilters, normalizeColorimetryFilter, decodeRgb, frameMetrics, meanDeltaE, skinMask, toGamma, toLinear, type FrameMetrics, type Matrix, type RgbFrame,
} from "../engine/color/src/index.js";

const argv = process.argv.slice(2);
const part = argv.includes("--part") ? argv[argv.indexOf("--part") + 1]! : "all";
const REAL = join(REPO_ROOT, "tests/fixtures/real");
const WORK = join(REPO_ROOT, "tests/.tmp/bench-color");
await mkdir(WORK, { recursive: true });
const FRAMES = 6;
const EVERY = 4; // s
const results: Record<string, unknown> = {};

// ------------------------------------------------------------- sources (real frames = ground truth)

const SOURCES = [
  { id: "talking-head", file: "talking-head.mp4", matrix: "bt601" as Matrix, skin: true, note: "tagged bt470bg (BT.601)" },
  { id: "interview", file: "interview.mp4", matrix: "bt601" as Matrix, skin: true, note: "untagged SD: BT.601 assumed" },
  { id: "product", file: "product.mp4", matrix: "bt709" as Matrix, skin: false, note: "untagged HD: BT.709 assumed" },
];

import { analyseShot, avg, CASES, clipFromRgb, dE, delivered, derive, enginePasses, summary, timings, useWorkDir } from "./lib/color-cases.js";
await useWorkDir(WORK, FRAMES);

const refs = new Map<string, RgbFrame[]>();
for (const s of SOURCES) refs.set(s.id, await decodeRgb(join(REAL, s.file), { matrix: s.matrix, count: FRAMES, everySec: EVERY, start: 1 }));


// ------------------------------------------------------------- part 1: matrix / range handling, no correction

if (part === "matrix" || part === "all") {
  const rows: Record<string, unknown>[] = [];
  for (const s of SOURCES) {
    const ref = refs.get(s.id)!;
    for (const enc of ["bt709", "untagged709", "bt601", "bt709full"] as const) {
      const clip = await clipFromRgb(s.id, ref, enc);
      // sanity: the clip decoded with its own matrix equals the reference
      const self = enc === "bt709full" ? ref : await decodeRgb(clip, { matrix: enc === "bt601" ? "bt601" : "bt709", count: FRAMES, everySec: 1, start: 0.5 });
      const plain = await delivered(await enginePasses(clip, [], `${s.id}-${enc}-plain`));
      // a neutral RGB filter forces the YUV→RGB→YUV round trip the correction filters cause
      const neutral = await delivered(await enginePasses(clip, ["colorchannelmixer=rr=1:gg=1:bb=1"], `${s.id}-${enc}-neutral`));
      const fixed = await delivered(await enginePasses(clip, ["colorchannelmixer=rr=1:gg=1:bb=1"], `${s.id}-${enc}-normalized`, { normalize: true }));
      const row = { source: s.id, encoding: enc, clipVsRef: dE(self, ref), renderVsRef: dE(plain, ref), renderWithRgbFilterVsRef: dE(neutral, ref), renderNormalizedVsRef: dE(fixed, ref) };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  results.matrix = rows;
}

// ------------------------------------------------------------- part 2: correction on degraded real frames

export const caseOutputs = new Map<string, { ref: RgbFrame[]; corrected: RgbFrame[]; masks?: Uint8Array[]; correction: unknown; clip: string }>();

if (part === "cases" || part === "all") {
  const rows: Record<string, unknown>[] = [];
  for (const s of SOURCES) {
    const ref = refs.get(s.id)!;
    const masks = s.skin ? ref.map((f) => skinMask(f)) : undefined;
    const refSum = summary(ref, masks);
    for (const [cid, c] of Object.entries(CASES)) {
      const tag = `${s.id}-${cid}`;
      const clip = await clipFromRgb(tag, derive(ref, c), "bt709");
      const shot = await analyseShot(clip);
      const { correction, reason } = autoCorrection(shot as never, true);
      const doc = { schemaVersion: "1.0", globalGrade: { look: "none" as const, intensity: 0 }, shots: [{ sourceId: "s", shotId: "s001", correction }] };
      const analysis = { schemaVersion: "1.0", generatedAt: "", sources: [{ sourceId: "s", shots: [shot], audio: {} }] };
      const filters = clipColorFilters(doc as never, "s", shot.end / 2, analysis as never);
      const before = await delivered(await enginePasses(clip, [], `${tag}-before`));
      const after = await delivered(await enginePasses(clip, filters, `${tag}-after`));
      caseOutputs.set(tag, { ref, corrected: after, masks, correction, clip });
      const row = {
        source: s.id, case: cid, what: c.what, analysis: { lumaMean: shot.luma.mean, p05: shot.luma.p05, p95: shot.luma.p95, rgbMean: shot.rgbMean }, correction, reason, filters,
        deltaE: { before: dE(before, ref), after: dE(after, ref), ...(masks ? { skinBefore: dE(before, ref, masks), skinAfter: dE(after, ref, masks) } : {}) },
        ref: refSum, before: summary(before, masks), after: summary(after, masks),
        ms: { basePassPlain: timings[`${tag}-before`], basePassCorrected: timings[`${tag}-after`] },
      };
      rows.push(row);
      console.log(`${tag.padEnd(26)} ΔE ${row.deltaE.before} → ${row.deltaE.after}${masks ? `  skin ${row.deltaE.skinBefore} → ${row.deltaE.skinAfter}` : ""}  luma ${refSum.luma}/${row.before.luma}→${row.after.luma}  clipHi ${row.after.clipHigh}  holes ${row.after.holes}  | ${reason}`);
    }
  }
  results.cases = rows;
}

// ------------------------------------------------------------- part 3: brand looks (on correct and on dark corrected shots)

const LOOKS = ["filmic", "warm", "cool", "vibrant", "high-contrast", "muted"] as const;
if (part === "looks" || part === "all") {
  const rows: Record<string, unknown>[] = [];
  const hueShift = (a?: { hue: number }, b?: { hue: number }) => (a && b ? Math.round((((b.hue - a.hue + 540) % 360) - 180) * 10) / 10 : undefined);
  for (const s of SOURCES) {
    const ref = refs.get(s.id)!;
    const masks = s.skin ? ref.map((f) => skinMask(f)) : undefined;
    for (const cid of ["ok", "under-2.5"]) {
      const tag = `${s.id}-${cid}`;
      const clip = await clipFromRgb(tag, derive(ref, CASES[cid]!), "bt709");
      const shot = await analyseShot(clip);
      const { correction } = autoCorrection(shot as never, true);
      const corr = cid === "ok" ? [] : clipColorFilters({ schemaVersion: "1.0", globalGrade: { look: "none", intensity: 0 }, shots: [{ sourceId: "s", shotId: "s001", correction }] } as never, "s", shot.end / 2, { schemaVersion: "1.0", generatedAt: "", sources: [{ sourceId: "s", shots: [shot], audio: {} }] } as never);
      const base = await delivered(await enginePasses(clip, corr, `${tag}-nolook`));
      const b0 = summary(base, masks);
      for (const look of LOOKS) {
        const grade = { schemaVersion: "1.0", globalGrade: { look, intensity: 0.6 }, shots: [] };
        const lookF = clipColorFilters(grade as never, "s", 0, undefined);
        const out = await delivered(await enginePasses(clip, [...corr, ...lookF], `${tag}-${look}`));
        const a = summary(out, masks);
        const row = {
          source: s.id, case: cid, look, filters: lookF, deltaEvsNoLook: dE(out, base),
          luma: [b0.luma, a.luma], shadowAB: [[b0.shadowA, b0.shadowB], [a.shadowA, a.shadowB]], meanAB: [[b0.a, b0.b], [a.a, a.b]],
          clipHigh: [b0.clipHigh, a.clipHigh], clipLow: [b0.clipLow, a.clipLow], holes: [b0.holes, a.holes],
          skinHueShift: hueShift(b0.skin, a.skin), skinChroma: b0.skin && a.skin ? [b0.skin.chroma, a.skin.chroma] : undefined,
          msBasePass: [timings[`${tag}-nolook`], timings[`${tag}-${look}`]],
        };
        rows.push(row);
        console.log(`${tag.padEnd(22)} ${look.padEnd(13)} ΔE ${row.deltaEvsNoLook}  blacks a/b ${b0.shadowA}/${b0.shadowB} → ${a.shadowA}/${a.shadowB}  mean a/b ${b0.a}/${b0.b} → ${a.a}/${a.b}  skin hue ${row.skinHueShift ?? "-"}°  clipHi ${a.clipHigh} lo ${a.clipLow}  ms ${row.msBasePass.join("→")}`);
      }
    }
  }
  results.looks = rows;
}

// ------------------------------------------------------------- part 4: real footage, as shot (no ground truth: measure the harm)

const REAL_SET = [
  { id: "talking-head", file: "talking-head.mp4", matrix: "bt601" as Matrix, skin: true, expect: "well exposed, warm interior" },
  { id: "interview", file: "interview.mp4", matrix: "bt601" as Matrix, skin: true, expect: "low-key interview (dark background)" },
  { id: "product", file: "product.mp4", matrix: "bt709" as Matrix, skin: false, expect: "object on black: low key on purpose" },
  { id: "night-interview", file: "color-night-interview.mp4", matrix: "bt709" as Matrix, skin: true, expect: "night interview, low light" },
  { id: "candle-vigil", file: "color-candle-vigil.mp4", matrix: "bt709" as Matrix, skin: true, expect: "candle light: dark and warm on purpose" },
  { id: "sunset", file: "color-sunset.mp4", matrix: "bt709" as Matrix, skin: false, expect: "warm dominant on purpose" },
  { id: "forest", file: "color-forest.mp4", matrix: "bt709" as Matrix, skin: false, expect: "green dominant on purpose" },
  { id: "indoor-interview", file: "color-indoor-interview.mp4", matrix: "bt709" as Matrix, skin: true, expect: "indoor interview" },
  { id: "cooking-vlog", file: "color-cooking-vlog.mp4", matrix: "bt709" as Matrix, skin: true, expect: "outdoor vlog, daylight" },
];
if (part === "real" || part === "all") {
  const rows: Record<string, unknown>[] = [];
  const version = argv.includes("--label") ? argv[argv.indexOf("--label") + 1]! : "current";
  for (const r of REAL_SET) {
    const ref = await decodeRgb(join(REAL, r.file), { matrix: r.matrix, count: FRAMES, everySec: 2, start: 1 });
    const masks = r.skin ? ref.map((f) => skinMask(f)) : undefined;
    const clip = await clipFromRgb(`real-${r.id}`, ref, "bt709");
    const shot = await analyseShot(clip);
    const { correction, reason } = autoCorrection(shot as never, true);
    const filters = clipColorFilters({ schemaVersion: "1.0", globalGrade: { look: "none", intensity: 0 }, shots: [{ sourceId: "s", shotId: "s001", correction }] } as never, "s", shot.end / 2, { schemaVersion: "1.0", generatedAt: "", sources: [{ sourceId: "s", shots: [shot], audio: {} }] } as never);
    const before = await delivered(await enginePasses(clip, [], `real-${r.id}-${version}-before`));
    const after = await delivered(await enginePasses(clip, filters, `real-${r.id}-${version}-after`));
    const b = summary(before, masks);
    const a = summary(after, masks);
    const hue = b.skin && a.skin ? Math.round((((a.skin.hue - b.skin.hue + 540) % 360) - 180) * 10) / 10 : undefined;
    const row = { source: r.id, expect: r.expect, correction, reason, change: dE(after, before), skinChange: masks ? dE(after, before, masks) : undefined, luma: [b.luma, a.luma], meanAB: [[b.a, b.b], [a.a, a.b]], clipHigh: [b.clipHigh, a.clipHigh], skinHueShift: hue };
    rows.push(row);
    console.log(`${r.id.padEnd(17)} change ΔE ${row.change}${masks ? ` skin ${row.skinChange} (hue ${hue}°)` : ""}  luma ${b.luma}→${a.luma}  a/b ${b.a}/${b.b}→${a.a}/${a.b}  clipHi ${b.clipHigh}→${a.clipHigh}  | ${reason}`);
  }
  results.real = rows;
}

await writeFile(join(WORK, `results-${part}.json`), JSON.stringify(results, null, 1));
