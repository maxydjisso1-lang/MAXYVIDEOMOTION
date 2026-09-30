/**
 * Controlled download of real-world test media (tests/fixtures/real/manifest.json).
 * - Checks the source's current sha1 on Wikimedia Commons / Archive.org against the pinned one,
 *   so a replaced upstream file is detected instead of silently changing the tests.
 * - Downloads only the needed segment (FFmpeg HTTP range requests), transcodes to H.264/AAC.
 * - Idempotent: existing outputs are kept. Nothing is committed (the folder is gitignored).
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, REPO_ROOT } from "../engine/core/src/index.js";
import { ffmpeg, probe } from "../engine/ffmpeg/src/index.js";

interface Fixture {
  id: string;
  output: string;
  use: string;
  source?: { kind: "commons"; title: string; variant: string; sha1: string | null } | { kind: "url"; url: string; sha1: string };
  segment?: { start: number; duration: number };
  derive?: { video: string; speech: string; speechStart: number; speechGainDb: number; noiseGainDb: number };
  license: string;
  attribution: string;
}

const DIR = join(REPO_ROOT, "tests/fixtures/real");
const UA = "brand-video-engine-fixtures/0.1 (https://github.com/; test fixtures)";
const manifest = JSON.parse(await readFile(join(DIR, "manifest.json"), "utf8")) as { fixtures: Fixture[] };
const only = process.argv.slice(2);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wikimedia rate-limits anonymous API use: be polite and back off. */
async function politeJson<T>(url: string): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await sleep(attempt ? 2000 * 2 ** attempt : 1500);
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    const text = await res.text();
    if (res.ok && text.trimStart().startsWith("{")) return JSON.parse(text) as T;
    console.log(`  … rate-limited (HTTP ${res.status}), retrying`);
  }
  throw new Error(`Gave up after retries: ${url}`);
}

async function commonsInfo(title: string): Promise<{ sha1: string; original: string; derivatives: string[] }> {
  const u = `https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo|videoinfo&iiprop=url|sha1&viprop=derivatives&format=json&titles=${encodeURIComponent(title)}`;
  const j = await politeJson<{ query: { pages: Record<string, { imageinfo?: { url: string; sha1: string }[]; videoinfo?: { derivatives?: { src: string }[] }[] }> } }>(u);
  const page = Object.values(j.query.pages)[0];
  const ii = page?.imageinfo?.[0];
  if (!ii) throw new Error(`Commons file not found: ${title}`);
  return { sha1: ii.sha1, original: ii.url, derivatives: (page.videoinfo?.[0]?.derivatives ?? []).map((d) => d.src) };
}

for (const fx of manifest.fixtures) {
  if (only.length && !only.includes(fx.id)) continue;
  const out = join(DIR, fx.output);
  if (existsSync(out)) {
    console.log(`= ${fx.id} (present)`);
    continue;
  }
  if (fx.source?.kind === "commons") {
    const info = await commonsInfo(fx.source.title);
    if (fx.source.sha1 && info.sha1 !== fx.source.sha1) throw new Error(`${fx.id}: upstream file changed (sha1 ${info.sha1} ≠ pinned ${fx.source.sha1})`);
    const url = fx.source.variant === "original" ? info.original : info.derivatives.find((d) => d.endsWith(fx.source!.kind === "commons" ? (fx.source as { variant: string }).variant : ""));
    if (!url) throw new Error(`${fx.id}: variant ${fx.source.variant} not available`);
    const seg = fx.segment ?? { start: 0, duration: 30 };
    console.log(`↓ ${fx.id}: ${seg.duration}s from ${fx.source.title} [${fx.source.variant}]`);
    await ffmpeg(["-user_agent", UA, "-ss", String(seg.start), "-t", String(seg.duration), "-i", url, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);
  } else if (fx.source?.kind === "url") {
    console.log(`↓ ${fx.id}: ${fx.source.url}`);
    const res = await fetch(fx.source.url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`${fx.id}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha1 = createHash("sha1").update(bytes).digest("hex");
    if (sha1 !== fx.source.sha1) throw new Error(`${fx.id}: sha1 ${sha1} ≠ pinned ${fx.source.sha1}`);
    await writeFile(out, bytes);
  } else if (fx.derive) {
    const d = fx.derive;
    const video = join(DIR, manifest.fixtures.find((f) => f.id === d.video)!.output);
    const speech = join(DIR, manifest.fixtures.find((f) => f.id === d.speech)!.output);
    const dur = (await probe(video)).durationSec;
    console.log(`⚙ ${fx.id}: speech over real street noise`);
    await ffmpeg([
      "-i", video, "-ss", String(d.speechStart), "-i", speech,
      "-filter_complex", `[0:a]volume=${d.noiseGainDb}dB[n];[1:a]aresample=48000,volume=${d.speechGainDb}dB,apad[s];[n][s]amix=inputs=2:normalize=0:duration=first[a]`,
      "-map", "0:v", "-map", "[a]", "-t", dur.toFixed(3), "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", out,
    ]);
  }
  const p = await probe(out);
  console.log(`  ✓ ${fx.output}: ${p.durationSec.toFixed(1)}s ${p.hasVideo ? `${p.width}x${p.height}@${p.fps}` : "audio"}${p.hasAudio ? " +audio" : ""}`);
}

const lines = manifest.fixtures.map((f) => `- **${f.output}** — ${f.use}. ${f.license}. ${f.attribution}.`);
await writeFile(join(DIR, "ATTRIBUTION.md"), `# Real fixtures — attribution\n\n${lines.join("\n")}\n`);
