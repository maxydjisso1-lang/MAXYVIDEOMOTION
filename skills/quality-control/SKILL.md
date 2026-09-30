---
name: quality-control
description: Run automated quality control on a rendered target before export (exports/…/qc-report.json) - resolution, fps, codec, audio presence, loudness/true peak, black/frozen frames, missing media, caption sync/overlap/safe zones/reading speed, color sanity, Brand DNA consistency, motion overrides, duration, aspect ratio. Use before every final export, or when the user asks "is it ready / check the video".
---

# quality-control

## Purpose
Catch everything a human finishing editor would catch, and **block the export** on real defects.

## Inputs
- A render for the target: `bve render --target <id>`, which is non-draft for final QC
- All project documents
- The target preset

## Outputs
`renders/<target>-<version>.qc.json` (schema: `schemas/qc-report.schema.json`) and a printed report:

```text
QC REPORT — ig_reels — v0012
Technical: PASS    Audio: PASS    Captions: WARN (1)
Color: PASS        Brand: PASS    Motion: PASS    Export: PASS
```

## Tools
- `bve qc --target <id> [--json]` — runs every check on the exact rendered file and writes `renders/<target>-<version>.qc.json`. With blockers it returns `ok:false`, `code: QC_BLOCKED`, exit 5, and the report text + blocking checks in `details`.
- Read the report JSON for details (`expected`, `measured`, `at`, `fix`).
- `bve frames --target <id> --at <sec,...>` — visually inspect flagged moments.
- `bve qc waive <checkId> --reason "..."` — **user decision only**.

### Checks
| Category | Check | Blocker when |
|---|---|---|
| technical | resolution, fps, codec, pixel format, aspect ratio, color tags | differs from the preset |
| technical | duration | outside the preset max, or outside the plan tolerance (warn) |
| technical | black / frozen frames | > 0.5 s outside intended fades |
| technical | missing media | any source hash mismatch or missing asset |
| audio | stream present, loudness, true peak | missing audio, or LUFS off by more than ±1 LU, or TP > preset max |
| audio | A/V drift | stream durations differ by > 1 frame |
| audio | clipping | warn |
| captions | overlap in time, reading speed, min duration, chars per line | overlap = blocker; others warn |
| captions | safe zones (measured text boxes) | any glyph box outside the safe zone |
| captions | sync (cue onset vs. speech onset) | median offset > 120 ms |
| color | illegal levels, crushed or clipped extent | warn (blocker for advertising/broadcast) |
| brand | tokens fresh, logo present, rendered end-card color (ΔE), **fonts as verified by the renderer** | FONT MISSING (no brand or fallback file, or libass substituted it) = blocker; FONT FALLBACK = warn; stale tokens or missing logo = blocker |
| motion | safe zones, overlaps between motion elements, collisions with captions (after captions gave way), overrides | out of the safe zone = blocker |
| export | container, faststart, metadata, file size vs. platform limit | platform limit exceeded |

## Workflow
1. Run `bve qc --target <id> --json`.
2. For each fail or warn:
   - look at the frame(s) with `bve frames`
   - decide whether it's a real problem
   - fix it through the owning skill (captions → subtitles, loudness → audio-cleanup…)
3. Re-render and re-run QC. Repeat until there are no blockers.
4. Report the final QC table to the user, including any accepted warnings and why they were accepted.

## Constraints
- Blockers cannot be waived by Claude. Only the user can accept a blocker, with `bve qc waive <checkId> --reason "..."`. The waiver is recorded in the report and the export metadata.
- QC always runs on the exact file that will be exported (the hash is recorded).
- Never edit the QC report by hand.

## Examples
- `captions.safe-zone` fail at 00:07.4 in tiktok → cue 12 is 3 lines on a long word. Split the cue with `bve doc get captions` and `bve doc set captions <file>`, then re-render.
- `audio.loudness` fail at −17.8 LUFS → master normalization was disabled. Re-enable it, then re-render.

## Failure handling
- QC can't measure something (a tool is missing): the check is `skip`, with a reason. A skipped blocker check makes the status `warn`, never `pass`.
- Flaky visual heuristics (black-frame detection on an intentional fade to black): verify the frames and let the user waive it with a reason.
