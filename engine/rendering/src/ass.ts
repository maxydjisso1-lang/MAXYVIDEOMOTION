/**
 * Pass B (fallback renderer) — Advanced SubStation Alpha burned in with libass + FFmpeg overlays.
 * Used automatically when Remotion is unavailable. Same tokens, same layout module, fewer
 * animation capabilities (no springs, no per-word stagger): the degradation is explicit.
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, withTempDir, type Captions, type MotionDoc, type Preset, type Project, type StyleTokens } from "../../core/src/index.js";
import { ffmpeg } from "../../ffmpeg/src/index.js";
import { ctaLayout, cueLayout, DISPLAY_PX, FULLSCREEN_COMPONENTS, lowerThirdBox, titleLayout, unit, watermarkBox, type Anchor, type Frame } from "../../motion/src/layout.js";
import { applyCase } from "../../captions/src/index.js";
import type { Geometry } from "./basePlate.js";

/** ASS colour: &HAABBGGRR (alpha 00 = opaque). */
export function assColor(hex: string, alpha = 0): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  return `&H${alpha.toString(16).padStart(2, "0")}${b}${g}${r}`.toUpperCase();
}

function ts(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

const esc = (t: string) => t.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")");
const upper = (t: StyleTokens, s: string) => (t.caption.case === "upper" ? s.toLocaleUpperCase() : s);

function rect(w: number, h: number) {
  return `m 0 0 l ${Math.round(w)} 0 ${Math.round(w)} ${Math.round(h)} 0 ${Math.round(h)}`;
}

