/**
 * OPT-IN (`npm run fixtures:real && npm run test:real`): speech / music / noise / silence detection on
 * real recordings, through the CLI (analyze → analysis.json → audio clean → audio.json).
 * Accuracy is measured by scripts/bench-content.ts (docs/measurements/audio-content.md); these tests pin
 * the decisions the engine takes from it, above all: a music bed is never denoised as noise.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, type Analysis, type AudioDoc } from "../../engine/core/src/index.js";
import { ffmpeg, measureLoudness } from "../../engine/ffmpeg/src/index.js";
import { bveOk, freshDir, TMP } from "../helpers.js";

const REAL = join(REPO_ROOT, "tests/fixtures/real");
const PY = join(REPO_ROOT, "engine/python/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const NEEDED = ["music-carefree.m4a", "music-windswept.m4a", "street-noise.mp4", "noisy-audio.mp4", "talking-head.mp4", "speech-fr.mp3", "noise-ac-hum.m4a"];
const ready = NEEDED.every((f) => existsSync(join(REAL, f))) && existsSync(PY);
const read = <T>(dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), "utf8")) as T;

/** init → ingest → target → analyze; returns the source's audio analysis. */
async function analyzed(name: string, media: string) {
  const dir = await freshDir(`content-${name}`);
  await bveOk(null, "init", dir, "--name", name);
  await bveOk(dir, "ingest", media);
  await bveOk(dir, "target", "add", "reels", "--preset", "instagram/reels");
  await bveOk(dir, "analyze");
  const audio = read<Analysis>(dir, "analysis/analysis.json").sources[0]!.audio;
  return { dir, audio };
}
async function denoiseDecision(dir: string) {
  await bveOk(dir, "audio", "clean", "--preset", "standard");
  const d = read<AudioDoc>(dir, "audio/audio.json").dialogue[0]!;
  return { decision: d.denoise?.decision, rnn: d.chain.some((p) => p.type === "denoise-rnn"), summary: d.denoise?.summary };
}
const sec = (a: Analysis["sources"][number]["audio"], label: string) =>
  (a.content?.segments ?? []).filter((s) => s.label === label).reduce((t, s) => t + s.end - s.start, 0);

