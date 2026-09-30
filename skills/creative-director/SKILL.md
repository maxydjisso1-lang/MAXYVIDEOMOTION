---
name: creative-director
description: Write or revise the creative plan (plan/creative-plan.json) - narrative structure, hook, section order, shot selection, pacing, transitions, music, captions, motion density, CTA, outro - from the brief, the video analysis and the Brand DNA. Use after analysis and brand exist, or when the user asks to change the story, hook, rhythm, duration or CTA.
---

# creative-director

## Purpose
Make the editorial decisions. This skill combines the **brief**, the **analysis** (facts about the footage) and the **Brand DNA** (identity) into a single `creative-plan.json`. Downstream skills execute that plan. The plan is semantic: it references transcript segments and shots, and the engine resolves exact frames.

## Inputs
- The `project.json` brief and targets
- `analysis/analysis.json` (use `bve analysis summary`)
- `analysis/transcript.json`
- `brand/brand.json`
- Optional: the user's constraints, such as "must include the price" or "end on the logo"

## Outputs
`plan/creative-plan.json` (schema: `schemas/creative-plan.schema.json`), with a `rationale` array written in plain language.

## Tools
- `bve analysis summary --json` and `bve transcript show --format segments` (numbered segments with timecodes).
- The **storytelling** skill, a reference for structures, hook techniques and pacing norms per platform.
- `bve plan validate --json` checks the schema. It also checks that referenced segments and shots exist and estimates the resulting duration against `targetDurationSec`.
- `bve plan estimate --json` returns the per-section durations after silence and filler removal.

## Workflow
1. **Read.** Read the brief, the analysis summary and the numbered transcript segments. Check the brand tone (`tone.do` / `tone.dont`) and motion energy.
2. **Choose a structure.** Pick it with the storytelling skill according to objective and duration. For example, a 30 s conversion ad uses hook → problem → solution → proof → CTA.
3. **Find the hook.** It must land in the first 1–3 s. Look for the strongest line (a bold claim, a result or a question) or the most striking visual. It may come from the middle of the source, since reordering is allowed.
4. **Select material for each section.** Use `segmentId` refs (best for speech) or `shotId` refs (for visuals). Prefer shots with `qualityScore` ≥ 0.6 and no exposure problems.
5. **Set the pacing** from the platform and the brand:
   - `pacing.style`
   - `avgShotSec`
   - `jumpCuts` and `punchIns` (fast styles)
   - silence removal thresholds
   - `removeFillers` (only if the user asked, or if the style is fast)
6. **Define the rest:**
   - transitions: `brand` between sections, `cut` within them
   - music mood and ducking
   - captions: on by default for social targets
   - motion density, intro and outro
   - CTA text, following the brand tone and 40 characters max
   - logo watermark
   - color intent
   - audio cleanup level
7. Write the plan, then run `bve plan validate` and `bve plan estimate`. Iterate until the estimate is within `durationToleranceSec`.
8. Present the plan to the user in 5–10 lines, including the rationale. Revise on feedback. Each revision creates a new version.

## Constraints
- Use only material that exists. Every ref must validate.
- Respect `maxDurationSec` for each target preset.
- Put nothing in the plan that contradicts the Brand DNA (for example `aggressive` pacing for a `calm` brand). Justify it in `rationale` if the brief explicitly overrides the brand.
- On-screen text follows `brand.tone`. Never invent claims, prices or statistics that are not in the footage or the brief.
- Pass the user's own words through unchanged in quotes. Don't paraphrase testimonials.

## Examples
Brief: "pub Instagram 30s, premium et dynamique". Brand: Maison Lune (calm, luxe). Footage: a 2 min founder interview plus product B-roll.

The plan:
- **Narrative:** `hook-problem-solution-cta`.
- **Hook:** segment `seg_031`, "Chaque bijou est unique, comme vous" (result-first), over the product close-up `s012`.
- **Sections:** problem (seg_004), solution (seg_010 + broll s015,s016), proof (seg_022).
- **Pacing:** `fast`, avgShotSec 2.2, punchIns true, jumpCuts false (they would clash with premium).
- **Transitions:** brand (fade).
- **Captions:** on, emphasis auto.
- **Motion:** density low, outro BrandOutro.
- **CTA:** "Découvrir la collection".
- **Rationale:** "Fast cutting satisfies 'dynamique'; brand-driven slow easing and fades keep it premium."

## Failure handling
- Not enough usable material for the target duration: propose a shorter duration or a slower pace. Never loop footage silently.
- `plan validate` reports unknown refs: re-list the segments and fix the ids.
- Conflicting user requests (for example 15 s with 5 key messages): explain the trade-off and propose the two best options.
