import type { Captions, MotionDoc, Preset, StyleTokens } from "../../core/src/types.generated.js";

/** Everything the composition needs. Style comes ONLY from `tokens`. */
export interface BrandVideoProps extends Record<string, unknown> {
  /** Optional: only used for previews in Remotion Studio. Renders composite in FFmpeg instead. */
  baseSrc?: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  safeZone: Preset["safeZone"];
  tokens: StyleTokens;
  instances: MotionDoc["instances"];
  cues: Captions["cues"];
  logoSrc?: string;
  fontFaces: { family: string; src: string; weight?: number }[];
}
