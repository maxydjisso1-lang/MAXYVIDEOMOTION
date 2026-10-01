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
import { ffmpeg, probe, rmsLevel } from "../../engine/ffmpeg/src/index.js";
import { runWhisper, wordErrorRate } from "../../engine/transcription/src/index.js";
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

  it("transcription under real street noise: WER regression thresholds and no silent failure", async () => {
    const ref = JSON.parse(readFileSync(join(REAL, "reference/cigale-fourmi.json"), "utf8")) as { span: { start: number; end: number }; text: string };
    const dir = await freshDir("real-wer");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const speech = join(dir, "speech.wav");
    await ffmpeg(["-ss", String(ref.span.start), "-t", (ref.span.end - ref.span.start).toFixed(3), "-i", join(REAL, "speech-fr.mp3"), "-ac", "1", "-ar", "48000", speech]);
    const noise = join(dir, "noise.wav");
    await ffmpeg(["-i", join(REAL, "street-noise.mp4"), "-vn", "-ac", "1", "-ar", "48000", noise]);
    const sRms = await rmsLevel(speech, { start: 0, end: (await probe(speech)).durationSec });
    const nRms = await rmsLevel(noise, { start: 0, end: (await probe(noise)).durationSec });
    const mixAt = async (snr: number) => {
      const out = join(dir, `mix${snr}.mp4`);
      await ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=320x180:r=25", "-i", speech, "-stream_loop", "-1", "-i", noise, "-filter_complex", `[2:a]volume=${(sRms - snr - nRms).toFixed(2)}dB[n];[1:a][n]amix=inputs=2:normalize=0:duration=first[a]`, "-map", "0:v", "-map", "[a]", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", out]);
      return out;
    };
    // Measured baseline (small, VAD on): clean 14.7 %, 10 dB 17.4 %. Thresholds leave room for run-to-run noise.
    const clean = await runWhisper(speech, { model: "small", language: "fr" });
    expect(wordErrorRate(ref.text, clean.segments.map((s) => s.text).join(" ")).wer).toBeLessThanOrEqual(0.2);
    const at10 = await runWhisper(await mixAt(10), { model: "small", language: "fr" });
    expect(wordErrorRate(ref.text, at10.segments.map((s) => s.text).join(" ")).wer).toBeLessThanOrEqual(0.25);
    // Far below 0 dB Whisper returns nothing: the engine must SAY so instead of delivering an empty transcript silently.
    const media = await mixAt(-13);
    const dir2 = await freshDir("real-buried");
    await bveOk(null, "init", dir2);
    await bveOk(dir2, "ingest", media);
    const summary = await bveOk<{ transcription?: { words: number; warning?: string } }[]>(dir2, "analyze", "--transcribe", "--language", "fr");
    expect(summary[0]!.transcription?.words).toBe(0);
    expect(summary[0]!.transcription?.warning).toMatch(/No speech transcribed/);
  });

  it("sentence view: a plan built from sentences never keeps part of a sentence (segments do)", async () => {
    const { dir, src } = await project("sentences", "talking-head.mp4");
    await bveOk(dir, "analyze", "--transcribe", "--language", "fr");
    const t = read<Transcript>(dir, "analysis/transcript.json");
    const sentences = await bveOk<{ id: string; start: number; end: number; words: number; unterminated: boolean }[]>(dir, "transcript", "sentences");
    expect(sentences.length).toBeGreaterThan(1);
    const allWords = words(t);
    /** Sentences whose words are only PARTLY kept by the compiled edit. */
    const partial = async () => {
      const tl = read<{ tracks: { video: { clips: { sourceIn: number; sourceOut: number }[] }[] } }>(dir, "timeline/timeline.json");
      const kept = (w: { start: number; end: number }) => tl.tracks.video[0]!.clips.some((c) => (w.start + w.end) / 2 >= c.sourceIn && (w.start + w.end) / 2 < c.sourceOut);
      return sentences.filter((s) => {
        const ws = allWords.filter((w) => w.start >= s.start - 0.01 && w.end <= s.end + 0.01 && !w.filler);
        const k = ws.filter(kept).length;
        return k > 0 && k < ws.length;
      }).length;
    };
    const base = { schemaVersion: "1.0", objective: "sentence test", targetDurationSec: 20, durationToleranceSec: 20, narrative: { structure: "custom" }, pacing: { style: "medium", removeSilences: { enabled: true } }, captions: { enabled: false } };
    // BEFORE: segments (as Phase 1 plans did).
    const segs = t.sources[0]!.segments;
    await writeFile(join(dir, "seg-plan.json"), JSON.stringify({ ...base, hook: { start: 0, end: 3, technique: "quote", sourceRefs: [{ segmentId: segs[1]!.id }] }, sections: [{ id: "a", role: "context", sourceRefs: [{ segmentId: segs[3]!.id }] }] }));
    await bveOk(dir, "plan", "set", join(dir, "seg-plan.json"));
    await bveOk(dir, "plan", "compile");
    const partialWithSegments = await partial();
    // AFTER: the same intent expressed with sentence ranges.
    const r = (s: { start: number; end: number }) => ({ sourceId: src.id, start: s.start, end: s.end });
    await writeFile(join(dir, "sent-plan.json"), JSON.stringify({ ...base, hook: { start: 0, end: 3, technique: "quote", sourceRefs: [r(sentences[1]!)] }, sections: [{ id: "a", role: "context", sourceRefs: [r(sentences[0]!)] }] }));
    await bveOk(dir, "plan", "set", join(dir, "sent-plan.json"));
    await bveOk(dir, "plan", "compile");
    const partialWithSentences = await partial();
    console.log(`partial sentences in the edit — segments: ${partialWithSegments}, sentences: ${partialWithSentences}`);
    expect(partialWithSegments).toBeGreaterThan(0); // the measured problem, reproduced
    expect(partialWithSentences).toBe(0);
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
    const audio = read<{ dialogue: { chain: { type: string }[]; denoise?: { decision: string; summary: string } }[] }>(dir, "audio/audio.json");
    // Chantier 2: strong noise (≈ −3 dB true SNR) is NOT denoised automatically — measured to cost intelligibility.
    expect(audio.dialogue[0]!.denoise?.decision).toBe("skip-strong-noise");
    expect(audio.dialogue[0]!.denoise?.summary).toMatch(/strong noise/);
    expect(audio.dialogue[0]!.chain.map((c) => c.type).filter((t) => t.startsWith("denoise"))).toEqual([]);
    expect(qc.categories.audio?.checks.find((c) => c.id === "audio.loudness")?.status).toBe("pass");
  });

  it("denoise policy on real street noise: skip light, apply medium (voice + intelligibility preserved), refuse strong", async () => {
    const ref = JSON.parse(readFileSync(join(REAL, "reference/cigale-fourmi.json"), "utf8")) as { span: { start: number; end: number }; text: string };
    const work = await freshDir("real-denoise-media");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(work, { recursive: true });
    const speech = join(work, "speech.wav");
    await ffmpeg(["-ss", String(ref.span.start), "-t", (ref.span.end - ref.span.start).toFixed(3), "-i", join(REAL, "speech-fr.mp3"), "-ac", "1", "-ar", "48000", speech]);
    const noise = join(work, "noise.wav");
    await ffmpeg(["-i", join(REAL, "street-noise.mp4"), "-vn", "-ac", "1", "-ar", "48000", noise]);
    const sRms = await rmsLevel(speech, { start: 0, end: (await probe(speech)).durationSec });
    const nRms = await rmsLevel(noise, { start: 0, end: (await probe(noise)).durationSec });
    const mixAt = async (snr: number) => {
      const out = join(work, `mix${snr}.mp4`);
      await ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=640x360:r=25", "-i", speech, "-stream_loop", "-1", "-i", noise, "-filter_complex", `[2:a]volume=${(sRms - snr - nRms).toFixed(2)}dB[n];[1:a][n]amix=inputs=2:normalize=0:duration=first[a]`, "-map", "0:v", "-map", "[a]", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-b:a", "192k", out]);
      return out;
    };
    type Denoise = { decision: string; mix?: number; candidates?: { mix: number; accepted: boolean; voiceLevelDeltaDb: number }[] };
    const decide = async (snr: number) => {
      const d2 = await freshDir(`real-denoise-${snr}`);
      await bveOk(null, "init", d2);
      const [s] = await bveOk<{ id: string }[]>(d2, "ingest", await mixAt(snr));
      await bveOk(d2, "target", "add", "reels", "--preset", "instagram/reels");
      await bveOk(d2, "brand", "set", "examples/brands/maison-lune");
      await bveOk(d2, "analyze");
      await bveOk(d2, "audio", "clean");
      return { dir: d2, sourceId: s!.id, denoise: read<{ dialogue: { denoise?: Denoise }[] }>(d2, "audio/audio.json").dialogue[0]!.denoise! };
    };
    expect((await decide(20)).denoise.decision).toBe("skip-clean");
    expect((await decide(0)).denoise.decision).toBe("skip-strong-noise");
    const medium = await decide(10);
    expect(medium.denoise.decision).toBe("applied");
    expect(medium.denoise.mix).toBe(0.7);
    expect(medium.denoise.candidates![0]!.voiceLevelDeltaDb).toBeGreaterThanOrEqual(-1);
    // The whole rendered chain (denoise + EQ + compressor + loudness): quieter noise, same intelligibility.
    const plan = { schemaVersion: "1.0", objective: "denoise", targetDurationSec: 36, durationToleranceSec: 10, narrative: { structure: "custom" }, hook: { start: 0, end: 2, technique: "quote" }, sections: [{ id: "all", role: "context", sourceRefs: [{ sourceId: medium.sourceId, start: 0, end: 36.3 }] }], pacing: { style: "calm", removeSilences: { enabled: false } }, captions: { enabled: false }, motion: { density: "none", outro: "none" } };
    await writeFile(join(medium.dir, "plan.json"), JSON.stringify(plan));
    await bveOk(medium.dir, "plan", "set", join(medium.dir, "plan.json"));
    await bveOk(medium.dir, "plan", "compile");
    const render = await bveOk<RenderRecord>(medium.dir, "render", "--target", "reels", "--draft", "--renderer", "ass");
    const input = join(work, "mix10.mp4");
    const output = join(medium.dir, render.path);
    const { decodePcm, estimateSnrDb } = await import("../../engine/audio/src/index.js");
    const snrIn = estimateSnrDb(await decodePcm(input));
    const snrOut = estimateSnrDb(await decodePcm(output));
    expect(snrOut).toBeGreaterThan(snrIn + 1);
    const werIn = wordErrorRate(ref.text, (await runWhisper(input, { language: "fr" })).segments.map((x) => x.text).join(" ")).wer;
    const werOut = wordErrorRate(ref.text, (await runWhisper(output, { language: "fr" })).segments.map((x) => x.text).join(" ")).wer;
    console.log(`medium noise: est. SNR ${snrIn} → ${snrOut} dB, WER ${(werIn * 100).toFixed(1)} → ${(werOut * 100).toFixed(1)} %`);
    expect(werOut).toBeLessThanOrEqual(werIn + 0.03);
  });
});
