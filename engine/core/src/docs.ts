import type { SchemaName } from "./validate.js";
import type {
  Analysis, AudioDoc, Brand, Captions, ColorDoc, CreativePlan, MotionDoc, StyleTokens, Timeline, Transcript,
} from "./types.generated.js";

export interface Docs {
  brand: Brand;
  styleTokens: StyleTokens;
  analysis: Analysis;
  transcript: Transcript;
  plan: CreativePlan;
  timeline: Timeline;
  color: ColorDoc;
  audio: AudioDoc;
  captions: Captions;
  motion: MotionDoc;
}
export type DocKey = keyof Docs;

interface DocSpec {
  schema: SchemaName;
  path: string;
  /** Decision documents are snapshotted on every version; measured facts (analysis) are not. */
  versioned: boolean;
}

export const DOC_SPECS: Record<DocKey, DocSpec> = {
  brand: { schema: "brand", path: "brand/brand.json", versioned: true },
  styleTokens: { schema: "style-tokens", path: "brand/style-tokens.json", versioned: true },
  analysis: { schema: "analysis", path: "analysis/analysis.json", versioned: false },
  transcript: { schema: "transcript", path: "analysis/transcript.json", versioned: false },
  plan: { schema: "creative-plan", path: "plan/creative-plan.json", versioned: true },
  timeline: { schema: "timeline", path: "timeline/timeline.json", versioned: true },
  color: { schema: "color", path: "color/color.json", versioned: true },
  audio: { schema: "audio", path: "audio/audio.json", versioned: true },
  captions: { schema: "captions", path: "subtitles/captions.json", versioned: true },
  motion: { schema: "motion", path: "motion/motion.json", versioned: true },
};

export const VERSIONED_DOCS = (Object.keys(DOC_SPECS) as DocKey[]).filter((k) => DOC_SPECS[k].versioned);

export function isDocKey(key: string): key is DocKey {
  return key in DOC_SPECS;
}
