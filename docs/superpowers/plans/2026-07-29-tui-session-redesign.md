# TUI Session Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two-pane Ink workspace with Splash → Home → Triage → Confirm → Done,
lazygit-style full-width triage, and a shared pixel/block brand face — without changing
safety, selection policy, screening, or the non-TTY report.

**Architecture:** Keep pure policy in `src/ui/model.ts`. Add `Splash.tsx` and `Home.tsx`.
Rework `App.tsx` into an explicit mode shell. Triage is full-width `List` + status line;
`Detail` becomes on-demand (`d`). Footer hints become mode-keyed. Stay on Ink/React/`trash`.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥20, Ink 5 + React 18, Vitest +
`ink-testing-library`. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-29-tui-session-redesign.md` — source of truth for
behaviour. Storyboard: workspace canvas `tui-ux-direction.canvas.tsx`.

## Global Constraints

- Node `>=20`. ESM only. TypeScript `strict` + `noUncheckedIndexedAccess`, `NodeNext`.
- Runtime deps remain exactly `ink`, `react`, `trash`. Do not add OpenTUI or anything else.
- All tests in `tests/**/*.test.{ts,tsx}`. No tests under `src/`.
- `src/types.ts` owns shared domain types. UI-only types may live in UI modules.
- Frame height budget stays `rows - 1` (Ink scroll bug). Never render a frame of height `rows`.
- Colour is never the only carrier of meaning.
- Non-TTY path (`cli.ts` → `renderScreenedReport`) must still never mount Ink or call clean.
- Safety invariants 1–8 and `onScreen` / `onClean` seams are unchanged.
- Spec open-point defaults: splash min dwell **400ms** or until recommended total ready
  (whichever later); `/` filter **out of this plan**; Detail is a **full-screen mode**, not an
  overlay that grows the frame.

---

## File map

| File | Task | Role |
| --- | --- | --- |
| `src/ui/model.ts` | 1 | `firstReclaimableId` cursor seed |
| `tests/ui.model.test.ts` | 1 | Tests for cursor seed |
| `src/ui/glyphs.ts` / `Banner.tsx` | 2 | Splash title letters in the shared face |
| `tests/ui.banner.test.tsx` (or glyphs) | 2 | Title rendering / narrow fallback |
| `src/ui/Footer.tsx` | 3 | `hintsFor(mode)` contextual keys |
| `tests/ui` footer tests | 3 | Mode hint strings |
| `src/ui/Splash.tsx` | 4 | Brand splash while scanning |
| `tests/ui.splash.test.tsx` | 4 | Splash render + dwell contract helpers |
| `src/ui/Home.tsx` | 5 | One-CTA home screen |
| `tests/ui.home.test.tsx` | 5 | Empty vs recommended menus |
| `src/ui/List.tsx` | 6 | Status line helper; full-width default |
| `src/ui/Detail.tsx` | 6 | Unchanged API; consumed only from detail mode |
| `src/ui/App.tsx` | 7 | Mode shell wiring Splash/Home/Triage/Detail/Confirm/Done |
| `tests/ui.app.test.tsx` | 7–8 | Session flows |
| `README.md` / `CHANGELOG.md` | 9 | Document the new session |

---

### Task 1: Cursor seed — largest reclaimable

**Files:**
- Modify: `src/ui/model.ts`
- Modify: `tests/ui.model.test.ts`

**Interfaces:**
- Consumes: `Row`, `Selection`, `isSelectable`, `isSelected`, `defaultSelection`
- Produces: `firstReclaimableId(rows, selection): string | undefined`

- [ ] **Step 1: Write the failing test**

Add to `tests/ui.model.test.ts`:

```ts
import { buildRows, defaultSelection, firstReclaimableId } from '../src/ui/model.js';

it('firstReclaimableId prefers the largest selected reclaimable row', () => {
  const rows = buildRows({
    projects: [/* dormant 100M, dormant 2G, active 500M — use existing fixtures in this file */],
    caches: [],
    categories: new Set(['build', 'cache']),
  });
  const selection = defaultSelection(rows);
  const id = firstReclaimableId(rows, selection);
  expect(id).toBe(/* id of the 2G dormant project */);
});

