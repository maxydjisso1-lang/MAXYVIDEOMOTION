import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addWaiver, Project, readWaivers, REPO_ROOT, writeRenderRecord, type RenderRecord } from "../../engine/core/src/index.js";
import { compileStyleTokens, readFontFile, resolveFonts, setBrand } from "../../engine/brand/src/index.js";
import { fileHashes, stageKey } from "../../engine/rendering/src/index.js";
import { freshDir, loadBrand } from "../helpers.js";

const kit = (name: string) => join(REPO_ROOT, "examples/brands", name);

describe("font files", () => {
  it("reads the legacy family and weight libass matches on", () => {
    const info = readFontFile(join(kit("maison-lune"), "fonts/Inter-600.ttf"));
    expect(info.family).toBe("Inter SemiBold");
    expect(info.typographicFamily).toBe("Inter");
    expect(info.weight).toBe(600);
    expect(info.postscript).toBe("Inter-SemiBold");
  });
});

describe("brand fonts: FOUND / FALLBACK / MISSING", () => {
  it("reports found and fallback from the kit files", async () => {
    const p = await Project.init(await freshDir("unit-fonts-a"), "Fonts A");
    const r = await setBrand(p, kit("maison-lune"));
    const byRole = Object.fromEntries(r.fonts.map((f) => [f.role, f.status]));
    expect(byRole).toEqual({ display: "fallback", body: "found", caption: "found" }); // Canela is commercial and absent
    expect(r.issues.some((i) => i.message.startsWith("FONT FALLBACK"))).toBe(true);
  });

  it("reports missing when neither the brand font nor a fallback file exists (never a silent system font)", async () => {
    const p = await Project.init(await freshDir("unit-fonts-b"), "Fonts B");
    const brand = loadBrand("volt-street");
    brand.identity.fonts = brand.identity.fonts.map((f) => (f.role === "caption" ? { role: "caption" as const, family: "Nonexistent Sans", weights: [800] } : f)) as typeof brand.identity.fonts;
    brand.caption.font = "caption";
    const dir = await freshDir("unit-fonts-b-kit");
    await import("node:fs/promises").then((fs) => fs.cp(kit("volt-street"), dir, { recursive: true }));
    await writeFile(join(dir, "brand.json"), JSON.stringify(brand));
    const r = await setBrand(p, dir);
    const caption = r.fonts.find((f) => f.role === "caption")!;
    expect(caption.status).toBe("missing");
    expect(caption.detail).toMatch(/brand fonts fetch/);
    expect(resolveFonts(p, compileStyleTokens(brand, 30)).find((f) => f.role === "display")!.status).toBe("found");
  });
});

describe("render artifacts are schema-validated", () => {
  it("rejects an invalid render record", async () => {
    const p = await Project.init(await freshDir("unit-artifacts"), "Artifacts");
    const bad = { targetId: "ig", version: p.head, draft: false, renderer: "magic", path: "renders/x.mp4", sha256: "0".repeat(64), durationSec: 1, stages: { base: "a", mix: "b" }, cacheHits: [], createdAt: new Date().toISOString() };
    await expect(writeRenderRecord(p, bad as unknown as RenderRecord)).rejects.toThrow(/render-record/);
  });
  it("rejects malformed waivers", async () => {
    const p = await Project.init(await freshDir("unit-waivers"), "Waivers");
    await expect(addWaiver(p, "not a check id", "because")).rejects.toThrow(/qc-waivers/);
    await addWaiver(p, "technical.black-frames", "intentional fade to black");
    expect((await readWaivers(p)).length).toBe(1);
  });
});

describe("render cache keys", () => {
  it("change when a referenced file's CONTENT changes, even at the same path", async () => {
    const p = await Project.init(await freshDir("unit-cache"), "Cache");
    await writeFile(p.abs("assets/logo.png"), "v1");
    const k1 = stageKey("graphics", { assets: await fileHashes(p, ["assets/logo.png"]) });
    await writeFile(p.abs("assets/logo.png"), "v2");
    const k2 = stageKey("graphics", { assets: await fileHashes(p, ["assets/logo.png"]) });
    expect(k1).not.toBe(k2);
    expect(stageKey("graphics", { a: 1, b: 2 })).toBe(stageKey("graphics", { b: 2, a: 1 }));
  });
});
