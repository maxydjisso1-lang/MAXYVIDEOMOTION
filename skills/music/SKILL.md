---
name: music
description: Add and control background music (audio/audio.json music section) - placement, volume, fades, automatic ducking under voice, beat/downbeat/drop detection, and syncing cuts and animations to the music. Use when the user provides or asks for music, wants the edit to follow the beat, or says music is too loud/quiet.
---

# music

## Purpose
Music is not just a layer added on top. Today it ducks automatically under the voice and fades with the end card. In Phase 2 it will also **drive the rhythm** of the edit, with cut points and motion accents snapping to beats and drops.

## Inputs
- A music asset in `assets/` (the user provides it; the license is recorded at ingest)
- `timeline/timeline.json`, `creative-plan.music`, `brand.audio.energy` and `musicMoods`

## Outputs
- The `audio.json` → `music[]` section (placement, gain, fades, ducking)
- `analysis/beats/<assetId>.json` (tempo, beats, downbeats, drops)
- `beat` / `drop` markers in the timeline

## Tools
- `bve asset add <track> --kind music --license "<license>"` — register the track (license recorded).
- Add it to `audio.json` → `music[]` with `bve doc get audio` / `bve doc set audio <file>`: `{ assetId, timelineStart, gainDb, fadeInSec, fadeOutSec, ducking: { enabled, amountDb, attackMs, releaseMs } }`. The mix applies sidechain ducking under the dialogue and the fades.
- Planned (not yet available): beat/downbeat/drop detection, snapping cuts and motion to beats, fitting the track to the video length.
- `bve doc get <doc>` / `bve doc set <doc> <file.json>` — read, then write back a modified document (validated against its schema, versioned, undoable). Use it for any fine adjustment that has no dedicated command yet.

## Workflow
1. Check that a music asset exists and has a license note. Without one, ask the user for a track. Do not download music.
2. Add a `music[]` entry to audio.json (`bve doc get audio`, then `bve doc set audio <file>`). Use a gain around −14 to −20 dB under voice (the brand energy decides the level) and keep ducking enabled.
3. If `syncCutsToBeats` is set: beat detection and beat snapping are **planned for Phase 2**. Tell the user, and keep cuts on speech boundaries.
4. Set `timelineEnd` and `fadeOutSec` so the music ends with the end card.
5. Render a draft of the audio and check that the voice stays intelligible (the engine measures dialogue-to-music ratio in speech regions and targets ≥ 12 dB).

## Constraints
- Never use music without a known license. QC warns on a missing `license`.
- Beat snapping must never cut inside a word or push the duration outside the tolerance.
- Keep one music bed per section. Change tracks only at a section boundary with a crossfade.

## Examples
- "Ajoute cette musique et cale les coupes sur le rythme" → register the asset, add the music entry with ducking, and explain that beat-synced cuts arrive in Phase 2.
- "La musique couvre la voix" → Raise the duck amount to 16 dB or lower the gain by 4 dB. Re-measure the ratio.

## Failure handling
- Unreliable beat detection (rubato, ambient): fall back to section-only snapping, or none, and say why.
- The track is shorter than the video: ask for a longer track, or end the music early with a fade-out before the end card.
