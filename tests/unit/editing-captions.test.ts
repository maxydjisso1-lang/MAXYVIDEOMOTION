import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Analysis, CreativePlan, Timeline } from "../../engine/core/src/index.js";
import { compileStyleTokens } from "../../engine/brand/src/index.js";
import { buildCaptions, remapWords, segment } from "../../engine/captions/src/index.js";
import { compilePlan, deleteClip, tightenRange } from "../../engine/editing/src/index.js";
import { motionFromPlan } from "../../engine/motion/src/index.js";
import { fixtureTranscript, FIXTURE_SENTENCES } from "../fixtures/generate.js";
import { FIXTURES, loadBrand } from "../helpers.js";

const transcript = fixtureTranscript("src_talk");
// Silences exactly as the synthetic audio produces them.
const silences = [{ start: 0, end: 0.6 }, ...FIXTURE_SENTENCES.slice(0, -1).map((s, i) => ({ start: s.start + 2.5, end: FIXTURE_SENTENCES[i + 1]!.start + 0.1 })), { start: 13.5, end: 14 }];
const analysis: Analysis = {
  schemaVersion: "1.0",
  generatedAt: new Date(0).toISOString(),
  sources: [{ sourceId: "src_talk", shots: [{ id: "s001", start: 0, end: 7 }, { id: "s002", start: 7, end: 14 }], audio: { silences } }],
};
const ctx = { analysis, transcript, sourceDurations: { src_talk: 14 } };
const plan = JSON.parse(readFileSync(join(FIXTURES, "plan.fixture.json"), "utf8")) as CreativePlan;
const words = transcript.sources[0]!.segments.flatMap((s) => s.words);

describe("plan -> timeline compiler", () => {
  const tl = compilePlan(plan, ctx, 30);
  const clips = tl.tracks.video[0]!.clips;

  it("puts the hook first (reordering) and follows the section order", () => {
    expect(clips.map((c) => c.sectionId)).toEqual(["hook", "context", "proof", "cta"]);
    expect(clips[0]!.sourceIn).toBeGreaterThan(3.9); // "comment créer…" starts at 4.1
  });

  it("never cuts through a word", () => {
    for (const c of clips) {
      for (const w of words) {
        const cutsIn = c.sourceIn > w.start + 1e-6 && c.sourceIn < w.end - 1e-6;
        const cutsOut = c.sourceOut > w.start + 1e-6 && c.sourceOut < w.end - 1e-6;
        expect(cutsIn || cutsOut, `${c.id} cuts "${w.w}"`).toBe(false);
      }
    }
  });

  it("removes the filler word when asked", () => {
    const euh = words.find((w) => w.filler)!;
    expect(clips.some((c) => c.sourceIn < euh.end && euh.start < c.sourceOut)).toBe(false);
  });

  it("keeps clips frame-aligned and contiguous", () => {
    let t = 0;
    for (const c of clips) {
      expect(c.timelineStart).toBeCloseTo(t, 3);
      expect(Math.abs((c.sourceOut - c.sourceIn) * 30 - Math.round((c.sourceOut - c.sourceIn) * 30))).toBeLessThan(0.05);
      t += Math.round((c.sourceOut - c.sourceIn) * 30) / 30;
    }
    expect(tl.durationSec).toBeCloseTo(t, 2);
  });

  it("is independent of the brand (the edit is identical for every Brand DNA)", () => {
    expect(compilePlan(plan, ctx, 30)).toEqual(tl);
  });

  it("ripples after a delete", () => {
    const edited = deleteClip(structuredClone(tl) as Timeline, "c002");
    expect(edited.tracks.video[0]!.clips.length).toBe(3);
    expect(edited.durationSec).toBeLessThan(tl.durationSec!);
  });

  it("keeps silences shorter than the threshold", () => {
    const r = tightenRange({ sourceId: "src_talk", start: 0.5, end: 3.0 }, ctx, { minSilenceSec: 5, padSec: 0.12, removeFillers: false, sourceDurationSec: 14 });
    expect(r.length).toBe(1);
  });
});

