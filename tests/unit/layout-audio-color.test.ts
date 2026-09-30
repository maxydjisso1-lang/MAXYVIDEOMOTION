import { describe, expect, it } from "vitest";
import type { Analysis } from "../../engine/core/src/index.js";
import { buildDialogueChain, compileChain } from "../../engine/audio/src/index.js";
import { compileStyleTokens } from "../../engine/brand/src/index.js";
import { autoCorrection } from "../../engine/color/src/index.js";
import { cropWindow } from "../../engine/editing/src/index.js";
import { cueLayout, fitFont, inside, safeRect, type Frame } from "../../engine/motion/src/index.js";
import { buildAss } from "../../engine/rendering/src/ass.js";
import { loadBrand } from "../helpers.js";

const reels: Frame = { width: 1080, height: 1920, safeZone: { top: 0.1, bottom: 0.2, left: 0.06, right: 0.14 } };

describe("layout (shared by Remotion, ASS and QC)", () => {
  const t = compileStyleTokens(loadBrand("volt-street"), 30);
  it("shrinks text to fit instead of overflowing", () => {
    const fit = fitFont("UNE PHRASE BEAUCOUP TROP LONGUE POUR UNE SEULE LIGNE", 600, 90, 1, true, 800);
    expect(fit.fontPx).toBeLessThan(90);
  });
  it("keeps caption blocks inside the platform safe zone", () => {
    const words = "REJOIGNEZ LA COMMUNAUTÉ DÈS AUJOURD'HUI".split(" ").map((text) => ({ text }));
    const l = cueLayout(reels, t, words);
    expect(inside(l.box, safeRect(reels))).toBe(true);
    expect(l.lines.length).toBeLessThanOrEqual(t.caption.maxLines);
  });
});

describe("reframing", () => {
  it("crops 16:9 to 9:16 around the center", () => {
    const w = cropWindow(1920, 1080, { width: 1080, height: 1920 });
    expect(w.h).toBe(1080);
    expect(w.w / w.h).toBeCloseTo(9 / 16, 2);
    expect(w.x).toBe(Math.round((1920 - w.w) / 2));
  });
});

describe("audio cleanup chain", () => {
  const noisy: Analysis["sources"][number]["audio"] = { noiseFloorDb: -48, noiseProfile: ["broadband"], humHz: 50 };
  it("adds processors only for measured problems", () => {
    const chain = buildDialogueChain(noisy, "standard").map((p) => p.type);
    expect(chain).toContain("denoise-fft");
    expect(chain).toContain("dehum");
    const clean = buildDialogueChain({ noiseFloorDb: -80 }, "standard").map((p) => p.type);
    expect(clean).not.toContain("denoise-fft");
    expect(clean).not.toContain("dehum");
  });
  it("compiles to FFmpeg filters and honours 'off'", () => {
    const f = compileChain(buildDialogueChain(noisy, "standard"));
    expect(f.some((x) => x.startsWith("afftdn="))).toBe(true);
    expect(f.filter((x) => x.startsWith("bandreject=f=50")).length).toBe(1);
    expect(buildDialogueChain(noisy, "off")).toEqual([]);
  });
});

describe("color correction", () => {
  it("brightens an underexposed shot, within the clamp", () => {
    const { correction } = autoCorrection({ id: "s1", start: 0, end: 1, luma: { mean: 0.1, p05: 0.01, p95: 0.3 }, rgbMean: [0.1, 0.1, 0.1] });
    expect(correction.exposure).toBeGreaterThan(0.5);
    expect(correction.exposure).toBeLessThanOrEqual(1.5);
  });
  it("leaves a well exposed, neutral shot alone", () => {
    const { correction, reason } = autoCorrection({ id: "s1", start: 0, end: 1, luma: { mean: 0.46, p05: 0.05, p95: 0.9 }, rgbMean: [0.5, 0.5, 0.5] });
    expect(correction.exposure).toBe(0);
    expect(correction.whiteBalance?.mode).toBe("as-shot");
    expect(reason).toMatch(/no correction/);
  });
});

describe("ASS fallback renderer", () => {
  it("uses brand tokens for fonts and colors", () => {
    const t = compileStyleTokens(loadBrand("volt-street"), 30);
    const ass = buildAss(t, reels, { schemaVersion: "1.0", instances: [{ id: "cta", component: "CTA", start: 1, durationSec: 2, anchor: "safe-bottom", props: { text: "Go" } }] }, {
      schemaVersion: "1.0", language: "fr", cues: [{ id: "cue_001", start: 0, end: 1, words: [{ text: "hello", start: 0, end: 0.5, emphasis: "key" }] }],
    });
    expect(ass).toContain("Montserrat");
    expect(ass).toContain("&H0014FF39"); // #39FF14 highlight in ASS BGR
    expect(ass).toContain("HELLO"); // brand case rule
    expect(ass).toContain("GO");
  });
});

describe("color filter compilation", () => {
  it("brightening beyond ×2 uses colorlevels (colorchannelmixer rejects gains > 2) and FFmpeg accepts it", async () => {
    const { clipColorFilters } = await import("../../engine/color/src/index.js");
    const { ffmpeg } = await import("../../engine/ffmpeg/src/index.js");
    const doc = { schemaVersion: "1.0", globalGrade: { look: "none" as const, intensity: 0 }, shots: [{ sourceId: "s", shotId: "a", correction: { exposure: 1.5, whiteBalance: { mode: "auto-gray-world" as const, gains: [1.1, 1, 0.95] as [number, number, number] } } }] };
    const analysis = { schemaVersion: "1.0", generatedAt: "2026-01-01T00:00:00Z", sources: [{ sourceId: "s", shots: [{ id: "a", start: 0, end: 10 }], audio: {} }] };
    const filters = clipColorFilters(doc, "s", 1, analysis);
    expect(filters[0]).toMatch(/^colorlevels=/);
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=160x90:d=0.2", "-vf", filters.join(","), "-f", "null", "-"]);
  });
});
