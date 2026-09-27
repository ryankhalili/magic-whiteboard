# Magic Whiteboard

A magic whiteboard prototype: indicate a place on the canvas, ask for a graph or equation, and refine the same editable object by speaking or typing. Built for desktop development and testing on a physical iPad. Its scene model, drawing tools, selection, transforms, camera, and history are application-owned implementations; no tldraw SDK is installed or required. The default is plain white paper with consistent text styling; equations, graphs, text, and geometry sit directly on the board with transparent backgrounds.

## Run locally

Requires a current Node.js installation compatible with Vite 7 (Node 22.12+ recommended).

```powershell
npm install
npm run dev
```

Open <http://localhost:3000>. Keep the terminal running. The server reads the hackathon key from `api.txt` in this directory, or from the `OPENAI_API_KEY` environment variable. Never put the key in a `VITE_` variable, client code, or a shared project file.

```powershell
npm run check
npm test
npm run build
npm start
```

`npm start` serves the previously built `dist` directory. `PORT` changes the default port. `OPENAI_TEXT_MODEL` and `OPENAI_REALTIME_MODEL` override the default models on the server.

## First interaction

1. Choose the magic pen, then click a location or draw around a region.
2. Type or say, “Plot y = sin(x) here, showing two full oscillations.”
3. Keep that object as your focus and ask, “Make the amplitude two,” or, “Use zero to ten.”
4. Indicate a new region and ask to move or resize the object there. Rotation, relative size changes, and undo are supported through board operations.
5. Try “Write the integral of sin(x) from two to five,” or, “Create a labeled right triangle.”

The empty board offers a graph example and a sample homework page. These add content to the current notebook. You can also load the sample homework background from Help. Backgrounds can be removed from Page settings, with Undo available afterward.

Use ordinary drawing and selection to annotate, drag, resize, and rotate objects. To edit individual characters, double-click text or an equation, or select it and choose **Edit on board**. MathLive provides a visual equation editor, including a math keyboard; **LaTeX source** switches to source editing. A graph's expression can also be edited directly.

## Object controls and live source

Select an object to open **Object controls**. The card stays available while editing its content. Collapsing it leaves an **Object controls** button to reopen it; deselecting the object closes its controls.

Edit the **Function or equation**, **LaTeX source**, or text field to update the board automatically after a short typing pause. Valid drafts compile locally, without an AI request. An incomplete or invalid expression stays in the field with an explanation while the board keeps its last valid version. **Restore last valid** discards that invalid draft. Ctrl/Cmd+Enter or leaving the field also applies a valid draft.

The card provides manual ink color, font size, graph/shape line width, shape fill and fill opacity, object opacity, size, rotation, layer order, and locking controls where applicable. Graph controls include X/Y limits, axis scaling, and separate grid/axes switches. Numeric fields apply on Enter or when leaving the field. Unlock a locked object before changing it.

**Zoom to object** brings the selected item into view without changing its contents. Voice and typed commands can also set an object's color, fill, opacity, rotation, crop, or layer: try “Bring this shape to the front.” Valid source edits are flushed before saving, exporting, or switching notebooks.

## Equations and custom geometry

Graphs support explicit functions such as `y=sin(x)` and implicit equations such as `x=1`, `x^2+y^2=9`, and `xy=1`. An equality involving both variables draws its numerically sampled zero contour in the visible graph window. This supports vertical lines, circles, and relations that are not single-valued functions of X. Graphs remain sampled approximations; a very small feature or discontinuity may need a different view. Inequalities, shaded solution regions, and a general symbolic equation solver are not implemented.

Implicit contour sampling can miss isolated points, tangencies without a sign change, or features smaller than the sampling grid. Check the graph against the source; it is not a complete mathematical solution-set oracle.

![Exported vertical line, circle, and constrained quadrilateral](research/interactive-math.png)

Ask, “Draw a quadrilateral with interior angles 91, 91, 90, and 88 degrees.” The polygon uses four actual vertices with those angles; labels are not substituted for geometric constraints. Convex angle lists must have 3–16 entries, each between 0.1° and 179.9°, and sum to `(n−2)×180°`. Inconsistent sums, crossing edges, and degenerate shapes return an explanation.

