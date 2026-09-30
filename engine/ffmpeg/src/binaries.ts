import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BveError } from "../../core/src/index.js";

export interface Binaries {
  ffmpeg: string;
  ffprobe: string;
}

let cached: Binaries | undefined;

function works(bin: string): boolean {
  const r = spawnSync(bin, ["-hide_banner", "-version"], { encoding: "utf8", windowsHide: true });
  return r.status === 0;
}

/** winget installs FFmpeg per-user; its PATH shim only appears in NEW shells. Look there too. */
function wingetCandidates(name: string): string[] {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== "win32" || !local) return [];
  const pkgs = join(local, "Microsoft", "WinGet", "Packages");
  if (!existsSync(pkgs)) return [];
  const out: string[] = [];
  for (const pkg of readdirSync(pkgs).filter((d) => /ffmpeg/i.test(d))) {
    for (const build of readdirSync(join(pkgs, pkg))) {
      const p = join(pkgs, pkg, build, "bin", `${name}.exe`);
      if (existsSync(p)) out.push(p);
    }
  }
  return out.sort().reverse();
}

function resolveOne(name: "ffmpeg" | "ffprobe"): string {
  const env = name === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  for (const candidate of [env, name, ...wingetCandidates(name)]) {
    if (candidate && works(candidate)) return candidate;
  }
  throw new BveError("TOOL_MISSING", `${name} was not found`, {
    hint: process.platform === "win32"
      ? "Install it with `winget install Gyan.FFmpeg`, or set FFMPEG_PATH / FFPROBE_PATH."
      : "Install FFmpeg >= 6.1 (e.g. `brew install ffmpeg` / `apt install ffmpeg`), or set FFMPEG_PATH / FFPROBE_PATH.",
  });
}

export function binaries(): Binaries {
  cached ??= { ffmpeg: resolveOne("ffmpeg"), ffprobe: resolveOne("ffprobe") };
  return cached;
}

export interface FfmpegCapabilities {
  version: string;
  filters: Set<string>;
  encoders: Set<string>;
}

let caps: FfmpegCapabilities | undefined;

export function capabilities(): FfmpegCapabilities {
  if (caps) return caps;
  const { ffmpeg } = binaries();
  const run = (args: string[]) => spawnSync(ffmpeg, ["-hide_banner", ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).stdout ?? "";
  const version = /ffmpeg version (\S+)/.exec(run(["-version"]))?.[1] ?? "unknown";
  const col2 = (text: string) => new Set(text.split(/\r?\n/).map((l) => l.trim().split(/\s+/)[1]).filter((x): x is string => !!x));
  caps = { version, filters: col2(run(["-filters"])), encoders: col2(run(["-encoders"])) };
  return caps;
}

export function hasFilter(name: string): boolean {
  return capabilities().filters.has(name);
}
