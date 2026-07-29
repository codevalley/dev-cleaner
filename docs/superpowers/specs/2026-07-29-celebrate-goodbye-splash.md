# Celebrate → Home loop + branded goodbye (+ splash)

**Date:** 2026-07-29  
**Status:** Approved (chat) — implement on `feat/tui-session-redesign`  
**Extends:** `2026-07-29-tui-session-redesign.md`

---

## Problem

1. After clean, the Done pane is underwhelming: celebration only activates at ≥1 GiB, so ~1G rounds show plain “Moved …” with no figure. The loop back to triage/Home is `esc` on a separate screen rather than the familiar Home menu.
2. Quit appends a thin closing line into scrollback — no brand moment, easy to miss.
3. Splash pixel titling exists but is easy to miss: **400 ms** min dwell, then leave as soon as rows exist; half-block `DEV-CLEANER` also reads differently from the solid face used for reclaim figures.

## Goals

1. **Cleaning delight** — alive cleaning screen (spinner + solid figure + light rule).
2. **Celebrate beat** — after clean, full-screen celebrate with solid figure (any positive reclaim), Trash CTA, **press any key to continue** (no auto-advance). `t` opens empty-Trash; `q` quits.
3. **Home loop** — any other key → Home (browse / empty Trash / quit) so multi-round sessions feel continuous.
4. **Branded goodbye** — after Ink unmounts, printed closing block with wordmark, recall line, Trash caveat (or emptied confirmation). Quiet if nothing cleaned.
5. **Splash that lands** — longer min dwell; prefer solid five-row title when height allows; keep purpose + scan pulse.

## Non-goals

- New runtime deps / leaving Ink.
- Changing clean, screening, or safety.
- Auto-advance celebrate timers.
- Changing non-TTY report behaviour.

---

## Session flow (updated)

```
Splash → Home ⇄ Triage → Confirm → Cleaning → Celebrate
              ▲                                      │
              └──────── any key (not t/q) ───────────┘
                         t → Trash flow → Home
                         q → exit → branded goodbye
```

`done` / `RoundSummary` as the primary post-clean surface is replaced by **Celebrate → Home**. RoundSummary helpers (`celebrationFor`, problem list) may still feed Celebrate content.

---

## Mode: Celebrate

**Layout (Splash energy, centered):**

- Solid five-row figure for `reclaimedBytes` when > 0 and width allows; else plain bold digits.
- Green: `Moved {bytes} to the Trash.`
- Dim counts: `N directories trashed` (+ refused/failed if any).
- Optional short phrase from lowered celebration tiers (see below).
- Problems list if any (budgeted).
- Boxed: `t empty the Trash — the space is not free until you do` when `canEmptyTrash`.
- Dim: `press any key to continue`.

**Keys:**

| Key | Action |
| --- | --- |
| `t` | Empty-Trash flow; `returnTo` = home |
| `q` / Ctrl-C | Quit |
| any other | → Home |

**Celebration tiers** (replace ≥1 GiB-only gate):

| Min bytes | Phrase / decoration |
| --- | --- |
| > 0 | figure + “Nice catch.” (or equivalent short line) |
| ≥ 100 MiB | figure + “A good round.” |
| ≥ 1 GiB | figure + “A big round.” + sparks |
| ≥ 10 GiB | figure + “An enormous round.” + rule |
| ≥ 100 GiB | figure + enormous + rule + triple sparks |

Zero trashed: no figure; yellow “Nothing was moved…”; still any-key → Home.

---

## Mode: Cleaning

- Prefer solid figure (same as Home) for snapshot bytes.
- Keep Logo when height allows.
- Spinner on `moving to the Trash…`.
- Optional thin green rule under figure.
- Input still blocked until clean completes.

---

## Splash fixes

1. Raise `SPLASH_MIN_DWELL_MS` to **1200** so the mark is perceptible even when the scan is fast.
2. When height ≥ ~9 and width fits, render splash title with **solid five-row** glyphs for `DEV-CLEANER` (or stacked `DEV` / `CLEANER`); else keep existing two-row half-block; last resort compact `WORDMARK`.
3. Never drop the title to zero lines while height can hold purpose+status+at least one title row.
4. `splashReady` unchanged logically: dwell first, then leave when scan done / recommended / rows.

---

## Goodbye (`renderClosingLine`)

When `summary.cleaned` and `trashedBytes > 0`:

```
  [solid figure rows if they fit]

  ▓▒░ dev-cleaner
  Reclaimed {bytes} across {N} round(s) · regenerable build output, off your disk's critical path.
  Trashed files still occupy the disk until you empty the Trash.
```

If `trashEmptied`: replace caveat with `The Trash was emptied — that space is back.`

If nothing cleaned: return `''` (unchanged quiet viewer).

Prefer solid `bigBytes` over half-block; fall back to plain wordmark + prose if width is tight.

---

## Home after celebrate

Unchanged Home menu. Session ledger reflects the round. **Focus lands on browse** (not reclaim) so a held enter from Confirm cannot chain celebrate → reclaim → clean. User arrows up for another reclaim.
---

## Tests

- `celebrationFor` / Celebrate: figure for sub-GiB; any-key → home; `t` → trash path.
- Cleaning still blocks keys mid-clean.
- Splash dwell 1200; solid title when height/width allow.
- `renderClosingLine` brand + recall + caveat; quiet when uncleaned.
- App session loop: confirm → clean → celebrate → key → home → browse.

## Out of scope leftovers

- Auto-skip celebrate.
- Animating glyph morphs beyond spinner / rule.
