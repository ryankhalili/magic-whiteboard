"""Optional local ASR experiment; never reads API keys or uploads input audio.

Use an isolated virtualenv. First use downloads public model weights to --cache.
Actual decoding is timed, including consumption of faster-whisper's lazy iterator.
This is a clip benchmark, not a streaming or microphone accuracy evaluation.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import time


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, nargs="+")
    parser.add_argument("--model", default="base.en")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--cache", type=Path, default=Path(".local/asr-models"))
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--library-directory", type=Path, action="append", default=[],
                        help="Windows CUDA/cuDNN DLL directory; affects only this process")
    args = parser.parse_args()
    if not 1 <= args.repeat <= 5:
        parser.error("repeat must be between 1 and 5")
    if any(not path.is_file() for path in args.audio):
        parser.error("audio must name existing local files")
    # Keep handles alive until process exit. No global PATH/driver changes.
    library_handles = [os.add_dll_directory(str(path.resolve())) for path in args.library_directory]
    if args.library_directory:
        os.environ["PATH"] = os.pathsep.join(str(path.resolve()) for path in args.library_directory) + os.pathsep + os.environ.get("PATH", "")

    from faster_whisper import WhisperModel
    start = time.perf_counter()
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type,
                         cpu_threads=8, download_root=str(args.cache))
    report = {"model": args.model, "device": args.device, "compute_type": args.compute_type,
              "versions": {name: importlib.metadata.version(name)
                           for name in ["faster-whisper", "ctranslate2"]},
              "load_seconds_including_download": round(time.perf_counter() - start, 3),
              "runs": []}
    for repeat in range(args.repeat):
        for path in args.audio:
            start = time.perf_counter()
            segments, info = model.transcribe(str(path), language="en", beam_size=5,
                                              vad_filter=True, condition_on_previous_text=False)
            text = " ".join(segment.text.strip() for segment in segments)
            seconds = time.perf_counter() - start
            result = {"file": path.name, "repeat": repeat + 1, "duration_seconds": round(info.duration, 3),
                      "decode_seconds": round(seconds, 3),
                      "real_time_factor": round(seconds / info.duration, 3) if info.duration else None,
                      "transcript": text}
            report["runs"].append(result)
            print(json.dumps(result), flush=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")


if __name__ == "__main__":
    main()
