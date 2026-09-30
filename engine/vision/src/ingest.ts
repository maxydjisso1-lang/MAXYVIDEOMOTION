import { copyFile, link, mkdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { BveError, existsSync, sha256File, slugId, toProjectRel, type Asset, type Project, type Source } from "../../core/src/index.js";
import { ffmpeg, probe } from "../../ffmpeg/src/index.js";

const MEDIA_EXT = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".mxf", ".wav", ".mp3", ".m4a", ".aac", ".flac"]);
const ASSET_EXT: Record<string, Set<string>> = {
  logo: new Set([".png", ".svg", ".webp"]),
  image: new Set([".png", ".jpg", ".jpeg", ".webp"]),
  font: new Set([".ttf", ".otf", ".woff", ".woff2"]),
  music: new Set([".wav", ".mp3", ".m4a", ".aac", ".flac"]),
  sfx: new Set([".wav", ".mp3", ".m4a"]),
  lut: new Set([".cube"]),
  video: MEDIA_EXT,
  brandbook: new Set([".pdf"]),
  reference: new Set([".png", ".jpg", ".jpeg", ".pdf", ".mp4", ".mov"]),
};

/** Hard link when possible (same volume: instant, no extra space), else copy. Originals are never touched. */
async function importFile(src: string, dest: string): Promise<void> {
  await mkdir(resolve(dest, ".."), { recursive: true });
  try {
    await link(src, dest);
  } catch {
    await copyFile(src, dest);
  }
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
}

export async function ingestSource(project: Project, file: string, role: Source["role"] = "a-roll"): Promise<Source> {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new BveError("MISSING_INPUT", `File not found: ${file}`);
  const ext = extname(abs).toLowerCase();
  if (!MEDIA_EXT.has(ext)) {
    throw new BveError("UNSUPPORTED", `Unsupported media type "${ext}"`, { hint: `Supported: ${[...MEDIA_EXT].join(" ")}` });
  }
  const info = await probe(abs);
  if (!info.hasVideo && !info.hasAudio) throw new BveError("UNSUPPORTED", `${file} has no audio or video stream`);

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

export async function addAsset(project: Project, file: string, kind: keyof typeof ASSET_EXT, opts: { as?: string; license?: string } = {}) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new BveError("MISSING_INPUT", `File not found: ${file}`);
  const ext = extname(abs).toLowerCase();
  if (!ASSET_EXT[kind]?.has(ext)) throw new BveError("UNSUPPORTED", `"${ext}" is not a valid ${kind} file`);
  const destRel = opts.as ?? `assets/${kind}s/${basename(abs)}`;
  const dest = project.writable(destRel);
  if (resolve(dest) !== abs) {
    if (!existsSync(dest)) await importFile(abs, dest);
  }
  const rel = toProjectRel(project.root, dest);
  const assets = (project.manifest.assets ??= []);
  const existing = assets.find((a) => a.path === rel);
  const asset: Asset = existing ?? { id: uniqueId(slugId(basename(abs), `${kind}_`), new Set(assets.map((a) => a.id))), kind: kind as Asset["kind"], path: rel };
  asset.sha256 = await sha256File(dest);
  if (opts.license) asset.license = opts.license;
  if (!existing) assets.push(asset);
  await project.saveManifest();
  return asset;
}

