/**
 * Maintenance script: fetch the example brands' Google fonts (all SIL OFL 1.1) into each kit's
 * fonts/ folder and point the kit's brand.json at them. Run once; the files are committed so
 * tests never need the network or installed fonts.
 */
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Project, readJson, REPO_ROOT, writeJsonAtomic, type Brand } from "../engine/core/src/index.js";
import { fetchBrandFonts, setBrand } from "../engine/brand/src/index.js";

for (const kit of ["maison-lune", "volt-street"]) {
  const kitDir = join(REPO_ROOT, "examples/brands", kit);
  const tmp = join(REPO_ROOT, "tests/.tmp", `vendor-fonts-${kit}`);
  await rm(tmp, { recursive: true, force: true });
  const project = await Project.init(tmp, `fonts ${kit}`);
  await setBrand(project, kitDir);
  const report = await fetchBrandFonts(project);
  const fontsDir = join(kitDir, "fonts");
  await mkdir(fontsDir, { recursive: true });
  for (const f of await readdir(project.abs("brand/fonts"))) await cp(join(project.abs("brand/fonts"), f), join(fontsDir, f));
  const brand = await readJson<Brand>(project.abs("brand/brand.json"));
  await writeJsonAtomic(join(kitDir, "brand.json"), brand);
  const families = [...new Set(brand.identity.fonts.flatMap((f) => [f.source?.kind === "file" && f.source.files ? f.family : undefined, f.fallbackSource ? f.fallback : undefined]).filter(Boolean))];
  await writeFile(
    join(fontsDir, "LICENSES.md"),
    `# Fonts in this kit\n\n${families.map((f) => `- **${f}** — SIL Open Font License 1.1, downloaded from Google Fonts (https://fonts.google.com/specimen/${String(f).replace(/ /g, "+")}).`).join("\n")}\n\nThe OFL allows bundling and redistribution with software. Full text: https://openfontlicense.org/open-font-license-official-text/\n`,
  );
  console.log(kit, report.roles.map((r) => `${r.role}:${r.status}`).join(" "), report.fetched);
}
