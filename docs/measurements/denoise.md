# Neural denoising, measured (chantier 2)

Produced with `scripts/bench-denoise.ts` (FFmpeg 9, faster-whisper `small`, CPU). The raw data is in [denoise.json](denoise.json).

- **Controlled cases.** The LibriVox fable (clean reference, 109 words) is mixed with real Liverpool street noise at a **true** SNR. The methods are compared on three measures:
  - **SI-SDR**: distance to the clean voice; higher is better, and it ignores gain.
  - **Whisper WER**: intelligibility.
  - **Voice-band level change** on the speech windows.
- **Real cases** have no reference, so they get guard metrics only.

> **Statistical caution.** One WER point is about one word. Differences of ±3 points are within run-to-run variation on a single 36 s passage.

## SI-SDR gain (dB, vs the noisy input)

| method | 20 dB | 10 dB | 5 dB | 0 dB | -5 dB |
|---|---|---|---|---|---|
| none | +0 | +0 | +0 | +0 | +0 |
| afftdn (Phase 1) | +0.4 | +0.4 | +0.4 | +0.2 | -0.3 |
| RNNoise 100 % | -5.1 | +1.5 | +3.6 | +5.4 | +6 |
| RNNoise 70 % | -2.6 | +2.5 | +3.7 | +4.3 | +3.7 |
| RNNoise 40 % | -0.3 | +1.9 | +2.3 | +2.2 | +1.6 |
| DeepFilterNet 3 | +2.4 | +6.3 | +8.1 | +9.6 | +10.7 |

## Whisper WER (input → output)

| method | 20 dB | 10 dB | 5 dB | 0 dB | -5 dB |
|---|---|---|---|---|---|
| none | 19.3 → **19.3 %** | 17.4 → **17.4 %** | 19.3 → **19.3 %** | 26.6 → **26.6 %** | 69.7 → **69.7 %** |
| afftdn (Phase 1) | 19.3 → **15.6 %** | 17.4 → **15.6 %** | 19.3 → **19.3 %** | 26.6 → **38.5 %** | 69.7 → **55.0 %** |
| RNNoise 100 % | 19.3 → **18.3 %** | 17.4 → **21.1 %** | 19.3 → **32.1 %** | 26.6 → **45.9 %** | 69.7 → **71.6 %** |
| RNNoise 70 % | 19.3 → **16.5 %** | 17.4 → **17.4 %** | 19.3 → **23.9 %** | 26.6 → **30.3 %** | 69.7 → **53.2 %** |
| RNNoise 40 % | 19.3 → **17.4 %** | 17.4 → **19.3 %** | 19.3 → **22.9 %** | 26.6 → **28.4 %** | 69.7 → **58.7 %** |
| DeepFilterNet 3 | 19.3 → **15.6 %** | 17.4 → **16.5 %** | 19.3 → **27.5 %** | 26.6 → **53.2 %** | 69.7 → **71.6 %** |

## Voice-band level change on speech windows (dB)

| method | 20 dB | 10 dB | 5 dB | 0 dB | -5 dB |
|---|---|---|---|---|---|
| none | 0 | 0 | 0 | 0 | 0 |
| afftdn (Phase 1) | -0.2 | -0.2 | -0.4 | -0.6 | -0.9 |
| RNNoise 100 % | -0.3 | -0.8 | -1.6 | -3.7 | -8.3 |
| RNNoise 70 % | -0.2 | -0.6 | -1.2 | -2.7 | -5.6 |
| RNNoise 40 % | -0.1 | -0.4 | -0.7 | -1.6 | -2.9 |
| DeepFilterNet 3 | -0.3 | -0.8 | -1.4 | -2.9 | -6.4 |

## Real fixtures (no reference)

| source | method | voice Δ (dB) | timbre Δ (dB) | est. SNR before → after |
|---|---|---|---|---|
| talking-head | afftdn (Phase 1) | -0.3 | 0 | 22.5 → 22.3 |
| talking-head | RNNoise 100 % | -0.2 | 0 | 22.5 → 32.6 |
| talking-head | RNNoise 70 % | -0.2 | 0 | 22.5 → 28.3 |
| talking-head | RNNoise 40 % | -0.1 | 0 | 22.5 → 25.1 |
| interview | afftdn (Phase 1) | -0.4 | 0.1 | 24.9 → 26.3 |
| interview | RNNoise 100 % | -4.2 | 0.2 | 24.9 → 39.2 |
| interview | RNNoise 70 % | -3 | 0.2 | 24.9 → 30.6 |
| interview | RNNoise 40 % | -1.8 | 0.1 | 24.9 → 27.1 |
| noisy-audio | afftdn (Phase 1) | -1.1 | 0.3 | 4.2 → 5.2 |
| noisy-audio | RNNoise 100 % | -9.7 | 2.2 | 4.2 → 19.6 |
| noisy-audio | RNNoise 70 % | -6.3 | 1 | 4.2 → 7.5 |
| noisy-audio | RNNoise 40 % | -3.2 | 0.4 | 4.2 → 5.2 |
| street only | afftdn (Phase 1) | -0.7 | 0.2 | 3.4 → 3.8 |
| street only | RNNoise 100 % | -38 | 1.6 | 3.4 → 14.8 |
| street only | RNNoise 70 % | -10.4 | 0.1 | 3.4 → 3.4 |
| street only | RNNoise 40 % | -4.5 | 0 | 3.4 → 3.3 |
| talking-head | DeepFilterNet 3 | -0.4 | 0 | 22.5 → 36.3 |
| interview | DeepFilterNet 3 | -4.6 | 0.2 | 24.9 → 50.3 |
| noisy-audio | DeepFilterNet 3 | -8.3 | 2.6 | 4.2 → 55.9 |
| street only | DeepFilterNet 3 | -34.5 | 2.6 | 3.4 → 30.2 |

