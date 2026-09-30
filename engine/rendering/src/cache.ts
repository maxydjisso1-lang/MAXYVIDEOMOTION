import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { copyFile, link, mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENGINE_VERSION, existsSync, REPO_ROOT, sha256File, sha256Json, type Project } from "../../core/src/index.js";

let codeHash: string | undefined;

/**
 * Fingerprint of the engine source code. Any change to how a stage renders (filters, layout,
 * components) changes every cache key, with no manual version bump to forget.
 */
export function engineCodeHash(): string {
  if (codeHash) return codeHash;
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|py)$/.test(e.name)) h.update(p.slice(REPO_ROOT.length)).update(readFileSync(p));
    }
  };
  for (const m of ["core", "ffmpeg", "brand", "editing", "color", "audio", "captions", "motion", "remotion", "rendering"]) walk(join(REPO_ROOT, "engine", m, "src"));
  codeHash = h.digest("hex").slice(0, 16);
  return codeHash;
}

/** Content-addressed stage cache: same inputs + same engine code -> same key -> reuse the file. */
export function stageKey(stage: string, inputs: unknown): string {
  return sha256Json({ stage, engine: ENGINE_VERSION, code: engineCodeHash(), inputs }).slice(0, 20);
}

/** Hash the CONTENT of referenced files (logo, LUT, fonts): same path, new file -> new key. */
export async function fileHashes(project: Project, rels: (string | undefined)[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of rels) {
    if (!rel) continue;
    const abs = project.abs(rel);
    out[rel] = existsSync(abs) ? await sha256File(abs) : "missing";
  }
  return out;
}

/**
 * Produce `rel` with `make(tmpAbs)` unless it already exists. Writes to a unique temp name and
 * renames, so an interrupted or concurrent render never leaves a file that looks cached.
 */
export async function cached(project: Project, rel: string, make: (tmpAbs: string) => Promise<void>): Promise<{ path: string; hit: boolean }> {
  const abs = project.writable(rel);
  if (existsSync(abs)) return { path: abs, hit: true };
  await mkdir(dirname(abs), { recursive: true });
  const ext = rel.slice(rel.lastIndexOf("."));
  const tmp = `${abs}.${randomBytes(4).toString("hex")}.partial${ext}`;
  await make(tmp);
  await rename(tmp, abs);
  return { path: abs, hit: false };
}

export async function linkOrCopy(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  if (existsSync(dest)) return;
  try {
    await link(src, dest);
  } catch {
    await copyFile(src, dest);
  }
}
