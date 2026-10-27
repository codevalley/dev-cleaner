# Understandable cleanup implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship the requested documentation and inspection improvements as 0.3.0.
**Architecture:** Reuse the scan inventory and cleanup boundary. Add bounded text-page
rendering for inspection/help and a separate asynchronous, filesystem-only Trash preview.
**Tech Stack:** TypeScript, React 18, Ink 5, Vitest.
**Spec:** `docs/superpowers/specs/2026-10-27-inspection-design.md`.

## Global constraints

Node >=20; no new installed packages (declare Ink’s existing string-width dependency directly for lossless path wrapping); no changes to deletable paths, activity scoring or guards.
Existing explicit confirmation and read-only piped reporting remain in place.

## Review focus

- Slow or failed Trash reads: Home stays responsive and never claims an unknown size is zero.
- Late async results: earlier measurements cannot overwrite post-cleanup state.
- Small terminals: complete help remains accessible and frames do not overflow.
- Many artifacts and long paths: scrolling reaches the final entry and exact path.
- Inspecting unselected projects: inspecting/back/help never select or clean anything.

## Task 1: Trash preview and Home

Files: `src/trash.ts`, `src/cli.ts`, `src/ui/App.tsx`, `src/ui/Home.tsx`;
tests in `tests/trash.test.ts`, `tests/ui.home.test.tsx`, `tests/ui.usability.test.tsx`.
Introduce `allowFinder?: boolean` on Trash reads and `readTrashPreview` at the App boundary.

- [x] Add failing tests for measured/loading/unavailable preview, no Finder fallback, and refresh.
- [x] Implement optional filesystem-only reading and asynchronous preview with stale-result protection.
- [x] Show clear provisional scan totals and preview in Home; run focused tests.

## Task 2: Inspection, shortcuts, and label explanations

Files: `src/ui/TextPage.tsx`, `src/ui/Help.tsx`, `src/ui/Detail.tsx`,
`src/ui/Footer.tsx`, `src/ui/App.tsx`, `src/ui/labels.ts`; related UI tests.
TextPage owns line windowing; Detail produces inventory lines; Help owns full shortcut prose.

- [x] Add failing tests for scrolling long inventory, kept dependencies, right/left navigation and help.
- [x] Implement bounded text pages, scroll controls and complete footer actions.
- [x] Expand short labels and explain rebuild consequences; run UI tests and inspect frames.

## Task 3: Documentation and release

Files: README, SAFETY, CONTRIBUTING, VERSIONING, stale comments/specs, CHANGELOG,
package.json and package-lock.json.

- [x] Correct current behavior claims and mark historical planning material.
- [x] Run full tests, typecheck, build, CLI smoke and package checks.
- [x] Review final diff and bump 0.3.0.
- [ ] Publish through the existing tagged release workflow.

## Validation

- All 1,027 tests passed across 48 files (app suite and remaining suite run separately).
- Typecheck and build passed; built CLI help and read-only scan passed.
- Package dry-run and contents check passed.
- Fresh review findings fixed and rechecked: lossless Unicode/space path wrapping and narrow-screen help.
- Regression tests cover stale Trash previews, startup while sizing, last-artifact scrolling, and preserved selection.
