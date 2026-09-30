"""Word-level transcription with faster-whisper.

Usage: python -m bve_py.transcribe --input media.mp4 --output out.json [--model large-v3] [--language fr]
Writes {"language": str, "segments": [{start, end, text, words: [{word, start, end, probability}]}]}.
Progress goes to stderr; the output file is written atomically.
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--language", default=None)
    parser.add_argument("--model-dir", default=None)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed: run `uv sync --project engine/python`", file=sys.stderr)
        return 3

    compute_type = "default"
    model = WhisperModel(args.model, device=args.device, compute_type=compute_type, download_root=args.model_dir)
    segments, info = model.transcribe(
        args.input,
        language=args.language,
        word_timestamps=True,
        vad_filter=True,  # drops hallucinations in silences and tightens word boundaries
        vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False,
    )
    print(f"language={info.language} p={info.language_probability:.2f} duration={info.duration:.1f}s", file=sys.stderr)

    out_segments = []
    for seg in segments:
        out_segments.append(
            {
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "text": seg.text,
                "words": [
                    {"word": w.word, "start": round(w.start, 3), "end": round(w.end, 3), "probability": round(w.probability, 3)}
                    for w in (seg.words or [])
                ],
            }
        )
        print(f"{seg.end:.1f}/{info.duration:.1f}", file=sys.stderr, flush=True)

    tmp = args.output + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"language": info.language, "segments": out_segments}, f, ensure_ascii=False)
    os.replace(tmp, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
