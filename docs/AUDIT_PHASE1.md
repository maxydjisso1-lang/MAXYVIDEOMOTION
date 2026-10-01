# Phase 1 technical audit

Scope: the state of the repository at the Phase 1 commit. Every finding below comes from reading the code and running it; nothing is aspirational. Findings are tagged **[A1]…** and summarised with priorities in §6.

## 1. Architecture

### 1.1 Modules and responsibilities

| Module | Responsibility | Depends on |
|---|---|---|
| `core` | Project manifest, typed document store (`readDoc`/`writeDocs`), JSON Schema validation (Ajv), snapshot versioning, path safety, errors, logging, frame math (`clipFrames`) | — |
| `ffmpeg` | Binary resolution (env → PATH → winget install dir), spawn with argument arrays, `ffprobe`, measurement filters (`scdet`, `signalstats`, `blackdetect`, `silencedetect`, `ebur128`, `astats`, `psnr`) | core |
| `vision` | Ingest (sha256, probe, hard link or copy, CFR mezzanine for VFR sources), assets registry, analysis (shots, exposure classes, color stats, silences, loudness, noise floor, keyframes, contact sheet) | core, ffmpeg |
| `transcription` | `TranscriptionProvider` interface: faster-whisper bridge and transcript import; filler marking | core |
| `brand` | Brand kit install, brand checks (WCAG, files), **token compiler** (brand.json → style-tokens.json), freshness guard, color math | core, vision |
| `editing` | Plan → timeline compiler (reordering, word-safe silence and filler cuts, punch-ins, markers), ripple edits, reframing geometry | core |
| `color` | Measured correction, brand looks, compilation to FFmpeg filters | core, ffmpeg |
| `audio` | Cleanup chains from measured problems, filter compilation, two-pass loudness | core, ffmpeg |
| `captions` | Remap words through the edit, brand-driven segmentation, emphasis, case rules | core |
| `motion` | **Pure** layout module (safe zones, text fitting, anchors, per-component boxes) and plan → motion.json | core (types only) |
| `remotion` | React components and composition that render the transparent graphics layer | core (types), motion |
| `rendering` | Three-pass render, stage cache, renderer selection, ASS fallback renderer | audio, brand, captions, color, core, editing, ffmpeg, motion, remotion (types) |
| `qc` | Checks on the delivered file, report, waivers | brand, captions, core, ffmpeg, motion, rendering |
| `export` | QC-gated delivery, SRT/VTT | core, rendering |
| `cli` | `bve` commands, JSON envelope, exit codes | all |
| `python` | uv project (Python 3.12): `bve_py.transcribe` | — (called by `transcription`) |

The graph is acyclic. `core` depends on nothing, and `motion/layout.ts` has no Node imports, so the browser bundle, the ASS renderer and QC run exactly the same layout code.

### 1.2 Coupling issues

- **[A1] `brand` → `vision`.** `setBrand` imports `addAsset` from `vision` only to register the kit's logo. Asset registration is project-model logic and belongs in `core`. *Fix: move `addAsset` (and `ingestSource`'s import helper) to `core/assets.ts`.*
- **[A2] Two `applyCase` implementations.** `captions/applyCase(text, rule, isFirst)` and `remotion/runtime.applyCase(text, rule)` have different signatures. Today they agree only because the callers compensate. *Fix: keep one pure implementation in `motion/layout.ts` (browser-safe) and import it everywhere.*
- **[A3] `qc` and `export` depend on `rendering`** for `renderRecordPath`, `RenderRecord` and `linkOrCopy`. The render record is a contract between rendering, QC and export, so it should live in `core` with a schema (see [C3]).
- **[A4] Logic in the CLI (violates the "Schema → Core → Engine → CLI" rule).** `bin.ts` holds behaviour that belongs in engine or core functions:
  - `target add` mutates the manifest directly
  - `analysis annotate` merges labels
  - `audio clean` resolves the cleanup level from the plan and picks the target
  - `plan compile` picks the timeline fps
  - `clean` decides which folders are disposable
  - `frames` extracts stills

  None of these are hacks, but they cannot be reused by a future MCP adapter or by tests. *Fix: one engine function per command, and a CLI reduced to argument parsing + envelope.*

## 2. CLI (`bve`, v0.1.0)

