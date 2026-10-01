/**
 * OPT-IN (`npm run fixtures:real && npm run test:real`): the colour path on real frames (chantier 5).
 * Same kit as the benchmark (scripts/lib/color-cases.ts): degradations applied in linear light to real
 * frames (the frames are the ground truth), the engine's analysis → autoCorrection → filters, inside a
 * lossless replica of the base-plate and final-encode passes. Thresholds keep a margin around the
 * numbers measured in docs/measurements/color.md.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, silentLogger } from "../../engine/core/src/index.js";
import {
  autoCorrection, clipColorFilters, decodeRgb, frameMetrics, skinMask, sourceColorimetry, type RgbFrame,
} from "../../engine/color/src/index.js";
import { probe } from "../../engine/ffmpeg/src/index.js";
import { renderBasePlate } from "../../engine/rendering/src/basePlate.js";
import { analyseShot, CASES, clipFromRgb, dE, delivered, derive, enginePasses, finalPass, summary, useWorkDir } from "../../scripts/lib/color-cases.js";

const REAL = join(REPO_ROOT, "tests/fixtures/real");
const WORK = join(REPO_ROOT, "tests/.tmp/real-color");
const FRAMES = 3;
const ready = ["talking-head.mp4", "product.mp4", "interview.mp4", "color-night-interview.mp4"].every((f) => existsSync(join(REAL, f)));

type Shot = Awaited<ReturnType<typeof analyseShot>>;
const filtersFor = (shot: Shot, correction: ReturnType<typeof autoCorrection>["correction"]) =>
  clipColorFilters({ schemaVersion: "1.0", globalGrade: { look: "none", intensity: 0 }, shots: [{ sourceId: "s", shotId: "s001", correction }] } as never, "s", shot.end / 2, { schemaVersion: "1.0", generatedAt: "", sources: [{ sourceId: "s", shots: [shot], audio: {} }] } as never);

/** A degraded talking-head case through analysis, correction and the two passes (normalisation on, as in the base plate). */
async function runCase(caseId: keyof typeof CASES & string, ref: RgbFrame[]) {
  const clip = await clipFromRgb(`th-${caseId}`, derive(ref, CASES[caseId]!), "bt709");
  const shot = await analyseShot(clip);
  const { correction, reason } = autoCorrection(shot as never, true);
  const before = await delivered(await enginePasses(clip, [], `th-${caseId}-before`, { normalize: true }));
  const after = await delivered(await enginePasses(clip, filtersFor(shot, correction), `th-${caseId}-after`, { normalize: true }));
  return { correction, reason, before, after };
}
const clipHigh = (fs: RgbFrame[]) => summary(fs).clipHigh;

describe.skipIf(!ready)("colour correction on real frames (guard-rails)", () => {
  let ref: RgbFrame[];
  beforeAll(async () => {
    await useWorkDir(WORK, FRAMES);
    ref = await decodeRgb(join(REAL, "talking-head.mp4"), { matrix: "bt601", count: FRAMES, everySec: 4, start: 1 });
  }, 120_000);

  it("a correctly exposed shot gets no correction at all", async () => {
    const r = await runCase("ok", ref);
    expect(r.correction.exposure).toBe(0);
    expect(r.correction.contrast).toBe(0);
    expect(r.correction.whiteBalance?.mode).toBe("as-shot");
    expect(dE(r.after, ref)).toBeLessThanOrEqual(dE(r.before, ref) + 0.05);
  }, 300_000);

  it.each([
    ["under-1.5", 0.4], // measured 15.25 → 3.48 (0.23)
    ["under-2.5", 0.4], // measured 22.63 → 4.65 (0.21)
  ] as const)("%s EV is recovered without clipping", async (caseId, maxRatio) => {
    const r = await runCase(caseId, ref);
    expect(r.correction.exposure).toBeGreaterThan(0);
    expect(dE(r.after, ref)).toBeLessThan(dE(r.before, ref) * maxRatio);
    expect(clipHigh(r.after)).toBeLessThanOrEqual(clipHigh(ref) + 0.005);
  }, 300_000);

  it("an overexposed shot is not brightened further", async () => {
    const r = await runCase("over+1", ref);
    expect(r.correction.exposure).toBeLessThanOrEqual(0);
    expect(clipHigh(r.after)).toBeLessThanOrEqual(clipHigh(r.before) + 0.005);
  }, 300_000);

  it.each(["cast-warm", "cast-cool", "cast-green", "mixed"] as const)("%s is reported, not neutralised automatically", async (caseId) => {
    const r = await runCase(caseId, ref);
    expect(r.correction.whiteBalance?.mode).toBe("as-shot");
    expect(Math.abs(dE(r.after, ref) - dE(r.before, ref))).toBeLessThanOrEqual(0.05);
    if (caseId !== "mixed") expect(r.reason).toMatch(/not applied/);
  }, 300_000);
});

