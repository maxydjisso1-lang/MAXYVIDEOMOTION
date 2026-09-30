import { mkdir } from "node:fs/promises";
import { readRenderRecord, type Project } from "../../core/src/index.js";
import { extractFrame } from "../../ffmpeg/src/index.js";

/** Stills from the current render, for Claude to look at. */
export async function extractRenderFrames(project: Project, targetId: string, seconds: number[], opts: { draft?: boolean; width?: number } = {}): Promise<string[]> {
  const rec = await readRenderRecord(project, targetId, { draft: !!opts.draft });
  await mkdir(project.abs("renders/frames"), { recursive: true });
  const out: string[] = [];
  for (const s of seconds) {
    const at = Math.min(Math.max(0, s), Math.max(0, rec.durationSec - 0.04));
    const rel = `renders/frames/${targetId}-${project.head}-${at.toFixed(2)}.jpg`;
    await extractFrame(project.abs(rec.path), at, project.writable(rel), { width: opts.width ?? 540, log: project.log });
    out.push(rel);
  }
  return out;
}