describe.skipIf(!ready)("audio content on real recordings", () => {
  it("a music bed alone is music, not noise, and is never denoised", async () => {
    const { dir, audio } = await analyzed("music", join(REAL, "music-carefree.m4a"));
    expect(audio.content?.detector).toBe("silero-vad+spectral");
    expect(audio.musicDetected).toBe(true);
    expect(audio.content!.shares.music).toBeGreaterThan(0.8);
    expect(audio.noiseProfile).not.toContain("broadband");
    const d = await denoiseDecision(dir);
    expect(d.decision).toBe("skip-music");
    expect(d.rnn).toBe(false);
  }, 600_000);

  it("speech over a music bed (+12 dB) is speech+music, and the music is not denoised", async () => {
    // Built at test time from a held-out music and real read speech (nothing committed).
    const work = join(TMP, "content-work-mix");
    await mkdir(work, { recursive: true });
    const speech = join(work, "speech.wav");
    const music = join(work, "music.wav");
    await ffmpeg(["-ss", "20", "-t", "18", "-i", join(REAL, "speech-fr.mp3"), "-ac", "1", "-ar", "48000", speech]);
    await ffmpeg(["-i", join(REAL, "music-windswept.m4a"), "-t", "30", "-ac", "1", "-ar", "48000", music]);
    const gain = (await measureLoudness(speech)).integratedLufs - 12 - (await measureLoudness(music)).integratedLufs;
    const mix = join(work, "voice-over-music.wav");
    await ffmpeg(["-i", music, "-i", speech, "-filter_complex", `[0:a]volume=${gain.toFixed(2)}dB[m];[1:a]adelay=6000:all=1,apad[s];[m][s]amix=inputs=2:normalize=0:duration=first[a]`, "-map", "[a]", mix]);
    const { dir, audio } = await analyzed("voice-music", mix);
    expect(audio.musicDetected).toBe(true);
    expect(sec(audio, "speech+music")).toBeGreaterThan(12); // speech spans 6–24 s
    expect(sec(audio, "music")).toBeGreaterThan(6); // the bed alone, before and after
    expect(sec(audio, "speech+noise")).toBeLessThan(2);
    expect((await denoiseDecision(dir)).decision).toBe("skip-music");
  }, 600_000);

  it("KNOWN LIMIT: a bed heard only under continuous speech is not detected, but the source is flagged", async () => {
    // A fast talker covers the whole clip: the background is never heard alone (docs/measurements/audio-content.md).
    const work = join(TMP, "content-work-mix");
    await mkdir(work, { recursive: true });
    const speech = join(work, "speech-continuous.wav");
    const music = join(work, "music.wav");
    if (!existsSync(speech)) await ffmpeg(["-t", "18", "-i", join(REAL, "talking-head.mp4"), "-vn", "-ac", "1", "-ar", "48000", speech]);
    if (!existsSync(music)) await ffmpeg(["-i", join(REAL, "music-windswept.m4a"), "-t", "30", "-ac", "1", "-ar", "48000", music]);
    const gain = (await measureLoudness(speech)).integratedLufs - 12 - (await measureLoudness(music)).integratedLufs;
    const mix = join(work, "voice-over-music-continuous.wav");
    await ffmpeg(["-i", music, "-i", speech, "-filter_complex", `[0:a]volume=${gain.toFixed(2)}dB[m];[m][1:a]amix=inputs=2:normalize=0:duration=shortest[a]`, "-map", "[a]", mix]);
    const { dir, audio } = await analyzed("voice-music-continuous", mix);
    expect(audio.musicDetected).toBe(false);
    expect(audio.content!.speechBackgroundUnknown).toBeGreaterThan(0.5);
    const d = await denoiseDecision(dir);
    expect(d.summary).toMatch(/cannot be ruled out/);
  }, 600_000);

  it("speech over street noise is speech+noise, not music; the SNR policy still decides", async () => {
    const { dir, audio } = await analyzed("voice-noise", join(REAL, "noisy-audio.mp4"));
    expect(audio.musicDetected).toBe(false);
    expect(sec(audio, "speech+noise")).toBeGreaterThan(3); // the voice spans ≈ 10 s of this 30 s fixture
    expect(audio.content!.shares.music).toBeLessThan(0.1);
    const d = await denoiseDecision(dir);
    expect(d.decision).not.toBe("skip-music");
    expect(["skip-clean", "skip-strong-noise", "applied", "rejected-all"]).toContain(d.decision);
  }, 600_000);

  it("street noise alone is noise, keeps its broadband verdict, and is not music", async () => {
    const { audio } = await analyzed("noise", join(REAL, "street-noise.mp4"));
    expect(audio.musicDetected).toBe(false);
    expect(audio.content!.shares.noise).toBeGreaterThan(0.8);
    expect(audio.noiseProfile).toContain("broadband");
  }, 600_000);

  it("a stationary air-conditioner hum (tonal) is noise, not music", async () => {
    const { audio } = await analyzed("hum", join(REAL, "noise-ac-hum.m4a"));
    expect(audio.musicDetected).toBe(false);
    expect(audio.content!.shares.music).toBeLessThan(0.1);
  }, 600_000);

  it("a talking head is speech, without music", async () => {
    const { audio } = await analyzed("speech", join(REAL, "talking-head.mp4"));
    expect(audio.musicDetected).toBe(false);
    expect(audio.content!.shares.speech).toBeGreaterThan(0.6);
    expect(audio.content!.shares.music).toBeLessThan(0.1);
  }, 600_000);

  it("digital silence is silence", async () => {
    const work = join(TMP, "content-work-silence");
    await mkdir(work, { recursive: true });
    const wav = join(work, "silence.wav");
    await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "10", wav]);
    const { audio } = await analyzed("silence", wav);
    expect(audio.content!.shares.silence).toBeGreaterThan(0.95);
    expect(audio.musicDetected).toBe(false);
  }, 600_000);
});
