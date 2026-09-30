---
name: video-editing
description: Build or modify the non-destructive timeline (timeline/timeline.json) - compile the creative plan into cuts, remove silences and hesitations, reorder, trim, jump cuts, punch-in zooms, transitions, B-roll, and smart reframing for 16:9/9:16/1:1/4:5. Use when the user asks to cut, shorten, reorder, remove silences, change format, or after creative-director produces a plan.
---

# video-editing

## Purpose
Create a frame-accurate edit without touching the sources. It is usually compiled from `creative-plan.json`, but you can also adjust it directly for requests like "cut the part where I cough" or "make the intro shorter".

## Inputs
- `plan/creative-plan.json` (for compilation)
- `analysis/*`, `project.json` targets
- Direct user edit requests

## Outputs
`timeline/timeline.json` (schema: `schemas/timeline.schema.json`). Every clip has a `reason`.

## Tools
- `bve plan compile --json` compiles the plan into the timeline:
  - resolves refs
  - cuts silences (`minSilenceSec`, `keepPaddingSec`) and fillers (when `removeFillers` is set)
  - snaps cut points to word gaps
  - adds punch-ins on jump cuts
  - adds brand transitions between sections
- `bve edit trim|split|move|delete|insert --clip <id> ...` for surgical edits.
- `bve edit silence-cut [--min 0.45 --pad 0.12]` / `bve edit remove-fillers` apply the same operations to an existing timeline.
- `bve reframe --target <id> --mode center|fit-blur|face|subject|manual` builds a crop path per target (`face` arrives in Phase 2).
- `bve timeline show --json` returns a readable EDL with timecodes and the transcript text per clip.
- `bve render --target <id> --draft --range a-b` renders a quick preview of a range.

## Workflow
1. Run `bve plan compile`. Check the output duration against the plan target (`bve timeline show`).
2. Read the timeline with the transcript. Verify that sentences are not cut mid-word and that the hook really starts at 0.
3. Reframe for each target:
   - Talking head → `face` (Phase 2) or `center`, adjusted with `subject` points from the analysis annotations.
   - Wide shot or text-on-screen → `fit-blur`.
   - Check the reframing with `bve frames --target <id> --clip <clipId>`.
4. Render a draft of the hook plus one transition, then look at the frames.
5. Summarize the edit: duration, number of cuts, removed silence (seconds) and removed fillers.

## Constraints
- Never cut inside a word. The compiler enforces word-gap snapping. Keep manual edits consistent with that rule.
- A jump cut on the same framing needs a punch-in (scale ≥ 1.08) or a B-roll cover. Otherwise it looks like an error.
- The linked dialogue track follows the video cuts. Never desync the dialogue manually.
- Stay within the target preset's `maxDurationSec`.
- Every modification goes through the CLI, which creates a version. Do not hand-edit JSON unless you then run `bve timeline validate`.

## Examples
- "Supprime les blancs et les euh" → `bve edit silence-cut` + `bve edit remove-fillers`, then report "−14.2 s of silence, 23 hesitations removed; new duration 1:12".
- "Mets la phrase sur le prix au début" → Find the segment, then run `bve edit move --clip clip_018 --to 0`. Check that the hook still reads naturally.
- "Fais une version 9:16" → `bve target add tiktok --preset tiktok/vertical` + `bve reframe --target tiktok --mode center`. Check the frames.

## Failure handling
- The compiled duration is off target by more than the tolerance: report the delta and propose trimming a section, or go back to creative-director.
- A face drifts out of the crop: switch that clip to `fit-blur`, or add `manual` keyframes.
- A source hash changed since analysis (`SOURCE_MODIFIED`): stop. The user must confirm re-ingest and re-analysis.
