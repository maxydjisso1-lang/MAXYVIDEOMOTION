#!/usr/bin/env node
/**
 * bve — the execution layer Claude drives. Every command validates its inputs and outputs
 * against schemas/, and every mutating command creates a project version.
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Command, Option } from "commander";
import {
  BveError, createLogger, DOC_SPECS, ENGINE_VERSION, existsSync, loadPreset, Project, readJson, validate, type CreativePlan, type DocKey, type Timeline, type VersionId,
} from "../../core/src/index.js";
import { buildAudioDoc, type CleanupPreset } from "../../audio/src/index.js";
import { checkBrand, recompileTokens, setBrand } from "../../brand/src/index.js";
import { buildCaptions } from "../../captions/src/index.js";
import { autoColor } from "../../color/src/index.js";
import { compilePlan, deleteClip, ensureReframes, estimatePlan, setReframe, timelineContext, trimClip } from "../../editing/src/index.js";
import { exportTarget } from "../../export/src/index.js";
import { binaries, capabilities, extractFrame } from "../../ffmpeg/src/index.js";
import { motionFromPlan } from "../../motion/src/index.js";
import { formatQc, runQc, waive } from "../../qc/src/index.js";
import { remotionStatus, renderRecordPath, renderTarget, type RendererChoice, type RenderRecord } from "../../rendering/src/index.js";
import { fasterWhisper, importTranscript, transcribeProject } from "../../transcription/src/index.js";
import { addAsset, analyzeProject, ingestSource, summarizeAnalysis } from "../../vision/src/index.js";
import { emit, failure } from "./output.js";

const program = new Command();
program
  .name("bve")
  .description("brand-video-engine — AI-native, brand-aware video post-production (driven by Claude skills)")
  .version(ENGINE_VERSION)
  .option("-p, --project <dir>", "project directory", ".")
  .option("--json", "print a single JSON envelope on stdout (for Claude)", false);

const g = () => program.opts<{ project: string; json: boolean }>();

/** Wrap an action: open the project, run, print the envelope, map errors to exit codes. */
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

// ------------------------------------------------------------------ setup

program.command("doctor").description("check FFmpeg, filters, Remotion and transcription").action(async () => {
  const { json } = g();
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
  report.remotion = rs.available ? { available: true, note: "Remotion is free for individuals and companies of up to 3 people; larger organizations need a company license (remotion.dev/license)." } : { available: false, reason: rs.reason, fallback: "ASS/libass renderer" };
  report.transcription = { fasterWhisper: await fasterWhisper.available(), hint: "uv sync --project engine/python" };
  emit(json, { ok: true, data: report });
});

program.command("init <dir>").description("create a project").option("--name <name>", "project name").action(async (dir: string, o: { name?: string }) => {
  const { json } = g();
  try {
    const p = await Project.init(dir, o.name ?? dir.split(/[\\/]/).filter(Boolean).at(-1) ?? "project");
    emit(json, { ok: true, data: { root: p.root, id: p.manifest.id }, version: p.head }, `Project created at ${p.root}`);
  } catch (err) {
    const { env, exitCode } = failure(err);
    emit(json, env);
    process.exitCode = exitCode;
  }
});

program.command("ingest <files...>").description("register source media (hashed, never modified)")
  .addOption(new Option("--role <role>").choices(["a-roll", "b-roll", "music", "voiceover", "other"]).default("a-roll"))
  .action(action(async (p, files: string[], o: { role: "a-roll" }) => {
    const out = [];
    for (const f of files) out.push(await ingestSource(p, f, o.role));
    return out.map((s) => ({ id: s.id, path: s.path, durationSec: s.probe.durationSec, size: `${s.probe.width}x${s.probe.height}`, fps: s.probe.fps, fpsMode: s.probe.fpsMode, mezzanine: s.mezzanine }));
  }));

const asset = program.command("asset").description("project assets (logo, fonts, music, LUTs)");
asset.command("add <file>").requiredOption("--kind <kind>").option("--as <rel>").option("--license <text>")
  .action(action(async (p, file: string, o: { kind: "logo"; as?: string; license?: string }) => addAsset(p, file, o.kind, o)));

const target = program.command("target").description("delivery formats");
target.command("add <id>").requiredOption("--preset <platform/name>").action(action(async (p, id: string, o: { preset: string }) => {
  await loadPreset(o.preset);
  p.manifest.targets = [...p.manifest.targets.filter((t) => t.id !== id), { id, preset: o.preset }];
  await p.saveManifest();
  return p.manifest.targets;
}));
target.command("list").action(action(async (p) => p.manifest.targets));

