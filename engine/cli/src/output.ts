import { toBveError } from "../../core/src/index.js";

export interface Envelope {
  ok: boolean;
  data?: unknown;
  version?: string;
  warnings?: string[];
  code?: string;
  message?: string;
  hint?: string;
  details?: unknown;
}

/** stdout carries exactly one JSON envelope (with --json) — logs go to stderr. */
export function emit(json: boolean, env: Envelope, human?: string): void {
  if (json) process.stdout.write(JSON.stringify(env, null, 2) + "\n");
  else if (env.ok) process.stdout.write((human ?? JSON.stringify(env.data, null, 2)) + "\n");
  else process.stderr.write(`✗ [${env.code}] ${env.message}${env.hint ? `\n  hint: ${env.hint}` : ""}\n`);
}

export function failure(err: unknown): { env: Envelope; exitCode: number } {
  const e = toBveError(err);
  return { env: { ok: false, code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.details ? { details: e.details } : {}) }, exitCode: e.exitCode };
}