Angle constraints alone do not uniquely determine side lengths. The app chooses one valid convex construction tangent to a circle. Resizing fits the polygon uniformly within its object bounds to preserve its angles, so it may leave space inside a wide or tall box. Explicit custom polygons use 3–16 ordered normalized vertices (`{x,y}`, each coordinate from 0 to 1); open polylines use 2–16 vertices. One coordinate scale is preserved when fitting them. If both vertices and angles are supplied, they must agree. Comma-separated text such as `A,B,C,D` supplies vertex labels.

## Placement and graph scale

The magic pen offers two focus modes, saved separately for each notebook:

- **Reference** is the default. A circled region supplies a location and context. New objects use its center as a placement reference and retain readable, natural proportions; the circle does not prescribe an exact width and height.
- **Literal** treats the circled region as a boundary. New objects use that area, and AI edits, moves, and resizes must stay inside it. Changes to objects outside the region are rejected. Draw a larger area if content cannot fit. Use this for a specific space on a worksheet or a deliberate layout.

A graph also has its own axis-scaling choice. **Equal units** gives one unit on each axis the same visual length, so `y = x` appears at 45 degrees and a circle retains its proportions. It preserves the chosen x range and adjusts the displayed y range; parts of a tall curve can be outside the visible window. **Independent axes** uses separate horizontal and vertical scales; editing a Y limit selects this mode. Explicit functions can receive an automatic initial Y range, while implicit equations use a finite two-dimensional view. **Natural graph size** restores a comfortable rectangle and equal units on an existing graph. Placement mode and graph axis scaling control different things.

## Voice interaction

**Voice mode** hides the typing bar and shows the microphone control, live transcript, and an action selector. The microphone circle responds to measured microphone volume (RMS). Choose **Assistant** for board commands, **Dictate math** for equations, or **Dictate text** for prose. Spoken replies are optional.

The connection provides continuous audio input, turn detection, transcripts, and board tool calls. Streaming text and math previews show partial model output before a complete edit is committed. Complete changes commit after recognized speech turns; recognition and generation latency still apply. **True per-word math compilation while the user is still speaking is deferred.** The current behavior combines speech turns with streamed model output, rather than a continuously correct transcription of every spoken word. Selecting characters or math content gives follow-up instructions more specific context. Check a resulting edit when the selection or spoken reference is ambiguous.

## Notebooks

Use **Notebooks** to create, rename, and switch between separate boards. Each notebook has its own canvas, title, paper, and layout settings. The previous single-board prototype is retained as the first notebook, using its existing storage key.

Canvas changes are checkpointed locally, and switching waits for the current checkpoint to finish. A failed save keeps the current notebook open and reports the problem. Notebook metadata has a recovery backup, and canvas checkpoints are stored in IndexedDB. Earlier prototype notebooks are migrated from these checkpoints or read-only legacy storage, including supported encoded handwriting and embedded image data. Unreadable or unsupported documents produce an error before replacement; their saved copies remain intact, and you can switch to another notebook. There is no notebook deletion control in this version.

Notebooks belong to the current browser profile and website address on this device. Another browser, device, or newly generated preview hostname has a separate local library. Download an editable `.marginalia.json` file to transfer a notebook or keep a backup. There is no shared cloud document store yet. **Open notebook file** replaces the active board; create a new notebook first if you want to keep the current one separately.

Before replacing an earlier SDK checkpoint, the app preserves its original schema, encoded handwriting, images and other records in an immutable `pre-owned-canvas:<notebook id>` archive in the checkpoint database. Repeated migration attempts do not replace that first archive. Migration stops if the archive cannot be saved. In **Help**, choose **Download original notebook backup** to retrieve it without changing the current board. The archive does not appear as another notebook or automatically make an old app understand the new checkpoint format. Notebooks created after migration have no earlier checkpoint to download.

The `.marginalia.json` file extension and existing browser-storage keys are retained for compatibility with notebooks saved before the Magic Whiteboard name change.

## Images, pages, and saving