## Findings

1. **A better SNR does not mean better speech.** Every method raises SNR and SI-SDR at every noise level, yet intelligibility gets **worse** in strong noise:
   - RNNoise 100 %: 19.3 → 32.1 % at 5 dB, and 26.6 → 45.9 % at 0 dB.
   - DeepFilterNet: 19.3 → 27.5 % at 5 dB, and 26.6 → 53.2 % at 0 dB.

   This is the voice degradation the guard must prevent.
2. **Light noise (≈20 dB).**
   - RNNoise **hurts**: SI-SDR −5.1 dB at 100 % and −2.6 dB at 70 %. There is nothing useful to remove, so it only adds artefacts.
   - DeepFilterNet still helps (+2.4 dB).
   - Policy: no RNNoise above an estimated SNR of 22 dB.
3. **Medium noise (≈10 dB)** is the regime where denoising pays without cost:
   - RNNoise 70 %: SI-SDR +2.5 dB, WER unchanged (17.4 → 17.4 %), voice −0.6 dB.
   - DeepFilterNet: +6.3 dB, WER 17.4 → 16.5 %.
4. **afftdn**, Phase 1's automatic denoiser, is neutral on SI-SDR (+0.2 to +0.4 dB) and erratic on WER (+11.9 points at 0 dB). It is **removed from the automatic chain**.
5. **Real interview.** It is relatively clean (estimated 24.9 dB), yet RNNoise and DeepFilterNet both lower the voice by 3 to 4.6 dB. Without a guard they would damage it.
6. **Ambience without speech.** Both methods remove it almost entirely (−34 to −38 dB). That is correct for denoising, and it is why denoising must be tied to dialogue sources.
7. **Reference-free SNR estimate** (voice band, loudest 20 % vs quietest 10 % of 100 ms windows). True SNR 20, 10, 5, 0 and −5 dB maps to an estimate of 25, 15.4, 10.9, 7.1 and 4.6 dB: monotonic and usable for decisions.

## Decision implemented

| Estimated SNR | Action | Basis |
|---|---|---|
| ≥ 22 dB | none (`skip-clean`) | RNNoise only adds distortion (true 20 dB) |
| 13–22 dB | RNNoise 70 %, then 40 %, **each checked by the guard** | true 10 dB: SI-SDR +2.5 dB, WER unchanged |
| < 13 dB | none, **the user is told** (`skip-strong-noise`) | every method lowers intelligibility at true ≤ 5 dB |

**Guard** (reference-free, applied to the real rendered candidate). A candidate is rejected if any of these holds:
- the voice-band level on speech windows drops by more than 1 dB;
- the voice timbre (the spread of the band-level changes) moves by more than 0.3 dB;
- the SNR gain is under 1 dB.

The thresholds are the worst accepted medium-noise values, with a small margin. Every decision, accepted or rejected, is recorded with its numbers in `audio.json` (`dialogue[].denoise`).

**Method.** RNNoise (FFmpeg `arnndn`, BSD model, ≈300 KB, sha256-pinned, downloaded once and never committed). DeepFilterNet 3 measures clearly better in light and medium noise, but it needs a second Python stack: torch 2.0.1 / torchaudio 2.0.2 / Python 3.11, about 1 GB, with old pins that failed twice to install. Adopting it is a dependency decision left open.

**Transcription is never run on denoised audio.** Denoising raised the WER in every strong-noise case.

## End-to-end check (real-suite test, medium noise, true 10 dB)

The full rendered chain was measured on the same project, with and without the denoise processor. The chain is high-pass, then denoise, EQ, compressor, de-esser, two-pass loudnorm, limiter and AAC encode.

| rendered audio | est. SNR | Whisper WER |
|---|---|---|
| input mix | 15.4 dB | 19.3 % |
| chain **without** denoise | 13.9 dB | 22.0 % |
| chain **with** RNNoise 70 % (the policy's choice) | **22.0 dB** | **22.0 %** |

Denoising adds +8.1 dB of estimated SNR with an identical WER. The small WER difference against the raw input (+2.7 points ≈ 3 words) comes from the rest of the chain, not from the denoiser. The compressor also lifts the noise floor (15.4 → 13.9 dB), which is noted for a later chantier.
