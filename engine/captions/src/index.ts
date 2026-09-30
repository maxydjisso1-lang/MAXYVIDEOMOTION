/**
 * Captions pipeline: transcript (source time) -> remap through the edit -> segmentation driven
 * by style tokens -> emphasis -> captions.json (timeline time). Styling happens at render time.
 */
import { round3, SCHEMA_VERSION, type Captions, type CreativePlan, type Project, type StyleTokens, type Timeline, type Transcript } from "../../core/src/index.js";

type Cue = Captions["cues"][number];
type CueWord = Cue["words"][number];

export interface TimedWord {
  text: string;
  start: number;
  end: number;
  p?: number;
  /** First word after a cut that jumps in the source: a cue must never span it. */
  cutBefore?: boolean;
}

/** Map words from source time into timeline time; words that were cut out disappear. */
export function remapWords(transcript: Transcript, timeline: Timeline): TimedWord[] {
  const out: TimedWord[] = [];
  const clips = timeline.tracks.video.filter((t) => t.kind === "primary").flatMap((t) => t.clips).filter((c) => c.enabled !== false);
  let prev: (typeof clips)[number] | undefined;
  for (const clip of clips) {
    const words = transcript.sources.find((s) => s.sourceId === clip.sourceId)?.segments.flatMap((s) => s.words) ?? [];
    const speed = clip.speed ?? 1;
    const jump = !!prev && (prev.sourceId !== clip.sourceId || Math.abs(prev.sourceOut - clip.sourceIn) > 0.05);
    let first = true;
    prev = clip;
    for (const w of words) {
      const mid = (w.start + w.end) / 2;
      if (mid < clip.sourceIn || mid >= clip.sourceOut) continue;
      const toTl = (s: number) => clip.timelineStart + (Math.min(Math.max(s, clip.sourceIn), clip.sourceOut) - clip.sourceIn) / speed;
      out.push({ text: w.w, start: round3(toTl(w.start)), end: round3(toTl(w.end)), ...(w.p !== undefined ? { p: w.p } : {}), ...(jump && first ? { cutBefore: true } : {}) });
      first = false;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// Words that must not end a line/cue ("une | marque" reads badly).
const NO_BREAK_AFTER = new Set([
  "le", "la", "les", "l'", "un", "une", "des", "de", "du", "d'", "au", "aux", "à", "en", "et", "ou", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "votre", "leur", "ce", "cette", "ces", "qui", "que", "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "pour", "par", "sur", "dans", "avec", "sans", "dès",
  "the", "a", "an", "of", "to", "and", "or", "my", "your", "our", "their", "this", "that", "in", "on", "at", "for", "with", "by", "from", "i", "we", "you",
]);
const STOP = new Set([...NO_BREAK_AFTER, "est", "sont", "vais", "va", "pas", "ne", "is", "are", "be", "will", "it", "its", "so", "euh", "um", "uh"]);

const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
const endsSentence = (w: string) => /[.!?…]$/.test(w);
const endsClause = (w: string) => /[,;:]$/.test(w);

export interface SegmentOptions {
  maxWordsPerLine: number;
  maxLines: number;
  maxCharsPerLine?: number;
  maxCueSec: number;
  pauseSec?: number;
}

export function segmentOptions(tokens: StyleTokens): SegmentOptions {
  // Energetic brands flash shorter cues; calm brands give longer reading windows.
  const maxCueSec = round3(4.2 - 2.2 * tokens.motion.energy);
  return { maxWordsPerLine: tokens.caption.maxWordsPerLine, maxLines: tokens.caption.maxLines, maxCharsPerLine: 42, maxCueSec, pauseSec: 0.35 };
}

export function segment(words: TimedWord[], opts: SegmentOptions): TimedWord[][] {
  const cues: TimedWord[][] = [];
  const maxWords = opts.maxWordsPerLine * opts.maxLines;
  const maxChars = (opts.maxCharsPerLine ?? 42) * opts.maxLines;
  let cur: TimedWord[] = [];
  const flush = () => {
    if (cur.length) cues.push(cur);
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev) {
      const pause = w.start - prev.end;
      const chars = cur.reduce((a, x) => a + x.text.length + 1, 0) + w.text.length;
      const tooLong = cur.length >= maxWords || chars > maxChars || w.end - cur[0]!.start > opts.maxCueSec;
      const natural = endsSentence(prev.text) || pause > (opts.pauseSec ?? 0.35);
      if (w.cutBefore) flush();
      else if ((natural || tooLong) && !NO_BREAK_AFTER.has(bare(prev.text))) flush();
      else if (tooLong && cur.length >= 2) {
        // Break before the dangling function word(s) instead of after them.
        let k = cur.length;
        while (k > 1 && NO_BREAK_AFTER.has(bare(cur[k - 1]!.text))) k--;
        const carry = cur.splice(k);
        flush();
        cur = carry;
      }
    }
    cur.push(w);
  }
  flush();
  // No orphans: a lone word joins its neighbour when both come from the same continuous take.
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    if (cue.length !== 1 || cues.length === 1) continue;
    const prev = cues[i - 1];
    const next = cues[i + 1];
    if (prev && !cue[0]!.cutBefore && prev.length < maxWords) {
      prev.push(cue[0]!);
      cues.splice(i--, 1);
    } else if (next && !next[0]!.cutBefore && next.length < maxWords) {
      next.unshift(cue[0]!);
      cues.splice(i--, 1);
    }
  }
  return cues;
}

/** Heuristic emphasis: numbers, brand/CTA/on-screen words, then the most "contentful" word. At most one `key` per cue. */
export function emphasize(cue: TimedWord[], context: { keywords: Set<string> }, cueIndex: number): CueWord["emphasis"][] {
  const scores = cue.map((w) => {
    const b = bare(w.text);
    if (!b || STOP.has(b)) return 0;
    let s = Math.min(b.length, 10) / 10;
    if (/\d/.test(b)) s += 2;
    if (context.keywords.has(b)) s += 1.5;
    if (endsSentence(w.text) || endsClause(w.text)) s += 0.2;
    return s;
  });
  const best = scores.indexOf(Math.max(...scores));
  return cue.map((_, i) => {
    if (i !== best || scores[i]! < 0.55) return "none";
    // Keep "key" rare (roughly one cue in two) so emphasis keeps its meaning.
    return scores[i]! >= 1.5 || cueIndex % 2 === 0 ? "key" : "strong";
  });
}

function lineBreaks(cue: TimedWord[], maxWordsPerLine: number, maxLines: number): boolean[] {
  const lines = Math.min(maxLines, Math.ceil(cue.length / maxWordsPerLine));
  const perLine = Math.ceil(cue.length / lines);
  return cue.map((_, i) => lines > 1 && (i + 1) % perLine === 0 && i < cue.length - 1);
}

export function buildCaptions(transcript: Transcript, timeline: Timeline, tokens: StyleTokens, plan?: CreativePlan): Captions {
  const words = remapWords(transcript, timeline);
  const opts = segmentOptions(tokens);
  const keywords = new Set(
    [tokens.brandName, plan?.cta?.text, plan?.hook.onScreenText, ...(plan?.sections.map((s) => s.onScreenText) ?? [])]
      .filter((x): x is string => !!x)
      .flatMap((x) => x.split(/\s+/).map(bare))
      .filter((x) => x && !STOP.has(x)),
  );
  const groups = segment(words, opts);
  const cues: Cue[] = groups.map((g, i) => {
    const emph = emphasize(g, { keywords }, i);
    const breaks = lineBreaks(g, opts.maxWordsPerLine, opts.maxLines);
    return {
      id: `cue_${String(i + 1).padStart(3, "0")}`,
      start: g[0]!.start,
      end: g.at(-1)!.end,
      words: g.map((w, k): CueWord => ({
        text: w.text,
        start: w.start,
        end: w.end,
        ...(emph[k] !== "none" ? { emphasis: emph[k] } : {}),
        ...(breaks[k] ? { lineBreakAfter: true } : {}),
      })) as Cue["words"],
    };
  });
  // Minimum on-screen time 0.7 s, never overlapping the next cue.
  for (const [i, c] of cues.entries()) {
    const next = cues[i + 1];
    const wanted = Math.max(c.end, c.start + 0.7);
    c.end = round3(next ? Math.min(wanted, next.start) : Math.min(wanted, timeline.durationSec ?? wanted));
  }
  return { schemaVersion: SCHEMA_VERSION, language: transcript.language, renderer: "remotion", cues };
}

/** Project operation: build captions from the transcript, the edit and the brand tokens. */
export async function buildProjectCaptions(project: Project): Promise<Captions> {
  const doc = buildCaptions(await project.readDoc("transcript"), await project.readDoc("timeline"), await project.readDoc("styleTokens"), await project.readDocOptional("plan"));
  await project.writeDoc("captions", doc, { command: "captions build", message: `Captions: ${doc.cues.length} cues` });
  return doc;
}