**Global options:** `-p/--project <dir>` (default `.`), `--json`. With `--json`, stdout carries exactly one envelope: `{ ok: true, data, version }` or `{ ok: false, code, message, hint?, details? }`. Logs go to stderr (level from `BVE_LOG_LEVEL`) and to `<project>/logs/bve.jsonl`.

**Exit codes:**

| Code | Error codes |
|---|---|
| 0 | ok |
| 1 | `FFMPEG_FAILED`, `RENDER_FAILED`, `INTERNAL` |
| 2 | `VALIDATION`, `PATH_UNSAFE`, `NOTHING_TO_UNDO`, `PROJECT_EXISTS`, `UNSUPPORTED` |
| 3 | `NOT_FOUND`, `MISSING_INPUT`, `SOURCE_MODIFIED` |
| 4 | `TOOL_MISSING` |
| 5 | `QC_BLOCKED` |

"Versioned" means the command creates a snapshot version (undoable).

| Command | Input | Output (`data`) | Validation | Versioned | Notable errors |
|---|---|---|---|---|---|
| `doctor` | — | FFmpeg path/version/missing filters, Remotion status + license note, transcription availability | — | no | none (reports problems as data) |
| `init <dir> [--name]` | dir | `{root, id}` | project.json schema | creates v0001 | `PROJECT_EXISTS` |
| `ingest <files…> [--role]` | media files | per source: id, path, duration, size, fps, fpsMode, mezzanine | extension whitelist, ffprobe must read it, needs audio or video | no (manifest only) [V1] | `MISSING_INPUT`, `UNSUPPORTED` |
| `asset add <file> --kind [--as] [--license]` | file | asset record | per-kind extension whitelist, path safety | no [V1] | `UNSUPPORTED`, `PATH_UNSAFE` |
| `target add <id> --preset` / `target list` | preset id | targets | preset schema | no [V1] | `NOT_FOUND` |
| `analyze [--source] [--transcribe --language --model]` | sources | compact summary | analysis (+ transcript) schema on write | no (facts) | `TOOL_MISSING` (whisper) |
| `analysis summary` / `analysis annotate --file` | annotations JSON | summary / `{annotated}` | analysis schema | **no** [V2] | `NOT_FOUND` (shot) |
| `transcript import <file>` / `transcript show` | transcript JSON | counts / segments | transcript schema + source ids | no | `VALIDATION`, `NOT_FOUND` |
| `brand set <kit\|file>` | brand kit | tokens summary + issues | brand schema, WCAG, referenced files (logo missing = blocking) | **yes** (brand + tokens) | `VALIDATION` |
| `brand tokens` / `brand validate` | — | tokens summary / issues | style-tokens schema | tokens: yes | `MISSING_INPUT` |
| `plan set <file>` / `plan validate` / `plan estimate` | plan JSON | duration estimate per section | creative-plan schema + reference resolution | set: yes | `VALIDATION` (unknown segment/shot) |
| `plan compile` | plan, analysis, transcript | timeline summary | timeline schema | yes | `VALIDATION` (no material) |
| `timeline show` | — | EDL summary | — | no | `MISSING_INPUT` |
| `edit delete --clip` / `edit trim --clip [--in --out]` | clip id | timeline summary | timeline schema, min 0.1 s, not the last clip | yes | `NOT_FOUND`, `VALIDATION` |
| `reframe --target --mode center\|fit-blur` | target | reframe map | timeline schema | yes | `NOT_FOUND` |
| `color auto [--intent]` | analysis, timeline, tokens | per-shot reasons | color schema | yes | `MISSING_INPUT` |
| `audio clean [--preset] [--target]` | analysis, preset | audio doc | audio schema | yes | `MISSING_INPUT` (no target) |
| `captions build` | transcript, timeline, tokens, plan | cues summary | captions schema | yes | `MISSING_INPUT` |
| `motion from-plan` / `motion list` | plan, timeline, tokens | instances | motion schema (per-component props) | from-plan: yes | `MISSING_INPUT` |
| `render --target [--draft] [--renderer]` | all docs | render record | sources re-hashed; tokens freshness (auto-recompile) | no (render artifacts) | `SOURCE_MODIFIED`, `TOOL_MISSING`, `RENDER_FAILED`, `FFMPEG_FAILED` |
| `frames --target --at <secs> [--draft]` | render | still paths | — | no | `NOT_FOUND` (no render) |
| `qc --target [--draft]` | render | status, text, report | — **[C1]** | no | `MISSING_INPUT`; **exit 5 with `ok:true` when the status is fail [E1]** |
| `qc waive <checkId> --reason` | reason | waivers | non-empty reason **[C2]** | no | `VALIDATION` |
| `export --target\|--all [--sidecars]` | render + QC report | delivered files | QC status, render sha, version | no (manifest) | `QC_BLOCKED` (exit 5) |
| `doc get <key>` / `doc set <key> <file> [-m]` | document | document / version | the document's schema | set: yes for decision docs | `VALIDATION` |
| `clean` | — | removed folders | — | no | — |
| `version list\|undo\|checkout <id>\|diff <a> <b>` | — | metadata | — | undo/checkout create a version | `NOTHING_TO_UNDO`, `NOT_FOUND` |

