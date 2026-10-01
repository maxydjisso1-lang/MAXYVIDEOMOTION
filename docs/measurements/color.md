# Colour pipeline (chantier 5): measurements and guard-rails

This document records the measurements behind the colour guard-rails.

- **Scripts:** `scripts/bench-color.ts`. The kit it shares with the real tests is `scripts/lib/color-cases.ts`.
- **Raw data:** [color.json](color.json).
- **Real tests:** `tests/real/color.test.ts`. They reproduce these numbers within 0.07 ΔE.

## Protocol

**Ground truth.** Ground truth is a set of real frames from the fixtures, decoded to RGB with a stated matrix:

- talking head: BT.601 tag, skin;
- interview: SD, untagged, skin;
- product: HD, untagged, black background.

**Degraded cases.** Degradations are applied to those frames **in linear light**:

- −1.5 / −2.5 EV;
- +1 EV, clipped;
- warm, cool and green casts;
- low contrast;
- mixed light (warm left, cool right);
- dark + warm.

The frames are then encoded as clean clips.

**Pipeline under test.** Each clip goes through the engine's real colour path: analysis (`frameStats` + luma histograms → `shotStats`) → `autoCorrection` → `clipColorFilters`. This runs inside a lossless replica of the two FFmpeg passes that touch colour:

- the base plate, `engine/rendering/src/basePlate.ts`;
- the final encode's `scale=out_color_matrix=bt709`, `engine/rendering/src/renderTarget.ts`.

The source-colorimetry test calls the real `renderBasePlate`.

**Validation without ground truth.** Six real videos (Wikimedia Commons, CC / public domain) were run as shot, to measure the *harm*:

- night interview;
- candle-light vigil;
- sunset;
- forest;
- indoor interview;
- cooking vlog.

**Metrics.**

| Metric | What it measures |
|---|---|
| CIEDE2000 | difference to the reference (all pixels / skin pixels) |
| Luma | BT.709 Y′ mean, 5–95 % spread |
| Lab cast | mean a\*/b\*, and the colour of the darkest 5 % of pixels |
| Skin | hue and chroma (YCbCr skin mask) |
| Clipping | crushed / clipped pixels (a channel at 0 / 255) |
| Posterisation | luma histogram holes |
| Time | duration of the base pass |

Throughout this document, "ΔE" means CIEDE2000.

## 1. Source colorimetry (no correction)

ΔE between the delivered render and the reference:

| Source | Before (engine as it was) | With an RGB filter in the chain | With normalisation to BT.709 at the base plate |
|---|---|---|---|
| BT.709, tagged | 0.15–0.67 | same | same |
| **BT.709, untagged (HD)** | **0.57–2.16** | same | **0.15–0.68** |
| BT.601, tagged | 0.49–1.33 | same | 0.29–0.66 |
| BT.709, full range | 0.15–0.71 | 0.62–1.04 | 0.40–0.93 |

**Cause.** The intermediate file loses the source's tag, and the final encode then assumes BT.601.

**Fix (wired).** The first filter of every clip is `scale=in_color_matrix=<source>:in_range=<source>:out_color_matrix=bt709:out_range=tv`.

- **Matrix:** the tag if there is one. Otherwise ≥ 720 lines means BT.709 and smaller means BT.601.
- **Range:** `colorRange` from the probe, then the `yuvj` pixel format, otherwise TV.

The final encode is unchanged.

**SD untagged.** The BT.601 convention is applied. A test clip that was BT.709-coded at SD therefore stays at 1.52 (this is expected).

## 2. Automatic correction: v1 (before) vs v2 (guard-rails)

### v1 defects

The v1 correction had three defects:

- The analysis "p05/p95" values are signalstats' **10th/90th** percentiles in **TV range**. The 0.6 contrast threshold therefore fired on almost every image.
- Exposure aimed at a mean of 0.46 with a plain gain. It brightened low-key scenes and clipped highlights, up to 16 % of pixels.
- Gray-world white balance cannot tell a scene's own colour from a cast. For example, interview as shot has R/B = 1.72, while talking head with a warm cast has R/B = 1.69.

### v2 rules

- **Statistics.** All statistics are converted to full range.
- **Brightening.**
  - Brighten only without highlights: the **98th** percentile must be < 0.65. This is a new analysis field, `luma.p98`, from Y-plane histograms. Without it, the 90th percentile must be < 0.5.
  - The gain is capped so that the 90th percentile stays ≤ 0.75, the 98th ≤ 0.92 and the mean ≤ 0.42.
  - The gain is applied by an exact `lutrgb` shoulder that never reaches clipped white. Both a plain gain and a `curves` spline clipped.
