"""Speech probability per 32 ms with Silero VAD (the model shipped inside faster-whisper: no extra package).

Usage: python -m bve_py.vad --input audio16k.wav --output out.json
Writes {"model": "silero_vad_v6", "hopSec": 0.032, "probs": [...]}. The output file is written atomically.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from bve_py.transcribe import read_wav_16k_mono

CHUNK = 512  # Silero VAD at 16 kHz: one probability per 512 samples = 32 ms


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        import numpy as np
        from faster_whisper.vad import get_vad_model
    except ImportError:
        print("faster-whisper is not installed: run `uv sync --project engine/python`", file=sys.stderr)
        return 3

    audio = read_wav_16k_mono(args.input)
    audio = np.pad(audio, (0, (-len(audio)) % CHUNK))
    probs = get_vad_model()(audio).reshape(-1) if len(audio) else []

    tmp = args.output + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"model": "silero_vad_v6", "hopSec": CHUNK / 16000, "probs": [round(float(p), 3) for p in probs]}, f)
    os.replace(tmp, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
