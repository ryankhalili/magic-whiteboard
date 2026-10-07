# Extensible mathematics in MagiBoard

Research and implementation notes, October 7, 2026.

## Recommendation

Build an extensible collection of mathematical objects and computation adapters. Keep MagiBoard's canvas, voice, notebook storage, source editing, Undo and export as the common interface. An AI translates a request into a validated specification; a suitable engine calculates or renders it. This can grow much further than a menu of five tools, without pretending one language model or renderer can correctly implement every branch of mathematics.

Start with parametric/polar curves, interactive parameters, geometric constructions and symbolic calculation. Add adaptive numerical simulation next. Keep general generated-code execution a separate, explicitly bounded capability.

## What this change actually implements

- Proper KaTeX plot labels, including fractions in differential equations, shared by board and image export.
- Independent axis lines, numerical ticks, coordinate grid and surface mesh controls. Numbers are dimensionless unless the problem specifies physical units; numbers and units are different concepts.
- A default 3D view with Z up, Y right and positive X toward the viewer. Existing saved camera angles remain intact.
- Diffuse face shading that retains depth cues when surface mesh lines are hidden. This is faceted SVG lighting, not a WebGL renderer with cast shadows.
- AI-created surface, revolution and phase plots open a draft. Ordinary equations, ordinary 2D graphs and edits to existing board objects remain immediate. The manual math studio retains its own explicit insertion flow.
- Drafts accept typed or voice corrections. Voice stays connected. “Add it” confirms the current revision; cancellation discards it. Drafts do not alter the saved board until confirmation. Confirmation inserts the revised objects as one undoable operation and preserves unrelated work made meanwhile.
- A stale approval cannot commit a newer draft. Voice cannot create or revise and then approve that revision within the same speech turn; automatic repair cannot invent approval.

Current drafts hold up to six complex plots and are temporary: reload discards them. The implementation classifies complexity by the three supported scientific plot types, not by an established mathematical-confidence score. Ambiguity-aware review for other future tools remains a design goal. New computation engines, arbitrary code, unit inference, a heavy-model selector and unlimited math support are **not** implemented in this change.

## Capability survey

This is a practical coverage map, not an exhaustive classification of mathematics. An extensible app should register capabilities rather than add a toolbar button for every topic.

| Family | Useful objects and interactions | Computation/rendering direction |
| --- | --- | --- |
| Notation and derivations | Aligned steps, piecewise definitions, matrices, vectors, tensors, annotations | Existing editable LaTeX; structured expressions for semantic edits |
| Algebra | Simplify, factor, solve equations/systems, explicit assumptions and solution sets | SymPy; preserve exact and approximate results separately |
| Curves and relations | Explicit/implicit, polar, parametric, inequalities, piecewise curves | Extend existing evaluator and bounded samplers; handle discontinuities |
| Geometry | Constructions, conics, tangencies, intersections, angle/length constraints | JSXGraph or a constraint adapter; persist construction dependencies |
| Calculus | Tangents, secants, Riemann sums, integration regions, Taylor approximations | Symbolic results plus independently sampled visualizations |
| Multivariable calculus | Contours, heatmaps, parametric surfaces, level sets, vector fields, flux | Specialized samplers plus Three.js for interactive 3D |
| Linear algebra | Basis changes, transformations, eigenvectors, projections, matrix decompositions | SymPy/NumPy/SciPy; sliders and linked vector objects |
| Dynamical systems | Time series, phase portraits, equilibria, events and parameter sweeps | Adaptive ODE solvers, with initial conditions and tolerances |
| PDEs | Heat/wave/Poisson models, boundary conditions, spatial meshes | Specialized solver service such as FEniCS; never infer boundary data silently |
| Probability and statistics | Distributions, sampling, regression, confidence intervals, residuals | SciPy plus a statistical chart adapter; retain original data and random seeds |
| Signals and systems | FFT, spectrograms, filters, Bode plots, phasors | SciPy signal/FFT; explicit sample rates and frequency units |
| Optimization | Feasible regions, objective contours, iteration paths | Numerical optimizers with convergence and constraint diagnostics |
| Discrete mathematics | Networks, trees, graph algorithms, state diagrams, truth tables | Cytoscape.js/Graphviz adapters; nodes and edges remain editable |
| Complex analysis | Complex plane, domain coloring, roots and transformations | Complex-valued evaluation with explicit branch conventions |
| Scientific diagrams | Free-body diagrams, circuits, molecules, schematic biology | Domain-specific object schemas; drawings are not automatically simulations |
| Animation and explanation | Parameter sliders, time evolution, linked views, narrated derivations | Local interactive timeline; queued Manim video export if needed |

