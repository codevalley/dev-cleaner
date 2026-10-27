# 0.3.0: understandable cleanup

The user requested a minor release before a larger v2: correct documentation, disclose
Trash size on Home, explain keyboard shortcuts and labels, and let people inspect what
a project row includes before selecting it.

## Approach

Extend the existing Ink interface and its scanned artifact inventory. A copy-only change
would leave long detail lists inaccessible; a general filesystem browser is beyond this
release. The implementation choice is a scrollable project inspector, showing every
discovered artifact path, size, category, and whether the current preset includes it.
Inspection never changes selection. Right arrow and `d` open it; left arrow/Escape return.

Home measures Trash asynchronously using filesystem access only, avoiding a Finder
automation prompt during startup. Show measured bytes/items, loading, or an explicit
unavailable state. Refresh after cleanup and emptying; explicit Trash inspection retains
the existing Finder fallback and typed confirmation.

Use two bounded footer rows in Triage, complete key/action labels, and a scrollable `?`
help screen for narrow terminals. Explain slow rebuild, uncommitted changes, and dependency
downloads as consequences. Keep report label wording compatible; expand short UI labels.
Scan progress and partial totals must be described as provisional.

## Constraints and acceptance

- Stay on Node >=20, TypeScript, React 18 and Ink 5; no new installed packages. Declare Ink’s existing `string-width` directly for Unicode path layout.
- Do not widen artifact/cache tables, alter activity scoring, or change deletion guards.
- Do not read arbitrary artifact contents or add noninteractive cleanup.
- Inspector must expose long paths and every row, including artifacts excluded by preset.
- Keyboard help, inspection and Home must remain within terminal width/height.
- Failed or stale Trash reads must not display a fabricated empty state.
- Update current docs; label old specs/checklists as historical where superseded.
- Test behavior, typecheck, build, inspect terminal frames, and release as 0.3.0.
