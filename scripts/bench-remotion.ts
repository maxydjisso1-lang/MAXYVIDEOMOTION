/**
 * Graphics stage benchmark (chantier 6): the real renderGraphicsRemotion on an already prepared
 * reference project, for several Chrome settings. Measures, does not decide.
 *   - REMOTION_CONCURRENCY (tabs) and BVE_REMOTION_GL (Chrome GL backend) per variant;
 *   - wall time, Remotion sub-stages, CPU / peak memory;
 *   - frame-exact comparison of the (lossless) output with the reference variant: a missing or
 *     different caption / motion frame is counted.
 *
 * Usage: tsx scripts/bench-remotion.ts --project <dir> [--runs 2] [--variants c4,c2,c6,c8,c4-angle]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createLogger, Project, REPO_ROOT, withTempDir } from "../engine/core/src/index.js";
import { ffmpeg } from "../engine/ffmpeg/src/index.js";
import { geometry, renderGraphicsRemotion } from "../engine/rendering/src/index.js";

const arg = (k: string, d: string) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1]! : d);
const dir = resolve(arg("project", join(REPO_ROOT, "tests/.tmp/perf-work/x264-lossless-1")));
const runs = Number(arg("runs", "2"));
const variants = arg("variants", "c4,c2,c6,c8,c4-angle").split(",");
const OUT = join(REPO_ROOT, "tests/.tmp/perf/remotion");
await mkdir(OUT, { recursive: true });

const project = await Project.open(dir, createLogger({ projectRoot: dir, level: "info" }));
const targetId = project.manifest.targets[0]!.id;
const preset = await project.preset(targetId);
const [tokens, motion, captions] = await Promise.all([project.readDoc("styleTokens"), project.readDocOptional("motion"), project.readDocOptional("captions")]);
const base = join(dir, "renders/cache", (await readdir(join(dir, "renders/cache"))).find((n) => /^base-.*\.mp4$/.test(n))!);
const g = geometry(preset, false);
const durationSec = 592 / g.fps;

function sampler(file: string): ChildProcess | undefined {
  if (process.platform !== "win32") return undefined;
  const ps = `while ($true) { $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime; $c = (Get-Process | Where-Object { $_.ProcessName -match 'chrome' } | Measure-Object WorkingSet64 -Sum).Sum; "$([math]::Round($cpu,1));$([math]::Round($c/1MB))" | Out-File -Append -Encoding utf8 '${file}' }`;
  return spawn("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, stdio: "ignore" });
}

/** Frames whose PSNR to the reference is not infinite (lossless outputs: any difference counts). */
async function frameDiff(a: string, ref: string): Promise<{ differing: number[]; worstPsnr: number }> {
  return withTempDir(async (tmp) => {
    await ffmpeg(["-i", a, "-i", ref, "-lavfi", "[0:v][1:v]psnr=stats_file=p.txt", "-f", "null", "-"], { cwd: tmp });
    const rows = (await readFile(join(tmp, "p.txt"), "utf8")).split(/\r?\n/).filter(Boolean).map((l) => ({ n: Number(/n:(\d+)/.exec(l)![1]) - 1, p: /psnr_avg:inf/.test(l) ? Infinity : Number(/psnr_avg:([\d.]+)/.exec(l)![1]) }));
    const diff = rows.filter((r) => r.p !== Infinity);
    return { differing: diff.map((r) => r.n), worstPsnr: diff.length ? Math.round(Math.min(...diff.map((r) => r.p)) * 10) / 10 : Infinity };
  });
}

const rows: Record<string, unknown>[] = [];
let ref: string | undefined;
for (let r = 1; r <= runs; r++) {
  for (const v of variants) {
    const [c, gl] = v.split("-");
    process.env.REMOTION_CONCURRENCY = c!.slice(1);
    if (gl) process.env.BVE_REMOTION_GL = gl;
    else delete process.env.BVE_REMOTION_GL;
    const out = join(OUT, `${v}-run${r}.mp4`);
    const samples = join(OUT, `${v}-run${r}.csv`);
    const s = sampler(samples);
    await new Promise((res) => setTimeout(res, 2500));
    const t0 = Date.now();
    await renderGraphicsRemotion(project, { basePlate: base, key: `bench-${v}-${r}`, tokens, motion, captions, preset, geometry: g, durationSec, draft: false }, out);
    const wallMs = Date.now() - t0;
    s?.kill();
    const sm = (await readFile(samples, "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).map((l) => l.replace(/^﻿/, "").split(";").map(Number));
    const logs = (await readFile(join(dir, "logs/bve.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const rem = logs.filter((l) => l.profile === "remotion").at(-1);
    ref ??= out;
    const diff = out === ref ? { differing: [], worstPsnr: Infinity } : await frameDiff(out, ref);
    const row = {
      variant: v, run: r, wallMs, renderFramesMs: rem?.renderFramesMs, overlayEncodeMs: rem?.overlayEncodeMs, selectCompositionMs: rem?.selectCompositionMs, frameMsP50: rem?.frameMs?.p50,
      cpuMean: sm.length ? Math.round((sm.reduce((a, x) => a + x[0]!, 0) / sm.length) * 10) / 10 : null, chromePeakMb: Math.max(0, ...sm.map((x) => x[1]!)),
      framesDifferingFromRef: diff.differing.length, differingFrames: diff.differing.slice(0, 20), worstPsnr: diff.worstPsnr,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
}
delete process.env.REMOTION_CONCURRENCY;
delete process.env.BVE_REMOTION_GL;