- Import a PNG, JPEG, WebP, or GIF as an ordinary image or a locked background. Pasted screenshots use the same portable image storage. A new background replaces the previous background on the current board.
- **Image crop** in Object controls hides percentages from the left, right, top, and bottom edges without deleting the original image bytes. **Reset crop** restores the full image. Unlock a background before cropping it. The crop is used in the live board, PNG/PDF export, and AI board captures.
- A4 mode uses a fixed 794 × 1123 canvas region; infinite mode expands around the content. Choose plain, dotted, grid, or ruled paper and a background color.
- PNG and PDF exports include the entire current board and its locked image background. A4 mode crops to the page; infinite mode includes all content with a small margin.
- PDF output contains a high-resolution flattened rendering. Graph expressions and equations remain editable in the app and in downloaded `.marginalia.json` project files.
- Project files contain editable scene records, embedded images, and board settings. They never include server credentials. Project import validates and migrates the document before replacing the active board. The legacy `.marginalia.json` format remains supported.
- Local browser storage holds each notebook. Download an editable project backup before switching browsers/devices, changing preview addresses, or clearing website data.

Image input is limited to 12 MB; large photographs are resized to at most 2400 pixels on their longest side. Project import is limited to 40 MB. PDF import is not included in this version.

Screenshot and ink understanding is experimental. Typed commands include an image of the focused region or viewport when the board contains an image or ink. In a voice session, the assistant can call `inspect_board` to capture that region on demand. The crop includes complete selected strokes and a small margin, and is scaled to at most 1024 pixels on the longest side.

Select or loosely circle handwriting to reveal **Clean up handwriting** and **Plot this handwriting**. Cleanup asks the assistant to create editable text and equations, then replace only the selected ink after successful creation; it keeps a homework background. Plotting asks it to read the function and create a nearby graph while retaining the original ink. These are deliberate AI actions, not automatic handwriting conversion or reliable OCR. Inspect recognized symbols and use Undo if needed, especially for small or ambiguous writing.

## Test on iPad

Run the server on the Windows computer and open its HTTPS preview URL on the iPad. The microphone requires a secure browser context: a plain `http://192.168...` LAN URL can load the board but cannot provide normal microphone access. `http://localhost:3000` is suitable for desktop testing.

The backend requires a six-digit device pairing code for a remote browser. On the laptop, open **Help & iPad connection** at `http://localhost:3000` to read the current code, then enter it on the iPad. The server terminal also shows it. Pairing permits AI use through the laptop; it does not synchronize notebooks. The code changes when the server restarts and is not displayed to remote browsers.

Use Safari's Add to Home Screen option for an app-style entry point. This is currently a web application, not a signed native iPad binary. Drawing quality, Apple Pencil behavior, microphone routing, and export/download behavior should be tested on the actual device. A future native package can wrap this application or replace the drawing surface with native ink.

An application manifest and iPad home-screen icon are included. There is no offline application cache yet; open the app while the Windows server and HTTPS preview are running.

## Voice and API cost

The canvas, drawing, rendering, image import, source compilation, and file export run locally. Natural-language commands and Realtime voice use the paid OpenAI API with this project's server-side key.

