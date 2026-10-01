/**
 * Decompose the three FFmpeg video passes of a profiled render (chantier 3). MEASURES ONLY.
 * Replays each pass with the EXACT arguments the engine logged (logs/bve.jsonl, "ffmpeg start"),
 * then the same pass with a null output (decode + filters, no encode). Encode cost = difference.
 *
 * Usage: tsx scripts/profile-ffmpeg.ts [projectDir]   (default: tests/.tmp/profile/reference)
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../engine/core/src/index.js";
import { ffmpeg } from "../engine/ffmpeg/src/index.js";

const dir = process.argv[2] ?? join(REPO_ROOT, "tests/.tmp/profile/reference");
const logs = (await readFile(join(dir, "logs/bve.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { msg?: string; tool?: string; args?: string[] });
const starts = logs.filter((l) => l.msg === "ffmpeg start" && Array.isArray(l.args));

// Identify the video passes by their output file name.
const pick = (re: RegExp) => starts.find((l) => re.test(l.args!.at(-1) ?? ""));
const passes = [
  ["base plate", pick(/base-[0-9a-f]+\.mp4\.[0-9a-f]+\.partial\.mp4$/)],
  ["graphics overlay", pick(/gfx-[0-9a-f]+\.mp4\.[0-9a-f]+\.partial\.mp4$/)],
  ["final encode", pick(/renders[\\/][a-z0-9_]+-v\d{4}\.mp4$/)],
] as const;

const tmp = join(dir, ".cache/profile-ffmpeg");
const results: Record<string, unknown>[] = [];
for (const [name, entry] of passes) {
  if (!entry) {
    console.log(`skip ${name}: not found in the log`);
    continue;
  }
  // The runner prepends -hide_banner -nostdin -y; the logged args are what it received.
  const args = entry.args!.filter((a) => !["-hide_banner", "-nostdin", "-y"].includes(a));
  const outIdx = args.length - 1;
  const encodeOut = join(tmp, `${name.replace(/\s/g, "-")}.mp4`);
  const withEncode = [...args.slice(0, outIdx), encodeOut];
  // Null pass: drop the codec/rate-control options, decode + filter to /dev/null.
  const codecOpts = new Set(["-c:v", "-preset", "-crf", "-g", "-bf", "-profile:v", "-maxrate", "-bufsize", "-c:a", "-b:a", "-movflags", "-color_primaries", "-color_trc", "-colorspace", "-color_range", "-pix_fmt"]);
  const nullArgs: string[] = [];
  for (let i = 0; i < outIdx; i++) {
    if (codecOpts.has(args[i]!)) {
      i++;
      continue;
    }
    nullArgs.push(args[i]!);
  }
  nullArgs.push("-f", "null", "-");
  // The partial/temporary inputs (PNG frames of the graphics pass) were deleted after the render.
  const missingInput = args.some((a, i) => args[i - 1] === "-i" && /frames[\\/]g-%0\dd\.png$/.test(a));
  if (missingInput) {
    console.log(`skip ${name}: its PNG frames were temporary (measured in the isolation runs instead)`);
    continue;
  }
  const { mkdir } = await import("node:fs/promises");
  await mkdir(tmp, { recursive: true });
  const t0 = performance.now();
  await ffmpeg(withEncode, { cwd: dir });
  const full = performance.now() - t0;
  const t1 = performance.now();
  await ffmpeg(nullArgs, { cwd: dir });
  const decodeFilter = performance.now() - t1;
  const row = { pass: name, fullMs: Math.round(full), decodeFilterMs: Math.round(decodeFilter), encodeMs: Math.round(full - decodeFilter), encoder: args[args.indexOf("-c:v") + 1], preset: args[args.indexOf("-preset") + 1], crf: args[args.indexOf("-crf") + 1] };
  results.push(row);
  console.log(JSON.stringify(row));
}
// Base plate filter breakdown: same inputs, graph variants, null output (decode + filters only).
const baseEntry = passes[0][1];
const filterBreakdown: Record<string, unknown>[] = [];
if (baseEntry) {
  const args = baseEntry.args!.filter((a) => !["-hide_banner", "-nostdin", "-y"].includes(a));
  const gi = args.indexOf("-filter_complex");
  const graph = args[gi + 1]!;
  const inputs = args.slice(0, gi);
  const colour = /,(colorchannelmixer|eq|curves|colorbalance|vibrance|hue|lut3d)=('[^']*'|[^,[;])*/g;
  const variants: [string, string][] = [
    ["decode + all filters (as rendered)", graph],
    ["without colour filters", graph.replace(colour, "")],
    ["lanczos scaling replaced by bilinear", graph.replace(/flags=lanczos/g, "flags=bilinear")],
    ["decode + trim + fps only", graph.replace(colour, "").replace(/,crop=[^,[;]*,scale=[^,[;]*/g, "")],
    // One colour filter type removed at a time: which one carries the cost.
    ...(["colorchannelmixer", "eq", "curves", "colorbalance"] as const).map((t): [string, string] => [`without ${t} only`, graph.replace(new RegExp(`,${t}=('[^']*'|[^,[;])*`, "g"), "")]),
  ];
  console.log(`base plate: ${(graph.match(/\[\d+:v\]/g) ?? []).length} clip inputs, ${(graph.match(/colorchannelmixer=|eq=|curves=|colorbalance=|vibrance=/g) ?? []).length} colour filters`);
  for (const [label, g] of variants) {
    const t0 = performance.now();
    await ffmpeg([...inputs, "-filter_complex", g, "-map", "[vout]", "-f", "null", "-"], { cwd: dir });
    const row = { variant: label, ms: Math.round(performance.now() - t0) };
    filterBreakdown.push(row);
    console.log(JSON.stringify(row));
  }
}
await rm(tmp, { recursive: true, force: true });
const file = join(REPO_ROOT, "docs/measurements/render-profile-ffmpeg.json");
await writeFile(file, JSON.stringify({ date: new Date().toISOString(), project: dir.replace(REPO_ROOT, "."), results, filterBreakdown }, null, 2) + "\n");
console.log(`written ${file}`);
