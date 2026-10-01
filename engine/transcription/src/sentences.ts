/**
 * Sentence view of a transcript (derived, never stored). Whisper segments are time windows, not
 * sentences: on continuous speech every segment boundary can fall mid-sentence (measured: 5/5 on
 * the real talking-head fixture). Sentences are rebuilt from the words and the punctuation Whisper
 * actually produced — nothing is guessed: an unpunctuated run stays ONE sentence and is flagged.
 * Each sentence (and each clause, split at , ; :) is an exact word-aligned {sourceId, start, end}
 * range, usable as-is in a creative plan.
 */
import type { Transcript } from "../../core/src/index.js";

type Word = Transcript["sources"][number]["segments"][number]["words"][number];

export interface Clause {
  start: number;
  end: number;
  text: string;
}

export interface Sentence {
  id: string;
  sourceId: string;
  start: number;
  end: number;
  text: string;
  words: number;
  /** Mean Whisper word probability (a weak signal: it does not catch confident misspellings). */
  meanProb: number | null;
  /** Words below p 0.5: where proofreading should look first. */
  lowConfidence: string[];
  /** True when the sentence has no terminal punctuation (run-on or truncated). */
  unterminated: boolean;
  clauses: Clause[];
}

const SENTENCE_END = /[.!?…]["»”)]*$/;
const CLAUSE_END = /[,;:]["»”)]*$/;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function toSentences(transcript: Transcript): Sentence[] {
  const out: Sentence[] = [];
  for (const src of transcript.sources) {
    const words = src.segments.flatMap((s) => s.words).filter((w) => w.w.replace(/[^\p{L}\p{N}]/gu, "").length > 0 || SENTENCE_END.test(w.w));
    let cur: Word[] = [];
    const flush = (terminated: boolean) => {
      const content = cur.filter((w) => /[\p{L}\p{N}]/u.test(w.w));
      if (content.length) {
        const clauses: Clause[] = [];
        let c: Word[] = [];
        for (const w of cur) {
          c.push(w);
          if (CLAUSE_END.test(w.w) || w === cur.at(-1)) {
            clauses.push({ start: round3(c[0]!.start), end: round3(c.at(-1)!.end), text: c.map((x) => x.w).join(" ") });
            c = [];
          }
        }
        const probs = content.map((w) => w.p).filter((p): p is number => typeof p === "number");
        out.push({
          id: `sent_${String(out.length + 1).padStart(3, "0")}`,
          sourceId: src.sourceId,
          start: round3(content[0]!.start),
          end: round3(content.at(-1)!.end),
          text: cur.map((w) => w.w).join(" "),
          words: content.length,
          meanProb: probs.length ? round3(probs.reduce((a, b) => a + b, 0) / probs.length) : null,
          lowConfidence: content.filter((w) => typeof w.p === "number" && w.p < 0.5).map((w) => w.w),
          unterminated: !terminated,
          clauses,
        });
      }
      cur = [];
    };
    for (const w of words) {
      cur.push(w);
      if (SENTENCE_END.test(w.w)) flush(true);
    }
    flush(false);
  }
  return out;
}
