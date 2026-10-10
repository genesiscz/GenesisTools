---
name: ux
description: UX polish and verification for GenesisTools' native macOS surfaces — the notch/side widget, Clicky, the Settings window, the hub and the review window (src/macos/GenesisKit, src/macos/GenesisTools). Use it whenever you design, change, review or test anything a user sees or touches there, even if the request only says "polish this", "it jumps", "padding looks off", "can't click it", "make it shippable", "test every setting", "the animation is janky", "the permission error is hidden" or "check the widget". It routes to the shippable checklist, live-testing recipes for the real app, motion verification and the ledger of things that were wrong on the first try. Pair it with the swift skill (performance) and the design skills it names.
---

# Native UX for GenesisTools

The bar is "shippable to someone who is not the author". Most defects found in this codebase were not hard
problems; they were affordances nobody exercised: an icon where a preview belonged, a row where only the
chevron reacted, a list whose last item was cut off, a permission error printed as grey text, an animation
that looked fine in code and showed an empty card for 130 ms on screen. So the work is mostly **using the
thing for real, frame by frame, and comparing it with the checklist**, then fixing the shape of the code.

## The loop

1. **Read the ledger first** ([references/findings.md](references/findings.md)): each entry is a mistake made
   once, with how to see it and the fix. Do not repeat one.
2. **Run the real surface, not a mental model.** The real GenesisTools.app with its real grants, driven in the
   background so the user's pointer and windows are never touched: [references/live-testing.md](references/live-testing.md).
3. **Walk the checklist** for every view you touch: [references/checklist.md](references/checklist.md).
4. **Verify motion with instruments**, not with one screenshot: [references/motion.md](references/motion.md).
   Window frames from the window server, transition callbacks from the app, and only then a recording.
5. **Evidence in pairs**: `…/Widget/Screenshot/<YYYY-MM-DD-HHMM>-<slug>-before.png` and the same stamp with
   `-after.png`, so before and after sit next to each other.
6. **Write down what was wrong on the first try** in the ledger, generically, with the commit.

## Design authorities (load before a judgment call)

| Question | Load |
|---|---|
| Does this look like a native Mac app? Too many cards, fake glass, custom chrome? | `macos-golden-gate-design` |
| HIG: control choice, spacing, contrast, hit targets, sentence case | `apple-hig-expert` |
| Does this motion feel right (easing, duration, interruption, origin)? | `review-animations` |
| SwiftUI API and state patterns | `swiftui-expert-skill` |
| Why is it slow, stalling, re-rendering, burning CPU? | repo `swift` skill |

## Codebase rules that are UX rules

- Generic pieces live in GenesisKit (one disclosure row, one permission dialog, one thumbnail view); never an
  app-local copy. Hover effect on every button, tooltip on every icon-only button, `.titlebarZone()` on every
  window root (src/macos/GenesisTools/CLAUDE.md has the table).
- Data and caching belong on the TypeScript side; a view body only reads cached state.
- Staging surfaces (widget, Clicky) stay gated for other users: Preview bundle or `scripts/native/staging.ts on`.