it('firstReclaimableId falls back to largest selectable when nothing is selected', () => {
  const rows = buildRows({ /* same */ projects: [...], caches: [], categories: ... });
  const id = firstReclaimableId(rows, { projects: new Set(), caches: new Set() });
  expect(id).toBe(/* largest selectable, including active if that is largest */);
});
```

Use the file’s existing project factories; do not invent a second fixture style.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui.model.test.ts -t firstReclaimableId`  
Expected: FAIL — `firstReclaimableId` is not exported.

- [ ] **Step 3: Implement**

In `src/ui/model.ts`, next to `firstSelectableId`:

```ts
/**
 * Cursor seed for Triage/Home: the largest selected reclaimable row, else the largest
 * selectable row. Headers and blocked rows are never candidates.
 */
export function firstReclaimableId(
  rows: readonly Row[],
  selection: Selection,
): string | undefined {
  const selected = rows.filter(
    (row) => isSelectable(row) && isSelected(selection, row),
  );
  const pool = selected.length > 0 ? selected : rows.filter(isSelectable);
  if (pool.length === 0) return undefined;
  return pool.reduce((best, row) => (row.bytes > best.bytes ? row : best)).id;
}
```

Keep `firstSelectableId` for any caller that still wants “first in list order”.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/ui.model.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/model.ts tests/ui.model.test.ts
git commit -m "$(cat <<'EOF'
feat(ui): seed cursor on largest reclaimable row

Triage and Home should land attention on the bytes the user came for,
not whatever happens to sort first in section order.
EOF
)"
```

---

### Task 2: Brand face — splash title letters

**Files:**
- Modify: `src/ui/Banner.tsx` (`PIXELS` / `bigText` already used by `Logo`)
- Optionally extend: `src/ui/glyphs.ts` if Splash will also need the 5-row `bigTextLines` face for a tall title — prefer **one** face. Spec: Splash uses the same system as `Logo` (`bigText` 2-row half-block) for `DEV-CLEANER`, stacked as two words if width requires.
- Modify: `tests/ui.banner.test.tsx`

**Interfaces:**
- Consumes: `bigText`, `LOGO_TEXT`, `WORDMARK`, `Logo`
- Produces: `splashTitle(width): { lines: string[]; degraded: boolean }` exported from `Banner.tsx`

- [ ] **Step 1: Write the failing test**

```ts
import { splashTitle, LOGO_TEXT, WORDMARK, bigText } from '../src/ui/Banner.js';

it('splashTitle returns the block face when width allows', () => {
  const [top] = bigText(LOGO_TEXT);
  const result = splashTitle(top.length + 4);
  expect(result.degraded).toBe(false);
  expect(result.lines.join('\n')).toContain(top);
});

it('splashTitle degrades to WORDMARK when too narrow', () => {
  const result = splashTitle(10);
  expect(result.degraded).toBe(true);
  expect(result.lines).toEqual([WORDMARK.slice(0, 10)]); // or truncated WORDMARK
});
```

- [ ] **Step 2: Run — expect FAIL** (`splashTitle` missing)

- [ ] **Step 3: Implement `splashTitle`**

```ts
export function splashTitle(width: number): { lines: string[]; degraded: boolean } {
  const [top, bottom] = bigText(LOGO_TEXT);
  if (top.length <= width) {
    return { lines: [top, bottom], degraded: false };
  }
  // Try stacking DEV / CLEANER if both fit.
  const [d0, d1] = bigText('DEV');
  const [c0, c1] = bigText('CLEANER');
  if (Math.max(d0.length, c0.length) <= width) {
    return { lines: [d0, d1, '', c0, c1], degraded: false };
  }
  return { lines: [truncateLabel(WORDMARK, Math.max(0, width))], degraded: true };
}
```

Ensure `PIXELS` already contains every letter in `DEV-CLEANER` (it does today). If stacking introduces letters already present, no table change.

- [ ] **Step 4: Run `npx vitest run tests/ui.banner.test.tsx` — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/ui/Banner.tsx tests/ui.banner.test.tsx
git commit -m "$(cat <<'EOF'
feat(ui): splashTitle helper for pixel brand entry

One glyph face for splash, reclaim hero, and done — degrade to the
compact wordmark when the terminal is too narrow.
EOF
)"
```

