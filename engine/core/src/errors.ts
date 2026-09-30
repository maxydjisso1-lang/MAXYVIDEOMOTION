export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "MISSING_INPUT"
  | "PATH_UNSAFE"
  | "SOURCE_MODIFIED"
  | "TOOL_MISSING"
  | "FFMPEG_FAILED"
  | "RENDER_FAILED"
  | "QC_BLOCKED"
  | "NOTHING_TO_UNDO"
  | "PROJECT_EXISTS"
  | "UNSUPPORTED"
  | "INTERNAL";

const EXIT_CODES: Record<ErrorCode, number> = {
  VALIDATION: 2,
  NOT_FOUND: 3,
  MISSING_INPUT: 3,
  PATH_UNSAFE: 2,
  SOURCE_MODIFIED: 3,
  TOOL_MISSING: 4,
  FFMPEG_FAILED: 1,
  RENDER_FAILED: 1,
  QC_BLOCKED: 5,
  NOTHING_TO_UNDO: 2,
  PROJECT_EXISTS: 2,
  UNSUPPORTED: 2,
  INTERNAL: 1,
};

/** Every error surfaced to Claude carries a stable code and, when possible, an actionable hint. */
export class BveError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, opts: { hint?: string; details?: unknown; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "BveError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export function toBveError(err: unknown): BveError {
  if (err instanceof BveError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new BveError("INTERNAL", message, { cause: err });
}
