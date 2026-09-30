# Architecture — brand-video-engine

> Status: **design draft (pre-implementation)**. The CLI commands referenced here and in `skills/*/SKILL.md` are the target interface for Phase 1.

## 1. Core idea

brand-video-engine splits post-production into three layers:

| Layer | Who | Responsibility |
|---|---|---|
| **Decision** | Claude, guided by `skills/*/SKILL.md` | Understands the brief, the footage (analysis + contact sheets) and the brand. Writes *intent* as JSON documents: Brand DNA, creative plan, emphasis and motion choices. |
| **Contract** | `schemas/*.schema.json` | Typed, validated documents. They are the only thing the two other layers share. |
| **Execution** | `engine/` (TypeScript CLI `bve`, Python sidecar only where needed) | Deterministic measurement, compilation and rendering: FFmpeg, Remotion, Whisper. No LLM calls, no API keys. |

Why this split:

- **No API keys in the engine.** Claude already *is* the vision and language model. The engine produces artifacts Claude can read, such as numbers, keyframes and contact sheets. Claude writes back decisions. This keeps the engine reproducible and testable.
- **Explainable.** Every decision lives in a JSON document with a `reason` or `rationale` field and, for the brand, `provenance`.
- **Reproducible.** The same documents and the same sources produce the same render. Renders are cached by a content hash of their inputs.
- **Composable.** Each skill reads some documents and writes one. Any skill can run alone. For example, you can do "just clean the audio" without a creative plan.

## 2. Repository layout

```text
brand-video-engine/
├── .claude-plugin/plugin.json      # installable as a Claude Code plugin (skills + CLI)
├── skills/                         # 13 Claude skills (decision layer)
│   ├── post-production/            # entry point / orchestrator
│   ├── video-analysis/  brand-intelligence/  creative-director/  storytelling/
│   ├── video-editing/  color-grading/  audio-cleanup/  music/
│   ├── subtitles/  motion-brand/  quality-control/  export/
├── schemas/                        # JSON Schema 2020-12 — single source of truth
├── engine/                         # npm workspaces
│   ├── core/          # project store, versioning, validation, logging, errors, fs safety, cache
│   ├── ffmpeg/        # ffprobe/ffmpeg runner, filtergraph builder, progress parsing
│   ├── vision/        # shot detection, exposure/color stats, keyframes, contact sheets (ffmpeg-based)
│   ├── editing/       # creative-plan → timeline compiler, silence/filler cuts, punch-ins, reframe paths
│   ├── color/         # auto correction, brand looks, color.json → FFmpeg filters, before/after stills
│   ├── audio/         # loudness/noise analysis, cleanup chain compiler, mix/ducking graph
│   ├── transcription/ # TranscriptionProvider interface + faster-whisper bridge
│   ├── brand/         # Brand DNA: palette extraction, token compiler (brand.json → BrandTokens)
│   ├── remotion/      # React/Remotion brand components + compositions
│   ├── rendering/     # render graph: base plate → graphics → mux → encode, per target
│   ├── qc/            # quality-control checks registry
│   ├── cli/           # `bve` binary (commander), JSON output mode for Claude
│   └── python/        # uv project: whisper, (Phase 2) face tracking, beat detection
├── presets/  instagram/ tiktok/ youtube/ linkedin/ advertising/   # target format definitions
├── examples/          # brand kits + sample projects + prompts
├── tests/             # fixtures (generated synthetic media) + e2e
├── scripts/           # doctor, fixture generation, model download, type generation
└── docs/
```

Why the directories differ slightly from the initial brief:

- **`engine/brand`, `engine/editing`, `engine/color`, `engine/qc`, `engine/core` and `engine/cli` are added.** Brand DNA, editing, color and QC each have enough logic to need their own module, with one module per skill domain. `core` holds the project model that every module imports.
- **`engine/python` is a single uv project** instead of Python code spread across `vision/` and `transcription/`. You get one environment, one lockfile and one install step. The TS modules call it through a thin, typed bridge.
- **A 13th skill, `post-production`, is added.** It is the single entry point that fires on requests like "turn this into an Instagram ad". `creative-director` stays focused on *planning*, and orchestration lives in `post-production`.

## 3. Technical decisions