Codex can use a ChatGPT sign-in for subscription access, or an API key for usage-based access. That development-tool login does not replace the Platform API key used by this application; general API calls use separate API billing. See [official Codex authentication documentation](https://developers.openai.com/codex/auth/).

Default backend models:

- Typed commands: `gpt-4.1-mini`, using a constrained board-operation tool.
- Voice: `gpt-realtime-mini`, with `gpt-4o-mini-transcribe` for visible input transcription.

Help displays the running server's configured text and voice models. `OPENAI_TEXT_MODEL` and `OPENAI_REALTIME_MODEL` can change the defaults. The app responds to typed instructions and user-started voice turns through board tools; it has no autonomous background agent that continues working on notebooks.

To contain prototype usage, the backend allows 200 typed commands and 30 total reserved voice minutes, and stops a voice session after five minutes. The voice client also stops after 90 seconds of inactivity. Counters persist in the ignored `.local/usage.json` file. These are local usage allowances, **not a guaranteed dollar spending cap**; account billing and available credits are authoritative. Check the OpenAI project before increasing the allowances. End the voice session when finished.

The API key stays on the server. `api.txt`, `.env` files, and local usage records are ignored by Git and blocked from HTTP serving. Browser sessions receive an audio connection and board commands, not the permanent API key. Do not publish the workspace itself as static files.

## Architecture

- React 19 and TypeScript provide the application shell.
- An independently written scene editor provides selection, pressure-sensitive ink, camera controls, object transforms, transactions, and undo/redo. React and browser SVG/HTML render the scene; the editor uses no third-party canvas SDK.
- Custom `magic` shapes store their expressions, LaTeX, geometry, labels, ranges, and object IDs.
- mathjs parses an allowlisted arithmetic syntax; an application-owned evaluator and sampled SVG paths render explicit functions and implicit equation contours. Model output is not evaluated as JavaScript.
- `shared/geometry.ts` constructs and validates polygons, verifies interior angles, and provides uniform vertex fitting used by the shared live/export SVG renderer.
- KaTeX displays math; MathLive supplies direct equation editing and a math keyboard. `pdf-lib` packages board images into PDFs.
- A local notebook manifest tracks per-notebook metadata. Serialized IndexedDB checkpoints preserve separate boards and await a durable save before switching; legacy storage keys remain readable for migration.
- Native pointer interactions complete before a voice command or Undo changes the scene, preventing an old drag from overwriting a newer AI edit.
- An Express backend calls the Responses API for typed commands and negotiates WebRTC Realtime sessions for voice.
- The assistant receives selection, spatial focus, pointer, viewport, relevant objects, and recent conversation context. Typed commands can also include a board image; Realtime's `inspect_board` tool requests one on demand. Validated operations update the existing objects and preserve undo behavior.

Useful implementation entry points are `src/canvas/`, `src/board/`, `src/notebooks/`, `src/files/boardFiles.ts`, `src/files/capture.ts`, `shared/board.ts`, `server/board-tools.ts`, and `server/index.ts`.

The original application code is proprietary; see [LICENSE](LICENSE). Remaining libraries use permissive software licenses, and bundled math fonts use SIL OFL. Preserve [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), also served by the app. The [commercial distribution audit](research/COMMERCIALIZATION.md) records exact versions, font terms, the removed SDK, and the remaining `@arnog/colors` copyright-notice provenance gap. Removing the SDK eliminates that SDK's commercial-license requirement; this engineering audit is not a blanket clearance of API service terms, third-party uploads, or future added assets.

## Scope and next steps

This prototype is strongest at graph creation and revision, equations, constrained polygons, and spatial board editing. It is not yet a comprehensive solver or a source of verified mathematical proofs.

See the [Excalidraw interaction review](research/EXCALIDRAW-INSPIRATION.md) for reusable templates, bound connectors, duplication, and structured AI diagram tools. The current implementation uses no Excalidraw source or package. Team development follows [the feature-branch workflow](CONTRIBUTING.md).

1. Test a full voice/pen interaction on the physical iPad, especially the timing of “this” and “here.”
2. Improve handwriting cleanup with a reviewable recognition preview, symbol corrections, and an explicit keep-original option.
3. Add multi-page PDF import and ordered document/LaTeX export.
4. Improve offline recovery, cloud document synchronization, and collaboration.
5. Evaluate native packaging and high-fidelity Pencil input after measuring the browser experience.
6. Explore incremental speech-to-math rendering while speaking, with explicit draft/final states and correction handling; current voice edits remain turn-based.

Automated tests cover command validation, geometry, file validation, notebook migration/isolation, and serialized checkpoint persistence. Browser visual checks and physical-iPad verification remain separate from those tests; do not infer device readiness from a successful TypeScript build alone.

## Development workflow

Keep `main` stable. Develop changes on feature/fix branches and merge through reviewed pull requests after the checks pass; do not push directly to `main`. See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks, recovery safeguards, and what to include in a review.

## Verified in this prototype

- TypeScript and production build succeed; 261 automated tests pass. The last production dependency audit reported no known vulnerabilities; this change adds no dependencies. The main JavaScript bundle is approximately 1.81 MB before compression and triggers Vite's bundle-size warning; further splitting would improve initial loading.
- Chrome checks cover implicit vertical/circular equations, angle-constrained polygons, live valid/invalid LaTeX drafts, direct character deletion, persistent/reopened controls, manual styling in Literal mode, cropped-image persistence/reset, PNG export, and the inspector at a 768 × 1024 viewport. A real API command `Plot x=1` produced the complete equality and a valid vertical contour. Multi-object placement was checked visually; AI interpretation still needs user review.
- The independent canvas was exercised in Chrome for pressure-aware pencil rendering, selection, dragging, resizing, undo/redo, equation character editing, and PNG export with math fonts. Automated tests cover interruption of pointer gestures by AI commands and legacy notebook migration, including a real exported fixture with encoded handwriting and an image background.
- Direct math editing deletes and inserts individual symbols; text entry and graph expression editing were exercised in Chrome. A real API request changed `x^2+4` to `x^2+7` without creating another object.
- Separate notebooks retain their individual contents across switching and page reloads, including text edited immediately before switching. The plain whiteboard PNG export was visually checked.
- Real API commands create a two-cycle sine graph and modify the same existing graph.
- A drawn region controls graph placement in the HTTPS preview at a 1024 × 768 tablet viewport.
- Reference mode creates a natural-sized graph from a narrow gesture. Literal mode fits the chosen rectangle and rejects changes outside it. Equal units renders `y = x` at 45 degrees; switching axis modes preserves the object's size. Natural graph size restores proportions. Focus mode survives a reload, and the controls were checked at 768 × 1024.
- OpenAI WebRTC negotiation and acknowledged whiteboard-context creation, deletion, and replacement succeed in Chrome without microphone recording. The diagnostic catches protocol rejections as well as connection failures. Regressions enforce the 32-character conversation item ID limit. Actual spoken interaction still needs a physical-device check.
- The bundled worksheet imports as a locked background and survives reload. The assistant correctly read its function and roots from a board image; this is one test, not an OCR accuracy claim.
- Pencil drawing and undo work over the worksheet. PNG, content-sized PDF, and A4 PDF downloads were rendered and visually checked, including KaTeX fonts.
- The preview rejects unpaired AI requests, does not disclose its pairing code remotely, and blocks credential/source-file URLs.

The Chrome automation extension's file-picker upload helper required an unavailable file-URL permission, so local file-chooser upload and editable-project reimport still need a manual browser check. The image import pipeline was exercised using the bundled sample through the normal app UI. No extension permissions were changed.

## Temporary HTTPS preview

The hackathon setup uses an account-free [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). It is a temporary development preview: the computer and both processes must stay running. The board itself remains in each browser's local storage; opening the URL on another device starts that device's own board.

The verified official Windows binary is stored in ignored `.local/cloudflared.exe`. On a fresh checkout, obtain the Windows 64-bit executable from [Cloudflare's official downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/) and save it there. The installed version for this session is `2026.9.3`, checked against the official GitHub release asset's SHA-256 digest.

Start a new preview in PowerShell:

```powershell
.\server\start-tunnel.ps1
npm run dev
```

If the app server is already running, restart it after starting the new tunnel. The helper prints the HTTPS URL and tunnel process ID, and saves only the exact generated hostname in `.local/preview-host.txt`. Vite permits that hostname explicitly. It does not permit every tunnel hostname. The helper installs no service and makes no autostart change.

Open the HTTPS URL in Safari on the iPad, enter the pairing code from **Help & iPad connection** on the laptop, and use **Check voice connection** before starting the microphone. On the laptop, use `http://localhost:3000`. Stop the app with Ctrl+C. Stop the tunnel with the `Stop-Process -Id ...` command printed by the helper; stop an old tunnel before starting another. A newly started tunnel receives a different URL and therefore a separate browser-storage origin; download notebook files before changing preview addresses. A server restart changes the pairing code.

To check only the OpenAI voice configuration without opening media, run `npx tsx server/check-realtime.ts`. The script reports success or an error without printing credentials. Actual speech, pen latency, and iPad audio behavior still require device testing.
