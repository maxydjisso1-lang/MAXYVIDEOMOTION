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
- `bve plan compile` — plan → timeline: resolves refs, cuts silences (`pacing.removeSilences`) and fillers (`pacing.removeFillers`) only between words, keeps `keepPaddingSec` of air, frame-snaps every clip, adds punch-ins on jump cuts, section markers and a default `center` reframe per target.
- `bve timeline show` — readable EDL (clips, source ranges, sections, reasons, markers).
- `bve edit delete --clip <id>` / `bve edit trim --clip <id> [--in <s>] [--out <s>]` — ripple edits.
- `bve reframe --target <id> --mode center|fit-blur` — per-target crop strategy.
- `bve render --target <id> --draft` then `bve frames --target <id> --at <seconds>` to check.
- To change structure or pacing, edit the plan and recompile (preferred), or use `bve doc get/set timeline` for manual changes.
- Planned (not yet available): `face`/`subject` reframing (MediaPipe), split/move/insert commands, beat snapping.
- `bve doc get <doc>` / `bve doc set <doc> <file.json>` — read, then write back a modified document (validated against its schema, versioned, undoable). Use it for any fine adjustment that has no dedicated command yet.

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
- "Supprime les blancs et les euh" → set `pacing.removeSilences.enabled` and `pacing.removeFillers` in the plan, run `bve plan set` and `bve plan compile`, then report "−14.2 s of silence, 23 hesitations removed; new duration 1:12".
- "Mets la phrase sur le prix au début" → Find the segment (`bve transcript show`), make it the plan's `hook.sourceRefs`, then run `bve plan set` and `bve plan compile`. Check that the hook still reads naturally.
- "Fais une version 9:16" → `bve target add tiktok --preset tiktok/vertical` + `bve reframe --target tiktok --mode center`. Check the frames.

## Failure handling
- The compiled duration is off target by more than the tolerance: report the delta and propose trimming a section, or go back to creative-director.
- A face drifts out of the crop: switch that clip to `fit-blur`, or add `manual` keyframes.
- A source hash changed since analysis (`SOURCE_MODIFIED`): stop. The user must confirm re-ingest and re-analysis.
