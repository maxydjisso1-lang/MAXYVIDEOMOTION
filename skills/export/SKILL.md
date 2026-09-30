---
name: export
description: Render and deliver final files per platform preset (YouTube 16:9, TikTok 9:16, Instagram Reels 9:16 / 1:1 / 4:5, LinkedIn 16:9, advertising/broadcast) with smart reframing, safe-zone aware layout, correct codecs and loudness, plus caption sidecars and thumbnails. Use when the user wants the final video, other formats, multiple versions, or "export / exporte / livre".
---

# export

## Purpose
Turn a QC-passed render into deliverables. Also generate the other formats from the **same edit**, re-laid out rather than just resized: the crop follows the subject, and captions, CTA and logo move to that format's safe zones.

## Inputs
- A project at a given version, its targets and presets
- The QC report for each target

## Outputs
- `exports/<project>-<target>-<version>.mp4`
- Optional `.srt`/`.vtt` and `thumbnail.jpg`
- An entry in `project.json.exports` with its sha256 and QC report path

## Tools
- `bve target add <id> --preset <platform/name>` / `bve target list`. See `presets/` for all presets.
- `bve render --target <id>` renders the final quality.
- `bve export --target <id>|--all [--sidecars srt,vtt] [--thumbnail <sec>]` **refuses when QC is missing or failed** for that exact render.
- `bve frames --target <id> --at hook,cta` lets you visually check each format.

### Presets (Phase 1)
| Preset | Size | fps | Video | Audio | Loudness |
|---|---|---|---|---|---|
| youtube/landscape | 1920×1080 | source (≤60) | H.264 High, ~16 Mbps | AAC 320k | −14 LUFS |
| tiktok/vertical | 1080×1920 | 30 | H.264 High, ~12 Mbps | AAC 256k | −14 LUFS |
| instagram/reels | 1080×1920 | 30 | H.264 High, ~12 Mbps | AAC 256k | −14 LUFS |
| instagram/square | 1080×1080 | 30 | H.264 High | AAC 256k | −14 LUFS |
| instagram/portrait | 1080×1350 | 30 | H.264 High | AAC 256k | −14 LUFS |
| linkedin/landscape | 1920×1080 | 30 | H.264 High | AAC 256k | −14 LUFS |
| advertising/broadcast | 1920×1080 | 25 | ProRes 422 HQ | PCM 48k | −23 LUFS (EBU R128) |

## Workflow
1. For each new format: run `bve target add`, then `bve reframe --target <id>` (see video-editing). Captions and motion re-layout automatically from their anchors.
2. Render a draft and check frames at the hook, a caption-dense moment and the CTA. Look at them for each format.
3. Run the final render, then QC (the quality-control skill), then `bve export`.
4. Give the user the list of files with their duration, size and QC status.

## Constraints
- Export is never allowed without a passing (or user-waived) QC on the same render hash.
- Exports are immutable. Re-exporting creates a new file with the new version in its name.
- Never overwrite or write next to the user's source files.

## Examples
- "Exporte aussi en carré et en 16:9 pour LinkedIn" → add `instagram/square` + `linkedin/landscape`, reframe (`fit-blur` for wide shots in the square format), check the frames, QC and export.
- "Fais-moi une version 15 s" → This is a new plan variant, so hand back to creative-director (duration 15). It gets its own targets and exports.

## Failure handling
- `QC_BLOCKED` (exit 5): relay the blocking checks and route them to the owning skill.
- Disk space is low (`DISK_SPACE`): suggest `bve clean` (removes caches and intermediate renders, never sources or exports).
- A preset is unknown: list the available presets and offer to create a custom one under `presets/`.