describe.skipIf(!ready)("real footage as shot", () => {
  beforeAll(() => useWorkDir(WORK, FRAMES));

  it("night interview: controlled brightening, no clipping", async () => {
    const ref = await decodeRgb(join(REAL, "color-night-interview.mp4"), { matrix: "bt709", count: FRAMES, everySec: 3, start: 1 });
    const clip = await clipFromRgb("night", ref, "bt709");
    const shot = await analyseShot(clip);
    const { correction } = autoCorrection(shot as never, true);
    expect(correction.exposure).toBeGreaterThan(1); // measured 1.46 EV
    const before = await delivered(await enginePasses(clip, [], "night-before", { normalize: true }));
    const after = await delivered(await enginePasses(clip, filtersFor(shot, correction), "night-after", { normalize: true }));
    expect(summary(after).luma).toBeGreaterThan(summary(before).luma * 2); // measured 0.10 → 0.28
    expect(clipHigh(after)).toBeLessThan(0.01);
  }, 300_000);
});

describe.skipIf(!ready)("source colorimetry (normalised to BT.709 in the base plate)", () => {
  beforeAll(() => useWorkDir(WORK, FRAMES));

  it("untagged HD: read as BT.709 by the real base plate (was ≈ 2 ΔE off when read as BT.601)", async () => {
    const ref = await decodeRgb(join(REAL, "product.mp4"), { matrix: "bt709", count: FRAMES, everySec: 4, start: 1 });
    const clip = await clipFromRgb("product-untagged", ref, "untagged709");
    const p = await probe(clip);
    expect(sourceColorimetry(p)).toMatchObject({ matrix: "bt709", assumed: true });
    // the engine's own base plate (renderBasePlate), on a minimal project stub, then the final colour step
    const base = join(WORK, "product-untagged.engine-base.mp4");
    const project = { source: () => ({ probe: p }), sourceMediaPath: () => clip, abs: (x: string) => x, log: silentLogger, root: WORK };
    const timeline = { tracks: { video: [{ kind: "primary", clips: [{ id: "c1", sourceId: "s", sourceIn: 0, sourceOut: FRAMES }] }] } };
    await renderBasePlate(project as never, { timeline: timeline as never, tokens: { grade: {} } as never, preset: { width: p.width, height: p.height, fps: 25 } as never, targetId: "t", draft: false }, base);
    const out = join(WORK, "product-untagged.engine-final.mp4");
    await finalPass(base, out);
    const rendered = await decodeRgb(out, { matrix: "bt709", count: FRAMES, everySec: 1, start: 0.5 });
    expect(dE(rendered, ref)).toBeLessThan(1); // measured 0.15 with normalisation, 0.57–2.16 without
    const plain = await delivered(await enginePasses(clip, [], "product-untagged-plain"));
    expect(dE(rendered, ref)).toBeLessThan(dE(plain, ref));
  }, 300_000);

  it("untagged SD: the BT.601 convention", async () => {
    const ref = await decodeRgb(join(REAL, "interview.mp4"), { matrix: "bt601", count: FRAMES, everySec: 4, start: 1 });
    const clip = await clipFromRgb("interview-untagged601", ref, "untagged601");
    const p = await probe(clip);
    expect(sourceColorimetry(p)).toMatchObject({ matrix: "bt601", assumed: true });
    const out = await delivered(await enginePasses(clip, [], "interview-untagged601", { normalize: true }));
    expect(dE(out, ref)).toBeLessThan(1);
  }, 300_000);
});

describe.skipIf(!ready)("brand looks kept as they are (measured side effects)", () => {
  let ref: RgbFrame[];
  let masks: Uint8Array[];
  let clip: string;
  beforeAll(async () => {
    await useWorkDir(WORK, FRAMES);
    ref = await decodeRgb(join(REAL, "talking-head.mp4"), { matrix: "bt601", count: FRAMES, everySec: 4, start: 1 });
    masks = ref.map((f) => skinMask(f));
    clip = await clipFromRgb("th-ok", derive(ref, CASES.ok!), "bt709");
  }, 120_000);
  const look = (name: string) => clipColorFilters({ schemaVersion: "1.0", globalGrade: { look: name, intensity: 0.6 }, shots: [] } as never, "s", 0, undefined);
  const skinHue = (fs: RgbFrame[]) => {
    const h = fs.map((f, i) => frameMetrics(f, masks[i]).skin!.hue);
    return h.reduce((a, b) => a + b, 0) / h.length;
  };

  it("muted turns skin hue (measured +9.2°)", async () => {
    const base = await delivered(await enginePasses(clip, [], "look-none", { normalize: true }));
    const muted = await delivered(await enginePasses(clip, look("muted"), "look-muted", { normalize: true }));
    const shift = skinHue(muted) - skinHue(base);
    expect(shift).toBeGreaterThan(5);
    expect(shift).toBeLessThan(13);
  }, 300_000);

  it("vibrant crushes shadows (measured 1 % → 11 % of pixels with a channel at 0)", async () => {
    const base = await delivered(await enginePasses(clip, [], "look-none", { normalize: true }));
    const vib = await delivered(await enginePasses(clip, look("vibrant"), "look-vibrant", { normalize: true }));
    expect(summary(vib).clipLow).toBeGreaterThan(summary(base).clipLow * 3);
  }, 300_000);
});
