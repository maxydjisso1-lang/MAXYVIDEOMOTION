---
name: brand-intelligence
description: Build or update the Brand DNA (brand/brand.json) from a logo, brand guidelines/brand book, colors, fonts, images, past campaigns, reference videos or a website description. Use whenever brand assets are provided, when the user says "use my brand / charte graphique", or when any visual decision needs brand context and brand.json is missing.
---

# brand-intelligence

## Purpose
Brand DNA is the core of this framework. Every color, font, caption style, animation speed, easing, transition and grade is derived from `brand.json`. Your job is to turn heterogeneous brand material into a **complete, validated and explainable** Brand DNA.

## Inputs
Any subset of the following:
- logo files (SVG or PNG preferred)
- brand book PDF
- color codes
- font files or names
- product images
- past campaign images or videos
- website text or screenshots
- adjectives from the user

## Outputs
- `brand/brand.json` (schema: `schemas/brand.schema.json`), with `provenance` for every non-trivial field.
- `brand/preview.png`: a sample frame showing the palette, typography, caption style and a motion keyframe strip.

## Tools
- `bve brand extract --assets <files...> --json` returns **facts**: palette clusters with pixel share, logo background/transparency, embedded font names (PDF/SVG), and dominant colors of reference media.
- `bve brand init --from-extract` writes a draft `brand.json` with `source: "extracted"` fields and schema defaults.
- `bve brand validate` / `bve brand tokens --fps 30` validate the file and show the compiled `BrandTokens` (exact frames, easing and distances).
- `bve brand preview [--target <id>]` renders the preview frame.
- The Read tool on the brand book, images and preview lets you view them.

## Workflow
1. Run `bve brand extract` on everything provided.
2. **Read the brand book or look at the images yourself.** Extraction gives numbers. You provide meaning:
   - **Colors:** decide which colors are primary, secondary and accent, and their usage rules ("accent only for CTA").
   - **Fonts:** assign the display, body and caption roles. If a font file is missing, pick the closest Google Font as `fallback`.
   - **Visual language:** set contrast, radius, shadows, composition, shapes and density.
   - **Motion personality:** map the brand character to `speed`, `easing`, `amplitude`, `transitionStyle` and `energy` using the table below.
   - **Captions:** set the style consistent with the above.
   - **Tone:** add do/don't lists for on-screen copy.
3. Write `brand.json`. Record `provenance` for each field:
   - `user` when the user gave the value
   - `extracted` when it was measured
   - `inferred` when you judged it, with `evidence` and `confidence`
4. Run `bve brand validate`, then `bve brand preview`. Look at the preview and adjust anything that feels off-brand.
5. Show the user a short summary with the preview. **Explicitly ask them to confirm inferred fields with confidence < 0.6** (usually the motion personality).

### Brand character → motion
| Character cues | speed | easing | amplitude | transitionStyle | energy |
|---|---|---|---|---|---|
| luxury, premium, minimal, calm | slow | decelerate | subtle | fade / mask | 0.2 |
| corporate, trustworthy, clean | medium | standard | subtle | slide | 0.35 |
| tech, precise, modern | medium | emphasized | moderate | wipe / mask | 0.5 |
| youthful, playful, social-first | fast | spring-snappy | bold | zoom / slide | 0.8 |
| sport, energetic, bold | fast | spring-snappy | bold | wipe / zoom | 0.9 |

"Premium **and** dynamic" means: speed `fast`, easing `decelerate` or `emphasized` (no bounce), amplitude `moderate`, and energy around 0.6. Only the pace increases. The premium restraint in easing and amplitude stays.

## Constraints
- Never invent hex values that you cannot see or measure. If no colors are given, derive them from the logo, or ask.
- Keep primary colors to 4 or fewer. Every text/background pair used in captions and CTAs must reach WCAG AA contrast (4.5:1). `bve brand validate` checks this.
- Record the font license if it is known. Unlicensed commercial fonts must get a fallback.
- Updating the brand later restyles all motion and captions automatically. Warn the user before changing an approved brand on a project with exports.

## Examples
- Input: a black SVG logo, "Maison Lune, joaillerie minimaliste", a PDF with Canela and Inter. Output: the primary is near-black `#111111`, the accent is gold measured from the PDF's pages, display is Canela (fallback "Cormorant Garamond"), body is Inter, motion is `slow/decelerate/subtle/fade`, energy is 0.2, and captions are white Inter 600, sentence case, fade, no box.
- Input: a PNG logo with neon green on black and the words "on fait bouger la street". Output: the accent is `#39FF14`, motion is `fast/spring-snappy/bold/zoom`, and captions are uppercase, pop, with the key words highlighted in the accent color.

## Failure handling
- The brand book is unreadable (scanned PDF): view the pages as images and extract visually. Set a lower confidence.
- The logo is a low-res JPG on a white background: warn that the quality will suffer. `extract` attempts background removal. Suggest getting an SVG.
- Validation fails on contrast: propose the nearest compliant pairing (for example a darker text color or a box background). Don't silently change brand colors.