## Candidate engines and tradeoffs

**SymPy** covers symbolic algebra, calculus, matrices, ODEs, geometry, logic and physics-related modules. It is the best first adapter for exact results and LaTeX output. A symbolic answer still needs assumptions, domains and verification; a pretty expression is not evidence of correctness. SymPy uses a BSD license. [Features](https://www.sympy.org/en/features.html), [project](https://www.sympy.org/).

**SciPy** is a numerical toolbox rather than a drawing app. Use it for integration, optimization, statistics, linear algebra and signal processing. Its `solve_ivp` API exposes integration methods, tolerances and events, which are important upgrades over a fixed-step demonstration integrator. Save these solver settings with the object and report unsuccessful integration honestly. [API reference](https://docs.scipy.org/doc/scipy/reference/index.html), [solve_ivp](https://docs.scipy.org/doc/scipy/reference/generated/scipy.integrate.solve_ivp.html).

**JSXGraph** is the strongest candidate for interactive mathematical constructions: geometry, curves, fields, surfaces, sliders and touch interaction. Adopt selected capabilities behind an adapter rather than replacing the notebook with another app. Persist our declarative construction source so future renderer changes remain possible. It offers an MIT license option; retain its notices. [Documentation](https://jsxgraph.org/docs/), [MIT license](https://github.com/jsxgraph/jsxgraph/blob/main/LICENSE.MIT).

**Three.js** is appropriate when surfaces need genuine interactive cameras, lighting and materials. `MeshStandardMaterial` supplies a physically based material, but a polished math plot still requires our axes, ticks, data mapping, clipping and picking logic. Keep mesh edges, coordinate grids, axes and numbers separate. Later expose grid planes (XY/XZ/YZ), label units and lighting controls. [Material documentation](https://threejs.org/docs/pages/MeshStandardMaterial.html), [MIT license](https://github.com/mrdoob/three.js/blob/dev/LICENSE).

**Plotly.js** provides many scientific and statistical chart types, saving substantial implementation work for data exploration. It is less natural as a freeform notebook construction engine and adds another interaction layer. Load it only for appropriate objects. Its core is MIT licensed. [Scientific charts](https://plotly.com/javascript/scientific-charts/), [license](https://github.com/plotly/plotly.js/blob/main/LICENSE).

**MathBox** is useful inspiration or an optional adapter for animated mathematical scenes. **Cytoscape.js** suits interactive networks, while **Graphviz** supplies layout for graph descriptions. **Manim Community** is a good asynchronous animation/export backend, not a substitute for immediate canvas interaction. [MathBox](https://github.com/unconed/mathbox), [Cytoscape.js](https://js.cytoscape.org/), [Graphviz](https://graphviz.org/documentation/), [Manim](https://www.manim.community/).

**FEniCS** is a longer-term route to serious finite-element PDE applications. Treat each physical model as a supported recipe with defined inputs, boundary conditions and solver diagnostics, not as a universal “simulate anything” button. [Project](https://fenicsproject.org/).

These licenses do not remove attribution or redistribution obligations. Audit pinned packages and transitive assets before integrating them; no new library was installed for this change.

## MATLAB-like computation and local execution

For common educational tasks, Python with NumPy/SciPy/SymPy is a practical default. **Pyodide** can run Python scientific packages in the browser, with computation in a worker to keep drawing responsive. Package loading, memory and iPad performance require real-device benchmarks. Only load packages needed by the selected capability. [Pyodide](https://pyodide.org/en/stable/), [workers](https://pyodide.org/en/stable/usage/webworker.html).

A worker is **not a security sandbox** for arbitrary AI-written programs: workers can access networking APIs. Trusted, validated computation recipes can run locally; unrestricted generated code needs an isolated execution service without application credentials, with restricted network/file access, resource limits, cancellation and a vetted package image. Return structured results and diagnostics, not executable HTML. [Worker capabilities](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers).

Actual MATLAB can be an optional integration for users with suitable licenses. MATLAB Compiler can package supported applications for deployment using MATLAB Runtime; that does not imply that Runtime is a free general interpreter for arbitrary newly generated MATLAB scripts. Web deployment also has product-specific requirements. **GNU Octave** offers a MATLAB-like alternative, but toolbox compatibility and GPL redistribution requirements must be evaluated for the chosen architecture. [MATLAB Compiler](https://www.mathworks.com/help/compiler/getting-started-with-matlab-compiler.html), [web deployment](https://www.mathworks.com/help/webappserver/ug/create-and-deploy-a-web-app.html), [Octave](https://octave.org/about).

## Proposed extension contract

Each registered capability should provide:

1. **Input schema:** expressions, variables, parameters, domains, units, data, initial/boundary conditions and allowed edits.
2. **Validation:** syntax, dimensional compatibility, mathematical prerequisites and bounded resource estimates.
3. **Computation:** a versioned recipe or adapter returning values, warnings, convergence information and provenance.
4. **Rendering and interaction:** shared board/export views, hit targets, sliders, accessible labels and property controls.
5. **Persistence:** original source plus result/cache references, engine version and reproducibility settings.
6. **Review policy:** whether the request needs a preview, clarification or permission for an expensive compute job.

The language model selects capabilities and supplies inputs. Deterministic validators decide whether the specification can run. The user sees a draft with assumptions and relevant parameters; spoken corrections update that same specification. Jobs carry draft IDs and revisions so delayed results cannot overwrite newer instructions. Cancellation and changing notebooks invalidate outstanding jobs.

For a future simulation preview, show the model, initial conditions, domain, units and time interval before running an expensive job. A cheap coarse preview can be followed by a refined result on approval. Keep axes and physical units explicit; never invent units from the shape of a curve.

## Fast and deliberate modes

Keep normal voice interpretation fast. A deliberate mode can use a stronger text model and a higher supported reasoning setting for planning, derivations and model formulation, while keeping the microphone/session layer separate. A compute action should dispatch a solver when numerical work is required: extra model reasoning is not a replacement for integration or constraint solving.

Model choice and reasoning effort affect latency and token usage. Supported effort values depend on the model. Expose cancellation and a visible cost/latency expectation; validate model access before enabling the option. This change leaves existing models and reasoning settings unchanged. [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).

## Implementation sequence and acceptance checks

1. **Now:** editable previews, consistent formulas, separate display controls and readable 3D shading. Test creation → spoken correction → later approval, stale approval, cancel, rotation, Undo and export.
2. **Next:** typed capability registry; parametric/polar curves and parameter sliders; geometry constructions; symbolic simplify/solve/differentiate/integrate. Preserve source and test solutions by substitution where applicable.
3. **Then:** adaptive ODE time-series/phase views, solver diagnostics, units and data/statistics charts. Compare known analytic solutions and test tolerance sensitivity, events and singularities.
4. **Afterwards:** Three.js interactive 3D, contours and level sets; reproducible compute jobs and optional local Pyodide recipes. Test mesh bounds, discontinuities, camera orientation, export consistency and device performance.
5. **Advanced:** isolated generated-code execution, specialized PDE recipes and animation exports. Require cancellation, time/memory ceilings and reproducible results before exposing general execution.

The product can be open-ended through extensions while still being honest about what each installed capability can calculate, validate and display.
