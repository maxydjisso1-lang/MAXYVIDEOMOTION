---
name: post-production
description: Entry point for brand-video-engine. Use when the user wants a video edited, cut down, branded, captioned, reformatted or turned into an ad/reel/short. Examples - "turn this video into a 30s Instagram ad", "make a TikTok from my interview with my brand kit", "transforme ma vidéo en pub". Orchestrates the other skills end to end, from analysis to export.
---

# post-production (orchestrator)

## Purpose
Turn raw footage, a brand kit and a brief into finished, QC-passed deliverables. The user does not need to know anything about FFmpeg or Remotion. This skill decides **which** skills to run and in what order, and it keeps the user informed at the two approval points.

## Inputs
- One or more video files (required).
- A brand kit (optional but strongly recommended): logo, colors, fonts, brand book, reference videos, or an existing `brand.json`.
- A brief: goal, platform(s), duration, tone. Infer what you can and ask only for what blocks you. If the platform is missing, ask for it. If the duration is missing, use the platform default.
- Optional: music file, B-roll, product images.

## Outputs
- A project directory (`project.json` plus documents), exports in `exports/`, and a QC report for each target.
- A short plain-language summary: what was done, the key choices and their reasons, and what is worth reviewing.

## Tools
`bve` CLI (always with `--json`). Commands used directly: `doctor`, `init`, `ingest`, `target add|list`, `render --draft`, `frames --target <id> --at <s1,s2,...>` (seconds; take them from `bve timeline show` markers), `version list|undo|checkout`.
Sub-skills: video-analysis, brand-intelligence, creative-director (+ storytelling), video-editing, color-grading, audio-cleanup, music, subtitles, motion-brand, quality-control, export.
- `bve doc get <doc>` / `bve doc set <doc> <file.json>` — read, then write back a modified document (validated against its schema, versioned, undoable). Use it for any fine adjustment that has no dedicated command yet.

## Workflow
1. **Preflight.** Run `bve doctor --json`. If FFmpeg, Python or a model is missing, stop and give the exact install command.
2. **Project.** Run `bve init <dir> --name "<name>"`, then `bve ingest <videos...> [--assets <files...>]`. Put the project next to the user's files unless they say otherwise. Never move or modify their originals.
3. **Targets.** Run `bve target add <id> --preset <platform/name>` for each requested format (see `presets/`).
4. **Understand the footage.** Run the **video-analysis** skill.
5. **Understand the brand.** Run the **brand-intelligence** skill. If no brand kit is given, build a neutral Brand DNA from the brief and say so. Make sure every font role is FOUND or FALLBACK (`bve brand fonts fetch`): a MISSING font blocks export.
6. **Plan.** Run the **creative-director** skill. **Approval point 1:** present the plan in 5–10 lines (structure, hook, duration, style, CTA). Continue without waiting only if the user said to proceed autonomously.
7. **Build**, in this order, because each step depends on the previous one:
   1. video-editing
   2. color-grading
   3. audio-cleanup
   4. music (if any)
   5. subtitles (if enabled)
   6. motion-brand
8. **Review.** Run `bve render --target <id> --draft`, then `bve frames --target <id> --at <seconds>` at the hook, the middle, the CTA and the end card (times from `bve timeline show` and `bve motion list`). Look at the frames yourself. Fix anything off-brand or broken through the relevant skill.
9. **QC and export.** Run the **quality-control** skill, then the **export** skill. **Approval point 2:** report the results and links to the files.
10. Offer the obvious next steps, such as other formats, a shorter cutdown or alternative hooks.

## Constraints
- Sources are read-only. Every change goes through a document and creates a version.
- Never export when QC reports a blocker.
- Do not invent brand values. If a value is inferred, record its provenance and mention it.
- Keep the user-facing language free of FFmpeg and Remotion jargon unless they ask for it.
- Reply in the user's language.

## Examples
- "Voici ma vidéo et ma charte graphique. Transforme-la en publicité Instagram de 30 secondes avec un style premium et dynamique." → Targets `instagram/reels` (+ offer `instagram/portrait`). The brief combines premium and dynamic, which the creative-director turns into a fast plan with restrained motion amplitude.
- "Just clean the audio and add captions." → Run only ingest, video-analysis (audio + transcript), audio-cleanup, subtitles, QC and export. There is no creative plan: the timeline is the full source.
- "Undo the last change." / "Reviens à la version précédente." → Run `bve version undo`, re-render a draft, and state what was reverted.

## Failure handling
- A step fails with `ok:false`: read `code` and `hint`, fix the cause (usually through the owning skill) and retry once. If it still fails, stop and explain in plain language.
- The footage is unusable (all black, no audio when captions are needed, corrupt): report it after analysis and before any planning.
- The brief conflicts with the footage (a 60 s ad requested from 20 s of material): propose alternatives and don't pad silently.
