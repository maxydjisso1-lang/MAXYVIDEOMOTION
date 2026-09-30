# brand-video-engine

> An open-source AI-native video post-production engine for Claude that understands brand identity and automatically applies it across editing, color, audio, captions and motion design.

```text
"Here is my video and my brand guidelines. Turn it into a premium, dynamic 30-second Instagram ad."
        │
        ▼
 Claude (skills)  ──►  Brand DNA  ──►  Style Tokens  ──►  deterministic rendering (FFmpeg + Remotion)  ──►  QC  ──►  export
```

**Status: Phase 1 (MVP vertical slice) — working end to end, tested on Windows.** See [Roadmap](#roadmap).

---

## What is it?

brand-video-engine is a set of **Claude Skills** plus a **CLI (`bve`)**. Claude handles the creative decisions: structure, hook, pacing, emphasis and on-screen copy. The engine executes them deterministically:
- analysis
- non-destructive editing
- color
- audio cleanup and loudness
- captions
- brand motion graphics
- quality control
- export

## Why is it different?

This is not "Claude + FFmpeg". The difference is a layer in between: **Brand DNA → Style Tokens**.

- `brand.json` (the Brand DNA) describes a brand's identity: colors, fonts, logo rules, visual language, **motion personality** (speed, easing, amplitude, transitions, energy), caption style, grade and tone.
- `bve` **compiles** it into `style-tokens.json`. This is a deterministic, reviewable translation into concrete values: frame counts, bezier curves or spring physics, travel distances, shapes, caption rhythm and color look.
- Motion components, captions and the color look accept **only** tokens. A minimal luxury brand therefore produces slow, restrained animation. An energetic street brand produces springy, bold animation. The creative plan and the edit stay the same.

The Phase 1 acceptance test proves it. It runs the same footage and the same plan with two brands:

| | Maison Lune (minimal, luxury) | Volt Street (energetic, urban) |
|---|---|---|
| Timeline | identical | identical |
| Motion | 24-frame decelerate curves, hairlines, fades, watermark | 8-frame springs with overshoot, pills, zoom transitions, staggered words |
| Captions | sentence case, up to 12 words per cue, gold emphasis | UPPERCASE, up to 6 words per cue, neon scale emphasis |
| Grade | filmic, muted | vibrant |
| End card | ivory `#F4EFE6` (measured in the render: ΔE 1.0) | night `#0A0A0A` |

## Architecture

```text
Decision layer   skills/*/SKILL.md      Claude: brief → Brand DNA, creative plan, emphasis, copy
Contract layer   schemas/*.schema.json  JSON Schema 2020-12, validated on every read/write
Execution layer  engine/* + bve CLI     FFmpeg, Remotion, Whisper — deterministic, no API keys
```

The render runs in three passes, each cached by a content hash:

1. **FFmpeg base plate**: cuts, color and reframing.
2. **Graphics**: Remotion, or the ASS/libass fallback, for motion and captions.
3. **FFmpeg**: audio cleanup, two-pass loudnorm and the final encode.

Full details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Installation

Requirements:
- Node ≥ 20
- FFmpeg ≥ 6.1 (a full build with libass)
- optional: `uv` for Whisper transcription

```bash
git clone <repo> brand-video-engine && cd brand-video-engine
npm install
# Windows: winget install Gyan.FFmpeg astral-sh.uv   ·   macOS: brew install ffmpeg uv   ·   Linux: apt install ffmpeg
npm link                  # puts the `bve` command on your PATH (or call `node bin/bve.js …`)
npm run doctor            # checks FFmpeg filters, Remotion browser, transcription
uv sync --project engine/python   # optional: Whisper (Python 3.12 venv is managed by uv)
```

The skills call `bve`, so it must be on the PATH of the shell Claude uses (`npm link` does that).

The first Remotion render downloads Chrome Headless Shell (~110 MB). No API key is needed anywhere. [.env.example](.env.example) lists the optional settings.

**Use it with Claude Code:** the repository is a Claude Code plugin (`.claude-plugin/plugin.json` + `skills/`). Install it as a plugin, or copy `skills/` into your project's `.claude/skills/`.

## Claude Skills

| Skill | Role |
|---|---|
| `post-production` | Entry point: orchestrates the whole pipeline |
| `video-analysis` | Measures shots, exposure, silences, loudness and noise; transcribes; Claude labels shots from contact sheets |
| `brand-intelligence` | Builds `brand.json` from logos, brand books and references |
| `creative-director` | Writes `creative-plan.json` from the brief, the analysis and the brand |
| `storytelling` | Reference for structures, hooks and platform norms |
| `video-editing` | Plan → timeline: silence and filler removal, word-safe cuts, punch-ins, reframing |
| `color-grading` | Correction (measured) plus grade (brand) |
| `audio-cleanup` | Denoise, EQ, compression, de-essing, loudness |
| `music` | Music bed and ducking (beat sync is Phase 2) |
| `subtitles` | Word-level captions styled by the brand |
| `motion-brand` | Brand motion components |
| `quality-control` | Blocking QC before export |
| `export` | Delivery per platform preset, plus SRT/VTT |

## CLI

Every command accepts `--project <dir>` and `--json`. With `--json`, stdout holds exactly one `{ ok, data | code, message, hint }` object. Exit codes are:
- `2` validation
- `3` missing input
- `4` missing tool
- `5` QC blocked

```bash
bve init my-ad --name "My ad"
bve -p my-ad ingest talk.mp4
bve -p my-ad target add ig_reels --preset instagram/reels
bve -p my-ad brand set examples/brands/maison-lune        # brand.json + assets → style tokens
bve -p my-ad analyze --transcribe --language fr            # or: transcript import <file>
bve -p my-ad plan set plan.json && bve -p my-ad plan compile
bve -p my-ad color auto && bve -p my-ad audio clean
bve -p my-ad captions build && bve -p my-ad motion from-plan
bve -p my-ad render --target ig_reels [--draft] [--renderer auto|remotion|ass]
bve -p my-ad qc --target ig_reels
bve -p my-ad export --target ig_reels --sidecars srt,vtt
bve -p my-ad version list | version undo | version checkout v0007
```

Other commands:
- `doctor`
- `asset add`
- `analysis summary|annotate`
- `transcript show`
- `brand tokens|validate`
- `plan validate|estimate`
- `timeline show`
- `edit delete|trim`
- `reframe --mode center|fit-blur`
- `motion list`
- `frames`
- `qc waive` (a user decision only)
- `version diff`
- `doc get|set` (validated, versioned edit of any document)

## Brand DNA

See [schemas/brand.schema.json](schemas/brand.schema.json) and the two example kits in [examples/brands/](examples/brands/). Every inferred field carries `provenance` (`user | extracted | inferred | default`, confidence and evidence), so Claude can explain each choice and ask the user to confirm uncertain ones.

## Motion engine

Phase 1 ships these Remotion components:
- `Title`
- `CTA`
- `LowerThird`
- `Watermark`
- `BrandOutro` (with `BrandIntro`/`LogoReveal` aliases)
- `Transition`
- brand captions

Each component picks its **variant** from `tokens.shape.style` (line, block or pill) and its **motion** from `tokens.motion`. Motion is either a bezier curve or a spring, with its own duration, travel distance, overshoot and stagger.

Layout math (safe zones, text fitting and anchors) lives in one pure module, `engine/motion/src/layout.ts`. Remotion, the ASS fallback renderer and QC all use it, so what QC checks is what the renderers draw.

## Presets

`instagram/reels`, `instagram/square`, `instagram/portrait`, `tiktok/vertical`, `youtube/landscape`, `linkedin/landscape`, `advertising/broadcast`. Each preset defines geometry, codec, loudness and the **safe zones** of the platform UI.

## Licensing

brand-video-engine is **MIT**.

**Remotion is not MIT.** It is free for individuals and for companies of up to 3 people. Larger organizations need a [Remotion company license](https://www.remotion.dev/license). The engine does not work around those terms. It detects whether Remotion is available and, when it is not, renders with the built-in **ASS/libass fallback** (`--renderer ass`). The fallback keeps the same tokens and layout, but has simpler animation: no springs and no per-word stagger. QC reports which renderer was used.

## Development

```bash
npm run typecheck
npm run gen:types     # regenerate TS types from schemas/ (single source of truth)
npm run fixtures      # synthetic test media (FFmpeg lavfi) + example logos
```

Project layout, module interfaces and design decisions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Testing

```bash
npm run test:unit     # ~40 fast tests: tokens, schemas, versioning, editing, captions, layout, audio, color
npm run test:e2e      # full renders: brand A/B, QC gating, export, undo, source integrity, ASS fallback (~5–8 min)
```

The test media is synthetic and generated by FFmpeg, with known properties: a shot cut at 7.0 s, an underexposed second shot, speech-like bursts with 1 s silences, pink noise and a filler word. No video files are committed.

## Roadmap

- **Phase 1 (done):** the vertical slice. It covers:
  - project format and snapshot versioning
  - analysis
  - plan compiler
  - color and audio
  - captions
  - 6 motion components
  - QC and export
  - Remotion plus the ASS fallback
  - 13 skills
- **Phase 2:**
  - face-tracking smart reframing (MediaPipe)
  - the remaining motion components (Quote, Statistic, ProductReveal, FeatureCard, Callout)
  - beat detection and beat-synced cuts
  - shot matching across cameras
  - dereverb
  - embedded Google Fonts
  - multi-version cutdowns
- **Phase 3:**
  - Brand DNA from URL and PDF brand books
  - MCP server adapter
  - OpenTimelineIO export
  - web preview UI