export function buildAss(tokens: StyleTokens, frame: Frame, motion: MotionDoc | undefined, captions: Captions | undefined): string {
  const t = tokens;
  const u = unit(frame);
  const ms = (frames: number) => Math.round((frames / t.fps) * 1000);
  const enterMs = ms(t.motion.enterFrames);
  const exitMs = ms(t.motion.exitFrames);
  const outline = t.caption.background === "stroke" ? t.caption.strokePx * u : 0;
  const shadow = t.caption.background === "shadow" ? 3 * u : 0;
  const borderStyle = t.caption.background === "box" ? 3 : 1;
  const boxed = t.shape.style === "block" || t.shape.style === "pill";
  const styles = [
    `Style: Caption,${t.caption.family},${Math.round(t.caption.sizePx * u)},${assColor(t.caption.textColor)},${assColor(t.caption.highlightColor)},&H00000000,&H80000000,${t.caption.weight >= 600 ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${outline.toFixed(1)},${shadow.toFixed(1)},8,0,0,0,1`,
    `Style: Title,${t.type.display.family},${Math.round(DISPLAY_PX * u)},${assColor(boxed ? t.color.onAccent : "#FFFFFF")},${assColor(t.color.accent)},${assColor(t.color.accent)},${assColor(t.color.accent)},-1,0,0,0,100,100,0,0,${boxed ? 3 : 1},${boxed ? (24 * u).toFixed(1) : "0"},${boxed ? 0 : (3 * u).toFixed(1)},8,0,0,0,1`,
    `Style: Body,${t.type.body.family},${Math.round(56 * u)},${assColor(boxed ? t.color.onAccent : "#FFFFFF")},${assColor(t.color.accent)},${assColor(t.color.accent)},${assColor(t.color.accent)},-1,0,0,0,100,100,0,0,${boxed ? 3 : 1},${boxed ? (22 * u).toFixed(1) : (2 * u).toFixed(1)},0,8,0,0,0,1`,
    `Style: Shape,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
  ];
  const events: string[] = [];
  const add = (layer: number, start: number, end: number, style: string, text: string) => events.push(`Dialogue: ${layer},${ts(start)},${ts(end)},${style},,0,0,0,,${text}`);
  const instances = motion?.instances ?? [];
  const fullscreen = instances.filter((i) => FULLSCREEN_COMPONENTS.has(i.component));

  for (const i of instances) {
    const s = i.start;
    const e = i.start + i.durationSec;
    const anchor = (i.anchor ?? "auto") as Anchor;
    const props = i.props as Record<string, string | undefined>;
    const dy = Math.round(t.motion.distancePx * u);
    switch (i.component) {
      case "Title":
      case "Subtitle": {
        const text = upper(t, props.text ?? "");
        const fit = titleLayout(frame, t, text, anchor);
        const box = fit.box;
        const x = Math.round(box.x + box.w / 2);
        const y = Math.round(box.y + fit.padPx * 0.7 + (t.shape.style === "line" ? 24 * u : 0));
        add(2, s, e, "Title", `{\\an8\\fs${fit.fontPx}\\move(${x},${y + dy},${x},${y},0,${enterMs})\\fad(${enterMs},${exitMs})}${fit.lines.map(esc).join("\\N")}`);
        if (t.shape.style === "line") {
          const lw = Math.round(box.w * 0.3);
          add(1, s, e, "Shape", `{\\pos(${Math.round(x - lw / 2)},${Math.round(y - 20 * u)})\\1c${assColor(t.color.accent)}\\fad(${enterMs},${exitMs})\\p1}${rect(lw, Math.max(2, t.shape.strokePx * u))}{\\p0}`);
        }
        break;
      }
      case "CTA": {
        const text = upper(t, props.text ?? "");
        const fit = ctaLayout(frame, t, text, anchor, !!props.subtext);
        const box = fit.box;
        const x = Math.round(box.x + box.w / 2);
        const y = Math.round(box.y + 22 * u);
        add(3, s, e, "Body", `{\\an8\\fs${fit.fontPx}\\move(${x},${y + dy},${x},${y},0,${enterMs})\\fad(${enterMs},${exitMs})}${esc(text)}`);
        break;
      }
      case "LowerThird": {
        const box = lowerThirdBox(frame, t);
        add(2, s, e, "Body", `{\\an7\\pos(${Math.round(box.x + 24 * u)},${Math.round(box.y)})\\fad(${enterMs},${exitMs})}${esc(props.name ?? "")}${props.title ? `\\N{\\fs${Math.round(32 * u)}\\1c${assColor(t.color.accent)}}${esc(props.title)}` : ""}`);
        break;
      }
      case "Transition": {
        const half = Math.round((i.durationSec / 2) * 1000);
        if (t.motion.transition === "wipe" || t.motion.transition === "slide") {
          add(5, s, e, "Shape", `{\\move(${-frame.width},0,${frame.width},0)\\1c${assColor(t.color.accent)}\\p1}${rect(frame.width, frame.height)}{\\p0}`);
        } else {
          add(5, s, e, "Shape", `{\\pos(0,0)\\1c${assColor(t.color.background)}\\alpha&H30&\\fad(${half},${half})\\p1}${rect(frame.width, frame.height)}{\\p0}`);
        }
        break;
      }
      case "BrandOutro":
      case "BrandIntro":
      case "LogoReveal": {
        add(10, s, e, "Shape", `{\\pos(0,0)\\1c${assColor(t.color.background)}\\fad(${enterMs},0)\\p1}${rect(frame.width, frame.height)}{\\p0}`);
        const bw = Math.round(140 * u);
        add(11, s + (t.motion.enterFrames * 2) / t.fps, e, "Shape", `{\\pos(${Math.round(frame.width / 2 - bw / 2)},${Math.round(frame.height / 2 + Math.min(frame.width, frame.height) * 0.14)})\\1c${assColor(t.color.accent)}\\fad(${enterMs},0)\\p1}${rect(bw, Math.max(3, (t.shape.style === "line" ? t.shape.strokePx : 18) * u))}{\\p0}`);
        break;
      }
    }
  }

  for (const cue of captions?.cues ?? []) {
    if (cue.hidden || fullscreen.some((f) => cue.start >= f.start && cue.start < f.start + f.durationSec)) continue;
    const words = cue.words.map((w, k) => applyCase(w.text, t.caption.case, k === 0));
    // libass does not wrap like the browser: break exactly where the shared layout breaks.
    const layout = cueLayout(frame, t, cue.words.map((w, k) => ({ text: words[k]!, lineBreakAfter: w.lineBreakAfter })));
    const breaks = layout.breaks;
    const parts = cue.words.map((w, k) => {
      const txt = esc(words[k]!);
      const emph = w.emphasis === "key" || w.emphasis === "strong";
      const styled = emph ? `{\\1c${assColor(t.caption.highlightColor)}${t.caption.emphasisStyle === "scale" ? "\\fscx115\\fscy115" : ""}}${txt}{\\r}` : txt;
      return styled + (breaks.has(k) ? "\\N" : " ");
    });
    const x = Math.round(layout.box.x + layout.box.w / 2);
    const anim = t.caption.animation === "pop" ? `\\fscx80\\fscy80\\t(0,${Math.round(enterMs * 0.8)},\\fscx100\\fscy100)` : "";
    add(4, cue.start, cue.end, "Caption", `{\\an8\\pos(${x},${Math.round(layout.box.y)})\\fs${layout.fontPx}${anim}\\fad(${Math.round(enterMs / 2)},80)}${parts.join("").trim()}`);
  }

  return [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${frame.width}`, `PlayResY: ${frame.height}`, "ScaledBorderAndShadow: yes", "WrapStyle: 2", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles, "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events, "",
  ].join("\n");
}

