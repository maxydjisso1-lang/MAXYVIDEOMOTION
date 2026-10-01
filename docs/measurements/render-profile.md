# Render profile (chantier 3) — measurements only, no optimisation

Produced with `scripts/profile-render.ts` and `scripts/profile-ffmpeg.ts`. Raw data: [render-profile.json](render-profile.json).

## Reference scenario (frozen)

[`tests/fixtures/real/reference/render-profile-scenario.json`](../../tests/fixtures/real/reference/render-profile-scenario.json):
- **Source:** the real talking-head fixture, 1280×720 at 25 fps (CC BY-SA 4.0).
- **Transcript:** the reference transcript is imported, so Whisper does not run.
- **Brand:** Maison Lune (filmic grade, line/fade motion).
- **Output:** Instagram Reels **final quality**, 1080×1920 at 30 fps, with the Remotion renderer.
- **Content:** captions, a hook title, brand transitions, a CTA, a watermark and an end card.
- **Edit:** 3 clips, **19.7 s, 592 frames**.

Every run builds a fresh project, so no stage cache is reused.

**Machine:**
- Intel Core i5-8350U: 4 cores / 8 threads, 1.7 GHz, laptop.
- 8 GB RAM.
- Windows 11, FFmpeg 9.0.2, Remotion 4.0.530, Node 25.

## Baseline: three runs

| run | total | base plate | graphics | audio | final encode |
|---|---|---|---|---|---|
| 1 | 179.8 s | 51.2 s | 88.1 s | 3.4 s | 35.3 s |
| 2 | 200.6 s | 68.2 s | 88.2 s | 3.5 s | 37.5 s |
| 3 | 219.8 s | 61.1 s | 108.3 s | 3.8 s | 44.1 s |
| **median** | **200.6 s** | **61.1 s (30 %)** | **88.2 s (44 %)** | **3.5 s (2 %)** | **37.5 s (19 %)** |

- **Effective speed:** 592 frames / 200.6 s = **2.95 frames per second of wall time**, or 0.10× real time.
- **Run-to-run spread is ±10 %.** The CPU sits at 100 % for most of the render (thermal throttling on a laptop). Compare future measurements on the median of several runs, on the same machine.

## Where the time goes (median run)

```text
200.6 s total
├─ base plate (FFmpeg)                     61 s
│   ├─ decode + trim + fps                  ~1 s
│   ├─ colour filters (21 for 3 clips)     ~24 s   ← colorbalance alone ≈ 20 s
│   └─ libx264 medium, CRF 14               ~27 s
├─ graphics                                88 s
│   ├─ browser start + composition          5–9 s  (fixed per render)
│   ├─ Remotion frame rendering (4 tabs)   36 s    (592 frames → 16.6 fps)
│   │    per frame ≈ 230 ms per tab: seek 3 ms (p50) · screenshot + PNG write ≈ 97 %
│   └─ overlay pass (FFmpeg)               40–47 s (PNG decode + overlay + libx264 medium CRF 15)
├─ audio mix + 2-pass loudnorm              3.5 s
└─ final encode (FFmpeg)                   37.5 s
    ├─ decode + range conversion            ~3.6 s
    └─ libx264 medium, CRF 18               ~31 s
```

**Total by kind of work:**

| Work | Approx. time | Share |
|---|---|---|
| Software H.264 encoding, three passes in series (≈27 + ≈35 + ≈31 s) | **≈ 90–100 s** | ≈ half |
| Chrome frame capture | ≈ 36 s | 18 % |
| Colour filters | ≈ 24 s | 12 % |
| Fixed browser start | 5–9 s | — |
| Audio | 3.5 s | 2 % |

## Component isolation (graphics stage only, same base plate)

