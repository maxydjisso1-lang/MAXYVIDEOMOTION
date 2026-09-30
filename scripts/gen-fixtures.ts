/** Generates synthetic test media and the example brand logos. Idempotent. */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../engine/core/src/index.js";
import { generateAll, generateLogo } from "../tests/fixtures/generate.js";

const out = await generateAll(join(REPO_ROOT, "tests/fixtures/generated"));
console.log("fixtures:", out);

for (const [brand, kind, color, file] of [
  ["maison-lune", "crescent", "#111111", "maison-lune.png"],
  ["volt-street", "bolt", "#39FF14", "volt.png"],
] as const) {
  const dir = join(REPO_ROOT, "examples/brands", brand, "assets/logo");
  await mkdir(dir, { recursive: true });
  console.log("logo:", await generateLogo(kind, color, join(dir, file)));
}
