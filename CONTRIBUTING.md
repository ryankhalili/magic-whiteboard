# Contributing to Chalkpal

This is a private, proprietary application. Coordinate changes with the repository owner and preserve the original-code license plus all third-party notices.

## Branches and review

Keep `main` stable and runnable. Make changes on a focused branch such as `feat/interactive-math` or `fix/notebook-restore`; do not commit or push directly to `main`. Open a pull request, review its final diff, and merge after the required checks and relevant manual verification pass. Use a separate worktree for parallel work when sharing a checkout would mix changes. Do not remove or overwrite another contributor's work.

A pull request should explain the concrete problem, resulting behavior, tests performed, and remaining limitations. Include a screenshot for a visible change and a reproduction example for math or voice behavior. Report actual observations: automated tests do not establish physical-iPad behavior, per-word dictation, or model accuracy.

## Local development and checks

Use the Node version specified by the project's tooling; Node 22.12+ supports the current setup. From the repository directory:

```powershell
npm ci
npm run dev
```

Before review, run:

```powershell
npm run check
npm test
npm run build
```

The GitHub workflow runs these checks on pushes and pull requests. Add meaningful regression coverage when changing parsing, geometry, document migration, persistence, command execution, or gesture behavior. For rendering changes, inspect both the board and an exported image/PDF. Test crop, lock state, rotation, and legacy documents when the affected feature interacts with them.

## Implementation boundaries

- Keep model output declarative. Validate board operations and mathematical expressions; do not execute generated JavaScript or arbitrary mathjs evaluation.
- Keep the original scene editor independent of commercially restricted drawing SDKs. Review direct dependencies, transitive dependencies, fonts, and other bundled assets before adding them. Re-run `python research/generate-notices.py` after dependency changes and inspect [the commercialization audit](research/COMMERCIALIZATION.md).
- Use shared geometry and rendering helpers for the live board, exports, and AI captures. Custom angle labels must match measured vertex angles. Constrained polygons use uniform fitting because independent X/Y stretching would change their angles.
- Live source editing must keep the last valid equation or graph visible while a draft is incomplete. Manual controls must remain usable during editing and respect locks and Undo.
- Image crop is reversible metadata. Preserve the source asset and make the live view, exported files, and AI capture agree about the crop.
- Complete an in-progress pointer interaction before applying an AI command, changing notebooks, or taking a checkpoint.

## Notebook data and recovery

Notebook contents are local to a browser profile and origin. Download editable `.marginalia.json` backups before testing changes that affect persistence. A different localhost port or preview hostname has a separate library.

Validate and normalize an imported or restored snapshot before replacing the active document. Reject unsupported records explicitly; do not turn a failed migration into an empty saved notebook. Preserve existing storage keys, embedded image bytes, parent relationships, and object identifiers unless an explicit migration handles them.

The checkpoint store retains the first raw SDK snapshot under `pre-owned-canvas:<notebook id>` before migration. This recovery copy is immutable. Do not replace it with newer data, automatically restore it, or delete old SDK databases. **Download original notebook backup** in Help retrieves the original without changing the current board. Switching notebooks waits for durable persistence; report storage failures and preserve work in the tab.

## Credentials, model behavior, and costs

Use `OPENAI_API_KEY` or the ignored local `api.txt` file for the server. Never commit keys, `.env` contents, local usage records, or Codex authentication material. Do not place secrets in `VITE_` variables, browser code, fixtures, screenshots, or project downloads. Use non-sensitive fixtures for migration and vision tests.

The application defaults to `gpt-6-luna` with low reasoning effort for typed commands, `gpt-realtime-mini` for voice, and `gpt-4o-mini-transcribe` for visible input transcription. Luna does not replace the Realtime audio model. Server environment variables can override the first two; Luna-specific reasoning settings are applied only to that model. Check the existing API allowance before running paid integration tests; unit tests should not require network access or spend credits. Local request/minute limits are not a guaranteed dollar cap.

Codex's ChatGPT sign-in can provide subscription access for development, while API-key access is usage-based. Chalkpal's general OpenAI API requests still use its Platform key and separate API billing. See [official Codex authentication documentation](https://developers.openai.com/codex/auth/). Do not reuse Codex login tokens as application API credentials.

There is no autonomous background agent in the product. Voice processing currently follows recognized speech turns and can stream model output before committing a complete edit. True per-word math compilation while the user continues speaking remains future work. Keep these distinctions in documentation, demos, and release notes.