**CLI findings:**

- **[E1]** `bve qc` exits with 5 but prints `ok: true` when blockers exist (the command itself succeeded; the report failed). This is defensible but surprising. *Proposal: keep `ok:true` and document it in the quality-control skill, or return `ok:false, code: QC_BLOCKED` with the report in `details`.*
- **[V1]** Sources, assets and targets live only in `project.json`, and project.json is not snapshotted. `undo` cannot undo `target add` or `ingest`. This is acceptable because they are additive, but it must be documented.
- **[V2]** `analysis` and `transcript` are unversioned "facts", yet Claude's `annotate` labels are decisions. *Proposal: move semantic labels to a versioned `annotations.json` document.*

## 3. JSON contracts

### 3.1 Documents

| Contract | Written by | Read by | Validated on write | Validated on read | Versioned |
|---|---|---|---|---|---|
| `project.schema.json` | core (`saveManifest`) | all | ✅ | ✅ | head pointer only |
| `brand.schema.json` | `brand set`, `doc set` | brand, rendering, qc | ✅ | ✅ | ✅ |
| `style-tokens.schema.json` | brand (compiler) | color, captions, motion, remotion, ass, qc | ✅ | ✅ | ✅ (+ `brandHash` freshness) |
| `creative-plan.schema.json` | `plan set`, `doc set` | editing, captions, motion, qc | ✅ + reference check | ✅ | ✅ |
| `timeline.schema.json` | editing | rendering, captions, motion, color | ✅ | ✅ | ✅ |
| `motion.schema.json` | motion, `doc set` | remotion, ass, qc | ✅ (per-component props for 9 of 14 components) | ✅ | ✅ |
| `captions.schema.json` | captions, `doc set` | remotion, ass, qc, export | ✅ | ✅ | ✅ |
| `color` / `audio` | color, audio | rendering, qc | ✅ | ✅ | ✅ |
| `analysis` / `transcript` | vision, transcription | editing, color, audio, captions | ✅ | ✅ | ✗ (by design, see [V2]) |
| `preset.schema.json` | repo (`presets/`) | core | — | ✅ | — |
| `qc-report.schema.json` | qc | export | **✗ [C1]** | ✗ | — |

All decision documents go through `Project.writeDocs`. That path runs the schema check, then an atomic write, then a version commit. No engine module writes a decision document any other way (checked by searching every `writeJsonAtomic`/`writeFile` call site).

### 3.2 Bypasses and gaps

- **[C1] The QC report is written without being validated against `qc-report.schema.json`**, and export reads it without validation. It conforms today (it is built from typed code), but the contract is not enforced.
- **[C2] The waivers file (`exports/qc-waivers.json`) has no schema.**
- **[C3] Render records (`renders/*.render.json`) have no schema**, although QC and export depend on their fields (sha256, renderer, durationSec).
- **[C4] Version metadata (`versions/*/meta.json`) has no schema.** It is internal, which makes this low risk.
- **[C5] Props schemas are missing** for `Transition`, `Watermark`, `BrandOutro`/`BrandIntro`/`LogoReveal` and `Quote` (they accept any object). `creative-plan.motion.lowerThirds[]` allows extra properties.
- **[C6] Some documents carry values from other documents instead of references.** `style-tokens.logo.primary` is a path and not an asset id with a sha256. Changing the logo file's content, but not its name, is invisible to the cache (see §4.3).

