import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWritable, isValid, Project, resolveInProject, SCHEMAS_DIR, subtractRanges, validate, type Timeline,
} from "../../engine/core/src/index.js";
import { compileStyleTokens } from "../../engine/brand/src/index.js";
import { FIXTURES, freshDir, loadBrand } from "../helpers.js";

describe("schemas", () => {
  it("all compile in Ajv strict mode", () => {
    for (const f of readdirSync(SCHEMAS_DIR)) expect(() => isValid(f.replace(".schema.json", "") as never, {})).not.toThrow();
  });
  it("validate the examples and fixtures", () => {
    validate("brand", loadBrand("maison-lune"));
    validate("brand", loadBrand("volt-street"));
    validate("creative-plan", JSON.parse(readFileSync(join(FIXTURES, "plan.fixture.json"), "utf8")));
  });
  it("reject unsafe paths in documents", () => {
    const b = loadBrand("volt-street");
    b.identity.logo.primary = "../../etc/passwd";
    expect(isValid("brand", b)).toBe(false);
    b.identity.logo.primary = "C:/logo.png";
    expect(isValid("brand", b)).toBe(false);
  });
});

describe("path safety", () => {
  it("rejects traversal and absolute paths", () => {
    expect(() => resolveInProject("/p", "../x")).toThrow(/escapes|project-relative/);
    expect(() => resolveInProject("/p", "/etc/passwd")).toThrow();
  });
  it("never lets the engine write into source/", () => {
    expect(() => assertWritable("/p", "source/clip.mp4")).toThrow(/read-only/);
    expect(() => assertWritable("/p", "renders/out.mp4")).not.toThrow();
  });
});

describe("time ranges", () => {
  it("subtracts cuts", () => {
    expect(subtractRanges({ start: 0, end: 10 }, [{ start: 2, end: 3 }, { start: 5, end: 6 }])).toEqual([
      { start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 10 },
    ]);
  });
});

describe("snapshot versioning", () => {
  const timeline = (d: number): Timeline => ({
    schemaVersion: "1.0", fps: 30, durationSec: d,
    tracks: { video: [{ id: "v1", kind: "primary", clips: [{ id: "c001", sourceId: "src_a", sourceIn: 0, sourceOut: d, timelineStart: 0 }] }], audio: [] },
  });

  it("commits on every write and undoes as NEW versions (history is never rewritten)", async () => {
    const p = await Project.init(await freshDir("unit-versions"), "Versions");
    await p.writeDocs({ brand: loadBrand("maison-lune"), styleTokens: compileStyleTokens(loadBrand("maison-lune"), 30) }, { command: "test", message: "brand" });
    await p.writeDoc("timeline", timeline(10), { command: "test", message: "t10" });
    await p.writeDoc("timeline", timeline(8), { command: "test", message: "t8" });
    await p.writeDoc("timeline", timeline(5), { command: "test", message: "t5" });
    expect((await p.readDoc("timeline")).durationSec).toBe(5);

    const u1 = await p.undo();
    expect((await p.readDoc("timeline")).durationSec).toBe(8);
    const u2 = await p.undo(); // consecutive undos keep walking back
    expect((await p.readDoc("timeline")).durationSec).toBe(10);
    expect(u2.restores).not.toBe(u1.restores);

    const all = await p.versions.list();
    expect(all.length).toBe(7); // init, brand, t10, t8, t5, undo, undo
    expect(all.at(-1)!.id).toBe(p.head);

    await p.checkout("v0005"); // t5
    expect((await p.readDoc("timeline")).durationSec).toBe(5);
  });

  it("removes documents that did not exist in the restored version", async () => {
    const p = await Project.init(await freshDir("unit-versions-2"), "Versions 2");
    await p.writeDoc("timeline", timeline(4), { command: "test", message: "t4" });
    await p.undo();
    expect(p.hasDoc("timeline")).toBe(false);
  });

  it("refuses to undo past the initial version", async () => {
    const p = await Project.init(await freshDir("unit-versions-3"), "Versions 3");
    await expect(p.undo()).rejects.toThrow(/nothing to undo/i);
  });
});
