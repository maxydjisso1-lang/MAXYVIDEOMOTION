import { describe, expect, it } from "vitest";
import { bestTextOn, compileStyleTokens, contrastRatio, deltaE } from "../../engine/brand/src/index.js";
import { validate } from "../../engine/core/src/index.js";
import { loadBrand } from "../helpers.js";

describe("Brand DNA -> style tokens", () => {
  const lune = loadBrand("maison-lune");
  const volt = loadBrand("volt-street");

  it("produces schema-valid tokens", () => {
    for (const b of [lune, volt]) validate("style-tokens", compileStyleTokens(b, 30));
  });

  it("is deterministic (same brand + fps -> identical tokens)", () => {
    expect(compileStyleTokens(lune, 30)).toEqual(compileStyleTokens(structuredClone(lune), 30));
  });

  it("translates a calm, minimal brand into slow, restrained motion", () => {
    const t = compileStyleTokens(lune, 30);
    expect(t.motion.enterFrames).toBe(24); // slow = 0.8 s
    expect(t.motion.easing.kind).toBe("bezier");
    expect(t.motion.overshoot).toBe(0);
    expect(t.motion.staggerFrames).toBe(0);
    expect(t.motion.scaleFrom).toBe(1);
    expect(t.shape.style).toBe("line");
  });

  it("translates an energetic brand into fast, springy, bold motion", () => {
    const t = compileStyleTokens(volt, 30);
    expect(t.motion.enterFrames).toBeLessThan(10);
    expect(t.motion.easing.kind).toBe("spring");
    expect(t.motion.overshoot).toBeGreaterThan(0);
    expect(t.motion.staggerFrames).toBeGreaterThan(0);
    expect(t.motion.distancePx).toBeGreaterThan(compileStyleTokens(lune, 30).motion.distancePx);
    expect(t.shape.style).toBe("pill");
    expect(t.caption.case).toBe("upper");
  });

  it("scales frame counts with the delivery fps", () => {
    expect(compileStyleTokens(lune, 60).motion.enterFrames).toBe(48);
  });

  it("hashes the brand so stale tokens are detectable", () => {
    const changed = structuredClone(lune);
    changed.motion.speed = "fast";
    expect(compileStyleTokens(changed, 30).brandHash).not.toBe(compileStyleTokens(lune, 30).brandHash);
  });
});

describe("color math", () => {
  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
    expect(bestTextOn("#39FF14")).toBe("#111111");
    expect(bestTextOn("#111111")).toBe("#FFFFFF");
  });
  it("computes ΔE", () => {
    expect(deltaE("#F4EFE6", "#F4EFE6")).toBe(0);
    expect(deltaE("#F4EFE6", "#0A0A0A")).toBeGreaterThan(50);
  });
});