describe("captions", () => {
  const tl = compilePlan(plan, ctx, 30);
  const lune = compileStyleTokens(loadBrand("maison-lune"), 30);
  const volt = compileStyleTokens(loadBrand("volt-street"), 30);

  it("remaps words through the edit and drops the words that were cut", () => {
    const w = remapWords(transcript, tl);
    expect(w.map((x) => x.text)).not.toContain("euh");
    expect(w[0]!.text).toBe("comment");
    expect(w[0]!.start).toBeLessThan(0.2);
  });

  it("never lets a cue span a cut that jumps in the source", () => {
    const caps = buildCaptions(transcript, tl, lune, plan);
    const joined = caps.cues.map((c) => c.words.map((w) => w.text).join(" "));
    expect(joined.some((t) => t.includes("montrer vraiment"))).toBe(false);
  });

  it("does not end a line on an article ('une | marque')", () => {
    const toks = [..."comment créer une marque forte et durable pour vous".split(" ")].map((text, i) => ({ text, start: i * 0.3, end: i * 0.3 + 0.25 }));
    const cues = segment(toks, { maxWordsPerLine: 3, maxLines: 1, maxCueSec: 10 });
    for (const c of cues) expect(["une", "la", "le", "pour", "et"]).not.toContain(c.at(-1)!.text);
  });

  it("segments differently for different brands (the brand drives caption rhythm)", () => {
    const a = buildCaptions(transcript, tl, lune, plan);
    const b = buildCaptions(transcript, tl, volt, plan);
    expect(b.cues.length).toBeGreaterThan(a.cues.length);
    expect(Math.max(...b.cues.map((c) => c.words.length))).toBeLessThanOrEqual(6);
  });

  it("emphasises numbers and keywords, at most one key word per cue", () => {
    const caps = buildCaptions(transcript, tl, lune, plan);
    const keyWords = caps.cues.flatMap((c) => c.words.filter((w) => w.emphasis === "key").map((w) => w.text));
    expect(keyWords.some((w) => w.includes("2026"))).toBe(true);
    for (const c of caps.cues) expect(c.words.filter((w) => w.emphasis === "key").length).toBeLessThanOrEqual(1);
  });

  it("respects minimum duration without overlaps", () => {
    const caps = buildCaptions(transcript, tl, volt, plan);
    caps.cues.forEach((c, i) => {
      const next = caps.cues[i + 1];
      if (next) expect(c.end).toBeLessThanOrEqual(next.start + 1e-9);
    });
  });
});

describe("motion from plan", () => {
  const tl = compilePlan(plan, ctx, 30);
  it("derives timing and variants from tokens (different brands -> different motion docs)", () => {
    const a = motionFromPlan(plan, tl, compileStyleTokens(loadBrand("maison-lune"), 30));
    const b = motionFromPlan(plan, tl, compileStyleTokens(loadBrand("volt-street"), 30));
    expect(a).not.toEqual(b);
    const outroA = a.instances.find((i) => i.component === "BrandOutro")!;
    const outroB = b.instances.find((i) => i.component === "BrandOutro")!;
    expect(outroA.durationSec).toBeGreaterThan(outroB.durationSec); // calm brand lingers
    expect(a.instances.some((i) => i.component === "Watermark")).toBe(true); // Maison Lune defines a watermark rule
    expect(b.instances.some((i) => i.component === "Watermark")).toBe(false);
    expect(new Set(a.instances.map((i) => i.variant))).toEqual(new Set(["line-fade"]));
    expect(new Set(b.instances.map((i) => i.variant))).toEqual(new Set(["pill-zoom"]));
  });
  it("keeps every instance inside the video", () => {
    const m = motionFromPlan(plan, tl, compileStyleTokens(loadBrand("volt-street"), 30));
    for (const i of m.instances) expect(i.start + i.durationSec).toBeLessThanOrEqual(tl.durationSec! + 1e-6);
  });
});
