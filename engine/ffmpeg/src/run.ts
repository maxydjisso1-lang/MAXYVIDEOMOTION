import { spawn } from "node:child_process";
import { BveError, silentLogger, type Logger } from "../../core/src/index.js";
import { binaries } from "./binaries.js";

export interface RunOptions {
  cwd?: string;
  log?: Logger;
  signal?: AbortSignal;
  /** Keep the full stderr (analysis filters print their results there). Default keeps the last 64 KB. */
  captureStderr?: boolean;
  onProgress?: (seconds: number) => void;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

const TAIL = 64 * 1024;

/** Spawn with an argument array (never a shell string): no quoting bugs, no injection. */
function exec(bin: string, args: string[], opts: RunOptions, tool: string): Promise<RunResult> {
  const log = opts.log ?? silentLogger;
  log.debug({ tool, args }, `${tool} start`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, windowsHide: true, signal: opts.signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      if (!opts.captureStderr && stderr.length > TAIL * 2) stderr = stderr.slice(-TAIL);
      if (opts.onProgress) {
        const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(d);
        if (m) opts.onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });
    child.on("error", (err) => reject(new BveError("TOOL_MISSING", `Cannot run ${tool}: ${err.message}`, { cause: err })));
    child.on("close", (code) => {
      if (code === 0) {
        log.debug({ tool }, `${tool} done`);
        resolvePromise({ stdout, stderr });
      } else {
        const tail = stderr.trim().split(/\r?\n/).slice(-15).join("\n");
        reject(new BveError("FFMPEG_FAILED", `${tool} exited with code ${code}:\n${tail}`, { details: { args } }));
      }
    });
  });
}

export function ffmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return exec(binaries().ffmpeg, ["-hide_banner", "-nostdin", "-y", ...args], opts, "ffmpeg");
}

export function ffprobe(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return exec(binaries().ffprobe, ["-hide_banner", ...args], opts, "ffprobe");
}

/**
 * Escape a value for use inside a filtergraph option (e.g. `ass=filename=...`).
 * Prefer running FFmpeg with `cwd` set and relative paths; this handles the rest,
 * including Windows drive colons and backslashes.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, "/").replace(/([:'\[\],;=])/g, "\\$1");
}

/**
 * A file path as a filter option value (e.g. arnndn=m=…): quoted, with ':' escaped, so a Windows
 * drive letter survives BOTH filtergraph parsing levels. Verified with FFmpeg 9 on Windows.
 */
export function quoteFilterPath(path: string): string {
  return `'${path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''")}'`;
}
