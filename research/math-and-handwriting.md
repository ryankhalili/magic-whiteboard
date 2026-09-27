# Math, handwriting, and PDF research

Research date: September 26, 2026. Target: a 24-hour hackathon with a Windows development machine and a real iPad. This is a source-based survey; no accuracy or latency benchmarks were run.

## Recommendation

Build the voice-directed whiteboard first: select an area, speak a request, create an editable equation, graph, text block, or shape, then modify that same object conversationally. Use KaTeX for equation display and JSXGraph for interactive mathematical graphs. Handwriting recognition and PDF annotations are secondary demo features.

Store graphs as structured data, for example `{id, expression, xDomain, yDomain, bounds, style}`. “Make it +3” patches the selected graph's expression; “from 0 to 10” patches its domain. Local rendering evaluates the expression and redraws the graph. This keeps follow-up edits reliable and avoids asking an LLM to generate executable drawing code for each turn. Keep display LaTeX and a computable expression or AST separately.

## Rendering and computation

| Need | Candidate | Assessment |
| --- | --- | --- |
| Equation display | [KaTeX](https://katex.org/) — MIT | Recommended for immediate board previews. Implements a [documented subset of TeX commands](https://katex.org/docs/supported), not full document compilation. |
| Equation editing | [MathLive](https://github.com/arnog/mathlive) — MIT | Useful correction UI with LaTeX import/export, mobile math keyboard, and accessible input. Add after the core voice flow. |
| Interactive educational graphs | [JSXGraph](https://jsxgraph.org/home/) — MIT/LGPL dual license | Preferred fit for functions, geometry, implicit curves, vector fields, and touch interaction. Uses SVG or canvas. |
| Minimal function plot | [function-plot](https://github.com/mauriciopoppe/function-plot) — MIT | Smaller alternative for a narrow demo. D3-based function plotting, reevaluated as graph bounds change. |
| Scientific/data charts | [Plotly.js](https://plotly.com/javascript/is-plotly-free/) — MIT | Useful later for broader charts and 3D. Can operate offline without an account. |
| Numerical expressions | [math.js](https://mathjs.org/docs/expressions/security.html) | Parses expressions to an AST. Restrict accepted expressions and run expensive work with time limits in a worker; do not execute arbitrary generated JavaScript. |
| Symbolic mathematics | [SymPy](https://www.sympy.org/en/index.html) — BSD | Optional Python backend for integration, differentiation, and solving. Unnecessary for merely plotting a supplied function. |
| Rich math/SVG rendering | [MathJax](https://www.mathjax.org/) | Alternative where richer rendering or SVG is useful. Its [TeX processor is a LaTeX subset](https://docs.mathjax.org/en/latest/input/tex/index.html). |
| Full LaTeX document PDF | [Tectonic](https://tectonic-typesetting.github.io/en-US/) | Full TeX/LaTeX compiler. MIT core; some underlying components have other open-source licenses. Defer from live drawing to document mode/export. |

Board mode and document mode should share content but have different layout models. Board mode retains movable, rotated objects. Document mode orders paragraphs and equations into a typeset document. Rendering LaTeX on the board does not require recompiling an entire `.tex` document after each spoken word.

## Handwriting recognition

| Candidate | Verified capabilities | Practical limitation |
| --- | --- | --- |
| [Mathpix stroke API](https://docs.mathpix.com/reference/post-v3-strokes) | Accepts raw stroke coordinates; returns recognized text and LaTeX. Also supports images and PDFs through other endpoints. | Hosted commercial service. Use selected expressions rather than repeatedly submitting the whole page. Recognition is not guaranteed correct. |
| [MyScript iink](https://developer.myscript.com/docs/interactive-ink/4.2/overview/content-types/) | Specialized digital-ink SDK for text, math, diagrams, and mixed content, with native and web options. [Math output includes LaTeX/MathML](https://developer.myscript.com/docs/interactive-ink/4.2/android/fundamentals/import-and-export/). | Proprietary recognition engine. Its [pricing page](https://developer.myscript.com/pricing) advertises 2,000 free cloud requests and 25 development device licenses; production terms need checking. |
| [pix2tex / LaTeX-OCR](https://github.com/lukas-blecher/LaTeX-OCR) — MIT | Python/PyTorch image-to-equation-LaTeX model, with Python, HTTP API, and Docker paths. | Not a complete note-taking recognizer. The README still describes handwritten formula support as incomplete; training primarily uses rendered formula images. Treat as a backend experiment. |
| Vision LLM | Can interpret an image crop with surrounding context and propose a transcription. | Recommendation, not a benchmark finding: use as a fallback, preserve original ink, and make corrections easy. Do not treat recognition output as ground truth. |

The [official Mathpix live drawing demo](https://github.com/Mathpix/live-math-drawing-demo) is a close reference for “magic write.” Its visible repository had no LICENSE file, so permissive reuse was not confirmed. Its local sample places the master API key in the client bundle; a deployed app should obtain an app token through its own backend.

The [Mathpix stroke integration guide](https://docs.mathpix.com/guides/strokes) documents several useful constraints:

- Each request recognizes only the strokes supplied in that request. A stroke session does not carry recognition context forward.
- Send one expression per request for separate editable equation objects. Group strokes locally by selection, spacing, or idle time.
- Read both `latex_styled` and `text`; LaTeX-only rendering drops mixed-content results.
- Capture pointer events and coalesced samples, including pen-down and pen-up points. Preserve raw points for recognition; smoothing is for display.

Apple [Scribble](https://developer.apple.com/documentation/uikit/handwriting-recognition) supports handwriting as text input, including adapted custom views. It is not established as the complete math-to-LaTeX recognizer for this app. Current [PencilKit APIs announced for iPadOS 27](https://developer.apple.com/videos/play/wwdc2026/203/) also provide on-device handwritten text recognition and search, including selected strokes. This research did not verify a general math-to-LaTeX API. Evaluate native options later against the actual iPad OS and build environment.

## Homework PDFs and export

Use [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0) to render imported homework pages and [pdf-lib](https://pdf-lib.js.org/) ([MIT repository](https://github.com/Hopding/pdf-lib)) to create an exported copy containing added text, images, or vector marks.

For an MVP, PDF pages can be locked backgrounds with editable ink and objects over them. Keep the original PDF and rich project state, then flatten overlays into an exported PDF. PDF export should not be the only saved state: it loses the app's graph expressions, selections, and conversational edit context.

## Suggested demo sequence

1. Mark an area with the magic pen and say “plot y equals x squared plus two.”
2. Say “make it plus three,” then “show x from zero to ten”; update the same graph.
3. Select another area and dictate a definite integral; show formatted math immediately.
4. If time remains, select handwritten math, convert it through Mathpix or MyScript, and retain one-step undo.
5. Add a single homework PDF page and export only after the primary interaction works on the real iPad.

Recognition quality, graph gesture conflicts, and Apple Pencil behavior need hands-on testing. Mouse input can validate the object model on Windows, but cannot establish stylus latency or palm rejection quality.