| Decision | Choice | Why | Rejected |
|---|---|---|---|
| Main language | TypeScript (Node ≥ 20, ESM) | Remotion is TS/React. Keeping one language for the engine and the motion layer means shared types. | Python-first, which would split the motion layer from everything else |
| Python | Only for ML models without solid JS equivalents: faster-whisper (Phase 1), MediaPipe and librosa (Phase 2) | Best-in-class word timestamps and VAD | whisper in JS/WASM, which is slower and less accurate |
| Python runtime | `uv` with a pinned **Python 3.12** venv | The ML wheels (ctranslate2, mediapipe) lag behind the newest Python, and 3.14 is installed on this machine. uv isolates the version. | System Python |
| Contracts | JSON Schema as the source of truth, validated with **Ajv**, TS types generated by `json-schema-to-typescript` | Claude reads JSON Schema natively, it works across languages (Python validates the same files), and there is one source of truth | Zod-first, which is TS-only and makes Claude read generated schemas |
| Media ops | FFmpeg ≥ 6.1 CLI via `execa` (no fluent-ffmpeg) | FFmpeg already covers cut, scale, crop, color (`eq`, `colorbalance`, `lut3d`), audio (`afftdn`, `arnndn`, `deesser`, `acompressor`, `loudnorm`, `sidechaincompress`) and analysis (`scdet`, `signalstats`, `blackdetect`, `silencedetect`, `ebur128`). fluent-ffmpeg is unmaintained. | Custom decoding |
| Motion | Remotion 4 (React) | Programmatic, parametric, frame-accurate. Components take `BrandTokens`. | After Effects templates or Lottie, which are not parametric enough and not code-reviewable |
| Captions | Remotion (animated) with an **ASS/libass fallback** | The ASS fallback keeps captions working if Remotion is unavailable or unlicensed, and renders fast drafts | — |
| Claude integration | Skills + CLI with `--json` output. Distributed as a Claude Code plugin. | Zero server to run, works in Claude Code today, every step is inspectable in the terminal | MCP server (planned for Phase 3 as an optional adapter over the same core) |
| Project state | Plain JSON files + snapshot versioning | Human-readable and diffable. Git works on top of it. | SQLite, event sourcing |
| Logging | `pino` JSON lines to `project/logs/`. Human-readable logs on stderr. The result JSON goes on stdout. | Claude parses stdout reliably, and logs stay auditable | — |
| Tests | `vitest`, with **synthetic fixtures generated by FFmpeg** (`testsrc2`, `sine`, `anoisesrc`) | No large binaries in git, and properties are known exactly (a silence at 2.0–2.8 s, a black frame at 5 s, and so on) | Committed sample videos |
| Workspace | npm workspaces | Built into Node, with no extra tool | pnpm or turbo, which are unnecessary at this size |

## 4. Project on disk

```text
my-project/
├── project.json            # manifest (schemas/project.schema.json)
├── source/                 # originals — read-only, hashed at ingest
├── assets/                 # logo, fonts, music, LUTs, brand book
├── brand/brand.json
├── analysis/analysis.json  transcript.json  keyframes/  contact-sheets/
├── plan/creative-plan.json
├── timeline/timeline.json
├── color/color.json
├── audio/audio.json
├── subtitles/captions.json
├── motion/motion.json
├── versions/v0001/ … v000N/  # snapshots of all mutable documents + meta.json
├── renders/                # intermediate renders (disposable, cache-addressed)
├── exports/                # final deliverables + qc reports
├── logs/                   # *.jsonl
└── .cache/                 # proxies, mezzanines, temp — safe to delete
```

**Non-destructive rules**

1. Nothing under `source/` is ever written after ingest. The engine refuses output paths inside `source/`, and the sha256 is re-checked before each render.
2. Sources with variable frame rate (VFR) or long-GOP encoding get a CFR mezzanine in `.cache/`. The original is still the reference.
3. Every mutating command validates its output document and then **auto-commits a version**.

## 5. Versioning

- `versions/vNNNN/` contains a copy of every mutable document (brand, plan, timeline, color, audio, captions, motion) and a `meta.json` with `{ id, parent, createdAt, actor: "claude"|"user", command, message, changed: [docs] }`.
- Documents are small (KB), so full snapshots are simpler and more robust than diffs.
- `bve version undo` restores the parent's documents into the working copy **as a new version** ("revert v0007"). History is never rewritten, so an undo can itself be undone.
- `bve version checkout vNNNN`, `bve version list` and `bve version diff vA vB` (a JSON diff summarised in plain language) are also available.
- Exports record the version they were rendered from, so any deliverable can be rebuilt exactly.

## 6. End-to-end workflow

Example request: *"Voici ma vidéo et ma charte graphique. Transforme-la en publicité Instagram de 30 secondes avec un style premium et dynamique."*