// ------------------------------------------------------------------ analysis

program.command("analyze").description("measure shots, exposure, color, silences, loudness (+ transcription)")
  .option("--source <ids>", "comma-separated source ids")
  .option("--transcribe", "run speech-to-text (faster-whisper)")
  .option("--language <code>", "fr | en | auto", "auto")
  .option("--model <name>", "whisper model", "large-v3")
  .action(action(async (p, o: { source?: string; transcribe?: boolean; language: string; model: string }) => {
    const ids = o.source?.split(",");
    if (o.transcribe) await transcribeProject(p, { language: o.language, model: o.model, ...(ids ? { sourceIds: ids } : {}) });
    const a = await analyzeProject(p, ids ? { sourceIds: ids } : {});
    return summarizeAnalysis(a);
  }));

const analysis = program.command("analysis");
analysis.command("summary").action(action(async (p) => summarizeAnalysis(await p.readDoc("analysis"))));
analysis.command("annotate").requiredOption("--file <annotations.json>", "[{sourceId, shotId, labels?, notes?, qualityScore?}]")
  .action(action(async (p, o: { file: string }) => {
    const a = await p.readDoc("analysis");
    const notes = await readJson<{ sourceId: string; shotId: string; labels?: { label: string; confidence?: number }[]; notes?: string; qualityScore?: number }[]>(o.file);
    for (const n of notes) {
      const shot = a.sources.find((s) => s.sourceId === n.sourceId)?.shots.find((s) => s.id === n.shotId);
      if (!shot) throw new BveError("NOT_FOUND", `Unknown shot ${n.sourceId}/${n.shotId}`);
      if (n.labels) shot.labels = n.labels.map((l) => ({ ...l, source: "claude" as const }));
      if (n.notes) shot.notes = n.notes;
      if (n.qualityScore !== undefined) shot.qualityScore = n.qualityScore;
    }
    await p.writeDoc("analysis", a, { command: "analysis annotate", message: `Annotated ${notes.length} shot(s)` });
    return { annotated: notes.length };
  }));

const transcript = program.command("transcript");
transcript.command("import <file>").description("import a word-level transcript (schemas/transcript.schema.json)")
  .action(action(async (p, file: string) => {
    const t = await importTranscript(p, file);
    return { language: t.language, segments: t.sources.reduce((a, s) => a + s.segments.length, 0) };
  }));
transcript.command("show").action(action(async (p) => {
  const t = await p.readDoc("transcript");
  return t.sources.flatMap((s) => s.segments.map((seg) => ({ sourceId: s.sourceId, id: seg.id, range: `${seg.start.toFixed(2)}-${seg.end.toFixed(2)}`, text: seg.text, fillers: seg.words.filter((w) => w.filler).length })));
}));

// ------------------------------------------------------------------ brand

const brand = program.command("brand").description("Brand DNA and style tokens");
brand.command("set <path>").description("install brand.json or a brand-kit folder (brand.json + assets/)")
  .action(action(async (p, path: string) => {
    const r = await setBrand(p, path);
    return { brand: r.brand.name, tokens: summarizeTokens(r.tokens), issues: r.issues };
  }));
brand.command("tokens").description("recompile style tokens from brand.json").action(action(async (p) => summarizeTokens(await recompileTokens(p))));
brand.command("validate").action(action(async (p) => ({ issues: checkBrand(await p.readDoc("brand"), p) })));

function summarizeTokens(t: Awaited<ReturnType<typeof recompileTokens>>) {
  return { brand: t.brandName, fps: t.fps, color: t.color, motion: t.motion, shape: t.shape, caption: { family: t.caption.family, case: t.caption.case, animation: t.caption.animation, maxWordsPerLine: t.caption.maxWordsPerLine }, grade: t.grade };
}

// ------------------------------------------------------------------ plan & edit

