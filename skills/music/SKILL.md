---
name: music
description: Add and control background music (audio/audio.json music section) - placement, volume, fades, automatic ducking under voice, beat/downbeat/drop detection, and syncing cuts and animations to the music. Use when the user provides or asks for music, wants the edit to follow the beat, or says music is too loud/quiet.
---

# music

## Purpose
Music is not just a layer added on top. It can **drive the rhythm** of the edit: cut points and motion accents snap to beats and drops, and the music ducks under the voice.

## Inputs
- A music asset in `assets/` (the user provides it; the license is recorded at ingest)
- `timeline/timeline.json`, `creative-plan.music`, `brand.audio.energy` and `musicMoods`

## Outputs
- The `audio.json` → `music[]` section (placement, gain, fades, ducking)
- `analysis/beats/<assetId>.json` (tempo, beats, downbeats, drops)
- `beat` / `drop` markers in the timeline

## Tools
- `bve music add <assetId> [--start 0] [--gain -14] [--fade-in 0.5 --fade-out 1.5]`
- `bve music duck --amount 12 [--attack 80 --release 400]` uses FFmpeg `sidechaincompress` keyed on the dialogue.
- `bve music beats <assetId>` runs beat, downbeat and drop detection (Phase 2: librosa. Phase 1: `bve music bpm --manual 120 --offset 0.35` as a manual grid).
- `bve edit snap-to-beats [--tolerance 0.15] [--sections-only]` nudges cut points to the nearest beats within the tolerance, without cutting words.
- `bve music fit --end-on-downbeat` trims or loops the music so that it ends musically on the last frame.

## Workflow
1. Check that a music asset exists and has a license note. Without one, ask the user for a track. Do not download music.
2. Run `bve music add` with gain around −14 to −20 dB under voice (the brand energy decides the level), then `bve music duck`.
3. If `syncCutsToBeats` is set: run `bve music beats`, then `bve edit snap-to-beats --sections-only` for a premium or calm style, or snap all cuts for a fast or aggressive style. Motion-brand then uses the `beat` markers for accents.
4. Run `bve music fit --end-on-downbeat` so the music ends on the outro.
5. Render a draft of the audio and check that the voice stays intelligible (the engine measures dialogue-to-music ratio in speech regions and targets ≥ 12 dB).

## Constraints
- Never use music without a known license. QC warns on a missing `license`.
- Beat snapping must never cut inside a word or push the duration outside the tolerance.
- Keep one music bed per section. Change tracks only at a section boundary with a crossfade.

## Examples
- "Ajoute cette musique et cale les coupes sur le rythme" → add, duck, beats, then snap-to-beats (all cuts, style fast), and add motion accents on downbeats.
- "La musique couvre la voix" → Raise the duck amount to 16 dB or lower the gain by 4 dB. Re-measure the ratio.

## Failure handling
- Unreliable beat detection (rubato, ambient): fall back to section-only snapping, or none, and say why.
- The track is shorter than the video: use `bve music fit --loop` on phrase boundaries, or ask for a longer track.
