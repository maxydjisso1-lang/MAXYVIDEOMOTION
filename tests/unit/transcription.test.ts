import { describe, expect, it } from "vitest";
import type { Transcript } from "../../engine/core/src/index.js";
import { joinSubwordTokens, normalizeForWer, toSentences, transcriptionReport, wordErrorRate } from "../../engine/transcription/src/index.js";

describe("word error rate", () => {
  it("is 0 for identical text regardless of case and punctuation", () => {
    expect(wordErrorRate("La Cigale, ayant chanté.", "la cigale ayant chanté").wer).toBe(0);
  });
  it("still counts spelling and accents (no masking)", () => {
    const r = wordErrorRate("la cigale dépourvue", "la sigale dépourvu");
    expect(r.substitutions).toBe(2);
    expect(r.wer).toBeCloseTo(2 / 3, 5);
  });
  it("counts deletions and insertions", () => {
    const r = wordErrorRate("a b c d", "a c d e f");
    expect([r.substitutions, r.deletions, r.insertions]).toEqual([0, 1, 2]);
  });
  it("splits elisions and hyphens the same way on both sides", () => {
    expect(normalizeForWer("Qu'est-ce qu’il dit-elle")).toEqual(["qu", "est", "ce", "qu", "il", "dit", "elle"]);
  });
});

describe("sub-word tokens", () => {
  it("merges apostrophe, punctuation and French inversion tokens", () => {
    const w = (t: string, s: number) => ({ w: t, start: s, end: s + 0.2 });
    expect(joinSubwordTokens([w("Qu", 0), w("'est", 0.2), w("-ce", 0.4), w("que", 0.6), w("2026", 0.8), w(".", 1)]).map((x) => x.w)).toEqual(["Qu'est-ce", "que", "2026."]);
  });
});

describe("sentence view", () => {
  // Two Whisper segments that split a sentence in the middle (as measured on real talk).
  const words = (text: string, t0: number) => text.split(" ").map((w, i) => ({ w, start: t0 + i * 0.3, end: t0 + i * 0.3 + 0.25, p: w.startsWith("Ozira") ? 0.3 : 0.9 }));
  const t: Transcript = {
    schemaVersion: "1.0", language: "fr", model: "test",
    sources: [{ sourceId: "src_a", segments: [
      { id: "seg_001", start: 0, end: 2.1, text: "", words: words("Je suis Ozira, je dirige ma petite", 0) },
      { id: "seg_002", start: 2.1, end: 4, text: "", words: words("entreprise. Et puis voilà", 2.1) },
    ] }],
  };
  const s = toSentences(t);

  it("rebuilds sentences across segment boundaries from real punctuation", () => {
    expect(s.map((x) => x.text)).toEqual(["Je suis Ozira, je dirige ma petite entreprise.", "Et puis voilà"]);
    expect(s[0]!.start).toBe(0);
    expect(s[0]!.end).toBeCloseTo(2.35, 5); // end of the word "entreprise."
  });
  it("flags unterminated text instead of guessing a boundary", () => {
    expect(s[0]!.unterminated).toBe(false);
    expect(s[1]!.unterminated).toBe(true);
  });
  it("offers clauses as sub-ranges and reports low-confidence words", () => {
    expect(s[0]!.clauses.map((c) => c.text)).toEqual(["Je suis Ozira,", "je dirige ma petite entreprise."]);
    expect(s[0]!.lowConfidence).toEqual(["Ozira,"]);
  });
});

describe("transcription report (no silent failure)", () => {
  const analysis = (speech: { start: number; end: number }[]) => ({ schemaVersion: "1.0", generatedAt: "2026-01-01T00:00:00Z", sources: [{ sourceId: "src_a", shots: [], audio: { speech } }] });
  const transcript = (n: number): Transcript => ({ schemaVersion: "1.0", language: "fr", model: "t", sources: [{ sourceId: "src_a", segments: n ? [{ id: "seg_001", start: 0, end: 1, text: "x", words: Array.from({ length: n }, (_, i) => ({ w: `w${i}`, start: i * 0.3, end: i * 0.3 + 0.2 })) }] : [] }] });

  it("warns when non-silent audio produced no words", () => {
    const [r] = transcriptionReport(transcript(0), analysis([{ start: 0, end: 30 }]));
    expect(r!.words).toBe(0);
    expect(r!.warning).toMatch(/No speech transcribed from 30s/);
  });
  it("warns on a very low word rate over long non-silent audio", () => {
    const [r] = transcriptionReport(transcript(10), analysis([{ start: 0, end: 60 }]));
    expect(r!.wordsPerMinute).toBe(10);
    expect(r!.warning).toMatch(/words\/min/);
  });
  it("stays quiet on normal speech", () => {
    const [r] = transcriptionReport(transcript(80), analysis([{ start: 0, end: 30 }]));
    expect(r!.warning).toBeUndefined();
  });
});
