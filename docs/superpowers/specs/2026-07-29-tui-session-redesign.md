# dev-cleaner — TUI session redesign

**Date:** 2026-07-29  
**Status:** Draft — awaiting approval  
**Supersedes:** the “User interface” section of `2026-07-25-dev-cleaner-design.md` (two-pane Ink workspace). All other sections of that spec (discovery, safety, clean, caches, degradation) remain in force.

**Companion:** interactive storyboard at  
`~/.cursor/projects/Users-nyn-develop-dev-cleaner/canvases/tui-ux-direction.canvas.tsx`

---

## Problem

The safety engine, selection policy, and screening are strong. The interactive session is not: it opens into a crowded two-pane utility (narrow list + always-on essay detail + a footer that dumps every key). That reads as dense and unintuitive. Users who like tools such as lazygit expect a focused primary surface and detail on demand — not an IDE-style split from the first frame.

## Goals

1. **Brand-first entry** — a pixel/block splash while the scan starts, using one glyph face shared with reclaim numbers.
2. **Home as the default** — one clear reclaim action on the recommended selection; browsing is opt-in.
3. **Lazygit-style triage** — full-width list, focused-row status line, detail on demand (`d`), contextual keys.
4. **Distinct modes** — Splash → Home → Triage → Confirm → Done, each with its own layout and primary action.
5. **Stay on Ink** — no OpenTUI, no new runtime deps beyond `ink` / `react` / `trash`.
6. **Keep the sacred core** — `model.ts`, discovery, `clean.ts`, screening, Trash semantics, non-TTY report unchanged in behaviour.

## Non-goals

- Migrating off Ink / Node.
- Multi-panel tiling (lazygit’s multi-pane layout is explicitly not the target).
- `--yes` / non-interactive clean (still deferred).
- Changing safety invariants, allowlist, or screening tiers.
- Redesigning the piped static report beyond staying consistent with the same selection/labels policy.

---

## Session model

```
                 scan stream
                     │
                     ▼
              ┌─────────────┐
              │   Splash    │  brand + “scanning…”
              └──────┬──────┘
                     │ enough data for an honest recommended total
                     ▼
              ┌─────────────┐
         ┌───►│    Home     │◄──────────────────┐
         │    └──────┬──────┘                   │
         │           │ enter (recommended)      │
         │           │ b (browse)               │
         │           ▼                          │
         │    ┌─────────────┐                   │
         │    │   Triage    │◄── esc from       │
         │    └──────┬──────┘    Confirm        │
         │           │ enter                    │
         │           ▼                          │
         │    ┌─────────────┐                   │
         │    │   Confirm   │                   │
         │    └──────┬──────┘                   │
         │           │ enter (clean)            │
         │           ▼                          │
         │    ┌─────────────┐                   │
         │    │    Done     │── esc / reclaim ──┘
         │    └──────┬──────┘
         │           │ t → Trash confirm (existing flow)
         │           │ q → exit
         └───────────┘
```

`App.tsx` already has a `Phase` union and multi-round `applyRound`. This redesign makes phases **named modes with different layouts**, not overlays on one workspace chrome.

### Mode contracts

| Mode | Primary question | Primary key | Chrome |
| --- | --- | --- | --- |
| **Splash** | “Who is this / is it working?” | (none — waits) | Tall wordmark, one purpose line, scan pulse |
| **Home** | “Trash the recommended set?” | `enter` | Hero reclaim figure, short menu |
| **Triage** | “Adjust what is selected?” | `space` / `enter` | Full-width list + status line + contextual footer |
| **Confirm** | “Really move these?” | `enter` | Question + block figure + will-move / blocked lists |
| **Done** | “What next?” | `esc` home / `t` Trash / `q` quit | Same figure face, session ledger, Trash offer |

---

## Branding

One glyph system (extend `src/ui/glyphs.ts` / `Banner.tsx` as needed):

1. **Splash title** — tall block/pixel `DEV-CLEANER` (or `DEV` + `CLEANER` stacked if width demands). Degrades to compact `▓▒░ DEV-CLEANER` when the terminal is too narrow.
2. **Reclaim / Done figure** — same face as today’s `bigText` / `bigBytes` for the byte total.
3. **Chrome mark** — compact `▓▒░ DEV-CLEANER` on Home / Triage / Confirm / Done after splash.

Splash may show a light scanning animation (reuse `ScanStatus` spinner vocabulary). It must not block reclaim: as soon as the recommended selection has a stable enough total to show honestly, transition to Home. Progressive scan may continue updating Home’s number and counts after arrival.

Colour remains non-carrier (existing rule): glyphs and words must read without colour.

---

## Home

Home is the **default post-splash screen**, not Triage.

Contents (top → bottom):

1. Compact mark + ready/scanning status + root label.
2. Hero reclaim figure (recommended selection bytes) + short caption (counts + disk free).
3. Action menu:
   - `enter` — trash the recommended N items · XG (runs existing `onScreen` → Confirm path).
   - `b` — browse & adjust (→ Triage).
   - `t` — Trash (existing Trash flow), when wired.
   - `q` — quit.

If the recommended selection is empty (everything active/blocked, or nothing found), Home states that plainly and offers `b` / `q` — never an `enter` that would clean zero targets under a celebratory number.