---

### Task 3: Contextual footer hints

**Files:**
- Modify: `src/ui/Footer.tsx`
- Create or extend: `tests/ui.footer.test.ts` (new file if none exists; today hints are only asserted via `ui.app.test.tsx`)

**Interfaces:**
- Consumes: mode kind strings
- Produces:

```ts
export type HintMode =
  | 'home'
  | 'triage'
  | 'detail'
  | 'confirm'
  | 'done'
  | 'trash-confirm'
  | 'screening'
  | 'cleaning';

export function hintsFor(mode: HintMode): string;
```

Keep `KEY_HINTS` as an alias of `hintsFor('triage')` temporarily so old imports compile, or update all call sites in the same task.

- [ ] **Step 1: Failing tests**

```ts
import { hintsFor } from '../src/ui/Footer.js';

it('home promotes enter reclaim and browse', () => {
  expect(hintsFor('home')).toMatch(/enter/);
  expect(hintsFor('home')).toMatch(/b /);
  expect(hintsFor('home')).not.toMatch(/j\/k/);
});

it('triage keeps list keys and esc home', () => {
  const h = hintsFor('triage');
  expect(h).toMatch(/space/);
  expect(h).toMatch(/esc home/);
  expect(h).toMatch(/d detail/);
});

it('confirm is only enter/esc', () => {
  expect(hintsFor('confirm')).toMatch(/enter confirm/);
  expect(hintsFor('confirm')).toMatch(/esc/);
});
```

Exact strings — pick once and lock them here:

| Mode | Hints string |
| --- | --- |
| `home` | `enter reclaim · b browse · p preset · t Trash · q quit` |
| `triage` | `space toggle · a section · j/k move · d detail · p preset · enter clean · esc home · t Trash · q quit` |
| `detail` | `esc back · q quit` |
| `confirm` | `enter confirm · esc back · q quit` |
| `done` | `esc home · t Trash · q quit` |
| `trash-confirm` | keep existing Trash confirm copy behaviour (typed EMPTY) — footer may be empty or `esc cancel · q quit` |
| `screening` | `esc cancel · q quit` |
| `cleaning` | (empty or `cleaning…`) |

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `hintsFor` + update `Footer` to take `hints: string` (or `mode`)**

Prefer:

```ts
export interface FooterProps {
  hints: string;
  session?: string | undefined;
  message?: string | undefined;
  width: number;
}
```

Callers pass `hintsFor(mode)`. Remove the hardcoded `KEY_HINTS` constant usage inside `Footer`.

- [ ] **Step 4: Fix any broken app tests that import `KEY_HINTS` — re-export `hintsFor('triage')` as `KEY_HINTS` if needed for one release of test churn, or update assertions.**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(ui): mode-keyed footer hints

Only show keys that work on the current screen; promote the primary
action so the footer stops reading as decoration.
EOF
)"
```

---

### Task 4: `Splash` component

**Files:**
- Create: `src/ui/Splash.tsx`
- Create: `tests/ui.splash.test.tsx`

**Interfaces:**
- Consumes: `splashTitle`, `useSpinner` / `SPINNER_FRAMES`, `formatBytes` (optional count line)
- Produces:

```ts
export const SPLASH_MIN_DWELL_MS = 400;

export interface SplashProps {
  width: number;
  height: number;
  scanning: boolean;
  rootsLabel: string; // e.g. "~/develop" or joined roots
  projects: number;
  caches: number;
  bytes: number; // running total of discovered reclaimable under default categories — display only
}