```text
post-production (orchestrator skill)
│
├─ 1. bve init + bve ingest video.mp4 + assets         → project.json, hashes, probe, mezzanine
├─ 2. video-analysis     bve analyze --transcribe       → analysis.json, transcript.json, contact sheets
│                        Claude views contact sheets    → bve analysis annotate (labels, best shots)
├─ 3. brand-intelligence bve brand extract <assets>     → palette/fonts/logo facts
│                        Claude reads brand book/images → writes brand.json (motion personality…)
│                        bve brand validate / tokens    → preview of the Brand DNA
├─ 4. creative-director  (+ storytelling reference)     → plan/creative-plan.json
│                        bve plan validate              → shown to user for approval (unless told to proceed)
├─ 5. video-editing      bve plan compile               → timeline.json (silences cut, sections, reframe per target)
├─ 6. color-grading      bve color auto                 → color.json (correction) + brand grade; before/after stills
├─ 7. audio-cleanup      bve audio clean                → audio.json dialogue chains; before/after metrics
├─ 8. music              bve music add/duck             → audio.json music section, beat markers
├─ 9. subtitles          bve captions build             → captions.json (remapped to timeline, emphasis)
├─ 10. motion-brand      bve motion from-plan           → motion.json (CTA, titles, outro…) + preview frames
├─ 11. bve render --target ig_reels --draft             → review loop (Claude inspects frames, adjusts docs)
├─ 12. quality-control   bve qc --target ig_reels       → qc-report.json (blocking on fail)
└─ 13. export            bve export --target ig_reels   → exports/…mp4 (refused if QC failed)
```

Each step is a skill that can also be invoked alone. Each one ends with a validated document and an automatic version.

## 7. Rendering pipeline

```text
                 timeline + color + reframe[target]              audio.json
sources ──► [A] BASE PLATE (FFmpeg)                              ──► [C] AUDIO MIX (FFmpeg)
            trim/concat, CFR, crop/scale to target,                  dialogue chains, music,
            color correction + grade (eq/colorbalance/lut3d)          ducking (sidechaincompress),
            → renders/<hash>-base.mp4 (high-bitrate, muted)           loudnorm 2-pass, limiter
                          │                                           → renders/<hash>-mix.wav
                          ▼                                                    │
            [B] GRAPHICS (Remotion) — only if motion/captions exist            │
            <OffthreadVideo src=base/> + <Captions/> + <Motion…/>              │
            BrandTokens injected as props → renders/<hash>-comp.mp4 (muted)    │
                          │                                                    │
                          └──────────────► [D] MUX + ENCODE (FFmpeg) ◄─────────┘
                                          preset codec/bitrate/fps/color tags
                                          → renders/<target>-<version>.mp4 → QC → exports/
```

Why this approach:

- **Graphics are rendered over the base plate in one Remotion pass**, not as an alpha overlay composited later. Alpha intermediates (ProRes 4444) are huge, and a single pass keeps captions frame-accurate against the picture.
- **When there are no graphics, [B] is skipped** and the pipeline is FFmpeg-only, which is fast.
- **Each stage output is cached by `sha256(inputs + params + engineVersion)`.** Changing only the captions re-runs [B] and [D], not [A].
- **`--draft`** renders at half resolution with a fast preset, for review loops.

## 8. Brand DNA → motion

`brand.json` is **compiled** into `BrandTokens` (in `engine/brand`), and those tokens are the only props style source that components accept:

```ts
interface BrandTokens {
  color: { primary: string; secondary: string; accent: string; bg: string; fg: string; onPrimary: string };
  type: { display: FontSpec; body: FontSpec; caption: FontSpec };           // loaded via @remotion/fonts
  shape: { radius: number; style: 'none'|'line'|'block'|'pill'|'circle'; shadow: string };
  motion: {
    enterFrames: number; exitFrames: number; staggerFrames: number;          // from speed × fps
    easing: (t: number) => number; spring?: SpringConfig;                    // from easing
    distancePx: number; scaleFrom: number; overshoot: number;                // from amplitude × energy
    transition: 'cut'|'fade'|'slide'|'wipe'|'mask'|'zoom'|'blur';
  };
  layout: { density: 'airy'|'balanced'|'dense'; composition: string; safe: SafeZone };
}
```

The mapping is deterministic and lives in one table, `engine/brand/src/tokens.ts`, so it can be tested and reviewed. For example:

| Brand DNA | Minimal / premium | Dynamic / energetic |
|---|---|---|
| `motion.speed` | slow: enter 24 f @30 fps | fast: enter 8 f |
| `motion.easing` | decelerate cubic | spring-snappy with overshoot |
| `motion.amplitude` | subtle: 12 px travel, no scale | bold: 120 px travel, scale 0.8→1 |
| `visual.shapes` | line accents | solid blocks / pills |
| `energy` | no stagger, no secondary motion | per-word stagger, secondary bounce |

Components choose **variants** from tokens instead of hard-coding a look. For example, `Title` with `shapes: line` animates a hairline rule and a fade-up, while `shapes: block` wipes a solid color block that reveals the text.

