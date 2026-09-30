---
name: motion-brand
description: Add brand-driven motion graphics (motion/motion.json) rendered with Remotion - BrandIntro, BrandOutro, LogoReveal, Title, Subtitle, LowerThird, CTA, Quote, Statistic, ProductReveal, FeatureCard, Callout, Transition, Watermark. Style, easing, speed, amplitude and shapes come from Brand DNA. Use when the user wants titles, lower thirds, CTA, logo animation, text animations, intro/outro, or when a creative plan requests motion.
---

# motion-brand

## Purpose
Motion design that looks like the brand, not like a template. You choose **what** appears, **when** and **with what content**. Brand DNA decides **how it looks and moves**: `brand.json` is compiled into `BrandTokens`, which every component consumes. A minimal brand gets minimal motion and an energetic brand gets energetic motion, with the same `motion.json`.

## Inputs
- `creative-plan.json` (motion density, intro/outro, lower thirds, CTA, onScreenText)
- `brand/brand.json`
- `timeline/timeline.json` (markers: sections, beats)
- `subtitles/captions.json` (to avoid collisions)

## Outputs
`motion/motion.json` (schema: `schemas/motion.schema.json`): component instances with timing, content props and anchors. No style values are stored there.

## Tools
- `bve motion from-plan` creates the instances requested by the plan (CTA, outro, titles for `onScreenText`, lower thirds), timed to the section markers.
- `bve motion add <Component> --at <sec> --duration <sec> --props '<json>' [--anchor lower-third] [--targets a,b]`
- `bve motion edit <id> ...` / `bve motion remove <id>`
- `bve motion list --json`
- `bve motion preview <id> --target <id> [--frames 5]` renders a filmstrip of the animation (in → hold → out). **Look at it.**
- `bve brand tokens` shows the exact durations, easing and distances in effect.

### Components (Phase 1 in bold)
**Title**, Subtitle, **LowerThird**, **CTA**, **LogoReveal**, BrandIntro, **BrandOutro**, **Watermark**, Quote, Statistic, ProductReveal, FeatureCard, Callout, Transition. Captions are rendered by the same Remotion composition but managed by the subtitles skill.

## Workflow
1. Run `bve motion from-plan`.
2. Check the density:

   | density | instances |
   |---|---|
   | low | 1 every ~10 s or less, CTA + outro |
   | medium | 1 every ~5 s |
   | high | continuous accents |

   Motion should support the message and never compete with a speaking face.
3. Write the on-screen copy following `brand.tone`. Keep it short: titles ≤ 6 words, CTA ≤ 5 words.
4. Run `bve motion preview` for each new instance and target. Check the following:
   - legibility (duration ≥ 1 s for every 3 words of reading)
   - safe zones
   - no collision with captions
   - timing on beats or cuts where relevant
5. For deviations the user asks for ("plus punchy ici"), use `tokenOverrides` on that instance rather than editing the brand. QC lists the overrides.

## Constraints
- Never hard-code colors or fonts in props. The components only accept tokens. If the user wants a color outside the brand, confirm it, then add it to `brand.json` as an accent, or use a documented override.
- The logo respects `clearSpace`, `minHeightPx` and `allowedBackgrounds`.
- Titles and CTA text never cross the target safe zones. Layout measures the text and shrinks or rewraps it (`fitText`). If the text still doesn't fit, shorten the copy.
- Don't stack more than 2 animated elements at once, plus captions.

## Examples
Same `motion.json` (`CTA "Découvrir la collection"` at 26 s for 4 s, anchor safe-bottom), two brands:
- **Maison Lune** (slow/decelerate/subtle/fade, shapes: line): a hairline draws in over 0.8 s, the text fades up 12 px, and the logo fades in and holds.
- **Street brand** (fast/spring-snappy/bold/zoom, shapes: pill): a neon pill scales from 0.6 with overshoot in 0.27 s, the text staggers word by word, and there is a pulse accent on the next beat marker.

## Failure handling
- Font failed to load (`FONT_UNAVAILABLE`): the renderer uses the brand `fallback` font. Report it and have QC flag it.
- The preview shows clipping or overflow: shorten the copy, change the anchor or the variant. Never scale the text below the caption size.
- Remotion is unavailable or unlicensed for the user: use `--renderer ffmpeg`, which supports basic Title, CTA and Watermark (static plus fade only). Tell the user what is lost.
