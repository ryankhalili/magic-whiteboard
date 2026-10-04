# Local voice experiment — 2026-10-03

Local transcription works on the development laptop. This is a reproducible experiment, not a replacement for the app's current Realtime connection. No OpenAI requests, paid services, or microphone recordings were used for this evaluation.

## Observed results

Hardware: Windows, Intel i9-13900HX, NVIDIA RTX 4080 Laptop GPU (12 GB). Software: Python 3.12.3, faster-whisper 1.2.1, CTranslate2 4.8.2, PyAV 16.1.0; `base.en`, English, beam size 5, Silero VAD enabled, no prior-text conditioning. CPU uses 8 threads and int8; GPU uses float16.

Eight synthetic English clips cover an integral, evaluation bounds, a vertical line, a parabola window, a theorem reference, a 3D surface, a physics statement, and prose. Clip durations are 2.325–4.745 seconds. Every transcript preserved the mathematical words and intended command on both devices in two passes. A separate two-second silence clip produced empty text twice.

| Completed clip | Warm CPU decode | Warm GPU decode |
|---|---:|---:|
| Integral (4.104 s audio) | 0.391 s | 0.095 s |
| Evaluation bounds (4.505 s) | 0.464 s | 0.106 s |
| Parabola range (4.625 s) | 0.431 s | 0.197 s |
| Physics statement (4.364 s) | 0.456 s | 0.201 s |
| Plain text (4.199 s) | 0.429 s | 0.170 s |
| Surface (4.745 s) | 0.437 s | 0.188 s |
| Theorem reference (4.080 s) | 0.450 s | 0.172 s |
| Vertical line (2.325 s) | 0.411 s | 0.128 s |

Numbers are the second pass in the same process. Timings include consuming the lazy segment iterator. Cached model loading was 0.830 s CPU / 1.156 s GPU; the first decoded clip added 0.743 s / 0.728 s respectively. Earlier cold GPU runs took about two seconds on the first clip. Results fluctuate with laptop load and power state.

These are clean synthetic voices, not a human-speech accuracy benchmark. Classroom noise, accents, dysfluencies, long sessions, mathematics vocabulary, and iPad network latency remain untested. A completed-clip decoder does not provide true streaming. Do not describe the 0.1–0.2 s decode time as end-to-end voice latency: the speaker still has to finish the clip, and a board action also requires intent parsing and validated execution.

## Reproduce

From the repository root in PowerShell:

```powershell
python -m venv .local/asr-venv
& .local/asr-venv/Scripts/python.exe -m pip install -r research/requirements-local-asr.txt
powershell -NoProfile -File research/generate-asr-fixtures.ps1
$asrAudio = Get-ChildItem .local/asr-fixtures -Filter '*.wav' | ForEach-Object FullName
& .local/asr-venv/Scripts/python.exe research/benchmark-local-asr.py @asrAudio --device cpu --output .local/asr-cpu-results.json
```

The fixture generator uses Windows System.Speech. On other operating systems, provide your own local clips. The first model load downloads public weights into `.local/asr-models`; the benchmark never uploads the clips. Repeat with `--device cuda --compute-type float16` if CUDA 12 and compatible cuDNN 9 libraries are available. `--library-directory PATH` adds an existing Windows DLL directory for this process only. The observed GPU run reused an already installed cuDNN copy; it did not install a driver or modify system PATH.

Current unpinned PyAV 19.0.1 fails with faster-whisper 1.2.1 (`av.open` no longer accepts `metadata_errors`). The isolated experiment pins the working version above. CUDA hardware discovery can succeed even when cuDNN DLLs are unavailable, so a successful device count alone does not establish GPU inference readiness. Keep packages, model caches, and audio out of Git and app bundles.

## Product integration proposal

Use local voice activity detection or hold-to-talk to capture a short phrase, decode it in a persistent local worker, and feed its transcript into the existing validated command pipeline. Text dictation can bypass the command model, as it already does in Realtime mode. Local ASR removes the speech-provider charge, but a hosted command model or image generation still costs money. Local CPU/GPU time and power also have a cost.

For low-latency math drafts, use rolling overlapping audio windows and stable-prefix reconciliation. Keep drafts temporary; commit once against the captured document/selection version. The existing deterministic math preview parser can render supported partial integrals, bounds, fractions, and functions. It now also accepts ASR pause commas in unambiguous clauses such as “cosine of x, bar from pi to two pi.” Unsupported or ambiguous phrases wait for the model rather than making an incorrect permanent edit.

Before enabling this for users, add a loopback worker with explicit health/capability checks, bounded audio and request queues, cancellation on document changes, retained model loading, local-only audio processing, and clear handling when the companion laptop is offline. An iPad-only installation will need a different on-device engine or a hosted transcription fallback. Human speech and noisy-room evaluation should determine the chosen model size. We have not claimed production readiness from this smoke test.

## Current hold-to-talk behavior

The Realtime client can start with its audio input disabled; recovery and reconnect preserve that choice. Releasing a hold disables the microphone track while allowing the server's existing VAD to finish the final phrase. It deliberately does not send a competing manual audio commit, which can race automatic VAD. A temporary connection closes five seconds after release once any pending turn/repair has completed (maximum 90-second wait), instead of remaining connected indefinitely. A deliberately enabled continuous session is preserved.

Do not promise that sending silence on a muted WebRTC connection is free. The gate prevents microphone capture from reaching the service; closing the temporary session is the stronger boundary for avoiding idle usage. Losing focus releases the hold; switching documents cancels its lifecycle so a delayed permission prompt cannot unexpectedly open capture on another notebook.

## Primary references

- [faster-whisper implementation, requirements, VAD, and model loading](https://github.com/SYSTRAN/faster-whisper)
- [Base English checkpoint](https://huggingface.co/Systran/faster-whisper-base.en)
- [CTranslate2 installation](https://opennmt.net/CTranslate2/installation.html)
- [NVIDIA cuDNN Windows installation](https://docs.nvidia.com/deeplearning/cudnn/backend/v9.5.1/installation/windows.html)
- [OpenAI Realtime VAD and manual turn handling](https://developers.openai.com/api/docs/guides/realtime-conversations#disable-vad)

The faster-whisper source is MIT licensed. Treat model weights and any separately distributed CUDA/cuDNN, PyAV/FFmpeg, and other runtime components as separate third-party artifacts before packaging a desktop distribution; this experiment vendors none of them.