Non-JSON intermediates (`graphics.ass`, PNG frames, WAV/MP4 stages) are derived artifacts, fully determined by validated documents.

## 4. Rendering

### 4.1 Official pipeline

```text
Source (read-only; sha256 re-checked before every render; CFR mezzanine used if the source was VFR)
 │
 ├─[A] BASE PLATE — FFmpeg                                  renders/cache/base-<key>.mp4
 │     per clip: -ss in -t (frames/fps + 0.1) -i source
 │       setpts → fps=F → trim=end_frame=N (frame-exact)
 │       → color correction (colorchannelmixer exposure×WB gains, eq contrast/saturation)
 │       → brand look (colorbalance/curves/eq/vibrance/hue; lut3d if any)
 │       → reframe (center crop to aspect, punch-in scale; or fit-blur) → scale W×H, setsar 1
 │     concat → libx264 CRF 14 (draft 22), GOP fps/2, no B-frames, muted
 │
 ├─[B] GRAPHICS — only if motion instances or caption cues exist
 │     Remotion (default when packages + headless browser are available):
 │       bundle (cached) → renderFrames → transparent PNG sequence (temp dir)
 │       → FFmpeg overlay on the base plate → renders/cache/gfx-<key>.mp4 (CRF 15, muted)
 │     ASS/libass fallback (automatic when Remotion is unavailable, or --renderer ass):
 │       graphics.ass built from tokens + the same layout module → ass= filter,
 │       logo overlays (watermark, end card) → renders/cache/gfx-<key>.mp4
 │     Remotion never decodes video (official decision; see ARCHITECTURE §3).
 │
 ├─[C] AUDIO — FFmpeg                                        renders/cache/mix-<key>.wav
 │     per clip: seek → resample 48 kHz stereo → apad/atrim to frame-exact length
 │       → dialogue chain (highpass, dehum, afftdn, EQ, compressor, de-esser) → 12 ms edge fades
 │     concat → [music: gain, fades, delay, sidechaincompress ducking, amix]
 │     → loudnorm pass 1 (measure) → loudnorm pass 2 (linear) → alimiter (TP − 0.3 dB) → PCM 24-bit
 │
 └─[D] FINAL ENCODE — FFmpeg (not cached)                    renders/<target>-<version>[-draft].mp4
       video = gfx or base; scale out_range=tv, BT.709 matrix, pix_fmt from preset, color tags;
       libx264 high, CRF from preset, maxrate/bufsize; or ProRes (broadcast preset)
       audio AAC 256k (or PCM); -t = frame-exact duration; +faststart
       → render record renders/<target>-<version>.render.json (renderer, sha256, stages, cache hits)
```

### 4.2 Cache keys

`stageKey(stage, inputs) = sha256(stableStringify({ stage, engine: package.version, code: engineCodeHash(), inputs }))`, truncated to 20 hex characters. `engineCodeHash()` fingerprints every engine source file (post-audit fix for [R2]). `stableStringify` sorts object keys, so equal data always gives an equal key.

| Stage | Inputs hashed |
|---|---|
| base | `timeline.tracks.video`, `timeline.reframe[target]`, full color document, analysis shot ids and ranges, `tokens.grade`, **sha256 of the LUT file**, geometry `{w,h,fps}`, draft flag, sha256 of every source |
| graphics | base key, renderer name, full style tokens, motion document, captions document, preset safe zone, geometry, draft flag, **sha256 of the logo and of every font file** (post-audit fix for [R1]) |
| mix | `timeline.tracks.video`, full audio document, preset loudness, sample rate, sha256 of every source |
| Remotion bundle | sha256 of every `.ts/.tsx` file in `engine/remotion/src` and `engine/motion/src` → `engine/remotion/.bundle/<16 hex>/` |

Cached files are written as `<name>.partial.<ext>` and renamed on success, so an interrupted render is never mistaken for a cache hit. `bve clean` deletes `.cache/`, `renders/cache/` and `renders/frames/`.

### 4.3 Rendering findings

