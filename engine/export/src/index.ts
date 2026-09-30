import { writeFile } from "node:fs/promises";
import { BveError, importFile, qcReportPath, readQcReport, readRenderRecord, sha256File, toProjectRel, type Captions, type Project } from "../../core/src/index.js";

function stamp(sec: number, sep: "," | "."): string {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
}

export function toSrt(c: Captions): string {
  return c.cues.map((cue, i) => `${i + 1}\n${stamp(cue.start, ",")} --> ${stamp(cue.end, ",")}\n${cue.words.map((w) => w.text + (w.lineBreakAfter ? "\n" : " ")).join("").trim()}\n`).join("\n");
}

export function toVtt(c: Captions): string {
  return `WEBVTT\n\n${c.cues.map((cue) => `${stamp(cue.start, ".")} --> ${stamp(cue.end, ".")}\n${cue.words.map((w) => w.text + (w.lineBreakAfter ? "\n" : " ")).join("").trim()}\n`).join("\n")}`;
}

/** Deliver a render. Refuses unless QC ran on this exact file at this version and has no blocker. */
export async function exportTarget(project: Project, targetId: string, opts: { sidecars?: ("srt" | "vtt")[] } = {}) {
  const rec = await readRenderRecord(project, targetId);
  const qcRel = qcReportPath(rec.path);
  const qc = await readQcReport(project, rec.path);
  if (!qc) throw new BveError("QC_BLOCKED", "Quality control has not been run on this render", { hint: `bve qc --target ${targetId}` });
  if (qc.status === "fail") {
    const blockers = Object.values(qc.categories).flatMap((c) => c.checks).filter((c) => c.status === "fail" && c.severity === "blocker");
    throw new BveError("QC_BLOCKED", `Export refused: ${blockers.length} blocking QC issue(s): ${blockers.map((b) => b.id).join(", ")}`, { details: blockers, hint: "Fix them through the owning skill, re-render and re-run QC." });
  }
  const sha = await sha256File(project.abs(rec.path));
  if (sha !== rec.sha256 || qc.renderPath !== rec.path || qc.version !== project.head) {
    throw new BveError("QC_BLOCKED", "The render changed after QC", { hint: `bve qc --target ${targetId}` });
  }
  const ext = rec.path.slice(rec.path.lastIndexOf("."));
  const outRel = `exports/${project.manifest.id.replace(/^p_/, "")}-${targetId}-${project.head}${ext}`;
  await importFile(project.abs(rec.path), project.writable(outRel));
  const files = [outRel];
  const captions = await project.readDocOptional("captions");
  for (const kind of opts.sidecars ?? []) {
    if (!captions) break;
    const rel = outRel.replace(ext, `.${kind}`);
    await writeFile(project.writable(rel), kind === "srt" ? toSrt(captions) : toVtt(captions), "utf8");
    files.push(rel);
  }
  const entry = {
    id: `${targetId}_${project.head}`,
    targetId,
    version: project.head,
    path: outRel,
    sha256: sha,
    createdAt: new Date().toISOString(),
    qcReport: toProjectRel(project.root, project.abs(qcRel)),
  };
  project.manifest.exports = [...(project.manifest.exports ?? []).filter((e) => e.id !== entry.id), entry];
  await project.saveManifest();
  return { ...entry, files, qcStatus: qc.status };
}
