#!/usr/bin/env node
/**
 * bve — the execution layer Claude drives.
 *
 * This file only parses arguments and prints the JSON envelope. Every behaviour lives in an
 * engine/core function (Schema → Core → Engine → CLI), so it is reusable and testable.
 */
import { Command, Option } from "commander";
import {
  addAsset, BveError, createLogger, DOC_SPECS, ENGINE_VERSION, isDocKey, Project, readJson, type Asset, type DocKey, type VersionId,
} from "../../core/src/index.js";
import { cleanProjectAudio, type CleanupPreset } from "../../audio/src/index.js";
import { checkBrand, recompileTokens, setBrand, type BrandFontsReport } from "../../brand/src/index.js";
import { buildProjectCaptions } from "../../captions/src/index.js";
import { colorAutoProject } from "../../color/src/index.js";
import {
  compileProjectPlan, deleteClipInProject, estimateProjectPlan, reframeTarget, setPlan, timelineSummary, trimClipInProject,
} from "../../editing/src/index.js";
import { exportTarget } from "../../export/src/index.js";
import { binaries, capabilities } from "../../ffmpeg/src/index.js";
import { motionFromProjectPlan } from "../../motion/src/index.js";
import { formatQc, runQc, waive } from "../../qc/src/index.js";
import { extractRenderFrames, remotionStatus, renderTarget, type RendererChoice } from "../../rendering/src/index.js";
import { fasterWhisper, importTranscript, listSegments, listSentences, transcribeProject, transcriptionReport } from "../../transcription/src/index.js";
import { analyzeProject, annotateAnalysis, ingestSource, summarizeAnalysis, type ShotAnnotation } from "../../vision/src/index.js";
import { fetchBrandFonts } from "../../brand/src/index.js";
import { emit, failure } from "./output.js";

const program = new Command();
program
  .name("bve")
  .description("brand-video-engine — AI-native, brand-aware video post-production (driven by Claude skills)")
  .version(ENGINE_VERSION)
  .option("-p, --project <dir>", "project directory", ".")
  .option("--json", "print a single JSON envelope on stdout (for Claude)", false);

const g = () => program.opts<{ project: string; json: boolean }>();

/** Open the project, run, print the envelope, map errors to exit codes. */
function action<A extends unknown[]>(fn: (project: Project, ...args: A) => Promise<unknown>, human?: (data: any) => string) {
  return async (...args: A) => {
    const { project: dir, json } = g();
    try {
      const project = await Project.open(dir, createLogger({ projectRoot: dir }));
      const data = await fn(project, ...args);
      emit(json, { ok: true, data, version: project.head }, human?.(data));
    } catch (err) {
      const { env, exitCode } = failure(err);
      emit(json, env);
      process.exitCode = exitCode;
    }
  };
}

const num = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BveError("VALIDATION", `"${v}" is not a number`);
  return n;
};

// ------------------------------------------------------------------ setup

program.command("doctor").description("check FFmpeg, filters, Remotion and transcription").action(async () => {
  const report: Record<string, unknown> = { engine: ENGINE_VERSION, node: process.version };
  try {
    const b = binaries();
    const c = capabilities();
    const needed = ["ass", "afftdn", "loudnorm", "ebur128", "scdet", "signalstats", "silencedetect", "blackdetect", "sidechaincompress", "colorbalance", "curves", "lut3d"];
    report.ffmpeg = { path: b.ffmpeg, version: c.version, missingFilters: needed.filter((f) => !c.filters.has(f)) };
  } catch (err) {
    report.ffmpeg = { error: (err as BveError).message, hint: (err as BveError).hint };
  }
  const rs = await remotionStatus();
  report.remotion = rs.available
    ? { available: true, note: "Remotion is free for individuals and companies of up to 3 people; larger organizations need a company license (remotion.dev/license)." }
    : { available: false, reason: rs.reason, fallback: "ASS/libass renderer" };
  report.transcription = { fasterWhisper: await fasterWhisper.available(), hint: "uv sync --project engine/python" };
  emit(g().json, { ok: true, data: report });
});

