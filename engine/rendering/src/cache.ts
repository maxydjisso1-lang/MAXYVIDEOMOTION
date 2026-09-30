import { copyFile, link, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { ENGINE_VERSION, existsSync, sha256Json, type Project } from "../../core/src/index.js";

/** Bump when a render stage changes its output for identical inputs (invalidates caches). */
export const PIPELINE_REVISION = 2;

/** Content-addressed stage cache: same inputs -> same key -> reuse the file. */
export function stageKey(stage: string, inputs: unknown): string {
  return sha256Json({ stage, engine: ENGINE_VERSION, pipeline: PIPELINE_REVISION, inputs }).slice(0, 20);
}

/**
 * Produce `rel` with `make(tmpAbs)` unless it already exists. Writes to a temp name and renames,
 * so an interrupted render never leaves a truncated file that looks cached.
 */
export async function cached(project: Project, rel: string, make: (tmpAbs: string) => Promise<void>): Promise<{ path: string; hit: boolean }> {
  const abs = project.writable(rel);
  if (existsSync(abs)) return { path: abs, hit: true };
  await mkdir(dirname(abs), { recursive: true });
  const ext = rel.slice(rel.lastIndexOf("."));
  const tmp = `${abs}.partial${ext}`;
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
