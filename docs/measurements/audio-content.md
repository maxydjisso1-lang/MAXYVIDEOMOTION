# Speech / music / noise / silence detection (chantier 4)

**Goal:** stop the engine from treating a music bed as noise to remove.

Produced with `scripts/bench-content.ts`. The corpus is [audio-content-corpus.json](../../tests/fixtures/real/reference/audio-content-corpus.json), and the raw numbers are in [audio-content.json](audio-content.json).

## Method (shipped)

The detector works per 1 s window, with a 0.5 s hop, on the engine's 16 kHz mono decode (`engine/audio/src/content.ts`).

1. **Speech.** Silero VAD gives a speech probability every 32 ms. This is the model already shipped inside faster-whisper, called through the existing Python sidecar (`bve_py.vad`), so there is no new package. A window counts as speech when at least 30 % of it is speech.
2. **Background.** The background is read only on frames that are confidently *not* speech: VAD probability below 0.15, at least 200 ms from any speech, within a 3 s context. Frames whose level is under −55 dBFS count as silence. Otherwise the background is classified as follows:
   - **Music by held notes.** Spectral partials last at least 0.3 s and cover at least 60 % of the background frames. They carry at least 10 % of its 80–5000 Hz energy. And either notes start at a rate of at least 4 per second, or at least 1.5 per second over a peaky spectrum (flatness ≤ 0.05; this catches pads and sustained chords).
   - **Music by beat.** The onset envelope (spectral flux in 16 bands) is periodic, with a normalised autocorrelation of at least 0.4 at lags of 0.25–1 s (60–240 BPM, over a 6 s context). At least 15 % of the energy is below 200 Hz (kick drum and bass). The onset strength must be real, at least 0.5; every real recording measured is at least 1.0, while an exact synthetic hum is 0.24.
   - **Noise.** Anything else.
   - **Stationary tones.** A frequency that holds a peak in at least 90 % of the background frames is a stationary tone (hum, fan, engine) and is removed from note tracking.
3. **Not enough background.** When a window has under 1 s of background, or its beat cannot be measured, it takes the nearest decided background within 10 s; a music bed does not stop. If nothing is found, the window is speech with an **unmeasured background**.
4. **Outputs.** The labels are `silence`, `noise`, `music`, `speech`, `speech+noise` and `speech+music`. Segments shorter than 1 s are absorbed by their neighbour. The analysis also records:
   - `shares`;
   - `speechBackgroundUnknown`;
   - `musicDetected`, which is true when music covers at least 20 % of the non-silent duration.
5. **Engine decisions.**
   - When `musicDetected` is true, `bve audio clean` records `denoise.decision = "skip-music"` and applies nothing.
   - The chantier 2 policy is unchanged otherwise. When the background is unmeasured on at least 50 % of the source, the denoise summary says that music cannot be ruled out.
   - "Broadband" noise is no longer reported when the floor is music.
6. **Fallback without the sidecar.** The same spectral background rules run, but speech is decided by level dynamics. This path is marked `detector: "spectral-only"` and is measured below.

**Cost.** About 1.5–3.5 s per source for the VAD (mostly starting Python), plus about 20 ms per second of audio for the features (measured on 30 s and 71 s sources).

## Corpus and protocol

- **Real recordings, all CC / public domain.**
  - 23 music sources: classical, acoustic, orchestral, electronic, hip-hop, drum & bass, funk, rock, techno.
  - 3 sung pieces (hard cases).
  - 26 noise sources: street, rain, restaurant, ventilation, fan, air conditioning, wind, sea, birds, applause, typing, train, clocks.
  - 6 speech excerpts from 5 speakers (French and English, read speech, talking head, interview).
- **Synthetic cases.** Digital silence, room tone at −65 dBFS, pink and brown noise, and a 50 Hz mains hum.
- **Mixes.** Each background is normalised to −23 LUFS, then the speech is laid over it with the background at the following levels below the voice:
  - music beds: 6, 12 and 18 dB;
  - noise: 5, 10 and 20 dB.

  There are two layouts:
  - **Standard:** background alone for 0–6 s, speech from 6 to 24 s, background alone for 24–30 s.
  - **Continuous:** the voice covers the whole 18 s clip, so the background is never heard alone.
- **Ground truth.** Truth is defined per window. The background class comes from the corpus. Speech presence comes from the clean speech track's own activity; windows with 5–25 % activity are not scored.
- **Splits.**
  - **dev:** the only cases used to choose thresholds.
  - **test:** measured once with the rules frozen. It was then *seen*, see the history below.
  - **test2:** fresh, never looked at before its single measurement (beat music and trap noises).
- **Methods compared.**
  - **before:** the engine before chantier 4. Every non-silent stretch is "speech" and music is never detected.
  - **vad:** the shipped method.
  - **dsp:** the fallback without the sidecar.

### History (nothing hidden)

1. **Rules v1 were frozen on dev; test run 1 found three problems.**
   - Electronic beat music was missed: it has no held notes.
   - One speech excerpt was a corpus error: its span ran past the end of the file.
   - `rain-drops` read as music. Its spectrogram shows pitched harmonic stacks; it is still counted as noise, as labelled beforehand.

   Source-level music detection on that first run: precision 0.79, recall 0.80.