program.command("init <dir>").description("create a project").option("--name <name>", "project name").action(async (dir: string, o: { name?: string }) => {
  try {
    const p = await Project.init(dir, o.name ?? dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "project");
    emit(g().json, { ok: true, data: { root: p.root, id: p.manifest.id }, version: p.head }, `Project created at ${p.root}`);
  } catch (err) {
    const { env, exitCode } = failure(err);
    emit(g().json, env);
    process.exitCode = exitCode;
  }
});

program.command("ingest <files...>").description("register source media (hashed, never modified)")
  .addOption(new Option("--role <role>").choices(["a-roll", "b-roll", "music", "voiceover", "other"]).default("a-roll"))
  .action(action(async (p, files: string[], o: { role: "a-roll" }) => {
    const out = [];
    for (const f of files) out.push(await ingestSource(p, f, o.role));
    return out.map((s) => ({ id: s.id, path: s.path, durationSec: s.probe.durationSec, hasVideo: s.probe.hasVideo, hasAudio: s.probe.hasAudio, size: s.probe.hasVideo ? `${s.probe.width}x${s.probe.height}` : undefined, fps: s.probe.fps, fpsMode: s.probe.fpsMode, mezzanine: s.mezzanine }));
  }));

const asset = program.command("asset").description("project assets (logo, fonts, music, LUTs)");
asset.command("add <file>").requiredOption("--kind <kind>").option("--as <rel>").option("--license <text>")
  .action(action(async (p, file: string, o: { kind: Asset["kind"]; as?: string; license?: string }) => addAsset(p, file, o.kind, o)));

const target = program.command("target").description("delivery formats");
target.command("add <id>").requiredOption("--preset <platform/name>").action(action(async (p, id: string, o: { preset: string }) => p.addTarget(id, o.preset)));
target.command("list").action(action(async (p) => p.manifest.targets));

// ------------------------------------------------------------------ analysis

program.command("analyze").description("measure shots, exposure, color, silences, loudness (+ transcription)")
  .option("--source <ids>", "comma-separated source ids")
  .option("--transcribe", "run speech-to-text (faster-whisper)")
  .option("--language <code>", "fr | en | auto", "auto")
  .option("--model <name>", "whisper model (tiny, base, small, medium, large-v3)", "small")
  .action(action(async (p, o: { source?: string; transcribe?: boolean; language: string; model: string }) => {
    const ids = o.source?.split(",");
    const analysis = await analyzeProject(p, ids ? { sourceIds: ids } : {});
    const summary = summarizeAnalysis(analysis);
    if (!o.transcribe) return summary;
    const transcript = await transcribeProject(p, { language: o.language, model: o.model, ...(ids ? { sourceIds: ids } : {}) });
    const reports = transcriptionReport(transcript, analysis);
    return summary.map((s) => ({ ...s, transcription: reports.find((r) => r.sourceId === s.sourceId) }));
  }));

const analysis = program.command("analysis");
analysis.command("summary").action(action(async (p) => summarizeAnalysis(await p.readDoc("analysis"))));
analysis.command("annotate").requiredOption("--file <annotations.json>", "[{sourceId, shotId, labels?, notes?, qualityScore?}]")
  .action(action(async (p, o: { file: string }) => annotateAnalysis(p, await readJson<ShotAnnotation[]>(o.file))));

const transcript = program.command("transcript");
transcript.command("import <file>").description("import a word-level transcript (schemas/transcript.schema.json)")
  .action(action(async (p, file: string) => {
    const t = await importTranscript(p, file);
    return { language: t.language, segments: t.sources.reduce((a, s) => a + s.segments.length, 0) };
  }));
transcript.command("show").description("Whisper segments (time windows — may cut mid-sentence)").action(action(async (p) => listSegments(p)));
transcript.command("sentences").description("sentences and clauses as exact {sourceId,start,end} ranges for creative plans").action(action(async (p) => listSentences(p)));

// ------------------------------------------------------------------ brand

const brand = program.command("brand").description("Brand DNA and style tokens");
brand.command("set <path>").description("install brand.json or a brand-kit folder (brand.json + assets/ + fonts/)")
  .action(action(async (p, path: string) => {
    const r = await setBrand(p, path);
    return { brand: r.brand.name, tokens: summarizeTokens(r.tokens), issues: r.issues, fonts: r.fonts };
  }));
