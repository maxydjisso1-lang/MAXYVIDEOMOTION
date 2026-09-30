---
name: audio-cleanup
description: Clean and master dialogue audio (audio/audio.json) - detect and reduce background noise, HVAC/fan, street, wind, electrical hum, hiss, excessive reverb; apply voice EQ, de-essing, compression, gain, loudness normalization and limiting while keeping the voice natural. Use when audio sounds noisy, quiet, uneven, harsh, or before any export.
---

# audio-cleanup

## Purpose
Produce clear, natural and correctly loud dialogue. Processing is described as editable per-source chains, which are compiled to FFmpeg filters at render time.

## Inputs
- `analysis/analysis.json` → `audio` (noise floor, noiseProfile, humHz, clipping, LUFS, speech ranges)
- `project.json` targets (the loudness target comes from the preset)
- The `creative-plan.audio.cleanup` level, if a plan exists

## Outputs
The `dialogue[]` and `master` sections of `audio/audio.json` (schema: `schemas/audio.schema.json`), with before/after metrics.

## Tools
- `bve audio clean [--preset gentle|standard|aggressive] [--source <id>]` builds the chain from the measured problems.
- `bve audio set --source <id> --processor deess --params '{"intensity":0.4}'` / `--disable <type>` for manual changes.
- `bve audio preview --source <id> --range 10-20 --ab` exports short before/after WAV snippets plus metrics.
- `bve audio measure` re-measures after processing.

### Processor map (FFmpeg)
| Problem | Processor | FFmpeg |
|---|---|---|
| rumble, handling, HVAC low end | highpass 70–100 Hz | `highpass` |
| 50/60 Hz hum + harmonics | dehum | `bandreject`/`anequalizer` notches at f, 2f, 3f… |
| broadband noise, fan, street | denoise-fft / denoise-rnn | `afftdn` (with noise profile from silences) / `arnndn` (RNNoise) |
| hiss | denoise-fft high band + gentle lowpass | `afftdn`, `lowpass` 14–16 kHz |
| sibilance | deess | `deesser` |
| muddy or thin voice | eq | `equalizer` (cut ~250 Hz, presence +2 dB ~3–5 kHz) |
| uneven levels | compressor | `acompressor` (2.5–4:1) |
| loudness | master | `loudnorm` two-pass to the preset target, then `alimiter` |
| reverb | dereverb | Phase 2 (DeepFilterNet); Phase 1 = warn only |
| wind | highpass 120 Hz + denoise | limited; warn |

## Workflow
1. Read the analysis audio section. Name the problems in plain words.
2. Run `bve audio clean` with the preset from the plan (default `standard`). The engine only adds the processors whose problems were detected.
3. Run `bve audio preview --ab` on a representative 10 s range with speech over noise. Check the metrics:
   - speech-to-noise improved
   - the noise floor went down
   - no artifacts were flagged (the spectral-flatness heuristic)
4. If the voice sounds processed (the artifact flag, or a speech-to-noise gain > 25 dB with the rnn denoiser), step down the denoise strength or switch to `gentle`.
5. Report the result: "Noise floor −52 → −68 dBFS, hum 50 Hz removed, loudness normalized to −14 LUFS / −1 dBTP."

## Constraints
- Naturalness beats silence. Leave a little room tone and never gate speech hard.
- Denoise before compression. Compression raises the noise floor.
- Loudness normalization happens once, on the master mix, after music. Not per clip.
- Never process clipped audio louder. If clipping is detected, warn: it can be softened (`adeclip`) but not undone.

## Examples
- "Il y a un bruit de ventilation" → `hvac`/broadband in the profile → highpass 80 Hz + `afftdn` with a profile learned from the silences, then A/B.
- "Le son est trop faible" → Loudness only. The master handles it and no cleanup is needed.
- Outdoor interview with wind → highpass 120 Hz + moderate denoise. Tell the user wind removal is limited.

## Failure handling
- `arnndn` model missing → fall back to `afftdn` with a warning, and suggest `scripts/download-models`.
- No silence long enough to learn a noise profile → use the `afftdn` adaptive mode.
- A/B shows degradation → revert the processor (`--disable`) and explain the trade-off to the user.
