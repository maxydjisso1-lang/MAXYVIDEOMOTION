import { cp, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BveError, existsSync, readJson, validate, type Brand, type Project, type StyleTokens } from "../../core/src/index.js";
import { addAsset } from "../../vision/src/index.js";
import { contrastRatio } from "./color.js";
import { compileStyleTokens } from "./tokens.js";

export interface BrandIssue {
  level: "error" | "warning";
  field: string;
  message: string;
}

/** Checks beyond the schema: legibility and referenced files. */
export function checkBrand(brand: Brand, project?: Project): BrandIssue[] {
  const issues: BrandIssue[] = [];
  const t = compileStyleTokens(brand, 30);
  const pairs: [string, string, string][] = [
    ["/identity (onPrimary on primary)", t.color.onPrimary, t.color.primary],
    ["/identity (onAccent on accent)", t.color.onAccent, t.color.accent],
    ["/identity/neutrals (foreground on background)", t.color.foreground, t.color.background],
  ];
  for (const [field, fg, bg] of pairs) {
    const ratio = contrastRatio(fg, bg);
    if (ratio < 4.5) issues.push({ level: "warning", field, message: `Contrast ${ratio.toFixed(2)}:1 is below WCAG AA (4.5:1) for text ${fg} on ${bg}` });
  }
  if (project) {
    const refs: [string, string | undefined][] = [
      ["/identity/logo/primary", brand.identity.logo.primary],
      ["/grade/lut", brand.grade?.lut],
      ...brand.identity.fonts.map((f, i) => [`/identity/fonts/${i}`, f.source?.kind === "file" ? f.source.path : undefined] as [string, string | undefined]),
    ];
    for (const [field, rel] of refs) {
      if (!rel) continue;
      if (!existsSync(project.abs(rel))) {
        const isFont = field.startsWith("/identity/fonts");
        issues.push({
          level: field === "/identity/logo/primary" ? "error" : "warning",
          field,
          message: isFont ? `Font file ${rel} not found: the fallback font will be used` : `Referenced file ${rel} not found in the project`,
        });
      }
    }
  }
  return issues;
}

/**
 * Install a Brand DNA into the project. Accepts a brand.json file or a brand-kit folder
 * (brand.json + assets/). Kit assets are imported under the project's assets/.
 * Writes brand.json AND the compiled style tokens in one version.
 */
export async function setBrand(project: Project, input: string, fps?: number): Promise<{ brand: Brand; tokens: StyleTokens; issues: BrandIssue[] }> {
  const abs = resolve(input);
  const isDir = existsSync(abs) && (await stat(abs)).isDirectory();
  const file = isDir ? join(abs, "brand.json") : abs;
  if (!existsSync(file)) throw new BveError("MISSING_INPUT", `No brand.json at ${input}`);
  const brand = validate<Brand>("brand", await readJson(file), file);

  const kitAssets = join(isDir ? abs : dirname(abs), "assets");
  if (existsSync(kitAssets)) {
    await cp(kitAssets, project.abs("assets"), { recursive: true, force: false, errorOnExist: false });
    if (existsSync(project.abs(brand.identity.logo.primary))) await addAsset(project, project.abs(brand.identity.logo.primary), "logo", { as: brand.identity.logo.primary });
  }
  const issues = checkBrand(brand, project);
  const blocking = issues.filter((i) => i.level === "error");
  if (blocking.length) {
    throw new BveError("VALIDATION", `Brand DNA has blocking issues:\n  - ${blocking.map((i) => `${i.field}: ${i.message}`).join("\n  - ")}`, { details: issues });
  }
  const tokens = compileStyleTokens(brand, fps ?? (await projectFps(project)));
  await project.writeDocs({ brand, styleTokens: tokens }, { command: "brand set", message: `Brand DNA "${brand.name}" installed; style tokens compiled` });
  return { brand, tokens, issues };
}

export async function recompileTokens(project: Project, fps?: number): Promise<StyleTokens> {
  const brand = await project.readDoc("brand");
  const tokens = compileStyleTokens(brand, fps ?? (await projectFps(project)));
  await project.writeDoc("styleTokens", tokens, { command: "brand tokens", message: "Style tokens recompiled" });
  return tokens;
}

/** Tokens are compiled for the delivery frame rate (the first target's, else 30). */
async function projectFps(project: Project): Promise<number> {
  const first = project.manifest.targets[0];
  return first ? (await project.preset(first.id)).fps : 30;
}

/** Stale tokens mean the render would not reflect the current brand: always check before rendering. */
export async function ensureFreshTokens(project: Project, fps: number): Promise<StyleTokens> {
  const brand = await project.readDoc("brand");
  const current = await project.readDocOptional("styleTokens");
  const fresh = compileStyleTokens(brand, fps);
  if (current && current.brandHash === fresh.brandHash && current.fps === fps) return current;
  await project.writeDoc("styleTokens", fresh, { actor: "engine", command: "brand tokens", message: `Style tokens recompiled (${current ? "brand or fps changed" : "missing"})` });
  return fresh;
}