const plan = program.command("plan").description("creative plan (written by the creative-director skill)");
plan.command("set <file>").action(action(async (p, file: string) => {
  const doc = validate<CreativePlan>("creative-plan", await readJson(file), file);
  const est = estimatePlan(doc, await timelineContext(p));
  await p.writeDoc("plan", doc, { command: "plan set", message: `Creative plan: ${doc.narrative.structure}, ${doc.targetDurationSec}s` });
  return est;
}));
plan.command("validate").action(action(async (p) => estimatePlan(await p.readDoc("plan"), await timelineContext(p))));
plan.command("estimate").action(action(async (p) => estimatePlan(await p.readDoc("plan"), await timelineContext(p))));
plan.command("compile").description("plan -> timeline (silences/fillers removed, word-safe cuts)").action(action(async (p) => {
  const doc = await p.readDoc("plan");
  const first = p.manifest.targets[0];
  const fps = first ? (await p.preset(first.id)).fps : 30;
  const tl = await ensureReframes(p, compilePlan(doc, await timelineContext(p), fps));
  await p.writeDoc("timeline", tl, { command: "plan compile", message: `Timeline compiled: ${tl.tracks.video[0]!.clips.length} clips, ${tl.durationSec}s` });
  return timelineSummary(tl);
}));

function timelineSummary(tl: Timeline) {
  return { durationSec: tl.durationSec, fps: tl.fps, clips: tl.tracks.video.flatMap((t) => t.clips).map((c) => ({ id: c.id, src: `${c.sourceId} ${c.sourceIn}-${c.sourceOut}`, at: c.timelineStart, section: c.sectionId, zoom: c.zoom?.[0]?.scale, reason: c.reason })), markers: tl.markers };
}

program.command("timeline").command("show").action(action(async (p) => timelineSummary(await p.readDoc("timeline"))));

const edit = program.command("edit").description("surgical, non-destructive timeline edits");
edit.command("delete").requiredOption("--clip <id>").action(action(async (p, o: { clip: string }) => {
  const tl = deleteClip(await p.readDoc("timeline"), o.clip);
  await p.writeDoc("timeline", tl, { command: "edit delete", message: `Deleted clip ${o.clip}` });
  return timelineSummary(tl);
}));
edit.command("trim").requiredOption("--clip <id>").option("--in <sec>", "", parseFloat).option("--out <sec>", "", parseFloat).action(action(async (p, o: { clip: string; in?: number; out?: number }) => {
  const tl = trimClip(await p.readDoc("timeline"), o.clip, { ...(o.in !== undefined ? { in: o.in } : {}), ...(o.out !== undefined ? { out: o.out } : {}) });
  await p.writeDoc("timeline", tl, { command: "edit trim", message: `Trimmed clip ${o.clip}` });
  return timelineSummary(tl);
}));

program.command("reframe").requiredOption("--target <id>").addOption(new Option("--mode <mode>").choices(["center", "fit-blur"]).default("center"))
  .action(action(async (p, o: { target: string; mode: "center" | "fit-blur" }) => {
    p.target(o.target);
    const tl = setReframe(await p.readDoc("timeline"), o.target, o.mode);
    await p.writeDoc("timeline", tl, { command: "reframe", message: `Reframe ${o.target}: ${o.mode}` });
    return tl.reframe;
  }));

// ------------------------------------------------------------------ color, audio, captions, motion

program.command("color").command("auto").addOption(new Option("--intent <intent>").choices(["correct-only", "brand-look"]).default("brand-look"))
  .action(action(async (p, o: { intent: "correct-only" | "brand-look" }) => {
    const doc = autoColor(await p.readDoc("analysis"), await p.readDoc("timeline"), await p.readDoc("styleTokens"), { intent: o.intent, previous: await p.readDocOptional("color") });
    await p.writeDoc("color", doc, { command: "color auto", message: `Color: ${doc.shots.length} shot(s) corrected, look ${doc.globalGrade?.look}` });
    return { look: doc.globalGrade, shots: doc.shots.map((s) => ({ shot: `${s.sourceId}/${s.shotId}`, reason: s.reason })) };
  }));

program.command("audio").command("clean").addOption(new Option("--preset <level>").choices(["off", "gentle", "standard", "aggressive"]))
  .option("--target <id>", "loudness target taken from this target's preset")
  .action(action(async (p, o: { preset?: CleanupPreset; target?: string }) => {
    const planDoc = await p.readDocOptional("plan");
    const level = o.preset ?? (planDoc?.audio?.cleanup as CleanupPreset | undefined) ?? "standard";
    const tid = o.target ?? p.manifest.targets[0]?.id;
    if (!tid) throw new BveError("MISSING_INPUT", "No target: the loudness target comes from a delivery preset", { hint: "bve target add ig_reels --preset instagram/reels" });
    const doc = buildAudioDoc(await p.readDoc("analysis"), await p.preset(tid), level, await p.readDocOptional("audio"));
    await p.writeDoc("audio", doc, { command: "audio clean", message: `Audio cleanup (${level}), master ${doc.master.loudnessLufs} LUFS` });
    return doc;
  }));

