# Implementation plan

## Phases

### Phase 0 — Foundations (this commit: design only)
Architecture, schemas, SKILL.md drafts, example Brand DNA files. No engine code.

### Phase 1 — MVP: a vertical slice, from talking-head footage to a branded vertical ad

| # | Capability | Scope in Phase 1 | Deferred |
|---|---|---|---|
| 1 | Project + versioning | init, ingest (hash, probe, CFR mezzanine), docs read/write with validation, auto-commit, undo/checkout/list/diff | branches, OTIO export |
| 2 | Video analysis | probe, shots (`scdet`), luma/saturation/RGB stats (`signalstats`), black/freeze, silence, loudness, keyframes, contact sheets, `annotate` | object/product detection models |
| 3 | FFmpeg editing | plan → timeline compiler, silence removal, filler removal (from word timestamps), section ordering, punch-in zooms, cut/fade transitions, `center` + `fit-blur` reframe | face-tracking reframe, B-roll auto-placement |
| 4 | Audio cleanup | measurement + preset chains (highpass, dehum, `afftdn`/`arnndn`, deess, EQ, compressor, `loudnorm` 2-pass, limiter), before/after metrics | dereverb (DeepFilterNet), spectral repair |
| 5 | Color correction | auto exposure/contrast from luma percentiles, gray-world WB with skin protection, brand look presets + LUT, before/after stills | shot matching across cameras, curves UI |
| 6 | Whisper subtitles | faster-whisper word timestamps (FR/EN plus auto-detect), remap through the timeline, segmentation, heuristic + Claude emphasis, Remotion + ASS renderers | diarization, translation |
| 7 | Brand DNA | schema, palette extraction from logo/images, `tokens` compiler, `brand preview` frame, 2 example brands | website scraping, PDF brand-book parsing |
| 8 | Remotion motion | Title, LowerThird, CTA, LogoReveal, BrandOutro, Watermark, Captions, and token-driven variants | the other 8 components (Phase 2) |
| 9 | Quality control | technical, audio (LUFS/TP), black frames, duration, ratio, A/V drift, caption bounds/overlap/CPS, brand colors/fonts, missing media | perceptual color QC |
| 10 | Claude skills | 13 SKILL.md, plugin manifest | — |
| + | Presets | instagram/reels, instagram/square, instagram/portrait, tiktok/vertical, youtube/landscape, linkedin/landscape, advertising/broadcast | — |

**MVP acceptance test** (automated e2e on a synthetic fixture, plus a manual run on real footage):

1. `bve init`, then `bve ingest talk.mp4 logo.png`, then `bve analyze --transcribe`.
2. Apply the example brand and a checked-in creative plan.
3. Run `bve plan compile`, `bve color auto`, `bve audio clean`, `bve captions build` and `bve motion from-plan`.
4. Run `bve render --target ig_reels`, `bve qc` and `bve export`.
5. The result must meet all of the following:
   - a 1080×1920 30 fps H.264/AAC file at −14 LUFS ±1 and TP ≤ −1 dBTP
   - silences removed
   - captions inside the safe zones
   - CTA and outro in brand colors
   - QC PASS
   - `bve version undo` restores the previous timeline
6. Re-running with the second example brand gives visibly different motion and captions and the same edit.

### Phase 2 — Advanced editing and motion
Face-tracking smart reframe (MediaPipe), all 14 motion components, beat detection (librosa) with beat-synced cuts and animations, cross-camera color matching, skin-tone qualifier, multi-version generation (15 s, 30 s, 60 s cutdowns from one plan), B-roll placement, dereverb.

### Phase 3 — Ecosystem
Brand DNA from website URL and PDF brand book, MCP server adapter, OpenTimelineIO export (Premiere/Resolve round-trip), a web preview UI, a music library connector, and translation of captions.

## Dependencies

**System:** FFmpeg ≥ 6.1 (full build with libass, libfreetype, libzimg, arnndn), Node ≥ 20, uv (it manages Python 3.12), and Chromium (downloaded automatically by Remotion).
On Windows: `winget install Gyan.FFmpeg astral-sh.uv`.

**Node (runtime):** `commander`, `execa`, `ajv`, `ajv-formats`, `pino`, `sharp` (palette and logo), `remotion`, `@remotion/renderer`, `@remotion/bundler`, `@remotion/layout-utils`, `@remotion/fonts`, `@remotion/google-fonts`, `react`, `react-dom`.
**Node (dev):** `typescript`, `tsx`, `vitest`, `json-schema-to-typescript`, `eslint`, `prettier`.
**Python:** `faster-whisper` (Phase 1). Phase 2 adds `mediapipe`, `librosa` and `numpy`.
**Models/data:** Whisper `large-v3` (about 3 GB; `small` for tests) and RNNoise model files for `arnndn` (BSD). Both are downloaded by `scripts/download-models`, never committed.

