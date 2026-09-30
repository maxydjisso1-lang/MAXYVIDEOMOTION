import { copyFile, link, mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { BveError } from "./errors.js";
import { existsSync, sha256File } from "./fsutil.js";
import { slugId, toProjectRel } from "./paths.js";
import type { Project } from "./project.js";
import type { Asset } from "./types.generated.js";

export const ASSET_EXT: Record<Asset["kind"], Set<string>> = {
  logo: new Set([".png", ".svg", ".webp"]),
  image: new Set([".png", ".jpg", ".jpeg", ".webp"]),
  font: new Set([".ttf", ".otf", ".woff", ".woff2"]),
  music: new Set([".wav", ".mp3", ".m4a", ".aac", ".flac"]),
  sfx: new Set([".wav", ".mp3", ".m4a"]),
  lut: new Set([".cube"]),
  video: new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]),
  brandbook: new Set([".pdf"]),
  reference: new Set([".png", ".jpg", ".jpeg", ".pdf", ".mp4", ".mov"]),
};

/** Hard link when possible (same volume: instant, no extra space), else copy. The original is never touched. */
export async function importFile(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await link(src, dest);
  } catch {
    await copyFile(src, dest);
  }
}

export function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
}

/** Register (and import when outside the project) a logo, font, music track, LUT… */
export async function addAsset(project: Project, file: string, kind: Asset["kind"], opts: { as?: string; license?: string } = {}): Promise<Asset> {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new BveError("MISSING_INPUT", `File not found: ${file}`);
  const ext = extname(abs).toLowerCase();
  if (!ASSET_EXT[kind]?.has(ext)) throw new BveError("UNSUPPORTED", `"${ext}" is not a valid ${kind} file`, { hint: `Accepted: ${[...(ASSET_EXT[kind] ?? [])].join(" ")}` });
  const dest = project.writable(opts.as ?? `assets/${kind}s/${basename(abs)}`);
  if (resolve(dest) !== abs && !existsSync(dest)) await importFile(abs, dest);
  const rel = toProjectRel(project.root, dest);
  const assets = (project.manifest.assets ??= []);
  const existing = assets.find((a) => a.path === rel);
  const asset: Asset = existing ?? { id: uniqueId(slugId(basename(abs), `${kind}_`), new Set(assets.map((a) => a.id))), kind, path: rel };
  asset.sha256 = await sha256File(dest);
  if (opts.license) asset.license = opts.license;
  if (!existing) assets.push(asset);
  await project.saveManifest();
  return asset;
}
