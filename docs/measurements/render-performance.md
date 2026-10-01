# Render performance (chantier 6)

This document records two render optimisations, measured on the chantier-3 reference scenario. Neither one changes the delivered quality, the audio, the captions, the motion or any contract.

- **Scripts:**
  - `scripts/bench-render.ts`: 3 full renders per state, each on a fresh project (no stage cache);
  - `scripts/bench-remotion.ts`: the graphics stage in isolation;
  - `scripts/compare-renders.ts`: video and audio quality.
- **Raw data:** [render-performance.json](render-performance.json).

**Reference scenario:**

- the talking-head source, 3 clips;
- Instagram Reels 1080×1920 at 30 fps;
- 592 frames (19.7 s) at final quality;
- the Remotion renderer;
- the Maison Lune grade (curves + 2 × `colorbalance` + 2 × `eq`).

**Machine:** i5-8350U (4 cores, 8 threads), 8 GB RAM, Windows 11.

## Results

Times are medians of 3 runs, in seconds.

| Stage | Baseline | Lossless intermediates | **Final** (+ colour after crop) |
|---|---|---|---|
| base plate | 52.2 | 28.0 | **12.7** |
| graphics (Remotion capture + overlay pass) | 92.7 | 67.2 | **50.3** |
| audio | 3.0 | 3.3 | 2.9 |
| final encode | 35.1 | 39.8 * | **34.2** |
| **total (wall)** | **207.9** (182.5 / 207.9 / 219.0) | **137.9** (125.6 / 137.9 / 146.4) | **101.1** (93.2 / 101.1 / 104.4) |
| real-time factor | 0.095× | 0.143× | **0.195×** |

\* The final encode itself does not change. In an isolated replay it took 31–34 s from either input; the 39.8 s median is noise.

**Gain:** −106.8 s, **−51.4 %**. The rendering speed is ×2.06.

The chantier-3 profile measured 200.6 s (179.8–219.8 s), which is consistent with this baseline. Runs vary by about ±10 % on this laptop (thermal).

**Resources:**

| | Baseline | Final |
|---|---|---|
| Mean CPU | 84–85 % | 71–75 % |
| Peak Chrome memory | 2.6–2.9 GB | 2.5–2.8 GB |
| Peak FFmpeg memory | 0.84–0.89 GB | 0.74–0.75 GB |

## 1. Lossless intermediates (x264)

The base plate and the graphics overlay are intermediates: they are never delivered. Before, they were encoded with `medium` at crf 14 and crf 15. Only the delivery encode (`medium`, crf 18) compresses the output.

Replay of the base-plate pass with the logged arguments:

| x264 setting | Pass time | Next pass decode | Size |
|---|---|---|---|
| medium crf 14 (before) | 52.8 s | 2.4 s | 28 MB |
| **ultrafast qp 0 (lossless, chosen)** | **26.6 s** | 2.5 s | 221 MB |
| veryfast crf 14 | 31.3 s | 2.3 s | 26 MB |
| ultrafast crf 14 | 31.8 s | 1.6 s | 55 MB |

Lossless is the fastest setting, and it removes a compression generation. In the final render it is applied by `intermediateEncode` (`engine/rendering/src/basePlate.ts`) to the base plate, the Remotion overlay and the ASS overlay. Drafts are unchanged.

**Cost.** The render cache of one version grows from 47 MB to 424 MB, which is about 21 MB per second of 1080×1920 video. `bve clean` purges it.

## 2. Colour after the crop (base plate)

**Before.** The whole colour chain ran on the full source frame (1280×720), before the 9:16 crop (404×720). The chain was the colorimetry normalisation, the correction and the brand look (curves, 2 × `colorbalance`, 2 × `eq`). So it processed 3.2 times more pixels than were kept.

**Change.** Every one of these filters is per-pixel, so they commute exactly with a crop. They now run on the cropped window.

**Exception.** A crop with an odd offset would be rounded on subsampled YUV. In that case, and in `fit-blur` mode, the colour chain stays first.

**Result.** The base plate takes 28.0 s → 10.6–11.9 s, and **592/592 frames are bit-identical** to the previous output. No correction is skipped: `colorbalance` runs on fewer pixels.

## 3. Chrome / Remotion capture (measured, unchanged)

The graphics stage was run in isolation, 2 runs per setting:

| Setting | `renderFrames` | Peak Chrome memory | Result |
|---|---|---|---|
| 2 tabs | 39.7 / 39.6 s | 1.9 GB | |
| **4 tabs (kept)** | 33.7 / 32.3 s | 1.8–2.3 GB | |
| 6 tabs | 31.3 / 28.6 s | 2.6 GB | ≈ −3 s for ≈ +400 MB |
| 8 tabs | 39.2 / 29.6 s | 2.5–2.8 GB | |
| 4 tabs, GL `angle` (GPU) | 61.3 / 34.1 s | 2.0–2.2 GB | **different pixels on every frame** (PSNR 35 dB): rejected |

**Decision:** no change. Going from 4 to 6 tabs would save about 2 % of the render (noisy) and add about 400 MB on an 8 GB machine.

`BVE_REMOTION_GL` stays as a measurement instrument; unset, Remotion keeps its default.

## Quality

The reference ("ideal") is the lossless graphics intermediate taken through the same final colour step and encoded losslessly, with the same audio.

| | VMAF mean | SSIM | PSNR mean | Audio | Size |
|---|---|---|---|---|---|
| baseline (3 runs) | 96.19–96.39 | 0.9908–0.9916 | 49.8–50.1 dB | identical | 12.9–13.0 MB |
| final (3 runs) | **96.95–97.25** | **0.9922–0.9930** | **51.2–51.3 dB** | identical (sample by sample) | **11.75–11.82 MB** |

Other checks:

- **Frames and duration:** 592 frames and 19.733 s in every render.
- **Captions and motion:** these are in the picture. Per-frame PSNR finds no differing frame outside the end-card start (below).

## Pre-existing defect (not caused by this chantier)

The Remotion graphics are **not deterministic at the start of the end card**:

- frames 537–540 differ between two runs with the same settings (PSNR 35 dB);
- sometimes, frames 535–536 are rendered **without the end card** (PSNR 8 dB).

This happened in 2 of 3 baseline runs and in 1 of 3 final runs. Fixing it is outside a performance chantier.

## Not done

- **Delivery encode.** Still `medium` crf 18; changing it would change the delivered quality and size.
- **Merging the overlay pass into the final encode.** It would save a few seconds now that the overlay pass is lossless, but it would change the stage cache structure.
- **A 3D LUT for the grade.** It would be an approximation, so it was not done.
