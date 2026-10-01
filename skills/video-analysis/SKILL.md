---
name: video-analysis
description: Analyze video sources in a brand-video-engine project - shots, scene changes, exposure, colors, faces, motion, silences, speech, loudness, noise, transcript. Use before any editing/planning decision, or when the user asks "what's in this video", "is the audio usable", "find the best moments".
---

# video-analysis

## Purpose
Produce `analysis/analysis.json` and `analysis/transcript.json`. These are **measured facts** that every later decision relies on. Then add the semantic layer, meaning what is actually in each shot, by looking at contact sheets yourself.

## Inputs
- A project with ingested sources (`bve ingest`).
- Optional: language hint for transcription.

## Outputs
- `analysis/analysis.json` (schema: `schemas/analysis.schema.json`)
- `analysis/transcript.json` (schema: `schemas/transcript.schema.json`)
- `analysis/keyframes/*.jpg`, `analysis/contact-sheets/*.jpg`

## Tools
- `bve analyze [--source <ids>] [--transcribe] [--language fr|en|auto] [--model small|medium|large-v3]` (default `small`; the model is downloaded once into ./models) — technical analysis (FFmpeg: scdet, signalstats, blackdetect, silencedetect, ebur128, astats) + transcription (faster-whisper, needs `uv sync --project engine/python`).
- `bve transcript import <file>` — use an existing word-level transcript instead (schemas/transcript.schema.json).
- `bve transcript show` — numbered segments with timecodes and filler counts.
- `bve analysis summary --json` — compact view that fits in context; prefer it over reading the whole file for long videos.
- `bve analysis annotate --file <annotations.json>` — merge your semantic labels (`[{sourceId, shotId, labels, notes, qualityScore}]`) into shots, marked `source: "claude"`.
- Read tool on `analysis/contact-sheets/*.jpg` and `analysis/keyframes/**` to see the footage.
- Planned (not yet available): face tracks, object/product detection models, hum detection.

## Workflow
1. Run `bve analyze --transcribe --json`. Transcription is the slowest step (roughly 0.1–0.5× real time on GPU and 1–2× on CPU). Tell the user if the video is long.
2. Run `bve analysis summary --json` and note the following:
   - resolution, fps and VFR status
   - shot count and durations
   - exposure problems
   - loudness, noise floor and noise profile
   - speech coverage
   - transcript language and confidence
3. Open the contact sheets. For each shot, write labels such as `talking-head`, `close-up`, `wide`, `product`, `logo`, `b-roll`, `person:<name if known>`, `text-on-screen` or `unusable`. Add short `notes` and a `qualityScore` guess where relevant (focus, framing, eye contact, energy).
4. Write the annotations file and run `bve analysis annotate`.
5. Report the essentials to the user in 3–6 bullets, especially problems: underexposed shots, noisy audio, hum, clipping, very long silences.

## Constraints
- The noise floor comes from a real silence when there is one, else from the quietest 100 ms windows (10th percentile). "Broadband" means an audible floor AND speech less than 30 dB above it. It cannot yet tell background music from noise: check the contact sheet/brief before letting audio-cleanup denoise a music bed.
- Whisper segments are not sentences (measured: every boundary mid-sentence on continuous speech). `bve transcript sentences` gives sentence and clause ranges built from the real punctuation.
- Transcription accuracy (measured, `docs/measurements/transcription-noise.md`): `small` ≈ 15 % WER on clean read French (mostly spelling: "sigale" for "cigale"); degradation stays small down to ≈5 dB SNR and becomes large below 0 dB; far below 0 dB Whisper can return nothing. The mean word probability barely moves with those errors: do not treat it as an accuracy score.
- Never put decisions (keep/cut) in analysis. Only facts and labels belong here.
- Label only what you can see. Mark uncertain labels with `confidence` < 0.6.
- Do not re-run transcription if `transcript.json` exists and the sources' sha256 values are unchanged. The engine caches it, so don't pass `--force` without a reason.

## Examples
- The analysis finds `noiseProfile: ["hum"]` with `humHz: 50`. Flag it for audio-cleanup.
- Shot `s004` has `exposure: "under"` and `luma.p95` = 0.41. Flag it for color-grading.
- The transcript contains many `filler: true` words. Mention that removing hesitations is possible.

## Failure handling
- `TOOL_MISSING` (ffmpeg or whisper): relay the `hint` install command.
- The language was detected with low confidence: re-run with an explicit `--language` after asking the user, or use the brief's language.
- There is no audio stream: skip transcription and tell the orchestrator that captions are unavailable.
- The file is very long (> 30 min): analyze proxies (the default). For the semantic pass, only annotate candidate shots from the summary.