- **Darkening.** Darken only a washed-out shot: mean > 0.62 and 10th percentile > 0.25.
- **Contrast.** Contrast is added only if the 10–90 % spread is still < 0.4 *after* the exposure gain.
- **White balance.** It is **off by default**. The would-be gray-world gains are written in `reason`. `bve color auto --white-balance gray-world` keeps the old behaviour on request.

### Results on the degraded cases

Mean of the 3 sources:

| Case | ΔE before | v1 | **v2** | Skin ΔE (before / v1 / v2) | Clipped highlights (v1 / v2) |
|---|---|---|---|---|---|
| correct | 0.44 | 6.16 | **0.44** | 0.7 / 12.4 / 0.7 | 12 % / 0 % |
| −1.5 EV | 9.77 | 6.62 | **2.22** | 19.1 / 11.2 / 3.0 | 7 % / 0 % |
| −2.5 EV | 14.50 | 8.20 | **2.89** | 29.2 / 12.7 / 3.8 | 4 % / 0 % |
| dark + warm | 11.85 | 7.55 | **4.80** | 23.0 / 11.7 / 7.2 | 6 % / 0 % |
| low contrast | 12.00 | 12.25 | **9.83** | 9.4 / 10.3 / 8.6 | 0 / 0 |
| +1 EV (clipped) | 7.19 | 9.24 | 7.19 (left) | 14.0 / 17.2 / 14.0 | (in the source) |
| warm cast | 4.14 | 6.42 | 4.14 (reported, not applied) | 6.6 / 12.4 / 6.6 | |
| cool cast | 3.77 | 7.27 | 3.77 (reported) | | |
| green cast | 3.41 | 6.75 | 3.41 (reported) | | |
| mixed light | 1.94 | 6.44 | 1.94 (left) | 3.2 / 12.7 / 3.2 | |

## 3. Real footage as shot

The change is the ΔE between the render without and with the correction.

| Video | v1: change / clipped | v2 | v2 decision |
|---|---|---|---|
| talking head | 3.5 / 3 % | 0 | none (cast reported) |
| interview (low key) | 7.5 / 14 % | 0 | "dark but with highlights (98th percentile 0.87): low-key" |
| product (object on black) | 6.5 / 16 % | 0 | low-key |
| candle-light vigil | 6.7 / 15 % | 0 | low-key |
| forest (green on purpose) | 5.4 / 4 % (green neutralised) | 0 | cast reported |
| sunset | 0 | 0 | none |
| indoor interview | 4.6 / 5 % | 0 | cast reported |
| **night interview** | 7.5 / 1 % | luma 0.10 → 0.28, 0 % clipped | brightened 1.46 EV (98th percentile 0.33). Checked by eye: the face becomes readable. |
| cooking vlog (title card at 60 s) | 7.4 / 16 % | 1.5, 0 % clipped | low-key (98th percentile 0.69) + contrast +0.245 (known limit) |

## 4. Brand looks (intensity 0.6)

All looks are kept unchanged; these are creative decisions.

| Look | Skin hue | Shadows | Base-pass time |
|---|---|---|---|
| filmic | +2.6 to +3.8° | blacks lifted and teal-tinted (a\*/b\* ≈ −1/−2), intended | +1.1 to +3.8 s |
| warm / cool (`colorbalance`) | +0.4 to +1.2° / −3 to −4.3° | no crushing, also on a dark shot brightened by 2.5 EV | +0.8 to +2.9 s |
| **vibrant** | −3.2 to +0.2° | **crushes shadows**: pixels with a channel at 0 go ×2 to ×10 (1 % → 11 % on a talking head, 25 % → 50 % on a corrected dark shot) | +0.2 to +1 s |
| high-contrast | +1.7 to +2.8° | blacks to 0 | ≈ 0 |
| **muted** | **+7 to +9.2°** (desaturating turns the hue) | — | ≈ 0 |

**`colorbalance` on dark shots.** The "large gains on dark shots" problem came from the v1 exposure gain (`colorlevels` up to ×2.8, no protection), not from `colorbalance`. `colorbalance` does not crush shadows. Its cost is time: about ×2 on the base pass. This is left to a performance phase.

**Cost of the v2 correction.** +0.05 to +0.45 s per base pass (`lutrgb`, `eq`).

## Limits

- **Casts are no longer corrected automatically.** They are reported. A white-balance method that tells a cast from a scene's own colour (for example, near-neutral pixels) is future work.
- **Clipped overexposure cannot be recovered.**
- **Title card false "flat".** A mostly black frame with small text reads as "flat" and gets a little contrast (cooking-vlog title card, ΔE 1.5).
- **Low contrast is only partly restored** (12.0 → 9.8).
- **Small sample.** The degraded cases come from 3 sources, plus 6 real videos for validation. The 480p Commons derivatives are VP9 transcodes.