export async function renderGraphicsAss(
  project: Project,
  args: { basePlate: string; tokens: StyleTokens; motion?: MotionDoc; captions?: Captions; preset: Preset; geometry: Geometry; durationSec: number; draft: boolean },
  out: string,
): Promise<void> {
  const frame: Frame = { width: args.geometry.width, height: args.geometry.height, safeZone: args.preset.safeZone };
  const t = args.tokens;
  const u = unit(frame);
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "graphics.ass"), buildAss(t, frame, args.motion, args.captions), "utf8");
    await mkdir(join(dir, "fonts"), { recursive: true });
    for (const role of ["display", "body", "caption"] as const) {
      const f = t.type[role].file;
      if (f && existsSync(project.abs(f))) await copyFile(project.abs(f), join(dir, "fonts", `${role}${f.slice(f.lastIndexOf("."))}`));
    }
    const inputs = ["-i", args.basePlate];
    let graph = `[0:v]ass=graphics.ass:fontsdir=fonts[g0]`;
    let last = "[g0]";
    const logo = t.logo?.primary && existsSync(project.abs(t.logo.primary)) ? project.abs(t.logo.primary) : undefined;
    const instances = args.motion?.instances ?? [];
    const wm = instances.find((i) => i.component === "Watermark");
    const outro = instances.find((i) => FULLSCREEN_COMPONENTS.has(i.component));
    if (logo && (wm || outro)) {
      inputs.push("-loop", "1", "-t", args.durationSec.toFixed(3), "-i", logo);
      graph += `;[1:v]format=rgba,split[l1][l2]`;
      if (wm) {
        const box = watermarkBox(frame, t, (wm.anchor ?? "top-right") as Anchor);
        const h = Math.round(box.h);
        const right = (wm.anchor ?? "").endsWith("right");
        graph += `;[l1]scale=-2:${h},colorchannelmixer=aa=${t.logo?.watermark?.opacity ?? 0.8}[wm];${last}[wm]overlay=x=${right ? `${Math.round(box.x + box.w)}-w` : Math.round(box.x)}:y=${Math.round(box.y)}:enable='between(t,${wm.start},${wm.start + wm.durationSec})'[g1]`;
        last = "[g1]";
      } else graph += `;[l1]nullsink`;
      if (outro) {
        const lh = Math.round(Math.min(frame.width, frame.height) * 0.2);
        const appear = outro.start + (t.motion.enterFrames * 0.6) / t.fps;
        graph += `;[l2]scale=-2:${lh},fade=t=in:st=${appear.toFixed(3)}:d=${(t.motion.enterFrames / t.fps).toFixed(3)}:alpha=1[ol];${last}[ol]overlay=x=(W-w)/2:y=(H-h)/2:enable='gte(t,${outro.start})'[g2]`;
        last = "[g2]";
      } else graph += `;[l2]nullsink`;
    }
    await ffmpeg(
      [...inputs, "-filter_complex", graph, "-map", last, "-an", "-c:v", "libx264", "-preset", args.draft ? "veryfast" : "medium", "-crf", args.draft ? "22" : "15", "-pix_fmt", "yuv420p", "-t", args.durationSec.toFixed(3), out],
      { log: project.log, cwd: dir },
    );
  }, project.abs(".cache/tmp"));
}
