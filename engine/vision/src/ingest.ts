import { mkdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { BveError, existsSync, importFile, sha256File, slugId, uniqueId, type Project, type Source } from "../../core/src/index.js";
import { ffmpeg, probe } from "../../ffmpeg/src/index.js";

export const MEDIA_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mxf", ".wav", ".mp3", ".m4a", ".aac", ".flac"]);

export async function ingestSource(project: Project, file: string, role: Source["role"] = "a-roll"): Promise<Source> {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new BveError("MISSING_INPUT", `File not found: ${file}`, { hint: "Check the path; wrap paths containing spaces in quotes." });
  const ext = extname(abs).toLowerCase();
  if (!MEDIA_EXT.has(ext)) {
    throw new BveError("UNSUPPORTED", `Unsupported media type "${ext}"`, { hint: `Supported: ${[...MEDIA_EXT].join(" ")}` });
  }
  const info = await probe(abs);
  if (!info.hasVideo && !info.hasAudio) throw new BveError("UNSUPPORTED", `${basename(abs)} has no audio or video stream`);
  if (info.durationSec <= 0) throw new BveError("UNSUPPORTED", `${basename(abs)} has no measurable duration`);

  const id = uniqueId(slugId(basename(abs), "src_"), new Set(project.manifest.sources.map((s) => s.id)));
  const destRel = `source/${id}${ext}`;
  const dest = project.abs(destRel);
  if (existsSync(dest)) throw new BveError("PROJECT_EXISTS", `${destRel} already exists`);
  await importFile(abs, dest);

  // Per-stream durations are useful to QC but not part of the stored contract.
  const { videoDurationSec: _v, audioDurationSec: _a, ...stored } = info;
  const source: Source = {
    id,
    path: destRel,
    originalPath: abs,
    sha256: await sha256File(dest),
    bytes: (await stat(dest)).size,
    role,
    probe: stored,
  };

  // Variable frame rate (typical of phones) drifts once cut: edit from a CFR mezzanine instead.
  if (info.hasVideo && info.fpsMode === "vfr") {
    const fps = Math.round(info.fps ?? 30);
    const mezzRel = `.cache/mezzanine/${id}.mp4`;
    await mkdir(project.abs(".cache/mezzanine"), { recursive: true });
    await ffmpeg(["-i", dest, "-r", String(fps), "-c:v", "libx264", "-preset", "fast", "-crf", "12", "-c:a", "aac", "-b:a", "256k", project.abs(mezzRel)], { log: project.log });
    source.mezzanine = mezzRel;
    project.log.info({ id, fps }, "VFR source: created CFR mezzanine");
  }

  project.manifest.sources.push(source);
  await project.saveManifest();
  return source;
}