| composition | frame rendering | mean ms/frame/tab | overlay pass |
|---|---|---|---|
| empty (no motion, no captions) | 28.1 s | 181.5 | 41.2 s |
| captions only | 29.0 s | 188.5 | 41.0 s |
| motion only | 28.9 s | 188.9 | 43.7 s |
| full | 31.8 s | 206.5 | 40.5 s |

- **The content (captions, titles, transitions, CTA, end card) adds only ≈ 12 %** to frame rendering.
- **About 88 % is the fixed cost of capturing a 1080×1920 transparent frame.**
- **The overlay pass costs the same whatever the content.**

**Per-frame time by what is on screen** (baseline run, 4 tabs):

| on screen | frames | mean ms |
|---|---|---|
| watermark only | 28 | 188 |
| captions | 229 | 217 |
| CTA + captions | 90 | 232 |
| end card | 78 | 233 |
| title + captions | 86 | 244 |
| transition + captions | 66 | 249 |

- The first 4 frames take 860 ms each. That is the cold start of each tab: page load and font loading through `delayRender`.

## Concurrency (Remotion tabs, full composition)

| tabs | frame rendering | ms/frame/tab | overlay pass |
|---|---|---|---|
| 1 | 56.1 s | 93 | 42.3 s |
| 2 | 38.6 s | 127 | 40.5 s |
| **4 (current)** | 32.4 s | 212 | 40.3 s |
| 8 | 29.3 s | 370 | 39.8 s |

- Beyond 2 tabs, scaling is poor because the machine is CPU-bound: each tab gets slower.

## Screenshot format (same composition, diagnostic only)

| format | frame rendering | mean frame size |
|---|---|---|
| PNG (required: transparency) | 30.5 s | 109 KB |
| JPEG (no alpha, unusable for compositing) | 27.4 s | 29 KB |

- **Image encoding accounts for ≈ 10 %** of frame rendering. The rest is Chrome's software compositing and capture.

## CPU / GPU / memory

| stage | CPU (mean) | GPU 3D | peak memory |
|---|---|---|---|
| base plate | 98.5 % | ≈ 0 % | ffmpeg 562 MB, Chrome 1.66 GB (idle tabs from an earlier run) |
| graphics | 73.4 % | ≈ 0 % | **Chrome 2.2–2.6 GB**, ffmpeg 893 MB |
| audio | 100 % | ≈ 0 % | ffmpeg 855 MB |
| final encode | 92.7 % | ≈ 0 % | ffmpeg 756 MB |

- **The GPU is unused** (0–3 %). Remotion opens Chrome Headless Shell without an explicit GL flag (`gl = undefined`), and FFmpeg encodes with libx264 in software.
- **Memory is not a bottleneck,** but it is close to the limit of an 8 GB machine during the graphics stage.

## Other checks

- **Repeated JavaScript work.** All layout maths for every frame (safe zones, text fitting, obstacle avoidance) costs **0.11 ms per frame** in Node: negligible.
- **Unnecessary re-renders.** Frames with content cost at most 30 % more than frames with only the watermark, which shows no sign of a re-render storm. Normal re-renders also reuse unchanged stages from the cache, but these profile runs deliberately did not.
- **Preview (draft) vs export (final).** The draft takes **55 s** versus about 200 s: base plate 26 s, graphics 22.6 s (frame rendering 17.2 s at 540×960), audio 2.9 s, final encode 3.3 s (veryfast). In the draft, colour filtering at source resolution still dominates the base plate.

## Main bottleneck

The cost is **CPU-bound software video processing**, not the Remotion animation code:
1. **Three full-quality software H.264 encodes in series** (base → overlay → final). Together they take about half of the render.
2. **Chrome's software frame capture** of 1080×1920 transparent PNGs, which takes 18 % with 4 tabs. The content of the frames is a minor factor (≈ 12 % of that).
3. **The `colorbalance` filter** of the brand grade: about 20 s for 3 clips.

No optimisation has been made. The measures above are what any future change must be compared against: same scenario, median of three runs, same machine.
