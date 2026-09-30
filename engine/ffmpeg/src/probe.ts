import type { Probe } from "../../core/src/index.js";
import { BveError } from "../../core/src/index.js";
import { ffprobe } from "./run.js";

interface FfStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  color_space?: string;
  color_transfer?: string;
  bits_per_raw_sample?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
}

const rate = (r?: string) => {
  if (!r) return 0;
  const [n, d] = r.split("/").map(Number);
  return d ? (n ?? 0) / d : Number(n) || 0;
};

export interface ProbeResult extends Probe {
  videoDurationSec?: number;
  audioDurationSec?: number;
}

export async function probe(path: string): Promise<ProbeResult> {
  let json: { streams?: FfStream[]; format?: { duration?: string } };
  try {
    const { stdout } = await ffprobe(["-v", "error", "-print_format", "json", "-show_streams", "-show_format", path]);
    json = JSON.parse(stdout);
  } catch (err) {
    throw new BveError("MISSING_INPUT", `Unreadable media file: ${path}`, { cause: err, hint: "Check the file is a valid video/audio file." });
  }
  const v = json.streams?.find((s) => s.codec_type === "video" && s.codec_name !== "mjpeg" && s.codec_name !== "png");
  const a = json.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(json.format?.duration ?? v?.duration ?? a?.duration ?? 0);
  const out: ProbeResult = { durationSec: duration, hasVideo: !!v, hasAudio: !!a };
  if (v) {
    const rot = Math.round(v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? Number(v.tags?.rotate ?? 0));
    const rotated = Math.abs(rot) % 180 === 90;
    // Report DISPLAY dimensions: FFmpeg auto-rotates on decode.
    out.width = rotated ? v.height : v.width;
    out.height = rotated ? v.width : v.height;
    out.rotation = ([0, 90, 180, 270, -90, -180, -270].includes(rot) ? rot : 0) as Probe["rotation"];
    const r = rate(v.r_frame_rate);
    const avg = rate(v.avg_frame_rate);
    out.fps = Math.round((avg || r) * 1000) / 1000;
    out.fpsMode = r && avg && Math.abs(r - avg) / r > 0.01 ? "vfr" : "cfr";
    out.videoCodec = v.codec_name;
    out.pixFmt = v.pix_fmt;
    if (v.color_space) out.colorSpace = v.color_space;
    if (v.color_transfer) out.colorTransfer = v.color_transfer;
    if (v.bits_per_raw_sample) out.bitDepth = Number(v.bits_per_raw_sample);
    if (v.duration) out.videoDurationSec = Number(v.duration);
  }
  if (a) {
    out.audioCodec = a.codec_name;
    out.sampleRate = Number(a.sample_rate);
    out.channels = a.channels;
    if (a.duration) out.audioDurationSec = Number(a.duration);
  }
  return out;
}