brand.command("tokens").description("recompile style tokens from brand.json").action(action(async (p) => summarizeTokens(await recompileTokens(p))));
brand.command("validate").action(action(async (p) => ({ issues: checkBrand(await p.readDoc("brand"), p) })));
brand.command("fonts").command("fetch").description("download Google fonts declared by the brand into brand/fonts/ (once, at setup)")
  .action(action(async (p): Promise<BrandFontsReport> => fetchBrandFonts(p)));

function summarizeTokens(t: Awaited<ReturnType<typeof recompileTokens>>) {
  return { brand: t.brandName, fps: t.fps, color: t.color, motion: t.motion, shape: t.shape, type: t.type, caption: { family: t.caption.family, case: t.caption.case, animation: t.caption.animation, maxWordsPerLine: t.caption.maxWordsPerLine }, grade: t.grade };
}

// ------------------------------------------------------------------ plan & edit

const plan = program.command("plan").description("creative plan (written by the creative-director skill)");
plan.command("set <file>").action(action(async (p, file: string) => setPlan(p, file)));
plan.command("validate").action(action(async (p) => estimateProjectPlan(p)));
plan.command("estimate").action(action(async (p) => estimateProjectPlan(p)));
plan.command("compile").description("plan -> timeline (silences/fillers removed, word-safe cuts)").action(action(async (p) => timelineSummary(await compileProjectPlan(p))));

program.command("timeline").command("show").action(action(async (p) => timelineSummary(await p.readDoc("timeline"))));

const edit = program.command("edit").description("surgical, non-destructive timeline edits");
edit.command("delete").requiredOption("--clip <id>").action(action(async (p, o: { clip: string }) => timelineSummary(await deleteClipInProject(p, o.clip))));
edit.command("trim").requiredOption("--clip <id>").option("--in <sec>", "", num).option("--out <sec>", "", num)
  .action(action(async (p, o: { clip: string; in?: number; out?: number }) => timelineSummary(await trimClipInProject(p, o.clip, { ...(o.in !== undefined ? { in: o.in } : {}), ...(o.out !== undefined ? { out: o.out } : {}) }))));

program.command("reframe").requiredOption("--target <id>").addOption(new Option("--mode <mode>").choices(["center", "fit-blur"]).default("center"))
  .action(action(async (p, o: { target: string; mode: "center" | "fit-blur" }) => (await reframeTarget(p, o.target, o.mode)).reframe));

// ------------------------------------------------------------------ color, audio, captions, motion

program.command("color").command("auto").addOption(new Option("--intent <intent>").choices(["correct-only", "brand-look"]).default("brand-look"))
  .action(action(async (p, o: { intent: "correct-only" | "brand-look" }) => {
    const doc = await colorAutoProject(p, o.intent);
    return { look: doc.globalGrade, shots: doc.shots.map((s) => ({ shot: `${s.sourceId}/${s.shotId}`, reason: s.reason })) };
  }));

program.command("audio").command("clean").addOption(new Option("--preset <level>").choices(["off", "gentle", "standard", "aggressive"]))
  .option("--target <id>", "loudness target taken from this target's preset")
  .action(action(async (p, o: { preset?: CleanupPreset; target?: string }) => cleanProjectAudio(p, { ...(o.preset ? { preset: o.preset } : {}), ...(o.target ? { targetId: o.target } : {}) })));

program.command("captions").command("build").action(action(async (p) => {
  const doc = await buildProjectCaptions(p);
  return { cues: doc.cues.map((c) => ({ id: c.id, at: `${c.start}-${c.end}`, text: c.words.map((w) => (w.emphasis === "key" ? w.text.toUpperCase() : w.text)).join(" ") })) };
}));

const motion = program.command("motion");
motion.command("from-plan").action(action(async (p) => (await motionFromProjectPlan(p)).instances.map((i) => ({ id: i.id, component: i.component, at: `${i.start}+${i.durationSec}`, variant: i.variant }))));
motion.command("list").action(action(async (p) => (await p.readDoc("motion")).instances));

// ------------------------------------------------------------------ render, QC, export