export function Splash(props: SplashProps): React.ReactElement;

/** Pure: may leave splash when dwell elapsed AND (scan done OR recommendedBytes > 0 OR scanning stalled with rows). */
export function splashReady(input: {
  dwellElapsedMs: number;
  scanning: boolean;
  recommendedBytes: number;
  hasAnyRow: boolean;
}): boolean;
```

- [ ] **Step 1: Tests for `splashReady` and render**

```ts
it('splashReady waits for min dwell', () => {
  expect(splashReady({
    dwellElapsedMs: 100,
    scanning: false,
    recommendedBytes: 1_000_000,
    hasAnyRow: true,
  })).toBe(false);
});

it('splashReady after dwell when recommended bytes exist', () => {
  expect(splashReady({
    dwellElapsedMs: 400,
    scanning: true,
    recommendedBytes: 1_000_000,
    hasAnyRow: true,
  })).toBe(true);
});

it('splashReady after dwell when scan finished even if zero reclaim', () => {
  expect(splashReady({
    dwellElapsedMs: 400,
    scanning: false,
    recommendedBytes: 0,
    hasAnyRow: false,
  })).toBe(true);
});
```

Render test: `render(<Splash … />)` contains block title or WORDMARK and `scanning` / purpose line `reclaim regenerable build output`.

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement `Splash.tsx`** — center title vertically within `height`, purpose line, scan status line. Must not exceed `height` lines (pad/truncate). No footer of its own; App may omit Footer on splash.

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "$(cat <<'EOF'
feat(ui): Splash brand screen while the scan starts

Pixel title with a minimum dwell, then hand off once an honest
recommended total (or scan completion) exists.
EOF
)"
```

---

### Task 5: `Home` component

**Files:**
- Create: `src/ui/Home.tsx`
- Create: `tests/ui.home.test.tsx`

**Interfaces:**

```ts
export interface HomeProps {
  width: number;
  height: number;
  rootsLabel: string;
  scanning: boolean;
  recommendedCount: number;
  recommendedBytes: number;
  dormantCount: number;
  activeCount: number;
  cacheCount: number;
  disk?: DiskUsage | undefined;
  session?: string | undefined; // prior rounds ledger, optional
}

export function Home(props: HomeProps): React.ReactElement;
```

Layout per spec: compact mark, hero `Headline` (or `bigText` of recommended bytes), caption with counts + disk, action box:

- If `recommendedCount > 0`: show `enter  trash the recommended N items · XG`
- Always: `b browse & adjust`, `t Trash` (caller may hide if Trash unwired), `q quit`
- If `recommendedCount === 0`: **do not** show enter reclaim; show a plain “nothing recommended” line

- [ ] **Step 1: Tests**

```ts
it('offers enter reclaim when recommendedCount > 0', () => {
  const { lastFrame } = render(<Home … recommendedCount={4} recommendedBytes={1.9e9} />);
  expect(lastFrame()).toMatch(/enter/);
  expect(lastFrame()).toMatch(/recommended/);
});

it('hides enter reclaim when nothing is recommended', () => {
  const { lastFrame } = render(<Home … recommendedCount={0} recommendedBytes={0} />);
  expect(lastFrame()).not.toMatch(/trash the recommended/);
  expect(lastFrame()).toMatch(/browse/);
});
```

- [ ] **Step 2–4: FAIL → implement → PASS → commit**

```bash
git commit -m "$(cat <<'EOF'
feat(ui): Home screen with one reclaim CTA

Default post-splash surface: trash the recommended set, or press b
to browse. Never offer enter when the recommended set is empty.
EOF
)"
```

---

### Task 6: Triage list — status line, no always-on Detail

**Files:**
- Modify: `src/ui/List.tsx` — add `statusLine(row, categories, width): string` helper (pure, exported)
- Modify: `tests/ui.list.test.tsx`
- `Detail.tsx` — no API change

**Interfaces:**

```ts
export function statusLine(
  row: Row | undefined,
  categories: ReadonlySet<Category>,
  width: number,
): string;
```

