import { BveError, clipFrames, existsSync, readJson, round3, sha256File, toProjectRel, writeJsonAtomic, writeRenderRecord, type Project, type RenderRecord } from "../../core/src/index.js";
import { ensureFreshTokens, resolveFonts } from "../../brand/src/index.js";
import { ffmpeg } from "../../ffmpeg/src/index.js";
import { renderGraphicsAss, type AssFontReport } from "./ass.js";
import { renderAudioMix } from "./audioMix.js";
import { geometry, renderBasePlate } from "./basePlate.js";
import { cached, fileHashes, stageKey } from "./cache.js";
import { remotionStatus, renderGraphicsRemotion } from "./remotion.js";

export type RendererChoice = "auto" | "remotion" | "ass";

export type { RenderRecord };

export async function renderTarget(project: Project, targetId: string, opts: { draft?: boolean; renderer?: RendererChoice } = {}): Promise<RenderRecord> {
  const draft = opts.draft ?? false;
  const preset = await project.preset(targetId);
  const bad = (await project.verifySources()).filter((s) => !s.ok);
  if (bad.length) {
    throw new BveError("SOURCE_MODIFIED", `Source(s) changed or missing since ingest: ${bad.map((b) => `${b.id} (${b.reason})`).join(", ")}`, { hint: "Restore the original file, or re-ingest and re-analyse." });
  }
  const tokens = await ensureFreshTokens(project, preset.fps);
  const [timeline, color, analysis, audio, captions, motion] = await Promise.all([
    project.readDoc("timeline"),
    project.readDocOptional("color"),
    project.readDocOptional("analysis"),
    project.readDocOptional("audio"),
    project.readDocOptional("captions"),
    project.readDocOptional("motion"),
  ]);
  const g = geometry(preset, draft);
  const clipsUsed = timeline.tracks.video.filter((t) => t.kind === "primary").flatMap((t) => t.clips).filter((c) => c.enabled !== false);
  if (!clipsUsed.length) throw new BveError("VALIDATION", "The timeline has no enabled clip to render", { hint: "Run `bve plan compile`." });
  const noVideo = [...new Set(clipsUsed.map((c) => c.sourceId))].filter((id) => !project.source(id).probe.hasVideo);
  if (noVideo.length) {
    throw new BveError("UNSUPPORTED", `Audio-only source(s) on the picture track: ${noVideo.join(", ")}`, {
      hint: "Use a video source for the timeline; audio-only files are for voice-over or music (planned: audio-only timelines over a brand background).",
    });
  }
  const totalFrames = timeline.tracks.video.filter((t) => t.kind === "primary").flatMap((t) => t.clips).filter((c) => c.enabled !== false).reduce((a, c) => a + clipFrames(c, g.fps), 0);
  const durationSec = round3(totalFrames / g.fps);
  const sourceHashes = project.manifest.sources.map((s) => [s.id, s.sha256]);
  const hits: RenderRecord["cacheHits"] = [];
  // Referenced files are keyed by CONTENT, not by path.
  const fontFiles = (["display", "body", "caption"] as const).flatMap((r) => [...(tokens.type[r].files ?? []), ...(tokens.type[r].fallbackFiles ?? [])].map((x) => x.path));
  const assetHashes = await fileHashes(project, [tokens.logo?.primary, tokens.grade.lut, ...fontFiles]);

  // Pass A — base plate
  const reframe = timeline.reframe?.[targetId] ?? { mode: "center" };
  const baseKey = stageKey("base", { clips: timeline.tracks.video, reframe, color, shots: analysis?.sources.map((s) => s.shots.map((x) => [x.id, x.start, x.end])), grade: tokens.grade, lut: tokens.grade.lut ? assetHashes[tokens.grade.lut] : null, g, draft, sourceHashes });
  const base = await cached(project, `renders/cache/base-${baseKey}.mp4`, (tmp) => renderBasePlate(project, { timeline, color, analysis, tokens, preset, targetId, draft }, tmp));
  if (base.hit) hits.push("base");

  // Pass B — graphics (motion + captions), renderer chosen by capability
  const hasGraphics = !!(motion?.instances.length || captions?.cues.length);
  let renderer: RenderRecord["renderer"] = "none";
  let note: string | undefined;
  let picture = base.path;
  let graphicsKey: string | undefined;
  let assFonts: AssFontReport | undefined;
  if (hasGraphics) {
    const wanted = opts.renderer ?? ((process.env.BVE_RENDERER as RendererChoice | undefined) ?? "auto");
    if (wanted === "ass") renderer = "ass";
    else {
      const st = await remotionStatus(project.log);
      if (st.available) renderer = "remotion";
      else if (wanted === "remotion") throw new BveError("TOOL_MISSING", `Remotion is not available: ${st.reason}`, { hint: "Run `npm install`, or use `--renderer ass`." });
      else {
        renderer = "ass";
        note = `Remotion unavailable (${st.reason}); used the ASS/libass fallback renderer`;
        project.log.warn(note);
      }
    }
    graphicsKey = stageKey("graphics", { baseKey, renderer, tokens, motion, captions, safe: preset.safeZone, g, draft, assetHashes });
    const key = graphicsKey;
    const gfx = await cached(project, `renders/cache/gfx-${key}.mp4`, (tmp) =>
      renderer === "remotion"
        ? renderGraphicsRemotion(project, { basePlate: base.path, key, tokens, motion, captions, preset, geometry: g, durationSec, draft }, tmp)
        : renderGraphicsAss(project, { basePlate: base.path, tokens, motion, captions, preset, geometry: g, durationSec, draft }, tmp).then(async (r) => {
            assFonts = r;
            // Keep libass' font choice with the cached graphics so cache hits stay verifiable.
            await writeJsonAtomic(project.writable(`renders/cache/gfx-${key}.fonts.json`), r);
          }),
    );
    if (gfx.hit && renderer === "ass" && existsSync(project.abs(`renders/cache/gfx-${key}.fonts.json`))) {
      assFonts = await readJson<AssFontReport>(project.abs(`renders/cache/gfx-${key}.fonts.json`));
    }
    if (gfx.hit) hits.push("graphics");
    picture = gfx.path;
  }

  // Pass C — audio mix
  const mixKey = stageKey("mix", { clips: timeline.tracks.video, audio, loud: preset.loudness, sr: preset.audio.sampleRate, sourceHashes });
  const mix = await cached(project, `renders/cache/mix-${mixKey}.wav`, (tmp) => renderAudioMix(project, { timeline, audio, preset }, tmp));
  if (mix.hit) hits.push("mix");

  // Final encode to the delivery preset
  const ext = preset.video.codec === "prores" ? "mov" : "mp4";
  const rel = `renders/${targetId}-${project.head}${draft ? "-draft" : ""}.${ext}`;
  const out = project.writable(rel);
  const video = preset.video.codec === "prores"
    ? ["-c:v", "prores_ks", "-profile:v", preset.video.profile === "hq" ? "3" : "2", "-pix_fmt", preset.video.pixFmt]
    : ["-c:v", "libx264", "-profile:v", preset.video.profile ?? "high", "-preset", draft ? "veryfast" : "medium", "-crf", String(draft ? 23 : preset.video.crf ?? 18),
       ...(preset.video.maxBitrateKbps ? ["-maxrate", `${preset.video.maxBitrateKbps}k`, "-bufsize", `${preset.video.maxBitrateKbps * 2}k`] : []),
       "-pix_fmt", preset.video.pixFmt, "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"];
  const aud = preset.audio.codec === "aac" ? ["-c:a", "aac", "-b:a", `${preset.audio.bitrateKbps ?? 256}k`] : ["-c:a", preset.audio.codec];
  // Browser-rendered frames arrive full range (yuvj); deliverables must be broadcast/TV range BT.709.
  const levels = ["-vf", `scale=out_range=tv:out_color_matrix=bt709,format=${preset.video.pixFmt}`, "-color_range", "tv"];
  await ffmpeg(
    ["-i", picture, "-i", mix.path, "-map", "0:v:0", "-map", "1:a:0", ...levels, ...video, "-r", String(g.fps), ...aud, "-ar", String(preset.audio.sampleRate), "-t", durationSec.toFixed(3), ...(ext === "mp4" ? ["-movflags", "+faststart"] : []), out],
    { log: project.log },
  );

  // Fonts actually used. Remotion loads only project files and fails the render if one cannot load;
  // libass reports its own choice, so a silent substitution is detected and downgraded here.
  const fonts: NonNullable<RenderRecord["fonts"]> = hasGraphics
    ? resolveFonts(project, tokens).map((r) => {
        if (renderer !== "ass") return { role: r.role, requested: r.requested, used: r.used, status: r.status, detail: r.detail };
        if (!assFonts) return { role: r.role, requested: r.requested, used: r.used, status: "unverified" as const, detail: "libass font report unavailable" };
        const exp = assFonts.expected[r.role];
        const picked = exp ? assFonts.fontSelection[exp.fontname] : undefined;
        if (exp && picked && picked !== exp.postscript) {
          return { role: r.role, requested: r.requested, used: picked, status: "missing" as const, detail: `libass substituted "${exp.fontname}" (${exp.postscript}) with "${picked}"` };
        }
        return { role: r.role, requested: r.requested, used: picked ?? exp?.postscript ?? r.used, status: r.status, detail: r.detail };
      })
    : [];
  const record: RenderRecord = {
    targetId,
    version: project.head,
    draft,
    renderer,
    ...(note ? { rendererNote: note } : {}),
    path: toProjectRel(project.root, out),
    sha256: await sha256File(out),
    durationSec,
    stages: { base: toProjectRel(project.root, base.path), ...(hasGraphics ? { graphics: toProjectRel(project.root, picture) } : {}), mix: toProjectRel(project.root, mix.path) },
    cacheHits: hits,
    ...(fonts.length ? { fonts } : {}),
    createdAt: new Date().toISOString(),
  };
  await writeRenderRecord(project, record);
  return record;
}
