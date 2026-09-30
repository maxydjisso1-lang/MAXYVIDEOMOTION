/**
 * OPT-IN suite (`npm run fixtures:real && npm run test:real`): real footage + real Whisper.
 * Proves: audio → Whisper → word timestamps → transcript.json → captions.json → renderer → QC,
 * on public-domain / Creative Commons media (tests/fixtures/real/manifest.json).
 * The Whisper model is downloaded at most once (./models) and never during later runs.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, type Analysis, type Captions, type QcReport, type RenderRecord, type Transcript } from "../../engine/core/src/index.js";
import { bveOk, freshDir } from "../helpers.js";

const REAL = join(REPO_ROOT, "tests/fixtures/real");
const PY = join(REPO_ROOT, "engine/python/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const ready = ["talking-head.mp4", "interview.mp4", "product.mp4", "speech-fr.mp3", "noisy-audio.mp4"].every((f) => existsSync(join(REAL, f))) && existsSync(PY);
const read = <T>(dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8")) as T;
const words = (t: Transcript) => t.sources.flatMap((s) => s.segments.flatMap((g) => g.words));

async function project(name: string, media: string, brand = "examples/brands/maison-lune") {
  const dir = await freshDir(`real-${name}`);
  await bveOk(null, "init", dir, "--name", name);
  const [src] = await bveOk<{ id: string; durationSec: number }[]>(dir, "ingest", join(REAL, media));
  await bveOk(dir, "target", "add", "reels", "--preset", "instagram/reels");
  await bveOk(dir, "brand", "set", brand);
  return { dir, src: src! };
}

/** A plan Claude could have written: hook from the middle, then the opening, then more. */
async function planFromSegments(dir: string, segments: { id: string }[], opts: { captions?: boolean } = {}) {
  const ids = segments.map((s) => s.id);
  if (ids.length < 2) throw new Error(`Whisper returned ${ids.length} segment(s): nothing to edit`);
  const plan = {
    schemaVersion: "1.0",
    objective: "real-footage validation",
    targetDurationSec: 20,
    durationToleranceSec: 15,
    narrative: { structure: "story-arc" },
    hook: { start: 0, end: 3, technique: "quote", sourceRefs: [{ segmentId: ids[Math.min(2, ids.length - 1)]! }] },
    sections: [
      { id: "opening", role: "context", sourceRefs: ids.slice(0, 2).map((segmentId) => ({ segmentId })) },
      { id: "more", role: "testimonial", sourceRefs: ids.slice(3, 5).map((segmentId) => ({ segmentId })) },
    ].filter((s) => s.sourceRefs.length),
    pacing: { style: "medium", punchIns: true, removeSilences: { enabled: true }, removeFillers: true },
    captions: { enabled: opts.captions !== false },
    motion: { density: "low", outro: "BrandOutro" },
    cta: { text: "Découvrir la marque", durationSec: 3 },
    audio: { cleanup: "gentle" },
  };
  await writeFile(join(dir, "plan.json"), JSON.stringify(plan));
  await bveOk(dir, "plan", "set", join(dir, "plan.json"));
}

async function finish(dir: string, renderer: "auto" | "ass", opts: { captions?: boolean } = {}) {
  await bveOk(dir, "plan", "compile");
  await bveOk(dir, "color", "auto");
  await bveOk(dir, "audio", "clean");
  if (opts.captions !== false) await bveOk(dir, "captions", "build");
  await bveOk(dir, "motion", "from-plan");
  const render = await bveOk<RenderRecord>(dir, "render", "--target", "reels", "--renderer", renderer);
  const qc = (await bveOk<{ report: QcReport }>(dir, "qc", "--target", "reels")).report;
  const exported = await bveOk<{ path: string }[]>(dir, "export", "--target", "reels", "--sidecars", "srt");
  return { render, qc, exported };
}