## 9. Multi-format and smart reframing

- The timeline is format-agnostic. `timeline.reframe[targetId]` holds crop-window keyframes for each clip.
- **Reframe modes:**
  - `face` tracks faces with MediaPipe and smooths the crop path (Phase 2).
  - `subject` uses Claude-annotated points of interest on keyframes.
  - `center` is a static center crop.
  - `fit-blur` letterboxes over a blurred background. It is the fallback for wide shots that are not faces.
- **Presets** (`presets/<platform>/<name>.json`) define resolution, fps, codec, bitrate, loudness target, max duration and **safe zones**. Safe zones are the insets where the platform UI covers the video: the TikTok and Reels right rail and bottom caption area, and the YouTube progress bar.
- Captions and motion anchors (`safe-bottom`, `lower-third`, `auto`) resolve against the target's safe zone at render time. Text is measured with `@remotion/layout-utils` so QC can prove that nothing overflows.

## 10. Module interfaces (Phase 1)

```ts
// engine/core
interface ProjectStore {
  open(dir: string): Promise<Project>;                       // validates project.json
  read<K extends DocKey>(key: K): Promise<Docs[K]>;          // validated against schema
  write<K extends DocKey>(key: K, doc: Docs[K], meta: CommitMeta): Promise<VersionId>; // validate → atomic write → auto-commit
  resolve(rel: RelPath): AbsPath;                            // rejects traversal / writes into source/
}
interface VersionStore {
  commit(meta: CommitMeta): Promise<VersionId>;
  list(): Promise<VersionMeta[]>;
  undo(): Promise<VersionId>;                                // creates a revert version
  checkout(id: VersionId): Promise<VersionId>;
  diff(a: VersionId, b: VersionId): Promise<DocDiff[]>;
}
interface StageContext { project: Project; log: Logger; tmp: TempDir; signal: AbortSignal; progress(p: number, msg?: string): void; }
class BveError extends Error { code: ErrorCode; hint?: string; details?: unknown } // every CLI error → { ok:false, code, message, hint }

// engine/ffmpeg
interface Ffmpeg {
  probe(path: AbsPath): Promise<Probe>;
  run(args: FfArgs, ctx: StageContext): Promise<FfResult>;   // progress, cancellation, stderr capture
  analyze<T>(filter: AnalysisFilter<T>, input: AbsPath, ctx: StageContext): Promise<T>; // scdet, ebur128, silencedetect…
}
class FilterGraph { /* typed builder → string; escapes Windows paths correctly */ }

// engine/transcription
interface TranscriptionProvider {
  id: string;
  transcribe(input: AbsPath, opts: { language?: string; model: string; wordTimestamps: true }, ctx: StageContext): Promise<TranscriptSource>;
}

// engine/brand
function compileTokens(brand: Brand, fps: number, preset: Preset): BrandTokens;
function extractPalette(image: AbsPath, k?: number): Promise<ColorToken[]>;

// engine/rendering
interface RenderStage<I, O> { name: string; cacheKey(i: I): string; run(i: I, ctx: StageContext): Promise<O>; }
function renderTarget(project: Project, targetId: string, opts: { draft?: boolean }): Promise<RenderResult>;

// engine/qc
interface QcCheck { id: string; category: QcCategory; severity: Severity; run(ctx: QcContext): Promise<QcCheckResult>; }
```

The CLI contract for Claude is:

- With `--json`, stdout holds exactly one JSON object: `{ ok: true, data, version?, warnings[] }` or `{ ok: false, code, message, hint }`.
- Exit codes are `0` for ok, `2` for validation, `3` for missing input, `4` for tool missing, `5` for a QC block, and `1` for anything else.

## 11. Security and robustness

- **No secrets needed.** `.env.example` only documents optional paths: `FFMPEG_PATH`, `BVE_PYTHON`, `WHISPER_MODEL_DIR` and `REMOTION_CONCURRENCY`.
- **Paths are safe.** Every path in a document is a `relPath` (the schema rejects absolute paths and `..`). The engine resolves it inside the project root. FFmpeg is always spawned with an argument array, never a shell string.
- **Large files are handled safely.**
  - Media is streamed, never loaded into memory.
  - Analysis runs on proxies.
  - Free disk space is checked before a render.
  - Temp dirs are scoped per command and removed in `finally`.
  - `bve clean` purges `.cache/` and `renders/`.
- **Inputs are validated.** Ingest checks the container and codec whitelist and runs ffprobe before accepting a file. Fonts and images are type-checked by magic bytes.
- **`bve doctor`** checks the FFmpeg version and the required filters and libs (libass, arnndn, zscale), Node, the Python venv, the whisper model and Remotion's browser.
