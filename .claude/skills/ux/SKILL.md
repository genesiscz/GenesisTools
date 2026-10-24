---
name: ux
description: UX polish, audits and verification for GenesisTools' native macOS surfaces — the notch/side widget, Clicky, the Settings window, the hub, the recording picker, the permission and approval dialogs and the review window (src/macos/GenesisKit, src/macos/GenesisTools). Use it whenever you design, change, review, audit or test anything a user sees or touches there, even if the request only says "polish this", "review this view", "what would you change", "it jumps", "padding looks off", "can't click it", "make it shippable", "test every setting", "the animation is janky", "keyboard does nothing", "VoiceOver", "the error is unreadable", "the permission error is hidden" or "check the widget". It routes to a pass-by-pass code audit, the shippable checklist (pointer, hit targets, keyboard, VoiceOver, feedback, errors, undo, empty states, Reduce Motion, attention, counts and words, settings), live-testing recipes for the real app, motion verification and the ledger of things that were wrong on the first try. Pair it with the swift skill (performance) and the design skills it names.
---

# Native UX for GenesisTools

The bar is "shippable to someone who is not the author". Most defects found in this codebase were not hard
problems; they were affordances nobody exercised: an icon where a preview belonged, a row where only the
chevron reacted, a list whose last item was cut off, a permission error printed as grey text, an animation
that looked fine in code and showed an empty card for 130 ms on screen. So the work is mostly **using the
thing for real, frame by frame, and comparing it with the checklist**, then fixing the shape of the code.

## Reviewing or auditing a surface

Asked to review, audit or list what you would change: follow [references/audit.md](references/audit.md). It maps
the surface, walks the passes (pointer and targets, keyboard, VoiceOver, feedback and errors, undo and lost work,
empty states, motion, things that appear by themselves, counts and words, layout, windows and settings) with search
recipes, and
starts with what the shared components already do, so that no finding claims a defect they handle. Its first step
is `bun .claude/skills/ux/scripts/ux-scan.ts <files>`, which prints the candidates of every pass at once. Report what
the user meets, not code style.

## The loop

1. **Read the ledger first** ([references/findings.md](references/findings.md)): each entry is a mistake made
   once, with how to see it and the fix. Do not repeat one.
2. **Run the real surface, not a mental model.** The real GenesisTools.app with its real grants, driven in the
   background so the user's pointer and windows are never touched: [references/live-testing.md](references/live-testing.md).
3. **Walk the checklist** for every view you touch: [references/checklist.md](references/checklist.md), with the
   passes of [references/audit.md](references/audit.md) over your own diff.
4. **Verify motion with instruments**, not with one screenshot: [references/motion.md](references/motion.md).
   Window frames from the window server, transition callbacks from the app, and only then a recording.
5. **Evidence in annotated pairs** ([references/screenshots.md](references/screenshots.md): same size and scale,
   red marks on real changes, amber on data-only differences, a note per pair):
   `…/<Area>/Screenshot/<YYYY-MM-DD-HHMM>-<area>-<slug>-before.png` and the same stamp with `-after.png`, so before and
   after sit next to each other.
6. **Write down what was wrong on the first try** in the ledger, generically, with the commit.

## What Martin asks for, before he has to (his reviews of 2026-10-23)

Read this before a widget, hub or settings change, and do these without being asked. Each line is a request he had
to make by screenshot.

- **Every clickable thing answers the pointer.** Round bubbles get a round hover ring, not a rectangular plate or
  nothing. If he cannot tell a thing is clickable by hovering it, it is a defect.
- **Opinionated means configurable.** A sound, a popup, an auto-expand, a flash, a tooltip, a placement, an order:
  ship a setting with your pick as its default (`.claude/rules/opinionated-settings.md`), and say which you added.
- **Say why something moved.** When the widget chimes or opens by itself, the session that caused it flashes
  (its bubble, its row, its popup) for a configurable few seconds. A cue without its cause is noise.
- **Rows carry their times.** A session row says when it was last active and when its newest question or answer
  arrived ("active 12m ago · asked 3m ago"), live (`LiveAgo`). A header says what the session is: agent, project,
  model, working or idle for how long, context size.
- **No jumps.** A filter that empties a list does not shrink an open panel; a tab, filter or headline never scrolls
  under a fade; content never blinks empty while a panel grows or a hover changes it.
- **The action is near the eye.** The reply box sits where the reading happens (under the tabs), not at the far
  bottom of a tall panel.
- **Attention cues point, they do not cover.** A flash is the border; a tinted overlay over a whole card reads as
  covered. Border flash is the `AttentionPulse` default.
- **A tooltip never stands in for the real hover behavior.** If hover should open a preview, a tooltip appearing
  instead is a bug to fix, not a fallback.
- **Every count opens what it counts**, and every session offers its terminal (cmux) and its inbox.

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
  window root (.claude/rules/macos-app.md has the table).
- Data and caching belong on the TypeScript side; a view body only reads cached state.
- Staging surfaces (widget, Clicky) stay gated for other users: Preview bundle or `scripts/native/staging.ts on`.
