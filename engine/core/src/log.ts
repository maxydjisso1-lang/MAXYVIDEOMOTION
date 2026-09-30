import { mkdirSync } from "node:fs";
import { join } from "node:path";
import pino, { type Logger } from "pino";

export type { Logger };

/**
 * Structured logs: JSON lines to stderr (stdout is reserved for the CLI result envelope)
 * and, when a project is known, appended to <project>/logs/bve.jsonl for auditability.
 */
export function createLogger(opts: { projectRoot?: string; level?: string } = {}): Logger {
  const level = opts.level ?? process.env.BVE_LOG_LEVEL ?? "info";
  const streams: pino.StreamEntry[] = [{ level: level as pino.Level, stream: pino.destination({ fd: 2, sync: true }) }];
  if (opts.projectRoot) {
    const dir = join(opts.projectRoot, "logs");
    mkdirSync(dir, { recursive: true });
    streams.push({ level: "debug", stream: pino.destination({ dest: join(dir, "bve.jsonl"), sync: true, mkdir: true }) });
  }
  return pino({ level: "debug", base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, pino.multistream(streams));
}

export const silentLogger: Logger = pino({ level: "silent" });
