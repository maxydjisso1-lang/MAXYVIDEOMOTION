/**
 * Quality control on the exact file that will be exported. Blockers make the report "fail",
 * and export refuses a failed report. Checks re-use the renderers' layout module, so what is
 * checked is what was drawn.
 */
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BveError, existsSync, readJson, round3, SCHEMA_VERSION, sha256File, sha256Json, withTempDir, writeJsonAtomic,
  type Preset, type Project, type QcReport,
} from "../../core/src/index.js";
import { deltaE, rgbToHex } from "../../brand/src/index.js";
import { applyCase } from "../../captions/src/index.js";
import { detectBlack, ffmpeg, measureLoudness, probe } from "../../ffmpeg/src/index.js";
import {
  ctaLayout, cueLayout, estimateTextWidth, FULLSCREEN_COMPONENTS, inside, lowerThirdBox, safeRect, titleLayout, watermarkBox, type Anchor, type Box, type Frame,
} from "../../motion/src/layout.js";
import { renderRecordPath, type RenderRecord } from "../../rendering/src/index.js";

type Category = keyof QcReport["categories"];
type Check = QcReport["categories"]["technical"] extends infer C ? (C extends { checks: (infer X)[] } ? X : never) : never;

export interface Waiver {
  checkId: string;
  reason: string;
  at: string;
}

const WAIVERS = "exports/qc-waivers.json";
const intersects = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Average color of a region of one frame (for "did the brand color survive rendering?"). */
export async function sampleColor(file: string, atSec: number, box: Box): Promise<string> {
  return withTempDir(async (dir) => {
    await ffmpeg(
      ["-ss", atSec.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `crop=${Math.round(box.w)}:${Math.round(box.h)}:${Math.round(box.x)}:${Math.round(box.y)},scale=1:1:flags=area,format=rgb24`, "px.ppm"],
      { cwd: dir },
    );
    const buf = await readFile(join(dir, "px.ppm"));
    const px = buf.subarray(buf.length - 3);
    return rgbToHex([px[0]!, px[1]!, px[2]!]);
  });
}