Format: `▸ name · chip chips · primaryArtifact relPath bytes` truncated to `width`. Empty string if no row (still one blank line in App for height stability).

- [ ] **Step 1: Unit tests for `statusLine`**

- [ ] **Step 2–4: Implement + PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(ui): triage status line for the focused row

Lazygit-style context under the full-width list so Detail can leave
the default frame.
EOF
)"
```

Note: App still shows Detail until Task 7; this task only adds the helper and tests.

---

### Task 7: App mode shell

**Files:**
- Modify: `src/ui/App.tsx` (large — work carefully)
- Modify: `tests/ui.app.test.tsx`

**Mode type** (inside `App.tsx`):

```ts
type Mode =
  | { kind: 'splash' }
  | { kind: 'home' }
  | { kind: 'triage' }
  | { kind: 'detail' }
  | { kind: 'screening'; candidate: Candidate; provisional: readonly BlockedEntry[] }
  | { kind: 'confirm'; snapshot: ConfirmSnapshot }
  | { kind: 'cleaning'; snapshot: ConfirmSnapshot }
  | { kind: 'done'; report: RoundReport }
  | { kind: 'trash-reading' }
  | { kind: 'trash-confirm'; summary: TrashSummary; typed: string }
  | { kind: 'trash-result'; ok: boolean; detail: string | undefined; summary: TrashSummary | undefined };
```

Rename today’s `phase: { kind: 'list' | 'result' | … }` accordingly (`list` → start at `splash` then `home`/`triage`; `result` → `done`).

**Behaviour checklist (must have tests):**

1. Mount starts in `splash`. After `splashReady`, transition to `home`.
2. Home `enter` with `recommendedCount > 0` starts the same screening path as today’s list Enter (build candidate from `defaultSelection` / current selection that matches recommended).
3. Home `enter` with `recommendedCount === 0` is ignored (or shows message) — never Confirm of zero.
4. Home `b` → `triage`. Triage `esc` → `home`.
5. Triage default frame: **List full width** + status line + Footer — **no Detail sibling**.
6. Triage `d` → `detail` full screen; `esc` → `triage`.
7. Triage cursor initialized with `firstReclaimableId(rows, selection)`.
8. Triage `enter` → screening/confirm as today.
9. Done `esc` → `home` (not quit). `q` quits from Done.
10. Footer uses `hintsFor(mode)`.
11. `frameBudget` still holds; splash/home/done must also fit in `rows - 1`.

**Recommended selection on Home:** compute via existing `buildRows` + `defaultSelection` + `selectedBytes` / `selectedCount` from session projects/caches and current preset categories — same as Triage defaults at first paint. As scan progresses, Home numbers update.

**Splash dwell:** `useRef(Date.now())` on mount; `useEffect` interval or check on each render/stream event calling `splashReady`.

- [ ] **Step 1: Add focused failing tests at the top of a new describe in `ui.app.test.tsx`** for flows 1–6 before rewriting App (or add tests then implement until green). Prefer writing 2–3 critical flow tests first:

```ts
describe('session modes', () => {
  it('shows splash then home, and enter opens confirm for recommended', async () => { … });
  it('b opens triage without a detail pane', async () => { … });
  it('d opens detail and esc returns to triage', async () => { … });
});
```

Use the existing stream helpers / `render` / `stdin` patterns already in `ui.app.test.tsx`. Assert **absence** of a known Detail-only string (e.g. a `LABEL_HELP` sentence) on the triage frame, and **presence** after `d`.

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Implement mode shell in `App.tsx`**

Practical approach:

1. Rename `phase` → `mode` and update the union.
2. Initial state `{ kind: 'splash' }`; on ready set `{ kind: 'home' }`.
3. Split render into `switch (mode.kind)` branches: Splash / Home / Triage(+footer) / Detail / existing Confirm/Round/Trash screens.
4. Update `useInput` to branch on mode (Home keys vs Triage keys vs …).
5. Remove the two-pane flex that mounts `List` + `Detail` side by side.

Keep `onScreen` / `onClean` / Trash / disk wiring identical.

- [ ] **Step 4: Fix the full `ui.app.test.tsx` suite** — many tests assume immediate list visibility. Update them to:

- wait for Home (or send `b` to enter Triage), **or**
- accept Splash→Home then interact.

Do not weaken screening/confirm tests.

- [ ] **Step 5: Run full UI tests**

Run: `npx vitest run tests/ui.app.test.tsx tests/ui.home.test.tsx tests/ui.splash.test.tsx tests/ui.list.test.tsx tests/ui.model.test.ts tests/ui.banner.test.tsx`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(ui): Splash → Home → Triage mode shell

Replace the two-pane workspace with the approved session model:
brand entry, one reclaim CTA, lazygit-style full-width triage, and
detail on demand.
EOF
)"
```

