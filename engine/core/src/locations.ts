import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, resolved from this file (works from sources via tsx and from dist/). */
function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "brand-video-engine") return dir;
    } catch {
      /* keep walking up */
    }
    dir = resolve(dir, "..");
  }
  throw new Error("brand-video-engine: cannot locate repository root");
}

export const REPO_ROOT = findRepoRoot();
export const SCHEMAS_DIR = join(REPO_ROOT, "schemas");
export const PRESETS_DIR = join(REPO_ROOT, "presets");
export const REMOTION_ENTRY = join(REPO_ROOT, "engine/remotion/src/index.ts");
export const ENGINE_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
export const SCHEMA_VERSION = "1.0";