describe.skipIf(!ready)("real footage + Whisper", () => {
  it("transcribes clear French speech with word timestamps (LibriVox, public domain)", async () => {
    const { dir } = await project("speech-fr", "speech-fr.mp3");
    await bveOk(dir, "analyze", "--transcribe", "--language", "fr", "--model", "small");
    const t = read<Transcript>(dir, "analysis/transcript.json");
    expect(t.language).toBe("fr");
    expect(t.model).toBe("faster-whisper/small");
    const w = words(t);
    expect(w.length).toBeGreaterThan(60);
    expect(t.sources[0]!.segments[0]!.text.toLowerCase()).toContain("librivox");
    // Timestamps: ordered, inside the file, and never inside a measured silence.
    for (let i = 1; i < w.length; i++) expect(w[i]!.start).toBeGreaterThanOrEqual(w[i - 1]!.start - 0.01);
    expect(w.at(-1)!.end).toBeLessThanOrEqual(71.1);
    const silences = read<Analysis>(dir, "analysis/analysis.json").sources[0]!.audio.silences!.filter((s) => s.end - s.start >= 0.8);
    const inside = w.filter((x) => silences.some((s) => x.start > s.start + 0.2 && x.end < s.end - 0.2));
    expect(inside.length).toBe(0);
  });

  it("talking head: Whisper → captions.json → Remotion render → QC → export (model NOT downloaded again)", async () => {
    const { dir } = await project("talking-head", "talking-head.mp4");
    await bveOk(dir, "analyze", "--transcribe", "--language", "fr");
    const log = readFileSync(join(dir, "logs/bve.jsonl"), "utf8");
    expect(log).not.toMatch(/downloading once/);
    const t = read<Transcript>(dir, "analysis/transcript.json");
    await planFromSegments(dir, t.sources[0]!.segments);
    const { render, qc, exported } = await finish(dir, "auto");
    const caps = read<Captions>(dir, "subtitles/captions.json");
    const spoken = new Set(words(t).map((x) => x.w));
    expect(caps.cues.length).toBeGreaterThan(3);
    for (const c of caps.cues) for (const w of c.words) expect(spoken.has(w.text)).toBe(true);
    expect(caps.cues.flatMap((c) => c.words).some((w) => w.text.startsWith("'"))).toBe(false); // no "j 'exerce"
    expect(render.renderer).toBe("remotion");
    expect(qc.status).not.toBe("fail");
    expect(qc.categories.captions?.checks.find((c) => c.id === "captions.safe-zone")?.status).toBe("pass");
    expect(exported[0]!.path).toMatch(/\.mp4$/);
  });

  it("interview (2 speakers, 480p source upscaled to 1080x1920)", async () => {
    const { dir } = await project("interview", "interview.mp4", "examples/brands/volt-street");
    await bveOk(dir, "analyze", "--transcribe", "--language", "fr");
    await planFromSegments(dir, read<Transcript>(dir, "analysis/transcript.json").sources[0]!.segments);
    const { qc } = await finish(dir, "ass");
    expect(qc.status).not.toBe("fail");
  });

  it("product footage without any audio: shots only, no captions, silent track accepted", async () => {
    const { dir, src } = await project("product", "product.mp4", "examples/brands/volt-street");
    const summary = await bveOk<{ shots: { id: string }[] }[]>(dir, "analyze");
    const plan = {
      schemaVersion: "1.0", objective: "product reveal", targetDurationSec: 8, durationToleranceSec: 5,
      narrative: { structure: "teaser" }, hook: { start: 0, end: 2, technique: "visual-reveal", onScreenText: "Nouveauté" },
      sections: [{ id: "reveal", role: "demo", sourceRefs: [{ sourceId: src.id, start: 0, end: 8 }] }],
      pacing: { style: "fast", removeSilences: { enabled: false } }, captions: { enabled: false },
      motion: { density: "medium", outro: "BrandOutro" }, cta: { text: "Précommander", durationSec: 2 },
    };
    await writeFile(join(dir, "plan.json"), JSON.stringify(plan));
    await bveOk(dir, "plan", "set", join(dir, "plan.json"));
    expect(summary[0]!.shots.length).toBeGreaterThanOrEqual(1);
    const { qc } = await finish(dir, "ass", { captions: false });
    expect(qc.status).not.toBe("fail");
    expect(qc.categories.audio?.checks.find((c) => c.id === "audio.loudness")?.status).toBe("skip");
  });

  it("speech over real street noise: detected as noisy, cleanup chain applied, loudness delivered on target", async () => {
    const { dir } = await project("noisy", "noisy-audio.mp4");
    await bveOk(dir, "analyze", "--transcribe", "--language", "fr");
    const a = read<Analysis>(dir, "analysis/analysis.json").sources[0]!.audio;
    expect(a.noiseFloorDb).toBeGreaterThan(-40);
    expect(a.noiseProfile).toContain("broadband");
    await planFromSegments(dir, read<Transcript>(dir, "analysis/transcript.json").sources[0]!.segments, { captions: false });
    const { qc } = await finish(dir, "ass", { captions: false });
    const audio = read<{ dialogue: { chain: { type: string }[] }[] }>(dir, "audio/audio.json");
    expect(audio.dialogue[0]!.chain.map((c) => c.type)).toContain("denoise-fft");
    expect(qc.categories.audio?.checks.find((c) => c.id === "audio.loudness")?.status).toBe("pass");
  });
});
