---
name: subtitles
description: Generate brand-styled, animated captions (subtitles/captions.json) - Whisper transcription with word timestamps, remapping through the edit, segmentation into readable lines, detection of key words to emphasize, styling from Brand DNA, safe-zone aware layout, SRT/VTT export. Use when the user wants subtitles/captions/sous-titres, animated captions, or when a social target needs sound-off readability.
---

# subtitles

## Purpose
Readable, perfectly synced captions that look like the brand. Pipeline:

```text
audio → transcription (word timestamps) → remap to edited timeline → segmentation → emphasis → style (Brand DNA) → layout per target (safe zones) → render (Remotion | ASS)
```

## Inputs
- `analysis/transcript.json` (source time)
- `timeline/timeline.json`
- `brand/brand.json` → `caption`
- The target presets (safe zones)

## Outputs
`subtitles/captions.json` (schema: `schemas/captions.schema.json`) in timeline time. Optional `exports/*.srt` / `*.vtt` sidecars.

## Tools
- `bve captions build` — remaps word timings through the edit, segments with the brand's caption rhythm (words per line, lines, cue length from energy), never spans a source-jumping cut, never ends a line on an article, auto-emphasises numbers/keywords (at most one key word per cue).
- Fix a word, emphasis or line break: `bve doc get captions`, edit, `bve doc set captions <file>` (validated, versioned).
- Sidecars: `bve export --target <id> --sidecars srt,vtt`.
- Check: `bve render --target <id> --draft` + `bve frames`; QC measures overlap, reading speed and safe zones.
- Planned (not yet available): dedicated `captions fix|emphasize|resync` commands, translation.
- `bve doc get <doc>` / `bve doc set <doc> <file.json>` — read, then write back a modified document (validated against its schema, versioned, undoable). Use it for any fine adjustment that has no dedicated command yet.

## Workflow
1. Run `bve captions build`.
2. **Proofread.** Whisper `small` misspells names and rare words (e.g. "Ozira Mobunu" for Osiéra Mebounou, "sigale" for "cigale"). Start with the `lowConfidence` words of `bve transcript sentences`, but read everything: confident misspellings are common. Sub-word tokens ("j 'exerce", "Qu'est -ce") and orphan words are fixed automatically. Run `bve doc get captions`, then fix brand names, proper nouns and technical terms that Whisper often misspells. The brand name must be spelled exactly as in `brand.json`.
3. **Refine emphasis semantically.** Heuristics are a starting point. Choose 1 key word per cue at most and 1 in 3 cues or fewer for `key`. Pick the words that carry the message ("COMMENT", "CRÉER", "UNE MARQUE").
4. Preview at the hook, a dense cue and the CTA for each target. Check the following:
   - nothing is cut or off-screen
   - no overlap with lower-thirds or the CTA (captions auto-hide under full-screen motion)
   - the text stays inside the safe zones
5. Offer SRT/VTT sidecars for platforms that support native captions (YouTube, LinkedIn).

## Constraints
- Reading speed must stay at 17 characters per second or fewer for FR/EN. Cues last at least 0.7 s. There are at most `maxLines` lines and never more than 42 characters per line.
- Captions never overlap each other in time, and they never cover a face (Phase 2 uses face boxes; Phase 1 respects the anchor and safe zones).
- Keep the style from Brand DNA. Put per-project changes in `styleOverrides` (QC reports them), never in brand.json, unless the user wants a brand-wide change.
- Languages: FR and EN are first-class. Other Whisper languages work, but emphasis heuristics are generic.

## Examples
Transcript "Aujourd'hui je vais vous montrer comment créer une marque", brand caption `upper, pop, emphasisStyle color`:
- cue 1: "AUJOURD'HUI JE VAIS VOUS MONTRER" (no emphasis)
- cue 2: "**COMMENT**" (key, accent color, pop)
- cue 3: "**CRÉER** UNE **MARQUE**" (key, strong)

## Failure handling
- Low-confidence words (p < 0.5) are listed by `build`. Review them first.
- A word drifts after cuts (a caption appears before the voice): adjust the word's `start`/`end` against the speech ranges in the analysis, then `bve doc set captions <file>`.
- Text overflows in the 9:16 layout: the engine auto-reduces words per line. If it still overflows, lower `sizeScale` in the overrides and report it.
