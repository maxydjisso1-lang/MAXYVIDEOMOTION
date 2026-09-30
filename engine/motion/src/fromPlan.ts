/**
 * Creative plan + timeline + style tokens -> motion.json.
 * The plan says WHAT appears; tokens decide timing and variant, so the same plan yields
 * different motion documents for different brands (and identical ones for the same brand).
 */
import { round3, SCHEMA_VERSION, type CreativePlan, type MotionDoc, type StyleTokens, type Timeline } from "../../core/src/index.js";

type Instance = MotionDoc["instances"][number];

export function variantFor(tokens: StyleTokens): string {
  return `${tokens.shape.style}-${tokens.motion.transition}`;
}

const sec = (frames: number, t: StyleTokens) => frames / t.fps;

/** On-screen time for a text: brand minimum hold + a reading allowance, plus in/out animation. */
export function textDuration(text: string, t: StyleTokens): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  const reading = 0.6 + words * 0.3;
  return round3(sec(t.motion.enterFrames + t.motion.exitFrames, t) + Math.max(sec(t.motion.minHoldFrames, t), reading));
}

/** End card length follows the brand tempo: calm brands linger, energetic brands snap. */
export function outroDuration(t: StyleTokens): number {
  return round3(Math.min(2.6, Math.max(1.3, sec(t.motion.minHoldFrames + t.motion.enterFrames + t.motion.exitFrames, t) + 0.3)));
}

export function motionFromPlan(plan: CreativePlan, timeline: Timeline, tokens: StyleTokens): MotionDoc {
  const duration = timeline.durationSec ?? 0;
  const variant = variantFor(tokens);
  const instances: Instance[] = [];
  const markers = timeline.markers ?? [];
  const sectionStarts = markers.filter((m) => m.kind === "section" || m.kind === "hook").sort((a, b) => a.time - b.time);
  const nextBoundary = (t: number) => sectionStarts.find((m) => m.time > t + 0.01)?.time ?? duration;

  const outro = plan.motion?.outro ?? "BrandOutro";
  const outroSec = outro === "none" ? 0 : outroDuration(tokens);
  const outroStart = round3(Math.max(0, duration - outroSec));

  // Hook title: on screen from the first frame (sound-off viewers decide in 1-2 s).
  if (plan.hook.onScreenText) {
    const end = Math.min(nextBoundary(0), outroStart);
    instances.push({
      id: "title_hook",
      component: "Title",
      start: 0,
      durationSec: round3(Math.max(0.8, Math.min(textDuration(plan.hook.onScreenText, tokens), end))),
      anchor: "top",
      variant,
      props: { text: plan.hook.onScreenText },
      reason: `hook on-screen text (${plan.hook.technique})`,
    });
  }

  for (const s of plan.sections) {
    const m = markers.find((x) => x.id === `m_${s.id}`);
    if (!s.onScreenText || !m) continue;
    const end = Math.min(nextBoundary(m.time), outroStart);
    if (end - m.time < 0.8) continue;
    instances.push({
      id: `title_${s.id}`,
      component: "Title",
      start: m.time,
      durationSec: round3(Math.min(textDuration(s.onScreenText, tokens), end - m.time)),
      anchor: "top",
      variant,
      props: { text: s.onScreenText },
      reason: `on-screen text for section ${s.id} (${s.role})`,
    });
  }

  for (const [i, lt] of (plan.motion?.lowerThirds ?? []).entries()) {
    const at = lt.at ?? 0.5;
    instances.push({
      id: `lower_third_${i + 1}`,
      component: "LowerThird",
      start: round3(at),
      durationSec: round3(Math.min(textDuration(`${lt.name} ${lt.title ?? ""}`, tokens) + 1, Math.max(0.8, outroStart - at))),
      anchor: "lower-third",
      variant,
      props: { name: lt.name, ...(lt.title ? { title: lt.title } : {}) },
      reason: "speaker identification requested by the plan",
    });
  }

  // Brand transitions between sections (a cut stays a cut for "cut" brands).
  if (tokens.motion.transition !== "cut" && plan.transitions?.betweenSections !== "cut") {
    const half = Math.max(sec(tokens.motion.transitionFrames, tokens), 1 / tokens.fps);
    for (const m of sectionStarts.slice(1)) {
      if (m.time >= outroStart - 0.1) continue;
      instances.push({
        id: `transition_${m.label ?? m.id}`,
        component: "Transition",
        start: round3(Math.max(0, m.time - half)),
        durationSec: round3(half * 2),
        layer: 5,
        variant,
        props: {},
        reason: `brand transition (${tokens.motion.transition}) into section ${m.label}`,
      });
    }
  }

  if (plan.cta) {
    const ctaSec = plan.cta.durationSec ?? 3;
    const marker = markers.find((m) => m.kind === "cta")?.time ?? duration - ctaSec;
    const start = round3(Math.max(0, Math.min(marker, outroStart - ctaSec)));
    instances.push({
      id: "cta",
      component: "CTA",
      start,
      durationSec: round3(Math.max(0.8, Math.min(ctaSec, outroStart - start))),
      anchor: "safe-bottom",
      layer: 3,
      variant,
      props: { text: plan.cta.text, ...(plan.cta.subtext ? { subtext: plan.cta.subtext } : {}), showLogo: false },
      reason: "call to action from the creative plan",
    });
  }

  if (tokens.logo?.watermark && plan.logo?.watermark !== false) {
    instances.push({
      id: "watermark",
      component: "Watermark",
      start: 0,
      durationSec: round3(Math.max(0.5, outroStart)),
      anchor: (tokens.logo.watermark.anchor as Instance["anchor"]) ?? "top-right",
      layer: 0,
      variant,
      props: {},
      reason: "brand watermark rule (identity.logo.watermark)",
    });
  }

  if (outro !== "none" && outroSec > 0) {
    instances.push({
      id: "outro",
      component: outro === "LogoReveal" ? "LogoReveal" : "BrandOutro",
      start: outroStart,
      durationSec: round3(duration - outroStart),
      anchor: "center",
      layer: 10,
      variant,
      props: {},
      reason: `end card; length follows brand tempo (${tokens.motion.enterFrames} f enter)`,
    });
  }

  return { schemaVersion: SCHEMA_VERSION, instances: instances.sort((a, b) => a.start - b.start || (a.layer ?? 1) - (b.layer ?? 1)) };
}
