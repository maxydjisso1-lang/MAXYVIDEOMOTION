/**
 * Robustness matrix. Every case has a DEFINED outcome: success, or a specific error code with a
 * hint — never a raw FFmpeg stack. Media are synthetic (FFmpeg lavfi), so this runs anywhere.
 * Renders use --draft + the ASS renderer to keep the matrix fast; the brand A/B test covers final quality.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { RenderRecord } from "../../engine/core/src/index.js";
import { ffmpeg, probe } from "../../engine/ffmpeg/src/index.js";
import { bve, bveOk, freshDir, TMP } from "../helpers.js";

const MEDIA = join(TMP, "robust-media");
const KIT = "examples/brands/volt-street";

async function make(name: string, args: string[]): Promise<string> {
  const out = join(MEDIA, name);
  await ffmpeg([...args, out]);
  return out;
}

const video = (size: string, rate: number, dur: number) => ["-f", "lavfi", "-i", `testsrc2=s=${size}:r=${rate}:d=${dur}`];
const tone = (dur: number) => ["-f", "lavfi", "-i", `sine=f=440:d=${dur}:sample_rate=48000`];
const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"];

/** Minimal plan that needs no transcript: the first seconds of the source, a CTA, an end card. */
async function writePlan(dir: string, sourceId: string, seconds: number): Promise<string> {
  const plan = {
    schemaVersion: "1.0",
    objective: "robustness",
    targetDurationSec: seconds,
    durationToleranceSec: seconds,
    narrative: { structure: "custom" },
    hook: { start: 0, end: Math.min(1, seconds), technique: "visual-reveal" },
    sections: [{ id: "main", role: "demo", sourceRefs: [{ sourceId, start: 0, end: seconds }] }],
    pacing: { style: "medium", removeSilences: { enabled: false } },
    captions: { enabled: false },
    motion: { density: "low", outro: seconds >= 2 ? "BrandOutro" : "none" },
    cta: { text: "Découvrir", durationSec: Math.min(1.5, seconds) },
  };
  const file = join(dir, "plan.json");
  await writeFile(file, JSON.stringify(plan));
  return file;
}

/** ingest → brand → analyze → plan → compile → color → audio → motion → draft render. */
async function pipeline(name: string, media: string, seconds: number, opts: { projectDir?: string } = {}) {
  const dir = opts.projectDir ?? (await freshDir(`robust-${name}`));
  await bveOk(null, "init", dir, "--name", name);
  const [src] = await bveOk<{ id: string }[]>(dir, "ingest", media);
  await bveOk(dir, "target", "add", "reels", "--preset", "instagram/reels");
  await bveOk(dir, "brand", "set", KIT);
  await bveOk(dir, "analyze");
  await bveOk(dir, "plan", "set", await writePlan(dir, src!.id, seconds));
  await bveOk(dir, "plan", "compile");
  await bveOk(dir, "color", "auto");
  await bveOk(dir, "audio", "clean");
  await bveOk(dir, "motion", "from-plan");
  const render = await bveOk<RenderRecord>(dir, "render", "--target", "reels", "--draft", "--renderer", "ass");
  const info = await probe(join(dir, render.path));
  return { dir, src: src!, render, info };
}

