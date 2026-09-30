/**
 * Synthetic fixtures with KNOWN properties, generated with FFmpeg (no binaries in git):
 *  - talk.mp4: 1920x1080 30fps, 14 s. Shot cut at 7.0 s; shot 2 is deliberately underexposed.
 *    "Voice" = harmonic bursts (one burst per word) over pink noise (~-46 dBFS):
 *    sentences at 0.5–3.0, 4.0–6.5, 7.5–10.0, 11.0–13.5 → silences of 1.0 s between them.
 *  - transcript.json: word timings that match the bursts exactly (incl. one filler "euh").
 *  - brand logos (PNG with alpha), drawn geometrically so no system font is needed.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpeg } from "../../engine/ffmpeg/src/index.js";
import type { Transcript } from "../../engine/core/src/index.js";

export const FIXTURE_SENTENCES: { start: number; words: string[] }[] = [
  { start: 0.5, words: ["Aujourd'hui", "je", "vais", "vous", "montrer"] },
  { start: 4.0, words: ["comment", "créer", "une", "marque", "forte."] },
  { start: 7.5, words: ["euh", "vraiment", "unique", "en", "2026."] },
  { start: 11.0, words: ["Rejoignez", "la", "communauté", "dès", "aujourd'hui."] },
];
export const FIXTURE_DURATION = 14;
export const FIXTURE_SHOT_CUT = 7.0;

const FILLERS = new Set(["euh", "heu", "um", "uh", "hum"]);

export function fixtureTranscript(sourceId: string): Transcript {
  return {
    schemaVersion: "1.0",
    language: "fr",
    model: "fixture/exact",
    sources: [
      {
        sourceId,
        segments: FIXTURE_SENTENCES.map((s, i) => {
          const words = s.words.map((w, k) => ({
            w,
            start: Math.round((s.start + 0.5 * k + 0.1) * 1000) / 1000,
            end: Math.round((s.start + 0.5 * (k + 1)) * 1000) / 1000,
            p: 0.97,
            ...(FILLERS.has(w.toLowerCase()) ? { filler: true } : {}),
          }));
          return { id: `seg_${String(i + 1).padStart(3, "0")}`, start: words[0]!.start, end: words.at(-1)!.end, text: s.words.join(" "), words };
        }),
      },
    ],
  };
}

export async function generateTalkVideo(out: string): Promise<string> {
  if (existsSync(out)) return out;
  const gate = FIXTURE_SENTENCES.map((s) => `between(t,${s.start},${s.start + 2.5})`).join("+");
  const voice = `0.22*(sin(2*PI*180*t)+0.5*sin(2*PI*360*t)+0.25*sin(2*PI*720*t))*(${gate})*gte(mod(t,0.5),0.1)`;
  await ffmpeg([
    "-f", "lavfi", "-i", `testsrc2=s=1920x1080:r=30:d=${FIXTURE_SHOT_CUT}`,
    "-f", "lavfi", "-i", `testsrc=s=1920x1080:r=30:d=${FIXTURE_DURATION - FIXTURE_SHOT_CUT}`,
    "-f", "lavfi", "-i", `aevalsrc='${voice}':s=48000:d=${FIXTURE_DURATION}`,
    "-f", "lavfi", "-i", `anoisesrc=color=pink:amplitude=0.006:sample_rate=48000:duration=${FIXTURE_DURATION}:seed=7`,
    "-filter_complex",
    "[1:v]eq=brightness=-0.22:contrast=0.75[dark];[0:v][dark]concat=n=2:v=1:a=0,format=yuv420p[v];[2:a][3:a]amix=inputs=2:normalize=0[a]",
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    out,
  ]);
  return out;
}

/** Geometric PNG logos with alpha (portable: no fonts involved). */
export async function generateLogo(kind: "crescent" | "bolt", color: string, out: string): Promise<string> {
  if (existsSync(out)) return out;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const alpha =
    kind === "crescent"
      ? "if(lt(hypot(X-H/2,Y-H/2),H*0.42)*gt(hypot(X-H/2-H*0.16,Y-H/2-H*0.06),H*0.36),255,0)+if(between(X,H*1.05,W-H*0.1)*between(Y,H*0.47,H*0.53),255,0)"
      : "if(lt(abs(Y-H/2),H*0.38)*lt(abs(X-W/2),W/2-H*0.38)+lt(hypot(abs(X-W/2)-(W/2-H*0.38),Y-H/2),H*0.38),255,0)*if(lt(abs((X-W/2)*0.35-(Y-H/2)*0.9),H*0.07),0,1)";
  await ffmpeg([
    "-f", "lavfi", "-i", `color=c=black:s=${kind === "crescent" ? "720x240" : "600x240"}`,
    "-vf", `format=rgba,geq=r=${r}:g=${g}:b=${b}:a='${alpha}'`,
    "-frames:v", "1", out,
  ]);
  return out;
}

export async function generateAll(dir: string): Promise<{ video: string; transcript: string }> {
  await mkdir(dir, { recursive: true });
  const video = await generateTalkVideo(join(dir, "talk.mp4"));
  const transcript = join(dir, "talk.transcript.json");
  await writeFile(transcript, JSON.stringify(fixtureTranscript("src_talk"), null, 2));
  return { video, transcript };
}
