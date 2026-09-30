"""Word-level transcription with faster-whisper.

Usage: python -m bve_py.transcribe --input audio16k.wav --output out.json [--model small] [--language fr]
                                   [--model-dir ./models]
Writes {"language", "language_probability", "model", "device", "segments": [{start, end, text,
words: [{word, start, end, probability}]}]}. Progress goes to stderr; the output file is written atomically.

The model is downloaded ONCE into --model-dir and loaded offline afterwards.
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def use_system_certificates() -> None:
    """Corporate proxies / antivirus often re-sign TLS: trust the OS certificate store."""
    try:
        import truststore

        truststore.inject_into_ssl()
    except Exception:  # pragma: no cover - best effort
        pass


def pick_device(requested: str) -> tuple[str, str]:
    if requested != "auto":
        return requested, "float16" if requested == "cuda" else "int8"
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda", "float16"
    except Exception:
        pass
    return "cpu", "int8"


def read_wav_16k_mono(path: str):
    """The engine decodes media with ITS FFmpeg into 16 kHz mono PCM; we only read samples.

    (faster-whisper's own decoder depends on PyAV, whose API changes between versions.)
    """
    import wave

    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getframerate() != 16000 or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit(f"expected 16 kHz mono 16-bit WAV, got {w.getframerate()} Hz / {w.getnchannels()} ch / {8 * w.getsampwidth()} bit")
        pcm = w.readframes(w.getnframes())
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0


def load_model(name: str, model_dir: str | None, device: str, compute_type: str):
    from faster_whisper import WhisperModel

    try:
        return WhisperModel(name, device=device, compute_type=compute_type, download_root=model_dir, local_files_only=True)
    except Exception:
        print(f"model '{name}' not cached in {model_dir or 'default cache'}: downloading once", file=sys.stderr, flush=True)
        use_system_certificates()
        return WhisperModel(name, device=device, compute_type=compute_type, download_root=model_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default=None)
    parser.add_argument("--model-dir", default=None)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        print("faster-whisper is not installed: run `uv sync --project engine/python`", file=sys.stderr)
        return 3

    device, compute_type = pick_device(args.device)
    model = load_model(args.model, args.model_dir, device, compute_type)
    segments, info = model.transcribe(
        read_wav_16k_mono(args.input),
        language=args.language,
        word_timestamps=True,
        vad_filter=True,  # drops hallucinations in silences and tightens word boundaries
        vad_parameters={"min_silence_duration_ms": 300},
        condition_on_previous_text=False,
    )
    print(f"language={info.language} p={info.language_probability:.2f} duration={info.duration:.1f}s device={device}/{compute_type}", file=sys.stderr, flush=True)

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
        print(f"progress {seg.end:.1f}/{info.duration:.1f}", file=sys.stderr, flush=True)

    tmp = args.output + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(
            {
                "language": info.language,
                "language_probability": round(info.language_probability, 3),
                "model": args.model,
                "device": f"{device}/{compute_type}",
                "segments": out_segments,
            },
            f,
            ensure_ascii=False,
        )
    os.replace(tmp, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