describe("robustness matrix", () => {
  beforeAll(async () => {
    await freshDir("robust-media");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(MEDIA, { recursive: true });
  });

  describe("geometry, frame rate and aspect ratio", () => {
    for (const [label, size, rate] of [
      ["1080p24 16:9", "1920x1080", 24],
      ["4K25 16:9", "3840x2160", 25],
      ["1080x1920 30 9:16", "1080x1920", 30],
      ["1080x1080 60 1:1", "1080x1080", 60],
    ] as const) {
      it(`${label} → 9:16 draft at the preset fps`, async () => {
        const media = await make(`geo-${size}-${rate}.mp4`, [...video(size, rate, 3), ...tone(3), ...h264]);
        const { info } = await pipeline(`geo-${size}-${rate}`, media, 2.5);
        expect([info.width, info.height]).toEqual([540, 960]); // draft = half of 1080x1920
        expect(info.fps).toBe(30);
        expect(info.hasAudio).toBe(true);
      });
    }
  });

  describe("streams and durations", () => {
    it("video without audio renders with a silent track", async () => {
      const media = await make("no-audio.mp4", [...video("1280x720", 30, 3), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]);
      const { src, info } = await pipeline("no-audio", media, 2.5);
      expect(src).toBeTruthy();
      expect(info.hasAudio).toBe(true);
    });

    it("audio-only source: analysed, then refused by the renderer with UNSUPPORTED (not an FFmpeg error)", async () => {
      const media = await make("audio-only.m4a", [...tone(3), "-c:a", "aac"]);
      const dir = await freshDir("robust-audio-only");
      await bveOk(null, "init", dir);
      const [src] = await bveOk<{ id: string; hasVideo: boolean }[]>(dir, "ingest", media);
      expect(src!.hasVideo).toBe(false);
      await bveOk(dir, "target", "add", "reels", "--preset", "instagram/reels");
      await bveOk(dir, "brand", "set", KIT);
      await bveOk(dir, "analyze");
      await bveOk(dir, "plan", "set", await writePlan(dir, src!.id, 2));
      await bveOk(dir, "plan", "compile");
      const r = await bve(dir, "render", "--target", "reels", "--draft");
      expect(r.code).toBe(2);
      expect(r.json.code).toBe("UNSUPPORTED");
      expect(r.json.hint).toMatch(/video source/);
    });

    it("very short clip (0.5 s)", async () => {
      const media = await make("short.mp4", [...video("1280x720", 30, 0.5), ...tone(0.5), ...h264]);
      const { info } = await pipeline("short", media, 0.5);
      expect(info.durationSec).toBeGreaterThan(0.4);
    });

    it("long source (10 min) ingests and analyses", async () => {
      const media = await make("long.mp4", [...video("320x180", 25, 600), ...tone(600), ...h264]);
      const dir = await freshDir("robust-long");
      await bveOk(null, "init", dir);
      const [src] = await bveOk<{ durationSec: number }[]>(dir, "ingest", media);
      expect(src!.durationSec).toBeCloseTo(600, 0);
      const summary = await bveOk<{ shots: unknown[] }[]>(dir, "analyze");
      expect(summary[0]!.shots.length).toBeGreaterThanOrEqual(1);
    });

    it("variable frame rate source gets a CFR mezzanine", async () => {
      const a = await make("vfr-a.mp4", [...video("640x360", 30, 1), "-c:v", "libx264", "-preset", "ultrafast"]);
      const b = await make("vfr-b.mp4", [...video("640x360", 15, 1), "-c:v", "libx264", "-preset", "ultrafast"]);
      const list = join(MEDIA, "vfr.txt");
      await writeFile(list, `file '${a.replace(/\\/g, "/")}'\nfile '${b.replace(/\\/g, "/")}'\n`);
      const media = await make("vfr.mp4", ["-f", "concat", "-safe", "0", "-i", list, "-c", "copy"]);
      const dir = await freshDir("robust-vfr");
      await bveOk(null, "init", dir);
      const [src] = await bveOk<{ fpsMode: string; mezzanine?: string }[]>(dir, "ingest", media);
      expect(src!.fpsMode).toBe("vfr");
      expect(src!.mezzanine).toMatch(/\.cache\/mezzanine\//);
    });

    it("rotation metadata: display dimensions are used", async () => {
      const plain = await make("rot-plain.mp4", [...video("1280x720", 30, 2), ...tone(2), ...h264]);
      const media = await make("rotated.mp4", ["-display_rotation", "90", "-i", plain, "-c", "copy"]);
      const p = await probe(media);
      expect([p.width, p.height]).toEqual([720, 1280]);
      const { info } = await pipeline("rotated", media, 1.5);
      expect([info.width, info.height]).toEqual([540, 960]);
    });
  });

  describe("paths and names", () => {
    it("file name with spaces, accents and emoji; project path with spaces and accents", async () => {
      const media = await make("clip vidéo été 🎬 (final).mp4", [...video("1280x720", 30, 2), ...tone(2), ...h264]);
      const dir = await freshDir("robust dossier été avec espaces");
      const { src } = await pipeline("unicode", media, 1.5, { projectDir: dir });
      expect(src.id).toMatch(/^src_clip_video_ete/);
    });
  });

  describe("codecs", () => {
    for (const [label, file, args] of [
      ["HEVC 10-bit", "hevc10.mp4", ["-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-c:a", "aac", "-shortest"]],
      ["ProRes 422", "prores.mov", ["-c:v", "prores_ks", "-profile:v", "2", "-c:a", "pcm_s16le", "-shortest"]],
      ["VP9 WebM", "vp9.webm", ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-shortest"]],
      ["MJPEG AVI", "mjpeg.avi", ["-c:v", "mjpeg", "-q:v", "5", "-c:a", "pcm_s16le", "-shortest"]],
    ] as const) {
      it(`${label} source`, async () => {
        const media = await make(file, [...video("1280x720", 25, 2), ...tone(2), ...args]);
        const { info } = await pipeline(`codec-${file}`, media, 1.5);
        expect(info.videoCodec).toBe("h264");
      });
    }
  });

  describe("failures are clean and actionable", () => {
    it("missing file → MISSING_INPUT (exit 3)", async () => {
      const dir = await freshDir("robust-missing");
      await bveOk(null, "init", dir);
      const r = await bve(dir, "ingest", join(MEDIA, "does-not-exist.mp4"));
      expect([r.code, r.json.code]).toEqual([3, "MISSING_INPUT"]);
    });

    it("corrupt media → MISSING_INPUT 'Unreadable media file' (exit 3)", async () => {
      const bad = join(MEDIA, "corrupt.mp4");
      await writeFile(bad, Buffer.from("this is not a video".repeat(100)));
      const dir = await freshDir("robust-corrupt");
      await bveOk(null, "init", dir);
      const r = await bve(dir, "ingest", bad);
      expect([r.code, r.json.code]).toEqual([3, "MISSING_INPUT"]);
      expect(r.json.message).toMatch(/Unreadable media file/);
    });

    it("unsupported file type → UNSUPPORTED (exit 2)", async () => {
      const txt = join(MEDIA, "notes.txt");
      await writeFile(txt, "hello");
      const dir = await freshDir("robust-unsupported");
      await bveOk(null, "init", dir);
      const r = await bve(dir, "ingest", txt);
      expect([r.code, r.json.code]).toEqual([2, "UNSUPPORTED"]);
    });

    it("brand whose logo file is missing → VALIDATION (exit 2) before anything is written", async () => {
      const dir = await freshDir("robust-nologo");
      await bveOk(null, "init", dir);
      const kit = await freshDir("robust-nologo-kit");
      const { cp, readFile } = await import("node:fs/promises");
      await cp(KIT, kit, { recursive: true });
      const brand = JSON.parse(await readFile(join(kit, "brand.json"), "utf8"));
      brand.identity.logo.primary = "assets/logo/missing.png";
      await writeFile(join(kit, "brand.json"), JSON.stringify(brand));
      const r = await bve(dir, "brand", "set", kit);
      expect([r.code, r.json.code]).toEqual([2, "VALIDATION"]);
      expect(r.json.message).toMatch(/missing\.png/);
    });

    it("nonexistent font without fallback → renders, but QC blocks (FONT MISSING) and export is refused", async () => {
      const media = await make("font-case.mp4", [...video("1280x720", 30, 3), ...tone(3), ...h264]);
      const dir = await freshDir("robust-font");
      const kit = await freshDir("robust-font-kit");
      const { cp, readFile } = await import("node:fs/promises");
      await cp(KIT, kit, { recursive: true });
      const brand = JSON.parse(await readFile(join(kit, "brand.json"), "utf8"));
      brand.identity.fonts = brand.identity.fonts.map((f: { role: string }) => (f.role === "body" ? { role: "body", family: "Totally Missing Font", weights: [700] } : f));
      await writeFile(join(kit, "brand.json"), JSON.stringify(brand));
      await bveOk(null, "init", dir);
      const [src] = await bveOk<{ id: string }[]>(dir, "ingest", media);
      await bveOk(dir, "target", "add", "reels", "--preset", "instagram/reels");
      await bveOk(dir, "brand", "set", kit);
      await bveOk(dir, "analyze");
      await bveOk(dir, "plan", "set", await writePlan(dir, src!.id, 2.5));
      await bveOk(dir, "plan", "compile");
      await bveOk(dir, "audio", "clean");
      await bveOk(dir, "motion", "from-plan");
      await bveOk(dir, "render", "--target", "reels", "--renderer", "ass");
      const qc = await bve(dir, "qc", "--target", "reels");
      expect([qc.code, qc.json.code]).toEqual([5, "QC_BLOCKED"]);
      expect(qc.json.message).toMatch(/brand\.fonts/);
      const ex = await bve(dir, "export", "--target", "reels");
      expect([ex.code, ex.json.code]).toEqual([5, "QC_BLOCKED"]);
    });
  });
});
