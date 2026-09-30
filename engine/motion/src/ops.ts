import type { MotionDoc, Project } from "../../core/src/index.js";
import { motionFromPlan } from "./fromPlan.js";

/** Project operation: motion instances requested by the plan, timed and styled by the tokens. */
export async function motionFromProjectPlan(project: Project): Promise<MotionDoc> {
  const doc = motionFromPlan(await project.readDoc("plan"), await project.readDoc("timeline"), await project.readDoc("styleTokens"));
  await project.writeDoc("motion", doc, { command: "motion from-plan", message: `Motion: ${doc.instances.length} instances` });
  return doc;
}