program.command("captions").command("build").action(action(async (p) => {
  const doc = buildCaptions(await p.readDoc("transcript"), await p.readDoc("timeline"), await p.readDoc("styleTokens"), await p.readDocOptional("plan"));
  await p.writeDoc("captions", doc, { command: "captions build", message: `Captions: ${doc.cues.length} cues` });
  return { cues: doc.cues.map((c) => ({ id: c.id, at: `${c.start}-${c.end}`, text: c.words.map((w) => (w.emphasis === "key" ? w.text.toUpperCase() : w.text)).join(" ") })) };
}));

const motion = program.command("motion");
motion.command("from-plan").action(action(async (p) => {
  const doc = motionFromPlan(await p.readDoc("plan"), await p.readDoc("timeline"), await p.readDoc("styleTokens"));
  await p.writeDoc("motion", doc, { command: "motion from-plan", message: `Motion: ${doc.instances.length} instances` });
  return doc.instances.map((i) => ({ id: i.id, component: i.component, at: `${i.start}+${i.durationSec}`, variant: i.variant }));
}));
motion.command("list").action(action(async (p) => (await p.readDoc("motion")).instances));

// ------------------------------------------------------------------ render, QC, export

program.command("render").requiredOption("--target <id>").option("--draft", "half resolution, fast encode")
  .addOption(new Option("--renderer <r>").choices(["auto", "remotion", "ass"]))
  .action(action(async (p, o: { target: string; draft?: boolean; renderer?: RendererChoice }) => renderTarget(p, o.target, { draft: !!o.draft, ...(o.renderer ? { renderer: o.renderer } : {}) })));

program.command("frames").requiredOption("--target <id>").requiredOption("--at <secs>", "comma-separated seconds").option("--draft")
  .action(action(async (p, o: { target: string; at: string; draft?: boolean }) => {
    const rec = await readJson<RenderRecord>(join(p.root, renderRecordPath(o.target, p.head, !!o.draft)));
    await mkdir(p.abs("renders/frames"), { recursive: true });
    const out = [];
    for (const s of o.at.split(",").map(Number)) {
      const rel = `renders/frames/${o.target}-${p.head}-${s.toFixed(2)}.jpg`;
      await extractFrame(p.abs(rec.path), s, p.writable(rel), { width: 540 });
      out.push(rel);
    }
    return out;
  }));

const qc = program.command("qc").description("quality control (blocks export on blockers)");
qc.option("--target <id>").option("--draft").action(action(async (p, o: { target?: string; draft?: boolean }) => {
  if (!o.target) throw new BveError("MISSING_INPUT", "--target is required");
  const { report, reportPath } = await runQc(p, o.target, { draft: !!o.draft });
  if (report.status === "fail") process.exitCode = 5;
  return { status: report.status, reportPath, text: formatQc(report), report };
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

// ------------------------------------------------------------------ generic documents & housekeeping

const doc = program.command("doc").description("read/write any project document (validated against its schema, versioned)");
doc.command("get <key>").description(`one of: ${Object.keys(DOC_SPECS).join(", ")}`).action(action(async (p, key: string) => p.readDoc(docKey(key))));
doc.command("set <key> <file>").option("-m, --message <text>", "version message").action(action(async (p, key: string, file: string, o: { message?: string }) => {
  const k = docKey(key);
  const data = await readJson(file);
  const meta = await p.writeDoc(k, data as never, { command: `doc set ${k}`, message: o.message ?? `Edited ${k}` });
  return { doc: k, version: meta?.id ?? p.head };
}));

function docKey(key: string): DocKey {
  if (!(key in DOC_SPECS)) throw new BveError("VALIDATION", `Unknown document "${key}"`, { hint: `One of: ${Object.keys(DOC_SPECS).join(", ")}` });
  return key as DocKey;
}

program.command("clean").description("delete caches and intermediate renders (never sources, exports or documents)").action(action(async (p) => {
  const removed: string[] = [];
  for (const rel of [".cache", "renders/cache", "renders/frames"]) {
    if (existsSync(p.abs(rel))) {
      await rm(p.abs(rel), { recursive: true, force: true });
      removed.push(rel);
    }
  }
  return { removed };
}));

// ------------------------------------------------------------------ versions

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
