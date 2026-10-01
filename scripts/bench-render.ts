/**
 * Render timing benchmark (chantier 6). Same reference scenario as the chantier-3 profile
 * (tests/fixtures/real/reference/render-profile-scenario.json), but timing only: no verbose Remotion
 * log, no isolation experiments. Every run builds a fresh project (no stage cache), renders the
 * final deliverable, and keeps it for the quality comparison.
 *
 * Usage: tsx scripts/bench-render.ts --label <name> [--runs 3]
 * Output: tests/.tmp/perf/<label>/run<i>.mp4 and tests/.tmp/perf/<label>/timings.json
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogger, Project, readJson, REPO_ROOT } from "../engine/core/src/index.js";
import { cleanProjectAudio } from "../engine/audio/src/index.js";
import { setBrand } from "../engine/brand/src/index.js";
import { buildProjectCaptions } from "../engine/captions/src/index.js";
import { colorAutoProject } from "../engine/color/src/index.js";
import { compileProjectPlan, setPlan } from "../engine/editing/src/index.js";
import { motionFromProjectPlan } from "../engine/motion/src/index.js";
import { renderTarget } from "../engine/rendering/src/index.js";
import { importTranscript } from "../engine/transcription/src/index.js";
import { analyzeProject, ingestSource } from "../engine/vision/src/index.js";

const arg = (k: string, d: string) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1]! : d);
const label = arg("label", "baseline");
const runs = Number(arg("runs", "3"));
const REAL = join(REPO_ROOT, "tests/fixtures/real");
const SCN = await readJson<{ fixture: string; transcript: string; brandKit: string; target: { id: string; preset: string }; plan: unknown }>(join(REAL, "reference/render-profile-scenario.json"));
const OUT = join(REPO_ROOT, "tests/.tmp/perf", label);
const WORK = join(REPO_ROOT, "tests/.tmp/perf-work");
await mkdir(OUT, { recursive: true });

function startSampler(file: string): ChildProcess | undefined {
  if (process.platform !== "win32") return undefined;
  const ps = `
$ErrorActionPreference='SilentlyContinue'
while ($true) {
  $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
  $mem = Get-Process | Where-Object { $_.ProcessName -match 'chrome|node|ffmpeg' } | Group-Object { ($_.ProcessName -replace '-.*','') } | ForEach-Object { "$($_.Name)=$([math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum)/1MB))" }
  "$([DateTimeOffset]::Now.ToUnixTimeMilliseconds());$([math]::Round($cpu,1));$($mem -join ',')" | Out-File -Append -Encoding utf8 '${file}'
}`;
  return spawn("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, stdio: "ignore" });
}
async function samplesBetween(file: string, from: number, to: number) {
  const text = await readFile(file, "utf8").catch(() => "");
  const rows = text.split(/\r?\n/).filter(Boolean).map((l) => {
    const [t, cpu, mem] = l.replace(/^﻿/, "").split(";");
    return { t: Number(t), cpu: Number(cpu), mem: Object.fromEntries((mem ?? "").split(",").filter(Boolean).map((kv) => { const [k, v] = kv.split("="); return [k!, Number(v)]; })) as Record<string, number> };
  }).filter((s) => s.t >= from && s.t <= to);
  const cpu = rows.map((r) => r.cpu);
  const peak = (k: string) => Math.max(0, ...rows.map((r) => r.mem[k] ?? 0));
  return { cpuMean: cpu.length ? Math.round((cpu.reduce((a, b) => a + b, 0) / cpu.length) * 10) / 10 : null, peakMemMb: { chrome: peak("chrome"), ffmpeg: peak("ffmpeg"), node: peak("node") } };
}

async function buildProject(dir: string): Promise<Project> {
  const project = await Project.init(dir, "perf", createLogger({ projectRoot: dir, level: "info" }));
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

const results: Record<string, unknown>[] = [];
for (let i = 1; i <= runs; i++) {
  const dir = join(WORK, `${label}-${i}`);
  await rm(dir, { recursive: true, force: true });
  const project = await buildProject(dir);
  const samples = join(dir, "samples.csv");
  const sampler = startSampler(samples);
  await new Promise((r) => setTimeout(r, 3000)); // the first counter read is slow
  const t0 = Date.now();
  const rec = await renderTarget(project, SCN.target.id, { renderer: "remotion" });
  const t1 = Date.now();
  sampler?.kill();
  const logs = (await readFile(join(dir, "logs/bve.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const render = logs.filter((l) => l.profile === "render").at(-1);
  const remotion = logs.filter((l) => l.profile === "remotion").at(-1);
  const file = project.abs(rec.path);
  const kept = join(OUT, `run${i}.mp4`);
  await copyFile(file, kept);
  const row = {
    run: i, wallMs: t1 - t0, frames: render?.frames, stagesMs: render?.stagesMs,
    remotion: remotion ? { bundleMs: remotion.bundleMs, selectCompositionMs: remotion.selectCompositionMs, renderFramesMs: remotion.renderFramesMs, overlayEncodeMs: remotion.overlayEncodeMs, concurrency: remotion.concurrency } : undefined,
    bytes: (await stat(kept)).size, resources: await samplesBetween(samples, t0, t1),
  };
  results.push(row);
  console.log(JSON.stringify(row));
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const summary = {
  label, date: new Date().toISOString(), runs: results,
  median: {
    wallMs: median(results.map((r) => r.wallMs as number)),
    stagesMs: Object.fromEntries(Object.keys((results[0]!.stagesMs as object) ?? {}).map((k) => [k, median(results.map((r) => (r.stagesMs as Record<string, number>)[k]!))])),
  },
};
await writeFile(join(OUT, "timings.json"), JSON.stringify(summary, null, 1));
console.log("MEDIAN", JSON.stringify(summary.median));