program.command("render").requiredOption("--target <id>").option("--draft", "half resolution, fast encode")
  .addOption(new Option("--renderer <r>").choices(["auto", "remotion", "ass"]))
  .action(action(async (p, o: { target: string; draft?: boolean; renderer?: RendererChoice }) => renderTarget(p, o.target, { draft: !!o.draft, ...(o.renderer ? { renderer: o.renderer } : {}) })));

program.command("frames").requiredOption("--target <id>").requiredOption("--at <secs>", "comma-separated seconds").option("--draft")
  .action(action(async (p, o: { target: string; at: string; draft?: boolean }) => extractRenderFrames(p, o.target, o.at.split(",").map(num), { draft: !!o.draft })));

const qc = program.command("qc").description("quality control (exit 5 + QC_BLOCKED on blockers)");
qc.option("--target <id>").option("--draft").action(action(async (p, o: { target?: string; draft?: boolean }) => {
  if (!o.target) throw new BveError("MISSING_INPUT", "--target is required");
  const { report, reportPath } = await runQc(p, o.target, { draft: !!o.draft });
  const text = formatQc(report);
  if (report.status === "fail") {
    const blockers = Object.values(report.categories).flatMap((c) => c.checks).filter((c) => c.status === "fail" && c.severity === "blocker");
    throw new BveError("QC_BLOCKED", `QC failed with ${blockers.length} blocker(s): ${blockers.map((b) => b.id).join(", ")}`, { details: { reportPath, text, blockers }, hint: "Fix each blocker through its owning skill, re-render, re-run QC." });
  }
  return { status: report.status, reportPath, text, report };
}, (d) => d.text));
qc.command("waive <checkId>").requiredOption("--reason <text>").description("USER decision: accept a blocking check").action(action(async (p, id: string, o: { reason: string }) => waive(p, id, o.reason)));

program.command("export").option("--target <id>").option("--all").option("--sidecars <list>", "srt,vtt")
  .action(action(async (p, o: { target?: string; all?: boolean; sidecars?: string }) => {
    const ids = o.all ? p.manifest.targets.map((t) => t.id) : o.target ? [o.target] : [];
    if (!ids.length) throw new BveError("MISSING_INPUT", "Pass --target <id> or --all");
    const side = (o.sidecars?.split(",").filter((x) => x === "srt" || x === "vtt") ?? []) as ("srt" | "vtt")[];
    const out = [];
    for (const id of ids) out.push(await exportTarget(p, id, { sidecars: side }));
    return out;
  }));

// ------------------------------------------------------------------ documents, housekeeping, versions

const doc = program.command("doc").description("read/write any project document (validated against its schema, versioned)");
doc.command("get <key>").description(`one of: ${Object.keys(DOC_SPECS).join(", ")}`).action(action(async (p, key: string) => p.readDoc(docKey(key))));
doc.command("set <key> <file>").option("-m, --message <text>", "version message").action(action(async (p, key: string, file: string, o: { message?: string }) => {
  const k = docKey(key);
  const meta = await p.writeDoc(k, (await readJson(file)) as never, { command: `doc set ${k}`, message: o.message ?? `Edited ${k}` });
  return { doc: k, version: meta?.id ?? p.head };
}));

function docKey(key: string): DocKey {
  if (!isDocKey(key)) throw new BveError("VALIDATION", `Unknown document "${key}"`, { hint: `One of: ${Object.keys(DOC_SPECS).join(", ")}` });
  return key;
}

program.command("clean").description("delete caches and intermediate renders (never sources, documents or exports)").action(action(async (p) => ({ removed: await p.clean() })));

const version = program.command("version").description("snapshot history (non-destructive)");
version.command("list").action(action(async (p) => (await p.versions.list()).map((v) => ({ id: v.id, parent: v.parent, restores: v.restores, at: v.createdAt, command: v.command, message: v.message, changed: v.changed, head: v.id === p.head }))));
version.command("undo").description("restore the previous state as a new version").action(action(async (p) => p.undo()));
version.command("checkout <id>").action(action(async (p, id: string) => p.checkout(id as VersionId)));
version.command("diff <a> <b>").action(action(async (p, a: string, b: string) => p.versions.diff(a as VersionId, b as VersionId)));

program.parseAsync(process.argv).catch((err) => {
  const { env, exitCode } = failure(err);
  emit(g().json, env);
  process.exitCode = exitCode;
});
