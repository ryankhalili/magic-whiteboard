# Magic Whiteboard

A magic whiteboard prototype: indicate a place on the canvas, ask for a graph or equation, and refine that object by speaking or typing. Excalidraw supplies the drawing surface and pointer interactions. The application owns the editable document, AI commands, math editors, notebooks, and shared undo history.

The default is plain white paper. Equations, graphs, text, and geometry have transparent backgrounds. The project supports desktop development and testing on a physical iPad.

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

Use ordinary drawing and selection to annotate, drag, resize, and rotate objects. To edit individual characters, double-click text or an equation, or select it and choose **Edit on board**. MathLive provides a visual equation editor, including a math keyboard; **LaTeX source** switches to source editing. A graph's expression can also be edited directly. The inspector exposes the full source and graph range.

## Placement and graph scale

The magic pen offers two focus modes, saved separately for each notebook:

- **Reference** is the default. A circled region supplies a location and context. New objects use its center as a placement reference and retain readable, natural proportions; the circle does not prescribe an exact width and height.
- **Literal** treats the circled region as a boundary. New objects use that area, and AI edits, moves, and resizes must stay inside it. Changes to objects outside the region are rejected. Draw a larger area if content cannot fit. Use this for a specific space on a worksheet or a deliberate layout.

A graph also has its own axis-scaling choice. **Equal units** gives one unit on each axis the same visual length, so `y = x` appears at 45 degrees. It preserves the chosen x range and adjusts the displayed y range; parts of a tall curve can be outside the visible window. **Auto scale** fits the curve vertically. **Natural graph size** restores a comfortable rectangle and equal units on an existing graph. Placement mode and graph axis scaling control different things.

## Voice interaction

**Voice mode** hides the typing bar and shows the microphone control, live transcript, and an action selector. The microphone circle responds to measured microphone volume (RMS). Choose **Assistant** for board commands, **Dictate math** for equations, or **Dictate text** for prose. Spoken replies are optional.

The connection provides continuous audio input, turn detection, transcripts, and board tool calls. Streaming text and math previews show partial model output before a complete edit is committed. Complete changes commit after recognized speech turns; recognition and generation latency still apply, and this is not guaranteed instant, per-word LaTeX transcription. Selecting characters or math content gives follow-up instructions more specific context. Check a resulting edit when the selection or spoken reference is ambiguous.

## Notebooks

Use **Notebooks** to create, rename, and switch between separate boards. Each notebook has its own canvas, title, paper, and layout settings. The previous single-board prototype is retained as the first notebook, using its existing storage key.

Canvas changes are checkpointed locally, and switching waits for the current checkpoint to finish. A failed save keeps the current notebook open and reports the problem. Notebook metadata has a recovery backup, and canvas checkpoints are stored in IndexedDB. Earlier prototype notebooks are migrated from these checkpoints or read-only legacy storage, including supported encoded handwriting and embedded image data. Unreadable or unsupported documents produce an error before replacement; their saved copies remain intact, and you can switch to another notebook. There is no notebook deletion control in this version.

Notebooks belong to the current browser profile and website address on this device. Another browser, device, or newly generated preview hostname has a separate local library. Download an editable `.marginalia.json` file to transfer a notebook or keep a backup. There is no shared cloud document store yet. **Open notebook file** replaces the active board; create a new notebook first if you want to keep the current one separately.

Before replacing an earlier SDK checkpoint, the app preserves its original schema, encoded handwriting, images and other records in an immutable `pre-owned-canvas:<notebook id>` archive in the checkpoint database. Repeated migration attempts do not replace that first archive. Migration stops if the archive cannot be saved. In **Help**, choose **Download original notebook backup** to retrieve it without changing the current board. The archive does not appear as another notebook or automatically make an old app understand the new checkpoint format. Notebooks created after migration have no earlier checkpoint to download.

The `.marginalia.json` file extension and existing browser-storage keys are retained for compatibility with notebooks saved before the Magic Whiteboard name change.

## Images, pages, and saving

- Import a PNG, JPEG, WebP, or GIF as an ordinary image or a locked background. Pasted screenshots use the same portable image storage. A new background replaces the previous background on the current board.
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

The canvas, drawing, rendering, image import, and file export run locally. Natural-language commands and Realtime voice use the paid OpenAI API. They use the key supplied for this hackathon; a ChatGPT subscription is not used for billing.

Default backend models:

- Typed commands: `gpt-4.1-mini`, using a constrained board-operation tool.
- Voice: `gpt-realtime-mini`, with `gpt-4o-mini-transcribe` for visible input transcription.