- **[R1] Asset contents are not in the cache keys.** The logo, LUT and font files are referenced by path. Replacing `assets/logo/x.png` with a new file of the same name reuses stale graphics, and the same applies to the base plate for a LUT. *Fix: add the sha256 of every referenced asset to the keys (it is already stored in `project.json.assets`).*
- **[R2] `PIPELINE_REVISION` is manual.** A change to a filter implementation reuses old caches unless someone bumps it. *Fix: add a hash of the rendering, color and audio source files, the same way the Remotion bundle key works.*
- **[R3] Dialogue processing resets at every cut.** The chain runs per clip, so compressor and denoiser state restart at each cut. This is inaudible on the fixtures, but could pump on real speech. *Fix: concatenate first, then apply the chain per source segment, or process each source once and cut afterwards.*
- **[R4] The limiter works on sample peaks** (`alimiter`). True peak is only measured afterwards by QC, which passed at −6.5 dBTP, so there is a large margin. It needs checking on loud real material.
- **[R5] The `advertising/broadcast` preset (ProRes + PCM, 25 fps) has never been rendered.**
- **[R6] No concurrency guard.** Two renders of the same key at the same time would share one `.partial` path. *Fix: add a random suffix.*
- **[R7] Audio-only sources cannot be rendered** (the base plate needs video). This case has not been tested, and the likely result is a raw FFmpeg error rather than a clear `UNSUPPORTED` message. The robustness matrix (§7.3) will confirm.

## 5. Other observations

- **Fonts.** Brand fonts are embedded only when `source.kind = "file"` and the file exists. Google and system fonts rely on the machine, and the renderer never checks what the browser or libass actually used. QC reports this only as a generic warning. See the plan in §7.
- **Whisper.** The faster-whisper provider and the Python script exist but have **never run**. `uv` is not installed on this machine yet.
- **Real footage.** Everything so far is validated on synthetic media only.
- **Platforms.** Only Windows has been tested.
- **Packaging.** `npm run build` compiles cleanly to `dist/`, and `node dist/engine/cli/src/bin.js` runs. `bin/bve.js` uses `tsx` at runtime.

## 6. Priorities before Phase 2

| Priority | Findings | Why |
|---|---|---|
| P0 | [C1] [C2] [C3] validate the QC report, waivers and render records | "No module bypasses the contracts" must be literally true |
| P0 | [R1] [R2] asset hashes and source-code hash in cache keys | Reproducibility: a stale cache is a silent wrong output |
| P1 | [A4] move CLI logic into engine functions; [A1] [A2] [A3] | Development rule: Schema → Core → Engine → CLI |
| P1 | [R7] clean errors for audio-only; the robustness matrix (§7.3) | Fail cleanly |
| P1 | Fonts (§7.4) | Never depend silently on an installed font |
| P2 | [R3] [R4] [R5] [R6] [V1] [V2] [E1] [C5] | Correctness on real material and edge cases |

## 7. Proposed pre-Phase-2 work (awaiting validation)

### 7.1 Whisper validation
- Install `uv` (`winget install astral-sh.uv`), then run `uv sync --project engine/python` (Python 3.12 is managed by uv).
- Models are cached in `WHISPER_MODEL_DIR` (default `./models`, gitignored) and downloaded once. Tests use `small` by default, and `large-v3` is opt-in.
- Add an opt-in test (`BVE_TEST_WHISPER=1`) on a real French speech clip. It asserts the language, word timestamps inside the speech ranges measured by the analysis, silences with no words, and the full chain transcript → `captions.json` → render.

### 7.2 Real fixtures
- Add `tests/fixtures/real/manifest.json` with, per file: URL, sha256, license, attribution and duration. `npm run fixtures:real` downloads the files into the gitignored `tests/fixtures/real/`. Nothing is committed.
- Sources are restricted to public-domain or CC0/CC-BY footage with explicit terms: Wikimedia Commons, LibriVox (public-domain speech) and Mozilla Common Voice (CC0). Each file is trimmed to 10–30 s.
- Targets: talking-head (FR), interview (2 speakers), product (no speech, B-roll), noisy-audio (street or HVAC).

### 7.3 Robustness matrix (synthetic, generated by FFmpeg; runs in CI)
- **Geometry and frame rate:** 1080p and 4K; 24, 25, 30 and 60 fps; 16:9, 9:16 and 1:1 sources.
- **Edge cases:**
  - no audio
  - audio only
  - 0.5 s clip
  - 10 min clip (low resolution)
  - VFR
  - rotation metadata