## Technical risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Remotion license.** It is free for individuals and companies of 3 people or fewer, and a company license is needed above that. | Open-source users in larger companies need a license | Document it prominently. Keep Remotion isolated in `engine/remotion`. Keep the ASS caption fallback and an FFmpeg-only render path (`drawtext`/overlay) for basic titles and CTAs, so the engine is usable without Remotion. |
| FFmpeg builds differ (missing `arnndn`, libass, zscale) | Filters fail at runtime | `bve doctor` plus capability detection. Each processor declares the filters it needs and degrades (for example `arnndn` → `afftdn`) with a warning. |
| Python 3.14 installed, ML wheels not yet available | Transcription install fails | uv-managed 3.12 venv. whisper.cpp provider as a second `TranscriptionProvider`. |
| VFR phone footage | A/V drift, cuts off by a frame | CFR mezzanine at ingest. QC measures stream-duration drift. |
| Word-timestamp inaccuracy, especially after cuts | Captions out of sync | VAD filter, snapping of word boundaries to `silencedetect` edges, cut points snapped to word gaps, QC check on caption vs. speech overlap |
| Windows paths (spaces, accents such as `maxyvidéomotion`) inside FFmpeg filter args (`subtitles=`, `lut3d=`, `movie=`) | Filter parse errors | A single escaping helper, run with cwd set to the project and relative filter paths. The CI matrix includes Windows. |
| Auto color overcorrects intentional looks (night, neon) | Ugly output | Conservative clamps, a confidence score, shots marked `locked`, and before/after stills that Claude reviews visually before commit |
| Noise reduction artifacts ("underwater" voice) | Unnatural voice | Gentle defaults, measured speech-to-noise before and after, short A/B preview snippets, no gating on speech |
| Brand DNA "motion personality" is subjective | Wrong feel | `provenance` + `confidence` per field. Claude asks the user to confirm low-confidence fields. A `brand preview` renders sample frames. |
| Brand fonts missing or unlicensed | Wrong typography | Declared `fallback` Google Font. QC warns when a fallback was used. |
| Render time (4K, long videos) | Slow iteration | Draft mode, stage cache, Remotion concurrency, skip Remotion when there are no graphics |
| Large analysis files vs. Claude context | Claude can't read everything | `bve analysis summary` / `--brief` views. Heavy data (face tracks) is stored out of line. |
| Disk usage (mezzanines, renders) | Disk full | Free-space check, `bve clean`, and mezzanines only when needed |
| Scope creep | Never shipping | Phase gates. Phase 2 starts only after the MVP acceptance test passes. |

## Files to create in Phase 1 (after approval)

```text
package.json  tsconfig.base.json  .gitignore  .env.example  .editorconfig  LICENSE (MIT)  README.md
.claude-plugin/plugin.json
engine/core/        src/{project.ts,versions.ts,validate.ts,paths.ts,cache.ts,log.ts,errors.ts,tempdir.ts,index.ts}  package.json
engine/ffmpeg/      src/{runner.ts,probe.ts,filtergraph.ts,escape.ts,analyzers.ts,capabilities.ts,index.ts}
engine/vision/      src/{shots.ts,stats.ts,keyframes.ts,contactSheet.ts,analyze.ts,index.ts}
engine/audio/       src/{measure.ts,processors.ts,chains.ts,mix.ts,index.ts}
engine/transcription/ src/{provider.ts,fasterWhisper.ts,remap.ts,segment.ts,emphasis.ts,fillers.ts,index.ts}
engine/brand/       src/{palette.ts,tokens.ts,fonts.ts,index.ts}
engine/remotion/    src/{Root.tsx,Composition.tsx,tokens.ts,components/{Title,LowerThird,CTA,LogoReveal,BrandOutro,Watermark,Captions}.tsx,layout/safeZones.ts}
engine/rendering/   src/{basePlate.ts,graphics.ts,audioMix.ts,mux.ts,renderTarget.ts,index.ts}
engine/editing/     src/{compilePlan.ts,silenceCut.ts,fillerCut.ts,punchIn.ts,reframe.ts,index.ts}
engine/color/       src/{autoCorrect.ts,looks.ts,compile.ts,stills.ts,index.ts}
engine/qc/          src/{registry.ts,checks/{technical,audio,captions,color,brand,motion,export}.ts,report.ts}
engine/cli/         src/{bin.ts,commands/*.ts,output.ts}
engine/python/      pyproject.toml  uv.lock  bve_py/{transcribe.py,__main__.py}
presets/**.json     (7 presets) + presets/preset.schema.json
scripts/            doctor, gen-fixtures, download-models, gen-types
tests/              fixtures generator + unit tests per module + e2e/mvp.test.ts
examples/           prompts.md, project-walkthrough.md
```
