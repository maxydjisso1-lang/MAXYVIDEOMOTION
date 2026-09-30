/**
 * PHASE 1 ACCEPTANCE TEST — the vertical slice, driven through the real CLI like Claude would.
 *
 *   VIDEO A + BRAND A (Maison Lune)  -> OUTPUT A
 *   VIDEO A + BRAND B (Volt Street)  -> OUTPUT B
 *
 * Proves: identical edit, different style tokens / motion / captions, visibly different renders,
 * QC gating, export, snapshot + undo, untouched sources, and the no-Remotion fallback.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256File, type Captions, type MotionDoc, type ProjectManifest, type QcReport, type StyleTokens, type Timeline } from "../../engine/core/src/index.js";
import { deltaE } from "../../engine/brand/src/index.js";
import { probe, psnr } from "../../engine/ffmpeg/src/index.js";
import { sampleColor } from "../../engine/qc/src/index.js";
import type { RenderRecord } from "../../engine/rendering/src/index.js";
import { generateAll } from "../fixtures/generate.js";
import { bve, bveOk, FIXTURES, freshDir, GENERATED } from "../helpers.js";

const read = <T>(project: string, rel: string): T => JSON.parse(readFileSync(join(project, rel), "utf8")) as T;

interface Built {
  dir: string;
  render: RenderRecord;
  qc: QcReport;
  exportFile: string;
  preExportRefusal: { code: number; errorCode?: string };
}

async function buildProject(name: string, brandKit: string, renderer: "auto" | "ass", media: { video: string; transcript: string }): Promise<Built> {
  const dir = await freshDir(name);
  await bveOk(null, "init", dir, "--name", name);
  await bveOk(dir, "ingest", media.video);
  await bveOk(dir, "target", "add", "ig_reels", "--preset", "instagram/reels");
  await bveOk(dir, "brand", "set", brandKit);
  await bveOk(dir, "transcript", "import", media.transcript);
  await bveOk(dir, "analyze");
  await bveOk(dir, "plan", "set", join(FIXTURES, "plan.fixture.json"));
  await bveOk(dir, "plan", "compile");
  await bveOk(dir, "color", "auto");
  await bveOk(dir, "audio", "clean");
  await bveOk(dir, "captions", "build");
  await bveOk(dir, "motion", "from-plan");
  const render = await bveOk<RenderRecord>(dir, "render", "--target", "ig_reels", "--renderer", renderer);
  // Export must be refused before QC has run on this exact render.
  const refused = await bve(dir, "export", "--target", "ig_reels");
  const qc = (await bveOk<{ report: QcReport }>(dir, "qc", "--target", "ig_reels")).report;
  const exported = await bveOk<{ path: string }[]>(dir, "export", "--target", "ig_reels", "--sidecars", "srt");
  return { dir, render, qc, exportFile: join(dir, exported[0]!.path), preExportRefusal: { code: refused.code, ...(refused.json.code ? { errorCode: refused.json.code } : {}) } };
}

describe("Phase 1 vertical slice: same video, two brands", () => {
  let media: { video: string; transcript: string };
  let A: Built;
  let B: Built;

  beforeAll(async () => {
    media = await generateAll(GENERATED);
    A = await buildProject("e2e-a-maison-lune", "examples/brands/maison-lune", "auto", media);
    B = await buildProject("e2e-b-volt-street", "examples/brands/volt-street", "auto", media);
  });

  it("keeps the base edit identical across brands", () => {
    const ta = read<Timeline>(A.dir, "timeline/timeline.json");
    const tb = read<Timeline>(B.dir, "timeline/timeline.json");
    expect(ta.tracks).toEqual(tb.tracks);
    expect(ta.markers).toEqual(tb.markers);
    expect(ta.durationSec).toBe(tb.durationSec);
  });

  it("compiles different style tokens, motion and captions from the two Brand DNAs", () => {
    const tokA = read<StyleTokens>(A.dir, "brand/style-tokens.json");
    const tokB = read<StyleTokens>(B.dir, "brand/style-tokens.json");
    expect(tokA).not.toEqual(tokB);
    expect(tokA.motion.easing.kind).toBe("bezier");
    expect(tokB.motion.easing.kind).toBe("spring");

    expect(read<MotionDoc>(A.dir, "motion/motion.json")).not.toEqual(read<MotionDoc>(B.dir, "motion/motion.json"));
    expect(read<Captions>(A.dir, "subtitles/captions.json")).not.toEqual(read<Captions>(B.dir, "subtitles/captions.json"));
  });

  it("renders deliverables that meet the Instagram Reels spec", async () => {
    for (const p of [A, B]) {
      const info = await probe(p.exportFile);
      expect(info.width).toBe(1080);
      expect(info.height).toBe(1920);
      expect(info.fps).toBe(30);
      expect(info.videoCodec).toBe("h264");
      expect(info.audioCodec).toBe("aac");
      expect(p.render.renderer).toBe("remotion");
    }
  });

  it("produces VISIBLY different videos", async () => {
    const db = await psnr(A.exportFile, B.exportFile);
    // Same footage and edit: only brand-driven layers (grade, motion, captions, end card) differ.
    expect(db).toBeLessThan(25);

    // The end cards carry each brand's own background color, measured in the rendered pixels.
    const tokA = read<StyleTokens>(A.dir, "brand/style-tokens.json");
    const tokB = read<StyleTokens>(B.dir, "brand/style-tokens.json");
    const corner = { x: 40, y: 60, w: 80, h: 80 };
    const end = A.render.durationSec - 0.3;
    const [ca, cb] = await Promise.all([sampleColor(A.exportFile, end, corner), sampleColor(B.exportFile, end, corner)]);
    expect(deltaE(ca, tokA.color.background)).toBeLessThan(8);
    expect(deltaE(cb, tokB.color.background)).toBeLessThan(8);
    expect(deltaE(ca, cb)).toBeGreaterThan(50);
  });

  it("passes QC (no blockers) and gates export on it", () => {
    for (const p of [A, B]) {
      expect(p.qc.status).not.toBe("fail");
      expect(p.preExportRefusal.code).toBe(5);
      expect(p.preExportRefusal.errorCode).toBe("QC_BLOCKED");
      const m = read<ProjectManifest>(p.dir, "project.json");
      expect(m.exports?.[0]?.path).toMatch(/^exports\/.+\.mp4$/);
    }
    expect(A.qc.categories.audio?.status).toBe("pass");
    expect(A.qc.categories.captions?.status).toBe("pass");
    expect(A.qc.categories.motion?.status).toBe("pass");
  });

  it("renders with the brand's own font files and reports FOUND / FALLBACK per role", () => {
    const byRole = (p: Built) => Object.fromEntries((p.render.fonts ?? []).map((f) => [f.role, f.status]));
    expect(byRole(A)).toEqual({ display: "fallback", body: "found", caption: "found" }); // Canela (commercial) absent → Cormorant Garamond
    expect(byRole(B)).toEqual({ display: "found", body: "found", caption: "found" });
    const fontsCheck = (p: Built) => Object.values(p.qc.categories).flatMap((c) => c.checks).find((c) => c.id === "brand.fonts")!;
    expect(fontsCheck(A).status).toBe("warn");
    expect(fontsCheck(A).message).toContain("FONT FALLBACK");
    expect(fontsCheck(B).status).toBe("pass");
  });

  it("never modifies the source media", async () => {
    const original = await sha256File(media.video);
    for (const p of [A, B]) {
      const m = read<ProjectManifest>(p.dir, "project.json");
      expect(m.sources[0]!.sha256).toBe(original);
      expect(await sha256File(join(p.dir, m.sources[0]!.path))).toBe(original);
    }
  });

  it("snapshots every change and undoes without rewriting history", async () => {
    const before = read<Timeline>(A.dir, "timeline/timeline.json");
    const versionsBefore = (await bveOk<unknown[]>(A.dir, "version", "list")).length;
    await bveOk(A.dir, "edit", "delete", "--clip", "c002");
    expect(read<Timeline>(A.dir, "timeline/timeline.json")).not.toEqual(before);
    const undo = await bveOk<{ id: string; restores: string }>(A.dir, "version", "undo");
    expect(read<Timeline>(A.dir, "timeline/timeline.json")).toEqual(before);
    const versionsAfter = await bveOk<{ id: string }[]>(A.dir, "version", "list");
    expect(versionsAfter.length).toBe(versionsBefore + 2);
    expect(undo.restores).toBeTruthy();
  });

  it("falls back to the ASS/libass renderer and still delivers a QC-passing, on-brand video", async () => {
    const C = await buildProject("e2e-c-volt-ass", "examples/brands/volt-street", "ass", media);
    expect(C.render.renderer).toBe("ass");
    expect(C.qc.status).not.toBe("fail");
    // libass' own font choice is verified against the expected files (e.g. Montserrat-ExtraBold).
    const caption = C.render.fonts?.find((f) => f.role === "caption");
    expect(caption?.status).toBe("found");
    expect(caption?.used).toBe("Montserrat-ExtraBold");
    const tokC = read<StyleTokens>(C.dir, "brand/style-tokens.json");
    const c = await sampleColor(C.exportFile, C.render.durationSec - 0.3, { x: 40, y: 60, w: 80, h: 80 });
    expect(deltaE(c, tokC.color.background)).toBeLessThan(8);
  });
});