- **Paths:** file names with spaces, accents and emoji; Windows paths.
- **Codecs:** HEVC 10-bit, ProRes, VP9 and MJPEG.
- **Failure cases:**
  - missing file
  - corrupt file
  - missing font file
  - missing logo
- The expected outcome for every case is defined: either success, or a specific error code and hint. No raw FFmpeg errors.

### 7.4 Fonts
- **Project fonts in `brand/fonts/`.** Map the requested shape (`fontFamily`, `fontSource`) onto the existing contract, `identity.fonts[].source { kind: "file", path }`, so there is no parallel schema. Kit fonts are imported into `brand/fonts/`.
- **Google fonts are downloaded once** into `brand/fonts/` by `bve brand fonts fetch`, at setup time and not at render time. After that, every render uses files.
- **The renderers verify the font actually used:**
  - Remotion: `document.fonts.check()`, reported per role.
  - libass: parse the font-selection warnings.
- **QC reports per role:** `FONT FOUND` (embedded file used) / `FONT FALLBACK` (declared fallback used: warning) / `FONT MISSING` (neither: blocker unless waived).

## 8. Resolution status (pre-Phase-2 work)

| Finding | Status | How |
|---|---|---|
| [C1] QC report not validated | ✅ fixed | `core/artifacts.ts`: `writeQcReport` / `readQcReport` validate against `qc-report.schema.json` |
| [C2] waivers without schema | ✅ fixed | new `qc-waivers.schema.json`; `addWaiver` / `readWaivers` validate |
| [C3] render record without schema | ✅ fixed | new `render-record.schema.json` (now includes verified fonts); written and read only through `core` |
| [R1] asset contents not in cache keys | ✅ fixed | the base and graphics keys include the sha256 of the logo, LUT and every font file |
| [R2] manual pipeline revision | ✅ fixed | the `engineCodeHash()` of the engine sources is part of every stage key |
| [R6] no concurrency guard | ✅ fixed | unique `.partial` suffix per render |
| [R7] audio-only sources | ✅ fixed | the render refuses early with `UNSUPPORTED` and a hint (covered by the robustness matrix) |
| [A1] brand → vision | ✅ fixed | `addAsset` and `importFile` moved to `core/assets.ts` |
| [A2] two `applyCase` | ✅ fixed | a single implementation in `motion/layout.ts` |
| [A3] render record in rendering | ✅ fixed | the record, QC report and waivers live in `core/artifacts.ts` |
| [A4] logic in the CLI | ✅ fixed | every command calls one engine/core function (`addTarget`, `annotateAnalysis`, `setPlan`, `compileProjectPlan`, `colorAutoProject`, `cleanProjectAudio`, `buildProjectCaptions`, `motionFromProjectPlan`, `extractRenderFrames`, `Project.clean`, …) |
| [E1] `bve qc` ok:true + exit 5 | ✅ fixed | a failed QC now returns `ok:false`, `code: QC_BLOCKED`, with the report in `details` |
| Fonts | ✅ fixed | see §9 |
| [R3] chain state resets at cuts | ⏭ Phase 2 (audio) | measured: not audible on the fixtures |
| [R4] sample-peak limiter | ⏭ Phase 2 | QC measures true peak; all real renders passed |
| [R5] broadcast preset never rendered | ⏭ Phase 2 | — |
| [V1] [V2] manifest/analysis not versioned | ⏭ Phase 2 | annotations document |
| [C5] missing props schemas | ⏭ Phase 2 (motion components) | — |

### Bugs found by the robustness matrix and the real footage (all fixed)

