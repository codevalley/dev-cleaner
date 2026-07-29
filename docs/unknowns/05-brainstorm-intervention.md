# Brainstorm: TUI UX / presentation

**Problem:** The interactive presentation feels dense and unintuitive. The deeper issue is **UX** (session shape), not only **UI** paint.

**Searched:** `src/ui/*`, `docs/CONTRIBUTING.md` dependency freeze, original two-pane contract in `docs/superpowers/specs/2026-07-25-dev-cleaner-design.md`.

---

## Decisions locked (2026-07-29)

- **OpenTUI: out.** Stay on Ink + React.
- **Interaction model: lazygit-style.** Full-width triage, detail on demand, distinct modes.
- **Branding: yes.** Pixel/block splash on start; same face for reclaim hero + Done; compact `▓▒░` mark in chrome.
- **Visual direction:** interactive storyboard canvas — Splash → Home → Triage → Confirm → Done.

OpenTUI / new-renderer XL bets are **withdrawn**.

---

## S — ship this afternoon

- [ ] **[S] Collapse the always-on detail essay (*UI*)** — Detail on demand (`d`) or a short sticky summary so the list gets ~2× width. *Grounded in:* `src/ui/Detail.tsx`, `src/ui/App.tsx`. *Impact:* every interactive session (estimate). *Scope:* Reshape `Detail` + `App` layout budget.

- [ ] **[S] Contextual key hints (*UX*)** — Show only keys valid in the current `phase`; promote the primary action. *Grounded in:* `src/ui/Footer.tsx` (`KEY_HINTS`), `src/ui/App.tsx` `Phase` union. *Impact:* new users stop skipping the footer dump (estimate). *Scope:* Hint table keyed by `phase.kind`.

- [ ] **[S] Land cursor on biggest reclaimable (*UX*)** — Focus the top selected/selectable reclaimable row; weight it visually. *Grounded in:* `src/ui/model.ts` `buildRows`, `firstSelectableId`. *Impact:* first keystrokes match the hero number (estimate). *Scope:* Cursor seed + list emphasis.

- [ ] **[S] Quiet the chrome (*UI*)** — One hero number; demote competing headlines to one secondary line. *Grounded in:* `src/ui/Banner.tsx`, `src/ui/Gauge.tsx`, `src/ui/ScanStatus.tsx`. *Impact:* first-viewport readability (estimate). *Scope:* Layout/copy only.

---

## M — medium-term (days)

- [ ] **[M] Single-pane triage list (*UX*)** — Full-width list; detail as status line / `d` screen. Lazygit focus, not IDE panes. *Grounded in:* design spec two-pane contract; `src/ui/List.tsx` `chipPlan` (pane already too narrow). *Impact:* structural readability (estimate). *Scope:* New layout in `App`/`List`; keep `model.ts`.

- [ ] **[M] Home / Quick reclaim (*UX*)** — After scan: “Trash recommended N · XG” in ≤2 keys; `b` enters triage. *Grounded in:* `src/ui/model.ts` `defaultSelection`; `src/ui/Confirm.tsx`. *Impact:* common recommended-preset path (estimate). *Scope:* New home phase; reuse `onScreen` path.

- [ ] **[M] Pixel splash + brand face (*UI*)** — Tall title while scanning; same glyphs for Home/Done numbers; compact mark in chrome. *Grounded in:* `src/ui/glyphs.ts`, `src/ui/Banner.tsx`, `src/ui/ScanStatus.tsx`. *Impact:* brand beat, no new deps (estimate). *Scope:* Splash phase; extend glyph table if needed.

- [ ] **[M] Ink visual refresh (*UI*)** — Motion, hierarchy, less chrome, stronger selection — still Ink. *Grounded in:* `docs/CONTRIBUTING.md` three-dep freeze; `ScanStatus.tsx` motion. *Impact:* engaging feel without stack rewrite (estimate). *Scope:* Theme tokens + restyle screens.

- [ ] **[M] First-class refusals / filters (*UX*)** — Jump-to-blocked, filter, actionable `[-]` reasons. *Grounded in:* `src/ui/model.ts` `RowBlock`; `src/ui/Confirm.tsx` `REASONS`. *Impact:* store / nested-repo confusion (estimate). *Scope:* Filter state in `App`.

---

## L — long-term (weeks)

- [ ] **[L] Named modes shell (*UX*)** — Splash → Home → Triage → Confirm → Done, each with its own layout and primary action. *Grounded in:* `src/ui/App.tsx` `Phase` + `applyRound`; separate `Round`/`Confirm`/`Trash` screens. *Impact:* “what am I doing right now” clarity (estimate). *Scope:* Mode shell; keep `model.ts` / clean seams.

- [x] ~~**[L] OpenTUI migration**~~ — **Withdrawn.** Stay on Ink.

---

## XL — withdrawn

- [x] ~~**[XL] Disk studio on a new renderer**~~ — **Withdrawn.** Brand + modes on Ink cover the product intent.

---

**Next step:** Check boxes that resonate, then ask me to “assemble a reply from the checked items.”