async function moovBeforeMdat(file: string): Promise<boolean | undefined> {
  const fh = await open(file, "r");
  try {
    let pos = 0;
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(16);
    while (pos < size) {
      await fh.read(head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (type === "moov") return true;
      if (type === "mdat") return false;
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      if (len < 8) return undefined;
      pos += len;
    }
    return undefined;
  } finally {
    await fh.close();
  }
}

export async function runQc(project: Project, targetId: string, opts: { draft?: boolean } = {}): Promise<{ report: QcReport; reportPath: string }> {
  const recPath = join(project.root, renderRecordPath(targetId, project.head, !!opts.draft));
  if (!existsSync(recPath)) {
    throw new BveError("MISSING_INPUT", `No render of "${targetId}" at the current version ${project.head}`, { hint: `Run \`bve render --target ${targetId}\` first.` });
  }
  const rec = await readJson<RenderRecord>(recPath);
  const file = project.abs(rec.path);
  const preset: Preset = await project.preset(targetId);
  const [tokens, brand, plan, captions, motion] = await Promise.all([
    project.readDoc("styleTokens"), project.readDoc("brand"), project.readDocOptional("plan"), project.readDocOptional("captions"), project.readDocOptional("motion"),
  ]);
  const waivers: Waiver[] = existsSync(project.abs(WAIVERS)) ? await readJson<Waiver[]>(project.abs(WAIVERS)) : [];
  const results: Record<Category, Check[]> = { technical: [], audio: [], captions: [], color: [], brand: [], motion: [], export: [] };
  const add = (cat: Category, c: Check) => {
    const waived = c.status === "fail" && waivers.find((w) => w.checkId === c.id);
    results[cat].push(waived ? { ...c, status: "warn", message: `${c.message} — WAIVED by user: ${waived.reason}` } : c);
  };

  const info = await probe(file);
  const frame: Frame = { width: info.width ?? preset.width, height: info.height ?? preset.height, safeZone: preset.safeZone };
  const fps = preset.fps;
  const frameSec = 1 / fps;
  const fullscreen = (motion?.instances ?? []).filter((i) => FULLSCREEN_COMPONENTS.has(i.component));

  // ---- technical
  add("technical", { id: "technical.draft", status: rec.draft ? "fail" : "pass", severity: "blocker", message: rec.draft ? "This is a draft render (half resolution, fast encode)" : "Final-quality render", fix: `bve render --target ${targetId}` });
  add("technical", { id: "technical.resolution", status: info.width === preset.width && info.height === preset.height ? "pass" : "fail", severity: "blocker", message: `${info.width}x${info.height}`, expected: `${preset.width}x${preset.height}`, measured: `${info.width}x${info.height}` });
  add("technical", { id: "technical.fps", status: Math.abs((info.fps ?? 0) - fps) < 0.01 ? "pass" : "fail", severity: "blocker", message: `${info.fps} fps`, expected: fps, measured: info.fps });
  const codecOk = preset.video.codec === "h264" ? info.videoCodec === "h264" : info.videoCodec === "prores";
  add("technical", { id: "technical.codec", status: codecOk && info.pixFmt === preset.video.pixFmt ? "pass" : "fail", severity: "blocker", message: `${info.videoCodec} ${info.pixFmt}`, expected: `${preset.video.codec} ${preset.video.pixFmt}` });
  const durDiff = Math.abs(info.durationSec - rec.durationSec);
  add("technical", { id: "technical.duration", status: durDiff <= 2 * frameSec + 0.03 ? "pass" : "fail", severity: "blocker", message: `${round3(info.durationSec)} s (timeline ${rec.durationSec} s)`, expected: rec.durationSec, measured: round3(info.durationSec) });
  if (preset.maxDurationSec) add("technical", { id: "technical.max-duration", status: info.durationSec <= preset.maxDurationSec ? "pass" : "fail", severity: "blocker", message: `${round3(info.durationSec)} s / max ${preset.maxDurationSec} s` });
  if (plan) {
    const tol = plan.durationToleranceSec ?? 2;
    const off = Math.abs(info.durationSec - plan.targetDurationSec);
    add("technical", { id: "technical.plan-duration", status: off <= tol ? "pass" : "warn", severity: "minor", message: `${round3(info.durationSec)} s vs plan ${plan.targetDurationSec} s ±${tol}` });
  }
  const black = (await detectBlack(file, { minSec: 0.5 })).filter((b) => !fullscreen.some((f) => b.start >= f.start - 0.2 && b.end <= f.start + f.durationSec + 0.2));
  add("technical", { id: "technical.black-frames", status: black.length ? "fail" : "pass", severity: "blocker", message: black.length ? `${black.length} unintended black segment(s)` : "No unintended black frames", ...(black[0] ? { at: { start: round3(black[0].start), end: round3(black[0].end) } } : {}) });
  const sources = await project.verifySources();
  add("technical", { id: "technical.missing-media", status: sources.every((s) => s.ok) ? "pass" : "fail", severity: "blocker", message: sources.every((s) => s.ok) ? "All sources present and unmodified" : sources.filter((s) => !s.ok).map((s) => `${s.id}: ${s.reason}`).join("; ") });

  // ---- audio
  add("audio", { id: "audio.present", status: info.hasAudio ? "pass" : "fail", severity: "blocker", message: info.hasAudio ? `${info.audioCodec} ${info.sampleRate} Hz` : "No audio stream" });
  if (info.hasAudio) {
    const loud = await measureLoudness(file);
    const off = Math.abs(loud.integratedLufs - preset.loudness.integratedLufs);
    add("audio", { id: "audio.loudness", status: off <= preset.loudness.toleranceLu ? "pass" : "fail", severity: "blocker", message: `${loud.integratedLufs} LUFS`, expected: `${preset.loudness.integratedLufs} ±${preset.loudness.toleranceLu}`, measured: loud.integratedLufs, fix: "bve audio clean (master stage)" });
    const tp = loud.truePeakDb - preset.loudness.truePeakDb;
    add("audio", { id: "audio.true-peak", status: tp <= 0 ? "pass" : tp <= 1 ? "warn" : "fail", severity: "blocker", message: `${loud.truePeakDb} dBTP (max ${preset.loudness.truePeakDb})`, measured: loud.truePeakDb });
    const drift = Math.abs((info.videoDurationSec ?? info.durationSec) - (info.audioDurationSec ?? info.durationSec));
    add("audio", { id: "audio.av-drift", status: drift <= 2 * frameSec + 0.05 ? "pass" : "fail", severity: "blocker", message: `stream durations differ by ${round3(drift)} s` });
  }

  // ---- captions
  const cues = captions?.cues ?? [];
  const wantCaptions = plan?.captions?.enabled !== false;
  if (!cues.length) {
    add("captions", { id: "captions.present", status: wantCaptions ? "warn" : "skip", severity: "major", message: wantCaptions ? "No captions although the plan enables them" : "Captions disabled" });
  } else {
    const overlaps = cues.filter((c, i) => i > 0 && c.start < cues[i - 1]!.end - 1e-3);
    add("captions", { id: "captions.overlap", status: overlaps.length ? "fail" : "pass", severity: "blocker", message: overlaps.length ? `${overlaps.length} overlapping cue(s)` : "No overlapping cues" });
    const fast = cues.filter((c) => c.words.map((w) => w.text).join(" ").length / Math.max(0.1, c.end - c.start) > 20);
    add("captions", { id: "captions.reading-speed", status: fast.length ? "warn" : "pass", severity: "minor", message: fast.length ? `${fast.length} cue(s) above 20 chars/s` : "Reading speed OK" });
    const short = cues.filter((c) => c.end - c.start < 0.7 - 1e-3);
    add("captions", { id: "captions.min-duration", status: short.length ? "warn" : "pass", severity: "minor", message: short.length ? `${short.length} cue(s) shorter than 0.7 s` : "All cues >= 0.7 s" });
    const safe = safeRect(frame);
    const out = cues.filter((c) => {
      const l = cueLayout(frame, tokens, c.words.map((w, k) => ({ text: applyCase(w.text, tokens.caption.case, k === 0), lineBreakAfter: w.lineBreakAfter })));
      const widest = Math.max(...l.lines.map((line) => estimateTextWidth(line, l.fontPx, tokens.caption.case === "upper", tokens.caption.weight)));
      return !inside(l.box, safe) || widest > l.box.w + 1 || l.lines.length > tokens.caption.maxLines;
    });
    add("captions", { id: "captions.safe-zone", status: out.length ? "fail" : "pass", severity: "blocker", message: out.length ? `${out.length} cue(s) outside the safe zone or over ${tokens.caption.maxLines} lines (estimated metrics)` : "All cues inside the platform safe zone (estimated metrics)", ...(out[0] ? { at: { start: out[0].start, end: out[0].end } } : {}) });
    const late = cues.filter((c) => c.end > rec.durationSec + 0.05);
    add("captions", { id: "captions.within-duration", status: late.length ? "fail" : "pass", severity: "blocker", message: late.length ? `${late.length} cue(s) end after the video` : "All cues inside the video" });
  }

  // ---- color
  const colorDoc = await project.readDocOptional("color");
  add("color", { id: "color.applied", status: colorDoc ? "pass" : "warn", severity: "minor", message: colorDoc ? `${colorDoc.shots.length} shot(s) corrected, look "${colorDoc.globalGrade?.look ?? "none"}"` : "No color pass (run `bve color auto`)" });

  // ---- brand
  const fresh = tokens.brandHash === sha256Json(brand);
  add("brand", { id: "brand.tokens-fresh", status: fresh ? "pass" : "fail", severity: "blocker", message: fresh ? `Style tokens match Brand DNA "${brand.name}"` : "Style tokens are stale: the render does not reflect the current brand", fix: "bve brand tokens && bve render" });
  const logoOk = existsSync(project.abs(tokens.logo?.primary ?? brand.identity.logo.primary));
  const logoNeeded = (motion?.instances ?? []).some((i) => i.component === "Watermark" || FULLSCREEN_COMPONENTS.has(i.component));
  add("brand", { id: "brand.logo", status: logoOk || !logoNeeded ? "pass" : "fail", severity: "blocker", message: logoOk ? "Logo file present" : "Logo file missing" });
  const fontIssues = (["display", "body", "caption"] as const).flatMap((role) => {
    const f = tokens.type[role];
    if (f.file && !existsSync(project.abs(f.file))) return [`${role}: ${f.family} file missing → fallback "${f.fallback ?? "generic"}"`];
    if (!f.file) return [`${role}: ${f.family} not embedded → depends on installed fonts${f.fallback ? ` (fallback ${f.fallback})` : ""}`];
    return [];
  });
  add("brand", { id: "brand.fonts", status: fontIssues.length ? "warn" : "pass", severity: "minor", message: fontIssues.length ? fontIssues.join("; ") : "All brand fonts embedded" });
  const outro = fullscreen[0];
  if (outro && rec.renderer !== "none") {
    const t = outro.start + outro.durationSec * 0.7;
    const sample = await sampleColor(file, Math.min(t, rec.durationSec - frameSec), { x: frame.width * 0.03, y: frame.height * 0.03, w: frame.width * 0.08, h: frame.height * 0.04 });
    const d = deltaE(sample, tokens.color.background);
    add("brand", { id: "brand.render-colors", status: d < 8 ? "pass" : "warn", severity: "major", message: `End card background ${sample} vs brand ${tokens.color.background} (ΔE ${d.toFixed(1)})`, measured: sample, expected: tokens.color.background });
  }

  // ---- motion
  const safe = safeRect(frame);
  const motionOut: string[] = [];
  const overrides: string[] = [];
  const collisions: string[] = [];
  for (const i of motion?.instances ?? []) {
    if (i.tokenOverrides) overrides.push(i.id);
    const p = i.props as Record<string, string | undefined>;
    const up = (s: string) => (tokens.caption.case === "upper" ? s.toLocaleUpperCase() : s);
    let box: Box | undefined;
    if (i.component === "Title" || i.component === "Subtitle") box = titleLayout(frame, tokens, up(p.text ?? ""), (i.anchor ?? "auto") as Anchor).box;
    else if (i.component === "CTA") box = ctaLayout(frame, tokens, up(p.text ?? ""), (i.anchor ?? "auto") as Anchor, !!p.subtext).box;
    else if (i.component === "LowerThird") box = lowerThirdBox(frame, tokens);
    else if (i.component === "Watermark") box = watermarkBox(frame, tokens, (i.anchor ?? "top-right") as Anchor);
    if (!box) continue;
    if (!inside(box, safe)) motionOut.push(i.id);
    for (const c of cues) {
      if (c.start >= i.start + i.durationSec || i.start >= c.end) continue;
      const cl = cueLayout(frame, tokens, c.words.map((w, k) => ({ text: applyCase(w.text, tokens.caption.case, k === 0), lineBreakAfter: w.lineBreakAfter })));
      if (intersects(box, cl.box)) {
        collisions.push(`${i.id}×${c.id}`);
        break;
      }
    }
  }
  add("motion", { id: "motion.safe-zone", status: motionOut.length ? "fail" : "pass", severity: "blocker", message: motionOut.length ? `Outside safe zone: ${motionOut.join(", ")}` : "All motion elements inside the safe zone" });
  add("motion", { id: "motion.caption-collision", status: collisions.length ? "warn" : "pass", severity: "major", message: collisions.length ? `Overlaps captions: ${collisions.join(", ")}` : "No collision with captions" });
  add("motion", { id: "motion.token-overrides", status: overrides.length ? "warn" : "pass", severity: "info", message: overrides.length ? `Local deviations from Brand DNA: ${overrides.join(", ")}` : "No deviation from Brand DNA tokens" });
  add("motion", { id: "motion.renderer", status: rec.renderer === "ass" ? "warn" : "pass", severity: "info", message: rec.rendererNote ?? `Rendered with ${rec.renderer}` });

  // ---- export
  const size = (await stat(file)).size;
  const sameFile = (await sha256File(file)) === rec.sha256;
  add("export", { id: "export.integrity", status: sameFile ? "pass" : "fail", severity: "blocker", message: sameFile ? "File matches the render record" : "File changed since render" });
  if (preset.maxFileSizeMb) add("export", { id: "export.size", status: size / 1e6 <= preset.maxFileSizeMb ? "pass" : "fail", severity: "blocker", message: `${(size / 1e6).toFixed(1)} MB` });
  if (rec.path.endsWith(".mp4")) {
    const fast = await moovBeforeMdat(file);
    add("export", { id: "export.faststart", status: fast ? "pass" : "warn", severity: "minor", message: fast ? "moov atom first (streams progressively)" : "moov atom not at the start" });
  }

  const categories = Object.fromEntries(
    (Object.keys(results) as Category[]).map((k) => {
      const checks = results[k];
      const status = !checks.length || checks.every((c) => c.status === "skip") ? "skip" : checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "pass";
      return [k, { status, checks }];
    }),
  ) as QcReport["categories"];
  const all = Object.values(results).flat();
  const status: QcReport["status"] = all.some((c) => c.status === "fail" && c.severity === "blocker") ? "fail" : all.some((c) => c.status !== "pass" && c.status !== "skip") ? "warn" : "pass";
  const report: QcReport = { schemaVersion: SCHEMA_VERSION, targetId, version: project.head, createdAt: new Date().toISOString(), renderPath: rec.path, status, categories };
  const reportPath = rec.path.replace(/\.(mp4|mov)$/, ".qc.json");
  await writeJsonAtomic(project.writable(reportPath), report);
  return { report, reportPath };
}

export function formatQc(report: QcReport): string {
  const label = (s: string) => ({ pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" })[s] ?? s.toUpperCase();
  const lines = [`QC REPORT — ${report.targetId} — ${report.version}`, ""];
  const names: Record<string, string> = { technical: "Technical", audio: "Audio", captions: "Captions", color: "Color", brand: "Brand consistency", motion: "Motion", export: "Export" };
  for (const [k, cat] of Object.entries(report.categories)) {
    const n = cat.checks.filter((c) => c.status === "warn" || c.status === "fail").length;
    lines.push(`${(names[k] ?? k).padEnd(18)} ${label(cat.status)}${n ? ` (${n})` : ""}`);
  }
  lines.push("", `Overall: ${label(report.status)}`);
  for (const cat of Object.values(report.categories)) for (const c of cat.checks) if (c.status === "fail" || c.status === "warn") lines.push(`  ${label(c.status)} ${c.id}: ${c.message}`);
  return lines.join("\n");
}

export async function waive(project: Project, checkId: string, reason: string): Promise<Waiver[]> {
  if (!reason.trim()) throw new BveError("VALIDATION", "A waiver needs a reason");
  const path = project.abs(WAIVERS);
  const list: Waiver[] = existsSync(path) ? await readJson<Waiver[]>(path) : [];
  list.push({ checkId, reason, at: new Date().toISOString() });
  await writeJsonAtomic(project.writable(WAIVERS), list);
  return list;
}