---

### Task 8: Regression + e2e + CLI smoke

**Files:**
- Modify if needed: `tests/e2e.test.ts`, `tests/cli.wiring.test.ts`, `tests/ui.*.test.tsx`
- No CLI behaviour change expected except interactive path.

- [ ] **Step 1: Run full suite**

Run: `npm test`  
Expected: PASS. Fix any failures without changing safety modules unless a test was coupled to old chrome strings.

- [ ] **Step 2: Manual smoke (local)**

```bash
npm run build
node dist/cli.js --help
# In a real TTY:
node dist/cli.js ~/develop
# Piped still report-only:
node dist/cli.js ~/develop | head
```

Confirm: splash appears, Home CTA works, `b` triage, pipe deletes nothing.

- [ ] **Step 3: Commit fixes if any**

```bash
git commit -m "$(cat <<'EOF'
test(ui): align suite with session mode shell

Keep screening and non-TTY guarantees green after the TUI reshape.
EOF
)"
```

---

### Task 9: Docs

**Files:**
- Modify: `README.md` — replace the “interface” ASCII frame with Home + Triage sketches from the spec/storyboard
- Modify: `CHANGELOG.md` — under Unreleased / next version: TUI session redesign (minor)
- Modify: `docs/superpowers/specs/2026-07-25-dev-cleaner-design.md` — mark UI section superseded by `2026-07-29-tui-session-redesign.md` (one paragraph pointer; do not rewrite the whole historical spec)
- Optionally keep `docs/unknowns/05-brainstorm-intervention.md` as historical

- [ ] **Step 1: Edit README interface section** to show Splash/Home/Triage briefly; keep safety and pipe-first docs intact.

- [ ] **Step 2: CHANGELOG entry**

```md
### Changed
- Interactive session is now Splash → Home → Triage → Confirm → Done (lazygit-style
  full-width triage; detail on demand). Same safety model and non-TTY report.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md docs/superpowers/specs/2026-07-25-dev-cleaner-design.md
git commit -m "$(cat <<'EOF'
docs: describe Splash → Home → Triage session

Point the original design UI section at the 2026-07-29 redesign spec.
EOF
)"
```

---

## Spec coverage check

| Spec requirement | Task |
| --- | --- |
| Splash brand + min dwell + handoff | 2, 4, 7 |
| Home one CTA / no enter when empty | 5, 7 |
| Full-width triage, no always-on Detail | 6, 7 |
| Detail on `d` full-screen | 7 |
| Contextual hints | 3, 7 |
| Cursor on largest reclaimable | 1, 7 |
| Confirm/Done/Trash seams unchanged | 7, 8 |
| Ink only / no new deps | Global |
| Non-TTY unchanged | 8 |
| `/` filter deferred | Global (out of plan) |

## Placeholder scan

None intentional. Implementers must use existing factories in `tests/ui.model.test.ts` / `ui.app.test.tsx` rather than the commented placeholders in Task 1’s sketch — replace comments with real fixtures from those files when coding.

---

## Execution

Plan saved to `docs/superpowers/plans/2026-07-29-tui-session-redesign.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
