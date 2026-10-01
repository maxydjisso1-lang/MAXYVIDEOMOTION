/**
 * Render profiling (chantier 3). MEASURES ONLY — nothing here changes how the engine renders.
 *
 * Reference scenario: tests/fixtures/real/reference/render-profile-scenario.json (real talking-head
 * footage, Maison Lune, Instagram Reels final quality, Remotion renderer). Every run builds a fresh
 * project, so no stage cache is reused.
 *
 *   1. Baseline: full final render, stage timings (logs/bve.jsonl), Remotion per-frame times and
 *      seek times (Remotion verbose log), CPU / GPU / memory sampled every second (Windows counters).
 *   2. Attribution: per-frame time grouped by what is on screen (captions, title, CTA, transition…).
 *   3. Isolation experiments on the graphics stage: empty / captions only / motion only / full,
 *      concurrency 1-2-4-8, PNG vs JPEG screenshots, draft (preview) vs final.
 *   4. Pure JS layout cost of a frame, measured in Node.
 *
 * Usage: tsx scripts/profile-render.ts [--quick]   (--quick: baseline + attribution only)
 * Output: docs/measurements/render-profile.json (+ the Markdown report is written by hand from it)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, Project, readJson, REPO_ROOT, type Captions, type MotionDoc } from "../engine/core/src/index.js";
import { cleanProjectAudio } from "../engine/audio/src/index.js";
import { setBrand } from "../engine/brand/src/index.js";
import { buildProjectCaptions } from "../engine/captions/src/index.js";
import { colorAutoProject } from "../engine/color/src/index.js";
import { compileProjectPlan, setPlan } from "../engine/editing/src/index.js";
import { capabilities, probe } from "../engine/ffmpeg/src/index.js";
import { cueLayout, avoidObstacles, motionObstacles, applyCase, instanceBox, type Frame } from "../engine/motion/src/index.js";
import { motionFromProjectPlan } from "../engine/motion/src/index.js";
import { geometry, remotionBundle, renderGraphicsRemotion, renderTarget } from "../engine/rendering/src/index.js";
import { importTranscript } from "../engine/transcription/src/index.js";
import { analyzeProject, ingestSource } from "../engine/vision/src/index.js";

const quick = process.argv.includes("--quick");
const REAL = join(REPO_ROOT, "tests/fixtures/real");
const SCN = await readJson<{ fixture: string; transcript: string; brandKit: string; target: { id: string; preset: string }; plan: unknown }>(join(REAL, "reference/render-profile-scenario.json"));
const WORK = join(REPO_ROOT, "tests/.tmp/profile");
await rm(WORK, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });

// ---------------------------------------------------------------- resource sampler (Windows counters)
function startSampler(file: string): ChildProcess | undefined {
  if (process.platform !== "win32") return undefined;
  const ps = `
$ErrorActionPreference='SilentlyContinue'
while ($true) {
  # CIM perf class: Get-Counter names are localised (French Windows returns nothing for English names).
  $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
  $gpu = ((Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage').CounterSamples | Measure-Object CookedValue -Sum).Sum
  $mem = Get-Process | Where-Object { $_.ProcessName -match 'chrome|node|ffmpeg' } | Group-Object { ($_.ProcessName -replace '-.*','') } | ForEach-Object { "$($_.Name)=$([math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum)/1MB))" }
  "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds());$([math]::Round($cpu,1));$([math]::Round($gpu,1));$($mem -join ',')" | Out-File -Append -Encoding utf8 '${file}'
}`;
  return spawn("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, stdio: "ignore" });
}

interface Sample { t: number; cpu: number; gpu: number; memMb: Record<string, number> }
async function readSamples(file: string, from: number, to: number): Promise<Sample[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split(/\r?\n/).filter(Boolean).map((l) => {
    const [t, cpu, gpu, mem] = l.replace(/^﻿/, "").split(";");
    return { t: Number(t), cpu: Number(cpu), gpu: Number(gpu) || 0, memMb: Object.fromEntries((mem ?? "").split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k!, Number(v)]; })) };
  }).filter((s) => s.t >= from && s.t <= to);
}
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? { mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10, p50: s[Math.floor(s.length / 2)]!, p95: s[Math.floor(s.length * 0.95)]!, max: s.at(-1)! } : null;
};

// ---------------------------------------------------------------- build the reference project
async function buildProject(name: string): Promise<Project> {
  const dir = join(WORK, name);
  const project = await Project.init(dir, name, createLogger({ projectRoot: dir, level: "warn" }));
  await ingestSource(project, join(REAL, SCN.fixture));
  await project.addTarget(SCN.target.id, SCN.target.preset);
  await setBrand(project, join(REPO_ROOT, SCN.brandKit));
  await analyzeProject(project);
  await importTranscript(project, join(REAL, "reference", SCN.transcript));
  const planFile = join(dir, "plan.json");
  await writeFile(planFile, JSON.stringify(SCN.plan));
  await setPlan(project, planFile);
  await compileProjectPlan(project);
  await colorAutoProject(project);
  await cleanProjectAudio(project);
  await buildProjectCaptions(project);
  await motionFromProjectPlan(project);
  return project;
}

async function lastLog(project: Project, profile: string): Promise<Record<string, any> | undefined> {
  const lines = (await readFile(join(project.root, "logs/bve.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  return lines.filter((l) => l.profile === profile).at(-1);
}

/** Capture Remotion's verbose output (seek time per frame) while `fn` runs — console AND raw stdout/stderr. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  const sink = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  console.log = sink; console.info = sink; console.warn = sink; console.error = sink;
  const raw = (chunk: unknown) => {
    lines.push(...String(chunk).split(/\r?\n/));
    return true;
  };
  process.stdout.write = raw as typeof process.stdout.write;
  process.stderr.write = raw as typeof process.stderr.write;
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = orig.log; console.info = orig.info; console.warn = orig.warn; console.error = orig.error;
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  }
}

const out: Record<string, unknown> = {
  date: new Date().toISOString(),
  machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, ramGb: Math.round(totalmem() / 2 ** 30), platform: process.platform, ffmpeg: capabilities().version, node: process.version },
};

// ================================================================= 1. baseline
console.log("building reference project…");
const ref = await buildProject("reference");
const samplesFile = join(WORK, "samples.csv");
const sampler = startSampler(samplesFile);
await new Promise((r) => setTimeout(r, 3000)); // sampler warm-up (first counter read is slow)
process.env.BVE_REMOTION_LOG = "verbose";
const tStart = Date.now();
const { lines: remotionLines } = await captureConsole(() => renderTarget(ref, SCN.target.id, { renderer: "remotion" }));
const tEnd = Date.now();
delete process.env.BVE_REMOTION_LOG;
const render = await lastLog(ref, "render");
const rem = await lastLog(ref, "remotion");
const frameLog = await lastLog(ref, "remotion-frames");
// Remotion's own per-frame seek report: "Setting the current frame to N" … "handle was cleared after X ms"
// (time for the page to reach frame N, incl. delayRender handles), or "Seeking to frame N took X ms".
const seekMs = remotionLines
  .map((l) => /Setting the current frame to (\d+).{0,8}handle was cleared after (\d+)ms/.exec(l) ?? /Seeking to frame (\d+) took (\d+)ms/.exec(l))
  .filter((m): m is RegExpExecArray => !!m)
  .map((m) => Number(m[2]));
const glLine = remotionLines.find((l) => /Opening browser: gl =/.test(l));
const samples = await readSamples(samplesFile, tStart, tEnd);
console.log(`baseline: ${((tEnd - tStart) / 1000).toFixed(1)} s, stages ${JSON.stringify(render?.stagesMs)}`);

// Resource use per stage window (stage order: base → graphics → audio → final-encode).
const stagesMs = (render?.stagesMs ?? {}) as Record<string, number>;
let cursor = tStart;
const perStage: Record<string, unknown> = {};
for (const st of ["base", "graphics", "audio", "final-encode"]) {
  const ms = stagesMs[st] ?? 0;
  const ss = samples.filter((s) => s.t >= cursor && s.t < cursor + ms);
  perStage[st] = { ms, cpu: stats(ss.map((s) => s.cpu)), gpu: stats(ss.map((s) => s.gpu)), peakMemMb: ss.reduce((m, s) => { for (const [k, v] of Object.entries(s.memMb)) m[k] = Math.max(m[k] ?? 0, v); return m; }, {} as Record<string, number>) };
  cursor += ms;
}
out.baseline = {
  wallSec: (tEnd - tStart) / 1000,
  render,
  remotion: rem,
  seekMs: stats(seekMs),
  seekSamples: seekMs.length,
  gl: glLine ?? "not reported",
  perStage,
  cpuWhole: stats(samples.map((s) => s.cpu)),
  gpuWhole: stats(samples.map((s) => s.gpu)),
};

// ================================================================= 2. attribution of frame time
const fps = geometry(await ref.preset(SCN.target.id), false).fps;
const motion = await ref.readDoc("motion");
const captions = await ref.readDoc("captions");
const perFrame: number[] = frameLog?.frameMs ?? [];
const labelOf = (f: number) => {
  const t = f / fps;
  const on = motion.instances.filter((i) => t >= i.start && t < i.start + i.durationSec && i.component !== "Watermark").map((i) => i.component);
  const cue = captions.cues.some((c) => t >= c.start && t < c.end);
  const parts: string[] = [...new Set(on)].sort();
  if (cue && !parts.includes("BrandOutro")) parts.push("captions");
  return parts.length ? parts.join("+") : "nothing (watermark only)";
};
const groups: Record<string, number[]> = {};
perFrame.forEach((ms, f) => (groups[labelOf(f)] ??= []).push(ms));
out.attribution = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { frames: v.length, ...stats(v) }]));
console.log("attribution:", JSON.stringify(out.attribution));

// ================================================================= 4. pure JS layout cost (Node)
{
  const tokens = await ref.readDoc("styleTokens");
  const preset = await ref.preset(SCN.target.id);
  const frame: Frame = { width: preset.width, height: preset.height, safeZone: preset.safeZone };
  const frames = Math.round((render?.durationSec ?? 20) * fps);
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    const obstacles = motionObstacles(frame, tokens, motion.instances);
    for (const i of motion.instances) instanceBox(frame, tokens, i);
    const t = f / fps;
    for (const c of captions.cues.filter((x) => t >= x.start && t < x.end)) avoidObstacles(frame, tokens, cueLayout(frame, tokens, c.words.map((w, k) => ({ text: applyCase(w.text, tokens.caption.case, k === 0), lineBreakAfter: w.lineBreakAfter }))), c, obstacles);
  }
  const ms = performance.now() - t0;
  out.layoutJs = { frames, totalMs: Math.round(ms), perFrameMs: Math.round((ms / frames) * 1000) / 1000 };
  console.log("layout JS:", JSON.stringify(out.layoutJs));
}

if (!quick) {
  // ================================================================= 3. isolation experiments (graphics stage only)
  const base = ref.abs((render?.stages?.base as string | undefined) ?? (await readdir(ref.abs("renders/cache"))).map((f) => `renders/cache/${f}`).find((f) => /base-/.test(f))!);
  const preset = await ref.preset(SCN.target.id);
  const tokens = await ref.readDoc("styleTokens");
  const durationSec = render?.durationSec as number;
  const g = geometry(preset, false);
  const emptyMotion: MotionDoc = { schemaVersion: "1.0", instances: [] };
  const emptyCaptions: Captions = { ...captions, cues: [] };
  const graphicsRun = async (label: string, m: MotionDoc, c: Captions, conc?: number) => {
    if (conc) process.env.REMOTION_CONCURRENCY = String(conc);
    const outFile = join(WORK, `gfx-${label}.mp4`);
    const t0 = Date.now();
    await renderGraphicsRemotion(ref, { basePlate: base, key: `profile-${label}`, tokens, motion: m, captions: c, preset, geometry: g, durationSec, draft: false }, outFile);
    delete process.env.REMOTION_CONCURRENCY;
    const r = await lastLog(ref, "remotion");
    const row = { label, wallMs: Date.now() - t0, renderFramesMs: r?.renderFramesMs, overlayEncodeMs: r?.overlayEncodeMs, frameMs: r?.frameMs, concurrency: r?.concurrency };
    console.log("  ", JSON.stringify(row));
    return row;
  };
  console.log("isolation…");
  out.isolation = [
    await graphicsRun("empty", emptyMotion, emptyCaptions),
    await graphicsRun("captions-only", emptyMotion, captions),
    await graphicsRun("motion-only", motion, emptyCaptions),
    await graphicsRun("full", motion, captions),
  ];
  console.log("concurrency…");
  out.concurrency = [];
  for (const c of [1, 2, 4, 8]) (out.concurrency as unknown[]).push(await graphicsRun(`full-c${c}`, motion, captions, c));

  // PNG vs JPEG screenshot cost on the same composition (diagnostic: JPEG cannot carry transparency).
  console.log("png vs jpeg…");
  const { renderFrames, selectComposition } = await import("@remotion/renderer");
  const serveUrl = await remotionBundle(ref.log);
  const inputProps = { width: g.width, height: g.height, fps, durationInFrames: Math.round(durationSec * fps), safeZone: preset.safeZone, tokens, instances: motion.instances, cues: captions.cues, fontFaces: [] };
  const composition = await selectComposition({ serveUrl, id: "BrandVideo", inputProps, logLevel: "error" });
  out.screenshotFormat = [];
  for (const fmt of ["png", "jpeg"] as const) {
    const dir = join(WORK, `frames-${fmt}`);
    const t0 = Date.now();
    await renderFrames({ composition, serveUrl, inputProps, outputDir: dir, imageFormat: fmt, concurrency: Math.max(1, Math.floor(cpus().length / 2)), logLevel: "error", onStart: () => undefined, onFrameUpdate: () => undefined });
    const files = await readdir(dir);
    let bytes = 0;
    for (const f of files) bytes += (await import("node:fs")).statSync(join(dir, f)).size;
    (out.screenshotFormat as unknown[]).push({ format: fmt, frames: files.length, wallMs: Date.now() - t0, avgFrameKb: Math.round(bytes / files.length / 1024) });
    console.log("  ", fmt, Date.now() - t0, "ms");
    await rm(dir, { recursive: true, force: true });
  }

  // Preview (draft) vs export (final), fresh project → no cache.
  console.log("draft…");
  const draftProject = await buildProject("draft");
  const d0 = Date.now();
  await renderTarget(draftProject, SCN.target.id, { renderer: "remotion", draft: true });
  out.draft = { wallSec: (Date.now() - d0) / 1000, render: await lastLog(draftProject, "render"), remotion: await lastLog(draftProject, "remotion") };
}

sampler?.kill();
const probeOut = await probe(ref.abs((await lastLog(ref, "render"))?.targetId ? `renders/${SCN.target.id}-${ref.head}.mp4` : ""));
out.output = { width: probeOut.width, height: probeOut.height, fps: probeOut.fps, durationSec: probeOut.durationSec };
await mkdir(join(REPO_ROOT, "docs/measurements"), { recursive: true });
await writeFile(join(REPO_ROOT, "docs/measurements/render-profile.json"), JSON.stringify(out, null, 2) + "\n");
console.log("written docs/measurements/render-profile.json");
process.exit(0);
