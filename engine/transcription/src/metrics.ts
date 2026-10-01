/**
 * Objective transcription metrics. Word error rate against a reference text, with a documented
 * normalisation (case, punctuation, apostrophes, hyphens) — nothing that hides real errors:
 * accents and spelling still count ("sigale" ≠ "cigale", "dépourvu" ≠ "dépourvue").
 */

export function normalizeForWer(text: string): string[] {
  return text
    .toLocaleLowerCase("fr")
    .replace(/[’`]/g, "'")
    .replace(/['-]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export interface WerResult {
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceWords: number;
  hypothesisWords: number;
}

/** Levenshtein alignment on words. WER = (S + D + I) / N. */
export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const r = normalizeForWer(reference);
  const h = normalizeForWer(hypothesis);
  const n = r.length;
  const m = h.length;
  // d[i][j] = [cost, S, D, I]
  let prev: [number, number, number, number][] = Array.from({ length: m + 1 }, (_, j) => [j, 0, 0, j]);
  for (let i = 1; i <= n; i++) {
    const cur: [number, number, number, number][] = [[i, 0, i, 0]];
    for (let j = 1; j <= m; j++) {
      const same = r[i - 1] === h[j - 1];
      const sub = prev[j - 1]!;
      const del = prev[j]!;
      const ins = cur[j - 1]!;
      const options: [number, number, number, number][] = [
        [sub[0] + (same ? 0 : 1), sub[1] + (same ? 0 : 1), sub[2], sub[3]],
        [del[0] + 1, del[1], del[2] + 1, del[3]],
        [ins[0] + 1, ins[1], ins[2], ins[3] + 1],
      ];
      cur.push(options.sort((a, b) => a[0] - b[0])[0]!);
    }
    prev = cur;
  }
  const [cost, s, d, ins] = prev[m]!;
  return { wer: n ? cost / n : m ? 1 : 0, substitutions: s, deletions: d, insertions: ins, referenceWords: n, hypothesisWords: m };
}
