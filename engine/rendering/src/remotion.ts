/**
 * Pass B (primary renderer) — Remotion. The bundle is built once per engine source hash and
 * reused; per-render media are linked into the bundle's public/ folder under a unique key.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cpus } from "node:os";
import { BveError, existsSync, REMOTION_ENTRY, REPO_ROOT, withTempDir, type Captions, type MotionDoc, type Preset, type Project, type StyleTokens } from "../../core/src/index.js";
import { ffmpeg } from "../../ffmpeg/src/index.js";
import { resolveFonts } from "../../brand/src/index.js";
import type { BrandVideoProps } from "../../remotion/src/props.js";
import { linkOrCopy } from "./cache.js";
import type { Geometry } from "./basePlate.js";

export interface RemotionStatus {
  available: boolean;
  reason?: string;
}

let status: RemotionStatus | undefined;

/** Capability detection: packages importable AND a headless browser available (downloaded on first use). */
export async function remotionStatus(log?: Project["log"]): Promise<RemotionStatus> {
  if (status) return status;
  try {
    const renderer = await import("@remotion/renderer");
    await import("@remotion/bundler");
    log?.info("checking Remotion headless browser (first run downloads it)");
    await renderer.ensureBrowser();
    status = { available: true };
  } catch (err) {
    status = { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return status;
}

async function sourceHash(dir: string, acc = createHash("sha256")): Promise<string> {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await sourceHash(p, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.update(entry.name).update(await readFile(p));
  }
  return acc.digest("hex").slice(0, 16);
}

let bundlePromise: Promise<string> | undefined;

async function getBundle(log: Project["log"]): Promise<string> {
  bundlePromise ??= (async () => {
    const hash = createHash("sha256");
    for (const d of ["engine/remotion/src", "engine/motion/src"]) hash.update(await sourceHash(join(REPO_ROOT, d)));
    const outDir = join(REPO_ROOT, "engine/remotion/.bundle", hash.digest("hex").slice(0, 16));
    if (existsSync(join(outDir, "index.html"))) return outDir;
    const { bundle } = await import("@remotion/bundler");
    log.info("bundling Remotion compositions (cached afterwards)");
    await bundle({
      entryPoint: REMOTION_ENTRY,
      outDir,
      // The engine uses NodeNext-style ".js" specifiers for TypeScript files.
      webpackOverride: (config) => ({
        ...config,
        resolve: { ...config.resolve, extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
      }),
    });
    return outDir;
  })();
  return bundlePromise;
}

/**
 * Remotion renders ONLY the graphics layer (transparent PNG frames); FFmpeg composites it over
 * the base plate. Chrome never decodes video, so rendering is deterministic and faster, and the
 * two layers are aligned frame for frame.
 */
export async function renderGraphicsRemotion(
  project: Project,
  args: { basePlate: string; key: string; tokens: StyleTokens; motion?: MotionDoc; captions?: Captions; preset: Preset; geometry: Geometry; durationSec: number; draft: boolean },
  out: string,
): Promise<void> {
  const { renderFrames, selectComposition } = await import("@remotion/renderer");
  // Profiling (chantier 3): sub-stage wall times + Remotion's own per-frame times. No behaviour change.
  const prof: Record<string, number> = {};
  let mark = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    prof[name] = Math.round(now - mark);
    mark = now;
  };
  const remotionLog = (process.env.BVE_REMOTION_LOG as "error" | "info" | "verbose" | undefined) ?? "error";
  const serveUrl = await getBundle(project.log);
  lap("bundleMs");
  const pub = join(serveUrl, "public", args.key);
  let logoSrc: string | undefined;
  const logo = args.tokens.logo?.primary;
  if (logo && existsSync(project.abs(logo))) {
    const name = `logo${logo.slice(logo.lastIndexOf("."))}`;
    await linkOrCopy(project.abs(logo), join(pub, name));
    logoSrc = `${args.key}/${name}`;
  }
  // Only project font FILES are loaded (brand font, else its declared fallback). The composition
  // blocks rendering until each FontFace has loaded, and fails loudly if one cannot.
  const fontFaces: BrandVideoProps["fontFaces"] = [];
  const seen = new Set<string>();
  for (const face of resolveFonts(project, args.tokens).flatMap((r) => r.faces)) {
    if (seen.has(`${face.family}|${face.weight}|${face.path}`)) continue;
    seen.add(`${face.family}|${face.weight}|${face.path}`);
    const name = `font-${fontFaces.length}${face.path.slice(face.path.lastIndexOf("."))}`;
    await linkOrCopy(project.abs(face.path), join(pub, name));
    fontFaces.push({ family: face.family, src: `${args.key}/${name}`, weight: face.weight });
  }
  const fps = args.geometry.fps;
  const durationInFrames = Math.max(1, Math.round(args.durationSec * fps));
  const inputProps: BrandVideoProps = {
    width: args.geometry.width,
    height: args.geometry.height,
    fps,
    durationInFrames,
    safeZone: args.preset.safeZone,
    tokens: args.tokens,
    instances: args.motion?.instances ?? [],
    cues: args.captions?.cues ?? [],
    ...(logoSrc ? { logoSrc } : {}),
    fontFaces,
  };
  lap("assetsMs");
  const frameMs: number[] = new Array(durationInFrames).fill(0);
  try {
    await withTempDir(async (dir) => {
      const framesDir = join(dir, "frames");
      const composition = await selectComposition({ serveUrl, id: "BrandVideo", inputProps, logLevel: remotionLog });
      lap("selectCompositionMs");
      await renderFrames({
        composition,
        serveUrl,
        inputProps,
        outputDir: framesDir,
        imageFormat: "png",
        imageSequencePattern: "g-[frame].[ext]",
        concurrency: Number(process.env.REMOTION_CONCURRENCY) || Math.max(1, Math.floor(cpus().length / 2)),
        logLevel: remotionLog,
        onStart: () => undefined,
        // Remotion reports each frame's wall time (seek + screenshot + write).
        onFrameUpdate: (_done, frame, ms) => {
          frameMs[frame] = Math.round(ms * 10) / 10;
        },
      });
      lap("renderFramesMs");
      const files = (await readdir(framesDir)).filter((n) => /^g-\d+\.png$/.test(n)).sort();
      if (files.length !== durationInFrames) throw new Error(`expected ${durationInFrames} graphics frames, got ${files.length}`);
      const digits = /^g-(\d+)\.png$/.exec(files[0]!)![1]!;
      await ffmpeg(
        [
          "-i", args.basePlate,
          "-framerate", String(fps), "-start_number", String(Number(digits)), "-i", join(framesDir, `g-%0${digits.length}d.png`),
          "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto:eof_action=pass,format=yuv420p[out]",
          "-map", "[out]", "-an", "-c:v", "libx264", "-preset", args.draft ? "veryfast" : "medium", "-crf", args.draft ? "22" : "15",
          "-frames:v", String(durationInFrames), out,
        ],
        { log: project.log },
      );
      lap("overlayEncodeMs");
      const sorted = [...frameMs].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      project.log.info(
        {
          profile: "remotion",
          frames: durationInFrames,
          concurrency: Number(process.env.REMOTION_CONCURRENCY) || Math.max(1, Math.floor(cpus().length / 2)),
          ...prof,
          frameMs: { mean: Math.round((frameMs.reduce((a, b) => a + b, 0) / Math.max(1, frameMs.length)) * 10) / 10, p50: q(0.5), p95: q(0.95), max: sorted.at(-1) ?? 0 },
          slowestFrames: frameMs.map((ms, frame) => ({ frame, ms })).sort((a, b) => b.ms - a.ms).slice(0, 10),
        },
        "remotion timings",
      );
      project.log.debug({ profile: "remotion-frames", frameMs }, "remotion per-frame times");
    }, project.abs(".cache/tmp"));
  } catch (err) {
    throw new BveError("RENDER_FAILED", `Remotion render failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err, hint: "Retry with `--renderer ass` to use the FFmpeg/libass fallback." });
  } finally {
    await rm(pub, { recursive: true, force: true });
  }
}

/** The cached Remotion bundle (exposed for profiling diagnostics, scripts/profile-render.ts). */
export const remotionBundle = (log: Project["log"]) => getBundle(log);
