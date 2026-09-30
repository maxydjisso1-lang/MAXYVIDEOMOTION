/**
 * Render-side artifacts shared by rendering, QC and export. Every read and write goes through
 * its schema: no module can bypass these contracts.
 */
import { join } from "node:path";
import { BveError } from "./errors.js";
import { existsSync, readJson, writeJsonAtomic } from "./fsutil.js";
import type { Project } from "./project.js";
import type { QcReport, QcWaivers, RenderRecord } from "./types.generated.js";
import { validate } from "./validate.js";

export const renderRecordPath = (targetId: string, version: string, draft: boolean) => `renders/${targetId}-${version}${draft ? "-draft" : ""}.render.json`;
export const qcReportPath = (renderPath: string) => renderPath.replace(/\.(mp4|mov)$/, ".qc.json");
export const WAIVERS_PATH = "exports/qc-waivers.json";

export async function writeRenderRecord(project: Project, record: RenderRecord): Promise<string> {
  validate<RenderRecord>("render-record", record, "render record");
  const rel = renderRecordPath(record.targetId, record.version, record.draft);
  await writeJsonAtomic(project.writable(rel), record);
  return rel;
}

export async function readRenderRecord(project: Project, targetId: string, opts: { draft?: boolean } = {}): Promise<RenderRecord> {
  const rel = renderRecordPath(targetId, project.head, !!opts.draft);
  if (!existsSync(join(project.root, rel))) {
    throw new BveError("MISSING_INPUT", `No ${opts.draft ? "draft " : ""}render of "${targetId}" at the current version ${project.head}`, { hint: `Run \`bve render --target ${targetId}${opts.draft ? " --draft" : ""}\` first.` });
  }
  return validate<RenderRecord>("render-record", await readJson(project.abs(rel)), rel);
}

export async function writeQcReport(project: Project, report: QcReport): Promise<string> {
  validate<QcReport>("qc-report", report, "QC report");
  const rel = qcReportPath(report.renderPath);
  await writeJsonAtomic(project.writable(rel), report);
  return rel;
}

export async function readQcReport(project: Project, renderPath: string): Promise<QcReport | undefined> {
  const rel = qcReportPath(renderPath);
  if (!existsSync(project.abs(rel))) return undefined;
  return validate<QcReport>("qc-report", await readJson(project.abs(rel)), rel);
}

export async function readWaivers(project: Project): Promise<QcWaivers> {
  if (!existsSync(project.abs(WAIVERS_PATH))) return [];
  return validate<QcWaivers>("qc-waivers", await readJson(project.abs(WAIVERS_PATH)), WAIVERS_PATH);
}

export async function addWaiver(project: Project, checkId: string, reason: string): Promise<QcWaivers> {
  const list = [...(await readWaivers(project)), { checkId, reason: reason.trim(), at: new Date().toISOString() }];
  validate<QcWaivers>("qc-waivers", list, "waiver");
  await writeJsonAtomic(project.writable(WAIVERS_PATH), list);
  return list;
}
