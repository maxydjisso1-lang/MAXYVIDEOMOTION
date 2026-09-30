/** Project-level editing operations (read documents → pure function → validated, versioned write). */
import { readJson, validate, type CreativePlan, type Project, type Timeline } from "../../core/src/index.js";
import { compilePlan, estimatePlan, timelineContext } from "./compile.js";
import { deleteClip, ensureReframes, setReframe, trimClip } from "./ops.js";

export function timelineSummary(tl: Timeline) {
  return {
    durationSec: tl.durationSec,
    fps: tl.fps,
    clips: tl.tracks.video.flatMap((t) => t.clips).map((c) => ({ id: c.id, src: `${c.sourceId} ${c.sourceIn}-${c.sourceOut}`, at: c.timelineStart, section: c.sectionId, zoom: c.zoom?.[0]?.scale, reason: c.reason })),
    markers: tl.markers,
  };
}

/** Install a creative plan: schema + reference resolution are checked BEFORE anything is written. */
export async function setPlan(project: Project, file: string) {
  const plan = validate<CreativePlan>("creative-plan", await readJson(file), file);
  const estimate = estimatePlan(plan, await timelineContext(project));
  await project.writeDoc("plan", plan, { command: "plan set", message: `Creative plan: ${plan.narrative.structure}, ${plan.targetDurationSec}s` });
  return estimate;
}

export async function estimateProjectPlan(project: Project) {
  return estimatePlan(await project.readDoc("plan"), await timelineContext(project));
}

export async function compileProjectPlan(project: Project): Promise<Timeline> {
  const plan = await project.readDoc("plan");
  const tl = await ensureReframes(project, compilePlan(plan, await timelineContext(project), await project.deliveryFps()));
  await project.writeDoc("timeline", tl, { command: "plan compile", message: `Timeline compiled: ${tl.tracks.video[0]!.clips.length} clips, ${tl.durationSec}s` });
  return tl;
}

export async function deleteClipInProject(project: Project, clipId: string): Promise<Timeline> {
  const tl = deleteClip(await project.readDoc("timeline"), clipId);
  await project.writeDoc("timeline", tl, { command: "edit delete", message: `Deleted clip ${clipId}` });
  return tl;
}

export async function trimClipInProject(project: Project, clipId: string, range: { in?: number; out?: number }): Promise<Timeline> {
  const tl = trimClip(await project.readDoc("timeline"), clipId, range);
  await project.writeDoc("timeline", tl, { command: "edit trim", message: `Trimmed clip ${clipId}` });
  return tl;
}

export async function reframeTarget(project: Project, targetId: string, mode: "center" | "fit-blur"): Promise<Timeline> {
  project.target(targetId);
  const tl = setReframe(await project.readDoc("timeline"), targetId, mode);
  await project.writeDoc("timeline", tl, { command: "reframe", message: `Reframe ${targetId}: ${mode}` });
  return tl;
}