2. **Fixes, chosen on dev only.**
   - Electronic music, more beat music and periodic noises (two clocks, a train) were added to dev.
   - The beat cue was added. Background frames now exclude anything the VAD finds possibly voiced. Stationary tones are detected by frequency occupancy.
   - The corpus error was fixed.
   - test2 was then measured once.
3. **After test2.**
   - The exact synthetic mains hum (seen split) turned out to produce a spurious perfect periodicity. The onset-strength guard was added; it changes nothing on any real recording.
   - The continuous layout was added afterwards. It exposed the main limit, and no tuning followed it.

## Results: shipped method (`vad`)

Window figures are precision/recall per window; source figures count sources whose `musicDetected` decision is right.

| Case (test2 = fresh) | Speech P/R | Music P/R (windows) | Noise P/R (windows) | Music, source level |
|---|---|---|---|---|
| Music alone (8) | — | 1.00 / 0.98 | — | **8/8 detected** |
| Noise alone (6) | — | FP: 56 windows, all from the clock | 1.00 / 0.84 | **5/6 correct** (clock read as beat music) |
| Speech alone (2) | 1.00 / 0.94 | 0 FP | — | 2/2 correct |
| Speech + music, standard layout (48) | 0.99 / 0.96 | 1.00 / 0.97 | — | **48/48 detected** |
| Speech + noise, standard layout (36) | 1.00 / 0.96 | FP only from clock mixes | 1.00 / 0.87 | **30/36 correct** (6 clock mixes) |
| **Speech + music, continuous (48)** | 1.00 / 0.97 | — / **0.00** | — | **0/48 detected**; 48/48 flagged `speechBackgroundUnknown ≥ 0.5` |
| Speech + noise, continuous (36) | 1.00 / 0.98 | 0 FP | 1.00 / 0.09 | 36/36 correct (no music); 36/36 flagged |

**Other splits.**

| Split | Speech + music (standard) | Speech + music (continuous) | Source-level music false positives |
|---|---|---|---|
| dev | 42/42 detected | 1/42 detected | 8: alarm clock and its mixes (7), one wall-clock mix |
| test (seen) | 36/36 detected | 0/36 detected | 10: `rain-drops` and its mixes |

**Silence and synthetic cases (test).**
- Digital silence and −65 dBFS room tone: 100 % silence.
- Pink and brown noise: 100 % noise.
- Mains hum: 100 % noise.

**Singing (test, 3 cases).**
- All 3 are detected as music at source level.
- Per window, music recall is only 0.43. Singing is often read as speech (38 windows) or as noise.

**Before chantier 4 (`before`, test2).**
- Music: source recall 0.00.
- Speech: per-window precision 0.52, because every noise or music window was called speech.

**Fallback without the sidecar (`dsp`, test2).**
- Speech: precision 0.72, recall 0.94.
- Music at source level: precision 1.00, recall 0.88 in the standard layout.

The fallback is degraded but errs on the safe side, and the analysis summary names it.

## Limits

1. **A music bed heard only under continuous speech is not detected** (0/48 on test2, 0/36 on test, 1/42 on dev). The background is read in the pauses, and a fast continuous voice leaves none, so the method cannot see a quiet bed under it. Two other approaches were tried on dev and rejected:
   - **Cues measured during the speech:** long partials, low-band periodicity and high-band partials. The voice's own harmonics also last 0.6 s or more, and the low-band beat survives only under a male read voice.
   - **The RNNoise residual used as a background probe:** a +6 dB bed is often detected, but a +12/+18 dB bed rarely, and it adds a new false positive on a real noise (ventilation).

   What ships instead: the source is flagged with `speechBackgroundUnknown`, the denoise summary says "music cannot be ruled out", and the skills tell Claude to ask. The flag says only that the background could not be measured; it also covers noise under continuous speech, so it is not a music detector.

   **Fix path:** an AudioSet-trained tagger such as YAMNet or EfficientAT. That is a new model and possibly a new dependency, so it is a user decision, like DeepFilterNet.
2. **The bed must be heard alone near the speech.** In the standard layout, music heard alone within 10 s of the speech is enough. A long voice-over with only a short intro can fall under the 20 % source rule; this was not measured beyond 18 s of speech.
3. **Periodic mechanical noise can read as beat music** when it has low-frequency weight: ticking clocks (dev alarm clock, test2 clock). This errs on the safe side, since the source is then not denoised. A wall clock with no bass was not affected.
4. **Pitched sound design** (`rain-drops`) reads as music.
5. **Singing** is often labelled speech per window; source-level detection held on 3 of 3 cases (a small sample).
6. **A very slow pad** (chords held for 2 s, no rhythm) reads as noise between chord changes. The source decision held in the unit test.
7. **Crowd babble** is labelled speech by the VAD (restaurant). This does no harm to the decisions.
8. **Corpus.** The mixes are digital sums of real recordings: no room acoustics shared between voice and music, no mastering, 5 speakers. Backgrounds are level-normalised, and a bed quieter than −55 dBFS reads as silence.
