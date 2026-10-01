---
name: audio-cleanup
description: Clean and master dialogue audio (audio/audio.json) - detect and reduce background noise, HVAC/fan, street, wind, electrical hum, hiss, excessive reverb; apply voice EQ, de-essing, compression, gain, loudness normalization and limiting while keeping the voice natural. Use when audio sounds noisy, quiet, uneven, harsh, or before any export.
---

# audio-cleanup

## Purpose
Produce clear, natural and correctly loud dialogue. Processing is described as editable per-source chains, which are compiled to FFmpeg filters at render time.

## Inputs
- `analysis/analysis.json` → `audio` (noise floor, noiseProfile, humHz, clipping, LUFS, speech ranges, content segments, musicDetected)
- `project.json` targets (the loudness target comes from the preset)
- The `creative-plan.audio.cleanup` level, if a plan exists

## Outputs
The `dialogue[]` and `master` sections of `audio/audio.json` (schema: `schemas/audio.schema.json`), with before/after metrics.

## Tools
- `bve audio clean [--preset gentle|standard|aggressive|off] [--target <id>]` — builds each source's chain from the measured problems; the master loudness target comes from the target preset.
- Manual adjustment: `bve doc get audio`, edit a processor's `params` or set `"enabled": false`, `bve doc set audio <file>`.
- Verification: `bve qc --target <id>` measures the delivered loudness / true peak / A/V drift.
- Planned (not yet available): A/B preview snippets, dereverb (DeepFilterNet), automatic hum detection (a `humHz` you set in the analysis is honoured).
- `bve doc get <doc>` / `bve doc set <doc> <file.json>` — read, then write back a modified document (validated against its schema, versioned, undoable). Use it for any fine adjustment that has no dedicated command yet.

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
3. Render a draft (`bve render --target <id> --draft`) and run `bve qc --target <id> --draft` for loudness, true peak and drift. Check the following:
   - speech-to-noise improved
   - the noise floor went down
   - no artifacts were flagged (the spectral-flatness heuristic)
4. If the voice sounds processed (the artifact flag, or a speech-to-noise gain > 25 dB with the rnn denoiser), step down the denoise strength or switch to `gentle`.
5. Report the result: "Noise floor −52 → −68 dBFS, hum 50 Hz removed, loudness normalized to −14 LUFS / −1 dBTP."

## Constraints
- **Denoising is measured, never blind** (docs/measurements/denoise.md). `bve audio clean` estimates the SNR of each source and records the decision in `audio.json` → `dialogue[].denoise`:
  - `skip-clean` (≥ 22 dB): nothing to gain; neural denoise would only add artefacts.
  - `applied` (13–22 dB): RNNoise 70 % (or 40 %), kept only if the voice guard accepts it (voice level ≥ −1 dB, timbre change ≤ 0.3 dB, SNR gain ≥ 1 dB).
  - `skip-strong-noise` (< 13 dB): **left untouched on purpose** — every denoiser measured lowers intelligibility there (Whisper WER up to +27 points). Tell the user plainly; offer re-recording or a dedicated manual tool.
  - `rejected-all`: the guard refused every strength; report the reasons it lists.
  - `skip-music`: the analysis found music in the source (`musicDetected`). A denoiser removes a music bed as if it were noise, so nothing is applied. If the user also hears unwanted noise there, ask before doing anything manual.
- Never denoise audio before transcription: it raised the error rate in every noisy case measured.
- Read `denoise.summary` to the user rather than claiming the audio is "clean".
- Never denoise a music bed. The engine skips sources with `musicDetected`. It cannot see a bed that is only ever under continuous speech: then `content.speechBackgroundUnknown` is high and `denoise.summary` says "cannot be ruled out". In that case, or with `detector: "spectral-only"`, or if the user mentions music, ask before letting a denoise stand (set the processor `"enabled": false` if the user confirms music).
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
