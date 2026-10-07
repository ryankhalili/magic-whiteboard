# MagiBoard

An educational whiteboard where a pen, mouse, or voice can create and edit equations, graphs, diagrams, and homework annotations. Point or circle an area to give the assistant spatial context, then keep working on the same editable objects.

MagiBoard is currently a local web application for desktop and iPad browsers. Excalidraw supplies the drawing surface; the application owns notebook records, mathematical source, AI operations, and shared undo history. The original application code is proprietary; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.txt).

## Run locally

Use Node 22.12+ and npm. Install the locked dependencies, then start the development server:

```powershell
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000). Drawing, mathematical rendering, manual editing, PDF indexing, and exports work locally. AI features require a server-side `OPENAI_API_KEY`, or the ignored `api.txt` file in this directory. Never put credentials in a `VITE_` variable, browser code, or a notebook download.

For the production build:

```powershell
npm run check
npm test
npm run build
npm start
```

`npm start` serves the existing `dist` build; rebuild after changing client code. `PORT` changes the default port. Keep the server running while using the app.

## Write, point, and edit

1. Draw normally with the pencil, or use text and math tools to type directly.
2. Choose the magic pen and click a location or loosely circle an area.
3. Ask “Plot y = sin(x) here, showing two oscillations” or “Write the integral of sin(x) from two to five.”
4. Keep the object focused and ask for a revision: “Make the amplitude two,” “Use zero to ten,” or “Move that here.”

**Reference** focus treats the region as a location cue, allowing readable objects to extend beyond it. **Literal** focus constrains the edit to the circled area. Both support object IDs, contextual references, and undo.

Double-click text or math to edit individual characters. MathLive supplies a visual equation editor and math keyboard; LaTeX source remains available. **Object controls** includes applicable color, fill, opacity, dimensions, rotation, layer, lock, crop, and graph controls. Valid source drafts update locally after a short pause; incomplete input keeps the last valid rendering visible. **Math studio** provides direct creation and examples without an AI request.

Handwriting cleanup and plotting are explicit AI actions on selected ink. The result is editable text, math, or a graph. Review recognized symbols and use Undo when necessary; handwriting recognition is not infallible OCR.

## Mathematical tools

- **2D plots:** explicit functions and implicit equations, including `y=sin(x)`, `x=1`, and `x^2+y^2=9`. **Fit curve** fits an explicit function over its current X interval. **Reset -10…10** restores a standard window. The inspector shows the visible limits; editing Y limits chooses independent axis scales. Equal units preserves geometric proportions.
- **Geometry:** common shapes, labeled polygons/polylines, and convex polygons constrained by valid interior angles. Resizing constrained geometry preserves its angles. Angle constraints do not uniquely specify side lengths.
- **3D surfaces:** bounded sampled `z=f(x,y)` surfaces with view yaw/elevation controls.
- **Surfaces of revolution:** an explicit radius function swept about an X or Y axis, with a configurable sweep angle. This is a swept surface, not a general mesh/solid modeling engine.
- **Phase portraits:** two-dimensional autonomous ODE systems (`dx/dt`, `dy/dt`), direction fields, and numerically integrated trajectories. These are not general PDE simulations.

All model requests remain declarative. Expressions, domains, and operation payloads are validated; generated JavaScript or Python never executes in the application. Sampling can miss small features, singularities, or implicit tangencies. This is a visualization workspace, not a general symbolic solver or proof checker. Arbitrary 3D meshes, Manim/GIF generation, inequalities, and automatic scanned-book OCR are not implemented.

## Homework PDFs and textbooks

**Import → Put on the board** adds locked pages for annotation. Document view focuses on one page with previous/next controls; switching to the infinite canvas reveals the surrounding scratch space without changing the saved scene.

**Worksheet PDF** exports the original page sequence with work clipped to each page. Original page dimensions, crop boxes, rotations, and vector/text backgrounds are preserved when original bytes are available. Only the added annotations are rasterized. Side scratchwork stays out of this export. Older notebooks without retained originals fall back to their saved page images. A single original worksheet retains interactive form fields; export form-containing worksheets separately instead of combining them.

Generic PNG/PDF export captures the canvas or A4 region as a flattened image. **Selected area PDF** exports a circled region or selected objects. These are separate from the page-preserving homework export.

**Save to library** keeps a textbook for reference. The reader can move, resize, pin, zoom, and fit pages to its width. Its local index and downloadable structure guide reuse bookmarks, detectable contents entries, headings, practice locations, and text coverage. Search supports printed pages, numbered or named theorems, exercises, examples, sections, figures, and matching passages. Insert a whole page, suggested item, or manual crop.

The guide is generated locally during indexing; it is not an AI summary of the entire book. Exact local matches avoid the optional Jev ranker. Repeated numbers/names may need a chapter or candidate selection. Image-only pages need manual browsing/cropping, and detected figure/problem boundaries remain heuristic. Library originals stay in that browser; inserted images travel with notebook backups.

Limits: board PDF imports up to 120 pages and 40 MB; images up to 12 MB (large images are resized); editable project files up to 64 MB. Notebook storage and rendering budgets may impose a lower practical limit on large files.

## Voice and shortcuts

| Control | Behavior |
| --- | --- |
| Hold **Shift+R** or the **Hold to talk** button | Temporarily enable the magic pen and microphone; release to return to drawing |
| **Shift+Space** | Start or stop the voice session |
| **Shift+V** | Show or hide voice controls; hiding them does not itself stop an active session |
| **Ctrl/Cmd+K** | Focus the typed command bar |
| **Space** | Pan while using the canvas |

Typing and equation editing suppress canvas shortcuts. Hold-to-talk releases on focus loss and invalidates pending connections when changing notebooks. A temporary session closes after its final turn settles; a deliberately enabled continuous session stays active.

**Assistant** interprets board instructions. **Dictate math** transcribes equations and supports temporary previews for recognized integrals, bounds, functions, fractions, and evaluation bars. **Dictate text** inserts finalized transcripts literally, without asking a command model whether the words should be written. The selected mode changes both instructions and client behavior.

Partial math previews are speculative and never silently overwrite accepted source. Speech recognition may wait for a pause before producing chunks, so uninterrupted per-word compilation is not guaranteed. Confirmed operations are validated before committing.

Recovery is bounded and tied to the original instruction, target, and document version. Capacity errors honor short provider retry hints; malformed commands can receive one model correction. Changed targets, cancellation, quota/authentication failures, and repeated failures stop recovery. The UI should not replay a partially applied operation batch. No software can guarantee that provider, microphone, or network failures never occur.

**Pause microphone** closes the audio connection; muting spoken replies only silences the assistant. Temporary hold-to-talk gates audio and closes its session after pending work. Do not assume a muted but connected service is free. Continuous sessions renew in short segments and pause after inactivity.

A [local faster-whisper experiment](research/LOCAL-VOICE.md) records CPU/GPU measurements and reproducible scripts. It is not yet wired into the app's voice provider. The live application still uses OpenAI Realtime.

## Notebooks, backup, and recovery

Each notebook has separate content and settings. Saving is local to the browser profile and website origin; another device, profile, port, or temporary hostname has a different library. Pairing does not synchronize notebooks.

Download an editable `.marginalia.json` backup before changing origins or clearing browser data. Backups preserve objects, embedded images, and available original worksheet PDFs once per content hash. Import validates records and original-PDF hashes before replacing the active board. Create another notebook first when you want to keep the existing board separately.

Notebook switching waits for durable persistence. Storage failures keep the working board open. Legacy canvas migration retains an immutable original checkpoint, available through **Help → Download original notebook backup**. The existing storage keys, metadata identifiers, and `.marginalia.json` format are deliberately retained for compatibility with earlier names and notebooks.

Cloud synchronization, shared editing, accounts, and an offline application cache are not implemented. Browser-local storage is not a durable cloud backup.

## AI configuration and costs

The server defaults are `gpt-6-luna` with low reasoning for commands, `gpt-realtime-mini` for voice, `gpt-4o-mini-transcribe` for visible transcription, and `gpt-image-2.5-flare` at low quality for confirmed image generation. `OPENAI_TEXT_MODEL`, `OPENAI_REALTIME_MODEL`, and `OPENAI_IMAGE_MODEL` override the relevant defaults. Help shows the running configuration. Provider access and pricing must be checked against the account in use.

Image requests first create a placement/description proposal. Generation starts only after confirmation. Image jobs are not automatically retried after uncertain failure; durable request-ID records prevent accidental duplicate generation.

Cumulative local allowances default to 200 command/transcription attempts, 180 reserved voice minutes, and 20 confirmed image requests. Configure `OPENAI_COMMAND_LIMIT`, `OPENAI_VOICE_MINUTES_LIMIT`, or `OPENAI_IMAGE_LIMIT` explicitly. These counters persist across restarts in ignored `.local/usage.json`; they are usage allowances, not dollar caps or monthly billing plans. Unreadable counters disable paid requests instead of resetting consumption.

The API key stays on the server. Speech, selected board content/visual context, command context, and optional ranking candidates may be sent to their configured providers when those features run. Local drawing and indexing do not require those requests. A Codex or ChatGPT subscription does not serve as MagiBoard's API credential; account API billing is separate. See [API pricing](https://developers.openai.com/api/docs/pricing) and [Codex authentication](https://developers.openai.com/codex/auth/).

## iPad testing

Run the laptop server and open an HTTPS preview on iPad Safari; ordinary HTTP LAN addresses generally cannot access the microphone. With an official `cloudflared` binary in `.local` or PATH, start a temporary tunnel in a second terminal:

```powershell
node server/start-tunnel.mjs
```

Obtain the binary from [Cloudflare's official downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/). Enter the six-digit code from **Help & iPad connection** on the localhost laptop page. The code changes on restart or after repeated failed pairing attempts. Stop the tunnel with the helper's printed command when finished.

A new tunnel hostname creates a new storage origin: download backups before changing it. The computer and server must remain running. Safari's **Add to Home Screen** uses the included manifest and icons, but this is not a signed native app. Physical Apple Pencil input, touch gestures, microphone routing, interruptions, and downloads still need device testing.

## Engineering and release status

The main areas are `src/canvas/` (Excalidraw adapter/document/history), `src/board/` and `src/math/` (editable mathematical objects), `src/files/` and `src/documents/` (imports/exports/page view), `src/library/` (textbook indexing/reader), `src/ai/` (client voice/commands), and `server/` (validated provider requests and usage ledger).

Custom objects keep editable source in application records and use raster previews inside Excalidraw. Extreme zoom can reveal those pixels. Arbitrary foreign Excalidraw elements are rejected when the app cannot preserve their complete source/export representation.

Run type checking, tests, and a production build for every release. Check browser rendering, exported files, recovery, Undo/Redo, notebook restore, and physical iPad behavior separately. Historical reports in `research/` describe specific past checks, not current guarantees.

See [product readiness](research/PRODUCT_READINESS.md) for authentication, tenant isolation, durable backups, cost accounting, accessibility, and operational work required before a hosted paid release. [CONTRIBUTING.md](CONTRIBUTING.md) describes branch/PR review and compatibility requirements.

Excalidraw is MIT licensed, but bundled software and fonts retain their own conditions. The [current distribution audit](research/COMMERCIALIZATION.md) and [generated notices](THIRD_PARTY_NOTICES.txt) record the installed dependencies and unresolved provenance issues. Regenerate them after dependency changes with `python research/generate-notices.py`. A permissive canvas license does not remove all third-party obligations.
