import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { BveError } from "./errors.js";

/** Resolve a project-relative path, rejecting absolute paths and traversal outside the project. */
export function resolveInProject(projectRoot: string, rel: string): string {
  if (!rel || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new BveError("PATH_UNSAFE", `Expected a project-relative path, got "${rel}"`);
  }
  const abs = resolve(projectRoot, rel);
  const back = relative(projectRoot, abs);
  if (back.startsWith("..") || isAbsolute(back)) {
    throw new BveError("PATH_UNSAFE", `Path "${rel}" escapes the project directory`);
  }
  return abs;
}

/** Engine outputs must never land in source/ — originals are read-only after ingest. */
export function assertWritable(projectRoot: string, rel: string): string {
  const abs = resolveInProject(projectRoot, rel);
  const back = toProjectRel(projectRoot, abs);
  if (back === "source" || back.startsWith("source/")) {
    throw new BveError("PATH_UNSAFE", `Refusing to write into source/ ("${rel}"): sources are read-only`);
  }
  return abs;
}

/** Project-relative POSIX path (what documents store). */
export function toProjectRel(projectRoot: string, abs: string): string {
  return normalize(relative(projectRoot, abs)).split(sep).join("/");
}

/** Filesystem-safe id from an arbitrary name: "My Clip (1).MP4" -> "my_clip_1". */
export function slugId(name: string, prefix = ""): string {
  const base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  const id = `${prefix}${base || "item"}`;
  return /^[a-z]/.test(id) ? id : `x${id}`;
}