| Case | Symptom | Fix |
|---|---|---|
| Video without audio | loudnorm crashed on −∞ LUFS | silent programmes are not normalised; QC reports `audio.loudness: skip` with the reason |
| HEVC 10-bit | analysis rejected by its schema (luma > 1) | stats are always measured on 8-bit 4:2:0 |
| MJPEG in AVI | treated as audio-only | only `attached_pic` streams (cover art) are ignored, not a codec |
| Continuous speech / street ambience | noise floor reported as −90 dBFS ("clean") | the floor is the 10th percentile of 100 ms RMS windows when there is no real silence; "noisy" = floor > −62 dBFS AND loudness − floor < 30 dB (an estimate, not a true SNR) |
| Relative input paths | analyzers failed when run with a temp working dir | inputs resolved to absolute paths |
| Whisper tokens | "j 'exerce" in captions | apostrophe and punctuation tokens are merged into the previous word |
| Orphan words | a 1-word cue ("mon") | a lone word joins its neighbour within the same take |
| CTA over captions | collision (QC warning) | captions give way to motion shown at the same time (shared `avoidObstacles`, used by both renderers and QC) |
| Watermark over title | overlap (not detected before) | top titles reserve the brand watermark corner; new QC check `motion.overlap` |
| libass weight selection | Inter 600 rendered with the Regular file | libass is addressed by the file's own legacy family name; its `fontselect` log is verified against the expected PostScript name |
| faster-whisper + PyAV 19 | crash while decoding | the engine decodes with its own FFmpeg to 16 kHz WAV; Python only reads samples |
| Underexposed real interview (+1.5 EV) | render crashed: `colorchannelmixer` rejects gains > 2 | gains above ×2 are applied with `colorlevels` (unit test runs the filter in FFmpeg) |

## 9. Fonts (implemented)

- `brand.json` fonts declare files per weight: `source: { kind: "file", files: [{ weight, path }] }`. The optional `fallbackSource` holds the files of the declared fallback. Kits ship them in `fonts/`, which is imported to the project's `brand/fonts/`.
- `bve brand fonts fetch` downloads Google fonts (and fallbacks of absent commercial fonts) **once**, at setup, then points `brand.json` at the files.
- **Remotion** registers each file with the FontFace API and blocks rendering (`delayRender`) until it has loaded. A font that fails to load fails the render.
- **libass** receives the same files (`fontsdir`), addressed by their legacy family name. Its own `fontselect` log is compared with the expected PostScript name.
- The render record stores, per role, the requested font, the font used and a status. QC reports **FONT FOUND** (pass), **FONT FALLBACK** (warning) or **FONT MISSING** (blocker, export refused).

## 10. Real-world measurements that shape Phase 2

| Measurement | Result | Consequence |
|---|---|---|
| faster-whisper `small`, int8, CPU, clear French speech (71 s) | ≈45 s; language p=1.00; 17 segments, word timestamps; minor lexical errors ("sigale") | `small` is the default. Proofreading stays a skill step. Offer `medium`/`large-v3` for final deliverables. |
| Whisper segments on real talk | segments end mid-sentence ("… j'exerce dans le" \| "domaine …") | Phase 2: a sentence-level view, so plans never cut mid-sentence |
| Whisper on speech buried in street noise | 0 segments, with or without VAD | **corrected in chantier 1:** that mix was ≈ −13 dB SNR, not ≈0 dB (the loudness − noise-floor figure is not a true SNR). Measured curve: [measurements/transcription-noise.md](measurements/transcription-noise.md) |
| Whisper on speech at ≈5 dB SNR | transcribed, more errors ("cigare", "fourmille") | Phase 2: denoise **before** transcription |
| Phase 1 cleanup (`afftdn`) on real noise | floor −0.4 to −1.1 dB, SNR unchanged | **not sufficient** for real footage |
| RNNoise (`arnndn`, BSD model) | talking head: loudness−floor 15.9 → 24.1 dB with voice level preserved; street mix at true SNR ≈ −3 dB: loudness−floor 5 → 17 dB but voice −10 LU; street mix at ≈ −13 dB: voice destroyed (figures before chantier 1 used the loudness − noise-floor estimate, not a true SNR) | Phase 2: neural denoise with **strength driven by measured SNR**, voice-preservation check (loudness delta), DeepFilterNet evaluation for low SNR |
| Remotion render, 21 s real footage, 1080×1920 | ≈3 min on this machine (whole render; on the 10 s synthetic fixture: Remotion ≈45 s vs ASS ≈20 s) | Phase 2: profile the PNG sequence stage (JPEG + separate alpha, or fewer graphics-only frames) |
| Music vs noise | spectral flatness does not separate them on these files | Phase 2: tonal/temporal music detection before any denoise |
