# Transcription vs real street noise (chantier 1)

Generated with `scripts/bench-transcription.ts` (faster-whisper, CPU, int8), raw data in [transcription-noise.json](transcription-noise.json).

- **Reference:** La Fontaine, *La Cigale et la Fourmi* (109 words, public domain), read by a LibriVox volunteer (`speech-fr` fixture, span 24.8–61.2 s).
- **Noise:** real Liverpool street ambience (`street-noise` fixture), looped.
- **SNR** = RMS of the speech span (-34.4 dBFS) − RMS of the scaled noise, both over their whole duration. Pauses count in the speech RMS, so this is a conservative "overall" SNR.
- **WER** normalisation: case, punctuation, apostrophes and hyphens only. Spelling and accents still count.

## Word error rate

| setting | clean | 30 dB | 20 dB | 15 dB | 10 dB | 5 dB | 0 dB | -5 dB | -10 dB | -13 dB |
|---|---|---|---|---|---|---|---|---|---|---|
| small, VAD on | 14.7 % | 16.5 % | 19.3 % | 17.4 % | 17.4 % | 19.3 % | 26.6 % | 69.7 % | 100.0 % (0 seg.) | 100.0 % (0 seg.) |
| small, VAD off | 15.6 % | 16.5 % | 19.3 % | 17.4 % | 16.5 % | 22.0 % | 30.3 % | — | — | — |
| medium, VAD on | 9.2 % | — | — | — | 10.1 % | 14.7 % | 32.1 % | 67.0 % | 100.0 % (0 seg.) | 100.0 % (0 seg.) |

## Findings

1. **Even clean speech is not error-free.** `small` makes 14.7 % errors on clean read French, mostly confident misspellings ("sigale" for "cigale", "bice" for "bise", "dépourvu" for "dépourvue"). `medium` halves the errors on clean and lightly noisy speech (9.2 % clean, 10.1 % at 10 dB), at 3–4× the CPU time (≈100 s for 36 s of audio, versus ≈25 s for `small`).
2. **Street noise costs little down to ≈5 dB.** At 10 dB, `small` goes from 14.7 % to 17.4 %. The collapse starts at 0 dB, where `medium` is **not** better than `small` (32.1 % vs 26.6 %), and reaches about 70 % errors at −5 dB for both models.
3. **Silent failure below ≈ −10 dB.** Both models return **zero segments**, which is 100 % errors, with no error raised. This is the "0 segments" case observed in Phase 1. That fixture was mixed at ≈ −13 dB and not ≈0 dB as first estimated, because the analysis "noise floor vs loudness" figure is not a true SNR.
4. **Confidence is not accuracy.** The mean word probability stays between 0.74 and 0.89 whether the error rate is 9 % or 70 %. It must not be presented as a quality score. Low-probability words are only a starting point for proofreading.
5. **The VAD filter makes no measurable difference**, on or off, between clean and 0 dB.

## Segment boundaries (real transcripts, `scripts/analyze-segmentation.ts`)

| source | boundaries mid-sentence |
|---|---|
| talking head (fast, continuous speech) | **5 / 5** |
| LibriVox reading | 2 / 16 (one false positive: a lone closing quote) |
| interview | 0 / 9 |
| speech over noise | 0 / 7 |

Whisper segments are time windows. On continuous speech a plan built from segments keeps **2 partial sentences** on the real talking head. The same plan built from `bve transcript sentences` ranges keeps **0** (real-suite test).

## What changed in the engine (chantier 1)

- **Measurement, not heuristics.** `runWhisper` is the single path to Whisper. `--no-vad` and the per-segment `avg_logprob` and `no_speech_prob` are exposed for diagnostics.
- **`bve transcript sentences`.** Sentences and clauses are rebuilt from Whisper's own words and punctuation, as exact `{sourceId, start, end}` ranges. Unpunctuated runs stay whole and are flagged `unterminated`, and low-probability words are listed.
- **The transcription report in `bve analyze --transcribe`.** It gives the word count, words per minute over the non-silent audio, and an explicit **warning** when non-silent audio produced no words or very few.
- **Token fixes.** Tokenisation artefacts are merged: apostrophes, trailing punctuation and French inversion hyphens ("Qu'est -ce" → "Qu'est-ce").

Not done here, on purpose: denoising before transcription (chantier 2, to be measured with this same benchmark) and any change of the default model. `small` stays the default for speed, and `--model medium` is recommended for final captions.
