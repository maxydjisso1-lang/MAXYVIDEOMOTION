# Implementation plan

## Phases

### Phase 0 — Foundations (done)
Architecture, schemas, SKILL.md drafts, example Brand DNA files.

### Phase 1 — MVP vertical slice (done)

Status legend: ✅ implemented and tested · 🟡 implemented, not yet exercised end to end · ⏭ moved to a later phase.

| # | Capability | Phase 1 status |
|---|---|---|
| 1 | Project + versioning | ✅ `init`, `ingest` (sha256, probe, hard link or copy, CFR mezzanine for VFR sources), schema-validated reads and writes, auto-commit, `undo` / `checkout` / `list` / `diff`, `doc get`/`doc set` · ⏭ branches, OTIO export |
| 2 | Video analysis | ✅ shots (`scdet`), luma/saturation/RGB stats (`signalstats`), exposure classes, black segments, silences, loudness, noise floor, keyframes, contact sheet, Claude `annotate` · ⏭ freeze detection, hum detection, object/product models |
| 3 | FFmpeg editing | ✅ plan → timeline compiler, reordering, silence and filler removal with word-safe cuts and padding, frame-exact clips, punch-ins on jump cuts, `delete`/`trim` ripple, `center` + `fit-blur` reframing · ⏭ face-tracking reframe, B-roll placement, split/move commands |
| 4 | Audio cleanup | ✅ chains built from measured problems (highpass, dehum, `afftdn`, EQ, compressor, de-esser), two-pass `loudnorm` + limiter, edge fades at cuts, music bed with sidechain ducking (data-driven) · 🟡 `arnndn` (needs a model file) · ⏭ dereverb, A/B preview |
| 5 | Color | ✅ measured exposure/contrast/gray-world WB with clamps and skin protection, 7 brand looks + LUT, locked shots · ⏭ cross-camera matching, stills command |
| 6 | Subtitles | ✅ remap through the edit, brand-driven segmentation (never across a source jump, never after an article), emphasis, min duration and no overlaps, SRT/VTT · 🟡 faster-whisper provider (implemented; the E2E test uses the transcript-import provider so it runs without a 3 GB model) |
| 7 | Brand DNA | ✅ schema with provenance, kit install (`brand set`), WCAG and file checks, deterministic **style-token compiler**, stale-token detection, 2 contrasting example brands · ⏭ automatic palette extraction, PDF and URL ingestion |
| 8 | Motion | ✅ Remotion components Title/Subtitle, CTA, LowerThird, Watermark, BrandOutro (Intro/LogoReveal aliases), Transition, Captions, with token-driven variants and motion; ✅ ASS/libass fallback renderer with automatic capability detection · ⏭ Quote, Statistic, ProductReveal, FeatureCard, Callout |
| 9 | Quality control | ✅ up to 30 checks (29 when the preset has no file-size limit): technical, audio (LUFS/TP/drift), black frames, source integrity, caption overlap/speed/safe zone, brand tokens/logo/fonts/**rendered brand color (ΔE)**, motion safe zone and collisions, export integrity/faststart; blockers gate export; user waivers |
| 10 | Claude skills | ✅ 13 SKILL.md files reconciled with the real CLI (unimplemented features are marked *planned*), plugin manifest |
| + | Presets | ✅ instagram/reels, instagram/square, instagram/portrait, tiktok/vertical, youtube/landscape, linkedin/landscape, advertising/broadcast |

**Acceptance test.** `tests/e2e/brand-ab.test.ts` drives the real CLI on synthetic footage. It checks the following:
- Same video with brand A and with brand B gives an **identical timeline**.
- `style-tokens.json`, `motion.json` and `captions.json` all differ between the two brands.
- The deliverables meet the Reels spec.
- The renders are visibly different: PSNR is below 25 dB, and each end card's measured color matches its own brand (ΔE < 8).
- QC passes, and export is refused before QC.
- The sources are never modified.
- `undo` restores the timeline without rewriting history.
- The ASS fallback delivers a QC-passing video.

**Still to do before calling Phase 1 production-ready:**
- a manual run on real footage with real Whisper transcription
- a Linux/macOS CI matrix
- `npm run build` packaging checks

### Pre-Phase-2 hardening (done)

All P0/P1 audit findings are fixed, and the result is covered by tests. See [AUDIT_PHASE1.md §8–10](AUDIT_PHASE1.md#8-resolution-status-pre-phase-2-work).
- **Contracts.** The render record, QC report and waivers are validated through `core`.
- **Cache.** Keys now include the content of the assets and a hash of the engine code.
- **CLI.** It only parses arguments; every command calls one engine or core function.
- **Fonts.** Font files per weight, `bve brand fonts fetch`, and the font actually used is verified by each renderer. QC reports FOUND / FALLBACK / MISSING.
- **Whisper.** Validated on real French speech. The model is cached once in `./models`, decoding goes through the engine's FFmpeg, and `truststore` handles TLS-inspecting networks.
- **Real fixtures.** Five CC or public-domain files, downloaded under control and pinned by sha1: a talking head, an interview, product footage, French speech, and street noise mixed with speech. The opt-in `test:real` suite covers them.
- **Robustness matrix.** 20 cases. It found and fixed silent-audio loudnorm, HEVC 10-bit stats, MJPEG detection, relative paths and ×2 gain limits.

### Phase 2 — Real-world post-production (proposal, ordered by the measurements)

1. **Real transcription.** *Chantier 1 done (measurement + sentence view + no silent failure): [measurements/transcription-noise.md](measurements/transcription-noise.md).* Remaining for later chantiers: denoise before transcription (chantier 2), and a glossary via `initial_prompt`.
   - A sentence-level view, so plans never cut mid-sentence.
   - `medium`/`large-v3` for final deliverables.
   - A glossary (brand names) passed to Whisper as `initial_prompt`.
   - Denoising before transcription on noisy sources.
2. **Real audio cleanup.** *Chantier 2 done: SNR-driven RNNoise with a voice-preservation guard, afftdn removed from the automatic chain, strong noise left untouched and reported ([measurements/denoise.md](measurements/denoise.md)). Open: DeepFilterNet 3 measures better in light/medium noise but needs a second Python/torch stack — dependency decision pending.* Neural denoise:
   - RNNoise now (the FFmpeg filter is already available); evaluate DeepFilterNet for SNR < 10 dB.
   - Strength driven by the measured SNR.
   - A voice-preservation guard (loudness delta, speech/noise ratio before vs after).
   - Music-versus-noise detection before any denoise.
   - Continuous per-source processing, instead of processing per clip.
3. **Real color.** Cross-camera shot matching, a skin-tone qualifier, before/after stills for Claude, and per-shot confidence.
4. **Scene detection.** Semantic labels from contact sheets as a versioned annotations document, plus best-take selection.
5. **Smart reframing.** Face and subject tracking (MediaPipe, in the Python sidecar), smoothed crop paths, and avoidance of burned-in text (the real talking-head source has a burned-in banner).
6. **Advanced captions.** Proofreading helpers, speaker labels, and translation.
7. **Richer motion.** Quote, Statistic, ProductReveal, FeatureCard and Callout, with props schemas for every component.
8. **Music and ducking.** A music asset workflow, ducking tuned on real speech, and fitting the music to the video length.
9. **Beat synchronisation.** Beats, downbeats and drops (librosa); snapping cuts and motion accents to them.
10. **Stronger QC.** Perceptual color checks, speech intelligibility, caption-to-speech offset measured on the audio, and rendering the broadcast preset.

Every item follows **Schema → Core → Engine → CLI → Skill → Tests** and extends the real-footage suite.

Performance (chantier 3, profiled, not yet optimised): [measurements/render-profile.md](measurements/render-profile.md). On the reference scenario (19.7 s, 592 frames) the median is 200.6 s. About half of it is three software H.264 encodes in series. Chrome frame capture takes 18 %, the `colorbalance` filter about 10 %, and the animation content itself is minor.

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
