# MagiBoard distribution audit

Refreshed October 3, 2026 from the installed production tree and retained software/font notices. This is an engineering inventory and release checklist, not legal clearance. API service agreements, uploaded textbook rights, privacy requirements, trademarks, and app-store terms require separate review.

## Current canvas and inventory

The application now uses the published `@excalidraw/excalidraw` **0.18.1** React component. Excalidraw's version-matched license is MIT; its permissions include commercial distribution subject to retaining its copyright and license notice. The app's original source remains governed by [LICENSE](../LICENSE). [Upstream Excalidraw license](https://raw.githubusercontent.com/excalidraw/excalidraw/v0.18.1/LICENSE)

Neither `tldraw` nor an `@tldraw/*` package appears in this installed production inventory. The earlier tldraw SDK replacement is complete for the current dependency tree. Historical notebook compatibility does not introduce a runtime tldraw dependency. This does not mean the application has no licensing obligations: transitive packages and bundled fonts have separate terms.

The regenerated [inventory](production-license-inventory.json) contains **364 physical package instances / 340 unique name-version pairs** on this installation after the scoped Excalidraw Sass override. Declared metadata counts are MIT 288, ISC 40, Apache-2.0 16, BSD-3-Clause 8, 0BSD 7, MIT AND Zlib 2, and one each of MPL-2.0 OR Apache-2.0, CC0-1.0, and Unlicense. These totals include backend/nested packages, vary with installed optional dependencies, and are not browser bundle-size measurements. They do not include the additional font-license analysis below.

| Direct dependency | Installed version | Recorded license |
| --- | --- | --- |
| @excalidraw/excalidraw | 0.18.1 | MIT; separate bundled-font terms |
| @openai/agents | 0.18.0 | MIT |
| express | 5.2.1 | MIT |
| katex | 0.16.47 | MIT code; OFL fonts |
| lucide-react | 0.468.0 | ISC; retained Feather attribution |
| mathjs | 15.2.0 | Apache-2.0; LICENSE and NOTICE |
| mathlive | 0.110.0 | MIT code; OFL fonts |
| openai | 6.49.0 | Apache-2.0 |
| pdf-lib | 1.17.1 | MIT |
| pdfjs-dist | 6.3.289 | Apache-2.0 |
| react / react-dom | 19.3.0 | MIT |
| zod | 4.6.5 | MIT |

The [full notices](../THIRD_PARTY_NOTICES.txt) retain installed license texts, Apache NOTICE material, pako zlib-port notices, package-specific attributions, and font notices. An identical copy is served from [public/THIRD_PARTY_NOTICES.txt](../public/THIRD_PARTY_NOTICES.txt). Generate these after a clean dependency install:

```powershell
npm ci
python research/generate-notices.py
```

Review the resulting inventory and notice diff; a generated metadata list is not a substitute for examining what the distribution actually ships.

## Font assets require their own review

The current Vite plugin copies Excalidraw's bundled fonts unchanged. Retained [font metadata](licenses/excalidraw/font-metadata.json) covers **234 WOFF2 assets in nine families**, including language subsets. The relevant original license/metadata files live under [licenses/excalidraw](licenses/excalidraw/). KaTeX and MathLive have a separate [binary metadata record](font-license-metadata.json) and retained OFL text.

- **OFL and related font terms:** preserve font copyright, license, and reserved-name information. OFL permits bundling under its conditions, restricts selling fonts by themselves, and restricts reserved names for modified fonts. The font's license does not automatically become the license of a document made with it. Read the exact shipped family/version terms; do not infer font licensing from the JavaScript package's MIT declaration. [Official OFL text](https://openfontlicense.org/open-font-license-official-text/)
- **ComicShanns and other package-specific attribution:** the notice artifact includes the license embedded in the relevant font metadata. Keep that attribution with redistributed files.
- **Liberation 1.05:** the asset bundled by Excalidraw 0.18.1 is the older GPL v2 font with the Liberation exceptions, not the later OFL-licensed Liberation 2.x family. Its [retained license](licenses/excalidraw/Liberation-LICENSE.txt) includes a document-embedding exception and source/distribution provisions. An embedding exception is not a blanket exemption for distributing the font binary. Confirm the corresponding-source and distribution requirements for the actual web/native package, or replace/remove this asset through a tested font configuration before release. This audit does not certify that those requirements are already satisfied.

## Remaining notice provenance gaps

Two installed packages still have incomplete upstream attribution evidence in the retained artifacts. A targeted October 3 primary-source recheck confirmed both npm license declarations and their published Git commit IDs; the exact-commit license URLs still returned 404. See the [attempted sources and outcomes](licenses/provenance-check-2026-10-03.json).

- `@arnog/colors` **0.5.0** declares MIT but includes no copyright/license-text file. The repository listed in its package metadata was unavailable during the original review. The available declaration and the unresolved provenance note are retained; verify exact upstream copyright and license text before release, or remove/replace the dependency.
- `react-remove-scroll-bar` **2.3.8** is present again through the Excalidraw dependency tree. It declares MIT without a packaged license file. The current upstream `master` branch has a complete MIT license identifying Anton Korzunov, but its correspondence to the installed 2.3.8 release was not verified. The published commit's license URL was unavailable, so precise version-matched attribution remains flagged in the notices.

Other missing top-level notice files have version-specific evidence collected by the generator: Excalidraw/Radix retained upstream licenses; `seedrandom`, `fastdom`, and `strictdom` README license sections; and `javascript-natural-sort`'s author/license header. Preserve both MIT and zlib-port notices for installed pako versions **1.0.11** and **2.0.3**. Apache components require preservation of applicable license/NOTICE material and notices of modifications when relevant; consult the actual terms. [Apache-2.0 text](https://www.apache.org/licenses/LICENSE-2.0)

## Before shipping a commercial build

1. Resolve the two attribution gaps and the Liberation-font distribution question against the exact released artifacts. Keep an evidence record for each resolution.
2. Regenerate the inventory/notices from the final lockfile on the release build, including separately packaged fonts, native code, model weights, and runtime libraries. The local faster-whisper experiment is outside the npm production inventory and is not currently bundled in MagiBoard.
3. Include the application license and applicable third-party notices in web and downloaded distributions. Confirm that production routes actually serve the notice artifact.
4. Recheck dependency/asset changes and security audit findings for each release. A changed version may change both vulnerabilities and licensing details.
5. Review hosted-service agreements, content handling, authentication/authorization, and privacy separately; see [product readiness](PRODUCT_READINESS.md).

## Historical context

The September 26 prototype contained tldraw 5.4.2 under its bespoke SDK terms. That prompted an initial owned-canvas replacement, followed by the current Excalidraw integration. The old **119-package** owned-canvas figure no longer describes this application. The [prototype inventory](prototype-license-inventory.json) and historical integration reports remain as records; the regenerated production inventory above is the current dependency evidence.
