---
name: color-grading
description: Color correction and color grading per shot (color/color.json) - exposure, contrast, highlights/shadows/whites/blacks, saturation, temperature/tint, white balance, skin tones, shot matching, and brand-driven creative looks/LUTs. Use when footage looks too dark/bright/blue/orange/flat, when shots don't match, or to apply a brand or cinematic look.
---

# color-grading

## Purpose
Make every shot technically correct (**correction**), consistent across shots (**matching**), and then on-brand (**grading**). These are kept as three separate, stored, editable layers.

| Layer | Goal | Driven by |
|---|---|---|
| Correction | neutral, well-exposed, natural skin | measurements (luma percentiles, RGB means) |
| Matching | shot B looks like shot A | a reference shot (`matchTo`) — Phase 2 |
| Grading | creative look | `brand.grade` (look, intensity, LUT, saturation, warmth) |

## Inputs
- `analysis/analysis.json` (per-shot luma, saturation, rgbMean, exposure flags)
- `timeline/timeline.json` (only shots in use are processed)
- `brand/brand.json` (grade section)

## Outputs
`color/color.json` (schema: `schemas/color.schema.json`) with before/after measurements and a `reason` per shot.

## Tools
- `bve color auto [--intent brand-look|correct-only] [--white-balance off|gray-world]` — measured correction for every shot the timeline uses (exposure, contrast; white balance **off by default**, the measured cast is only reported in `reason`) + the brand grade from style tokens (look, intensity, saturation, warmth, LUT). Locked shots are kept.
- Manual adjustment: `bve doc get color`, change a shot's `correction`/`grade` and set `"locked": true`, then `bve doc set color <file>`.
- Check: `bve render --target <id> --draft` + `bve frames --target <id> --at <seconds>` and look at the frames (compare with `analysis/keyframes/`).
- Planned (not yet available): cross-camera shot matching, a before/after stills command, skin-tone qualifier.
- `bve doc get <doc>` / `bve doc set <doc> <file.json>` — read, then write back a modified document (validated against its schema, versioned, undoable). Use it for any fine adjustment that has no dedicated command yet.

## Workflow
1. Run `bve color auto`. The guard-rails (measured, docs/measurements/color.md):
   - **Exposure**: a shot is brightened only if it has no highlights (98th luma percentile < 0.65); the gain keeps the 90th percentile ≤ 0.75 and the 98th ≤ 0.92, and is applied by a curve that never clips. A dark shot WITH highlights (low-key interview, object on black, candle light) is left as shot. A washed-out shot (bright mean, no deep shadows) is darkened. Overexposure with clipped highlights cannot be recovered and is left alone.
   - **Contrast**: only when the shot is still flat after the exposure gain.
   - **White balance**: not applied automatically. Gray-world could not tell a warm interior, a forest or a sunset from a cast and degraded every real video tested; the would-be gains are written in `reason`. If the user confirms a cast, run `--white-balance gray-world` or set the shot's gains by hand.
   - Every source is first read with its own colorimetry (tag, else ≥ 720 lines = BT.709, smaller = BT.601) and delivered as BT.709.
2. Render a draft and extract frames from each corrected shot (`bve render --target <id> --draft`, then `bve frames --target <id> --at <seconds>`). **Look at them** next to `analysis/keyframes/`. Check the following:
   - skin looks natural (not orange, magenta or grey)
   - there are no crushed blacks or clipped highlights
   - consecutive shots feel consistent
   - the look matches the brand (for example, luxury is muted and filmic rather than vivid)
3. Fix outliers with `bve doc get color`, edit the shot's `correction`, then `bve doc set color <file>`. Set `"locked": true` on the shots the user approves.
4. Explain in one or two lines what changed ("brightened 3 underexposed shots by ~0.5 EV, neutralised the blue cast on the outdoor shots, applied a soft warm filmic look at 40%").

## Constraints
- Correction before grading, always. Never compensate for bad exposure with a LUT.
- Clamps: exposure ±1.5 EV and WB gains between 0.85 and 1.15 unless the user asks for more. Large corrections degrade 8-bit footage.
- Measured side effects of the brand looks (intensity 0.6), kept on purpose: `muted` turns skin hue by ≈ +7 to +9°; `vibrant` crushes shadows (pixels with a channel at 0: 1 % → 11 % on a talking head); `filmic` lifts and teal-tints the blacks (intended); `warm`/`cool` (colorbalance) do not crush shadows, even on brightened dark shots, but roughly double the base-plate time. Check skin and shadows on a draft when a brand uses `muted` or `vibrant`.
- Known limit: a mostly black frame with small text (title card) reads as "flat" and gets a little contrast.
- Respect intentional looks. Night, neon, silhouettes and shots annotated `intentional-look` get correction `intensity` ≤ 0.3.
- `locked` shots are never modified by `auto`.
- LUTs must be `.cube` files under `assets/`.

## Examples
- "La vidéo est trop sombre" → `bve color auto --intent correct-only`, then show the stills. Report the EV changes. If `reason` says "dark but with highlights: low-key", the engine judged it intentional: ask before brightening by hand.
- "Donne un look cinéma" → set `globalGrade: { look: "filmic", intensity: 0.5 }` via `bve doc set color`, render a draft, show the frames, and confirm the look is consistent with the brand. For a brand-wide change, edit `grade` in brand.json instead.
- The brand is "vibrant, youth" → `brand.grade.look = vibrant`. `auto` raises saturation but protects skin.

## Failure handling
- Heavy clipping in the source (p95 = 1.0 over large areas): highlights can't be recovered. Say so and reduce contrast instead.
- Mixed lighting in one shot: no automatic neutralisation (measured: a global WB made it worse). Mention that a split correction is a later feature.
- The LUT file is invalid or missing: the engine reports `ASSET_INVALID`. Fall back to the look preset.
