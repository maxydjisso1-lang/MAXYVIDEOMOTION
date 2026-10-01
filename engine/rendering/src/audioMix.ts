/** Pass C — FFmpeg: dialogue (cut like the picture) + cleanup chains + music/ducking + loudness. */
import { join } from "node:path";
import { clipDurationSec, withTempDir, type AudioDoc, type Preset, type Project, type Timeline } from "../../core/src/index.js";
import { compileChain, ensureRnnoiseModel, normalizeLoudness } from "../../audio/src/index.js";
import { ffmpeg } from "../../ffmpeg/src/index.js";
import { activeClips } from "./basePlate.js";

const EDGE_FADE = 0.012; // avoids clicks at every cut

export async function renderAudioMix(project: Project, args: { timeline: Timeline; audio?: AudioDoc; preset: Preset }, out: string): Promise<void> {
  const { timeline, audio, preset } = args;
  const sr = preset.audio.sampleRate;
  // The RNNoise model is fetched once (sha256-pinned) before any chain that uses it is compiled.
  if (audio?.dialogue.some((d) => d.chain.some((x) => x.type === "denoise-rnn" && x.enabled !== false))) await ensureRnnoiseModel();
  const clips = activeClips(timeline);
  const inputs: string[] = [];
  const chains: string[] = [];
  clips.forEach((c, i) => {
    const src = project.source(c.sourceId);
    const dur = clipDurationSec(c, preset.fps);
    const fades = `afade=t=in:d=${EDGE_FADE},afade=t=out:st=${Math.max(0, dur - EDGE_FADE).toFixed(3)}:d=${EDGE_FADE}`;
    if (src.probe.hasAudio) {
      inputs.push("-ss", c.sourceIn.toFixed(3), "-t", (dur + 0.1).toFixed(3), "-i", project.sourceMediaPath(c.sourceId));
      const chain = compileChain(audio?.dialogue.find((d) => d.sourceId === c.sourceId)?.chain ?? []);
      // apad+atrim: exactly the picture's frame-exact duration, even if the source audio is short.
      chains.push(`[${inputs.filter((x) => x === "-i").length - 1}:a]asetpts=PTS-STARTPTS,aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${dur.toFixed(6)},${[...chain, fades].join(",")}[a${i}]`);
    } else {
      chains.push(`anullsrc=r=${sr}:cl=stereo,atrim=duration=${dur.toFixed(3)}[a${i}]`);
    }
  });
  let graph = `${chains.join(";")};${clips.map((_, i) => `[a${i}]`).join("")}concat=n=${clips.length}:v=0:a=1[dia]`;
  let outLabel = "[dia]";

  // Music bed with sidechain ducking under the dialogue.
  const music = audio?.music?.[0];
  if (music) {
    const asset = project.asset(music.assetId);
    const idx = inputs.filter((x) => x === "-i").length;
    inputs.push("-ss", String(music.assetIn ?? 0), "-i", project.abs(asset.path));
    const total = timeline.durationSec ?? 0;
    const end = music.timelineEnd ?? total;
    const fadeOut = music.fadeOutSec ?? 1.5;
    graph += `;[${idx}:a]aresample=${sr},aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${music.gainDb ?? -14}dB,atrim=duration=${(end - (music.timelineStart ?? 0)).toFixed(3)},afade=t=in:d=${music.fadeInSec ?? 0.5},afade=t=out:st=${Math.max(0, end - (music.timelineStart ?? 0) - fadeOut).toFixed(3)}:d=${fadeOut},adelay=${Math.round((music.timelineStart ?? 0) * 1000)}:all=1[mus]`;
    if (music.ducking?.enabled !== false) {
      const d = music.ducking ?? {};
      graph += `;[dia]asplit[dia1][key];[mus][key]sidechaincompress=threshold=0.03:ratio=${Math.max(2, (d.amountDb ?? 12) / 2)}:attack=${d.attackMs ?? 80}:release=${d.releaseMs ?? 400}[musd];[dia1][musd]amix=inputs=2:normalize=0:duration=first[mix]`;
    } else {
      graph += `;[dia][mus]amix=inputs=2:normalize=0:duration=first[mix]`;
    }
    outLabel = "[mix]";
  }

  await withTempDir(async (dir) => {
    const pre = join(dir, "premaster.wav");
    await ffmpeg([...inputs, "-filter_complex", graph, "-map", outLabel, "-ar", String(sr), "-c:a", "pcm_f32le", pre], { log: project.log, cwd: project.root });
    await normalizeLoudness(pre, out, audio?.master ?? { loudnessLufs: preset.loudness.integratedLufs, truePeakDb: preset.loudness.truePeakDb, limiter: true }, sr, { log: project.log });
  }, project.abs(".cache/tmp"));
}
