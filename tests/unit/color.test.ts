import { describe, expect, it } from "vitest";
import {
  autoCorrection, brightenCurve, CORRECTION_POLICY, decodeRgb, deltaE2000, lab, normalizeColorimetryFilter, sourceColorimetry,
} from "../../engine/color/src/index.js";
import { ffmpeg } from "../../engine/ffmpeg/src/index.js";
import { TMP } from "../helpers.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// Analysis luma statistics are TV-range code values / 255; "p05"/"p95" are signalstats' 10th/90th percentiles.
const tv = (full: number) => (full * 219 + 16) / 255;
const shot = (mean: number, p10: number, p90: number, rgb: [number, number, number] = [0.45, 0.45, 0.45]) =>
  ({ id: "s1", start: 0, end: 1, luma: { mean: tv(mean), p05: tv(p10), p95: tv(p90) }, rgbMean: rgb });

describe("colour correction guard-rails (chantier 5)", () => {
  it("leaves a well-exposed shot alone (no contrast, no white balance)", () => {
    const { correction, reason } = autoCorrection(shot(0.42, 0.12, 0.8));
    expect(correction.exposure).toBe(0);
    expect(correction.contrast).toBe(0);
    expect(reason).toMatch(/no correction/);
  });
  it("does not brighten a dark shot that has highlights (low key on purpose)", () => {
    const { correction, reason } = autoCorrection(shot(0.15, 0.02, 0.6));
    expect(correction.exposure).toBe(0);
    expect(reason).toMatch(/low-key/);
  });
  it("brightens an underexposed shot without lifting its 90th percentile above the target", () => {
    const { correction } = autoCorrection(shot(0.08, 0.02, 0.25));
    expect(correction.exposure).toBeGreaterThan(0.5);
    expect(0.25 * 2 ** correction.exposure!).toBeLessThanOrEqual(CORRECTION_POLICY.targetP90 + 1e-3);
  });
  it("darkens a washed-out shot only", () => {
    expect(autoCorrection(shot(0.75, 0.4, 0.95)).correction.exposure).toBeLessThan(0);
    expect(autoCorrection(shot(0.7, 0.1, 0.98)).correction.exposure).toBe(0); // bright but with real blacks
  });
  it("adds contrast to a flat shot, judged after the exposure gain", () => {
    expect(autoCorrection(shot(0.45, 0.3, 0.6)).correction.contrast).toBeGreaterThan(0);
    // dark and flat: the gain itself restores the spread, no double correction
    const dark = autoCorrection(shot(0.08, 0.03, 0.2)).correction;
    expect(dark.exposure).toBeGreaterThan(0);
    expect(dark.contrast).toBeLessThan(0.15);
  });
  it("reports a colour cast but does not apply gray-world by default; the gray-world policy still can", () => {
    const warm = shot(0.42, 0.12, 0.8, [0.6, 0.45, 0.3]);
    const off = autoCorrection(warm);
    expect(off.correction.whiteBalance?.mode).toBe("as-shot");
    expect(off.reason).toMatch(/not applied/);
    const on = autoCorrection(warm, true, { ...CORRECTION_POLICY, whiteBalance: "gray-world" });
    expect(on.correction.whiteBalance?.mode).toBe("auto-gray-world");
  });
});

describe("brightening curve", () => {
  it("never clips: light grey stays below white, black stays black (real FFmpeg)", async () => {
    const dir = join(TMP, "color-curve");
    await mkdir(dir, { recursive: true });
    const src = join(dir, "grey.mp4");
    // left half 0.10 grey, right half 0.88 grey
    await ffmpeg(["-f", "lavfi", "-i", "color=c=0x1A1A1A:s=64x32:d=0.2,format=yuv444p[a];color=c=0xE0E0E0:s=64x32:d=0.2,format=yuv444p[b];[a][b]hstack", "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p", "-colorspace", "bt709", src]);
    const [f] = await decodeRgb(src, { matrix: "bt709", everySec: 0.04, filters: [brightenCurve(2.8)] });
    const px = (x: number) => f!.data[3 * (16 * f!.width + x)]!;
    expect(px(10)).toBeGreaterThan(0.1 * 255 * 2.2); // shadows get (close to) the full gain
    expect(px(100)).toBeLessThan(255); // a light grey is never pushed to clipped white
    expect(px(100)).toBeGreaterThan(0.88 * 255); // …but is not darkened either
  });
});

describe("source colorimetry", () => {
  it("uses the tag when there is one, the broadcast convention otherwise", () => {
    expect(sourceColorimetry({ colorSpace: "bt470bg", height: 1080 })).toMatchObject({ matrix: "bt601", assumed: false });
    expect(sourceColorimetry({ height: 1080 })).toMatchObject({ matrix: "bt709", assumed: true });
    expect(sourceColorimetry({ height: 480 })).toMatchObject({ matrix: "bt601", assumed: true });
    expect(sourceColorimetry({ pixFmt: "yuvj420p", height: 1080 }).range).toBe("pc");
    expect(normalizeColorimetryFilter({ height: 1080, colorRange: "tv" })).toBe("scale=in_color_matrix=bt709:in_range=tv:out_color_matrix=bt709:out_range=tv");
  });
});

describe("colour metrics", () => {
  it("CIEDE2000 matches the published reference pairs (Sharma et al.)", () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE2000([50, -1.3802, -84.2814], [50, 0, -82.7485])).toBeCloseTo(1.0, 3);
    expect(deltaE2000([50, 2.5, 0], [56, -27, -3])).toBeCloseTo(31.903, 2);
  });
  it("white is L*100 and neutral", () => {
    const [L, a, b] = lab(255, 255, 255);
    expect(L).toBeCloseTo(100, 1);
    expect(Math.abs(a) + Math.abs(b)).toBeLessThan(0.5);
  });
});