To contain prototype usage, the backend allows 200 typed commands and 30 total reserved voice minutes, and stops a voice session after five minutes. The voice client also stops after 90 seconds of inactivity. Counters persist in the ignored `.local/usage.json` file. These are local usage allowances, **not a guaranteed dollar spending cap**; account billing and available credits are authoritative. Check the OpenAI project before increasing the allowances. End the voice session when finished.

The API key stays on the server. `api.txt`, `.env` files, and local usage records are ignored by Git and blocked from HTTP serving. Browser sessions receive an audio connection and board commands, not the permanent API key. Do not publish the workspace itself as static files.

## Architecture

- React 19 and TypeScript provide the application shell.
- Excalidraw `0.18.1` supplies handwriting, selection, dragging, resizing, rotation, pan, and zoom. The app exposes a focused set of controls.
- The application document remains the source of truth. An adapter translates its records into Excalidraw elements and applies native changes back to those records.
- The application owns one undo history for drawing gestures, direct edits, and AI commands. It completes pointer interactions before applying an external edit.
- Custom `magic` shapes retain expressions, LaTeX, geometry, labels, ranges, and object IDs. Excalidraw element metadata also preserves their source records.
- Custom math, graphs, text, and geometry appear as generated PNG images inside Excalidraw. Their source remains editable through the app's live editors and inspector.
- mathjs parses supported scalar expressions. SVG paths render graphs, and KaTeX renders equations. MathLive supplies direct equation editing and a math keyboard.
- IndexedDB stores each notebook's editable records and embedded image assets. Portable `.marginalia.json` files, legacy migration, and application PNG/PDF export remain supported.
- A Vite plugin serves Excalidraw fonts locally and includes them in production builds. The app sets `EXCALIDRAW_ASSET_PATH` to this local directory.
- An Express backend calls the Responses API for typed commands and negotiates WebRTC Realtime sessions for voice.
- The assistant receives the selection, spatial focus, pointer, viewport, relevant objects, and recent conversation. Typed commands and Realtime's `inspect_board` tool can include board images.

The integration uses the published Excalidraw React component. It does not extract selected internals into a separate drawing engine. Hiding controls does not remove their code from the dependency. Bundle size remains an optimization task.

Start with `src/canvas/WhiteboardCanvas.tsx`, `src/canvas/excalidrawScene.ts`, and `src/canvas/liveContentImage.ts` for the integration. The document and history live in `src/canvas/editor.ts`. Math, notebook, file, and AI logic remain in `src/board/`, `src/notebooks/`, `src/files/`, `shared/board.ts`, and `server/`.

The original application code is proprietary. See [LICENSE](LICENSE). Excalidraw uses the MIT license. Its bundled fonts have separate terms, including OFL, MIT, and GPL v2 with the Liberation font exception. Preserve [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt), which the app also serves.

The [dependency inventory](research/production-license-inventory.json) and notices cover the installed port dependencies. The notices retain unresolved attribution gaps for `@arnog/colors` and `react-remove-scroll-bar`. The earlier [commercial distribution audit](research/COMMERCIALIZATION.md) describes the previous canvas and does not cover this port.

## Scope and next steps

This prototype is strongest at graph creation and revision, equations, simple geometry, and spatial board editing. It is not yet a comprehensive solver or a source of verified mathematical proofs.

1. Test a full voice/pen interaction on the physical iPad, especially the timing of “this” and “here.”
2. Improve handwriting cleanup with a reviewable recognition preview, symbol corrections, and an explicit keep-original option.
3. Add multi-page PDF import and ordered document/LaTeX export.
4. Improve offline recovery, cloud document synchronization, and collaboration.
5. Evaluate native packaging and high-fidelity Pencil input after measuring the browser experience.

Automated tests cover command validation, geometry, file validation, notebook migration/isolation, and serialized checkpoint persistence. Browser visual checks and physical-iPad verification remain separate from those tests; do not infer device readiness from a successful TypeScript build alone.

## Validation

Run `npm run check`, `npm test`, `npm run build`, and `npm audit` after dependency or integration changes. Automated tests cover scene conversion, custom image identity, history, file handling, notebook persistence, migration, and board commands. Test results from the previous canvas do not establish Excalidraw port readiness.

See the [Excalidraw port verification report](research/EXCALIDRAW_PORT.md) for the browser checks, fixes, integration tradeoffs, and repeatable smoke script from this branch.

Browser testing must include drawing over math and image backgrounds, selection, transforms, direct editing, AI edits, undo/redo, notebook switching, reload, and file exports. A full voice session, Apple Pencil pressure, touch gestures, and iPad download behavior still require tests on the physical device. PNG previews use bounded resolution, so extreme zoom can expose raster pixels.

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