Preset cycling (`p`) remains available on Home and Triage; changing preset recomputes selection from the already-scanned widest category set (existing rule).

---

## Triage (lazygit-style)

### Layout

```
┌─ mark · triage ────────────────── reclaim XX ─┐
│ disk gauge (one line)                         │
│                                               │
│ SECTION …                                     │
│ ▸◉ row …                                      │  ← full width
│  ◉ row …                                      │
│ …                                             │
│                                               │
│ ▸ name · chips · primary artifact summary     │  ← status line (focused row)
│ space · enter · d detail · / filter · esc home│  ← contextual footer
└───────────────────────────────────────────────┘
```

- **No always-on right pane.** Detail is either the one-line status under the list, or a full Detail view on `d` (esc returns to Triage).
- **Chip sacrifice** (`List.tsx` `chipPlan`) becomes far less necessary at full width; keep the planner for narrow terminals.
- **Cursor seed:** first focus lands on the largest selectable reclaimable row in the default-selected set (or largest selectable if none selected).
- **Keys (Triage):** existing list keys (`j/k`, `space`, `a`, `p`, `enter`, `t`, `q`) plus `d` detail, `esc` → Home, optional `/` filter (can ship in a follow-up if it threatens scope).

Blocked rows stay listed with `[-]` reasons (existing screening); they are not selectable and not in the reclaim total.

---

## Confirm and Done

**Confirm** keeps the current “looks like a question” structure (`Confirm.tsx`): question → block figure → framed choice → will-move / blocked. Entry points:

- Home `enter` (recommended snapshot), or
- Triage `enter` (current selection snapshot).

Same screening (`onScreen` cheap→full), same frozen `ConfirmSnapshot`, same arrival disclosure if the scan is still running.

**Done** is today’s round summary (`Round.tsx`) promoted to a named mode: same glyph face, Trash offer, `esc` → Home (not quit), `q` quits. Closing stdout line after final quit unchanged (`renderClosingLine`).

---

## Architecture (UI only)

```
src/ui/model.ts      — unchanged contracts (rows, selection, toTargets, applyRound)
src/ui/viewport.ts   — list windowing (Triage)
src/ui/glyphs.ts     — shared face (+ any letters splash needs)
src/ui/Banner.tsx    — Headline / Logo / WORDMARK
src/ui/Splash.tsx    — NEW
src/ui/Home.tsx      — NEW
src/ui/List.tsx      — full-width triage list
src/ui/Detail.tsx    — on-demand only
src/ui/Confirm.tsx   — keep, minor chrome alignment
src/ui/Round.tsx     — Done mode
src/ui/Footer.tsx    — hints keyed by mode
src/ui/App.tsx       — mode shell + scan stream + key routing
```

`cli.ts` wiring (`onScreen`, `onClean`, Trash, disk) stays. Non-TTY still calls `renderScreenedReport` and never mounts Ink.

### Mode state

Replace the overloaded “list with overlays” mental model with an explicit mode:

```ts
type Mode =
  | { kind: 'splash' }
  | { kind: 'home' }
  | { kind: 'triage' }
  | { kind: 'detail'; returnTo: 'triage' }  // optional nested
  | { kind: 'screening'; … }               // existing
  | { kind: 'confirm'; … }
  | { kind: 'cleaning'; … }
  | { kind: 'done'; … }                   // was result
  | { kind: 'trash-confirm' | 'trash-reading' | 'trash-result'; … };
```

Frame height budget (`rows - 1`) and pinned footer arithmetic remain mandatory (Ink scroll bug).

---

## Testing

- Keep fixture/unit coverage for `model.ts`, clean, report.
- Extend Ink tests (`ink-testing-library`):
  - Splash → Home transition when recommended total becomes available.
  - Home `enter` builds the same targets as Triage default selection.
  - Home empty-recommended does not offer a false confirm.
  - Triage is single-pane (no Detail sibling in the default frame).
  - `d` / `esc` round-trip Detail.
  - Contextual footer strings per mode.
  - Existing Confirm / screening / applyRound / Trash tests still pass.
- E2E: one interactive path Home→Confirm→Done and one Triage→Confirm path (deps-injected as today).

---

## Rollout / sequencing

Ship as one UX release (minor bump per `docs/VERSIONING.md` — presentation change, not safety). Suggested implementation order:

1. Mode shell + Splash + Home (still behind full-width triage that reuses List without Detail).
2. Remove always-on Detail; add status line + `d`.
3. Contextual footer + chrome quieting + cursor seed.
4. Polish: splash glyph completeness, motion, Done/Home loop copy.

Static report and CLI flags unchanged.

---

## Open points (decide during planning if needed)

1. **Splash duration:** transition on “recommended total available” vs fixed minimum dwell (e.g. 400ms) so the brand is perceptible on tiny trees.
2. **Filter `/`:** in v1 of this redesign or immediate follow-up.
3. **Detail as overlay vs full-screen mode:** prefer full-screen mode for height-budget honesty; overlay only if it never grows the frame.

Default proposals unless overruled: (1) min dwell 400ms or until recommended ready, whichever later; (2) filter follow-up; (3) full-screen Detail mode.
